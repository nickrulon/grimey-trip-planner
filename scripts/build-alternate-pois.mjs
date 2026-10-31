// Merge the raw POI pulls for the alternate lines (Overpass, Nominatim and
// the ACA-corridor resources table — three sources because Overpass was
// timing out on most chunks the day this was built) into one deduplicated
// GeoJSON of McDonald's, libraries, campsites and RV parks within 10 mi of
// the alternate lines, each tagged with its distance and nearest stop town.
//
//   node scripts/build-alternate-pois.mjs   → web/src/alternate-pois.json
//
// Raw inputs live in data/route/alt-pois-raw/ so the merge is reproducible
// without re-querying anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data/route/alt-pois-raw');
const OUT = path.join(ROOT, 'web/src/alternate-pois.json');
const alt = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/src/alternates.json'), 'utf8'));

const KX = 69 * Math.cos((30.4 * Math.PI) / 180), KY = 69;
const segs = [];
for (const f of alt.lines.features) {
  const c = f.geometry.coordinates;
  for (let i = 1; i < c.length; i++) segs.push([c[i - 1], c[i], f.properties.id]);
}
function distToLine(lng, lat) {
  let best = Infinity, line = null;
  for (const [a, b, id] of segs) {
    if (Math.abs(a[0] - lng) > 0.3 && Math.abs(b[0] - lng) > 0.3) continue;
    const px = (lng - a[0]) * KX, py = (lat - a[1]) * KY, bx = (b[0] - a[0]) * KX, by = (b[1] - a[1]) * KY;
    const L = bx * bx + by * by, t = L ? Math.max(0, Math.min(1, (px * bx + py * by) / L)) : 0;
    const d = Math.hypot(px - t * bx, py - t * by);
    if (d < best) { best = d; line = id; }
  }
  return { dist: best, line };
}
const stops = alt.stops.features.map((f) => ({ name: f.properties.name, lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
function nearestStop(lng, lat) {
  let best = Infinity, name = '';
  for (const s of stops) { const d = Math.hypot((s.lng - lng) * KX, (s.lat - lat) * KY); if (d < best) { best = d; name = s.name; } }
  return { town: name, townDist: best };
}

const items = [];
const push = (kind, name, lat, lng, extra = {}) => {
  if (!name || !isFinite(lat) || !isFinite(lng)) return;
  const { dist, line } = distToLine(lng, lat);
  if (dist > 10) return;
  items.push({ kind, name: String(name).trim(), lat: +lat.toFixed(5), lng: +lng.toFixed(5), dist: +dist.toFixed(1), line, ...nearestStop(lng, lat), ...extra });
};

// Overpass: { mcd: [...], library: [...], camp: [...] } elements with tags + center
const op = JSON.parse(fs.readFileSync(path.join(RAW, 'overpass.json'), 'utf8'));
for (const [kind, els] of Object.entries(op)) {
  for (const e of els) {
    const t = e.tags ?? {}; const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
    const k = kind === 'camp' ? (t.tourism === 'caravan_site' ? 'rv' : 'camp') : kind;
    const name = t.name ?? (kind === 'mcd' ? "McDonald's" : k === 'rv' ? 'RV park' : k === 'camp' ? 'Campsite' : 'Library');
    push(k, name, lat, lng, { phone: t.phone ?? t['contact:phone'] ?? null, website: t.website ?? t['contact:website'] ?? null, tents: t.tents ?? null, fee: t.fee ?? null, source: 'osm' });
  }
}
// Nominatim: { id: {kind,name,lat,lng,addr,...} }
const nm = JSON.parse(fs.readFileSync(path.join(RAW, 'nominatim.json'), 'utf8'));
for (const v of Object.values(nm)) push(v.kind, v.name, v.lat, v.lng, { addr: v.addr, source: 'nominatim' });
// ACA corridor resources table: [{kind,name,lat,lng,id}]
const dbr = JSON.parse(fs.readFileSync(path.join(RAW, 'db.json'), 'utf8'));
for (const v of dbr) push(v.kind, v.name, v.lat, v.lng, { resourceId: v.id, source: 'corridor-db' });

// Dedupe: same kind within ~0.15 mi → keep the richest record (OSM first).
const order = { osm: 0, 'corridor-db': 1, nominatim: 2 };
items.sort((a, b) => order[a.source] - order[b.source]);
const kept = [];
for (const it of items) {
  const dup = kept.find((k) => k.kind === it.kind && Math.hypot((k.lng - it.lng) * KX, (k.lat - it.lat) * KY) < 0.15);
  if (dup) { for (const [k, v] of Object.entries(it)) if (dup[k] == null && v != null) dup[k] = v; continue; }
  kept.push(it);
}
kept.sort((a, b) => a.lng - b.lng);

const fc = {
  type: 'FeatureCollection',
  features: kept.map((p) => ({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } })),
};
fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), radiusMi: 10, pois: fc }));
const counts = {};
for (const p of kept) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
console.log(`wrote ${OUT}: ${kept.length} POIs`, counts);
