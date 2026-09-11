// Compile the mined ride-intel log into a runtime artifact, the same way
// camping.json is built: the JSONL is an append-only source of record, never
// queried at runtime.
//
// The one hard problem is ANCHORING. The log stores places as names in the
// journal's own words ("Jacumba", "Lordsburg NM", "west El Paso / UTEP") with
// every mile field null. This resolves those names against the route's OWN
// geometry — route_places plus the corridor waypoints — so a mile is never
// eyeballed. Anything that will not resolve stays unanchored and is surfaced
// as regional advice instead of being given a fake position.
//
//   node scripts/build-intel.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { makeGazetteer, resolveRecord } from './lib/gazetteer.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'data/intel/ride-intel.jsonl');
const OUT = path.join(ROOT, 'data/intel/intel.json');

const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const havMi = ([lng1, lat1], [lng2, lat2]) => {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLa = rad(lat2 - lat1), dLn = rad(lng2 - lng1);
  const a = Math.sin(dLa / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

const db = openDb();
const gz = makeGazetteer(db, ROOT);
const totalMiles = gz.totalMiles;
const stateAtMile = gz.stateAtMile;

// ---- read the log ----------------------------------------------------------
const lines = fs.readFileSync(SRC, 'utf8').split('\n').filter((l) => l.trim());
const recs = lines.map((l) => JSON.parse(l));
const sourceRec = recs.find((r) => r.kind === 'source') ?? null;

// Amendments: a later page that corrects an earlier record wins outright.
const superseded = new Set();
for (const r of recs) {
  for (const key of ['amendedBy', 'resolvedBy']) {
    if (r[key]) superseded.add(r.id);
  }
  for (const id of r.resolves ?? []) superseded.add(id);
  for (const id of r.amends ?? []) superseded.add(id);
}

const stats = {
  total: recs.length, anchoredSpan: 0, anchoredPoint: 0,
  regional: 0, dropped: 0, superseded: superseded.size, byMethod: {},
};

// Pass 1: anchors without a relativeTo, so pass 2 can offset from them.
const anchorsById = new Map();
for (const r of recs) {
  if (r.kind !== 'anchor' || r.relativeTo) continue;
  const res = resolveRecord(r, gz);
  if (res.startMile != null) {
    anchorsById.set(r.id, { mile: (res.startMile + res.endMile) / 2, uncertaintyMi: res.uncertaintyMi });
  }
}

const out = [];
for (const r of recs) {
  if (r.kind === 'source') continue;
  const loc = r.loc ?? {};

  // Traps 1 & 6 from the handoff: a non-transferable one-off news event and
  // anything off the active route must never reach the warning layer.
  const offRoute = r.onActiveRoute === false || r.onActiveRoute === 'false';
  const notTransferable = r.transferable === false;
  if (notTransferable) { stats.dropped++; continue; }

  const state = loc.state ?? null;
  // All placement logic lives in the shared gazetteer so the builder and the
  // pilot cannot disagree about where a record sits.
  const res = resolveRecord(r, gz, anchorsById);
  const startMile = res.startMile ?? null;
  const endMile = res.endMile ?? null;
  const anchor = res.method ?? 'none';
  const approx = res.approx ?? false;

  const anchored = startMile != null;
  if (anchored && !offRoute) {
    if (endMile - startMile > 0.2) stats.anchoredSpan++; else stats.anchoredPoint++;
    stats.byMethod[anchor] = (stats.byMethod[anchor] ?? 0) + 1;
  } else if (!offRoute) stats.regional++;

  out.push({
    id: r.id,
    kind: r.kind,
    type: r.type ?? null,
    severity: r.severity ?? null,          // trap 2: NEVER re-rate
    summary: r.summary ?? null,
    detail: r.detail ?? null,
    cyclistIntel: r.cyclistIntel ?? null,
    actionable: r.actionable ?? null,
    quote: r.quote ?? null,
    state,
    road: loc.road ?? null,
    from: loc.from ?? null,
    to: loc.to ?? null,
    extentMi: loc.extentMi ?? null,
    dayMile: loc.dayMile ?? null,          // trap 3: a hint, not a position
    startMile: r1(startMile),
    endMile: r1(endMile),
    anchorMethod: anchor,
    anchorApprox: approx,
    anchorUncertaintyMi: res.uncertaintyMi ?? null,
    anchorNote: res.note ?? null,
    anchorMatchedTowns: res.matched ?? null,
    offRoute,
    divergence: r.divergence ?? null,
    observedDate: r.observedDate ?? null,
    stalenessYrs: r.stalenessYrs ?? null,
    confidence: r.confidence ?? null,
    mustVerify: r.mustVerify ?? false,
    verifyTarget: r.verifyTarget ?? null,
    offHighway: r.offHighway ?? false,
    routingPriority: r.routingPriority ?? null,
    shade: r.shade ?? null,
    windSheltered: r.windSheltered ?? null,
    superseded: superseded.has(r.id),
    amendedBy: r.amendedBy ?? r.resolvedBy ?? null,
    photos: (r.photos ?? []).filter((p) => p?.caption || p?.shows),
  });
}

// ---- Road-indexed tier ------------------------------------------------------
// The handoff asked for this first, on the assumption it needed "zero geometry
// work". It does not: this route's geometry carries no road names at all (the
// OSM cache holds way ids and coordinates, no refs), so there is nothing to
// match a road name against directly.
//
// What IS available is the anchored subset. Records that DID resolve tell us
// roughly which miles a road covers, and unanchored records naming that same
// road in that same state can inherit that envelope. Evidence placing
// evidence — imperfect, explicitly wider than a real anchor, and honest about
// which it is.
const roadKey = (road, state) => `${String(road).toLowerCase().replace(/\s*\(.*?\)/g, '').trim()}|${state ?? ''}`;
const roadEnvelope = new Map();
for (const r of out) {
  if (r.startMile == null || !r.road || r.offRoute) continue;
  for (const part of String(r.road).split(/\s*[/,]\s*/)) {
    if (!part.trim()) continue;
    const k = roadKey(part, r.state);
    const e = roadEnvelope.get(k) ?? { lo: Infinity, hi: -Infinity, n: 0 };
    e.lo = Math.min(e.lo, r.startMile); e.hi = Math.max(e.hi, r.endMile ?? r.startMile);
    e.n++;
    roadEnvelope.set(k, e);
  }
}
let roadScoped = 0;
for (const r of out) {
  if (r.startMile != null || !r.road || r.offRoute) continue;
  let best = null;
  for (const part of String(r.road).split(/\s*[/,]\s*/)) {
    if (!part.trim()) continue;
    const e = roadEnvelope.get(roadKey(part, r.state));
    // One lone anchored record makes a road envelope that is really just a
    // point; require corroboration and a sane width.
    if (!e || e.n < 2 || e.hi - e.lo > 600) continue;
    if (!best || (e.hi - e.lo) < (best.hi - best.lo)) best = e;
  }
  if (best) {
    r.roadMiles = [r1(best.lo), r1(best.hi)];
    r.roadEvidence = best.n;
    roadScoped++;
  }
}
stats.roadScoped = roadScoped;

// ---- Day calibration -------------------------------------------------------
// 40 GPS-measured riding days on this route with a loaded bike. This is the
// best evidence available for the app's speed setting — reported, never
// applied automatically, and explicitly a SUPPORTED rider's numbers.
const dayRecs = recs.filter((r) => r.kind === 'day');
const nums = (k) => dayRecs.map((r) => r[k]).filter((v) => typeof v === 'number' && v > 0).sort((a, b) => a - b);
const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);
const speeds = nums('avgMph'), miles = nums('miles'), climbs = nums('ascentFt');
const headwind = dayRecs.filter((r) => typeof r.headwindMph === 'number' && r.headwindMph > 0);
const calibration = {
  days: dayRecs.length,
  speedMph: speeds.length
    ? { n: speeds.length, median: med(speeds), slowest: speeds[0], fastest: speeds[speeds.length - 1] }
    : null,
  milesPerDay: miles.length ? { n: miles.length, median: med(miles), longest: miles[miles.length - 1] } : null,
  climbFtPerDay: climbs.length ? { n: climbs.length, median: med(climbs), biggest: climbs[climbs.length - 1] } : null,
  headwindDays: headwind.length,
  caveat: 'A supported rider (chase vehicle, no camping gear) in an unusually hot spring, riding this route in the opposite direction. Treat the speed spread as the honest range, not the temperatures.',
};

const built = {
  calibration,
  generatedAt: new Date().toISOString().slice(0, 10),
  schemaVersion: 'intel-1.0',
  source: sourceRec ? {
    id: sourceRec.id,
    blog: sourceRec.blog ?? sourceRec.summary ?? null,
    author: sourceRec.author ?? null,
    year: sourceRec.year ?? null,
    direction: 'west_to_east',            // Nick rides the reverse
    supported: true,                      // chase vehicle + cook: weak lodging evidence
    heatCalibration: sourceRec.heatCalibration ?? null,
    caveats: sourceRec.caveats ?? sourceRec.notes ?? null,
  } : null,
  stats,
  records: out,
};
fs.writeFileSync(OUT, JSON.stringify(built));
db.close();

const pct = (n) => `${Math.round((n / stats.total) * 100)}%`;
console.log(`intel built → data/intel/intel.json`);
console.log(`  ${stats.total} records`);
console.log(`  anchored as spans : ${stats.anchoredSpan} (${pct(stats.anchoredSpan)})`);
console.log(`  anchored as points: ${stats.anchoredPoint} (${pct(stats.anchoredPoint)})`);
console.log(`  regional (no mile): ${stats.regional}`);
console.log(`  ...of those, road-scoped from anchored evidence: ${stats.roadScoped}`);
console.log(`  dropped (not transferable): ${stats.dropped}`);
console.log(`  superseded by a later page: ${stats.superseded}`);
console.log('  by method:', JSON.stringify(stats.byMethod));
