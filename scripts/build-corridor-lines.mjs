// Corridor study, step 1: the lines.
//
// Nick is in Casa Grande, AZ (2026-11-01), and has to pick how to reach the
// Elysian Theater in LA: the I-10 corridor (Buckeye, Quartzsite, Blythe,
// Desert Center, Indio, Banning, Inland Empire) or the I-8 corridor the app
// already plans on (Gila Bend, Yuma, El Centro, the climb into San Diego, the
// coast). This script draws each candidate as a real, routed line with mile
// markers and an elevation profile, so camps can be anchored to "mile N of
// this corridor" and gaps measured the same way on every option.
//
//   node scripts/build-corridor-lines.mjs   → data/corridors/lines.json
//
// Router: FOSSGIS Valhalla (same host as build-alternates.mjs). Bicycle
// costing caps a request at 150 km, so lines are built leg by leg. Desert legs
// where the interstate shoulder IS the road use auto costing with highways on;
// everything else uses bicycle costing. The I-8 line is NOT re-routed: it is
// the app's own route_points from Casa Grande on, so its miles match the plan.
// Elevation: USGS NED 10 m via opentopodata, sampled every 0.25 mi (the same
// dataset and spacing as ingest-elevation.mjs, so climbs compare like for like).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { haversineMi } from './lib/geo.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data/corridors');
const OUT = path.join(OUT_DIR, 'lines.json');
const CACHE = path.join(ROOT, 'data/route/corridor-leg-cache.json');
const UA = 'grimey-trip-planner/1.0 (corridor study; nickrulon@gmail.com)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [lat, lng]
const P = {
  'Casa Grande': [32.8793, -111.7572],
  Maricopa: [33.0581, -112.0476],
  Mobile: [33.0461, -112.2640],
  Buckeye: [33.3703, -112.5838],
  Tonopah: [33.4931, -112.9358],
  Salome: [33.7811, -113.6146],
  Hope: [33.7225, -113.7049],
  Brenda: [33.6795, -113.9451],
  Quartzsite: [33.6639, -114.2299],
  Blythe: [33.6103, -114.5964],
  'Desert Center': [33.7128, -115.4019],
  'Chiriaco Summit': [33.6603, -115.7228],
  Mecca: [33.5717, -116.0772],
  Indio: [33.7206, -116.2156],
  'Palm Springs': [33.8303, -116.5453],
  Cabazon: [33.9175, -116.7870],
  Banning: [33.9256, -116.8764],
  Beaumont: [33.9295, -116.9773],
  Redlands: [34.0556, -117.1825],
  Claremont: [34.0967, -117.7198],
  Pasadena: [34.1478, -118.1445],
  'Elysian Theater': [34.1086, -118.2370],
  // I-10 interchanges where the legal bike line gets on or off (OSM motorway_junction nodes)
  'Ehrenberg (I-10 exit 1)': [33.6044, -114.5262], // Ehrenberg, south of exit 1: a point on the junction node made the router overshoot into California and U-turn
  'Mesa Dr (I-10 exit 232)': [33.6112, -114.7272], // on Mesa Dr north of the westbound ramps (a point on the freeway snapped to the eastbound lanes and U-turned)
  'Dillon Rd (I-10 exit 146)': [33.7171, -116.1717], // Love's on Dillon Rd, just off the exit
  'El Centro': [32.7920, -115.5631],
  Brawley: [32.9787, -115.5303],
  Niland: [33.2400, -115.5189],
  'Bombay Beach': [33.3508, -115.7294],
  'North Shore': [33.5197, -115.9394],
};

const BIKE = { costing: 'bicycle', opts: { bicycle_type: 'Hybrid', use_roads: 0.5, avoid_bad_surfaces: 1 } };
const I10 = { costing: 'auto', opts: { use_highways: 1, use_tolls: 0 } }; // the shoulder is the road
const HWY = { costing: 'auto', opts: { use_highways: 0, use_tolls: 0 } }; // stay on the state highway, not canal roads

const CORRIDORS = [
  {
    id: 'i10',
    name: 'I-10 corridor',
    color: '#4f46e5',
    summary: 'Casa Grande → Maricopa → Buckeye → Tonopah → I-10 shoulder → Quartzsite → Blythe → I-10 shoulder → Desert Center → Chiriaco Summit → Indio → Palm Springs → San Gorgonio Pass → Banning → Redlands → Pacific Electric Trail → Pasadena → the Elysian.',
    legs: [
      ['Casa Grande', 'Maricopa', BIKE], ['Maricopa', 'Buckeye', BIKE], ['Buckeye', 'Tonopah', BIKE],
      // ADOT allows bikes on I-10 west of Miller Rd; Caltrans only from Mesa Dr (Blythe) to Dillon Rd (Indio)
      ['Tonopah', 'Quartzsite', I10], ['Quartzsite', 'Ehrenberg (I-10 exit 1)', I10], ['Ehrenberg (I-10 exit 1)', 'Blythe', BIKE],
      ['Blythe', 'Mesa Dr (I-10 exit 232)', BIKE], ['Mesa Dr (I-10 exit 232)', 'Desert Center', I10],
      ['Desert Center', 'Chiriaco Summit', I10], ['Chiriaco Summit', 'Dillon Rd (I-10 exit 146)', I10], ['Dillon Rd (I-10 exit 146)', 'Indio', BIKE],
      ['Indio', 'Palm Springs', BIKE], ['Palm Springs', 'Cabazon', BIKE], ['Cabazon', 'Banning', BIKE],
      ['Banning', 'Beaumont', BIKE], ['Beaumont', 'Redlands', BIKE], ['Redlands', 'Claremont', BIKE],
      ['Claremont', 'Pasadena', BIKE], ['Pasadena', 'Elysian Theater', BIKE],
    ],
  },
  {
    id: 'i10-salome',
    name: 'I-10 variant: Salome Hwy and US 60 (off the interstate)',
    color: '#818cf8',
    variantOf: 'i10',
    summary: 'Tonopah → Salome Highway → Harquahala Valley → Salome → Hope → Brenda → back on I-10 to Quartzsite. Longer than the interstate, but it passes three small towns with RV parks.',
    legs: [['Tonopah', 'Salome', BIKE], ['Salome', 'Hope', BIKE], ['Hope', 'Brenda', BIKE], ['Brenda', 'Quartzsite', I10]],
  },
  {
    id: 'i10-mecca',
    name: 'I-10 variant: Box Canyon to Mecca (off the interstate)',
    color: '#818cf8',
    variantOf: 'i10',
    summary: 'Leave I-10 below Chiriaco Summit, drop down Box Canyon Road to Mecca at the top of the Salton Sea, then ride the CV Link path into Indio.',
    legs: [['Chiriaco Summit', 'Mecca', BIKE], ['Mecca', 'Indio', BIKE]],
  },
  {
    id: 'i8',
    name: 'I-8 corridor (the route in the app)',
    color: '#b45309',
    fromRoute: { startMile: 2142.1, endMile: 2628.1 }, // Casa Grande → Long Beach on route_points
    summary: 'The app’s own line: Casa Grande → Gila Bend → Dateland → Wellton → Yuma → El Centro → In-Ko-Pah grade → Jacumba → Alpine → San Diego → the coast → Long Beach, then up the LA River path to the Elysian (skipping the Santa Monica Pier saves about 23 mi).',
    legs: [['Long Beach', 'Elysian Theater', BIKE]],
  },
  {
    id: 'hybrid',
    name: 'Hybrid: I-8 to El Centro, Salton Sea, then I-10 corridor',
    color: '#0f766e',
    fromRoute: { startMile: 2142.1, endMile: 2386.7 }, // Casa Grande → El Centro on route_points
    joins: { corridor: 'i10', at: 'Indio' },
    summary: 'Keep the I-8 line (and its dense camps) as far as El Centro, then ride CA 111 up the east shore of the Salton Sea to Mecca and Indio, and finish on the I-10 corridor. Skips the San Diego mountains.',
    legs: [
      ['El Centro', 'Brawley', HWY], ['Brawley', 'Niland', HWY], ['Niland', 'Bombay Beach', HWY],
      ['Bombay Beach', 'North Shore', HWY], ['North Shore', 'Mecca', HWY], ['Mecca', 'Indio', BIKE],
      // then the i10 line from Indio on (stitched below)
    ],
  },
];

function decodePolyline6(str) {
  const out = []; let idx = 0, lat = 0, lng = 0;
  while (idx < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, byte;
      do { byte = str.charCodeAt(idx++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const saveCache = () => fs.writeFileSync(CACHE, JSON.stringify(cache));

async function routeLeg(a, b, mode) {
  const key = `${a.join(',')}|${b.join(',')}|${mode.costing}|${JSON.stringify(mode.opts)}`;
  if (cache[key]) return cache[key];
  const body = {
    locations: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }],
    costing: mode.costing, costing_options: { [mode.costing]: mode.opts }, units: 'miles',
  };
  let j = null;
  for (let attempt = 1; attempt <= 5 && !j; attempt++) {
    try {
      const r = await fetch('https://valhalla1.openstreetmap.de/route', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body),
      });
      if (r.status === 400) throw Object.assign(new Error(`Valhalla 400 ${await r.text()}`), { fatal: true });
      if (!r.ok) throw new Error(`Valhalla ${r.status}`);
      j = await r.json();
    } catch (err) {
      if (err.fatal || attempt === 5) throw err;
      await sleep(2000 * attempt);
    }
  }
  const coords = []; const roads = [];
  for (const leg of j.trip.legs) {
    coords.push(...decodePolyline6(leg.shape));
    for (const m of leg.maneuvers) {
      const lbl = (m.street_names ?? []).join(' / ');
      if (!lbl) continue;
      if (roads.length && roads[roads.length - 1][0] === lbl) roads[roads.length - 1][1] += m.length;
      else roads.push([lbl, m.length]);
    }
  }
  const out = {
    miles: j.trip.summary.length,
    coords: coords.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]),
    roads: roads.filter(([, d]) => d > 1.5).map(([l, d]) => `${l} ${d.toFixed(1)} mi`),
  };
  cache[key] = out; saveCache();
  await sleep(400);
  return out;
}

// --- elevation (opentopodata ned10m; 100 points/request, 1 req/s) ---
const elevCache = new Map(Object.entries(cache.__elev ?? {}));
async function elevations(points) {
  const keyOf = ([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const todo = [...new Set(points.map(keyOf))].filter((k) => !elevCache.has(k));
  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    let results = null;
    for (let attempt = 0; attempt < 4 && !results; attempt++) {
      if (attempt) await sleep(4000 * attempt);
      try {
        const r = await fetch('https://api.opentopodata.org/v1/ned10m', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
          body: JSON.stringify({ locations: batch.join('|') }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (d.status !== 'OK') throw new Error(d.error ?? 'bad status');
        results = d.results;
      } catch (err) {
        console.log(`  elevation batch ${i / 100 + 1}: ${err.message}`);
      }
    }
    batch.forEach((k, j) => elevCache.set(k, results?.[j]?.elevation ?? null));
    cache.__elev = Object.fromEntries(elevCache); saveCache();
    await sleep(1100);
  }
  return points.map((p) => elevCache.get(keyOf(p)) ?? null);
}

function cumulative(coords) {
  const m = [0];
  for (let i = 1; i < coords.length; i++) m.push(m[i - 1] + haversineMi(coords[i - 1], coords[i]));
  return m;
}

// Climb from samples every ~0.25 mi, with a 3 m hysteresis so DEM noise on a
// flat road does not add phantom feet.
function climbStats(elevM) {
  let up = 0, down = 0, hi = -Infinity, ref = null;
  for (const e of elevM) {
    if (e == null) continue;
    if (e > hi) hi = e;
    if (ref == null) { ref = e; continue; }
    const d = e - ref;
    if (d >= 3) { up += d; ref = e; } else if (d <= -3) { down -= d; ref = e; }
  }
  return { climbFt: Math.round(up * 3.28084), descentFt: Math.round(down * 3.28084), highPointFt: Math.round(hi * 3.28084) };
}

function sampleEvery(coords, cum, stepMi = 0.25) {
  const idx = []; let next = 0;
  for (let i = 0; i < coords.length; i++) if (cum[i] >= next) { idx.push(i); next = cum[i] + stepMi; }
  if (idx[idx.length - 1] !== coords.length - 1) idx.push(coords.length - 1);
  return idx;
}

function routeSlice(db, startMile, endMile) {
  return db.prepare(
    `SELECT lat, lng, mile, elevation_m FROM route_points WHERE mile >= ? AND mile <= ? ORDER BY mile`
  ).all(startMile, endMile);
}

// The I-8 line comes from the app's own route_points. After the 2026-11-01
// retrace onto I-10 those points are gone, so read the pre-retrace backup.
const I8_DB = ['backups/trip-before-retrace-i10-2026-11-01.sqlite', 'data/trip.sqlite']
  .map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f));
const db = new Database(I8_DB, { readonly: true });
const built = {};
const out = { generatedAt: new Date().toISOString(), origin: 'Casa Grande, AZ', corridors: [] };

for (const c of CORRIDORS) {
  let coords = []; const legs = []; const towns = []; let elevFromRoute = null;
  if (c.fromRoute) {
    const rows = routeSlice(db, c.fromRoute.startMile, c.fromRoute.endMile);
    coords = rows.map((r) => [+r.lng.toFixed(6), +r.lat.toFixed(6)]);
    elevFromRoute = rows.map((r) => r.elevation_m);
    legs.push({ from: 'Casa Grande', to: c.id === 'i8' ? 'Long Beach' : 'El Centro', miles: +(c.fromRoute.endMile - c.fromRoute.startMile).toFixed(1), roads: ['the app’s route (route_points)'], costing: 'route' });
    // the app's own town miles become corridor-mile anchors
    const routeTowns = db.prepare(
      `SELECT name, MIN(route_mile) AS mile FROM route_places
       WHERE route_mile >= ? AND route_mile <= ? AND off_route_mi < 1.5 AND place_type IN ('city','town','village')
       GROUP BY name ORDER BY mile`
    ).all(c.fromRoute.startMile, c.fromRoute.endMile);
    towns.push({ name: 'Casa Grande', mile: 0 });
    for (const t of routeTowns) if (t.name !== 'Casa Grande') towns.push({ name: t.name, mile: +(t.mile - c.fromRoute.startMile).toFixed(1) });
    if (c.legs.length) {
      const last = rows[rows.length - 1];
      P[c.id === 'i8' ? 'Long Beach' : 'El Centro'] = [last.lat, last.lng];
    }
  } else {
    towns.push({ name: c.legs[0][0], mile: 0 });
  }
  for (const [A, B, mode] of c.legs) {
    const from = c.id === 'i8' && A === 'Long Beach' ? P['Long Beach'] : P[A];
    const leg = await routeLeg(from, P[B], mode);
    const before = coords.length ? cumulative(coords).at(-1) : 0;
    coords.push(...(coords.length ? leg.coords.slice(1) : leg.coords));
    if (elevFromRoute) elevFromRoute.push(...new Array(coords.length - elevFromRoute.length).fill(null));
    legs.push({ from: A, to: B, miles: +leg.miles.toFixed(1), roads: leg.roads, costing: mode.costing === 'auto' && mode.opts.use_highways ? 'interstate shoulder' : mode.costing === 'auto' ? 'state highway' : 'bike' });
    towns.push({ name: B, mile: +(before + leg.miles).toFixed(1) });
    console.log(`${c.id}: ${A} → ${B} ${leg.miles.toFixed(1)} mi  ${leg.roads.join(' · ')}`);
  }
  if (c.joins) {
    const host = built[c.joins.corridor];
    const at = host.towns.find((t) => t.name === c.joins.at);
    const k = host.cum.findIndex((m) => m >= at.mile);
    const base = cumulative(coords).at(-1);
    coords.push(...host.coords.slice(k + 1));
    if (elevFromRoute) elevFromRoute.push(...new Array(coords.length - elevFromRoute.length).fill(null));
    for (const t of host.towns.filter((t) => t.mile > at.mile)) towns.push({ name: t.name, mile: +(base + t.mile - at.mile).toFixed(1) });
    legs.push({ from: c.joins.at, to: 'Elysian Theater', miles: +(host.miles - at.mile).toFixed(1), roads: [`the ${host.name} from ${c.joins.at}`], costing: 'shared' });
  }
  const cum = cumulative(coords);
  const sIdx = sampleEvery(coords, cum);
  let elev = null;
  if (elevFromRoute) {
    // route_points carry NED samples every ~0.25 mi; fill any gaps from the API
    const pts = sIdx.map((i) => coords[i]);
    const have = sIdx.map((i) => elevFromRoute[i]);
    const missing = pts.filter((_, j) => have[j] == null);
    const got = missing.length ? await elevations(missing) : [];
    let g = 0; elev = have.map((e) => (e == null ? got[g++] : e));
  } else {
    elev = await elevations(sIdx.map((i) => coords[i]));
  }
  const stats = climbStats(elev);
  const miles = +cum.at(-1).toFixed(1);
  const profile = sIdx.map((i, j) => [+cum[i].toFixed(2), elev[j] == null ? null : Math.round(elev[j] * 3.28084)]);
  built[c.id] = { ...c, coords, cum, miles, towns };
  out.corridors.push({
    id: c.id, name: c.name, color: c.color, variantOf: c.variantOf ?? null, summary: c.summary,
    miles, ...stats, legs, towns, profile, coords,
  });
  console.log(`== ${c.id}: ${miles} mi, climb ${stats.climbFt} ft, high ${stats.highPointFt} ft, ${coords.length} pts`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
