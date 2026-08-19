// Route ingestion: OSM USBR 90 relations + bicycle-routed reconstruction legs
// → one continuous east-to-west route with cumulative miles from Pensacola.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { extractPath, trimToNearest, cumulativeMiles, dedupeCoords, haversineMi } from './lib/geo.mjs';
import { fetchRelationWays, bikeLeg, geocodeTown } from './lib/providers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'data/route/waypoints.json'), 'utf8'));
const cachePath = path.join(root, 'data/route/geocode-cache.json');
const geoCache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};

async function cachedGeocode(name, state, near) {
  const key = `${name}|${state}`;
  if (!geoCache[key]) {
    geoCache[key] = await geocodeTown(name, state, near);
    fs.writeFileSync(cachePath, JSON.stringify(geoCache, null, 2));
    console.log(`  geocoded ${name}, ${state} → ${geoCache[key]}`);
  }
  return geoCache[key];
}

// v2 cache: ordered members with roles
const wayCachePath = path.join(root, 'data/route/osm-ways-cache-v2.json');
const wayCache = fs.existsSync(wayCachePath) ? JSON.parse(fs.readFileSync(wayCachePath, 'utf8')) : {};

async function cachedRelationWays(relationId) {
  const key = String(relationId);
  if (!wayCache[key]) {
    console.log(`  fetching relation ${relationId} from Overpass...`);
    wayCache[key] = await fetchRelationWays(relationId);
    fs.writeFileSync(wayCachePath, JSON.stringify(wayCache));
  }
  return wayCache[key];
}

// ---- 1. Extract each OSM segment's trunk path between its anchors (E→W) ----
const osmChains = {};
for (const seg of cfg.osmSegments) {
  console.log(`\n=== OSM segment: ${seg.name}`);
  const ways = await cachedRelationWays(seg.relationId);
  console.log(`  ${ways.length} member ways`);
  const { coords, gaps, error } = extractPath(ways, seg.anchorEast.lnglat, seg.anchorWest.lnglat);
  if (error) {
    console.error(`  ✗ ${error}`);
    process.exit(1);
  }
  let chain = coords;
  let connectorNote = '';
  if (seg.trimStart) {
    const anchor = cfg.anchors[seg.trimStart].lnglat;
    const t = trimToNearest(chain, anchor);
    chain = t.coords;
    console.log(`  trimmed to start near ${cfg.anchors[seg.trimStart].name} (route passes ${t.nearestMi.toFixed(2)} mi from anchor)`);
    if (t.nearestMi > 1) {
      console.log(`  routing connector from ${cfg.anchors[seg.trimStart].name} to route join...`);
      const conn = await bikeLeg(anchor, chain[0]);
      chain = dedupeCoords(conn.coords.concat(chain));
      connectorNote = ` Includes a ${cumulativeMiles(conn.coords).pop().toFixed(1)}-mi bike-routed connector from downtown Pensacola to the USBR 90 alignment.`;
    }
  }
  const miles = cumulativeMiles(chain);
  console.log(`  extracted: ${chain.length} pts, ${miles[miles.length - 1].toFixed(1)} mi, ` +
    `${gaps.length} gap(s) [${gaps.map((g) => g.miles.toFixed(2)).join(', ')}]`);
  console.log(`  start ${chain[0]}  end ${chain[chain.length - 1]}`);
  osmChains[seg.id] = { coords: chain, gaps, cfg: seg, connectorNote };
}

// ---- 2. Route the reconstruction legs between anchors ----
const reconChains = {};

function legEndpoints(leg) {
  const from = leg.fromSegmentEnd
    ? osmChains[leg.fromSegmentEnd].coords.at(-1)
    : leg.fromLegEnd
      ? reconChains[leg.fromLegEnd].coords.at(-1)
      : cfg.anchors[leg.fromAnchor].lnglat;
  const to = leg.toSegmentStart
    ? osmChains[leg.toSegmentStart].coords[0]
    : leg.toAnchor
      ? cfg.anchors[leg.toAnchor].lnglat
      : null;
  return { from, to };
}

for (const leg of cfg.reconLegs) {
  console.log(`\n=== Reconstruction leg: ${leg.name}`);
  const townCoords = [];
  // Prefer research-verified coords baked into waypoints.json; geocode only
  // as a fallback so the rebuild is deterministic and Photon-independent.
  for (const t of leg.towns) {
    townCoords.push(t.lnglat ?? await cachedGeocode(t.name, t.state, t.near));
  }
  const { from, to } = legEndpoints(leg);
  const pts = [from, ...townCoords, ...(to ? [to] : [])];
  let coords = [];
  const providers = new Set();
  for (let i = 0; i < pts.length - 1; i++) {
    const d = haversineMi(pts[i], pts[i + 1]);
    process.stdout.write(`  leg ${i + 1}/${pts.length - 1} (${d.toFixed(0)} mi direct)... `);
    const r = await bikeLeg(pts[i], pts[i + 1]);
    providers.add(r.provider);
    console.log(`${r.provider}, ${r.coords.length} pts`);
    coords = coords.concat(r.coords);
  }
  coords = dedupeCoords(coords);
  const miles = cumulativeMiles(coords);
  console.log(`  total: ${coords.length} pts, ${miles[miles.length - 1].toFixed(1)} mi via ${[...providers].join('+')}`);
  reconChains[leg.id] = { coords, providers: [...providers], cfg: leg };
}

// ---- 3. Assemble east→west, compute the master mile system ----
const ORDER = ['st-fl', 'st-al', 'st-ms', 'st-la', 'st-la-w', 'st-tx', 'st-nm', 'st-az', 'st-az-w', 'st-ca', 'sd-la'];
const now = new Date().toISOString();
const db = openDb();
db.exec('DELETE FROM route_points; DELETE FROM route_segments; DELETE FROM routes;');

db.prepare(
  `INSERT INTO routes (id, kind, name, total_miles, provenance, notes) VALUES (?,?,?,?,?,?)`
).run(
  'personal', 'personal', "Grimey's route: Pensacola → San Diego (Southern Tier E→W) → LA",
  null, 'mixed',
  'Phase 1: personal route follows the reconstructed canonical corridor exactly. SD→LA is a continuation, not part of the Southern Tier.'
);

const insSeg = db.prepare(
  `INSERT INTO route_segments (id, route_id, seq, name, start_mile, end_mile, provenance, source, source_url, retrieved_at, confidence, notes)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
);
const insPt = db.prepare(
  `INSERT INTO route_points (segment_id, seq, lat, lng, mile) VALUES (?,?,?,?,?)`
);
const insertMany = db.transaction((segId, coords, miles) => {
  for (let i = 0; i < coords.length; i++) {
    insPt.run(segId, i, coords[i][1], coords[i][0], miles[i]);
  }
});

let mile = 0;
let prevEnd = null;
let junctionProblems = 0;
const summary = [];

for (let s = 0; s < ORDER.length; s++) {
  const id = ORDER[s];
  const chain = osmChains[id] || reconChains[id];
  const c = chain.cfg;
  let coords = chain.coords;
  let junctionNote = '';
  if (prevEnd) {
    const junction = haversineMi(prevEnd, coords[0]);
    if (junction > 20) {
      console.error(`  ✗ ERROR: ${junction.toFixed(1)} mi junction gap entering ${id} — segment endpoints don't meet!`);
      junctionProblems++;
      mile += junction;
    } else if (junction > 0.2) {
      console.log(`  routing ${junction.toFixed(1)}-mi junction connector into ${id}...`);
      const conn = await bikeLeg(prevEnd, coords[0]);
      coords = dedupeCoords(conn.coords.concat(coords));
      junctionNote = ` Includes a bike-routed junction connector (~${junction.toFixed(1)} mi direct) joining the previous segment.`;
    }
  }
  const miles = cumulativeMiles(coords, mile);
  const startMile = mile;
  mile = miles[miles.length - 1];
  const gapNote = chain.gaps?.length
    ? ` Geometry gaps (mi): ${chain.gaps.map((g) => g.miles.toFixed(2)).join(', ')} (the ~4-mi Alabama gap is the Mobile Bay Ferry).`
    : '';
  insSeg.run(
    id, 'personal', s, c.name, startMile, mile,
    c.provenance, c.source, c.sourceUrl || null, now, c.confidence,
    ((c.notes || '') + gapNote + (chain.connectorNote || '') + junctionNote).trim() || null
  );
  insertMany(id, coords, miles);
  summary.push({ id, name: c.name, miles: (mile - startMile).toFixed(1), provenance: c.provenance });
  prevEnd = coords[coords.length - 1];
}

db.prepare(`UPDATE routes SET total_miles = ? WHERE id = 'personal'`).run(mile);
db.close();

console.log('\n==== ROUTE ASSEMBLED ====');
for (const s of summary) console.log(`  ${s.id.padEnd(6)} ${s.miles.padStart(7)} mi  [${s.provenance}]  ${s.name}`);
console.log(`  TOTAL  ${mile.toFixed(1)} mi (Pensacola → Santa Monica)`);
if (junctionProblems) console.error(`\n✗ ${junctionProblems} junction problem(s) — inspect before trusting the mile system.`);
console.log('\nSanity: ACA publishes the full ST (San Diego→St. Augustine) as ~3,078 mi;');
console.log('Pensacola→San Diego should land roughly in the 2,300–2,700 mi range, plus ~120–140 mi SD→LA.');
