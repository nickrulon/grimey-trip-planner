// Trip-plan engine: day splitting, resource-aware endpoint suggestions,
// actual-day recording, and anchor-based replanning (brief §12–§16).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function haversineMi([lng1, lat1], [lng2, lat2]) {
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Feasibility bounds for a riding day, used to flag (never silently "fix") plans.
export const DAY_BOUNDS = { veryShort: 20, tooLong: 95 };

// Day shaping defaults. maxMiles is a hard ceiling the planner never exceeds;
// effortTarget is what each day aims for in *effort miles*, so that flat days
// stretch toward the ceiling and climbing days come out shorter on their own.
export const DAY_SHAPE = { maxMiles: 65, effortTarget: 65, minMiles: 15 };

// Cycling effort heuristic: ~100 ft of climbing costs about a flat mile.
// Crude but stable, and it is only ever used to rank/limit days — never
// presented as a physiological fact.
const CLIMB_FT_PER_EFFORT_MILE = 100;

export function makePlanner(db) {
  const totalMiles = db.prepare(`SELECT total_miles FROM routes WHERE id='personal'`).get()?.total_miles ?? 0;

  const ptAtMile = db.prepare(
    `SELECT lat, lng, mile FROM route_points WHERE mile >= ? ORDER BY mile LIMIT 1`
  );
  const lastPt = db.prepare(`SELECT lat, lng, mile FROM route_points ORDER BY mile DESC LIMIT 1`);
  function pointAtMile(mile) {
    return ptAtMile.get(mile) ?? lastPt.get();
  }

  // Rider-tunable day shaping, stored in settings so the cap survives replans.
  const settingStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
  function dayShape(overrides = {}) {
    const num = (k, d) => {
      const v = Number(settingStmt.get(k)?.value);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    const maxMiles = overrides.maxMiles ?? num('maxDayMiles', DAY_SHAPE.maxMiles);
    return {
      maxMiles,
      // Effort target defaults to the ceiling: a pancake-flat day reaches the
      // cap, and every 100 ft of climb trims roughly a mile off the day.
      effortTarget: overrides.effortTarget ?? num('effortTargetMiles', maxMiles),
      minMiles: overrides.minMiles ?? DAY_SHAPE.minMiles,
    };
  }

  // ---- Route sampled every ~0.2 mi, shared by place naming and GPS locate().
  const refPts = [];
  {
    let nextAt = -1;
    for (const p of db.prepare(`SELECT lat, lng, mile FROM route_points ORDER BY mile`).all()) {
      if (p.mile >= nextAt) { refPts.push(p); nextAt = p.mile + 0.2; }
    }
  }

  // Project an arbitrary position onto the route: route mile + off-route miles.
  function locate(lat, lng) {
    let best = null, bestD = Infinity;
    for (const p of refPts) {
      const d = haversineMi([lng, lat], [p.lng, p.lat]);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { mile: best.mile, offMi: bestD } : null;
  }

  // ---- Named places for human day names, not "Mile 913". Two sources:
  // OSM towns/cities ingested into route_places, plus waypoints.json anchors.
  const places = [];
  const TYPE_WEIGHT = { city: 3, town: 2, village: 1 };
  for (const p of db.prepare(`SELECT name, place_type, population, route_mile FROM route_places`).all()) {
    places.push({ name: p.name, mile: p.route_mile, weight: TYPE_WEIGHT[p.place_type] ?? 1 });
  }
  try {
    const wp = JSON.parse(fs.readFileSync(path.join(root, 'data/route/waypoints.json'), 'utf8'));
    const found = [];
    (function scan(node) {
      if (!node || typeof node !== 'object') return;
      if (typeof node.name === 'string' && Array.isArray(node.lnglat)) found.push(node);
      for (const v of Object.values(node)) scan(v);
    })(wp);
    for (const f of found) {
      let bestD = Infinity, bestMile = null;
      for (const p of refPts) {
        const d = haversineMi(f.lnglat, [p.lng, p.lat]);
        if (d < bestD) { bestD = d; bestMile = p.mile; }
      }
      if (bestD <= 15) {
        // Strip parenthetical annotations: "Pensacola, FL (Mile 0)" → "Pensacola, FL"
        const clean = f.name.replace(/\s*\(.*\)$/, '');
        if (/\bline\b|×|\bexit\b/i.test(clean)) continue;  // "FL/AL line", "SR 188 × SR 87"
        places.push({ name: clean, mile: bestMile, weight: 2.5 });
      }
    }
  } catch (err) {
    console.warn('[plan] no waypoint places loaded:', err.message);
  }
  places.sort((a, b) => a.mile - b.mile);

  // ---- State by route mile. The corridor waypoints each declare their state,
  // so projecting them onto the mile system gives correct "City, ST" labels
  // (including at the fiddly border stretches) without a geocoder round-trip.
  const stateMarks = [];
  try {
    const wp = JSON.parse(fs.readFileSync(path.join(root, 'data/route/waypoints.json'), 'utf8'));
    for (const leg of wp.reconLegs ?? []) {
      for (const t of leg.towns ?? []) {
        if (!t.state || !t.lnglat) continue;
        let bestD = Infinity, bestMile = null;
        for (const q of refPts) {
          const d = haversineMi(t.lnglat, [q.lng, q.lat]);
          if (d < bestD) { bestD = d; bestMile = q.mile; }
        }
        if (bestD <= 12) stateMarks.push({ mile: bestMile, state: t.state });
      }
    }
  } catch { /* labels degrade to no state, which is honest enough */ }
  // Segments built from OSM relations have no town list; they are single-state
  // by construction, so seed them from the segment table directly.
  const OSM_SEG_STATE = { 'st-fl': 'FL', 'st-al': 'AL', 'st-la-w': 'LA', 'st-az-w': 'AZ' };
  for (const seg of db.prepare(`SELECT id, start_mile FROM route_segments`).all()) {
    if (OSM_SEG_STATE[seg.id]) {
      stateMarks.push({ mile: seg.start_mile, state: OSM_SEG_STATE[seg.id] });
    }
  }
  stateMarks.sort((a, b) => a.mile - b.mile);

  function stateAtMile(mile) {
    let cur = null;
    for (const m of stateMarks) {
      if (m.mile > mile + 8) break;
      cur = m.state;
    }
    return cur;
  }

  // Prefer significant places, but not at the cost of accuracy: a village
  // 1 mile away beats a city 7 miles down the road.
  function nameNearMile(mile) {
    let best = null, bestScore = -Infinity;
    for (const p of places) {
      const d = Math.abs(p.mile - mile);
      if (d > 8) continue;
      const score = p.weight * 2 - d;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best) return best.name;
    let nearest = null, nearestD = Infinity;
    for (const p of places) {
      const d = Math.abs(p.mile - mile);
      if (d < nearestD) { nearestD = d; nearest = p; }
    }
    if (nearest && nearestD <= 14) return `near ${nearest.name}`;
    return `Mile ${Math.round(mile)}`;
  }

  // ---- Endpoint suggestions (brief §13): overnight anchors in a mile window,
  // scored transparently. Scores are decision-support, not fake certainty.
  const overnightsInWindow = db.prepare(
    `SELECT id, category_id, name, brand, route_mile, off_route_mi, attributes_json,
            address, phone, website, hours, lat, lng
     FROM resources WHERE category_id IN ('campground','hotel')
     AND route_mile BETWEEN ? AND ? AND status='active'`
  );
  const nextAnchorStmt = db.prepare(
    `SELECT route_mile FROM resources WHERE category_id IN ('campground','hotel')
     AND status='active' AND off_route_mi <= 5
     AND route_mile > ? AND route_mile <= ? ORDER BY route_mile LIMIT 1`
  );
  const wifiNearStmt = db.prepare(
    `SELECT COUNT(*) n FROM resources WHERE category_id='wifi_work'
     AND route_mile BETWEEN ? AND ? AND off_route_mi <= 2`
  );

  // Effort miles = flat-equivalent distance. A 45-mi day with 2,000 ft of climb
  // costs about the same as a 65-mi day on the Gulf Coast, which is exactly the
  // trade the rider makes in their legs.
  function effortMiles(fromMile, toMile) {
    const gain = elevationForRange(fromMile, toMile)?.gainFt ?? null;
    const miles = toMile - fromMile;
    return { miles, gainFt: gain, effort: miles + (gain ?? 0) / CLIMB_FT_PER_EFFORT_MILE };
  }

  function suggestEndpoints(fromMile, target, window, opts = {}) {
    const shape = dayShape(opts);
    // The hard ceiling wins over the requested window: a suggestion the rider
    // has already said is too long is not a suggestion.
    const capMile = opts.ignoreCap ? totalMiles : fromMile + shape.maxMiles;
    const lo = Math.max(fromMile + Math.min(shape.minMiles, target), fromMile + target - window);
    const hi = Math.min(totalMiles, capMile, fromMile + target + window);
    if (hi <= lo) return [];
    const effortTarget = opts.effortTarget ?? Math.min(shape.effortTarget, target + window / 2);
    const out = [];
    for (const r of overnightsInWindow.all(lo, hi)) {
      const { miles: dayMiles, gainFt, effort } = effortMiles(fromMile, r.route_mile);
      const wifiNear = wifiNearStmt.get(r.route_mile - 2, r.route_mile + 2).n;
      let attrs = {};
      try { attrs = JSON.parse(r.attributes_json); } catch { /* keep {} */ }
      const score =
        100 -
        // Rank on effort, not raw distance, so hilly days come out shorter.
        Math.abs(effort - effortTarget) * 2 -
        r.off_route_mi * 7 +
        Math.min(wifiNear, 5) * 2 +
        (r.category_id === 'campground' && attrs.shower && attrs.shower !== 'no' ? 3 : 0);
      const town = nameNearMile(r.route_mile);
      out.push({
        resourceId: r.id, name: r.name, brand: r.brand, category: r.category_id,
        routeMile: r1(r.route_mile),
        dayMiles: r1(dayMiles),
        effortMiles: r1(effort), climbFt: gainFt,
        offRouteMi: r2(r.off_route_mi),
        wifiNear, town, state: stateAtMile(r.route_mile),
        address: r.address, phone: r.phone, website: r.website, hours: r.hours,
        lat: r.lat, lng: r.lng, attributes: r.attributes_json,
        score: r1(score),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 14);
  }

  // ---- Auto-plan: walk the route choosing the best anchor for each day, never
  // exceeding the rider's mileage ceiling and aiming at a constant *effort*
  // budget so climbing days shorten themselves (brief §13).
  function buildAutoDays(opts = {}) {
    const shape = dayShape(opts);
    const { maxMiles, minMiles } = shape;
    let { effortTarget } = shape;

    // Work-aware planning: on a day owing 7.5 h of desk time, the bike only
    // gets whatever is left of the daylight. That upper bound — not the
    // rider's preferred ceiling — is what actually governs a working day.
    const workAware = opts.workAware ?? (settingStmt.get('workAwarePlanning')?.value === '1');
    const planStartDate = settingStmt.get('startDate')?.value ?? null;
    let weekdayCap = maxMiles;
    // Weekends carry no desk time, so they can absorb the long miles the
    // working days give up. Explicit setting; defaults to the normal ceiling.
    const weekendSetting = Number(settingStmt.get('weekendMaxMiles')?.value);
    const weekendCap = opts.weekendMaxMiles
      ?? (Number.isFinite(weekendSetting) && weekendSetting > 0 ? weekendSetting : maxMiles);
    if (workAware) {
      const ws = workSettings();
      const rideable = toMin(ws.arriveBy) - toMin(ws.earliestDepart) - ws.minutes;
      weekdayCap = Math.max(minMiles, Math.min(maxMiles, (rideable / 60) * ridingSpeed()));
    }
    const capFor = (n) => {
      if (!workAware || !planStartDate) return maxMiles;
      return isWorkday(dateForDay(planStartDate, n)) ? weekdayCap : weekendCap;
    };

    const days = [];
    let from = opts.startMile ?? 0, dayNum = opts.startDayNumber ?? 1;
    let guard = 0;

    while (totalMiles - from > capFor(dayNum) && guard++ < 400) {
      const maxMiles = capFor(dayNum);
      effortTarget = workAware ? maxMiles : shape.effortTarget;
      // Aim at whatever distance is expected to cost effortTarget here: on flat
      // ground that is the cap, in the mountains it is a good deal less.
      let aim = maxMiles;
      for (let i = 0; i < 3; i++) {
        const probe = Math.min(from + aim, totalMiles);
        const { effort, miles } = effortMiles(from, probe);
        if (!miles || effort <= 0) break;
        const scaled = aim * (effortTarget / effort);
        aim = Math.max(minMiles, Math.min(maxMiles, (aim + scaled) / 2));
      }

      let picked = null;
      for (const w of [10, 18, Math.max(20, maxMiles - minMiles)]) {
        const sugs = suggestEndpoints(from, aim, w, { maxMiles, effortTarget });
        if (sugs.length) { picked = sugs[0]; break; }
      }

      const flags = [];
      let end, endName, overnightId = null;
      if (picked) {
        end = picked.routeMile;
        endName = picked.town;
        overnightId = picked.resourceId;
      } else {
        // Nothing to sleep at within the ceiling. Stopping dead on the cap can
        // strand a 16-mile stub tomorrow, so peek past it: if the next anchor
        // is just out of reach, split the gap into two balanced days instead.
        end = Math.min(from + maxMiles, totalMiles);
        const nxt = nextAnchorStmt.get(from + maxMiles, from + maxMiles * 2);
        if (nxt && nxt.route_mile - end < DAY_BOUNDS.veryShort) {
          end = from + (nxt.route_mile - from) / 2;
        }
        endName = nameNearMile(end);
        flags.push('no_anchor');
      }
      if (end - from < 1) { end = Math.min(from + maxMiles, totalMiles); }
      if (end - from > maxMiles + 0.5) flags.push('over_cap');
      if (end - from < DAY_BOUNDS.veryShort) flags.push('very_short');

      days.push({
        day_number: dayNum, start_mile: from, end_mile: end,
        start_name: days.length ? days[days.length - 1].end_name : nameNearMile(from),
        end_name: endName, overnight_resource_id: overnightId,
        flags, status: 'planned',
      });
      from = end; dayNum++;
    }

    // Remainder is <= that day's ceiling by construction, so it is the last day.
    if (totalMiles - from > 0.5) {
      days.push({
        day_number: dayNum, start_mile: from, end_mile: totalMiles,
        start_name: days.length ? days[days.length - 1].end_name : nameNearMile(from),
        end_name: nameNearMile(totalMiles), overnight_resource_id: null,
        flags: [], status: 'planned',
      });
    }
    return days;
  }

  const insertRev = db.prepare(`INSERT INTO plan_revisions (created_at, reason, active) VALUES (?,?,1)`);
  const insertDay = db.prepare(
    `INSERT INTO planned_days
     (revision_id, day_number, start_mile, end_mile, start_name, end_name,
      overnight_resource_id, status, flags, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const deactivate = db.prepare(`UPDATE plan_revisions SET active=0 WHERE active=1`);

  const saveRevision = db.transaction((reason, days) => {
    deactivate.run();
    const rev = insertRev.run(new Date().toISOString(), reason);
    for (const d of days) {
      insertDay.run(
        rev.lastInsertRowid, d.day_number, d.start_mile, d.end_mile,
        d.start_name, d.end_name, d.overnight_resource_id,
        d.status ?? 'planned', JSON.stringify(d.flags ?? []), d.notes ?? null
      );
    }
    return rev.lastInsertRowid;
  });

  // Build without saving, so the rider can compare schedules before committing.
  function previewAutoPlan(opts = {}) {
    const lastDone = db.prepare(`SELECT * FROM actual_days ORDER BY day_number DESC LIMIT 1`).get();
    const startMile = lastDone ? lastDone.end_mile : 0;
    const startDayNumber = lastDone ? lastDone.day_number + 1 : 1;
    const built = buildAutoDays({ ...opts, startMile, startDayNumber });
    const total = (lastDone ? lastDone.day_number : 0) + built.length;
    const startDate = settingStmt.get('startDate')?.value ?? null;
    const arriveDate = settingStmt.get('arriveDate')?.value ?? null;
    const lengths = built.map((b) => b.end_mile - b.start_mile);
    return {
      dayCount: total, newDays: built.length,
      maxDay: r1(Math.max(...lengths, 0)),
      avgDay: r1(lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length)),
      projectedArrival: startDate ? dateForDay(startDate, total) : null,
      arriveDate,
      daysLate: startDate && arriveDate
        ? Math.max(0, total - (daysBetween(startDate, arriveDate) + 1)) : null,
    };
  }

  function autoPlan(opts = {}) {
    const shape = dayShape(opts);
    const lastDone = opts.fromScratch ? null
      : db.prepare(`SELECT * FROM actual_days ORDER BY day_number DESC LIMIT 1`).get();
    let past = [];
    let startMile = opts.startMile ?? 0;
    let startDayNumber = opts.startDayNumber ?? 1;

    if (lastDone) {
      const { days: cur } = activeDays();
      past = cur
        .filter((d) => d.day_number <= lastDone.day_number)
        .map((d) => ({ ...d, flags: JSON.parse(d.flags || '[]') }));
      startMile = lastDone.end_mile;
      startDayNumber = lastDone.day_number + 1;
    }

    const fresh = buildAutoDays({ ...opts, startMile, startDayNumber });
    const revId = saveRevision(
      lastDone
        ? `rebuild after day ${lastDone.day_number} (max ${r1(shape.maxMiles)} mi/day, from mile ${r1(startMile)})`
        : `auto (max ${r1(shape.maxMiles)} mi/day, effort-balanced)`,
      [...past, ...fresh]
    );
    return {
      revisionId: revId, dayCount: past.length + fresh.length, shape,
      keptDays: past.length, rebuiltFromMile: r1(startMile),
    };
  }

  // ---- Intra-day itinerary (brief §12: a day is stops, not just an endpoint).
  const DEFAULT_SPEED = 11;      // loaded touring average, mph
  const DEFAULT_START = '06:00';

  const toMin = (hhmm) => {
    const [h, m] = String(hhmm ?? DEFAULT_START).split(':').map(Number);
    return (Number.isFinite(h) ? h : 6) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const toHHMM = (min) => {
    const wrapped = ((Math.round(min) % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };

  function ridingSpeed() {
    const v = Number(settingStmt.get('ridingSpeedMph')?.value);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SPEED;
  }

  // Ride time uses EFFORT miles, so a climb costs real minutes rather than
  // pretending 30 mountain miles take as long as 30 flat ones.
  function rideMinutes(fromMile, toMile, speed) {
    const { effort } = effortMiles(fromMile, toMile);
    return Math.max(0, (effort / speed) * 60);
  }

  const stopsInRange = db.prepare(
    `SELECT * FROM planned_stops WHERE route_mile >= ? AND route_mile <= ?
     ORDER BY route_mile`
  );

  function dayItinerary(dayNumber) {
    const { days } = activeDays();
    const day = days.find((d) => d.day_number === dayNumber);
    if (!day) throw new Error(`No day ${dayNumber}`);
    const speed = ridingSpeed();
    const startTime =
      db.prepare(`SELECT start_time FROM day_plans WHERE day_number = ?`).get(dayNumber)?.start_time
      ?? settingStmt.get('dayStartTime')?.value ?? DEFAULT_START;

    // Stops strictly inside the day; the overnight endpoint is the finish line,
    // not a stop the rider has to add by hand.
    const stops = stopsInRange.all(day.start_mile + 0.01, day.end_mile - 0.01);
    const items = [];
    let cursorMile = day.start_mile;
    let cursorMin = toMin(startTime);

    for (const st of stops) {
      const rideMin = rideMinutes(cursorMile, st.route_mile, speed);
      const arrive = cursorMin + rideMin;
      const depart = arrive + (st.dwell_min ?? 0);
      items.push({
        type: 'stop', id: st.id,
        name: st.name, category: st.category, resourceId: st.resource_id,
        routeMile: r1(st.route_mile), offRouteMi: r2(st.off_route_mi),
        rideMiles: r1(st.route_mile - cursorMile),
        rideMinutes: Math.round(rideMin),
        arriveTime: toHHMM(arrive), departTime: toHHMM(depart),
        dwellMin: st.dwell_min ?? 0, notes: st.notes,
      });
      cursorMile = st.route_mile;
      cursorMin = depart;
    }

    const finalRide = rideMinutes(cursorMile, day.end_mile, speed);
    const finishMin = cursorMin + finalRide;
    const totalRide = items.reduce((a, i) => a + i.rideMinutes, 0) + Math.round(finalRide);
    return {
      dayNumber, startTime, speedMph: speed,
      startMile: r1(day.start_mile), endMile: r1(day.end_mile),
      endName: day.end_name, overnightName: day.overnight_name ?? null,
      items,
      finish: {
        rideMiles: r1(day.end_mile - cursorMile),
        rideMinutes: Math.round(finalRide),
        arriveTime: toHHMM(finishMin),
        pastMidnight: finishMin >= 1440,
      },
      totalRideMinutes: totalRide,
      totalDwellMinutes: items.reduce((a, i) => a + i.dwellMin, 0),
    };
  }

  // Candidates for the next stop: everything reachable further along today,
  // annotated with how long the ride there takes from where you already are.
  function stopCandidates({ dayNumber, fromMile, cats, limit = 40 }) {
    const { days } = activeDays();
    const day = days.find((d) => d.day_number === dayNumber);
    if (!day) throw new Error(`No day ${dayNumber}`);
    const speed = ridingSpeed();
    const lo = Math.max(day.start_mile, fromMile ?? day.start_mile) + 0.05;
    const hi = day.end_mile - 0.05;
    if (hi <= lo) return { candidates: [], speedMph: speed };
    const catList = cats && cats.length ? cats : ['wifi_work', 'campground', 'hotel'];
    const rows = db.prepare(
      `SELECT id, category_id, name, brand, route_mile, off_route_mi, address,
              phone, website, hours, wifi_status, lat, lng
       FROM resources
       WHERE status='active' AND route_mile BETWEEN ? AND ?
         AND category_id IN (${catList.map(() => '?').join(',')})
         AND off_route_mi <= 4
       ORDER BY route_mile LIMIT ?`
    ).all(lo, hi, ...catList, limit * 3);

    const out = rows.map((r) => ({
      resourceId: r.id, name: r.name, brand: r.brand, category: r.category_id,
      routeMile: r1(r.route_mile), offRouteMi: r2(r.off_route_mi),
      rideMiles: r1(r.route_mile - (fromMile ?? day.start_mile)),
      rideMinutes: Math.round(rideMinutes(fromMile ?? day.start_mile, r.route_mile, speed)),
      wifiStatus: r.wifi_status, address: r.address, phone: r.phone,
      website: r.website, hours: r.hours, lat: r.lat, lng: r.lng,
    }));
    // Prefer close-to-route options, but keep the list in ride order.
    out.sort((a, b) => a.rideMinutes - b.rideMinutes || a.offRouteMi - b.offRouteMi);
    return { candidates: out.slice(0, limit), speedMph: speed };
  }

  function addStop({ routeMile, resourceId, name, category, offRouteMi, dwellMin, notes }) {
    if (!Number.isFinite(Number(routeMile))) throw new Error('routeMile required');
    const info = db.prepare(
      `INSERT INTO planned_stops (route_mile, resource_id, name, category, off_route_mi, dwell_min, notes)
       VALUES (?,?,?,?,?,?,?)`
    ).run(Number(routeMile), resourceId ?? null, name || 'Stop', category ?? null,
      offRouteMi ?? null, Number.isFinite(Number(dwellMin)) ? Number(dwellMin) : 30, notes ?? null);
    return { ok: true, id: info.lastInsertRowid };
  }

  function updateStop({ id, dwellMin, departTime, dayNumber, notes }) {
    const stop = db.prepare(`SELECT * FROM planned_stops WHERE id = ?`).get(id);
    if (!stop) throw new Error(`No stop ${id}`);
    let dwell = stop.dwell_min;
    if (departTime && dayNumber != null) {
      // "I am leaving at noon" is the natural way to say this — derive the
      // dwell from the computed arrival rather than making the rider do math.
      const it = dayItinerary(Number(dayNumber));
      const item = it.items.find((i) => i.id === id);
      if (item) {
        const d = toMin(departTime) - toMin(item.arriveTime);
        if (d < 0) throw new Error(`That is before you would arrive (${item.arriveTime})`);
        dwell = Math.round(d);
      }
    } else if (Number.isFinite(Number(dwellMin))) {
      dwell = Math.max(0, Number(dwellMin));
    }
    db.prepare(`UPDATE planned_stops SET dwell_min=?, notes=COALESCE(?, notes) WHERE id=?`)
      .run(dwell, notes ?? null, id);
    return { ok: true, dwellMin: dwell };
  }

  function removeStop({ id }) {
    db.prepare(`DELETE FROM planned_stops WHERE id = ?`).run(id);
    return { ok: true };
  }

  function setDayStart({ dayNumber, startTime }) {
    db.prepare(
      `INSERT INTO day_plans (day_number, start_time) VALUES (?,?)
       ON CONFLICT(day_number) DO UPDATE SET start_time=excluded.start_time`
    ).run(Number(dayNumber), startTime || null);
    return { ok: true };
  }

  // ---- Auto-itinerary: fit a working day around a riding day.
  // The rider owes 7.5 h of sitting-down work on weekdays. Riding time is
  // fixed by the route, so the only free variables are when to leave and where
  // to sit. Everything here is arithmetic on those two — and when it does not
  // fit, the day says so instead of quietly scheduling four hours of work in
  // the dark.
  const WORK_DEFAULTS = {
    minutes: 450,            // 7.5 h
    windowStart: '08:00',
    windowEnd: '18:00',
    arriveBy: '19:00',       // want to be off the bike by this hour
    earliestDepart: '05:30',
    latestDepart: '09:30',
    maxBlockMin: 480,
  };

  function workSettings() {
    const num = (k, d) => {
      const v = Number(settingStmt.get(k)?.value);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    const str = (k, d) => settingStmt.get(k)?.value || d;
    return {
      minutes: num('workMinutesPerDay', WORK_DEFAULTS.minutes),
      windowStart: str('workWindowStart', WORK_DEFAULTS.windowStart),
      windowEnd: str('workWindowEnd', WORK_DEFAULTS.windowEnd),
      arriveBy: str('arriveByTime', WORK_DEFAULTS.arriveBy),
      earliestDepart: str('earliestDepart', WORK_DEFAULTS.earliestDepart),
      latestDepart: str('latestDepart', WORK_DEFAULTS.latestDepart),
      maxBlockMin: num('maxWorkBlockMin', WORK_DEFAULTS.maxBlockMin),
    };
  }

  function isWorkday(dateStr) {
    if (!dateStr) return true;                       // no calendar → assume workday
    const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
    return dow >= 1 && dow <= 5;
  }

  // Wi-Fi stops good enough to sit at for hours: close to the route, and
  // preferring places that actually document internet access.
  const workStopsStmt = db.prepare(
    `SELECT id, name, category_id, route_mile, off_route_mi, wifi_status, hours
     FROM resources
     WHERE status='active' AND category_id='wifi_work'
       AND route_mile BETWEEN ? AND ? AND off_route_mi <= ?
     ORDER BY route_mile`
  );

  function proposeDayItinerary(dayNumber, { day, date } = {}) {
    const { days } = activeDays();
    const d = day ?? days.find((x) => x.day_number === dayNumber);
    if (!d) throw new Error(`No day ${dayNumber}`);
    const ws = workSettings();
    const speed = ridingSpeed();
    const totalRide = rideMinutes(d.start_mile, d.end_mile, speed);
    const workday = isWorkday(date);
    const needed = workday ? ws.minutes : 0;
    const issues = [];

    if (!needed) {
      // Weekend: no work owed. Leave at a civilised hour and just ride.
      const start = toMin('07:30');
      return {
        dayNumber, date, workday: false, requiredMin: 0, scheduledMin: 0,
        startTime: toHHMM(start), arriveTime: toHHMM(start + totalRide),
        rideMinutes: Math.round(totalRide), stops: [], issues,
        feasible: true,
      };
    }

    const winStart = toMin(ws.windowStart), winEnd = toMin(ws.windowEnd);
    const arriveBy = toMin(ws.arriveBy);
    const dMin = toMin(ws.earliestDepart), dMax = toMin(ws.latestDepart);

    const cands = workStopsStmt.all(d.start_mile + 0.3, d.end_mile - 0.3, 2.5)
      .map((c) => ({
        ...c,
        toStop: rideMinutes(d.start_mile, c.route_mile, speed),
        afterStop: rideMinutes(c.route_mile, d.end_mile, speed),
        quality: (c.wifi_status === 'confirmed' ? 2 : c.wifi_status === 'likely' ? 1 : 0)
          - c.off_route_mi * 1.5,
      }));

    if (!cands.length) {
      issues.push(`No Wi-Fi stop on this stretch — ${Math.round(needed / 60 * 10) / 10} h of work has nowhere to land.`);
      const start = Math.max(dMin, Math.min(dMax, arriveBy - totalRide));
      return {
        dayNumber, date, workday: true, requiredMin: needed, scheduledMin: 0,
        startTime: toHHMM(start), arriveTime: toHHMM(start + totalRide),
        rideMinutes: Math.round(totalRide), stops: [], issues, feasible: false,
      };
    }

    // Cost of one candidate schedule. Arriving after dark is the worst outcome;
    // then work spilling past the window; then an unpleasantly early alarm.
    function score(stopsPlan, depart) {
      let t = depart, mile = d.start_mile, cost = 0, worked = 0;
      const legs = [];
      for (const sp of stopsPlan) {
        t += rideMinutes(mile, sp.route_mile, speed);
        const arrive = t;
        const begin = Math.max(arrive, winStart);
        cost += (begin - arrive) * 0.35;                 // idling before you may start
        const end = begin + sp.block;
        if (end > winEnd) cost += (end - winEnd) * 1.0;  // working past the window
        if (begin < winStart) cost += (winStart - begin) * 0.5;
        worked += sp.block;
        legs.push({ ...sp, arrive, begin, end });
        t = end; mile = sp.route_mile;
      }
      t += rideMinutes(mile, d.end_mile, speed);
      if (t > arriveBy) cost += (t - arriveBy) * 3.0;
      if (depart < toMin('06:00')) cost += (toMin('06:00') - depart) * 0.6;
      cost -= stopsPlan.reduce((a, sp) => a + sp.quality * 12, 0);
      cost += (stopsPlan.length - 1) * 25;              // each extra stop is friction
      return { cost, finish: t, legs, worked };
    }

    let best = null;
    const consider = (stopsPlan) => {
      for (let dep = dMin; dep <= dMax; dep += 10) {
        const r = score(stopsPlan, dep);
        if (!best || r.cost < best.cost) best = { ...r, depart: dep, plan: stopsPlan };
      }
    };

    // One long sit is the rider's stated preference; try every candidate.
    for (const c of cands) {
      if (needed <= ws.maxBlockMin) consider([{ ...c, block: needed }]);
    }
    // Two stops, for days where no single place is well placed (or the block
    // is longer than anyone wants to sit in one McDonald's).
    const top = [...cands].sort((a, b) => b.quality - a.quality).slice(0, 8);
    for (const a of top) {
      for (const b of top) {
        if (b.route_mile <= a.route_mile + 2) continue;
        for (const frac of [0.5, 0.65]) {
          consider([
            { ...a, block: Math.round(needed * frac) },
            { ...b, block: needed - Math.round(needed * frac) },
          ]);
        }
      }
    }

    if (!best) {
      issues.push('Could not fit a working day here.');
      return {
        dayNumber, date, workday: true, requiredMin: needed, scheduledMin: 0,
        startTime: ws.earliestDepart, arriveTime: toHHMM(dMin + totalRide),
        rideMinutes: Math.round(totalRide), stops: [], issues, feasible: false,
      };
    }

    const lastLeg = best.legs[best.legs.length - 1];
    if (best.finish > arriveBy) {
      issues.push(`Arrives ${toHHMM(best.finish)} — after your ${ws.arriveBy} target. Ride time (${dur(totalRide)}) plus ${dur(needed)} of work does not fit the daylight.`);
    }
    if (lastLeg.end > winEnd) {
      issues.push(`Work runs to ${toHHMM(lastLeg.end)}, past ${ws.windowEnd}.`);
    }
    if (best.legs[0].begin < winStart) {
      issues.push(`Starts work at ${toHHMM(best.legs[0].begin)}, before ${ws.windowStart} — needed to get off the bike in time.`);
    }
    if (best.depart < toMin('05:30')) {
      issues.push(`Early alarm: rolling out at ${toHHMM(best.depart)}.`);
    }

    return {
      dayNumber, date, workday: true,
      requiredMin: needed, scheduledMin: best.worked,
      startTime: toHHMM(best.depart), arriveTime: toHHMM(best.finish),
      rideMinutes: Math.round(totalRide),
      stops: best.legs.map((l) => ({
        resourceId: l.id, name: l.name, category: l.category_id,
        routeMile: r1(l.route_mile), offRouteMi: r2(l.off_route_mi),
        wifiStatus: l.wifi_status,
        arriveTime: toHHMM(l.arrive), workStart: toHHMM(l.begin),
        departTime: toHHMM(l.end), dwellMin: Math.round(l.end - l.arrive),
      })),
      issues, feasible: best.worked >= needed && best.finish <= arriveBy + 45,
    };
  }

  const dur = (min) => {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${m}m`;
  };

  // Build (and optionally save) itineraries for a run of days.
  function autoItineraries({ from = 1, to, apply = false } = {}) {
    const { days } = activeDays();
    const startDate = settingStmt.get('startDate')?.value ?? null;
    const targets = days.filter((d) =>
      d.day_number >= from && (to == null || d.day_number <= to) && d.status !== 'completed'
    );
    const results = [];
    for (const d of targets) {
      const date = dateForDay(startDate, d.day_number);
      try {
        results.push(proposeDayItinerary(d.day_number, { day: d, date }));
      } catch (err) {
        results.push({ dayNumber: d.day_number, date, error: err.message, issues: [err.message], feasible: false });
      }
    }

    if (apply) {
      const tx = db.transaction(() => {
        for (const d of targets) {
          const r = results.find((x) => x.dayNumber === d.day_number);
          if (!r || r.error) continue;
          // Replace only what falls inside this day, so hand-made stops on
          // other days survive.
          db.prepare(`DELETE FROM planned_stops WHERE route_mile > ? AND route_mile < ?`)
            .run(d.start_mile, d.end_mile);
          for (const sp of r.stops) {
            db.prepare(
              `INSERT INTO planned_stops (route_mile, resource_id, name, category, off_route_mi, dwell_min, notes)
               VALUES (?,?,?,?,?,?,?)`
            ).run(sp.routeMile, sp.resourceId, sp.name, sp.category, sp.offRouteMi,
              sp.dwellMin, r.workday ? 'work stop (auto)' : null);
          }
          db.prepare(
            `INSERT INTO day_plans (day_number, start_time) VALUES (?,?)
             ON CONFLICT(day_number) DO UPDATE SET start_time=excluded.start_time`
          ).run(d.day_number, r.startTime);
        }
      });
      tx();
    }

    const workdays = results.filter((r) => r.workday);
    return {
      applied: apply,
      dayCount: results.length,
      workdays: workdays.length,
      fullyScheduled: workdays.filter((r) => r.feasible && r.scheduledMin >= r.requiredMin).length,
      problemDays: results.filter((r) => r.issues?.length).map((r) => ({
        dayNumber: r.dayNumber, date: r.date, issues: r.issues,
        scheduledMin: r.scheduledMin ?? 0, requiredMin: r.requiredMin ?? 0,
      })),
      days: results,
    };
  }

  // ---- Calendar constraints. The trip has to land on a date, so the daily
  // ceiling is negotiable against the window the rider actually has.
  const DAY_MS = 86400000;
  function addDays(iso, n) {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round(
      (new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / DAY_MS
    );
  }
  function dateForDay(startDate, dayNumber) {
    return startDate ? addDays(startDate, dayNumber - 1) : null;
  }

  function scheduleInfo(days) {
    const startDate = settingStmt.get('startDate')?.value ?? null;
    const arriveDate = settingStmt.get('arriveDate')?.value ?? null;
    if (!startDate) return { startDate: null, arriveDate, plannedDays: days.length };
    const plannedDays = days.length;
    const projectedArrival = dateForDay(startDate, plannedDays);
    const info = {
      startDate, arriveDate, plannedDays, projectedArrival,
      maxDayMiles: r1(dayShape().maxMiles),
    };
    if (arriveDate) {
      // Inclusive: depart Sept 21, arrive Sept 21 = one day of riding.
      const availableDays = daysBetween(startDate, arriveDate) + 1;
      info.availableDays = availableDays;
      info.slackDays = availableDays - plannedDays;
      info.requiredAvgMiles = availableDays > 0 ? r1(totalMiles / availableDays) : null;
      info.daysLate = Math.max(0, plannedDays - availableDays);
    }
    return info;
  }

  // Search for the lowest daily ceiling that still lands the trip on time.
  // Feasibility only improves as the cap rises (fewer, longer days), so a
  // binary search over integer caps is enough, with a linear check at the end.
  function fitToDates({ apply = false, floorMiles } = {}) {
    const startDate = settingStmt.get('startDate')?.value;
    const arriveDate = settingStmt.get('arriveDate')?.value;
    if (!startDate || !arriveDate) throw new Error('Set both a depart date and an arrive date first');
    const availableDays = daysBetween(startDate, arriveDate) + 1;
    if (availableDays < 1) throw new Error('Arrive date is before the depart date');

    const lastDone = db.prepare(`SELECT * FROM actual_days ORDER BY day_number DESC LIMIT 1`).get();
    const startMile = lastDone ? lastDone.end_mile : 0;
    const startDayNumber = lastDone ? lastDone.day_number + 1 : 1;
    const daysLeft = availableDays - (lastDone ? lastDone.day_number : 0);
    if (daysLeft < 1) throw new Error('No calendar days left before the arrive date');

    const current = dayShape().maxMiles;
    const floor = floorMiles ?? current;
    const countAt = (cap) =>
      buildAutoDays({ maxMiles: cap, effortTarget: cap, startMile, startDayNumber }).length;

    const atFloor = countAt(floor);
    if (atFloor <= daysLeft) {
      // The rider's own ceiling already fits; the leftover days are theirs to
      // spend on rest, weather, or a longer stop — not miles we should invent.
      const res = {
        feasible: true, changed: false, cap: r1(floor),
        dayCount: atFloor, availableDays, daysLeft,
        slackDays: daysLeft - atFloor,
        note: `Your ${r1(floor)} mi/day ceiling already fits — ${daysLeft - atFloor} spare day(s) for rest or weather.`,
      };
      return res;
    }

    let lo = floor, hi = 140, best = null;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (countAt(mid) <= daysLeft) { best = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    if (best == null) {
      const minDays = countAt(140);
      return {
        feasible: false, changed: false, availableDays, daysLeft,
        dayCount: minDays, cap: 140,
        note: `Even at 140 mi/day this takes ${minDays} riding days — ${minDays - daysLeft} more than the window allows. Move the arrive date or start earlier.`,
      };
    }

    const dayCount = countAt(best);
    const result = {
      feasible: true, changed: true, cap: r1(best), previousCap: r1(current),
      dayCount, availableDays, daysLeft, slackDays: daysLeft - dayCount,
      note: `Fitting ${r1(totalMiles - startMile)} mi into ${daysLeft} day(s) needs the ceiling raised from ${r1(current)} to ${r1(best)} mi/day.`,
    };

    if (apply) {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES ('maxDayMiles', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).run(String(best));
      const built = autoPlan({ maxMiles: best });
      result.revisionId = built.revisionId;
      result.dayCount = built.dayCount;
      result.keptDays = built.keptDays;
    }
    return result;
  }

  // "Done as planned" — the rider locks the day in without changing anything.
  // Locking is just an actual at the planned endpoint, so every downstream
  // behaviour (replan, rebuild, progress) keys off one mechanism.
  function completeDay({ dayNumber, date, notes }) {
    const { days } = activeDays();
    const day = days.find((d) => d.day_number === dayNumber);
    if (!day) throw new Error(`No day ${dayNumber}`);
    return recordActual({
      dayNumber, endMile: day.end_mile, endName: day.end_name, date, notes,
    });
  }

  function unlockDay({ dayNumber }) {
    const { rev } = activeDays();
    const info = db.prepare(`DELETE FROM actual_days WHERE day_number = ?`).run(dayNumber);
    if (rev) {
      db.prepare(`UPDATE planned_days SET status='planned' WHERE revision_id=? AND day_number=?`)
        .run(rev.id, dayNumber);
    }
    return { ok: true, removed: info.changes };
  }

  // ---- Read model: active plan merged with actuals, plus map geometry.
  function activeRevision() {
    return db.prepare(`SELECT * FROM plan_revisions WHERE active=1`).get() ?? null;
  }

  function activeDays() {
    const rev = activeRevision();
    if (!rev) return { rev: null, days: [] };
    const days = db.prepare(
      `SELECT d.*, r.name AS overnight_name, r.category_id AS overnight_category,
              r.off_route_mi AS overnight_off_mi, r.address AS overnight_address,
              r.phone AS overnight_phone, r.website AS overnight_website,
              r.hours AS overnight_hours, r.lat AS overnight_lat, r.lng AS overnight_lng,
              r.attributes_json AS overnight_attrs, r.route_mile AS overnight_mile
       FROM planned_days d LEFT JOIN resources r ON r.id = d.overnight_resource_id
       WHERE d.revision_id = ? ORDER BY d.day_number`
    ).all(rev.id);
    return { rev, days };
  }

  const catCountsStmt = db.prepare(
    `SELECT category_id, COUNT(*) n FROM resources
     WHERE route_mile BETWEEN ? AND ? GROUP BY category_id`
  );

  const geomCache = new Map(); // revisionId -> FeatureCollections
  function dayGeometry(rev, days) {
    if (geomCache.has(rev.id)) return geomCache.get(rev.id);
    const ptsStmt = db.prepare(
      `SELECT lat, lng FROM route_points WHERE mile BETWEEN ? AND ? ORDER BY mile, seq`
    );
    const lineFeatures = [];
    for (const d of days) {
      if (d.end_mile - d.start_mile < 0.5) continue;
      const pts = ptsStmt.all(d.start_mile, d.end_mile);
      if (pts.length < 2) continue;
      const line = turf.simplify(
        turf.lineString(pts.map((p) => [p.lng, p.lat])),
        { tolerance: 0.0008, highQuality: false }
      );
      lineFeatures.push({
        type: 'Feature',
        properties: { dayNumber: d.day_number },
        geometry: line.geometry,
      });
    }
    const boundFeatures = days.map((d) => {
      const p = pointAtMile(d.start_mile);
      return {
        type: 'Feature',
        properties: { label: `D${d.day_number}`, dayNumber: d.day_number },
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      };
    });
    const endP = pointAtMile(days[days.length - 1]?.end_mile ?? totalMiles);
    if (endP) {
      boundFeatures.push({
        type: 'Feature', properties: { label: 'END', dayNumber: -1 },
        geometry: { type: 'Point', coordinates: [endP.lng, endP.lat] },
      });
    }
    const geo = {
      lines: { type: 'FeatureCollection', features: lineFeatures },
      bounds: { type: 'FeatureCollection', features: boundFeatures },
    };
    geomCache.set(rev.id, geo);
    return geo;
  }

  function planResponse() {
    const { rev, days } = activeDays();
    if (!rev) return { revision: null, days: [], geometry: null, totalMiles };
    const actuals = Object.fromEntries(
      db.prepare(`SELECT * FROM actual_days`).all().map((a) => [a.day_number, a])
    );
    const out = days.map((d) => {
      const counts = Object.fromEntries(
        catCountsStmt.all(d.start_mile, d.end_mile).map((c) => [c.category_id, c.n])
      );
      const a = actuals[d.day_number];
      const elev = elevationForRange(d.start_mile, d.end_mile);
      const riderNotes = notesStmt.all(d.end_mile, d.start_mile).map((n) => ({
        id: n.id, kind: n.kind, title: n.title, detail: n.detail,
        startMile: r1(n.start_mile), endMile: r1(n.end_mile),
        source: n.source, confidence: n.confidence,
      }));
      return {
        dayNumber: d.day_number,
        elevGainFt: elev?.gainFt ?? null, elevLossFt: elev?.lossFt ?? null,
        riderNotes,
        startMile: r1(d.start_mile), endMile: r1(d.end_mile),
        miles: r1(d.end_mile - d.start_mile),
        startName: d.start_name, endName: d.end_name,
        endState: stateAtMile(d.end_mile),
        overnight: d.overnight_resource_id
          ? { id: d.overnight_resource_id, name: d.overnight_name,
              category: d.overnight_category, offRouteMi: r2(d.overnight_off_mi),
              address: d.overnight_address, phone: d.overnight_phone,
              website: d.overnight_website, hours: d.overnight_hours,
              lat: d.overnight_lat, lng: d.overnight_lng,
              attributes: d.overnight_attrs,
              town: d.overnight_mile != null ? nameNearMile(d.overnight_mile) : null,
              state: d.overnight_mile != null ? stateAtMile(d.overnight_mile) : null,
              routeMile: r1(d.overnight_mile) }
          : null,
        status: d.status, flags: JSON.parse(d.flags || '[]'), notes: d.notes,
        resourceCounts: counts,
        actual: a ? {
          endMile: r1(a.end_mile), miles: r1(a.end_mile - a.start_mile),
          endName: a.end_name, date: a.date, notes: a.notes,
        } : null,
      };
    });
    const geometry = dayGeometry(rev, days);
    // Per-feature effective status so the map can color days without a second fetch.
    for (const f of geometry.lines.features) {
      const d = out.find((x) => x.dayNumber === f.properties.dayNumber);
      if (d) Object.assign(f.properties, {
        status: d.status, miles: d.miles, startName: d.startName, endName: d.endName,
        startMile: d.startMile, endMile: d.endMile,
        actualMiles: d.actual?.miles ?? null,
      });
    }
    const history = db.prepare(
      `SELECT id, created_at, reason, active,
              (SELECT COUNT(*) FROM planned_days pd WHERE pd.revision_id = plan_revisions.id) AS day_count
       FROM plan_revisions ORDER BY id DESC`
    ).all();
    // Calendar dates ride along with the plan so the timeline reads as dates,
    // not just day numbers.
    const startDate = settingStmt.get('startDate')?.value ?? null;
    if (startDate) {
      for (const d of out) d.date = dateForDay(startDate, d.dayNumber);
    }
    return {
      revision: { id: rev.id, createdAt: rev.created_at, reason: rev.reason },
      days: out, geometry, totalMiles: r1(totalMiles), history,
      schedule: scheduleInfo(out),
    };
  }

  // ---- Actuals (brief §14): record what happened; planned rows keep the plan.
  function recordActual({ dayNumber, endMile, endName, date, notes }) {
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const planned = days.find((d) => d.day_number === dayNumber);
    if (!planned) throw new Error(`No planned day ${dayNumber}`);
    const prev = db.prepare(`SELECT end_mile FROM actual_days WHERE day_number = ?`).get(dayNumber - 1);
    const startMile = prev ? prev.end_mile : planned.start_mile;
    if (endMile <= startMile) throw new Error(`End mile ${endMile} is not past day start (mile ${r1(startMile)})`);
    db.prepare(
      `INSERT OR REPLACE INTO actual_days (day_number, date, start_mile, end_mile, end_name, notes, recorded_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(dayNumber, date ?? null, startMile, endMile,
      endName || nameNearMile(endMile), notes ?? null, new Date().toISOString());
    const status = Math.abs(endMile - planned.end_mile) <= 2 ? 'completed' : 'modified';
    db.prepare(`UPDATE planned_days SET status=? WHERE revision_id=? AND day_number=?`)
      .run(status, rev.id, dayNumber);
    return { dayNumber, startMile: r1(startMile), endMile: r1(endMile), status };
  }

  // ---- Replan (brief §14): rebase the rest of the trip on actual progress.
  // Two honest strategies, never a blind redistribution of mileage:
  //   'rebuild' — re-cut every remaining day under the mileage ceiling with the
  //               effort budget, so a short day today shortens the days after it.
  //   'anchors' — keep the overnight stops already chosen (booked lodging) and
  //               only shift the mileage between them.
  function replanPreview(mode = 'rebuild') {
    const last = db.prepare(`SELECT * FROM actual_days ORDER BY day_number DESC LIMIT 1`).get();
    if (!last) throw new Error('No actual days recorded yet');
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const baseline = last.end_mile;
    const future = days.filter((d) => d.day_number > last.day_number);
    const shape = dayShape();
    const issues = [];
    let newDays = [];

    if (mode === 'anchors') {
      // Keep anchors in order; drop any the rider has already passed.
      const anchors = future
        .filter((d) => d.end_mile > baseline + 3)
        .map((d) => ({
          endMile: d.end_mile, endName: d.end_name,
          overnightId: d.overnight_resource_id, overnightName: d.overnight_name,
          origDayNumber: d.day_number, origMiles: d.end_mile - d.start_mile,
          origFlags: JSON.parse(d.flags || '[]'),
        }));
      const dropped = future.length - anchors.length;
      let from = baseline, dayNum = last.day_number + 1;
      for (const a of anchors) {
        const { miles, gainFt } = effortMiles(from, a.endMile);
        const flags = [...a.origFlags.filter((f) => f === 'no_anchor')];
        let splitOptions;
        if (miles > shape.maxMiles) {
          flags.push('over_cap');
          splitOptions = suggestEndpoints(from, Math.round(miles / 2), 18).slice(0, 5);
        } else if (miles < DAY_BOUNDS.veryShort) {
          flags.push('very_short');
        }
        newDays.push({
          day_number: dayNum,
          start_mile: from, end_mile: a.endMile,
          start_name: newDays.length ? newDays[newDays.length - 1].end_name : (last.end_name ?? nameNearMile(baseline)),
          end_name: a.endName, overnight_resource_id: a.overnightId,
          overnightName: a.overnightName,
          miles: r1(miles), climbFt: gainFt, origDayNumber: a.origDayNumber,
          origMiles: r1(a.origMiles), deltaMiles: r1(miles - a.origMiles),
          flags, splitOptions, status: 'planned',
        });
        from = a.endMile; dayNum++;
      }
      if (dropped > 0) issues.push(`${dropped} planned stop(s) already passed — absorbed into the new schedule.`);
      for (const d of newDays) {
        if (d.flags.includes('over_cap')) issues.push(`Day ${d.day_number} becomes ${d.miles} mi — over your ${r1(shape.maxMiles)} mi cap to keep ${d.end_name}.`);
        if (d.flags.includes('very_short')) issues.push(`Day ${d.day_number} is only ${d.miles} mi — consider merging with the next day.`);
      }
    } else {
      // Rebuild: re-cut the remainder from where the rider actually stands.
      const rebuilt = buildAutoDays({ startMile: baseline, startDayNumber: last.day_number + 1 });
      const prevByNum = new Map(future.map((d) => [d.day_number, d]));
      newDays = rebuilt.map((d, idx) => {
        const { miles, gainFt } = effortMiles(d.start_mile, d.end_mile);
        const orig = prevByNum.get(d.day_number);
        const overnight = d.overnight_resource_id
          ? db.prepare(`SELECT name FROM resources WHERE id = ?`).get(d.overnight_resource_id)
          : null;
        return {
          ...d,
          start_name: idx === 0 ? (last.end_name ?? nameNearMile(baseline)) : d.start_name,
          miles: r1(miles), climbFt: gainFt,
          overnightName: overnight?.name ?? null,
          origDayNumber: orig ? orig.day_number : null,
          origMiles: orig ? r1(orig.end_mile - orig.start_mile) : null,
          deltaMiles: orig ? r1(miles - (orig.end_mile - orig.start_mile)) : null,
        };
      });
      const keptAnchors = future.filter((f) =>
        f.overnight_resource_id &&
        rebuilt.some((n) => n.overnight_resource_id === f.overnight_resource_id)
      ).length;
      const lostAnchors = future.filter((f) =>
        f.overnight_resource_id && f.end_mile > baseline + 3 &&
        !rebuilt.some((n) => n.overnight_resource_id === f.overnight_resource_id)
      ).length;
      if (lostAnchors > 0) {
        issues.push(`${lostAnchors} previously chosen overnight stop(s) are no longer in the schedule${keptAnchors ? ` (${keptAnchors} kept)` : ''} — use "keep my stops" instead if any are booked.`);
      }
      for (const d of newDays) {
        if (d.flags.includes('no_anchor')) issues.push(`Day ${d.day_number} ends at mile ${r1(d.end_mile)} with no lodging or campground within the cap — plan to wild camp or stretch the day.`);
      }
    }

    const oldFinish = days.length ? days[days.length - 1].day_number : last.day_number;
    const newFinish = newDays.length ? newDays[newDays.length - 1].day_number : last.day_number;
    return {
      mode,
      baselineMile: r1(baseline), afterDay: last.day_number,
      baselineName: last.end_name, days: newDays, issues,
      maxDayMiles: r1(shape.maxMiles),
      summary: {
        oldFinishDay: oldFinish, newFinishDay: newFinish,
        dayDelta: newFinish - oldFinish,
        remainingMiles: r1(totalMiles - baseline),
      },
    };
  }

  function replanApply(mode = 'rebuild') {
    const preview = replanPreview(mode);
    const { days } = activeDays();
    const past = days.filter((d) => d.day_number <= preview.afterDay)
      .map((d) => ({ ...d, flags: JSON.parse(d.flags || '[]') }));
    const revId = saveRevision(
      `replan after day ${preview.afterDay} (from mile ${preview.baselineMile}, ${mode})`,
      [...past, ...preview.days]
    );
    return {
      revisionId: revId, dayCount: past.length + preview.days.length,
      issues: preview.issues, summary: preview.summary,
    };
  }

  // ---- Manual edits, in place on the active revision (pre-trip churn).
  // Moving a day's end shifts the next day's start; anchors elsewhere stay put.
  function editDayEnd({ dayNumber, endMile, endName, overnightResourceId }) {
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const idx = days.findIndex((d) => d.day_number === dayNumber);
    if (idx === -1) throw new Error(`No day ${dayNumber}`);
    const day = days[idx];
    if (day.status !== 'planned') throw new Error(`Day ${dayNumber} is ${day.status}; only planned days can be edited`);
    if (endMile <= day.start_mile) throw new Error('End must be past the day start');
    const next = days[idx + 1];
    if (next && endMile >= next.end_mile) throw new Error(`End would pass day ${next.day_number}'s endpoint`);
    const name = endName || nameNearMile(endMile);
    const shape = dayShape();
    // Flags describe the day as it now stands. An over-cap day the rider chose
    // on purpose is allowed — it is marked, not blocked.
    const flagsFor = (startM, endM, hasAnchor) => {
      const f = [];
      const len = endM - startM;
      if (len > shape.maxMiles + 0.5) f.push('over_cap');
      if (len < DAY_BOUNDS.veryShort) f.push('very_short');
      if (!hasAnchor) f.push('no_anchor');
      return JSON.stringify(f);
    };
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE planned_days SET end_mile=?, end_name=?, overnight_resource_id=?, flags=?
         WHERE revision_id=? AND day_number=?`
      ).run(endMile, name, overnightResourceId ?? null,
        flagsFor(day.start_mile, endMile, !!(overnightResourceId ?? null)),
        rev.id, dayNumber);
      if (next) {
        db.prepare(
          `UPDATE planned_days SET start_mile=?, start_name=?, flags=?
           WHERE revision_id=? AND day_number=?`
        ).run(endMile, name,
          flagsFor(endMile, next.end_mile, !!next.overnight_resource_id),
          rev.id, next.day_number);
      }
    });
    tx();
    geomCache.delete(rev.id);
    return {
      ok: true,
      day: { dayNumber, miles: r1(endMile - day.start_mile) },
      next: next ? { dayNumber: next.day_number, miles: r1(next.end_mile - endMile) } : null,
    };
  }

  // Merge a day into the one after it: one longer day, everything after shifts
  // up a number. The cap is deliberately not enforced here — merging is how the
  // rider says "I'd rather do 80 today than sit around at mile 16".
  function mergeDays({ dayNumber }) {
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const idx = days.findIndex((d) => d.day_number === dayNumber);
    if (idx === -1) throw new Error(`No day ${dayNumber}`);
    const day = days[idx], next = days[idx + 1];
    if (!next) throw new Error(`Day ${dayNumber} is the last day — nothing to merge into`);
    if (day.status !== 'planned' || next.status !== 'planned') {
      throw new Error('Only planned days can be merged');
    }
    const shape = dayShape();
    const merged = next.end_mile - day.start_mile;
    const flags = [];
    if (merged > shape.maxMiles + 0.5) flags.push('over_cap');
    if (!next.overnight_resource_id) flags.push('no_anchor');

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE planned_days SET end_mile=?, end_name=?, overnight_resource_id=?, flags=?
         WHERE revision_id=? AND day_number=?`
      ).run(next.end_mile, next.end_name, next.overnight_resource_id,
        JSON.stringify(flags), rev.id, dayNumber);
      db.prepare(`DELETE FROM planned_days WHERE revision_id=? AND day_number=?`)
        .run(rev.id, next.day_number);
      // Two-step renumber: a direct -1 collides with UNIQUE(revision, day).
      db.prepare(
        `UPDATE planned_days SET day_number = day_number + 1000
         WHERE revision_id=? AND day_number > ?`
      ).run(rev.id, next.day_number);
      db.prepare(
        `UPDATE planned_days SET day_number = day_number - 1001
         WHERE revision_id=? AND day_number > 1000`
      ).run(rev.id);
    });
    tx();
    geomCache.delete(rev.id);
    return { ok: true, dayNumber, miles: r1(merged), flags };
  }

  function splitDay({ dayNumber, atMile, endName, overnightResourceId }) {
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const day = days.find((d) => d.day_number === dayNumber);
    if (!day) throw new Error(`No day ${dayNumber}`);
    if (day.status !== 'planned') throw new Error(`Day ${dayNumber} is ${day.status}`);
    if (atMile <= day.start_mile + 1 || atMile >= day.end_mile - 1) {
      throw new Error('Split point must be inside the day');
    }
    const name = endName || nameNearMile(atMile);
    const tx = db.transaction(() => {
      // Two-step shift: a direct +1 walks into the UNIQUE(revision, day) constraint.
      db.prepare(
        `UPDATE planned_days SET day_number = day_number + 1000
         WHERE revision_id=? AND day_number > ?`
      ).run(rev.id, dayNumber);
      db.prepare(
        `UPDATE planned_days SET day_number = day_number - 999
         WHERE revision_id=? AND day_number > 1000`
      ).run(rev.id);
      db.prepare(
        `UPDATE planned_days SET end_mile=?, end_name=?, overnight_resource_id=?, flags='[]'
         WHERE revision_id=? AND day_number=?`
      ).run(atMile, name, overnightResourceId ?? null, rev.id, dayNumber);
      db.prepare(
        `INSERT INTO planned_days
         (revision_id, day_number, start_mile, end_mile, start_name, end_name,
          overnight_resource_id, status, flags)
         VALUES (?,?,?,?,?,?,?, 'planned', '[]')`
      ).run(rev.id, dayNumber + 1, atMile, day.end_mile, name, day.end_name,
        day.overnight_resource_id);
    });
    tx();
    geomCache.delete(rev.id);
    return { ok: true };
  }

  // ---- Ride Mode (brief §26): where am I, what's today, what's ahead.
  const upcomingStmt = db.prepare(
    `SELECT id, category_id, name, brand, route_mile, off_route_mi, wifi_status,
            lat, lng, address, phone, website, hours
     FROM resources WHERE route_mile BETWEEN ? AND ? AND status='active'
     ORDER BY route_mile LIMIT 40`
  );

  function positionInfo({ lat, lng, mile }) {
    let loc;
    if (mile != null) {
      const p = pointAtMile(mile);
      loc = { mile, offMi: 0, lat: p.lat, lng: p.lng };
    } else {
      const l = locate(lat, lng);
      if (!l) throw new Error('No route loaded');
      loc = { ...l, lat, lng };
    }
    const { days } = activeDays();
    const actuals = db.prepare(`SELECT day_number FROM actual_days`).all()
      .map((a) => a.day_number);
    const lastActual = actuals.length ? Math.max(...actuals) : 0;
    // Today = first un-ridden day whose stretch contains (or is ahead of) us.
    const today = days.find((d) => d.day_number > lastActual && loc.mile < d.end_mile - 0.5)
      ?? days.find((d) => d.day_number > lastActual) ?? null;
    const upcoming = upcomingStmt.all(loc.mile + 0.05, loc.mile + 45).map((u) => ({
      id: u.id, category: u.category_id, name: u.name, brand: u.brand,
      routeMile: r1(u.route_mile), milesAhead: r1(u.route_mile - loc.mile),
      offRouteMi: r2(u.off_route_mi), wifiStatus: u.wifi_status,
      lat: u.lat, lng: u.lng, address: u.address, phone: u.phone,
      website: u.website, hours: u.hours,
    }));
    // Notes you're inside right now, or will hit within 45 mi.
    const notesAhead = db.prepare(
      `SELECT * FROM route_notes
       WHERE end_mile >= ? AND start_mile <= ?
       ORDER BY start_mile LIMIT 8`
    ).all(loc.mile, loc.mile + 45).map((n) => ({
      id: n.id, kind: n.kind, title: n.title, detail: n.detail,
      startMile: r1(n.start_mile), endMile: r1(n.end_mile),
      milesAhead: n.start_mile <= loc.mile ? 0 : r1(n.start_mile - loc.mile),
      active: n.start_mile <= loc.mile && n.end_mile >= loc.mile,
      source: n.source, confidence: n.confidence,
    }));
    return {
      mile: r1(loc.mile), offRouteMi: r2(loc.offMi),
      lat: loc.lat, lng: loc.lng,
      nearPlace: nameNearMile(loc.mile),
      totalMiles: r1(totalMiles),
      notesAhead,
      day: today ? {
        dayNumber: today.day_number, endName: today.end_name,
        endMile: r1(today.end_mile), milesToEnd: r1(Math.max(0, today.end_mile - loc.mile)),
        overnightName: today.overnight_name,
      } : null,
      upcoming,
    };
  }

  // ---- Elevation (brief §17): per-day gain/loss + profile from sampled points.
  // Rider notes overlapping a day's mile range (brief §18: the route is not
  // just geometry — ferries, detours, and hard roads are part of the plan).
  const notesStmt = db.prepare(
    `SELECT * FROM route_notes WHERE start_mile <= ? AND end_mile >= ?
     ORDER BY start_mile`
  );

  const elevStmt = db.prepare(
    `SELECT mile, elevation_m FROM route_points
     WHERE elevation_m IS NOT NULL AND mile BETWEEN ? AND ? ORDER BY mile`
  );

  function elevationForRange(startMile, endMile) {
    const pts = elevStmt.all(startMile, endMile);
    if (pts.length < 3) return null;
    // Light smoothing so 10m-DEM noise doesn't inflate gain totals.
    const sm = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)].elevation_m;
      const b = p.elevation_m;
      const c = pts[Math.min(pts.length - 1, i + 1)].elevation_m;
      return { mile: p.mile, m: (a + b + c) / 3 };
    });
    let gainM = 0, lossM = 0;
    for (let i = 1; i < sm.length; i++) {
      const d = sm[i].m - sm[i - 1].m;
      if (d > 0) gainM += d; else lossM -= d;
    }
    return {
      gainFt: Math.round(gainM * 3.28084),
      lossFt: Math.round(lossM * 3.28084),
      minFt: Math.round(Math.min(...sm.map((p) => p.m)) * 3.28084),
      maxFt: Math.round(Math.max(...sm.map((p) => p.m)) * 3.28084),
      profile: sm.map((p) => [r1(p.mile), Math.round(p.m * 3.28084)]),
    };
  }

  return {
    totalMiles, pointAtMile, nameNearMile, suggestEndpoints,
    autoPlan, planResponse, recordActual, replanPreview, replanApply,
    editDayEnd, splitDay, mergeDays, completeDay, unlockDay, fitToDates,
    dayItinerary, stopCandidates, addStop, updateStop, removeStop, setDayStart,
    proposeDayItinerary, autoItineraries, previewAutoPlan,
    locate, positionInfo, elevationForRange, activeDays,
  };
}

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
