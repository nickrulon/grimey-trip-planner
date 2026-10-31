// One-off retrace: replace the Bogalusa detour with the US 90 mainline the
// rider actually rode (Pass Christian → Bay St. Louis → Pearlington → Pearl
// River bridges → Rigolets → Chef Menteur Hwy), and shift every route-mile
// anchor west of it. Run with --dry first; it prints the plan and writes nothing.
import fs from 'node:fs';
import { openDb } from '../server/db.mjs';
import { haversineMi } from './lib/geo.mjs';

const DRY = process.argv.includes('--dry');
const GEO = process.argv.find((a) => a.startsWith('--geometry='))?.slice(11)
  ?? '/private/tmp/claude-501/-Users-nicklynn-rulon/4bf67dda-956b-490b-acb1-2e2dfd96c70c/scratchpad/us90-new.json';
const g = JSON.parse(fs.readFileSync(GEO, 'utf8'));
const db = openDb();
const r1 = (n) => Math.round(n * 10) / 10;

// ---- anchors on the OLD trace ----
const A = db.prepare(`SELECT seq, mile, lat, lng FROM route_points WHERE segment_id='st-ms' AND seq=2022`).get();
const P = db.prepare(`SELECT seq, mile, lat, lng FROM route_points WHERE segment_id='st-ms' AND seq=?`).get(g.Pseq);
if (haversineMi([A.lng, A.lat], g.full[0]) > 0.01 || haversineMi([P.lng, P.lat], g.full[g.full.length - 1]) > 0.01) {
  throw new Error('geometry endpoints do not match trace anchors A/P');
}
// new points strictly between A and P, with cumulative miles from A
const inner = [];
let m = A.mile;
for (let i = 1; i < g.full.length; i++) {
  m += haversineMi(g.full[i - 1], g.full[i]);
  if (i < g.full.length - 1) inner.push({ lng: g.full[i][0], lat: g.full[i][1], mile: m });
}
const newP = m;                       // P's new mile
const delta = newP - P.mile;          // negative
const oldSpan = P.mile - A.mile, newSpan = newP - A.mile;
console.log(`A mile ${A.mile.toFixed(2)} | P old ${P.mile.toFixed(2)} -> new ${newP.toFixed(2)} | span ${oldSpan.toFixed(2)} -> ${newSpan.toFixed(2)} | delta ${delta.toFixed(2)} mi`);

// project a coordinate onto the NEW A..P line
const line = [[g.full[0][0], g.full[0][1], A.mile], ...inner.map((p) => [p.lng, p.lat, p.mile]), [g.full[g.full.length - 1][0], g.full[g.full.length - 1][1], newP]];
const project = (lat, lng) => { let b = null, bd = Infinity; for (const p of line) { const d = haversineMi([lng, lat], [p[0], p[1]]); if (d < bd) { bd = d; b = p; } } return { mile: b[2], off: bd }; };
const linear = (oldMile) => A.mile + (oldMile - A.mile) * (newSpan / oldSpan);   // for rows with no coordinates
const inWin = (x) => x > A.mile && x < P.mile;
const plan = [];
const log = (s) => plan.push(s);

// ---- 1. route_points ----
const inWinPts = db.prepare(`SELECT COUNT(*) n FROM route_points WHERE segment_id='st-ms' AND seq>? AND seq<?`).get(A.seq, P.seq).n;
log(`route_points: delete ${inWinPts} detour pts, insert ${inner.length} US 90 pts (elevation NULL → run ingest-elevation), shift ${db.prepare(`SELECT COUNT(*) n FROM route_points WHERE mile>=?`).get(P.mile).n} pts by ${delta.toFixed(2)}, renumber st-ms seq`);

// ---- 2. segments / route ----
log(`route_segments: st-ms end ${db.prepare(`SELECT end_mile FROM route_segments WHERE id='st-ms'`).get().end_mile.toFixed(1)} -> ${(db.prepare(`SELECT end_mile FROM route_segments WHERE id='st-ms'`).get().end_mile + delta).toFixed(1)}; seq>=3 shift; routes.total_miles ${db.prepare(`SELECT total_miles FROM routes`).get().total_miles.toFixed(1)} -> ${(db.prepare(`SELECT total_miles FROM routes`).get().total_miles + delta).toFixed(1)}`);

// ---- 3. resources (have coords) ----
const corridor = Object.fromEntries(db.prepare(`SELECT id, corridor_width_mi FROM resource_categories`).all().map((c) => [c.id, c.corridor_width_mi]));
const resIn = db.prepare(`SELECT id, name, category_id, lat, lng, route_mile FROM resources WHERE route_mile>? AND route_mile<?`).all(A.mile, P.mile);
const resKeep = [], resDrop = [];
for (const r of resIn) { const p = project(r.lat, r.lng); const lim = r.id.startsWith('rider-') ? 25 : (corridor[r.category_id] ?? 3); (p.off <= lim ? resKeep : resDrop).push({ ...r, ...p }); }
log(`resources in window: ${resIn.length} → keep ${resKeep.length} (re-projected, e.g. ${resKeep.slice(0, 3).map((r) => `${r.name}@${r1(r.mile)}/${r.off.toFixed(1)}off`).join(', ')}), drop ${resDrop.length} detour-only (${resDrop.slice(0, 4).map((r) => r.name).join(', ')}…); shift ${db.prepare(`SELECT COUNT(*) n FROM resources WHERE route_mile>=?`).get(P.mile).n} after`);

// ---- 4. places (have coords) ----
const plIn = db.prepare(`SELECT id, name, lat, lng, route_mile FROM route_places WHERE route_mile>? AND route_mile<?`).all(A.mile, P.mile);
const plKeep = [], plDrop = [];
for (const r of plIn) { const p = project(r.lat, r.lng); (p.off <= 8 ? plKeep : plDrop).push({ ...r, ...p }); }
log(`route_places in window: keep ${plKeep.map((r) => `${r.name}@${r1(r.mile)}/${r.off.toFixed(1)}off`).join(', ')} | drop ${plDrop.map((r) => r.name).join(', ')} | +Pearlington added | shift after`);

// ---- 5. notes ----
const closureE = project(g.E[1], g.E[0]).mile, closureW = project(g.W[1], g.W[0]).mile;
log(`route_notes: #37 detour → rewritten as 'bridge' note at mi ${r1(closureE)}–${r1(closureW)} (closed spans + field report); #38 re-anchored ${r1(closureW)}→${r1(334.7 + delta)}; ${db.prepare(`SELECT COUNT(*) n FROM route_notes WHERE start_mile>=?`).get(P.mile).n} notes shift`);

// ---- 6. planned_stops ----
const stIn = db.prepare(`SELECT id, name, route_mile, resource_id FROM planned_stops WHERE route_mile>? AND route_mile<?`).all(A.mile, P.mile);
const stDecide = stIn.map((s) => { const r = s.resource_id ? db.prepare(`SELECT lat, lng FROM resources WHERE id=?`).get(s.resource_id) : null; const p = r ? project(r.lat, r.lng) : { off: 99 }; return { ...s, ...p, keep: p.off <= 3 }; });
log(`planned_stops in window: ${stDecide.map((s) => `${s.name}@${r1(s.route_mile)} → ${s.keep ? 'keep@' + r1(s.mile) : 'DROP (' + s.off.toFixed(1) + ' mi off)'}`).join('; ')}; shift ${db.prepare(`SELECT COUNT(*) n FROM planned_stops WHERE route_mile>=?`).get(P.mile).n} after`);

// ---- 7. days & actuals ----
const rv = db.prepare(`SELECT lat, lng FROM resources WHERE id='rider-bsl-rv-park'`).get();
const rvNew = project(rv.lat, rv.lng);
log(`Sunshine RV Park: mile 187.5 (5.5 off) → ${rvNew.mile.toFixed(2)} (${rvNew.off.toFixed(2)} off) — D3 end / D4 start / actual D3 follow it`);
const act4 = db.prepare(`SELECT end_mile FROM actual_days WHERE day_number=4`).get().end_mile;
log(`actual D4 end ${act4} → ${(act4 + delta).toFixed(1)}  ⇒ D4 = ${(act4 + delta - rvNew.mile).toFixed(1)} mi ridden (was showing ${(act4 - 187.5).toFixed(1)})`);
log(`planned_days: ${db.prepare(`SELECT COUNT(*) n FROM planned_days WHERE end_mile>=? OR start_mile>=?`).get(P.mile, P.mile).n} rows shift; ${db.prepare(`SELECT COUNT(*) n FROM planned_days WHERE (end_mile>? AND end_mile<?) OR (start_mile>? AND start_mile<?)`).get(A.mile, P.mile, A.mile, P.mile).n} historical in-window rows mapped linearly (old detour miles → new span) so history stays monotonic`);

// ---- 8. camping.json ----
const camp = JSON.parse(fs.readFileSync('data/camping/camping.json', 'utf8'));
const cIn = camp.spots.filter((s) => inWin(s.routeMile)); const cKeep = cIn.filter((s) => project(s.lat, s.lng).off <= 20);
log(`camping.json: ${cIn.length} spots in window → keep ${cKeep.length} (${cKeep.map((s) => s.name).join(', ')}), drop ${cIn.length - cKeep.length}; ${camp.spots.filter((s) => s.routeMile >= P.mile).length} spots + ${camp.dayAdvice.filter((a) => a.nearMile >= P.mile).length} advice shift; ${camp.dayAdvice.filter((a) => inWin(a.nearMile)).length} in-window advice mapped linearly`);
log(`population_cells: wipe all ${db.prepare(`SELECT COUNT(*) n FROM population_cells`).get().n} and re-run ingest-population.mjs against the new line`);

console.log('\nPLAN:'); for (const s of plan) console.log(' • ' + s);
if (DRY) { console.log('\n(dry run — nothing written)'); db.close(); process.exit(0); }

// =============================== APPLY ===============================
db.pragma('foreign_keys = OFF');
const tx = db.transaction(() => {
  const shift = (table, col) => db.prepare(`UPDATE ${table} SET ${col} = ${col} + ? WHERE ${col} >= ?`).run(delta, P.mile);
  // route_points: delete detour, shift tail, insert new, renumber
  db.prepare(`DELETE FROM route_points WHERE segment_id='st-ms' AND seq>? AND seq<?`).run(A.seq, P.seq);
  db.prepare(`UPDATE route_points SET mile = mile + ? WHERE mile >= ?`).run(delta, P.mile - 1e-6);
  const ins = db.prepare(`INSERT INTO route_points (segment_id, seq, lat, lng, mile, elevation_m) VALUES ('st-ms', ?, ?, ?, ?, NULL)`);
  let s = A.seq + 1; for (const p of inner) ins.run(s++, p.lat, p.lng, p.mile);   // seqs A.seq+1 … < P.seq? inner.length (868) < 2955 so no collision
  // renumber st-ms contiguously by mile
  // seq is 0-based and (segment_id, seq) is the primary key, so renumbering in
  // place collides with rows not yet visited. Park every seq far out of range
  // first, then assign contiguously in mile order.
  db.prepare(`UPDATE route_points SET seq = seq + 1000000 WHERE segment_id='st-ms'`).run();
  const rows = db.prepare(`SELECT rowid FROM route_points WHERE segment_id='st-ms' ORDER BY mile, seq`).all();
  const setSeq = db.prepare(`UPDATE route_points SET seq=? WHERE rowid=?`);
  rows.forEach((r, i) => setSeq.run(i, r.rowid));
  // segments & route
  db.prepare(`UPDATE route_segments SET end_mile = end_mile + ? WHERE id='st-ms'`).run(delta);
  db.prepare(`UPDATE route_segments SET start_mile = start_mile + ?, end_mile = end_mile + ? WHERE seq >= 3`).run(delta, delta);
  db.prepare(`UPDATE route_segments SET name = 'Mississippi Gulf Coast → New Orleans (US 90 mainline via Pearlington; ridden 23 Sep 2026)', provenance='reconstructed', confidence='high',
     source = 'US 90 mainline: OSM ways (incl. the vehicle-closed Pearl River spans) + BRouter on open road; rider rode it end-to-end 23 Sep 2026. Replaces the ACA Bogalusa detour trace.',
     notes = 'Pearl River bridges (mi ' || ? || '–' || ? || ') are closed to VEHICLES since 2022 (highway=construction/access=no in OSM) but were passable by bicycle on 23 Sep 2026.' WHERE id='st-ms'`).run(r1(closureE), r1(closureW));
  db.prepare(`UPDATE routes SET total_miles = total_miles + ?`).run(delta);
  // resources
  shift('resources', 'route_mile');
  const upd = db.prepare(`UPDATE resources SET route_mile=?, off_route_mi=? WHERE id=?`);
  for (const r of resKeep) upd.run(r.mile, r.off, r.id);
  const delRes = db.prepare(`DELETE FROM resources WHERE id=?`), delSrc = db.prepare(`DELETE FROM resource_sources WHERE resource_id=?`);
  for (const r of resDrop) { delSrc.run(r.id); delRes.run(r.id); }
  // places
  shift('route_places', 'route_mile');
  const updPl = db.prepare(`UPDATE route_places SET route_mile=?, off_route_mi=? WHERE id=?`);
  for (const r of plKeep) updPl.run(r.mile, r.off, r.id);
  for (const r of plDrop) db.prepare(`DELETE FROM route_places WHERE id=?`).run(r.id);
  const pear = project(30.2465, -89.6112);
  db.prepare(`INSERT OR REPLACE INTO route_places (id, name, place_type, population, lat, lng, route_mile, off_route_mi) VALUES ('rider-pearlington','Pearlington','village',1445,30.2465,-89.6112,?,?)`).run(pear.mile, pear.off);
  // notes
  shift('route_notes', 'start_mile'); db.prepare(`UPDATE route_notes SET end_mile = end_mile + ? WHERE end_mile >= ? AND id NOT IN (37,38)`).run(delta, P.mile);
  db.prepare(`UPDATE route_notes SET kind='bridge', title='US 90 Pearl River bridges — closed to vehicles', start_mile=?, end_mile=?, confidence='medium',
     detail='The West Pearl River bridge and three smaller US 90 spans at the MS/LA line have been closed to all vehicle traffic since 2022 (OSM: highway=construction, access=no); DOTD had no construction start before Jan 2027 as of Sep 2026. ACA''s official alternative is a 117-mi detour via Bogalusa. FIELD REPORT 23 Sep 2026: Grimey rode straight across on the closed spans without issue — passable by bicycle on that date. Conditions can change; check before relying on it.' WHERE id=37`).run(closureE, closureW);
  db.prepare(`UPDATE route_notes SET title='Rigolets & Chef Menteur Hwy into New Orleans', start_mile=?, end_mile=?,
     detail='US 90 from the Pearl River down the Rigolets (Fort Pike) and along Chef Menteur Hwy into New Orleans East — narrow in spots, almost no services between Pearlington and the city (Phil''s Marina Cafe and a general store are about it), and urban traffic builds steadily into the city.' WHERE id=38`).run(closureW, 334.7 + delta);
  // stops
  shift('planned_stops', 'route_mile');
  for (const s2 of stDecide) { if (s2.keep) db.prepare(`UPDATE planned_stops SET route_mile=? WHERE id=?`).run(s2.mile, s2.id); else db.prepare(`DELETE FROM planned_stops WHERE id=?`).run(s2.id); }
  // canvas_marks / transits
  shift('canvas_marks', 'route_mile'); shift('route_transits', 'start_mile'); shift('route_transits', 'end_mile');
  // planned_days: shift tails; map in-window (historical) linearly; then pin the RV park
  // ONE statement per column: each row is mapped from its OLD value exactly
  // once. Two sequential UPDATEs re-mapped rows the shift had just moved into
  // the window (the ranges overlap), which corrupted the live plan on the
  // first attempt.
  const f = newSpan / oldSpan;
  for (const col of ['end_mile', 'start_mile']) {
    db.prepare(`UPDATE planned_days SET ${col} = CASE
        WHEN ${col} >= ? THEN ${col} + ?
        WHEN ${col} > ? AND ${col} < ? THEN ? + (${col} - ?) * ?
        ELSE ${col} END`).run(P.mile, delta, A.mile, P.mile, A.mile, A.mile, f);
  }
  db.prepare(`UPDATE actual_days SET end_mile = end_mile + ? WHERE end_mile >= ?`).run(delta, P.mile);
  db.prepare(`UPDATE actual_days SET start_mile = start_mile + ? WHERE start_mile >= ?`).run(delta, P.mile);
  // the RV park: exact projection for the active revision + actuals
  const rev = db.prepare(`SELECT id FROM plan_revisions WHERE active=1`).get().id;
  db.prepare(`UPDATE planned_days SET end_mile=? WHERE revision_id=? AND day_number=3`).run(rvNew.mile, rev);
  db.prepare(`UPDATE planned_days SET start_mile=? WHERE revision_id=? AND day_number=4`).run(rvNew.mile, rev);
  db.prepare(`UPDATE actual_days SET end_mile=? WHERE day_number=3`).run(rvNew.mile);
  db.prepare(`UPDATE actual_days SET start_mile=? WHERE day_number=4`).run(rvNew.mile);
  // population: wipe (re-ingest follows)
  db.exec(`DELETE FROM population_cells`);
  // Guard: the live plan must agree with reality or the whole thing rolls back.
  const d4 = db.prepare(`SELECT start_mile, end_mile FROM planned_days WHERE revision_id=? AND day_number=4`).get(rev);
  const d5 = db.prepare(`SELECT start_mile FROM planned_days WHERE revision_id=? AND day_number=5`).get(rev);
  const a4 = db.prepare(`SELECT start_mile, end_mile FROM actual_days WHERE day_number=4`).get();
  const ok = Math.abs(d4.end_mile - a4.end_mile) < 0.05 && Math.abs(d5.start_mile - d4.end_mile) < 0.05 && Math.abs(d4.start_mile - a4.start_mile) < 0.05;
  if (!ok) throw new Error(`GUARD: D4 plan ${d4.start_mile}->${d4.end_mile} vs actual ${a4.start_mile}->${a4.end_mile}, D5 start ${d5.start_mile}`);
});
tx();
db.pragma('foreign_keys = ON');
// camping.json
for (const s2 of camp.spots) { if (s2.routeMile >= P.mile) s2.routeMile = r1(s2.routeMile + delta); else if (inWin(s2.routeMile)) { const p = project(s2.lat, s2.lng); s2.routeMile = r1(p.mile); s2._offRouteMi = r1(p.off); } }
camp.spots = camp.spots.filter((s2) => !(s2._offRouteMi > 20)); for (const s2 of camp.spots) delete s2._offRouteMi;
for (const a of camp.dayAdvice) { if (a.nearMile >= P.mile) a.nearMile = r1(a.nearMile + delta); else if (inWin(a.nearMile)) a.nearMile = r1(linear(a.nearMile)); }
camp.retraceNote = `Miles west of ${r1(A.mile)} shifted by ${delta.toFixed(2)} on 2026-09-23 (Bogalusa detour replaced by the US 90 mainline).`;
fs.writeFileSync('data/camping/camping.json', JSON.stringify(camp, null, 2));
console.log('\nAPPLIED. total_miles now', db.prepare(`SELECT total_miles FROM routes`).get().total_miles.toFixed(2));
db.close();
