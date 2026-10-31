// Build the "alternate routes" overlay for the map: rider-proposed lines that
// leave the ACA route and rejoin it later, drawn so Nick can compare them
// against the official line. Geometry comes from OSRM's bicycle profile (which
// never routes on motorways — an "I 10" step name is the frontage road), leg
// by leg through named waypoints; each stop town is checked for a McDonald's
// via Nominatim, because a McDonald's is Nick's unit of "I can work here".
//
//   node scripts/build-alternates.mjs   → web/src/alternates.json
//
// Re-run whenever an alternate changes. The output is bundled into the web
// build (no API involved), so it ships with `npm run deploy:site`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web/src/alternates.json');
const UA = 'grimey-trip-planner/1.0 (route alternates; nickrulon@gmail.com)';

// name → [lat, lng, state, notes]. Coordinates are town centres; the ACA
// join points are actual route_points (looked up from data/trip.sqlite).
const T = {
  'Ville Platte': [30.689985, -92.270517, 'LA', 'leaves the ACA line at mile 492'],
  Eunice: [30.4944, -92.4176, 'LA', ''],
  Kinder: [30.4855, -92.8507, 'LA', 'US 190: wide shoulder, constant trucks'],
  'Iowa': [30.2366, -93.0138, 'LA', ''],
  'Lake Charles': [30.2266, -93.2174, 'LA', 'everything'],
  'Moss Bluff': [30.3025, -93.1926, 'LA', 'US 171 north out of Lake Charles'],
  Westlake: [30.2440, -93.2510, 'LA', 'LA 378 bridge: the bike-legal Calcasieu crossing (I-10 bridge is off-limits and has no shoulder)'],
  Sulphur: [30.2366, -93.3774, 'LA', ''],
  Vinton: [30.1908, -93.5813, 'LA', 'Cobblestone Inn'],
  Starks: [30.3138, -93.6627, 'LA', 'nothing'],
  Deweyville: [30.2988, -93.7407, 'TX', 'LA 12 bridge: short, no shoulder, quiet'],
  Mauriceville: [30.2016, -93.8668, 'TX', 'nothing'],
  Vidor: [30.1316, -94.0155, 'TX', ''],
  Evadale: [30.3494, -94.0733, 'TX', 'FM 105 bridge over the Neches: the bike-legal crossing north of Beaumont'],
  Silsbee: [30.348707, -94.180321, 'TX', 'rejoins the ACA line at mile 650'],
  Kountze: [30.374638, -94.317947, 'TX', 'leaves the ACA line at mile 662'],
  Cleveland: [30.3416, -95.0855, 'TX', 'FM 770 / TX 105: nothing between Kountze and here'],
  Conroe: [30.3119, -95.4561, 'TX', 'TX 105 is 4-lane commuter traffic'],
  Montgomery: [30.501877, -95.713564, 'TX', 'rejoins the ACA line at mile 780'],
  'Sour Lake': [30.1399, -94.4110, 'TX', 'one motel, no McDonald’s'],
  Batson: [30.2513, -94.6094, 'TX', 'nothing'],
};

const ALTERNATES = [
  {
    id: 'south-work-line-a',
    name: 'South work line, LA part',
    color: '#7c3aed',
    summary: 'Ville Platte → Eunice → Kinder → Lake Charles → Sulphur → Vinton → Deweyville → Vidor → Evadale → Silsbee. A McDonald’s in most towns; two dead legs (Vinton–Vidor, and nothing after Kountze).',
    stops: ['Ville Platte', 'Eunice', 'Kinder', 'Iowa', 'Lake Charles', 'Moss Bluff', 'Westlake', 'Sulphur', 'Vinton', 'Starks', 'Deweyville', 'Mauriceville', 'Vidor', 'Evadale', 'Silsbee'],
  },
  {
    id: 'south-work-line-b',
    name: 'South work line, TX part',
    color: '#7c3aed',
    summary: 'Kountze → FM 770 → Cleveland → Conroe → Montgomery on TX 105. The 2023 flood-detour line other Southern Tier riders used.',
    stops: ['Kountze', 'Cleveland', 'Conroe', 'Montgomery'],
  },
  {
    id: 'tx105-variant',
    name: 'TX 105 variant via Sour Lake',
    color: '#c026d3',
    summary: 'Silsbee → Sour Lake → Batson → Cleveland on TX 105 through the Big Thicket. Shorter, but Sour Lake has one motel and no McDonald’s, and no journals cover this stretch.',
    stops: ['Silsbee', 'Sour Lake', 'Batson', 'Cleveland'],
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Legs where the road we WANT is a US highway (trunk) must let the router use
// highways; legs that run beside I-10 must not, or it takes the interstate.
const USE_HIGHWAYS = { 'Eunice→Kinder': 1, 'Kinder→Iowa': 1, 'Cleveland→Conroe': 1, 'Conroe→Montgomery': 1, 'Silsbee→Sour Lake': 1, 'Sour Lake→Batson': 1, 'Batson→Cleveland': 1 };

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

// FOSSGIS Valhalla. Car costing with highways switched off per leg is the
// only public router that follows the roads a tourer actually rides here
// (OSRM's bicycle profile and Valhalla's bicycle costing both detour US 190
// onto 40 miles of farm roads; the OSRM demo host is unreachable from some
// networks — an AT&T captive portal swallows it).
async function routeLeg(A, B) {
  const a = T[A], b = T[B];
  const hw = USE_HIGHWAYS[`${A}→${B}`] ?? 0;
  const body = {
    locations: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }],
    costing: 'auto', costing_options: { auto: { use_highways: hw, use_tolls: 0 } }, units: 'miles',
  };
  let j = null;
  for (let attempt = 1; attempt <= 4 && !j; attempt++) {
    try {
      const r = await fetch('https://valhalla1.openstreetmap.de/route', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`Valhalla ${r.status}`);
      j = await r.json();
    } catch (err) {
      if (attempt === 4) throw new Error(`Valhalla failed for ${A} → ${B}: ${err.message}`);
      await sleep(1500 * attempt);
    }
  }
  const roads = []; const coords = [];
  for (const leg of j.trip.legs) {
    coords.push(...decodePolyline6(leg.shape));
    for (const m of leg.maneuvers) {
      const lbl = (m.street_names ?? []).join(' / ');
      if (!lbl) continue;
      if (roads.length && roads[roads.length - 1][0] === lbl) roads[roads.length - 1][1] += m.length;
      else roads.push([lbl, m.length]);
    }
  }
  return { miles: j.trip.summary.length, coords, roads: roads.filter(([, d]) => d > 2.5).map(([l, d]) => `${l} ${d.toFixed(0)} mi`) };
}

const mcdCache = new Map();
async function mcdonalds(town, state) {
  const key = `${town}, ${state}`;
  if (mcdCache.has(key)) return mcdCache.get(key);
  const q = encodeURIComponent(`McDonald's, ${town}, ${state}, USA`);
  const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=3`, { headers: { 'User-Agent': UA } });
  const j = r.ok ? await r.json() : [];
  const [lat, lng] = T[town];
  const near = j.find((h) => /mcdonald/i.test(h.display_name) && Math.hypot((+h.lat - lat) * 69, (+h.lon - lng) * 60) < 4);
  const out = near ? { lat: +near.lat, lng: +near.lon } : null;
  mcdCache.set(key, out);
  await sleep(1100); // Nominatim: 1 req/s
  return out;
}

function decimate(coords, every = 3) {
  return coords.filter((_, i) => i % every === 0 || i === coords.length - 1).map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
}

const features = [];
const stops = [];
const seenStop = new Set();
for (const alt of ALTERNATES) {
  let miles = 0; const coords = []; const legs = [];
  for (let i = 0; i < alt.stops.length - 1; i++) {
    const A = alt.stops[i], B = alt.stops[i + 1];
    const leg = await routeLeg(A, B);
    miles += leg.miles;
    legs.push({ from: A, to: B, miles: +leg.miles.toFixed(1), roads: leg.roads });
    coords.push(...(coords.length ? leg.coords.slice(1) : leg.coords));
    console.log(`${alt.id}: ${A} → ${B} ${leg.miles.toFixed(1)} mi  ${leg.roads.join(' · ')}`);
    await sleep(300);
  }
  features.push({
    type: 'Feature',
    properties: { id: alt.id, name: alt.name, color: alt.color, miles: +miles.toFixed(1), summary: alt.summary, legs },
    geometry: { type: 'LineString', coordinates: decimate(coords) },
  });
  for (const s of alt.stops) {
    if (seenStop.has(s)) continue; seenStop.add(s);
    const [lat, lng, state, note] = T[s];
    const mcd = await mcdonalds(s, state);
    console.log(`  ${s}: McDonald's ${mcd ? 'yes' : 'no'}`);
    stops.push({
      type: 'Feature',
      properties: { name: s, state, note, mcd: !!mcd, alt: alt.id },
      geometry: { type: 'Point', coordinates: [+lng.toFixed(5), +lat.toFixed(5)] },
    });
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  lines: { type: 'FeatureCollection', features },
  stops: { type: 'FeatureCollection', features: stops },
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB): ${features.length} lines, ${stops.length} stops`);
