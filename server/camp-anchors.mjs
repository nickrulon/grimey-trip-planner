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

// Ids must keep their meaning forever: plan days (in Netlify Blobs) point at
// them by id, so an id that is reused for a different camp silently swaps a
// past or planned bed. The mirror used to be `camp-res-${index}`, which a
// rebuilt camping.json re-dealt to different camps (2026-11-02 review). Now:
// reuse an existing camp-res row when it is the same place (normalized name,
// within ~1 mi); otherwise mint a content id from name + coordinates.
const GENERIC = new Set(['rv', 'park', 'resort', 'campground', 'camping', 'camp', 'area', 'blm', 'day', 'the', 'and',
  'county', 'state', 'beach', 'regional', 'site', 'sites', 'dispersed', 'land', 'road', 'rd', 'ltva', 'long', 'term',
  'visitor', 'of', 'at', 'formerly', 'aka', 'north', 'south', 'west', 'east', '14day', 'hipcamp', 'tent']);
const tokens = (n) => new Set(String(n).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/(\w)-(\w)/g, '$1$2')
  .split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t)));
const norm = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const shareToken = (a, b) => { const tb = tokens(b); return [...tokens(a)].some((t) => tb.has(t)); };
function contentId(s) {
  const key = `${norm(s.name)}|${Number(s.lat).toFixed(4)}|${Number(s.lng).toFixed(4)}`;
  let h = 2166136261; // FNV-1a, 32-bit
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `camp-res-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** Mirror researched camping spots into `resources` so the day planner can
 *  anchor nights on them. Idempotent and id-stable. Returns {added, updated, skipped, retired}. */
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
       address=excluded.address, route_mile=excluded.route_mile, off_route_mi=excluded.off_route_mi,
       phone=excluded.phone, website=excluded.website, attributes_json=excluded.attributes_json,
       status='active', last_verified=excluded.last_verified, user_notes=excluded.user_notes`);

  const existing = db.prepare(`SELECT id, name, lat, lng FROM resources WHERE id LIKE 'camp-res-%'`).all();
  // Don't double-count a spot OSM already knows about: an OSM id the research
  // cites, or the same place (≤ 0.15 mi) under an overlapping name.
  const osmRows = db.prepare(`SELECT id, name, lat, lng FROM resources WHERE id NOT LIKE 'camp-%'
     AND id NOT LIKE 'rider-%' AND category_id IN ('campground','hotel')`).all();
  const osmIds = new Set(osmRows.map((r) => r.id));
  const osmTwin = (s) => {
    for (const u of s.sources ?? []) {
      const m = String(u).match(/openstreetmap\.org\/(node|way|relation)\/(\d+)/);
      if (m && osmIds.has(`osm-${m[1]}-${m[2]}`)) return `osm-${m[1]}-${m[2]}`;
    }
    const near = osmRows.find((r) => hav(s.lat, s.lng, r.lat, r.lng) <= 0.15
      && (norm(r.name) === norm(s.name) || shareToken(r.name, s.name)));
    return near?.id ?? null;
  };

  // When OSM already has the place, the research enriches that row (one pin,
  // with the researched name, phone, notes and amenities) instead of adding a twin.
  const enrich = db.prepare(`UPDATE resources SET name=?, phone=COALESCE(?, phone), website=COALESCE(?, website),
       address=COALESCE(?, address), attributes_json=?, user_notes=COALESCE(?, user_notes), status='active',
       last_verified=? WHERE id=?`);
  const attrsOf = (id) => { try { return JSON.parse(db.prepare('SELECT attributes_json a FROM resources WHERE id=?').get(id)?.a || '{}'); } catch { return {}; } };
  let added = 0, updated = 0, skipped = 0, enriched = 0;
  const touched = new Set();
  const today = new Date().toISOString().slice(0, 10);
  const tx = db.transaction(() => {
    for (const s of spots) {
      const mile = s.routeMile;
      if (mile == null || s.lat == null || s.lng == null) { skipped++; continue; }
      const twin = osmTwin(s);
      if (twin) {
        const web = /^https?:\/\//.test(s.website ?? '') ? s.website : null;
        enrich.run(s.name, s.phone ?? null, web, s.locationNote ?? null,
          JSON.stringify({ ...attrsOf(twin), researched: true, confidence: s.confidence ?? null, price: s.price ?? null,
            tentsOk: s.tentsOk ?? null, showers: s.showers ?? null, water: s.water ?? null, toilets: s.toilets ?? null }),
          s.cyclistIntel ?? null, today, twin);
        enriched++; continue;
      }
      const off = Math.max(offRoute(s.lat, s.lng, mile), Number(s.offRouteMi) || 0);
      if (off > 12) { skipped++; continue; }            // too far to be a day-end
      const prior = existing.find((r) => !touched.has(r.id) && hav(s.lat, s.lng, r.lat, r.lng) <= 1
        && (norm(r.name) === norm(s.name) || shareToken(r.name, s.name)));
      const id = prior?.id ?? contentId(s);
      touched.add(id);
      up.run(
        id, s.name, s.lat, s.lng, s.locationNote ?? null, s.phone ?? null,
        s.website ?? null, mile, off,
        JSON.stringify({
          researched: true, confidence: s.confidence ?? null, price: s.price ?? null,
          tentsOk: s.tentsOk ?? null, showers: s.showers ?? null,
          water: s.water ?? null, toilets: s.toilets ?? null,
        }),
        today, today, s.cyclistIntel ?? null
      );
      if (prior) updated++; else added++;
    }
    // Rows whose spot is gone stay (plan days may point at them) but go quiet.
    const retire = db.prepare(`UPDATE resources SET status='retired' WHERE id=?`);
    for (const r of existing) if (!touched.has(r.id)) retire.run(r.id);
  });
  tx();
  return { added, updated, enriched, skipped, retired: existing.filter((r) => !touched.has(r.id)).length };
}
