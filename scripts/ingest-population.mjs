// Population along the corridor, from the 2020 Census at block-group level.
//
// Why block groups: they are the finest geography whose population AND
// centroid come from one lightweight request (TIGERweb, no key, no shapefile).
// Tracts are too coarse out west — a 900 sq mi tract's centroid can sit 40 mi
// from the only town in it — and blocks would be ~200k rows for no visual gain.
// Purpose is a glance-level "is there anybody out here" layer, not a census.
import { openDb } from '../server/db.mjs';

const UA = 'grimey-trip-planner/1.0 (personal bike tour planner)';
const LAYER = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/11/query';
const CHUNK_MI = 40;      // route window per request
const PAD_DEG = 0.4;      // ~25 mi of breathing room around each window
const KEEP_MI = 25;       // beyond this the cell is not "along the route"
const SQ_M_PER_SQ_MI = 2589988.11;

const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS population_cells (
    geoid TEXT PRIMARY KEY,
    lat REAL NOT NULL, lng REAL NOT NULL,
    pop INTEGER NOT NULL, housing INTEGER,
    aland_sqmi REAL NOT NULL, density REAL NOT NULL,
    route_mile REAL NOT NULL, off_route_mi REAL NOT NULL,
    source TEXT NOT NULL, retrieved_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_popcells_mile ON population_cells(route_mile);
`);

const startMile = Number(db.prepare(`SELECT value FROM settings WHERE key='tripStartMile'`).get()?.value) || 0;
const pts = db.prepare(`SELECT lat, lng, mile FROM route_points WHERE mile >= ? ORDER BY mile`).all(startMile);
console.log(`route: ${pts.length} points from mile ${startMile}`);

// Reference points every ~0.5 mi for projecting cells onto the route.
const ref = [];
let nextAt = -1;
for (const p of pts) if (p.mile >= nextAt) { ref.push(p); nextAt = p.mile + 0.5; }

const R = 3958.8, RAD = Math.PI / 180;
const hav = (lat1, lng1, lat2, lng2) => {
  const dLa = (lat2 - lat1) * RAD, dLn = (lng2 - lng1) * RAD;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLn / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
function project(lat, lng) {
  let best = null, bd = Infinity;
  for (const p of ref) {
    if (Math.abs(p.lat - lat) > 0.5 || Math.abs(p.lng - lng) > 0.6) continue; // cheap prune
    const d = hav(lat, lng, p.lat, p.lng);
    if (d < bd) { bd = d; best = p; }
  }
  return best ? { mile: best.mile, off: bd } : null;
}

// Windows of route: bbox of every point in each CHUNK_MI stretch, padded.
const windows = [];
for (let i = 0; i < pts.length;) {
  const m0 = pts[i].mile;
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, j = i;
  while (j < pts.length && pts[j].mile < m0 + CHUNK_MI) {
    const p = pts[j++];
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
  }
  windows.push([minLng - PAD_DEG, minLat - PAD_DEG, maxLng + PAD_DEG, maxLat + PAD_DEG]);
  i = j;
}
console.log(`${windows.length} corridor windows to fetch`);

async function fetchWindow(bbox, attempt = 1) {
  const q = new URLSearchParams({
    where: '1=1', geometry: bbox.map((n) => n.toFixed(4)).join(','),
    geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: 'GEOID,POP100,HU100,AREALAND,CENTLAT,CENTLON', returnGeometry: 'false', f: 'json',
  });
  const res = await fetch(`${LAYER}?${q}`, { headers: { 'User-Agent': UA } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    if (attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * attempt)); return fetchWindow(bbox, attempt + 1); }
    throw new Error(`TIGERweb ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  }
  if (body.exceededTransferLimit) console.warn('  ! window exceeded transfer limit — some cells missed', bbox);
  return body.features ?? [];
}

const upsert = db.prepare(`
  INSERT INTO population_cells (geoid, lat, lng, pop, housing, aland_sqmi, density, route_mile, off_route_mi, source, retrieved_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(geoid) DO UPDATE SET pop=excluded.pop, housing=excluded.housing, aland_sqmi=excluded.aland_sqmi,
    density=excluded.density, route_mile=excluded.route_mile, off_route_mi=excluded.off_route_mi, retrieved_at=excluded.retrieved_at
`);
const seen = new Set();
let kept = 0, dropped = 0, zero = 0;
const now = new Date().toISOString();
const t0 = Date.now();
for (let w = 0; w < windows.length; w++) {
  const feats = await fetchWindow(windows[w]);
  const tx = db.transaction(() => {
    for (const f of feats) {
      const a = f.attributes;
      if (seen.has(a.GEOID)) continue;
      seen.add(a.GEOID);
      const pop = Number(a.POP100) || 0;
      if (pop <= 0) { zero++; continue; }          // empty cells add nothing to a heat map
      const lat = Number(a.CENTLAT), lng = Number(a.CENTLON);
      const pr = project(lat, lng);
      if (!pr || pr.off > KEEP_MI) { dropped++; continue; }
      const sqmi = Math.max(Number(a.AREALAND) / SQ_M_PER_SQ_MI, 0.01);
      upsert.run(a.GEOID, lat, lng, pop, Number(a.HU100) || null, sqmi, pop / sqmi, pr.mile, pr.off,
        'US Census 2020 PL 94-171 via TIGERweb block groups', now);
      kept++;
    }
  });
  tx();
  if (w % 10 === 0 || w === windows.length - 1) {
    console.log(`  window ${w + 1}/${windows.length}: ${feats.length} fetched · kept ${kept} so far · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  await new Promise((r) => setTimeout(r, 250)); // be polite to a free federal server
}
const total = db.prepare(`SELECT COUNT(*) n, SUM(pop) p FROM population_cells`).get();
console.log(`\ndone: ${kept} cells kept, ${dropped} outside ${KEEP_MI} mi, ${zero} empty`);
console.log(`table: ${total.n} block groups, ${Number(total.p).toLocaleString()} people within ${KEEP_MI} mi of the route`);
db.close();
