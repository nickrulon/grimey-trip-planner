// ANCHOR PILOT — read-only accuracy test (data/intel/ANCHOR_PILOT.md).
// Round 2: now reads the structured town fields (betweenTowns / nearestTown /
// relativeTo) and applies the source record's extentDirectionRule.
// Writes anchor-pilot-results.json. Never writes ride-intel.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { makeGazetteer, resolveRecord } from './lib/gazetteer.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb();
const gz = makeGazetteer(db, ROOT);

const recs = fs.readFileSync(path.join(ROOT, 'data/intel/ride-intel.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byId = new Map(recs.map((r) => [r.id, r]));

// Pass 1: anchors WITHOUT a relativeTo, so pass 2 can offset from them.
const anchorsById = new Map();
for (const r of recs) {
  if (r.kind !== 'anchor' || r.relativeTo) continue;
  const res = resolveRecord(r, gz);
  if (res.startMile != null) {
    anchorsById.set(r.id, { mile: (res.startMile + res.endMile) / 2, uncertaintyMi: res.uncertaintyMi });
  }
}

const results = [];
function test(id, tier, expectRejected = false) {
  const r = byId.get(id);
  if (!r) { results.push({ id, tier, outcome: 'failed', whyFailed: 'id not in dataset' }); return; }

  // Filters run before anything else touches the record.
  const rejectReason =
    r.transferable === false ? 'transferable:false — one-off event, never anchored'
    : r.onActiveRoute === false ? "onActiveRoute:false — not on Nick's route"
    : null;
  if (rejectReason) {
    results.push({ id, tier, outcome: 'rejected', startMile: null, endMile: null,
      uncertaintyMi: null, whyFailed: rejectReason, correctlyRejected: expectRejected });
    return;
  }

  const res = resolveRecord(r, gz, anchorsById);
  if (res.method === 'none' && /needsAnchor/.test(res.reason ?? '')) {
    results.push({ id, tier, outcome: 'rejected', startMile: null, endMile: null,
      uncertaintyMi: null, whyFailed: res.reason, correctlyRejected: expectRejected });
    return;
  }
  if (res.startMile == null) {
    const loc = r.loc ?? {};
    const hadTowns = !!(loc.betweenTowns || loc.nearestTown);
    results.push({
      id, tier, outcome: 'failed', startMile: null, endMile: null, uncertaintyMi: null,
      geometrySource: 'route_places (250 OSM towns) + 153 corridor waypoints',
      whyFailed: res.reason,
      // The distinction Nick asked for: towns supplied but absent from the
      // gazetteer is a DIFFERENT failure from no towns at all.
      failureClass: hadTowns ? 'towns_supplied_but_absent_from_gazetteer' : 'no_town_named',
      townsTried: hadTowns ? (loc.betweenTowns ?? [loc.nearestTown]) : null,
      oneFieldThatWouldHaveFixedIt: hadTowns
        ? 'none — the town names are present; the ROUTE GAZETTEER lacks these places'
        : 'nearestTown / betweenTowns',
    });
    return;
  }
  const seg = db.prepare(
    `SELECT id, name FROM route_segments WHERE ? BETWEEN start_mile AND end_mile LIMIT 1`).get(res.startMile);
  results.push({
    id, tier,
    outcome: res.uncertaintyMi != null && res.uncertaintyMi <= 5 ? 'resolved' : 'partial',
    startMile: res.startMile, endMile: res.endMile,
    uncertaintyMi: res.uncertaintyMi,
    anchorMethod: res.method,
    matchedTowns: res.matched ?? null,
    missingTown: res.missingTown ?? null,
    note: res.note ?? null,
    geometrySegment: seg ? `${seg.id} — ${seg.name}` : null,
    geometrySource: 'route_places + corridor waypoints · route geometry is reconstructed; dashed sections are corridor-accurate, street-approximate',
    orderedForNick: true,
    whyFailed: null,
    oneFieldThatWouldHaveFixedIt: (res.uncertaintyMi ?? 0) > 5
      ? 'a tighter bracketing pair — this envelope is wide'
      : null,
    correctlyRejected: expectRejected ? false : undefined,
  });
}

for (const r of recs.filter((x) => x.kind === 'anchor')) test(r.id, 0);
for (const r of recs.filter((x) => x.severity === 5).slice(0, 12)) test(r.id, 1);
for (const id of ['p33-006', 'p36-003', 'p39-002', 'p47-003', 'p48-003', 'p50-006']) test(id, 2);
for (const id of ['p54-006', 'p20-009', 'p21-009', 'p23-012', 'd10-005', 'p24-001', 'p18-N1']) test(id, 3, true);

// ---- Controls ----
const glamis = gz.resolve('Glamis', 'CA');
test('p33-005', 'control');
const dry = results.find((x) => x.id === 'p33-005');
const controls = [
  { name: 'Glamis', expected: 2637, got: glamis ? Math.round(glamis.mile * 10) / 10 : null,
    pass: !!glamis && Math.abs(glamis.mile - 2637) <= 3 },
  { name: 'El Paso→Fort Hancock inside the known dry stretch 1689–1789',
    expected: 'overlaps 1689-1789',
    got: dry?.startMile != null ? `${dry.startMile}-${dry.endMile}` : null,
    pass: dry?.startMile != null && dry.endMile >= 1689 && dry.startMile <= 1789 },
];

const tally = (t) => {
  const rows = results.filter((r) => r.tier === t);
  const c = (o) => rows.filter((r) => r.outcome === o).length;
  return { n: rows.length, resolved: c('resolved'), partial: c('partial'), failed: c('failed'), rejected: c('rejected') };
};
const unc = results.filter((r) => r.outcome === 'resolved').map((r) => r.uncertaintyMi)
  .filter((x) => x != null).sort((a, b) => a - b);
const t3 = results.filter((r) => r.tier === 3);
const report = {
  ranAt: new Date().toISOString().slice(0, 10),
  round: 2,
  spec: 'data/intel/ANCHOR_PILOT.md',
  readOnly: true,
  changesThisRound: [
    'reads loc.betweenTowns (16), loc.nearestTown (9), relativeTo (1)',
    'applies source.extentDirectionRule: one-ended spans run toward DECREASING Nick-mile',
    'town+bearing+distance offsets projected geometrically onto the route',
    'resolver shared with the builder (scripts/lib/gazetteer.mjs) so they cannot drift',
  ],
  tiers: { tier0_anchors: tally(0), tier1_sev5: tally(1), tier2_dayMile: tally(2), tier3_mustReject: tally(3) },
  uncertaintyMi: unc.length ? { median: unc[Math.floor(unc.length / 2)], best: unc[0], worst: unc[unc.length - 1] } : null,
  filterCheck: {
    tier3Records: t3.length,
    allRejected: t3.every((r) => r.outcome === 'rejected'),
    leaked: t3.filter((r) => r.outcome !== 'rejected').map((r) => r.id),
  },
  gazetteerGaps: [...new Set(results.filter((r) => r.failureClass === 'towns_supplied_but_absent_from_gazetteer')
    .flatMap((r) => r.townsTried ?? []))],
  controls,
  results,
};
fs.writeFileSync(path.join(ROOT, 'data/intel/anchor-pilot-results.json'), JSON.stringify(report, null, 1));
db.close();

console.log('ANCHOR PILOT — round 2');
for (const [k, v] of Object.entries(report.tiers)) console.log(' ', k, JSON.stringify(v));
console.log(' uncertainty (mi):', JSON.stringify(report.uncertaintyMi));
console.log(' filter check:', report.filterCheck.allRejected ? 'PASS — all tier-3 rejected' : `FAIL — leaked ${report.filterCheck.leaked}`);
for (const c of report.controls) console.log(` control ${c.name}: expected ${c.expected}, got ${c.got} → ${c.pass ? 'PASS' : 'FAIL'}`);
if (report.gazetteerGaps.length) console.log(' gazetteer gaps:', report.gazetteerGaps.join(', '));
