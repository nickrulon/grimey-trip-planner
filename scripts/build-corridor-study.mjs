// Corridor study, step 2: camps, gaps and sample nights for each candidate line.
//
// Inputs
//   data/corridors/lines.json          from scripts/build-corridor-lines.mjs
//   data/corridors/research/*.json      research runs: {segments:[{seg,research:{camps},verify:{results}}],
//                                        gapHunts:[{id,result:{camps}}], cross:[{key,result}]}
//   data/corridors/osm-camps.json       optional OpenStreetMap sweep (map-only pins, never counted)
// Output
//   web/src/corridor-study.json         bundled into the web build (no API involved)
//
//   node scripts/build-corridor-study.mjs
//
// Every camp is anchored to EVERY line it serves (a camp in Indio serves both
// the I-10 line and the Salton Sea hybrid), by projecting it onto each line.
// "Usable" means tents are allowed (or not yet known) and nothing says it is
// closed or refuted. Gaps and sample nights are computed on usable camps only.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineMi } from './lib/geo.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data/corridors');
const OUT = path.join(ROOT, 'web/src/corridor-study.json');
const START_DATE = process.env.STUDY_START || '2026-11-02'; // first riding day out of Casa Grande

const lines = JSON.parse(fs.readFileSync(path.join(DIR, 'lines.json'), 'utf8'));
const L = Object.fromEntries(lines.corridors.map((c) => [c.id, c]));

// ---------- geometry ----------
for (const c of lines.corridors) {
  const cum = [0];
  for (let i = 1; i < c.coords.length; i++) cum.push(cum[i - 1] + haversineMi(c.coords[i - 1], c.coords[i]));
  c.cum = cum;
}
function townMile(c, name) {
  const t = c.towns.find((x) => x.name === name);
  if (!t) throw new Error(`${c.id}: no town ${name}`);
  return t.mile;
}
function sliceByMile(c, a, b) {
  const out = [];
  for (let i = 0; i < c.coords.length; i++) if (c.cum[i] >= a - 1e-6 && c.cum[i] <= b + 1e-6) out.push(c.coords[i]);
  return out;
}
// Composite: the I-10 line with both off-interstate variants spliced in.
function composite(id, name, parts) {
  const coords = [];
  const climb = climbOf(parts);
  for (const [cid, a, b] of parts) {
    const seg = sliceByMile(L[cid], a, b);
    coords.push(...(coords.length ? seg.slice(1) : seg));
  }
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineMi(coords[i - 1], coords[i]));
  return { id, name, coords, cum, miles: +cum.at(-1).toFixed(1), ...climb };
}
// climb over a stitched profile, same 3 m hysteresis as build-corridor-lines.mjs
function climbOf(parts) {
  const ft = [];
  for (const [cid, a, b] of parts) for (const [m, e] of L[cid].profile) if (m >= a && m <= b && e != null) ft.push(e);
  let up = 0, hi = -Infinity, ref = null;
  for (const e of ft) {
    if (e > hi) hi = e;
    if (ref == null) { ref = e; continue; }
    if (e - ref >= 9.84) { up += e - ref; ref = e; } else if (ref - e >= 9.84) ref = e;
  }
  return { climbFt: Math.round(up), highPointFt: Math.round(hi) };
}
const i10 = L.i10;
const COMPOSITES = {
  'i10-offinterstate': composite('i10-offinterstate', 'I-10 corridor using the Salome and Box Canyon variants', [
    ['i10', 0, townMile(i10, 'Tonopah')],
    ['i10-salome', 0, L['i10-salome'].miles],
    ['i10', townMile(i10, 'Quartzsite'), townMile(i10, 'Chiriaco Summit')],
    ['i10-mecca', 0, L['i10-mecca'].miles],
    ['i10', townMile(i10, 'Indio'), i10.miles],
  ]),
};
// lines a camp can be measured against
const MEASURE = { i10: L.i10, 'i10-salome': L['i10-salome'], 'i10-mecca': L['i10-mecca'], i8: L.i8, hybrid: L.hybrid, ...COMPOSITES };

// coarse grid index per line for fast nearest-vertex lookups
for (const c of Object.values(MEASURE)) {
  c.grid = new Map();
  c.coords.forEach(([lng, lat], i) => {
    const k = `${Math.floor(lat * 10)}:${Math.floor(lng * 10)}`;
    if (!c.grid.has(k)) c.grid.set(k, []);
    c.grid.get(k).push(i);
  });
}
function project(c, lat, lng, maxMi = 25) {
  let best = null;
  const r = Math.ceil(maxMi / 6.9); // 0.1 deg ≈ 6.9 mi of latitude
  const la = Math.floor(lat * 10), lo = Math.floor(lng * 10);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    for (const i of c.grid.get(`${la + dy}:${lo + dx}`) ?? []) {
      const d = haversineMi(c.coords[i], [lng, lat]);
      if (d <= maxMi && (!best || d < best.off)) best = { mile: c.cum[i], off: d, i };
    }
  }
  return best;
}

// ---------- research ----------
const resDir = path.join(DIR, 'research');
const runs = fs.existsSync(resDir) ? fs.readdirSync(resDir).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, data: JSON.parse(fs.readFileSync(path.join(resDir, f), 'utf8')) })) : [];

const norm = (s) => String(s ?? '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ')
  .replace(/\b(the|rv|park|resort|campground|camp|and|state|beach|county|regional|area|camping|site|sites|ground|grounds|of|at)\b/g, ' ')
  .replace(/\s+/g, ' ').trim();
const known = (v) => v != null && v !== '' && v !== 'unknown' && v !== 0;

const raw = [];
for (const { file, data } of runs) {
  for (const s of data.segments ?? []) {
    if (!s?.research?.camps) continue;
    const verdicts = new Map((s.verify?.results ?? []).map((v) => [norm(v.name), v]));
    for (const c of s.research.camps) {
      const v = verdicts.get(norm(c.name))
        ?? [...verdicts.entries()].find(([k]) => k && (k.includes(norm(c.name)) || norm(c.name).includes(k)))?.[1];
      raw.push({ ...c, seg: s.seg, run: file, verify: v ?? null });
    }
  }
  for (const g of data.gapHunts ?? []) {
    for (const c of g?.result?.camps ?? []) raw.push({ ...c, seg: `gap:${g.id}`, run: file, verify: null, fromGapHunt: true });
  }
}

function applyVerify(c) {
  const v = c.verify;
  const out = { ...c };
  out.verdict = v ? v.verdict : 'unchecked';
  if (v) {
    for (const k of ['tents', 'openNov2026', 'showers', 'water']) if (known(v[k])) out[k] = v[k];
    for (const k of ['priceTent', 'phone']) if (known(v[k])) out[k] = v[k];
    if (Number.isFinite(v.lat) && Number.isFinite(v.lng) && v.lat && v.lng
      && haversineMi([v.lng, v.lat], [c.lng, c.lat]) < 30) { out.lat = v.lat; out.lng = v.lng; }
    out.verifyNote = v.note;
    out.sources = [...new Set([...(c.sources ?? []), ...(v.sources ?? [])])];
  }
  return out;
}

// merge duplicates (same place found by two segment agents, or by a gap hunter)
const RANK = { confirmed: 4, corrected: 4, unverifiable: 1, unchecked: 2, refuted: 5 };
const CONF = { high: 3, medium: 2, low: 1 };
const merged = [];
for (const c0 of raw.map(applyVerify)) {
  if (!Number.isFinite(c0.lat) || !Number.isFinite(c0.lng) || !c0.lat || !c0.lng) continue;
  const n0 = norm(c0.name);
  const twin = merged.find((m) => {
    const d = haversineMi([m.lng, m.lat], [c0.lng, c0.lat]);
    const n1 = norm(m.name);
    if (d < 0.6 && n0 && n1 && (n0 === n1 || n0.includes(n1) || n1.includes(n0))) return true;
    const t0 = n0.split(' ').slice(0, 2).join(' '), t1 = n1.split(' ').slice(0, 2).join(' ');
    return d < 1.2 && t0.length > 4 && t0 === t1;
  });
  if (!twin) { merged.push({ ...c0, seen: [c0.seg] }); continue; }
  twin.seen.push(c0.seg);
  const better = (RANK[c0.verdict] ?? 0) > (RANK[twin.verdict] ?? 0)
    || ((RANK[c0.verdict] ?? 0) === (RANK[twin.verdict] ?? 0) && (CONF[c0.confidence] ?? 0) > (CONF[twin.confidence] ?? 0));
  const [a, b] = better ? [c0, twin] : [twin, c0];
  for (const k of Object.keys(b)) if (!known(a[k]) && known(b[k])) a[k] = b[k];
  a.sources = [...new Set([...(a.sources ?? []), ...(b.sources ?? [])])];
  a.seen = twin.seen;
  if (better) Object.assign(twin, a);
}

// ---------- hand-checked overrides (data/corridors/overrides.json) ----------
// Facts checked directly that beat the research (e.g. a campground that is
// still a construction site). Each entry: {match: name substring, set: {...fields}, note, source}.
const ovFile = path.join(DIR, 'overrides.json');
for (const o of fs.existsSync(ovFile) ? JSON.parse(fs.readFileSync(ovFile, 'utf8')) : []) {
  for (const c of merged.filter((m) => m.name.toLowerCase().includes(o.match.toLowerCase()))) {
    Object.assign(c, o.set);
    c.verifyNote = [c.verifyNote, `Checked ${o.source ? 'against ' + o.source : 'by hand'}: ${o.note}`].filter(Boolean).join(' ');
    if (o.source) c.sources = [...new Set([o.source, ...(c.sources ?? [])])];
    c.verdict = c.verdict === 'refuted' ? 'refuted' : 'corrected';
  }
}

// ---------- OSM map-only pins ----------
const osmFile = path.join(DIR, 'osm-camps.json');
const osm = fs.existsSync(osmFile) ? JSON.parse(fs.readFileSync(osmFile, 'utf8')) : [];
const osmOnly = [];
for (const e of osm) {
  const t = e.tags ?? {};
  const name = t.name ?? '';
  if (!name || /^\d+$/.test(name)) continue;
  if (/mobile home|trailer park|manufactured|apartments|storage|scout|ymca|church camp|youth camp/i.test(name)) continue;
  if (t.tents === 'no' || t.access === 'private' || t.access === 'no') continue;
  const n = norm(name);
  const dup = merged.some((m) => haversineMi([m.lng, m.lat], [e.lng, e.lat]) < 1.2
    && (norm(m.name) === n || norm(m.name).includes(n) || n.includes(norm(m.name)) || norm(m.name).split(' ')[0] === n.split(' ')[0]));
  if (dup) continue;
  osmOnly.push({
    name, kind: t.tourism === 'caravan_site' ? 'rv_park' : 'private_campground', lat: e.lat, lng: e.lng,
    tents: t.tents === 'yes' ? 'yes' : 'unknown', showers: t.shower === 'yes' ? 'yes' : t.shower === 'no' ? 'no' : 'unknown',
    water: t.drinking_water === 'yes' ? 'potable' : 'unknown', toilets: t.toilets === 'yes' ? 'flush' : 'unknown',
    phone: t.phone ?? t['contact:phone'] ?? '', website: t.website ?? t['contact:website'] ?? '',
    priceTent: t.fee === 'no' ? 'free' : '', verdict: 'map-only', confidence: 'low', mapOnly: true,
    sources: [`https://www.openstreetmap.org/${e.osm}`], cyclistNotes: 'OpenStreetMap only. Not researched: call first.',
  });
}

// ---------- anchor + classify ----------
const tierOf = (c) => {
  if (c.verdict === 'refuted' || c.tents === 'no' || c.openNov2026 === 'no') return 'no';
  // a casino or truck-stop lot is an emergency vehicle stop, not a tent site, unless tents are confirmed
  if (c.kind === 'casino_or_business' && c.tents !== 'yes') return 'no';
  if (c.tents === 'yes' && c.showers === 'yes' && c.water === 'potable') return 'full';
  if (c.tents === 'yes') return 'basic';
  return 'maybe';
};
const ALL = [...merged, ...osmOnly];
let seq = 0;
for (const c of ALL) {
  c.id = `cs-${++seq}`;
  c.tier = tierOf(c);
  c.anchors = {};
  for (const [id, line] of Object.entries(MEASURE)) {
    const p = project(line, c.lat, c.lng, 25);
    if (!p) continue;
    const off = Math.max(p.off, Number(c.offRouteMiApprox) > 0 && c.corridor === id ? Number(c.offRouteMiApprox) : 0);
    if (off <= 20) c.anchors[id] = { mile: +p.mile.toFixed(1), off: +off.toFixed(1) };
  }
}

// which corridors does a camp count for (riding distance off the line ≤ 10 mi, ≤ 15 for a lone option)
const SERVE_MI = 10;
const usable = (c) => !c.mapOnly && c.tier !== 'no';
function campsOn(lineId, maxOff = SERVE_MI) {
  return ALL.filter((c) => usable(c) && c.anchors[lineId] && c.anchors[lineId].off <= maxOff)
    .sort((a, b) => a.anchors[lineId].mile - b.anchors[lineId].mile);
}
function gapsOn(lineId, totalMiles, { tentsKnownOnly = false } = {}) {
  const pts = campsOn(lineId).filter((c) => !tentsKnownOnly || c.tents === 'yes');
  const marks = [{ name: 'Casa Grande', mile: 0 }, ...pts.map((c) => ({ name: c.name, mile: c.anchors[lineId].mile, id: c.id }))];
  const gaps = [];
  for (let i = 1; i < marks.length; i++) {
    const d = marks[i].mile - marks[i - 1].mile;
    if (d >= 25) gaps.push({ fromName: marks[i - 1].name, fromMile: +marks[i - 1].mile.toFixed(1), toName: marks[i].name, toMile: +marks[i].mile.toFixed(1), miles: +d.toFixed(1) });
  }
  const tail = totalMiles - marks.at(-1).mile;
  return { gaps, tailToEnd: +tail.toFixed(1), count: pts.length };
}

// sample nights: greedy, aim for `target`, never stop short of 40 if a camp lies beyond
function nightsOn(lineId, totalMiles, target) {
  const pts = campsOn(lineId).map((c) => ({ c, m: c.anchors[lineId].mile }));
  const nights = []; let at = 0; let guard = 0;
  while (totalMiles - at > target + 8 && guard++ < 20) {
    const window = pts.filter((p) => p.m > at + 35 && p.m <= at + target + 8);
    let pick = null;
    if (window.length) {
      const score = (p) => -Math.abs(p.m - at - target) + (p.c.tier === 'full' ? 8 : p.c.tier === 'basic' ? 3 : 0)
        - Math.min(6, p.c.anchors[lineId].off) - (p.m - at > target ? 4 : 0);
      pick = window.reduce((a, b) => (score(b) > score(a) ? b : a));
    } else {
      pick = pts.find((p) => p.m > at + 8) ?? null; // nothing in reach: the next camp, however far
    }
    if (!pick) break;
    // short-day fallbacks: other camps between 40 mi out and the pick (a wind day)
    const fallbacks = pts.filter((p) => p.m >= at + 40 && p.m < pick.m - 8)
      .sort((a, b) => (b.c.tier === 'full') - (a.c.tier === 'full') || b.m - a.m)
      .slice(0, 3).sort((a, b) => a.m - b.m)
      .map((p) => ({ name: p.c.name, dayMiles: +(p.m - at).toFixed(1), tier: p.c.tier }));
    nights.push({ id: pick.c.id, name: pick.c.name, mile: +pick.m.toFixed(1), dayMiles: +(pick.m - at).toFixed(1), tier: pick.c.tier, off: pick.c.anchors[lineId].off, fallbacks });
    at = pick.m;
  }
  const lastDay = +(totalMiles - at).toFixed(1);
  const days = nights.length + 1;
  const d = new Date(`${START_DATE}T12:00:00Z`);
  const arrive = new Date(d.getTime() + (days - 1) * 86400000).toISOString().slice(0, 10);
  return { target, nights, lastDay, days, arrive };
}

const STUDY = [
  { id: 'i10', line: L.i10, label: 'I-10 (interstate shoulder)' },
  { id: 'i10-offinterstate', line: COMPOSITES['i10-offinterstate'], label: 'I-10 with Salome + Box Canyon variants' },
  { id: 'i8', line: L.i8, label: 'I-8 via San Diego (LA River finish)' },
  { id: 'hybrid', line: L.hybrid, label: 'Hybrid: I-8 → Salton Sea → I-10' },
];
const corridors = STUDY.map(({ id, line, label }) => {
  const src = L[id] ?? null;
  const g = gapsOn(id, line.miles);
  const gk = gapsOn(id, line.miles, { tentsKnownOnly: true });
  const camps = campsOn(id);
  return {
    id, label, name: line.name, miles: line.miles,
    climbFt: line.climbFt ?? null, highPointFt: line.highPointFt ?? null, color: src?.color ?? L.i10.color,
    summary: src?.summary ?? '',
    camps: { usable: camps.length, full: camps.filter((c) => c.tier === 'full').length, tentsYes: camps.filter((c) => c.tents === 'yes').length, maybe: camps.filter((c) => c.tier === 'maybe').length, checked: camps.filter((c) => ['confirmed', 'corrected'].includes(c.verdict)).length },
    per100: +(camps.length / line.miles * 100).toFixed(1),
    gaps: g.gaps, gapsTentsKnown: gk.gaps,
    longestGap: Math.max(0, ...g.gaps.map((x) => x.miles)), longestGapTentsKnown: Math.max(0, ...gk.gaps.map((x) => x.miles)),
    over50: g.gaps.filter((x) => x.miles > 50).length,
    towns: (src?.towns ?? []).filter((t, i, a) => a.findIndex((u) => u.name === t.name) === i),
    plans: [70, 85, 100].map((t) => nightsOn(id, line.miles, t)),
    legs: src?.legs ?? [],
  };
});

// ---------- map geometry (decimated) ----------
const dec = (coords, every) => coords.filter((_, i) => i % every === 0 || i === coords.length - 1).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
const lineFeatures = [];
const addLine = (id, name, color, coords, extra = {}) => lineFeatures.push({
  type: 'Feature', properties: { id, name, color, ...extra }, geometry: { type: 'LineString', coordinates: coords },
});
// The I-10 line itself is the app's route since the 2026-11-01 retrace: only its two variants are drawn here.
addLine('i10-salome', L['i10-salome'].name, L['i10-salome'].color, dec(L['i10-salome'].coords, 3), { miles: L['i10-salome'].miles, kind: 'variant' });
addLine('i10-mecca', L['i10-mecca'].name, L['i10-mecca'].color, dec(L['i10-mecca'].coords, 3), { miles: L['i10-mecca'].miles, kind: 'variant' });
{ // the hybrid's own part: El Centro → Indio (the rest overlaps the I-8 route and the I-10 line)
  const h = L.hybrid; const a = h.legs[0].miles, b = townMile(h, 'Indio'); // legs[0] = Casa Grande → El Centro on the app's route
  addLine('hybrid', h.name, h.color, dec(sliceByMile(h, a, b), 3), { miles: h.miles, climbFt: h.climbFt, kind: 'main' });
}
// The I-8 corridor, whole: since the 2026-11-01 retrace the app's route is the
// I-10 line, so the I-8 / San Diego line only exists here, as the comparison.
addLine('i8', 'I-8 corridor via San Diego (the old plan)', L.i8.color, dec(L.i8.coords, 3), { miles: L.i8.miles, climbFt: L.i8.climbFt, kind: 'main' });
// gap stretches (> 40 mi between usable camps) drawn on their line
const gapFeatures = [];
for (const cor of corridors) {
  const line = MEASURE[cor.id];
  for (const g of cor.gaps.filter((x) => x.miles > 40)) {
    gapFeatures.push({ type: 'Feature', properties: { corridor: cor.id, miles: g.miles, from: g.fromName, to: g.toName, severe: g.miles > 50 },
      geometry: { type: 'LineString', coordinates: dec(sliceByMile(line, g.fromMile, g.toMile), 4) } });
  }
}
// mile markers every 25 mi along the I-10 line and the I-8 line (miles from Casa Grande)
const markFeatures = [];
for (const [id, line, every] of [['i8', L.i8, 25], ['hybrid', L.hybrid, 25]]) { // the I-10 line carries the app's own route miles
  for (let m = every; m < line.miles; m += every) {
    if (id === 'hybrid' && (m < 250 || m > 341)) continue; // shared with the other lines
    const i = line.cum.findIndex((x) => x >= m);
    markFeatures.push({ type: 'Feature', properties: { corridor: id, mile: m, label: `+${m}` }, geometry: { type: 'Point', coordinates: line.coords[i].map((v) => +v.toFixed(5)) } });
  }
}

const campFeatures = ALL.filter((c) => c.tier !== 'no').map((c) => ({ // no-tent / closed / refuted places stay off the map
  type: 'Feature',
  properties: {
    id: c.id, name: c.name, kind: c.kind, tier: c.tier, mapOnly: !!c.mapOnly,
    verdict: c.verdict, confidence: c.confidence,
    c_i10: !!(c.anchors.i10?.off <= SERVE_MI || c.anchors['i10-salome']?.off <= SERVE_MI || c.anchors['i10-mecca']?.off <= SERVE_MI),
    c_i8: !!(c.anchors.i8?.off <= SERVE_MI),
    c_hyb: !!(c.anchors.hybrid?.off <= SERVE_MI),
    anchors: JSON.stringify(c.anchors),
    tents: c.tents ?? 'unknown', showers: c.showers ?? 'unknown', water: c.water ?? 'unknown', toilets: c.toilets ?? 'unknown',
    power: c.power ?? 'unknown', wifi: c.wifi ?? 'unknown', open: c.openNov2026 ?? 'unknown',
    price: c.priceTent ?? '', phone: c.phone ?? '', website: c.website ?? '', reservations: c.reservations ?? '',
    access: c.access ?? '', notes: [c.cyclistNotes, c.verifyNote].filter(Boolean).join(' · ').slice(0, 600),
    sources: JSON.stringify((c.sources ?? []).slice(0, 4)),
  },
  geometry: { type: 'Point', coordinates: [+c.lng.toFixed(5), +c.lat.toFixed(5)] },
})).filter((f) => f.properties.c_i10 || f.properties.c_i8 || f.properties.c_hyb);

// cross-cutting findings (latest run wins)
const crossOf = (key) => runs.map((r) => r.data.cross?.find((x) => x?.key === key)?.result).filter(Boolean).at(-1) ?? null;
const services = crossOf('services');
const serviceFeatures = (services?.points ?? []).filter((p) => p.lat && p.lng).map((p) => ({
  type: 'Feature', properties: { name: p.name, kind: p.kind, water: p.water, food: p.food, hours: p.hours, note: p.note, corridor: p.corridor },
  geometry: { type: 'Point', coordinates: [+p.lng.toFixed(5), +p.lat.toFixed(5)] },
}));

const out = {
  generatedAt: new Date().toISOString(),
  origin: 'Casa Grande, AZ',
  startDate: START_DATE,
  runs: runs.map((r) => r.file),
  corridors,
  lines: { type: 'FeatureCollection', features: lineFeatures },
  gaps: { type: 'FeatureCollection', features: gapFeatures },
  marks: { type: 'FeatureCollection', features: markFeatures },
  camps: { type: 'FeatureCollection', features: campFeatures },
  services: { type: 'FeatureCollection', features: serviceFeatures },
  legality: crossOf('legality'),
  weather: crossOf('weather'),
  intel: crossOf('intel') ? { summary: crossOf('intel').summary, reports: crossOf('intel').reports.slice(0, 12) } : null,
  dryStretches: services?.dryStretches ?? [],
  // a short written bottom line, kept by hand next to the research
  verdict: fs.existsSync(path.join(DIR, 'verdict.json')) ? JSON.parse(fs.readFileSync(path.join(DIR, 'verdict.json'), 'utf8')) : null,
};
fs.writeFileSync(OUT, JSON.stringify(out));
// the merged, anchored camp list (research + verdicts), for scripts/corridor-to-camping.mjs
fs.writeFileSync(path.join(DIR, 'camps-merged.json'), JSON.stringify(ALL.filter((c) => !c.mapOnly).map((c) => {
  const { verify, ...rest } = c; return rest;
}), null, 1));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB): ${campFeatures.length} camps (${osmOnly.length} map-only), ${gapFeatures.length} gap stretches`);
for (const c of corridors) {
  console.log(`${c.label.padEnd(42)} ${String(c.miles).padStart(6)} mi  climb ${String(c.climbFt ?? '-').padStart(6)}  usable ${String(c.camps.usable).padStart(3)} (full ${c.camps.full}, tents-yes ${c.camps.tentsYes}, maybe ${c.camps.maybe})  per100 ${c.per100}  longest gap ${c.longestGap} (tents-known ${c.longestGapTentsKnown})  >50: ${c.over50}`);
  for (const p of c.plans) console.log(`   @${p.target}: ${p.days} days → ${p.arrive}  ` + p.nights.map((n) => `${n.dayMiles}→${n.name.slice(0, 22)}[${n.tier[0]}]`).join(' | ') + ` | last ${p.lastDay}`);
}
