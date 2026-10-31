// The camping research is hand-made, cyclist-specific and confidence-rated —
// by far the best bed data in this app. It was being served as a *guide*
// alongside the plan while the day-planner's own bed search (overnightsInWindow)
// read only `resources`, so a researched camp could sit dead on the route and
// the planner would still flag the night no_anchor and shorten the day to reach
// some OSM motel instead. Mirroring the spots into `resources` closes that:
// same table, same joins, same scoring, no second code path.
import fs from 'node:fs';
import path from 'node:path';

function findDataFile() {
  const rel = path.join('data', 'camping', 'camping.json');
  const roots = [process.cwd(), process.env.LAMBDA_TASK_ROOT, '/var/task', path.join(process.cwd(), '..')];
  for (const r of roots) {
    if (!r) continue;
    const p = path.join(r, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const R = 3958.8;
const rad = (d) => (d * Math.PI) / 180;
const hav = (a1, o1, a2, o2) => {
  const dla = rad(a2 - a1), dlo = rad(o2 - o1);
  const x = Math.sin(dla / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

/** Mirror researched camping spots into `resources` so the day planner can
 *  anchor nights on them. Idempotent. Returns {added, skipped}. */
export function syncCampSpots(db) {
  const file = findDataFile();
  if (!file) return { added: 0, skipped: 0, note: 'camping.json not found' };
  let spots = [];
  try { spots = JSON.parse(fs.readFileSync(file, 'utf8')).spots ?? []; }
  catch { return { added: 0, skipped: 0, note: 'camping.json unreadable' }; }

  // Route points, for the off-route distance the planner scores on.
  const pts = db.prepare('SELECT lat, lng, mile FROM route_points ORDER BY mile').all();
  const offRoute = (lat, lng, mile) => {
    let best = Infinity;
    for (const p of pts) {
      if (Math.abs(p.mile - mile) > 25) continue;      // only near its own anchor
      const d = hav(lat, lng, p.lat, p.lng);
      if (d < best) best = d;
    }
    return Number.isFinite(best) ? best : 0;
  };

  const up = db.prepare(`INSERT INTO resources
      (id, category_id, name, brand, lat, lng, address, phone, website, hours,
       route_mile, off_route_mi, wifi_status, attributes_json, status, first_seen, last_verified, user_notes)
     VALUES (?,'campground',?,NULL,?,?,?,?,?,NULL,?,?,NULL,?,'active',?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lng=excluded.lng,
       route_mile=excluded.route_mile, off_route_mi=excluded.off_route_mi,
       phone=excluded.phone, website=excluded.website, user_notes=excluded.user_notes`);

  // Don't double-count a spot OSM already knows about: same name, same place.
  const dupe = db.prepare(`SELECT 1 FROM resources WHERE id NOT LIKE 'camp-%'
     AND category_id IN ('campground','hotel') AND lower(name)=lower(?)
     AND route_mile BETWEEN ? AND ? LIMIT 1`);

  let added = 0, skipped = 0;
  const today = new Date().toISOString().slice(0, 10);
  const tx = db.transaction(() => {
    for (const [i, s] of spots.entries()) {
      const mile = s.routeMile;
      if (mile == null || s.lat == null || s.lng == null) { skipped++; continue; }
      if (dupe.get(s.name, mile - 2, mile + 2)) { skipped++; continue; }
      const off = offRoute(s.lat, s.lng, mile);
      if (off > 12) { skipped++; continue; }            // too far to be a day-end
      up.run(
        `camp-res-${i}`, s.name, s.lat, s.lng, s.locationNote ?? null, s.phone ?? null,
        s.website ?? null, mile, off,
        JSON.stringify({
          researched: true, confidence: s.confidence ?? null, price: s.price ?? null,
          tentsOk: s.tentsOk ?? null, showers: s.showers ?? null,
          water: s.water ?? null, toilets: s.toilets ?? null,
        }),
        today, today, s.cyclistIntel ?? null
      );
      added++;
    }
  });
  tx();
  return { added, skipped };
}
