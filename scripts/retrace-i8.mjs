// One-off retrace (2026-10-11): replace the ACA line west of Las Cruces
// (Hatch → Emory Pass → Silver City → Safford → Globe → Phoenix → Blythe →
// Brawley → Calexico → Ocotillo) with the rider's chosen I-10 / I-8 corridor
// (Deming → Lordsburg → Willcox → Benson → Tucson → Casa Grande → Gila Bend
// → Dateland → Wellton → Yuma → Holtville → El Centro → Ocotillo), and shift
// every route-mile anchor west of Ocotillo. Geometry comes from
// scratchpad/i8-new.json (FOSSGIS Valhalla legs, see the session notes).
//
//   node scripts/retrace-i8.mjs --dry      # print the plan, write nothing
//   node scripts/retrace-i8.mjs            # apply (backs up data/ first)
//
// Reference tables only. The live PLAN lives in Netlify Blobs and is rebuilt
// afterwards through POST /api/plan/retrace-tail — never push-state from here.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.mjs';
import { haversineMi } from './lib/geo.mjs';

const DRY = process.argv.includes('--dry');
const GEO = process.argv.find((a) => a.startsWith('--geometry='))?.slice(11)
  ?? '/private/tmp/claude-501/-Users-nicklynn-rulon/4bf67dda-956b-490b-acb1-2e2dfd96c70c/scratchpad/i8-new.json';
const g = JSON.parse(fs.readFileSync(GEO, 'utf8'));
const db = openDb();
const r1 = (n) => Math.round(n * 10) / 10;
const STAMP = '2026-10-11';

// ---- anchors on the OLD trace ----
const A = db.prepare(`SELECT segment_id, seq, mile, lat, lng FROM route_points WHERE segment_id=? AND seq=?`).get(g.A.segment, g.A.seq);
const P = db.prepare(`SELECT segment_id, seq, mile, lat, lng FROM route_points WHERE segment_id=? AND seq=?`).get(g.P.segment, g.P.seq);
if (haversineMi([A.lng, A.lat], g.full[0]) > 0.05 || haversineMi([P.lng, P.lat], g.full[g.full.length - 1]) > 0.05) {
  throw new Error('geometry endpoints do not match trace anchors A/P');
}

// New points strictly between A and P with cumulative miles from A.
const inner = [];
let m = A.mile;
for (let i = 1; i < g.full.length; i++) {
  m += haversineMi(g.full[i - 1], g.full[i]);
  if (i < g.full.length - 1) inner.push({ lng: g.full[i][0], lat: g.full[i][1], mile: m });
}
const newP = m;
const delta = newP - P.mile;
const oldSpan = P.mile - A.mile, newSpan = newP - A.mile;
console.log(`A ${A.segment_id}#${A.seq} mile ${A.mile.toFixed(2)} | P ${P.segment_id}#${P.seq} old ${P.mile.toFixed(2)} → new ${newP.toFixed(2)} | span ${oldSpan.toFixed(1)} → ${newSpan.toFixed(1)} | delta ${delta.toFixed(2)} mi`);

// State attribution for the new points (NM → AZ at the 109°02'51" meridian,
// AZ → CA at the Colorado River through Yuma).
const segFor = (lng) => (lng > -109.0475 ? 'st-nm' : lng > -114.63 ? 'st-az' : 'st-ca');
const nmAz = inner.find((p) => p.lng <= -109.0475)?.mile;
const azCa = inner.find((p) => p.lng <= -114.63)?.mile;
console.log(`state lines on the new span: NM→AZ mi ${nmAz?.toFixed(1)} · AZ→CA mi ${azCa?.toFixed(1)}`);

// Project a coordinate onto the NEW A..P line.
const line = [[g.full[0][0], g.full[0][1], A.mile], ...inner.map((p) => [p.lng, p.lat, p.mile]), [g.full[g.full.length - 1][0], g.full[g.full.length - 1][1], newP]];
// coarse index every ~1 mi for speed, then refine around the best coarse hit
const coarse = line.filter((_, i) => i % 10 === 0);
const project = (lat, lng) => {
  let b = null, bd = Infinity;
  for (const p of coarse) { const d = haversineMi([lng, lat], [p[0], p[1]]); if (d < bd) { bd = d; b = p; } }
  const idx = line.indexOf(b);
  for (let i = Math.max(0, idx - 12); i < Math.min(line.length, idx + 12); i++) { const d = haversineMi([lng, lat], [line[i][0], line[i][1]]); if (d < bd) { bd = d; b = line[i]; } }
  return { mile: b[2], off: bd };
};
const inWin = (x) => x > A.mile && x < P.mile;
const plan = []; const log = (s) => plan.push(s);

// ---- 1. route_points ----
const inWinPts = db.prepare(`SELECT COUNT(*) n FROM route_points WHERE mile>? AND mile<?`).get(A.mile, P.mile).n;
log(`route_points: delete ${inWinPts} old-line pts, insert ${inner.length} corridor pts (elevation NULL → run ingest-elevation), shift ${db.prepare(`SELECT COUNT(*) n FROM route_points WHERE mile>=?`).get(P.mile).n} pts by ${delta.toFixed(2)}, renumber st-nm/st-az/st-ca; drop st-az-w`);

// ---- 2. resources ----
const corridor = Object.fromEntries(db.prepare(`SELECT id, corridor_width_mi FROM resource_categories`).all().map((c) => [c.id, c.corridor_width_mi]));
const resIn = db.prepare(`SELECT id, name, category_id, lat, lng, route_mile FROM resources WHERE route_mile>? AND route_mile<?`).all(A.mile, P.mile);
const resKeep = [], resDrop = [];
for (const r of resIn) { const p = project(r.lat, r.lng); const lim = r.id.startsWith('rider-') ? 25 : (corridor[r.category_id] ?? 3); (p.off <= lim ? resKeep : resDrop).push({ ...r, ...p }); }
log(`resources in window: ${resIn.length} → keep ${resKeep.length} (e.g. ${resKeep.slice(0, 4).map((r) => `${r.name}@${r1(r.mile)}`).join(', ')}), drop ${resDrop.length}; shift ${db.prepare(`SELECT COUNT(*) n FROM resources WHERE route_mile>=?`).get(P.mile).n} after P`);

// ---- 3. places ----
const plIn = db.prepare(`SELECT id, name, lat, lng, route_mile FROM route_places WHERE route_mile>? AND route_mile<?`).all(A.mile, P.mile);
const plKeep = [], plDrop = [];
for (const r of plIn) { const p = project(r.lat, r.lng); (p.off <= 8 ? plKeep : plDrop).push({ ...r, ...p }); }
const NEW_TOWNS = [
  ['Deming', 'town', 14758, 32.2687, -107.7586], ['Willcox', 'town', 3213, 32.2529, -109.8320], ['Benson', 'town', 4887, 31.9679, -110.2943],
  ['Vail', 'village', 14938, 32.0481, -110.7137], ['Tucson', 'city', 542629, 32.2217, -110.9698], ['Marana', 'town', 51908, 32.4367, -111.2254],
  ['Picacho', 'village', 470, 32.7159, -111.4976], ['Eloy', 'town', 15635, 32.7559, -111.5548], ['Casa Grande', 'city', 55653, 32.8795, -111.7574],
  ['Gila Bend', 'town', 1892, 32.9478, -112.7168], ['Sentinel', 'village', 50, 32.8740, -113.2190], ['Dateland', 'village', 416, 32.7998, -113.5338],
  ['Tacna', 'village', 602, 32.6923, -113.9522], ['Wellton', 'town', 2882, 32.6726, -114.1469], ['Yuma', 'city', 95548, 32.6927, -114.6277],
  ['Winterhaven', 'village', 394, 32.7392, -114.6358], ['Holtville', 'town', 6330, 32.8112, -115.3803],
];
log(`route_places in window: keep ${plKeep.map((r) => `${r.name}@${r1(r.mile)}`).join(', ')} | drop ${plDrop.length} (${plDrop.slice(0, 6).map((r) => r.name).join(', ')}…) | add ${NEW_TOWNS.length} corridor towns | shift after P`);

// ---- 4. notes ----
const notesIn = db.prepare(`SELECT id, title FROM route_notes WHERE start_mile>? AND start_mile<?`).all(A.mile, P.mile);
const NEW_NOTES = [
  ['highway', 'I-10 shoulder: Las Cruces → Deming → Lordsburg → Willcox → Benson', 'Bikes are legal on rural interstate shoulders in New Mexico and Arizona. Wide, smooth, debris-prone; trucks at 75 mph. Carry spare tubes. Use the NM 549 / old US 80 frontage roads where they exist (most of Las Cruces → Deming).', A.mile + 0.1, A.mile + 229.6],
  ['no_services', 'Lordsburg → Willcox: 74 mi, gas only at San Simon (mi 44) and Bowie (mi 58)', 'Steins Pass 4,600 ft then down to San Simon. No motels between.', A.mile + 119.9, A.mile + 194.2],
  ['highway', 'Tucson: I-10 closed to bicycles from Kolb Rd (exit 270) to Buckeye', 'Leave I-10 at Houghton Rd / Kolb Rd and ride surface streets through Tucson and Marana; rejoin the corridor on the Casa Grande Hwy (old US 84 / AZ 87) to Casa Grande. The ban covers the whole Phoenix–Tucson stretch; this line avoids Phoenix entirely via I-8.', A.mile + 261.8, A.mile + 353.5],
  ['no_services', 'Gila Bend → Dateland: 50 mi, nothing', 'Sentinel rest area has toilets, no store. Dateland has a travel center and an RV park.', A.mile + 416.1, A.mile + 466.2],
  ['highway', 'Wellton → Yuma on old US 80, not I-8', 'I-8 is posted no-bicycles approaching Yuma; the old highway (Dome Valley / Old Hwy 80) parallels it into town.', A.mile + 504.0, A.mile + 535.7],
  ['no_services', 'Yuma → Holtville: 51 mi across the Imperial dunes', 'I-8 shoulder is legal in the California desert. Gordon’s Well / Sand Hills rest area has water. Holtville and El Centro are full towns.', A.mile + 535.7, A.mile + 586.6],
  ['highway', 'Ocotillo → Jacumba: I-8 is now closed to bikes between Ocotillo and CA 98', 'Ride CA 98 for 2 mi then Old Highway 80 up the In-Ko-Pah grade (2,800 ft in 15 mi, 5–6%). Jacumba Hot Springs at the top.', newP, newP + 19],
];
log(`route_notes: delete ${notesIn.length} old-line notes (${notesIn.slice(0, 4).map((n) => n.title.slice(0, 30)).join('; ')}…), add ${NEW_NOTES.length} corridor notes, shift ${db.prepare(`SELECT COUNT(*) n FROM route_notes WHERE start_mile>=?`).get(P.mile).n} after P`);

// ---- 5. local state tables (the live copies live in Blobs; keep local dev coherent) ----
const daysTail = db.prepare(`SELECT COUNT(*) n FROM planned_days WHERE start_mile>=?`).get(A.mile - 0.5).n;
log(`planned_days (local only): delete ${daysTail} tail rows past Las Cruces; planned_stops/canvas_marks/route_transits in window deleted, after P shifted`);

// ---- 6. camping.json / intel.json ----
const campPath = path.join('data/camping/camping.json'), intelPath = path.join('data/intel/intel.json');
const camp = JSON.parse(fs.readFileSync(campPath, 'utf8'));
const campIn = camp.spots.filter((s) => inWin(s.routeMile ?? -1));
const campKeep = [], campRetire = [];
for (const s of campIn) { const p = project(s.lat, s.lng); (p.off <= 5 ? campKeep : campRetire).push({ s, p }); }
log(`camping.json: ${campIn.length} spots in window → keep ${campKeep.length} (${campKeep.map((k) => k.s.name.slice(0, 22)).join(', ')}), retire ${campRetire.length}; shift ${camp.spots.filter((s) => (s.routeMile ?? -1) >= P.mile).length} after P`);
const intel = JSON.parse(fs.readFileSync(intelPath, 'utf8'));
const intelIn = intel.records.filter((r) => inWin(r.startMile ?? -1));
log(`intel.json: ${intelIn.length} records in window → active:false/offRoute; shift ${intel.records.filter((r) => (r.startMile ?? -1) >= P.mile).length} after P`);

// ---- 7. population ----
log(`population_cells: delete ${db.prepare(`SELECT COUNT(*) n FROM population_cells WHERE route_mile>? AND route_mile<?`).get(A.mile, P.mile).n} in window, shift ${db.prepare(`SELECT COUNT(*) n FROM population_cells WHERE route_mile>=?`).get(P.mile).n} after → then run ingest-population for the window`);

log(`routes.total_miles ${db.prepare(`SELECT total_miles FROM routes`).get().total_miles.toFixed(1)} → ${(db.prepare(`SELECT total_miles FROM routes`).get().total_miles + delta).toFixed(1)}`);
log(`corridor miles: ${g.waypoints.map((w) => `${w.name} ${(A.mile + w.cum).toFixed(1)}`).join(' · ')}`);
console.log(plan.map((s) => ' - ' + s).join('\n'));
if (DRY) { console.log('\n--dry: nothing written'); process.exit(0); }

// ---- backups ----
fs.mkdirSync('backups', { recursive: true });
for (const [src, dst] of [['data/trip.sqlite', `backups/trip-before-retrace-i8-${STAMP}.sqlite`], [campPath, `backups/camping-before-retrace-i8-${STAMP}.json`], [intelPath, `backups/intel-before-retrace-i8-${STAMP}.json`]]) fs.copyFileSync(src, dst);
db.pragma('wal_checkpoint(TRUNCATE)');

const tx = db.transaction(() => {
  const shift = (table, col, where = '') => db.prepare(`UPDATE ${table} SET ${col} = ${col} + ? WHERE ${col} >= ? ${where}`).run(delta, P.mile);

  // route_points
  db.prepare(`DELETE FROM route_points WHERE mile>? AND mile<?`).run(A.mile, P.mile);
  db.prepare(`UPDATE route_points SET mile = mile + ? WHERE mile >= ?`).run(delta, P.mile - 1e-6);
  db.prepare(`UPDATE route_points SET segment_id='st-az' WHERE segment_id='st-az-w'`).run();
  const ins = db.prepare(`INSERT INTO route_points (segment_id, seq, lat, lng, mile, elevation_m) VALUES (?, ?, ?, ?, ?, NULL)`);
  let tmp = 2_000_000;
  for (const p of inner) ins.run(segFor(p.lng), tmp++, p.lat, p.lng, p.mile);
  for (const seg of ['st-nm', 'st-az', 'st-ca']) {
    db.prepare(`UPDATE route_points SET seq = seq + 1000000 WHERE segment_id=?`).run(seg);
    const rows = db.prepare(`SELECT rowid FROM route_points WHERE segment_id=? ORDER BY mile`).all(seg);
    const setSeq = db.prepare(`UPDATE route_points SET seq=? WHERE rowid=?`);
    rows.forEach((r, i) => setSeq.run(i, r.rowid));
  }
  // segments & route
  db.prepare(`DELETE FROM route_segments WHERE id='st-az-w'`).run();
  db.prepare(`UPDATE route_segments SET end_mile=?, name='New Mexico: El Paso → Las Cruces → I-10 corridor to the Arizona line (rider’s 2026-10 time-saving line; skips Emory Pass)', provenance='reconstructed', confidence='high', notes='West of Las Cruces: NM 549 / old US 80 frontage + I-10 shoulder (legal, rural). Chosen 2026-10-10 to avoid Emory Pass and reach LA by Nov 12.' WHERE id='st-nm'`).run(nmAz);
  db.prepare(`UPDATE route_segments SET start_mile=?, end_mile=?, seq=7, name='Arizona: I-10 to Tucson, surface roads to Casa Grande, I-8 to Yuma (rider’s 2026-10 line)', provenance='reconstructed', confidence='high', notes='I-10 is closed to bikes Kolb Rd → Buckeye; this line leaves it at Houghton Rd and uses old US 84/AZ 87 to Casa Grande, then I-8 (legal) to Wellton and old US 80 into Yuma.' WHERE id='st-az'`).run(nmAz, azCa);
  db.prepare(`UPDATE route_segments SET start_mile=?, end_mile=end_mile+?, seq=8, name='California: Yuma → Imperial Valley → In-Ko-Pah → San Diego (I-8 / Old Hwy 80)' WHERE id='st-ca'`).run(azCa, delta);
  db.prepare(`UPDATE route_segments SET start_mile=start_mile+?, end_mile=end_mile+?, seq=9 WHERE id='sd-la'`).run(delta, delta);
  db.prepare(`UPDATE routes SET total_miles = total_miles + ?`).run(delta);

  // Tail plan rows (every revision) go first: they may reference beds that
  // are about to be dropped, and resources has FKs from planned_days,
  // planned_stops and resource_sources.
  db.prepare(`DELETE FROM planned_days WHERE end_mile > ?`).run(A.mile + 0.5);
  const dropIds = resDrop.map((r) => r.id);
  for (let i = 0; i < dropIds.length; i += 400) {
    const chunk = dropIds.slice(i, i + 400); const ph = chunk.map(() => '?').join(',');
    db.prepare(`UPDATE planned_days SET overnight_resource_id=NULL WHERE overnight_resource_id IN (${ph})`).run(...chunk);
    db.prepare(`DELETE FROM planned_stops WHERE resource_id IN (${ph})`).run(...chunk);
    db.prepare(`DELETE FROM resource_sources WHERE resource_id IN (${ph})`).run(...chunk);
    db.prepare(`DELETE FROM resources WHERE id IN (${ph})`).run(...chunk);
  }
  // resources
  const upd = db.prepare(`UPDATE resources SET route_mile=?, off_route_mi=? WHERE id=?`);
  shift('resources', 'route_mile');
  for (const r of resKeep) upd.run(r.mile, r.off, r.id);

  // places
  shift('route_places', 'route_mile');
  const updPl = db.prepare(`UPDATE route_places SET route_mile=?, off_route_mi=? WHERE id=?`);
  for (const r of plKeep) updPl.run(r.mile, r.off, r.id);
  for (const r of plDrop) db.prepare(`DELETE FROM route_places WHERE id=?`).run(r.id);
  const insPl = db.prepare(`INSERT OR REPLACE INTO route_places (id, name, place_type, population, lat, lng, route_mile, off_route_mi) VALUES (?,?,?,?,?,?,?,?)`);
  for (const [name, type, pop, lat, lng] of NEW_TOWNS) { const p = project(lat, lng); insPl.run(`corridor-${name.toLowerCase().replace(/\s+/g, '-')}`, name, type, pop, lat, lng, p.mile, p.off); }

  // notes
  db.prepare(`UPDATE route_notes SET end_mile = end_mile + ? WHERE end_mile >= ?`).run(delta, P.mile);
  shift('route_notes', 'start_mile');
  for (const n of notesIn) db.prepare(`DELETE FROM route_notes WHERE id=?`).run(n.id);
  const insN = db.prepare(`INSERT INTO route_notes (kind, title, detail, start_mile, end_mile, source, confidence) VALUES (?,?,?,?,?,?,?)`);
  for (const [kind, title, detail, s, e] of NEW_NOTES) insN.run(kind, title, detail, s, e, 'retrace-i8 2026-10-11 (azbikelaw.org, Caltrans freeway access, efgh.com old80)', 'medium');

  // local state tables
  db.prepare(`DELETE FROM planned_stops WHERE route_mile>? AND route_mile<?`).run(A.mile, P.mile); shift('planned_stops', 'route_mile');
  db.prepare(`DELETE FROM canvas_marks WHERE route_mile>? AND route_mile<?`).run(A.mile, P.mile); shift('canvas_marks', 'route_mile');
  db.prepare(`DELETE FROM route_transits WHERE start_mile>? AND start_mile<?`).run(A.mile, P.mile); shift('route_transits', 'start_mile'); db.prepare(`UPDATE route_transits SET end_mile=end_mile+? WHERE end_mile>=?`).run(delta, P.mile);

  // population
  db.prepare(`DELETE FROM population_cells WHERE route_mile>? AND route_mile<?`).run(A.mile, P.mile); shift('population_cells', 'route_mile');
});
tx();

// camping.json
for (const s of camp.spots) {
  if ((s.routeMile ?? -1) >= P.mile) s.routeMile = +(s.routeMile + delta).toFixed(2);
}
const retired = [];
camp.spots = camp.spots.filter((s) => {
  const k = campKeep.find((x) => x.s === s); const r = campRetire.find((x) => x.s === s);
  if (k) { s.routeMile = +k.p.mile.toFixed(2); s.locationNote = `${s.locationNote ?? ''} [re-anchored to the I-10/I-8 line ${STAMP}, ${k.p.off.toFixed(1)} mi off]`.trim(); return true; }
  if (r) { retired.push({ ...s, retiredReason: `old ACA line west of Las Cruces (${r.p.off.toFixed(0)} mi from the corridor), ${STAMP}` }); return false; }
  return true;
});
camp.retired = [...(camp.retired ?? []), ...retired];
camp.retraceNote = `${camp.retraceNote ? camp.retraceNote + ' ' : ''}${STAMP}: route west of Las Cruces replaced by the I-10/I-8 corridor (−${Math.abs(delta).toFixed(1)} mi); ${retired.length} spots retired, ${campKeep.length} re-anchored, later spots shifted.`;
fs.writeFileSync(campPath, JSON.stringify(camp, null, 1));

// intel.json
for (const r of intel.records) {
  if (inWin(r.startMile ?? -1)) { r.active = false; r.offRoute = true; r.anchorNote = `${r.anchorNote ? r.anchorNote + ' ' : ''}Off the ${STAMP} I-10/I-8 corridor.`; }
  else if ((r.startMile ?? -1) >= P.mile) { r.startMile = +(r.startMile + delta).toFixed(2); if (r.endMile != null) r.endMile = +(r.endMile + delta).toFixed(2); }
}
fs.writeFileSync(intelPath, JSON.stringify(intel));
db.pragma('wal_checkpoint(TRUNCATE)');
console.log(`\napplied. new total ${db.prepare(`SELECT total_miles FROM routes`).get().total_miles.toFixed(1)} mi; route_points ${db.prepare(`SELECT COUNT(*) n FROM route_points`).get().n}; places ${db.prepare(`SELECT COUNT(*) n FROM route_places`).get().n}; resources ${db.prepare(`SELECT COUNT(*) n FROM resources`).get().n}`);
console.log(`next: node scripts/ingest-elevation.mjs · node scripts/ingest-places.mjs --minMile=${Math.floor(A.mile)} --maxMile=${Math.ceil(newP)} · node scripts/ingest-resources.mjs --minMile=${Math.floor(A.mile)} --maxMile=${Math.ceil(newP)} · node scripts/ingest-population.mjs`);
