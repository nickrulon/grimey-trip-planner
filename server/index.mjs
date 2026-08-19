import express from 'express';
import * as turf from '@turf/turf';
import { openDb } from './db.mjs';
import { makePlanner } from './plan.mjs';
import { forecastForDays } from './weather.mjs';

const app = express();
app.use(express.json());
const db = openDb();
const planner = makePlanner(db);
// API_PORT, not PORT — dev harnesses inject PORT for the web server.
const PORT = process.env.API_PORT || 5181;

// ---- Route geometry, simplified for rendering, one feature per segment ----
let routeCache = null;

function buildRouteResponse() {
  if (routeCache) return routeCache;
  const segments = db.prepare(
    `SELECT * FROM route_segments ORDER BY seq`
  ).all();
  const features = [];
  const mileMarkers = [];
  let nextMarker = 0;
  for (const seg of segments) {
    const pts = db.prepare(
      `SELECT lat, lng, mile FROM route_points WHERE segment_id = ? ORDER BY seq`
    ).all(seg.id);
    if (pts.length < 2) continue;
    const line = turf.lineString(pts.map((p) => [p.lng, p.lat]));
    const simplified = turf.simplify(line, { tolerance: 0.0004, highQuality: false });
    features.push({
      type: 'Feature',
      properties: {
        id: seg.id, name: seg.name, provenance: seg.provenance,
        startMile: Math.round(seg.start_mile * 10) / 10,
        endMile: Math.round(seg.end_mile * 10) / 10,
        confidence: seg.confidence, source: seg.source,
        sourceUrl: seg.source_url, notes: seg.notes,
        continuation: seg.id === 'sd-la' ? 1 : 0,
      },
      geometry: simplified.geometry,
    });
    for (const p of pts) {
      if (p.mile >= nextMarker) {
        mileMarkers.push({ mile: nextMarker, lat: p.lat, lng: p.lng });
        nextMarker += 25;
      }
    }
  }
  const route = db.prepare(`SELECT * FROM routes WHERE id = 'personal'`).get();
  routeCache = {
    route: route ? { name: route.name, totalMiles: route.total_miles, notes: route.notes } : null,
    segments: { type: 'FeatureCollection', features },
    mileMarkers,
  };
  return routeCache;
}

app.get('/api/route', (_req, res) => {
  try {
    res.json(buildRouteResponse());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- Resources: filter by mile window + categories, GeoJSON out ----
app.get('/api/resources', (req, res) => {
  const minMile = Number(req.query.minMile ?? 0);
  const maxMile = Number(req.query.maxMile ?? 1e9);
  const cats = req.query.cats ? String(req.query.cats).split(',') : null;
  let sql = `SELECT r.*, group_concat(s.provider || ':' || s.provider_ref) AS srcs
             FROM resources r LEFT JOIN resource_sources s ON s.resource_id = r.id
             WHERE r.route_mile BETWEEN ? AND ?`;
  const args = [minMile, maxMile];
  if (cats) {
    sql += ` AND r.category_id IN (${cats.map(() => '?').join(',')})`;
    args.push(...cats);
  }
  sql += ` GROUP BY r.id`;
  const rows = db.prepare(sql).all(...args);
  res.json({
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      properties: {
        id: r.id, category: r.category_id, name: r.name, brand: r.brand,
        routeMile: Math.round(r.route_mile * 10) / 10,
        offRouteMi: Math.round(r.off_route_mi * 100) / 100,
        wifiStatus: r.wifi_status, website: r.website, hours: r.hours,
        address: r.address, phone: r.phone,
        attributes: r.attributes_json, sources: r.srcs,
        lastVerified: r.last_verified,
      },
      geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
    })),
  });
});

app.get('/api/categories', (_req, res) => {
  res.json(db.prepare(`SELECT * FROM resource_categories WHERE enabled = 1`).all());
});

app.get('/api/summary', (_req, res) => {
  const route = db.prepare(`SELECT * FROM routes WHERE id = 'personal'`).get();
  const counts = db.prepare(
    `SELECT category_id, COUNT(*) AS n FROM resources GROUP BY category_id`
  ).all();
  res.json({ totalMiles: route?.total_miles ?? null, resourceCounts: counts });
});

// ---- Trip plan (Phases 2–3) ----
const handle = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    res.status(400).json({ error: err.message ?? String(err) });
  }
};

app.get('/api/plan', handle(() => planner.planResponse()));

app.get('/api/plan/suggest', handle((req) => {
  const fromMile = Number(req.query.fromMile);
  if (!Number.isFinite(fromMile)) throw new Error('fromMile required');
  return planner.suggestEndpoints(
    fromMile,
    Number(req.query.target ?? 65),
    Number(req.query.window ?? 15),
    // Splitting an over-long day has to be able to look past the daily cap.
    { ignoreCap: req.query.ignoreCap === '1' }
  );
}));

app.get('/api/plan/auto/preview', handle((req) => planner.previewAutoPlan({
  ...(req.query.maxMiles ? { maxMiles: Number(req.query.maxMiles) } : {}),
  ...(req.query.workAware != null ? { workAware: req.query.workAware === '1' } : {}),
  ...(req.query.weekendMaxMiles ? { weekendMaxMiles: Number(req.query.weekendMaxMiles) } : {}),
})));

app.post('/api/plan/auto', handle((req) => planner.autoPlan({
  ...(req.body?.maxMiles ? { maxMiles: Number(req.body.maxMiles) } : {}),
  // Rebuilds keep locked days by default; pass fromScratch to start over.
  fromScratch: req.body?.fromScratch === true,
})));

app.post('/api/plan/day', handle((req) => planner.editDayEnd(req.body ?? {})));
app.post('/api/plan/day/split', handle((req) => planner.splitDay(req.body ?? {})));
app.post('/api/plan/day/merge', handle((req) => planner.mergeDays(req.body ?? {})));
// ---- Intra-day itinerary ----
app.get('/api/plan/day/:n/itinerary', handle((req) =>
  planner.dayItinerary(Number(req.params.n))));

app.get('/api/plan/day/:n/stop-candidates', handle((req) => planner.stopCandidates({
  dayNumber: Number(req.params.n),
  fromMile: req.query.fromMile != null ? Number(req.query.fromMile) : undefined,
  cats: req.query.cats ? String(req.query.cats).split(',') : undefined,
})));

app.post('/api/plan/stop', handle((req) => planner.addStop(req.body ?? {})));
app.post('/api/plan/stop/update', handle((req) => planner.updateStop(req.body ?? {})));
app.post('/api/plan/stop/remove', handle((req) => planner.removeStop(req.body ?? {})));
app.get('/api/plan/itinerary/auto', handle((req) => planner.autoItineraries({
  from: req.query.from ? Number(req.query.from) : 1,
  to: req.query.to ? Number(req.query.to) : undefined,
  apply: false,
})));
app.post('/api/plan/itinerary/auto', handle((req) => planner.autoItineraries({
  from: req.body?.from ? Number(req.body.from) : 1,
  to: req.body?.to ? Number(req.body.to) : undefined,
  apply: true,
})));

app.post('/api/plan/day/start-time', handle((req) => planner.setDayStart(req.body ?? {})));

app.get('/api/plan/fit', handle(() => planner.fitToDates({ apply: false })));
app.post('/api/plan/fit', handle((req) => planner.fitToDates({
  apply: true,
  floorMiles: req.body?.floorMiles ? Number(req.body.floorMiles) : undefined,
})));

app.post('/api/plan/day/complete', handle((req) => planner.completeDay(req.body ?? {})));
app.post('/api/plan/day/unlock', handle((req) => planner.unlockDay(req.body ?? {})));

app.post('/api/actual', handle((req) => {
  const b = req.body ?? {};
  if (!Number.isFinite(Number(b.dayNumber)) || !Number.isFinite(Number(b.endMile))) {
    throw new Error('dayNumber and endMile required');
  }
  return planner.recordActual({
    dayNumber: Number(b.dayNumber), endMile: Number(b.endMile),
    endName: b.endName, date: b.date, notes: b.notes,
  });
}));

const replanMode = (v) => (v === 'anchors' ? 'anchors' : 'rebuild');
app.get('/api/replan/preview', handle((req) => planner.replanPreview(replanMode(req.query.mode))));
app.post('/api/replan/apply', handle((req) => planner.replanApply(replanMode(req.body?.mode))));

// Record where the day actually ended AND return the proposed reshuffle in one
// round trip — the rider is at a picnic table, not a desk. Nothing is committed
// until /api/replan/apply, so the preview stays a proposal (brief §14).
app.post('/api/actual/replan', handle((req) => {
  const b = req.body ?? {};
  if (!Number.isFinite(Number(b.dayNumber)) || !Number.isFinite(Number(b.endMile))) {
    throw new Error('dayNumber and endMile required');
  }
  const actual = planner.recordActual({
    dayNumber: Number(b.dayNumber), endMile: Number(b.endMile),
    endName: b.endName, date: b.date, notes: b.notes,
  });
  return { actual, preview: planner.replanPreview(replanMode(b.mode)) };
}));

// ---- Ride Mode (Phase 4) ----
app.get('/api/position', handle((req) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const mile = req.query.mile != null ? Number(req.query.mile) : null;
  if (mile == null && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
    throw new Error('lat/lng or mile required');
  }
  return planner.positionInfo(mile != null ? { mile } : { lat, lng });
}));

// ---- Elevation profile for one day ----
app.get('/api/plan/day/:n/profile', handle((req) => {
  const { days } = planner.activeDays();
  const day = days.find((d) => d.day_number === Number(req.params.n));
  if (!day) throw new Error(`No day ${req.params.n}`);
  return planner.elevationForRange(day.start_mile, day.end_mile)
    ?? { profile: null, note: 'No elevation data ingested for this stretch yet.' };
}));

// ---- Settings + weather (Phase 4) ----
app.get('/api/settings', handle(() =>
  Object.fromEntries(db.prepare(`SELECT key, value FROM settings`).all()
    .map((r) => [r.key, r.value]))
));
app.post('/api/settings', handle((req) => {
  const upsert = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  );
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (typeof v !== 'string' || k.length > 64) throw new Error('string settings only');
    upsert.run(k, v);
  }
  return { ok: true };
}));

app.get('/api/weather', handle(async () => {
  const start = db.prepare(`SELECT value FROM settings WHERE key='startDate'`).get()?.value;
  if (!start) return { byDay: {}, note: 'Set a trip start date to see forecasts.' };
  const { days } = planner.activeDays();
  const geo = days.map((d) => {
    const s = planner.pointAtMile(d.start_mile);
    const e = planner.pointAtMile(d.end_mile);
    return {
      dayNumber: d.day_number, endName: d.end_name,
      startPt: [s.lng, s.lat], endPt: [e.lng, e.lat],
    };
  });
  return { startDate: start, byDay: await forecastForDays(start, geo) };
}));

app.listen(PORT, () => console.log(`API on http://localhost:${PORT}`));
