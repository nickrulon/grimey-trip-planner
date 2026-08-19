// External data providers. All free/public endpoints, used politely (throttled,
// identified User-Agent). Keys, if ever needed, come from process.env.

const UA = 'grimey-trip-planner/0.1 (personal bicycle trip planner)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, opts = {}, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return res;
    } catch (err) {
      if (err.fatal || attempt === tries) throw err;
      await sleep(2000 * attempt);
    }
  }
}

// ---------- Overpass (OSM) ----------

// Multiple public instances; rotate on connection failures so one saturated
// (or rate-limiting) endpoint doesn't zero out a whole ingest run.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
let overpassIdx = 0;
let lastOverpass = 0;

export async function overpass(query) {
  const wait = 1500 - (Date.now() - lastOverpass);
  if (wait > 0) await sleep(wait);
  lastOverpass = Date.now();
  let lastErr;
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const url = OVERPASS_ENDPOINTS[(overpassIdx + i) % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetchWithRetry(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
      });
      overpassIdx = (overpassIdx + i) % OVERPASS_ENDPOINTS.length; // stick with what works
      return res.json();
    } catch (err) {
      lastErr = err;
      await sleep(3000); // brief cooldown before trying the next mirror
    }
  }
  throw lastErr;
}

/**
 * Fetch a route relation's member ways IN MEMBERSHIP ORDER with roles:
 * [{id, role, coords:[[lng,lat],...]}]. Route relations are usually
 * member-sorted, which ordered assembly exploits.
 */
export async function fetchRelationWays(relationId) {
  const relData = await overpass(`[out:json][timeout:60];relation(${relationId});out;`);
  const rel = (relData.elements || []).find((e) => e.type === 'relation');
  if (!rel) throw new Error(`Relation ${relationId} not found`);
  const memberOrder = rel.members.filter((m) => m.type === 'way');

  const geomData = await overpass(
    `[out:json][timeout:120];relation(${relationId});way(r);out geom;`
  );
  const byId = new Map();
  for (const el of geomData.elements || []) {
    if (el.type === 'way' && el.geometry?.length >= 2) {
      byId.set(el.id, el.geometry.map((g) => [g.lon, g.lat]));
    }
  }
  const ways = [];
  for (const m of memberOrder) {
    const coords = byId.get(m.ref);
    if (coords) ways.push({ id: m.ref, role: m.role || '', coords });
  }
  return ways;
}

// ---------- Bike routing: BRouter primary, FOSSGIS Valhalla fallback ----------

let lastRoute = 0;

async function throttleRouting() {
  const wait = 1800 - (Date.now() - lastRoute);
  if (wait > 0) await sleep(wait);
  lastRoute = Date.now();
}

async function brouterLeg(from, to, profile) {
  const lonlats = `${from[0]},${from[1]}|${to[0]},${to[1]}`;
  const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
  const res = await fetchWithRetry(url, {}, 2);
  const gj = await res.json();
  const coords = gj?.features?.[0]?.geometry?.coordinates;
  if (!coords?.length) throw new Error('BRouter: empty geometry');
  return { coords: coords.map(([lng, lat]) => [lng, lat]), provider: 'brouter' };
}

function decodePolyline6(str) {
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lng += delta;
    }
    coords.push([lng / 1e6, lat / 1e6]);
  }
  return coords;
}

async function valhallaLeg(from, to) {
  const body = {
    locations: [
      { lon: from[0], lat: from[1] },
      { lon: to[0], lat: to[1] },
    ],
    costing: 'bicycle',
    // Touring posture: willing to ride the highway shoulder like the real
    // Southern Tier does in the desert Southwest.
    costing_options: { bicycle: { bicycle_type: 'Road', use_roads: 0.9, use_hills: 0.5 } },
  };
  const res = await fetchWithRetry('https://valhalla1.openstreetmap.de/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  const legs = data?.trip?.legs || [];
  if (!legs.length) throw new Error('Valhalla: no route');
  const coords = legs.flatMap((l) => decodePolyline6(l.shape));
  return { coords, provider: 'valhalla-fossgis' };
}

// Leg cache so re-runs don't hammer the public routers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const legCachePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../data/route/leg-cache.json'
);
const legCache = fs.existsSync(legCachePath)
  ? JSON.parse(fs.readFileSync(legCachePath, 'utf8'))
  : {};

import { haversineMi as _hav, cumulativeMiles as _cum } from './geo.mjs';

const lineLen = (coords) => _cum(coords).pop();

/**
 * Bicycle-route one leg between two [lng,lat] points. Cached on disk.
 * BRouter (fastbike for >20 mi rural legs, trekking in town) goes first;
 * when its result detours badly (ratio > 1.45 vs direct — it refuses the
 * desert highways the real Southern Tier rides), Valhalla competes and the
 * shorter route wins.
 */
export async function bikeLeg(from, to) {
  const direct = _hav(from, to);
  const profile = direct > 20 ? 'fastbike' : 'trekking';
  const base = [from, to].flat().map((n) => n.toFixed(5)).join(',');
  const bestKey = 'best:' + base;
  if (legCache[bestKey]) return legCache[bestKey];

  const brKey = profile + ':' + base;
  let br = legCache[brKey] || null;
  if (!br) {
    await throttleRouting();
    try {
      br = await brouterLeg(from, to, profile);
      legCache[brKey] = br;
    } catch (err) {
      console.warn(`  BRouter failed (${err.message}); trying Valhalla`);
    }
  }

  let best = br;
  const brLen = br ? lineLen(br.coords) : Infinity;
  if (!br || (direct > 8 && brLen / direct > 1.45)) {
    await throttleRouting();
    try {
      const va = await valhallaLeg(from, to);
      if (lineLen(va.coords) < brLen) best = va;
    } catch (err) {
      if (!br) throw err;
    }
  }
  legCache[bestKey] = best;
  fs.writeFileSync(legCachePath, JSON.stringify(legCache));
  return best;
}

// ---------- Geocoding: Photon (Komoot) ----------

let lastGeocode = 0;

const STATE_NAMES = {
  AL: 'Alabama', AZ: 'Arizona', CA: 'California', FL: 'Florida', LA: 'Louisiana',
  MS: 'Mississippi', NM: 'New Mexico', TX: 'Texas',
};

/**
 * Geocode a town, guarded by an approximate known coordinate: the accepted
 * candidate must fall within 25 mi of `near` (Photon happily returns
 * same-named places elsewhere — Alpine County for Alpine CA, etc.).
 * Falls back to `near` itself with a warning if nothing qualifies.
 */
export async function geocodeTown(name, state, near) {
  const wait = 1200 - (Date.now() - lastGeocode);
  if (wait > 0) await sleep(wait);
  lastGeocode = Date.now();
  const q = encodeURIComponent(`${name}, ${STATE_NAMES[state] || state}, USA`);
  const url = `https://photon.komoot.io/api/?q=${q}&limit=8&lang=en`;
  const res = await fetchWithRetry(url);
  const data = await res.json();
  for (const f of data.features || []) {
    const p = f.properties || {};
    const isUS = p.country === 'United States' || p.countrycode === 'US';
    if (!isUS) continue;
    const c = f.geometry.coordinates;
    if (!near || _hav(c, near) <= 25) return c; // [lng, lat]
  }
  if (near) {
    console.warn(`  ⚠ geocode for ${name}, ${state} had no candidate near expected location; using approximate coordinate`);
    return near;
  }
  throw new Error(`Geocode failed: ${name}, ${state}`);
}
