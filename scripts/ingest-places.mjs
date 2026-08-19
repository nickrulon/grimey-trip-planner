// Town/city ingestion along the corridor, for human day names ("DeRidder, LA").
// Usage: node scripts/ingest-places.mjs [--minMile=0] [--maxMile=2817]
import { openDb } from '../server/db.mjs';
import { overpass } from './lib/providers.mjs';
import { haversineMi } from './lib/geo.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('='))
);
const MIN_MILE = Number(args.minMile ?? 0);
const MAX_MILE = Number(args.maxMile ?? 2817);
const CHUNK_MI = 100;   // place nodes are sparse; big chunks are fine
const MAX_OFF_MI = 8;

const db = openDb();

const raw = db.prepare(
  `SELECT lat, lng, mile FROM route_points WHERE mile BETWEEN ? AND ? ORDER BY mile`
).all(MIN_MILE, MAX_MILE + 5);
if (raw.length < 2) {
  console.error('No route points — run ingest:route first.');
  process.exit(1);
}
const ref = [];
let nextAt = -1;
for (const p of raw) {
  if (p.mile >= nextAt) { ref.push(p); nextAt = p.mile + 0.25; }
}

function projectOntoRoute(lat, lng) {
  let best = null, bestD = Infinity;
  for (const p of ref) {
    const d = haversineMi([lng, lat], [p.lng, p.lat]);
    if (d < bestD) { bestD = d; best = p; }
  }
  return { mile: best.mile, offMi: bestD };
}

const upsert = db.prepare(
  `INSERT OR REPLACE INTO route_places
   (id, name, place_type, population, lat, lng, route_mile, off_route_mi)
   VALUES (?,?,?,?,?,?,?,?)`
);

let kept = 0;
for (let m = MIN_MILE; m < MAX_MILE; m += CHUNK_MI) {
  const pts = ref.filter((p) => p.mile >= m - 2 && p.mile <= m + CHUNK_MI + 2);
  if (!pts.length) continue;
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLat = (MAX_OFF_MI + 0.5) / 69;
  const padLng = padLat / Math.cos((midLat * Math.PI) / 180);
  const bbox = [
    Math.min(...lats) - padLat, Math.min(...lngs) - padLng,
    Math.max(...lats) + padLat, Math.max(...lngs) + padLng,
  ];
  // Constrained to the US admin area so border-hugging stretches don't get
  // named after the (often larger) Mexican town across the line.
  const q = `[out:json][timeout:90][bbox:${bbox.join(',')}];area["ISO3166-1"="US"][admin_level=2]->.us;node["place"~"^(city|town|village)$"]["name"](area.us);out body;`;
  process.stdout.write(`chunk mile ${m}–${m + CHUNK_MI}... `);
  let data;
  try {
    data = await overpass(q);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    continue;
  }
  let n = 0;
  const tx = db.transaction((elements) => {
    for (const el of elements) {
      if (el.lat == null || el.lon == null) continue;
      const { mile, offMi } = projectOntoRoute(el.lat, el.lon);
      if (offMi > MAX_OFF_MI || mile < MIN_MILE || mile > MAX_MILE) continue;
      upsert.run(
        `osm-node-${el.id}`, el.tags.name, el.tags.place,
        Number(el.tags.population) || null, el.lat, el.lon, mile, offMi
      );
      n++; kept++;
    }
  });
  tx(data.elements || []);
  console.log(`${n} kept`);
}

console.log(`\nDone. ${kept} places within ${MAX_OFF_MI} mi of the route.`);
db.close();
