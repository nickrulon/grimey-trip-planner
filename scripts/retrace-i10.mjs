// One-off retrace (2026-11-01): Nick left the I-8 plan at Casa Grande and is
// riding the I-10 corridor to LA instead — Maricopa → Rainbow Valley → Buckeye
// → I-10 shoulder → Quartzsite → Blythe → Desert Center → Chiriaco Summit →
// Indio → Palm Springs → San Gorgonio Pass → Banning → Redlands → Pacific
// Electric Trail → Pasadena → the Elysian Theater. The route now ENDS at the
// Elysian; San Diego, the coast and the Santa Monica pier leave the route.
//
// Geometry: the "i10" line in data/corridors/lines.json (FOSSGIS Valhalla legs,
// scripts/build-corridor-lines.mjs), with its NED 10 m elevation profile.
// The I-8 line stays on the map through the corridor study layer.
//
//   node scripts/retrace-i10.mjs --dry      # print the plan, write nothing
//   node scripts/retrace-i10.mjs            # apply (backs up data/ first)
//
// Reference tables only (plus local copies of the state tables so dev stays
// coherent). The live PLAN lives in Netlify Blobs and is rebuilt afterwards
// through POST /api/plan/retrace-tail — never push-state from here.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { haversineMi } from './lib/geo.mjs';

const DRY = process.argv.includes('--dry');
const STAMP = '2026-11-01';
const db = openDb();
const r1 = (n) => Math.round(n * 10) / 10;

const lines = JSON.parse(fs.readFileSync('data/corridors/lines.json', 'utf8'));
const I10 = lines.corridors.find((c) => c.id === 'i10');
if (!I10) throw new Error('no i10 line in data/corridors/lines.json');

// ---- anchor A: the current route point nearest the I-10 line's start (downtown Casa Grande) ----
const near = db.prepare(`SELECT segment_id, seq, mile, lat, lng FROM route_points WHERE mile BETWEEN 2130 AND 2150`).all();
const A = near.reduce((b, p) => (haversineMi([p.lng, p.lat], I10.coords[0]) < haversineMi([b.lng, b.lat], I10.coords[0]) ? p : b));
const joinMi = haversineMi([A.lng, A.lat], I10.coords[0]);
if (joinMi > 0.3) throw new Error(`I-10 line starts ${joinMi.toFixed(2)} mi from the route — refusing`);
const oldEnd = db.prepare(`SELECT MAX(mile) m FROM route_points`).get().m;

// new points after A, with route miles
const pts = [];
let m = A.mile + joinMi;
for (let i = 0; i < I10.coords.length; i++) {
  if (i) m += haversineMi(I10.coords[i - 1], I10.coords[i]);
  if (i === 0 && joinMi < 0.01) continue; // A itself
  pts.push({ lng: I10.coords[i][0], lat: I10.coords[i][1], mile: m, cum: m - A.mile - joinMi });
}
const newEnd = pts[pts.length - 1].mile;
// AZ → CA: the Colorado River under the I-10 bridge between Ehrenberg and Blythe
const BORDER_LNG = -114.536;
const borderIdx = pts.findIndex((p) => p.lng <= BORDER_LNG);
const borderMile = pts[borderIdx].mile;
const segFor = (i) => (i < borderIdx ? 'st-az' : 'st-ca');

// elevation from the line's 0.25-mi profile ([corridorMile, ft])
const elevAt = new Map();
{
  let j = 0;
  for (const [cm, ft] of I10.profile) {
    if (ft == null) continue;
    while (j < pts.length - 1 && Math.abs(pts[j + 1].cum - cm) <= Math.abs(pts[j].cum - cm)) j++;
    elevAt.set(j, ft / 3.28084);
  }
}

const project = (() => {
  const line = [[A.lng, A.lat, A.mile], ...pts.map((p) => [p.lng, p.lat, p.mile])];
  const coarse = line.filter((_, i) => i % 12 === 0);
  return (lat, lng) => {
    let b = coarse[0], bd = Infinity;
    for (const p of coarse) { const d = haversineMi([lng, lat], [p[0], p[1]]); if (d < bd) { bd = d; b = p; } }
    const idx = line.indexOf(b);
    for (let i = Math.max(0, idx - 14); i < Math.min(line.length, idx + 14); i++) {
      const d = haversineMi([lng, lat], [line[i][0], line[i][1]]); if (d < bd) { bd = d; b = line[i]; }
    }
    return { mile: b[2], off: bd };
  };
})();
const townMile = (name) => {
  const t = I10.towns.find((x) => x.name === name);
  return A.mile + joinMi + t.mile;
};

const plan = []; const log = (s) => plan.push(s);
log(`A ${A.segment_id}#${A.seq} mile ${A.mile.toFixed(2)} (join ${joinMi.toFixed(3)} mi) | old end ${oldEnd.toFixed(1)} → new end ${newEnd.toFixed(1)} (${(newEnd - oldEnd).toFixed(1)}) | AZ→CA at mile ${borderMile.toFixed(1)}`);

// ---- route_points ----
const oldTail = db.prepare(`SELECT COUNT(*) n FROM route_points WHERE mile > ?`).get(A.mile).n;
log(`route_points: delete ${oldTail} after A (I-8, coast, sd-la), insert ${pts.length} I-10 points (${elevAt.size} with elevation)`);

// ---- resources ----
const width = Object.fromEntries(db.prepare(`SELECT id, corridor_width_mi FROM resource_categories`).all().map((c) => [c.id, c.corridor_width_mi]));
const resIn = db.prepare(`SELECT id, name, category_id, lat, lng, route_mile FROM resources WHERE route_mile > ?`).all(A.mile);
const resKeep = [], resDrop = [];
for (const r of resIn) {
  if (r.id.startsWith('rider-')) continue; // mirrors of rider_places, re-synced below
  const p = project(r.lat, r.lng);
  (p.off <= (width[r.category_id] ?? 3) ? resKeep : resDrop).push({ ...r, ...p });
}
log(`resources after A: ${resIn.length} → keep ${resKeep.length} (${resKeep.slice(0, 5).map((r) => `${r.name}@${r1(r.mile)}`).join(', ')}…), drop ${resDrop.length}`);

// ---- places ----
const plIn = db.prepare(`SELECT id, name, lat, lng, route_mile FROM route_places WHERE route_mile > ?`).all(A.mile);
const plKeep = [], plDrop = [];
for (const r of plIn) { const p = project(r.lat, r.lng); (p.off <= 8 ? plKeep : plDrop).push({ ...r, ...p }); }
const NEW_TOWNS = [
  ['Maricopa', 'city', 58125, 33.0581, -112.0476], ['Buckeye', 'city', 91502, 33.3703, -112.5838],
  ['Tonopah', 'village', null, 33.4931, -112.9358], ['Quartzsite', 'town', 2413, 33.6639, -114.2299],
  ['Ehrenberg', 'village', 1470, 33.6042, -114.5250], ['Blythe', 'city', 18317, 33.6103, -114.5964],
  ['Desert Center', 'village', 204, 33.7128, -115.4019], ['Chiriaco Summit', 'village', null, 33.6603, -115.7228],
  ['Indio', 'city', 89137, 33.7206, -116.2156], ['Palm Desert', 'city', 51163, 33.7222, -116.3745],
  ['Rancho Mirage', 'city', 17218, 33.7397, -116.4128], ['Cathedral City', 'city', 51493, 33.7797, -116.4653],
  ['Palm Springs', 'city', 44575, 33.8303, -116.5453], ['Cabazon', 'village', 2535, 33.9175, -116.7870],
  ['Banning', 'city', 29505, 33.9256, -116.8764], ['Beaumont', 'city', 53036, 33.9295, -116.9773],
  ['Calimesa', 'city', 10026, 34.0039, -117.0620], ['Redlands', 'city', 73168, 34.0556, -117.1825],
  ['San Bernardino', 'city', 222101, 34.1083, -117.2898], ['Rialto', 'city', 104026, 34.1064, -117.3703],
  ['Fontana', 'city', 208393, 34.0922, -117.4350], ['Rancho Cucamonga', 'city', 174453, 34.1064, -117.5931],
  ['Upland', 'city', 79040, 34.0975, -117.6484], ['Claremont', 'city', 37266, 34.0967, -117.7198],
  ['La Verne', 'city', 31334, 34.1008, -117.7678], ['San Dimas', 'city', 34924, 34.1067, -117.8067],
  ['Glendora', 'city', 52558, 34.1361, -117.8653], ['Azusa', 'city', 50000, 34.1336, -117.9076],
  ['Duarte', 'city', 21727, 34.1394, -117.9773], ['Monrovia', 'city', 37931, 34.1442, -118.0019],
  ['Arcadia', 'city', 56681, 34.1397, -118.0353], ['Pasadena', 'city', 138699, 34.1478, -118.1445],
  ['Los Angeles', 'city', 3820914, 34.1086, -118.2370],
];
log(`route_places after A: keep ${plKeep.map((r) => r.name).join(', ') || '—'} | drop ${plDrop.length} | add ${NEW_TOWNS.length} I-10 towns`);

// ---- notes ----
const notesIn = db.prepare(`SELECT id, title FROM route_notes WHERE end_mile > ?`).all(A.mile);
const NOTES = JSON.parse(fs.readFileSync('data/corridors/i10-notes.json', 'utf8')).map((n) => ({
  ...n, start: n.from === 'A' ? A.mile + 0.1 : townMile(n.from) + (n.fromOffset ?? 0), end: n.to === 'END' ? newEnd : townMile(n.to) + (n.toOffset ?? 0),
}));
log(`route_notes: delete ${notesIn.length} (${notesIn.map((n) => n.title.slice(0, 28)).join('; ')}), add ${NOTES.length}`);

// ---- local state tables ----
const daysTail = db.prepare(`SELECT COUNT(*) n FROM planned_days WHERE end_mile > ?`).get(A.mile + 0.5).n;
log(`planned_days (local copy, every revision): delete ${daysTail} rows ending past Casa Grande; planned_stops/canvas_marks/route_transits past A deleted`);
const riders = db.prepare(`SELECT id, name, lat, lng, route_mile FROM rider_places WHERE route_mile > ?`).all(A.mile)
  .map((r) => ({ ...r, ...project(r.lat, r.lng) }));
log(`rider_places past A re-anchored: ${riders.map((r) => `${r.name.slice(0, 28)} ${r1(r.route_mile)}→${r1(r.mile)} (${r1(r.off)} off)`).join('; ')}`);

// ---- camping.json / intel.json ----
const campPath = 'data/camping/camping.json', intelPath = 'data/intel/intel.json';
const intel = JSON.parse(fs.readFileSync(intelPath, 'utf8'));
const intelPast = intel.records.filter((r) => (r.startMile ?? -1) > A.mile);
log(`intel.json: ${intelPast.length} records past A → active:false/offRoute (camping.json is regenerated by build-camping.mjs, which retires off-route spots)`);
log(`population_cells past A: delete ${db.prepare(`SELECT COUNT(*) n FROM population_cells WHERE route_mile > ?`).get(A.mile).n} → then run ingest-population`);
log(`I-10 towns: ${I10.towns.map((t) => `${t.name} ${r1(A.mile + joinMi + t.mile)}`).join(' · ')}`);
console.log(plan.map((s) => ' - ' + s).join('\n'));
if (DRY) { console.log('\n--dry: nothing written'); process.exit(0); }

// ---- backups ----
fs.mkdirSync('backups', { recursive: true });
db.pragma('wal_checkpoint(TRUNCATE)');
for (const [src, dst] of [['data/trip.sqlite', `backups/trip-before-retrace-i10-${STAMP}.sqlite`], [campPath, `backups/camping-before-retrace-i10-${STAMP}.json`], [intelPath, `backups/intel-before-retrace-i10-${STAMP}.json`]]) fs.copyFileSync(src, dst);

const tx = db.transaction(() => {
  // plan rows first: they may reference beds that are about to go (FKs)
  db.prepare(`DELETE FROM planned_days WHERE end_mile > ?`).run(A.mile + 0.5);
  db.prepare(`DELETE FROM planned_stops WHERE route_mile > ?`).run(A.mile);
  db.prepare(`DELETE FROM canvas_marks WHERE route_mile > ?`).run(A.mile);
  db.prepare(`DELETE FROM route_transits WHERE start_mile > ? OR end_mile > ?`).run(A.mile, A.mile);

  // route_points
  db.prepare(`DELETE FROM route_points WHERE mile > ?`).run(A.mile);
  const ins = db.prepare(`INSERT INTO route_points (segment_id, seq, lat, lng, mile, elevation_m) VALUES (?, ?, ?, ?, ?, ?)`);
  let tmp = 3_000_000;
  pts.forEach((p, i) => ins.run(segFor(i), tmp++, p.lat, p.lng, p.mile, elevAt.get(i) ?? null));
  for (const seg of ['st-az', 'st-ca']) {
    db.prepare(`UPDATE route_points SET seq = seq + 5000000 WHERE segment_id=?`).run(seg);
    const rows = db.prepare(`SELECT rowid FROM route_points WHERE segment_id=? ORDER BY mile`).all(seg);
    const setSeq = db.prepare(`UPDATE route_points SET seq=? WHERE rowid=?`);
    rows.forEach((r, i) => setSeq.run(i, r.rowid));
  }

  // segments & route
  db.prepare(`DELETE FROM route_segments WHERE id='sd-la'`).run();
  db.prepare(`UPDATE route_segments SET end_mile=?, name=?, notes=?, retrieved_at=? WHERE id='st-az'`).run(
    borderMile,
    'Arizona: I-10 to Tucson, surface roads to Casa Grande, then Maricopa → Rainbow Valley → Buckeye → I-10 to Quartzsite and the Colorado River (rider’s 2026-11 line)',
    'I-10 is closed to bikes from Kolb Rd (Tucson) to Miller Rd (Buckeye); this line leaves Casa Grande on the Maricopa–Casa Grande Hwy, AZ 238 and Rainbow Valley Rd, then rides the I-10 shoulder (legal) west of Buckeye. Chosen 2026-11-01 over the I-8 / San Diego line: 440 mi to the Elysian vs 514, about 8,500 ft of climbing vs 13,200.',
    STAMP);
  db.prepare(`UPDATE route_segments SET start_mile=?, end_mile=?, name=?, provenance='reconstructed', source=?, confidence='medium', notes=?, retrieved_at=? WHERE id='st-ca'`).run(
    borderMile, newEnd,
    'California: Blythe → Desert Center → Indio → San Gorgonio Pass → Inland Empire → the Elysian Theater (I-10 corridor, rider’s 2026-11 line)',
    'FOSSGIS Valhalla legs (scripts/build-corridor-lines.mjs)',
    'I-10 shoulder Blythe → Indio; CV Link / surface streets through the Coachella Valley; Tamarack / Haugen-Lehmann frontage through the pass; Cherry Valley and Calimesa to Redlands; Pacific Electric Trail to Claremont; Route 66 to Pasadena; Colorado Blvd and the LA River area to the Elysian.',
    STAMP);
  db.prepare(`UPDATE routes SET total_miles=?, name=?, notes=?`).run(newEnd,
    'Grimey’s route: Pensacola → Southern Tier E→W → Tucson → I-10 corridor → Los Angeles (the Elysian Theater)',
    `Retraced ${STAMP}: west of Casa Grande the route follows the I-10 corridor and ends at the Elysian Theater; the I-8 / San Diego line is kept as a comparison layer.`);

  // resources: drop what the new line no longer passes, re-anchor the rest
  const dropIds = resDrop.map((r) => r.id);
  for (let i = 0; i < dropIds.length; i += 400) {
    const chunk = dropIds.slice(i, i + 400); const ph = chunk.map(() => '?').join(',');
    db.prepare(`UPDATE planned_days SET overnight_resource_id=NULL WHERE overnight_resource_id IN (${ph})`).run(...chunk);
    db.prepare(`DELETE FROM planned_stops WHERE resource_id IN (${ph})`).run(...chunk);
    db.prepare(`DELETE FROM resource_sources WHERE resource_id IN (${ph})`).run(...chunk);
    db.prepare(`DELETE FROM resources WHERE id IN (${ph})`).run(...chunk);
  }
  const upd = db.prepare(`UPDATE resources SET route_mile=?, off_route_mi=? WHERE id=?`);
  for (const r of resKeep) upd.run(r.mile, r.off, r.id);

  // rider places (state) and their resource mirrors
  for (const r of riders) {
    db.prepare(`UPDATE rider_places SET route_mile=?, off_route_mi=? WHERE id=?`).run(r.mile, r.off, r.id);
    db.prepare(`UPDATE resources SET route_mile=?, off_route_mi=? WHERE id=?`).run(r.mile, r.off, r.id);
  }

  // places
  for (const r of plDrop) db.prepare(`DELETE FROM route_places WHERE id=?`).run(r.id);
  const updPl = db.prepare(`UPDATE route_places SET route_mile=?, off_route_mi=? WHERE id=?`);
  for (const r of plKeep) updPl.run(r.mile, r.off, r.id);
  const insPl = db.prepare(`INSERT OR REPLACE INTO route_places (id, name, place_type, population, lat, lng, route_mile, off_route_mi) VALUES (?,?,?,?,?,?,?,?)`);
  for (const [name, type, pop, lat, lng] of NEW_TOWNS) { const p = project(lat, lng); insPl.run(`corridor-${name.toLowerCase().replace(/\s+/g, '-')}`, name, type, pop, lat, lng, p.mile, p.off); }

  // notes
  for (const n of notesIn) db.prepare(`DELETE FROM route_notes WHERE id=?`).run(n.id);
  const insN = db.prepare(`INSERT INTO route_notes (kind, title, detail, start_mile, end_mile, source, confidence) VALUES (?,?,?,?,?,?,?)`);
  for (const n of NOTES) insN.run(n.kind, n.title, n.detail, n.start, Math.max(n.end, n.start + 0.1), n.source ?? `retrace-i10 ${STAMP}`, n.confidence ?? 'medium');

  // population (re-ingested for the new window afterwards)
  db.prepare(`DELETE FROM population_cells WHERE route_mile > ?`).run(A.mile);
});
tx();

for (const r of intel.records) {
  if ((r.startMile ?? -1) > A.mile) { r.active = false; r.offRoute = true; r.anchorNote = `${r.anchorNote ? r.anchorNote + ' ' : ''}Off the ${STAMP} I-10 line (was on the I-8 / San Diego line).`; }
}
fs.writeFileSync(intelPath, JSON.stringify(intel));
db.pragma('wal_checkpoint(TRUNCATE)');
console.log(`\napplied. route ends at ${newEnd.toFixed(1)}; AZ→CA ${borderMile.toFixed(1)}; route_points ${db.prepare(`SELECT COUNT(*) n FROM route_points`).get().n}; resources ${db.prepare(`SELECT COUNT(*) n FROM resources`).get().n}; places ${db.prepare(`SELECT COUNT(*) n FROM route_places`).get().n}`);
console.log(`next: node scripts/build-camping.mjs · node scripts/ingest-resources.mjs --minMile=${Math.floor(A.mile)} --maxMile=${Math.ceil(newEnd)} · node scripts/ingest-population.mjs · update STATE_CROSSINGS (California ${borderMile.toFixed(1)}) in web/src/App.tsx`);
