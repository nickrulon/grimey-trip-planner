// The Express app, built around an injected database handle so the same
// routes serve both the local better-sqlite3 process and the serverless
// WASM-SQLite function.
import express from 'express';
import * as turf from '@turf/turf';
import { makePlanner } from './plan.mjs';
import { makeCamping } from './camping.mjs';
import { makeToday } from './today.mjs';
import { makeIntel } from './intel.mjs';
import { forecastForDays } from './weather.mjs';

export function createApp(db) {
const app = express();
app.use(express.json());
const planner = makePlanner(db);
const camping = makeCamping(db, planner);
const intel = makeIntel();
const today = makeToday(db, planner, camping, intel);

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
  fromMin: req.query.fromMin != null ? Number(req.query.fromMin) : null,
  reachMi: req.query.reachMi != null ? Number(req.query.reachMi) : null,
  cats: req.query.cats ? String(req.query.cats).split(',') : undefined,
  limit: req.query.limit != null ? Number(req.query.limit) : undefined,
})));

// The Day Builder's next-link candidates, measured from the chain's cursor.
app.get('/api/plan/day/:n/build-candidates', handle((req) => today.buildCandidates(Number(req.params.n), {
  fromMile: req.query.fromMile, fromMin: req.query.fromMin, reachMi: req.query.reachMi,
  kind: String(req.query.kind ?? 'work'), limit: req.query.limit,
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

// ---- Today layer: the Day Canvas and its decision systems ----
app.get('/api/plan/day/:n/canvas', handle((req) => today.dayCanvas(Number(req.params.n))));
app.get('/api/plan/day/:n/work-options', handle((req) => today.workOptions(Number(req.params.n))));
app.get('/api/plan/day/:n/sleep-options', handle((req) => today.sleepOptions(Number(req.params.n), {
  back: req.query.back ? Number(req.query.back) : undefined,
  fwd: req.query.fwd ? Number(req.query.fwd) : undefined,
})));
app.get('/api/plan/day/:n/fit-options', handle((req) => today.fitOptions(Number(req.params.n))));
app.post('/api/plan/day/fit-apply', handle((req) =>
  today.applyFitOption(Number(req.body?.dayNumber), String(req.body?.optionId ?? ''))));

// Dry run: the same day assembled from a PROPOSED chain of stops (and maybe a
// new endpoint), nothing written. The builder calls this on every change so
// the timeline goes red the moment a day stops fitting.
app.post('/api/plan/day/:n/simulate', handle((req) =>
  today.dayCanvas(Number(req.params.n), req.body ?? {})));
// …and the same proposal, saved: the day's stops replaced and its endpoint
// moved in one transaction, so a half-saved chain is impossible.
app.post('/api/plan/day/:n/stops', handle((req) =>
  today.saveDayChain(Number(req.params.n), req.body ?? {})));

app.post('/api/plan/day/times', handle((req) => planner.setDayTimes(req.body ?? {})));
app.post('/api/plan/day/break', handle((req) => planner.addBreak(req.body ?? {})));
app.post('/api/plan/day/combo', handle((req) => planner.addCombo(req.body ?? {})));

// Rider-drawn marks: fixed appointments the ride has to meet. Time-anchored,
// so unlike a break they never slide when roll-out moves.
app.post('/api/plan/day/mark', handle((req) => planner.addMark(req.body ?? {})));
app.post('/api/plan/day/mark/update', handle((req) => planner.updateMark(req.body ?? {})));
app.post('/api/plan/day/mark/remove', handle((req) => planner.removeMark(req.body ?? {})));

app.post('/api/plan/day/costs', handle((req) => planner.setDayCosts(req.body ?? {})));
app.post('/api/plan/day/work-stop', handle((req) => planner.setWorkStop(req.body ?? {})));
app.post('/api/plan/day/rest', handle((req) => planner.insertRestDay(req.body ?? {})));
app.post('/api/plan/day/rest/remove', handle((req) => planner.removeRestDay(req.body ?? {})));

// One action: pick tonight's bed AND set the day's endpoint (they are the
// same fact — the plan never holds two answers to "where do I sleep").
app.post('/api/plan/day/sleep', handle((req) => {
  const b = req.body ?? {};
  if (b.campId) {
    const spot = camping.spotById(String(b.campId));
    if (!spot) throw new Error(`No camping spot ${b.campId}`);
    return planner.setSleep({
      dayNumber: b.dayNumber, endMile: spot.routeMile, endName: spot.name,
      campId: spot.id, cost: b.cost !== undefined ? b.cost : spot.price ?? undefined,
    });
  }
  if (b.resourceId) {
    const r = db.prepare(`SELECT * FROM resources WHERE id = ?`).get(String(b.resourceId));
    if (!r) throw new Error(`No resource ${b.resourceId}`);
    return planner.setSleep({
      dayNumber: b.dayNumber, endMile: r.route_mile,
      endName: b.endName ?? planner.nameNearMile(r.route_mile),
      overnightResourceId: r.id, cost: b.cost,
    });
  }
  if (!Number.isFinite(Number(b.endMile))) throw new Error('resourceId, campId, or endMile required');
  return planner.setSleep({
    dayNumber: b.dayNumber, endMile: Number(b.endMile),
    endName: b.endName, cost: b.cost,
  });
}));

app.post('/api/plan/revision/activate', handle((req) =>
  planner.activateRevision({ revisionId: Number(req.body?.revisionId) })));

// One-time import from the retired day-plan document (preview, then apply).
app.get('/api/migrate/dayplan', handle(() => today.dayplanMigration({ apply: false })));
app.post('/api/migrate/dayplan', handle((req) => today.dayplanMigration({
  apply: true, includeLodging: req.body?.includeLodging === true,
})));

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

// ---- Day-plan document: the rider's editable day-by-day plan (start/stops/
// lodging/budget). Stored whole as JSON — the cascade logic lives client-side,
// this is just durable storage.
// The day plan document. In the cloud this row lives in the shared database,
// so laptop and phone edit the same plan; locally it is just local state.
app.get('/api/dayplan', handle(() => {
  const row = db.prepare(`SELECT value FROM settings WHERE key='dayplanDoc'`).get();
  return row ? JSON.parse(row.value) : { days: [], derived: [] };
}));
app.post('/api/dayplan', handle((req) => {
  const doc = req.body ?? {};
  if (!Array.isArray(doc.days)) throw new Error('days array required');
  const stamped = {
    ...doc,
    updatedAt: doc.updatedAt ?? new Date().toISOString(),
    updatedBy: doc.updatedBy ?? 'unknown',
  };
  db.prepare(
    `INSERT INTO settings (key, value) VALUES ('dayplanDoc', ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(JSON.stringify(stamped));
  return { ok: true, updatedAt: stamped.updatedAt };
}));

// Raw route points for a mile window — lets the UI draw one day's exact
// section of the route.
app.get('/api/route/points', handle((req) => {
  const lo = Number(req.query.minMile ?? 0);
  const hi = Number(req.query.maxMile ?? 1e9);
  const pts = db.prepare(
    `SELECT lat, lng FROM route_points WHERE mile BETWEEN ? AND ? ORDER BY mile`
  ).all(lo, hi);
  // Thin long windows so a 70-mile day doesn't ship 2,000 vertices.
  const step = Math.max(1, Math.floor(pts.length / 800));
  return { coords: pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => [p.lng, p.lat]) };
}));

// ---- Camping guide: sleep planning, separate from ride planning ----
app.get('/api/camping', handle(() => camping.campingResponse()));

// ---- Ride intel: what other riders found out there, joined by route mile ----
app.get('/api/intel', handle(() => intel.summary()));
app.get('/api/intel/range', handle((req) => ({
  records: intel.forRange(Number(req.query.from ?? 0), Number(req.query.to ?? 1e9), {
    minSeverity: req.query.minSeverity ? Number(req.query.minSeverity) : 0,
  }),
})));
app.get('/api/intel/regional', handle((req) => ({
  records: intel.regionalFor(String(req.query.states ?? '').split(',').filter(Boolean)),
})));

// ---- Ride Mode (Phase 4) ----
app.get('/api/position', handle((req) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const mile = req.query.mile != null ? Number(req.query.mile) : null;
  if (mile == null && (!Number.isFinite(lat) || !Number.isFinite(lng))) {
    throw new Error('lat/lng or mile required');
  }
  const info = planner.positionInfo(mile != null ? { mile } : { lat, lng });
  // Other riders' hard-won warnings, ahead of you, worst first.
  info.intelAhead = intel.ahead(info.mile, 45, { minSeverity: 3 });
  return info;
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
    // dayplanDoc is a JSON document with its own endpoint, not a setting.
    .filter((r) => r.key !== 'dayplanDoc')
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

return app;
}
