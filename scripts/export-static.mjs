// Export a static, self-contained copy of the trip planner for sharing.
// The Express+SQLite API is replaced by snapshotted JSON plus
// scripts/static-shim.js, which computes /api/position and /api/route/points
// client-side and keeps the Day Planner writable via localStorage.
//
//   npx vite build --base=./ && API_PORT=5181 node scripts/export-static.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'api-data');
const API = `http://localhost:${process.env.API_PORT || 5181}`;
const POINT_SPACING_MI = 0.1; // plenty for drawing a day's section + GPS projection

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/index.html missing — run `npx vite build --base=./` first');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

// The export reads from the live API, so fail with an instruction, not a stack.
try {
  await fetch(`${API}/api/summary`);
} catch {
  console.error(`\nNo API reachable at ${API}.`);
  console.error('Start the app first (npm run dev), or run: npm run deploy:site\n');
  process.exit(1);
}

async function snap(apiPath, file, { optional = false } = {}) {
  const res = await fetch(API + apiPath);
  if (!res.ok && !optional) throw new Error(`${apiPath} -> ${res.status}`);
  if (!res.ok) console.warn(`  (optional) ${apiPath} -> ${res.status}, snapshotting its error body`);
  const body = await res.text();
  fs.writeFileSync(path.join(OUT, file), body);
  return body.length;
}

// Served straight off the CDN via netlify.toml rewrites (big + unchanging),
// plus plan.json as Ride Mode's fallback when no day plan is cached yet.
const flat = {
  '/api/route': 'route.json', '/api/resources': 'resources.json',
  '/api/camping': 'camping.json', '/api/plan': 'plan.json',
  '/api/population': 'population.json',
};
let total = 0;
for (const [p, f] of Object.entries(flat)) total += await snap(p, f);

// ---- Geometry + naming data the client-side endpoints need ----
const db = openDb();
const rawPts = db.prepare(`SELECT lat, lng, mile FROM route_points ORDER BY mile`).all();
const pts = [];
let nextAt = -1;
for (const p of rawPts) {
  if (p.mile >= nextAt) {
    pts.push([Math.round(p.lng * 1e5) / 1e5, Math.round(p.lat * 1e5) / 1e5, Math.round(p.mile * 100) / 100]);
    nextAt = p.mile + POINT_SPACING_MI;
  }
}
const last = rawPts[rawPts.length - 1];
if (last) pts.push([Math.round(last.lng * 1e5) / 1e5, Math.round(last.lat * 1e5) / 1e5, Math.round(last.mile * 100) / 100]);
fs.writeFileSync(path.join(OUT, 'route-points.json'), JSON.stringify({ pts }));

const TYPE_WEIGHT = { city: 3, town: 2, village: 1 };
// Naming must match the server's nameNearMile, which draws on BOTH the OSM
// places table and the waypoints.json anchors — otherwise the HUD falls back
// to "Mile 1987" on stretches the OSM table doesn't cover.
const places = db.prepare(`SELECT name, place_type, route_mile FROM route_places`).all()
  .map((p) => ({ name: p.name, mile: Math.round(p.route_mile * 10) / 10, weight: TYPE_WEIGHT[p.place_type] ?? 1 }));
try {
  const wp = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/route/waypoints.json'), 'utf8'));
  const found = [];
  (function scan(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.name === 'string' && Array.isArray(node.lnglat)) found.push(node);
    for (const v of Object.values(node)) scan(v);
  })(wp);
  const RAD = Math.PI / 180;
  const hav = ([lng1, lat1], [lng2, lat2]) => {
    const dLa = (lat2 - lat1) * RAD, dLn = (lng2 - lng1) * RAD;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLn / 2) ** 2;
    return 2 * 3958.8 * Math.asin(Math.sqrt(a));
  };
  let added = 0;
  for (const f of found) {
    let bestD = Infinity, bestMile = null;
    for (const p of pts) {
      const d = hav(f.lnglat, [p[0], p[1]]);
      if (d < bestD) { bestD = d; bestMile = p[2]; }
    }
    if (bestD > 15) continue;
    const clean = f.name.replace(/\s*\(.*\)$/, '');
    if (/\bline\b|×|\bexit\b/i.test(clean)) continue;
    places.push({ name: clean, mile: bestMile, weight: 2.5 });
    added++;
  }
  console.log(`  + ${added} waypoint place names (matching the server's naming)`);
} catch (err) {
  console.warn('  no waypoint places loaded:', err.message);
}
places.sort((a, b) => a.mile - b.mile);
const positionData = {
  totalMiles: Math.round((db.prepare(`SELECT total_miles FROM routes WHERE id='personal'`).get()?.total_miles ?? 0) * 10) / 10,
  places,
  notes: db.prepare(
    `SELECT id, kind, title, detail, start_mile, end_mile, source, confidence FROM route_notes ORDER BY start_mile`
  ).all(),
};
db.close();
fs.writeFileSync(path.join(OUT, 'position-data.json'), JSON.stringify(positionData));
console.log(`snapshotted ${Object.keys(flat).length} CDN endpoints`);
console.log(`route-points: ${pts.length} pts @ ~${POINT_SPACING_MI} mi · places: ${positionData.places.length} · notes: ${positionData.notes.length}`);

// ---- Patch index.html with the offline-position shim ----
// No banner: the full planning engine runs server-side now, so edits really do
// save to the shared trip. The old "saves in your browser only" notice was
// left over from the read-only snapshot era and is simply untrue.
const shimSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'static-shim.js'), 'utf8');
const head = `<script>\n${shimSrc}\n</script>`;
const idx = path.join(DIST, 'index.html');
let html = fs.readFileSync(idx, 'utf8');
html = html.replace('</head>', head + '\n</head>');
fs.writeFileSync(idx, html);

const mb = (n) => (n / 1e6).toFixed(1);
const distSize = fs.readdirSync(OUT).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`api-data total: ${mb(distSize)} MB · index.html patched with the offline-position shim`);
