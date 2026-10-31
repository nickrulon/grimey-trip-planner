// Resource ingestion: corridor search around the route via Overpass (OSM).
// Usage: npm run ingest:resources -- --maxMile=500
import { openDb } from '../server/db.mjs';
import { overpass } from './lib/providers.mjs';
import { haversineMi } from './lib/geo.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('='))
);
const MIN_MILE = Number(args.minMile ?? 0);
const MAX_MILE = Number(args.maxMile ?? 500);
const CHUNK_MI = 25;

const CATEGORIES = {
  wifi_work: {
    label: 'Wi-Fi / Work',
    corridor_width_mi: 3,
    overpassFilters: ['["amenity"~"^(fast_food|cafe|library)$"]'],
    config: {
      likelyWifiBrands: [
        "McDonald's", 'Starbucks', 'Panera Bread', 'Chick-fil-A', 'Krystal',
        'Burger King', 'Whataburger', "Dunkin'", "Wendy's", 'Waffle House',
      ],
    },
  },
  campground: {
    label: 'Campgrounds',
    corridor_width_mi: 5,
    overpassFilters: ['["tourism"~"^(camp_site|caravan_site)$"]'],
    config: {},
  },
  resupply: {
    label: 'Resupply (fuel / store)',
    corridor_width_mi: 2,
    overpassFilters: ['["amenity"="fuel"]', '["shop"~"^(convenience|supermarket|general)$"]'],
    config: {},
  },
  hotel: {
    label: 'Hotels / Motels',
    corridor_width_mi: 3,
    overpassFilters: ['["tourism"~"^(hotel|motel)$"]'],
    config: {},
  },
};

const db = openDb();
const now = new Date().toISOString();

for (const [id, c] of Object.entries(CATEGORIES)) {
  db.prepare(
    `INSERT INTO resource_categories (id, label, corridor_width_mi, enabled, config_json)
     VALUES (?,?,?,1,?)
     ON CONFLICT(id) DO UPDATE SET label=excluded.label,
       corridor_width_mi=excluded.corridor_width_mi, config_json=excluded.config_json`
  ).run(id, c.label, c.corridor_width_mi, JSON.stringify(c.config));
}

// ---- Load route, resampled to ~200 m for nearest-vertex mile projection ----
const raw = db.prepare(
  `SELECT lat, lng, mile FROM route_points
   WHERE mile BETWEEN ? AND ?
   ORDER BY mile`
).all(MIN_MILE, MAX_MILE + 5);
if (raw.length < 2) {
  console.error('No route points in range — run ingest:route first.');
  process.exit(1);
}
const ref = [];
let nextAt = -1;
for (const p of raw) {
  if (p.mile >= nextAt) { ref.push(p); nextAt = p.mile + 0.125; }
}
console.log(`Route window ${MIN_MILE}–${MAX_MILE} mi: ${raw.length} pts → ${ref.length} reference pts`);

function projectOntoRoute(lat, lng) {
  let best = null, bestD = Infinity;
  for (const p of ref) {
    const d = haversineMi([lng, lat], [p.lng, p.lat]);
    if (d < bestD) { bestD = d; best = p; }
  }
  return { mile: best.mile, offMi: bestD };
}

// ---- Chunked corridor Overpass queries ----
const maxWidth = Math.max(...Object.values(CATEGORIES).map((c) => c.corridor_width_mi));
const chunks = [];
for (let m = MIN_MILE; m < MAX_MILE; m += CHUNK_MI) {
  const pts = ref.filter((p) => p.mile >= m - 2 && p.mile <= m + CHUNK_MI + 2);
  if (!pts.length) continue;
  const lats = pts.map((p) => p.lat), lngs = pts.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLat = (maxWidth + 0.5) / 69;
  const padLng = padLat / Math.cos((midLat * Math.PI) / 180);
  chunks.push({
    m,
    bbox: [
      Math.min(...lats) - padLat, Math.min(...lngs) - padLng,
      Math.max(...lats) + padLat, Math.max(...lngs) + padLng,
    ],
  });
}

const allFilters = Object.values(CATEGORIES).flatMap((c) => c.overpassFilters);
const upsertRes = db.prepare(
  `INSERT OR REPLACE INTO resources
   (id, category_id, name, brand, lat, lng, address, phone, website, hours,
    route_mile, off_route_mi, wifi_status, attributes_json, status, first_seen, last_verified)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?)`
);
const upsertSrc = db.prepare(
  `INSERT INTO resource_sources (resource_id, provider, provider_ref, source_url, retrieved_at, confidence)
   VALUES (?,?,?,?,?,?)
   ON CONFLICT(provider, provider_ref) DO UPDATE SET retrieved_at=excluded.retrieved_at`
);

function categorize(tags) {
  if (/^(fast_food|cafe|library)$/.test(tags.amenity || '')) return 'wifi_work';
  if (tags.amenity === 'fuel' || /^(convenience|supermarket|general)$/.test(tags.shop || '')) return 'resupply';
  if (/^(camp_site|caravan_site)$/.test(tags.tourism || '')) return 'campground';
  if (/^(hotel|motel)$/.test(tags.tourism || '')) return 'hotel';
  return null;
}

function wifiStatus(catId, tags) {
  if (catId !== 'wifi_work') return null;
  const ia = tags.internet_access;
  if (ia === 'wlan' || ia === 'yes') return 'confirmed';
  if (ia === 'no') return 'none';
  if (tags.amenity === 'library') return 'likely';
  const brand = tags.brand || tags.name || '';
  if (CATEGORIES.wifi_work.config.likelyWifiBrands.some((b) => brand.toLowerCase().includes(b.toLowerCase()))) {
    return 'likely';
  }
  return 'unknown';
}

let total = 0, kept = 0;
for (const chunk of chunks) {
  const [s, w, n, e] = chunk.bbox;
  const q = `[out:json][timeout:90][bbox:${s},${w},${n},${e}];(${allFilters
    .map((f) => `nwr${f};`)
    .join('')});out center tags;`;
  process.stdout.write(`chunk mile ${chunk.m}–${chunk.m + CHUNK_MI}... `);
  let data;
  try {
    data = await overpass(q);
  } catch (err) {
    console.log(`FAILED: ${err.message}`);
    continue;
  }
  let chunkKept = 0;
  const tx = db.transaction((elements) => {
    for (const el of elements) {
      const tags = el.tags || {};
      const catId = categorize(tags);
      if (!catId) continue;
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) continue;
      // Mexico: explicit tag, Mexican brands, or the Los Algodones box south of
      // the Yuma line. A corridor bbox has no idea where the border is.
      if (tags['addr:country'] === 'MX') continue;
      if (/^(pemex|oxxo)$/i.test(tags.brand || tags.name || '')) continue;
      if (lat < 32.7185 && lng > -114.80 && lng < -114.70) continue;
      total++;
      const { mile, offMi } = projectOntoRoute(lat, lng);
      if (offMi > CATEGORIES[catId].corridor_width_mi) continue;
      if (mile < MIN_MILE || mile > MAX_MILE) continue;
      const id = `osm-${el.type}-${el.id}`;
      const name = tags.name || tags.brand || (catId === 'campground' ? 'Unnamed campground' : 'Unnamed');
      const addr = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']]
        .filter(Boolean).join(' ') || null;
      const attrs = {};
      for (const k of ['cuisine', 'shower', 'drinking_water', 'toilets', 'tents', 'fee', 'reservation', 'opening_hours', 'internet_access']) {
        if (tags[k]) attrs[k] = tags[k];
      }
      upsertRes.run(
        id, catId, name, tags.brand || null, lat, lng, addr,
        tags.phone || null, tags.website || null, tags.opening_hours || null,
        mile, offMi, wifiStatus(catId, tags), JSON.stringify(attrs), now, now
      );
      upsertSrc.run(id, 'osm', `${el.type}/${el.id}`,
        `https://www.openstreetmap.org/${el.type}/${el.id}`, now, 'medium');
      kept++; chunkKept++;
    }
  });
  tx(data.elements || []);
  console.log(`${chunkKept} kept`);
}

const counts = db.prepare(`SELECT category_id, COUNT(*) n FROM resources GROUP BY category_id`).all();
console.log(`\nDone. ${kept} in-corridor resources stored (${total} candidates seen).`);
for (const c of counts) console.log(`  ${c.category_id}: ${c.n}`);
db.close();
