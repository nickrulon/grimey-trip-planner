// Trip-plan engine: day splitting, resource-aware endpoint suggestions,
// actual-day recording, and anchor-based replanning (brief §12–§16).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';
import { makeDaylight, fmtClock, fmtDur } from './daylight.mjs';
import { venueScore, clock12 } from './shared.mjs';


// Bundlers that emit CJS leave import.meta.url empty; fall back to the process
// working directory so this module can be bundled for serverless.
function moduleDir(metaUrl, fallbackSub) {
  try {
    return path.dirname(fileURLToPath(metaUrl));
  } catch {
    return path.join(process.cwd(), fallbackSub);
  }
}

// Same hazard as the camping data: on a serverless bundle the module cannot
// infer its root from cwd alone, and a miss here degrades day names to
// "Mile 913" instead of failing loudly. Pick the root that actually has the
// route data in it.
const root = (() => {
  const probe = path.join('data', 'route', 'waypoints.json');
  const roots = [
    path.resolve(moduleDir(import.meta.url, 'server'), '..'),
    process.cwd(),
    process.env.LAMBDA_TASK_ROOT,
    '/var/task',
    path.resolve(process.cwd(), '..'),
  ];
  for (const r of roots) {
    if (!r) continue;
    try { if (fs.existsSync(path.join(r, probe))) return r; } catch { /* next */ }
  }
  return roots[0];
})();

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
  const daylight = makeDaylight(db, (k) => settingStmt.get(k)?.value);

  // Where the ride actually begins. The rider may be dropped off somewhere
  // other than route mile 0, and that is a schedule fact, not a route edit:
  // the route, its resources, notes and camping research all stay anchored to
  // the same miles — only the plan's first day moves.
  function tripStartMile() {
    const v = Number(settingStmt.get('tripStartMile')?.value);
    return Number.isFinite(v) && v >= 0 && v < totalMiles ? v : 0;
  }
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

  /**
   * How far day N is allowed to run. The rider's ceiling is not one number:
   * weekdays carry a work block, weekends do not, so a Saturday may legitimately
   * be longer than a Tuesday. Everything that judges a day's length — the
   * planner, manual endpoint edits, merges, the readiness chips — has to ask
   * this, or a perfectly legal weekend gets flagged as over-cap against the
   * weekday number.
   */
  function weekendMiles(overrides = {}) {
    const v = overrides.weekendMaxMiles ?? Number(settingStmt.get('weekendMaxMiles')?.value);
    return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
  }

  /**
   * The distance the rider will never exceed, any day of the week. This is ONE
   * number: "I don't ride more than 65" is a statement about the rider, not
   * about the calendar. Only the daily AIM changes between weekdays and
   * weekends (see targetForDayNumber) — keeping the two apart is what lets a
   * weekday stretch two miles to reach a real bed instead of stopping short of
   * one and burning a whole extra day.
   */
  function capForDayNumber(dayNumber, overrides = {}) {
    const weekday = dayShape(overrides).maxMiles;
    return Math.max(weekday, weekendMiles(overrides) ?? weekday);
  }

  /** What day N should AIM for: the weekday figure, or the weekend one. */
  function targetForDayNumber(dayNumber, overrides = {}) {
    const weekday = dayShape(overrides).maxMiles;
    const planStartDate = settingStmt.get('startDate')?.value ?? null;
    if (!planStartDate || dayNumber == null) return weekday;
    if (isWorkday(dateForDay(planStartDate, dayNumber))) return weekday;
    return weekendMiles(overrides) ?? weekday;
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
  // Every segment that carries no recon-leg town list needs its state seeded
  // here, or stateAtMile silently carries the PREVIOUS state forward across it.
  // That is how a 2026-10 reroute (st-az replacing st-az-w) put 400 miles of
  // Arizona under New Mexico's label and its camping rules.
  const OSM_SEG_STATE = {
    'st-fl': 'FL', 'st-al': 'AL', 'st-ms': 'MS', 'st-la': 'LA', 'st-la-w': 'LA',
    'st-tx': 'TX', 'st-nm': 'NM', 'st-az': 'AZ', 'st-az-w': 'AZ', 'st-ca': 'CA',
    'sd-la': 'CA',
  };
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

  // ---- Town/state for a REAL POINT (not a route mile). A motel 3 miles off
  // route belongs to the town it actually sits in, which is not always the
  // town nearest its route mile. Used to complete addresses for hand-off to
  // Apple/Google Maps and for anything the rider might read aloud on a phone.
  const placePts = db.prepare(
    `SELECT name, place_type, lat, lng FROM route_places`
  ).all();
  const PLACE_WEIGHT = { city: 3, town: 2, village: 1 };

  function townNearPoint(lat, lng) {
    if (lat == null || lng == null) return null;
    let best = null, bestScore = -Infinity;
    for (const p of placePts) {
      const d = haversineMi([lng, lat], [p.lng, p.lat]);
      if (d > 12) continue;
      // Distance dominates; size only breaks near-ties.
      const score = (PLACE_WEIGHT[p.place_type] ?? 1) * 0.6 - d;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best?.name ?? null;
  }

  /** { town, state } for a resource, from its own coordinates. */
  function placeOf(lat, lng, routeMile) {
    return {
      town: townNearPoint(lat, lng) ?? (routeMile != null ? nameNearMile(routeMile) : null),
      state: routeMile != null ? stateAtMile(routeMile) : null,
    };
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
    `SELECT id, name, route_mile FROM resources WHERE category_id IN ('campground','hotel')
     AND status='active' AND off_route_mi <= 5
     AND route_mile > ? AND route_mile <= ? ORDER BY route_mile LIMIT 1`
  );
  const wifiNearStmt = db.prepare(
    `SELECT COUNT(*) n FROM resources WHERE category_id='wifi_work'
     AND route_mile BETWEEN ? AND ? AND off_route_mi <= 2`
  );

  // Elevation prefix sums, built once. The anchor search asks for the climb of
  // thousands of candidate day-ranges; rescanning and re-smoothing the route
  // for each one dominated planning time (~2s locally, ~9s serverless, against
  // a 10s platform timeout). One pass up front makes each query two binary
  // searches. Smoothing is global rather than per-range, which also stops a
  // day's gain from shifting slightly depending on where the range was cut.
  const elevPrefix = (() => {
    const rows = db.prepare(
      `SELECT mile, elevation_m FROM route_points
       WHERE elevation_m IS NOT NULL ORDER BY mile`
    ).all();
    const n = rows.length;
    const miles = new Float64Array(n);
    const cumGain = new Float64Array(n);
    if (n < 3) return { miles, cumGain, n };
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = rows[Math.max(0, i - 1)].elevation_m;
      const c = rows[Math.min(n - 1, i + 1)].elevation_m;
      sm[i] = (a + rows[i].elevation_m + c) / 3;
      miles[i] = rows[i].mile;
    }
    for (let i = 1; i < n; i++) {
      const d = sm[i] - sm[i - 1];
      cumGain[i] = cumGain[i - 1] + (d > 0 ? d : 0);
    }
    return { miles, cumGain, n };
  })();

  function elevIndexAt(mile) {
    const { miles, n } = elevPrefix;
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (miles[mid] < mile) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Climb in feet between two miles, O(log n). */
  function gainFtBetween(fromMile, toMile) {
    if (elevPrefix.n < 3) return null;
    const i = elevIndexAt(fromMile), j = elevIndexAt(toMile);
    if (j <= i) return 0;
    return Math.round((elevPrefix.cumGain[j] - elevPrefix.cumGain[i]) * 3.28084);
  }

  // Effort miles = flat-equivalent distance. A 45-mi day with 2,000 ft of climb
  // costs about the same as a 65-mi day on the Gulf Coast, which is exactly the
  // trade the rider makes in their legs.
  function effortMiles(fromMile, toMile) {
    const gain = gainFtBetween(fromMile, toMile);
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
    // Weekends carry no desk time, so they can absorb the long miles the
    // working days give up. This split applies whenever a weekend ceiling is
    // set — it is a statement about the rider's week, not about whether the
    // planner is also placing work stops for them.
    // The season-blind fallback: a nominal 05:30-to-arriveBy window less the
    // desk time. Used only when the daylight engine cannot answer.
    let weekdayTarget = maxMiles;
    if (workAware) {
      const ws = workSettings();
      const rideable = toMin(ws.arriveBy) - toMin('05:30') - ws.minutes;
      weekdayTarget = Math.max(minMiles, Math.min(maxMiles, (rideable / 60) * ridingSpeed()));
    }
    // ...but the window that actually governs a working day is the daylight
    // left over at that date and that place, and it shrinks hard: the same
    // 7.5 h of desk time leaves ~5 h of light in east Texas in early October
    // and under 4 h in Arizona in mid-November. A plan built on the nominal
    // window quietly promises miles the rider cannot ride once the clocks
    // turn, so ask the daylight engine for the real day.
    const weekdayTargetAt = (date, mile) => {
      if (!workAware) return maxMiles;
      try {
        const m = daylight.dayModel({
          date, startMile: mile, endMile: mile, speedMph: ridingSpeed(),
        });
        if (m && Number.isFinite(m.usableH) && m.usableH > 0) {
          return Math.max(minMiles, Math.min(maxMiles, m.usableH * ridingSpeed()));
        }
      } catch { /* fall through to the nominal window */ }
      return weekdayTarget;
    };
    const targetFor = (n, mile) => {
      if (!planStartDate) return weekdayTarget;
      const date = dateForDay(planStartDate, n);
      return isWorkday(date)
        ? weekdayTargetAt(date, mile)
        : (weekendMiles(opts) ?? weekdayTarget);
    };
    const ceilingFor = (n) => capForDayNumber(n, opts);
    // An explicit effort target overrides the per-day ceiling; otherwise each
    // day aims at its own cap, so weekends stretch and weekdays do not.
    const explicitEffort = opts.effortTarget
      ?? (() => {
        const v = Number(settingStmt.get('effortTargetMiles')?.value);
        return Number.isFinite(v) && v > 0 ? v : null;
      })();

    const days = [];
    let from = opts.startMile ?? tripStartMile(), dayNum = opts.startDayNumber ?? 1;
    let guard = 0;

    while (totalMiles - from > targetFor(dayNum, from) && guard++ < 400) {
      const maxMiles = ceilingFor(dayNum);   // hard limit on the search
      const target = targetFor(dayNum, from); // what this day aims for
      effortTarget = explicitEffort ?? target;
      // Aim at whatever distance is expected to cost effortTarget here: on flat
      // ground that is the target, in the mountains it is a good deal less.
      let aim = target;
      for (let i = 0; i < 3; i++) {
        const probe = Math.min(from + aim, totalMiles);
        const { effort, miles } = effortMiles(from, probe);
        if (!miles || effort <= 0) break;
        const scaled = aim * (effortTarget / effort);
        aim = Math.max(minMiles, Math.min(target, (aim + scaled) / 2));
      }

      // Search for a bed NEAR the day's target, and only near it. Widening
      // the hunt until something turns up is what quietly turns a 55-mile
      // plan into a 39-mile one: in rural stretches the nearest motel can be
      // 20 miles short, and taking it costs a whole extra day. If nothing sits
      // close to the target, the day runs its full distance and is flagged
      // no_anchor — an honest "you still need a bed here" the rider can solve,
      // rather than a silently shortened day.
      let picked = null;
      for (const w of [10, 18]) {
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
        // Nothing to sleep at around the target. Reach PAST it for the next
        // real bed — but never past the ceiling. Halving the distance to that
        // bed (the old behaviour) turned a 56-mile day into two 28-mile days
        // and quietly cost a day of the trip every time it fired.
        const reach = nextAnchorStmt.get(from + aim, Math.min(from + maxMiles, totalMiles));
        if (reach) {
          end = reach.route_mile;
          endName = nameNearMile(end);
          overnightId = reach.id;
        } else {
          end = Math.min(from + target, totalMiles);
          endName = nameNearMile(end);
          flags.push('no_anchor');
        }
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
      overnight_resource_id, status, flags, notes,
      rest, lodging_cost, misc_cost, overnight_camp_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const deactivate = db.prepare(`UPDATE plan_revisions SET active=0 WHERE active=1`);

  // Costs ride with the CHOICE, not the day number: when a new revision keeps
  // an overnight (same resource / camp spot / end mile), its recorded cost
  // follows it. A rebuilt day with a different bed honestly starts at no cost.
  function carryCosts(days) {
    const { days: prev } = activeDays();
    if (!prev.length) return days;
    return days.map((d) => {
      if (d.lodging_cost != null || d.misc_cost != null || d.overnight_camp_id != null) return d;
      const match = prev.find((p) =>
        (d.overnight_resource_id && p.overnight_resource_id === d.overnight_resource_id) ||
        (p.overnight_camp_id && Math.abs(p.end_mile - d.end_mile) < 0.5) ||
        (!d.overnight_resource_id && Math.abs(p.end_mile - d.end_mile) < 0.5)
      );
      if (!match) return d;
      return {
        ...d,
        lodging_cost: match.lodging_cost ?? null,
        misc_cost: match.misc_cost ?? null,
        overnight_camp_id: d.overnight_resource_id ? null : match.overnight_camp_id ?? null,
      };
    });
  }

  const saveRevision = db.transaction((reason, days) => {
    const carried = carryCosts(days);
    deactivate.run();
    const rev = insertRev.run(new Date().toISOString(), reason);
    for (const d of carried) {
      insertDay.run(
        rev.lastInsertRowid, d.day_number, d.start_mile, d.end_mile,
        d.start_name, d.end_name, d.overnight_resource_id,
        d.status ?? 'planned', JSON.stringify(d.flags ?? []), d.notes ?? null,
        d.rest ? 1 : 0, d.lodging_cost ?? null, d.misc_cost ?? null,
        d.overnight_camp_id ?? null
      );
    }
    return rev.lastInsertRowid;
  });

  // Roll back = copy an old revision forward as a NEW active revision, so
  // history stays append-only and "undo the undo" is always possible.
  function activateRevision({ revisionId }) {
    const rev = db.prepare(`SELECT * FROM plan_revisions WHERE id = ?`).get(revisionId);
    if (!rev) throw new Error(`No revision #${revisionId}`);
    const days = db.prepare(`SELECT * FROM planned_days WHERE revision_id = ? ORDER BY day_number`)
      .all(revisionId)
      .map((d) => ({ ...d, flags: JSON.parse(d.flags || '[]') }));
    const newId = saveRevision(`rollback to rev #${revisionId} (${rev.reason})`, days);
    geomCache.clear();
    return { ok: true, revisionId: newId, dayCount: days.length };
  }

  // Build without saving, so the rider can compare schedules before committing.
  function previewAutoPlan(opts = {}) {
    const lastDone = db.prepare(`SELECT * FROM actual_days ORDER BY day_number DESC LIMIT 1`).get();
    const startMile = lastDone ? lastDone.end_mile : tripStartMile();
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
    let startMile = opts.startMile ?? tripStartMile();
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

  /**
   * Inverse of rideMinutes: the mile reached after N minutes of riding from
   * `fromMile`. Effort miles make this non-linear (a climb eats minutes), so
   * binary-search it rather than multiplying by speed.
   */
  function mileAfterRideMinutes(fromMile, minutes, speed = ridingSpeed()) {
    if (!(minutes > 0)) return fromMile;
    let lo = fromMile, hi = Math.min(totalMiles, fromMile + (minutes / 60) * speed * 1.05 + 1);
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (rideMinutes(fromMile, mid, speed) < minutes) lo = mid; else hi = mid;
    }
    return r1((lo + hi) / 2);
  }

  /**
   * A break: time off the bike that needs no venue. Anchored to a route mile
   * like every other stop (a break happens somewhere), but the rider states it
   * in the units they actually think in — "after two hours of riding".
   */
  function addBreak({ dayNumber, afterRideMin, afterMiles, atMile, dwellMin = 30, note }) {
    const { days } = activeDays();
    const day = days.find((d) => d.day_number === Number(dayNumber));
    if (!day) throw new Error(`No day ${dayNumber}`);
    const speed = ridingSpeed();

    // Breaks stack on each other — "2 hours, then 3 hours" is two calls — but
    // they stack independently of the WORK stop. Otherwise the first break of a
    // workday would jump past lunch and land in the afternoon, which is never
    // what "45 minutes in" means.
    const priorBreaks = breaksStmt.all(day.start_mile, day.end_mile);
    const lastMile = priorBreaks.length
      ? Math.max(day.start_mile, ...priorBreaks.map((s) => s.route_mile))
      : day.start_mile;

    let mile;
    if (atMile != null) mile = Number(atMile);
    else if (afterMiles != null) mile = lastMile + Number(afterMiles);
    else if (afterRideMin != null) mile = mileAfterRideMinutes(lastMile, Number(afterRideMin), speed);
    else throw new Error('Say when: afterRideMin, afterMiles, or atMile');

    if (!Number.isFinite(mile)) throw new Error('Could not work out where that break lands');
    if (mile <= day.start_mile + 0.05 || mile >= day.end_mile - 0.05) {
      throw new Error(
        `That break lands at mile ${r1(mile)}, outside day ${dayNumber} (mi ${r1(day.start_mile)}–${r1(day.end_mile)})`
      );
    }
    const dwell = Math.max(5, Math.round(Number(dwellMin) || 30));
    const info = db.prepare(
      `INSERT INTO planned_stops (route_mile, resource_id, name, category, off_route_mi, dwell_min, kind, notes)
       VALUES (?, NULL, ?, NULL, NULL, ?, 'break', ?)`
    ).run(mile, note || 'Break', dwell, note ?? null);
    return { ok: true, id: info.lastInsertRowid, routeMile: r1(mile), dwellMin: dwell };
  }

  /** Every break inside a day, in ride order. */
  const breaksStmt = db.prepare(
    `SELECT id, route_mile, name, dwell_min, notes FROM planned_stops
     WHERE kind='break' AND route_mile > ? AND route_mile < ? ORDER BY route_mile`
  );
  function breaksFor(day) {
    return breaksStmt.all(day.start_mile, day.end_mile).map((b) => ({
      id: b.id, name: b.name || 'Break',
      routeMile: r1(b.route_mile), dwellMin: b.dwell_min, note: b.notes,
    }));
  }

  // ---- canvas marks: the rider's own fixed appointments ----------------------
  // A mark is time-anchored: it does NOT move when roll-out moves. That is the
  // entire difference from a break, and it is why marks are a separate table
  // and a separate array on the canvas payload — `blocks` is derived state the
  // planner recomputes and the UI slides, so anything living there would drift.

  /**
   * The colour vocabulary. The DB stores the TOKEN NAME, never a hex value, so
   * a future palette change updates every existing mark instead of stranding
   * them. The first five deliberately match TIER_META in the camping code, so
   * the app keeps one colour vocabulary. Mirrored in web/src/Today.tsx.
   */
  const MARK_COLORS = ['slate', 'red', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];

  // Wire-level guards. '' / null / booleans are the classic ways a half-filled
  // form leaks through Number() as midnight or mile 0, so they are refused
  // outright rather than coerced.
  const missing = (v) => v == null || v === '' || typeof v === 'boolean';
  const minuteOf = (v, what) => {
    if (missing(v)) throw new Error(`${what} time is missing`);
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 1439) throw new Error(`${what} time must be a real time of day`);
    return n;
  };
  const textOf = (v, what, max) => {
    if (v == null) return '';
    if (typeof v !== 'string') throw new Error(`${what} must be text`);
    return v.slice(0, max).trim();   // slice THEN trim, so a cut never leaves trailing spaces
  };

  function markFields({ scope, dayNumber, routeMile, label, shape, color, startMin, endMin, notes }) {
    if (scope != null && scope !== 'day' && scope !== 'mile') throw new Error(`Unknown scope "${scope}"`);
    if (shape != null && shape !== 'block' && shape !== 'line') throw new Error(`Unknown shape "${shape}"`);
    if (color != null && !MARK_COLORS.includes(color)) {
      throw new Error(`Unknown colour "${color}" — one of ${MARK_COLORS.join(', ')}`);
    }
    const sc = scope ?? 'day';
    const sh = shape ?? 'block';
    const col = color ?? 'slate';
    const text = textOf(label, 'Label', 80);
    if (!text) throw new Error('A mark needs a label — "Ferry", "dentist", "call Mum"');

    const s = minuteOf(startMin, 'Start');
    let e = null;
    if (sh === 'block') {
      if (missing(endMin)) throw new Error('A block mark needs an end time');
      e = minuteOf(endMin, 'End');
      if (e <= s) throw new Error('A block mark has to end after it starts');
    }

    // Exactly one anchor, decided by the scope — never both, never neither.
    let dn = null;
    let mile = null;
    const { days } = activeDays();
    if (sc === 'day') {
      if (missing(dayNumber)) throw new Error('dayNumber required for a day-scoped mark');
      dn = Math.round(Number(dayNumber));
      if (!Number.isFinite(dn) || dn < 1) throw new Error('dayNumber required for a day-scoped mark');
      if (!days.some((d) => d.day_number === dn)) throw new Error(`No day ${dn}`);
    } else {
      if (missing(routeMile)) throw new Error('routeMile required for a mile-scoped mark');
      mile = Number(routeMile);
      // Only a mile the plan actually rides can ever show a mark: this trip
      // starts at mile 50, not 0, and finishes where the last day ends.
      const lo = days.length ? days[0].start_mile : 0;
      const hi = days.length ? days[days.length - 1].end_mile : totalMiles;
      if (!Number.isFinite(mile) || mile < lo - 0.05 || mile > hi + 0.05) {
        throw new Error(`routeMile must be between ${r1(lo)} and ${r1(hi)} — the miles this plan rides`);
      }
      mile = r1(mile);
    }

    return {
      scope: sc, day_number: dn, route_mile: mile,
      label: text, shape: sh, color: col,
      start_min: s, end_min: e,
      notes: textOf(notes, 'Note', 400) || null,
    };
  }

  const markRow = (m) => ({
    id: m.id, scope: m.scope, label: m.label, shape: m.shape, color: m.color,
    startMin: m.start_min, endMin: m.end_min,
    notes: m.notes, routeMile: m.route_mile == null ? null : r1(m.route_mile),
    dayNumber: m.day_number,
  });

  function addMark(body = {}) {
    const f = markFields(body);
    const info = db.prepare(
      `INSERT INTO canvas_marks
         (scope, day_number, route_mile, label, shape, color, start_min, end_min, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(f.scope, f.day_number, f.route_mile, f.label, f.shape, f.color,
      f.start_min, f.end_min, f.notes);
    return { ok: true, id: info.lastInsertRowid, mark: markRow({ id: info.lastInsertRowid, ...f }) };
  }

  function updateMark(body = {}) {
    const id = Number(body.id);
    if (!Number.isFinite(id)) throw new Error('id required');
    const cur = db.prepare(`SELECT * FROM canvas_marks WHERE id = ?`).get(id);
    if (!cur) throw new Error(`No mark ${id}`);
    // Anything not sent keeps its current value, so the edit form can send a
    // partial patch without silently clearing the other fields.
    const f = markFields({
      scope: body.scope ?? cur.scope,
      dayNumber: body.dayNumber ?? cur.day_number,
      routeMile: body.routeMile ?? cur.route_mile,
      label: body.label ?? cur.label,
      shape: body.shape ?? cur.shape,
      color: body.color ?? cur.color,
      startMin: body.startMin ?? cur.start_min,
      // A block being edited back from a line has no stored end to fall back on.
      endMin: body.endMin ?? cur.end_min,
      notes: body.notes !== undefined ? body.notes : cur.notes,
    });
    db.prepare(
      `UPDATE canvas_marks SET scope=?, day_number=?, route_mile=?, label=?,
              shape=?, color=?, start_min=?, end_min=?, notes=? WHERE id=?`
    ).run(f.scope, f.day_number, f.route_mile, f.label, f.shape, f.color,
      f.start_min, f.end_min, f.notes, id);
    return { ok: true, mark: markRow({ id, ...f }) };
  }

  function removeMark({ id }) {
    const n = Number(id);
    if (!Number.isFinite(n)) throw new Error('id required');
    const info = db.prepare(`DELETE FROM canvas_marks WHERE id = ?`).run(n);
    return { ok: true, removed: info.changes };
  }

  const marksByDayStmt = db.prepare(
    `SELECT * FROM canvas_marks WHERE scope='day' AND day_number = ? ORDER BY start_min`
  );
  const marksByMileStmt = db.prepare(
    `SELECT * FROM canvas_marks WHERE scope='mile' AND route_mile >= ? AND route_mile < ?
     ORDER BY start_min`
  );

  /**
   * The marks that belong on one day's canvas: the ones pinned to this day
   * number, plus the ones pinned to a mile this day rides. The mile window is
   * half-open [start, end) so a mark exactly on a day boundary shows once, on
   * the day that starts there; the trip's last day closes its interval, with a
   * hair of slack because stored miles are rounded to 0.1 and the day's end is
   * not. A rest day rides no miles, so it shows only day-scoped marks — a mile
   * mark belongs to whichever riding day actually reaches it.
   *
   * startMile/endMile override the day row's own range. A completed day keeps
   * its PLANNED miles in `planned_days` even after a short day is recorded, so
   * without this a mile-pinned mark shows twice after a replan: once on the day
   * that was actually ridden past it, and again on the day that now covers it.
   */
  function marksFor(day, { isLastDay = false, startMile, endMile } = {}) {
    const s = startMile ?? day.start_mile;
    const e = endMile ?? day.end_mile;
    const hi = isLastDay ? e + 0.05 : e;
    return [...marksByDayStmt.all(day.day_number), ...marksByMileStmt.all(s, hi)]
      .sort((a, b) => a.start_min - b.start_min || a.id - b.id)
      .map(markRow);
  }

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

  /** The daylight model for one planned day, or null before a start date is set. */
  function modelForDay(day, speed = ridingSpeed()) {
    const startDateSetting = settingStmt.get('startDate')?.value ?? null;
    const date = startDateSetting ? dateForDay(startDateSetting, day.day_number) : null;
    if (!date) return null;
    const { effort } = effortMiles(day.start_mile, day.end_mile);
    const times = dayTimes(day.day_number);
    return daylight.dayModel({
      date, startMile: day.start_mile, endMile: day.end_mile,
      effortMi: effort, speedMph: speed,
      departH: times.departH, workStartH: times.workStartH, rideUntilH: times.rideUntilH,
    });
  }

  /**
   * Candidates for the next stop: everything reachable further along, from
   * where you already are (`fromMile`), with how long the ride there takes.
   *
   * With `fromMin` — the clock at the cursor — every candidate also carries an
   * ARRIVAL time, which is the number the rider actually decides on: "Library,
   * 25 mi, 2h20" is far less useful than "arrive 9:47a", because on a workday
   * the question is whether he can be sitting down before the window opens.
   *
   * With `reachMi` the search runs that far past the cursor — past the day's
   * planned end if need be, but never past the next day's endpoint, which is
   * the farthest a day can legally end. Without it, the old behaviour: the day
   * as planned. In a builder the endpoint is an OUTCOME, so clamping to it
   * would make the last leg unplannable.
   */
  function stopCandidates({
    dayNumber, fromMile, fromMin = null, reachMi = null, behindMi = 0,
    maxOffRouteMi = 4, cats, limit = 40,
  }) {
    const { days } = activeDays();
    const day = days.find((d) => d.day_number === dayNumber);
    if (!day) throw new Error(`No day ${dayNumber}`);
    const speed = ridingSpeed();
    const from = fromMile ?? day.start_mile;
    // behindMi lets the builder see "next door" — the library beside the
    // McDonald's you are sitting in is 0.2 mi back along the route, and going
    // back to it is a real thing a day does. Such a stop rides nothing.
    const back = Math.max(0, Number(behindMi) || 0);
    const lo = Math.max(day.start_mile + 0.05, back > 0 ? from - back : from + 0.05);
    const next = days.find((d) => d.day_number === day.day_number + 1) ?? null;
    // The farthest a day can legally end: the next day's own endpoint, or the
    // end of the route. One definition, returned so callers never re-derive it.
    const farthest = next ? Math.min(totalMiles, next.end_mile - 0.05) : totalMiles;
    const hi = reachMi != null ? Math.min(from + Number(reachMi), farthest) : day.end_mile - 0.05;
    const off = Number(maxOffRouteMi);
    const maxOff = Number.isFinite(off) && off > 0 ? off : 4;
    const frame = { speedMph: speed, fromMile: r1(from), reachTo: r1(hi), farthestMile: r1(farthest) };
    if (hi <= lo) return { candidates: [], ...frame };
    const catList = cats && cats.length ? cats : ['wifi_work', 'campground', 'hotel'];
    const rows = db.prepare(
      `SELECT id, category_id, name, brand, route_mile, off_route_mi, address,
              phone, website, hours, wifi_status, lat, lng
       FROM resources
       WHERE status='active' AND route_mile BETWEEN ? AND ?
         AND category_id IN (${catList.map(() => '?').join(',')})
         AND off_route_mi <= ?
       ORDER BY route_mile LIMIT ?`
    ).all(lo, hi, ...catList, maxOff, limit * 3);

    // The clock the arrival is judged against: when work opens, when the rider
    // said they would stop riding. Only meaningful once a start date exists.
    const model = fromMin != null ? modelForDay(day, speed) : null;
    const workOpen = model?.workday && model.work ? Math.round(model.work.localStart * 60) : null;
    const rideTo = model ? Math.round(model.rideTo * 60) : null;

    const out = rows.map((r) => {
      const behind = r.route_mile <= from;
      const rideMin = behind ? 0 : Math.round(rideMinutes(from, r.route_mile, speed));
      const arriveMin = fromMin != null ? Math.round(Number(fromMin) + rideMin) : null;
      return {
        resourceId: r.id, name: r.name, brand: r.brand, category: r.category_id,
        routeMile: r1(r.route_mile), offRouteMi: r2(r.off_route_mi),
        rideMiles: behind ? 0 : r1(r.route_mile - from),
        rideMinutes: rideMin,
        behind,
        wifiStatus: r.wifi_status, address: r.address, phone: r.phone,
        website: r.website, hours: r.hours, lat: r.lat, lng: r.lng,
        // the headline number on a builder pin
        arriveMin,
        arriveClock: arriveMin != null ? clock12(arriveMin) : null,
        beforeWorkOpen: arriveMin != null && workOpen != null ? arriveMin <= workOpen : null,
        minsLateForWork: arriveMin != null && workOpen != null && arriveMin > workOpen ? arriveMin - workOpen : null,
        // minutes of riding left before the time the rider said they would stop
        lightLeftMin: arriveMin != null && rideTo != null ? rideTo - arriveMin : null,
        // one venue vocabulary for the whole app (see shared.mjs)
        score: r.category_id === 'wifi_work' ? r1(venueScore(r) - r.off_route_mi * 1.5) : r1(-r.off_route_mi * 1.5),
      };
    });
    // Prefer close-to-route options, but keep the list in ride order.
    out.sort((a, b) => a.rideMinutes - b.rideMinutes || a.offRouteMi - b.offRouteMi);
    return { candidates: out.slice(0, limit), ...frame, workOpenMin: workOpen, rideToMin: rideTo };
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
    const row = db.prepare(`SELECT * FROM planned_stops WHERE id = ?`).get(id);
    db.prepare(`DELETE FROM planned_stops WHERE id = ?`).run(id);
    // Dropping a combo puts its minutes back in the chair, so the work day
    // still adds up to a work day.
    if (row?.kind === 'combo') {
      const { days } = activeDays();
      const day = days.find((d) => row.route_mile > d.start_mile && row.route_mile < d.end_mile);
      if (day) shiftSeatedWork(day, row.dwell_min);
    }
    return { ok: true };
  }

  function setDayStart({ dayNumber, startTime }) {
    db.prepare(
      `INSERT INTO day_plans (day_number, start_time) VALUES (?,?)
       ON CONFLICT(day_number) DO UPDATE SET start_time=excluded.start_time`
    ).run(Number(dayNumber), startTime || null);
    return { ok: true };
  }

  /** Per-day time dials. Passing null for a field restores its default. */
  function setDayTimes({ dayNumber, startTime, workStart, rideUntil }) {
    const n = Number(dayNumber);
    if (!Number.isFinite(n)) throw new Error('dayNumber required');
    const clean = (v) => {
      if (v === undefined) return undefined;
      if (v === null || v === '') return null;
      if (!/^\d{1,2}:\d{2}$/.test(String(v))) throw new Error(`Bad time "${v}" — use HH:MM`);
      return String(v).padStart(5, '0');
    };
    const st = clean(startTime), ws = clean(workStart), ru = clean(rideUntil);
    db.prepare(`INSERT INTO day_plans (day_number) VALUES (?) ON CONFLICT(day_number) DO NOTHING`).run(n);
    db.prepare(
      `UPDATE day_plans SET
         start_time = CASE WHEN ? THEN ? ELSE start_time END,
         work_start = CASE WHEN ? THEN ? ELSE work_start END,
         ride_until = CASE WHEN ? THEN ? ELSE ride_until END
       WHERE day_number = ?`
    ).run(
      st !== undefined ? 1 : 0, st ?? null,
      ws !== undefined ? 1 : 0, ws ?? null,
      ru !== undefined ? 1 : 0, ru ?? null,
      n
    );
    return { ok: true };
  }

  const dayTimesStmt = db.prepare(
    `SELECT start_time, work_start, ride_until FROM day_plans WHERE day_number = ?`
  );
  /** Overrides as local hour floats, for the daylight model. */
  function dayTimes(dayNumber) {
    const row = dayTimesStmt.get(Number(dayNumber)) ?? {};
    const toH = (t) => {
      if (!t) return null;
      const [h, m] = String(t).split(':').map(Number);
      return Number.isFinite(h) ? h + (Number.isFinite(m) ? m / 60 : 0) : null;
    };
    return {
      startTime: row.start_time ?? null,
      workStart: row.work_start ?? null,
      rideUntil: row.ride_until ?? null,
      departH: toH(row.start_time),
      workStartH: toH(row.work_start),
      rideUntilH: toH(row.ride_until),
    };
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
    earliestDepart: '04:30',
    latestDepart: '09:30',
    maxBlockMin: 480,
  };

  function workSettings() {
    const num = (k, d) => {
      const v = Number(settingStmt.get(k)?.value);
      return Number.isFinite(v) && v > 0 ? v : d;
    };
    const str = (k, d) => settingStmt.get(k)?.value || d;
    // The owed minutes default to the ET work window's length, so "9:00–4:30
    // Eastern" is the single source of truth for how much work a day owes.
    const et = daylight.workWindowET();
    const etMinutes = Math.round((et.endH - et.startH) * 60);
    return {
      minutes: num('workMinutesPerDay', etMinutes > 0 ? etMinutes : WORK_DEFAULTS.minutes),
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
              `INSERT INTO planned_stops (route_mile, resource_id, name, category, off_route_mi, dwell_min, kind, notes)
               VALUES (?,?,?,?,?,?,?,?)`
            ).run(sp.routeMile, sp.resourceId, sp.name, sp.category, sp.offRouteMi,
              sp.dwellMin, r.workday ? 'work' : null, r.workday ? 'work stop (auto)' : null);
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
    // What the rider still has to ride, and how many days are left to do it
    // in. Averaged over the WHOLE trip these numbers quietly lie once days are
    // in the bank: a strong first week would keep telling you to ride harder.
    const lastDone = db.prepare(`SELECT * FROM actual_days ORDER BY day_number DESC LIMIT 1`).get();
    const doneDays = lastDone ? lastDone.day_number : 0;
    const fromMile = lastDone ? lastDone.end_mile : tripStartMile();
    const remainingMiles = Math.max(0, totalMiles - fromMile);
    info.remainingMiles = r1(remainingMiles);
    info.daysRidden = doneDays;
    const plannedDaysLeft = Math.max(0, plannedDays - doneDays);
    info.plannedAvgMiles = plannedDaysLeft > 0 ? r1(remainingMiles / plannedDaysLeft) : null;
    info.weekendMaxMiles = r1(weekendMiles() ?? dayShape().maxMiles);
    if (arriveDate) {
      // Inclusive: depart Sept 21, arrive Sept 21 = one day of riding.
      const availableDays = daysBetween(startDate, arriveDate) + 1;
      info.availableDays = availableDays;
      info.slackDays = availableDays - plannedDays;
      const calendarDaysLeft = Math.max(0, availableDays - doneDays);
      info.calendarDaysLeft = calendarDaysLeft;
      info.requiredAvgMiles = calendarDaysLeft > 0 ? r1(remainingMiles / calendarDaysLeft) : null;
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
    const startMile = lastDone ? lastDone.end_mile : tripStartMile();
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
    // Day numbers are an internal index; out on the road the rider thinks in
    // dates. Label the badges with the date and carry the number alongside for
    // anything that still keys on it.
    const planStart = settingStmt.get('startDate')?.value ?? null;
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const badgeLabel = (n) => {
      if (!planStart) return `D${n}`;
      const iso = dateForDay(planStart, n);
      if (!iso) return `D${n}`;
      const [, m, dd] = iso.split('-');
      return `${MON[Number(m) - 1]} ${Number(dd)}`;
    };
    const boundFeatures = days.map((d) => {
      const p = pointAtMile(d.start_mile);
      return {
        type: 'Feature',
        properties: {
          label: badgeLabel(d.day_number),
          date: planStart ? dateForDay(planStart, d.day_number) : null,
          dayNumber: d.day_number,
        },
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

  // The day's work anchor: the stop explicitly marked kind='work', or (for
  // plans made before work stops were first-class) the longest wi-fi sit.
  const workStopStmt = db.prepare(
    `SELECT s.*, r.wifi_status, r.hours AS res_hours, r.address, r.phone, r.website,
            r.lat, r.lng, r.brand
     FROM planned_stops s LEFT JOIN resources r ON r.id = s.resource_id
     WHERE s.route_mile > ? AND s.route_mile < ?
     ORDER BY (s.kind = 'work') DESC,
              (s.category = 'wifi_work' AND s.dwell_min >= 120) DESC,
              s.dwell_min DESC
     LIMIT 1`
  );
  // Every work anchor in the day, in ride order. A day can hold more than one:
  // sit somewhere for the morning, ride on, sit somewhere else for the
  // afternoon. The owed hours are split across them.
  const workStopsStmt2 = db.prepare(
    `SELECT s.*, r.wifi_status, r.hours AS res_hours, r.address, r.phone, r.website,
            r.lat, r.lng, r.brand
     FROM planned_stops s LEFT JOIN resources r ON r.id = s.resource_id
     WHERE s.kind='work' AND s.route_mile > ? AND s.route_mile < ?
     ORDER BY s.route_mile`
  );
  function workStopsFor(d) {
    return workStopsStmt2.all(d.start_mile, d.end_mile).map((s) => {
      const place = placeOf(s.lat, s.lng, s.route_mile);
      return {
        id: s.id, resourceId: s.resource_id, name: s.name, brand: s.brand,
        routeMile: r1(s.route_mile), offRouteMi: r2(s.off_route_mi),
        dwellMin: s.dwell_min, cost: s.cost ?? null,
        wifiStatus: s.wifi_status ?? null, hours: s.res_hours ?? null,
        address: s.address ?? null, phone: s.phone ?? null, website: s.website ?? null,
        lat: s.lat ?? null, lng: s.lng ?? null,
        town: place.town, state: place.state,
      };
    });
  }

  /** Riding while logged in — a meeting taken from the saddle. */
  const combosStmt = db.prepare(
    `SELECT id, route_mile, name, dwell_min, notes FROM planned_stops
     WHERE kind='combo' AND route_mile > ? AND route_mile < ? ORDER BY route_mile`
  );
  function combosFor(d) {
    return combosStmt.all(d.start_mile, d.end_mile).map((c) => ({
      id: c.id, name: c.name || 'Work + bike',
      routeMile: r1(c.route_mile), minutes: c.dwell_min, note: c.notes,
    }));
  }

  /**
   * A stretch ridden while on the clock. Anchored just past whichever work
   * stop it follows, so it sorts into the day between the sit-downs.
   */
  function addCombo({ dayNumber, minutes = 60, afterWorkStopId, name }) {
    const { days } = activeDays();
    const day = days.find((x) => x.day_number === Number(dayNumber));
    if (!day) throw new Error(`No day ${dayNumber}`);
    const mins = Math.round(Number(minutes));
    if (!Number.isFinite(mins) || mins <= 0) throw new Error('How long is the meeting? (minutes)');

    const stops = workStopsFor(day);
    const combos = combosFor(day);
    let anchor;
    if (afterWorkStopId) {
      const s = stops.find((x) => x.id === Number(afterWorkStopId));
      if (!s) throw new Error('That work stop is not on this day');
      anchor = s.routeMile;
    } else {
      // Default: after the last thing already scheduled inside the work day.
      const marks = [...stops.map((s) => s.routeMile), ...combos.map((c) => c.routeMile)];
      anchor = marks.length ? Math.max(...marks) : day.start_mile;
    }
    const mile = Math.min(anchor + 0.02, day.end_mile - 0.05);
    if (mile <= day.start_mile) throw new Error('No room for a combo on this day');
    const info = db.prepare(
      `INSERT INTO planned_stops (route_mile, resource_id, name, category, off_route_mi, dwell_min, kind, notes)
       VALUES (?, NULL, ?, NULL, NULL, ?, 'combo', ?)`
    ).run(mile, name || 'Work + bike', mins, name ?? null);
    // An hour of the work day MOVES onto the bike — it is not extra work. Take
    // the minutes out of the seated blocks (latest first) so the day still
    // owes exactly one work day.
    shiftSeatedWork(day, -mins);
    return { ok: true, id: info.lastInsertRowid, minutes: mins, routeMile: r1(mile) };
  }

  /**
   * Add (or remove) `delta` minutes of seated work across a day's work stops,
   * latest first, never dropping one below half an hour.
   */
  function shiftSeatedWork(day, delta) {
    const stops = workStopsFor(day);
    if (!stops.length) return;
    let left = delta;
    const upd = db.prepare(`UPDATE planned_stops SET dwell_min=? WHERE id=?`);
    if (delta < 0) {
      for (let i = stops.length - 1; i >= 0 && left < 0; i--) {
        const take = Math.min(-left, Math.max(0, stops[i].dwellMin - 30));
        if (take > 0) { upd.run(stops[i].dwellMin - take, stops[i].id); left += take; }
      }
    } else {
      const last = stops[stops.length - 1];
      upd.run(last.dwellMin + delta, last.id);
    }
  }

  function workStopFor(d) {
    const s = workStopStmt.get(d.start_mile, d.end_mile);
    if (!s || (s.kind !== 'work' && !(s.category === 'wifi_work' && s.dwell_min >= 120))) return null;
    const place = placeOf(s.lat, s.lng, s.route_mile);
    return {
      id: s.id, resourceId: s.resource_id, name: s.name, brand: s.brand,
      routeMile: r1(s.route_mile), offRouteMi: r2(s.off_route_mi),
      dwellMin: s.dwell_min, cost: s.cost ?? null,
      wifiStatus: s.wifi_status ?? null, hours: s.res_hours ?? null,
      address: s.address ?? null, phone: s.phone ?? null, website: s.website ?? null,
      lat: s.lat ?? null, lng: s.lng ?? null,
      town: place.town, state: place.state,
    };
  }

  // Readiness: the app's answer to "do I still need to think about this day?"
  // Ordered worst-first; the first issue is the day's headline state.
  const fmtMin = (m) => fmtDur(m / 60);

  /**
   * `extra` is what only a simulated day knows — the Trip list calls this
   * without it and sees exactly the issues it always did:
   *   workCreditMin / owedMin   → 'work_short' when the sit-downs (plus combos)
   *                               do not add up to a work day
   *   missedMarks [{ label }]   → 'mark_missed' per fixed appointment the walk
   *                               reaches too late
   */
  function readinessFor(d, model, workStop, riderNotes, actual, extra = {}) {
    if (actual) return { state: 'done', issues: [] };
    const issues = [];
    const miles = d.end_mile - d.start_mile;
    const rest = !!d.rest || miles < 0.5;
    if (!rest) {
      if (model.status === 'short') issues.push({ kind: 'daylight', label: 'Daylight conflict' });
      else if (model.status === 'tight') issues.push({ kind: 'daylight_tight', label: 'Tight daylight' });
      const flags = JSON.parse(d.flags || '[]');
      if (flags.includes('over_cap')) issues.push({ kind: 'mileage', label: 'Over mileage cap' });
      if (model.workday) {
        if (!workStop) issues.push({ kind: 'work', label: 'Needs work stop' });
        else if (workStop.wifiStatus === 'none') issues.push({ kind: 'work_wifi', label: 'No wi-fi reported at work stop' });
        else if (!workStop.wifiStatus || workStop.wifiStatus === 'unknown') issues.push({ kind: 'work_wifi', label: 'Wi-Fi unverified at work stop' });
        // A stop is chosen, but two hours at a library is not a work day.
        if (workStop && extra.workCreditMin != null && extra.owedMin != null
          && extra.workCreditMin < extra.owedMin - 5) {
          issues.push({
            kind: 'work_short',
            label: `Work day short by ${fmtMin(Math.round(extra.owedMin - extra.workCreditMin))}`,
          });
        }
      }
      for (const m of extra.missedMarks ?? []) issues.push({ kind: 'mark_missed', label: m.label });
    }
    if (!d.overnight_resource_id && !d.overnight_camp_id) {
      issues.push({ kind: 'sleep', label: 'Needs sleep anchor' });
    }
    for (const n of riderNotes) {
      if (['detour', 'ferry', 'no_services', 'caution'].includes(n.kind)) {
        issues.push({ kind: 'route', label: n.title });
        break;
      }
    }
    // Headline = the most consequential issue present, in THIS order — not the
    // first one that happened to be pushed. A missed boat outranks everything.
    const RANK = ['mark_missed', 'daylight', 'mileage', 'work', 'work_short', 'sleep'];
    const worst = RANK.map((k) => issues.find((i) => i.kind === k)).find(Boolean)
      ?? issues[0] ?? null;
    return { state: worst ? worst.kind : 'ready', issues };
  }

  function planResponse() {
    const { rev, days } = activeDays();
    if (!rev) return { revision: null, days: [], geometry: null, totalMiles };
    const startDateSetting = settingStmt.get('startDate')?.value ?? null;
    const speed = ridingSpeed();
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
      const date = startDateSetting ? dateForDay(startDateSetting, d.day_number) : null;
      const { effort } = effortMiles(d.start_mile, d.end_mile);
      const times = dayTimes(d.day_number);
      const model = date ? daylight.dayModel({
        date, startMile: d.start_mile, endMile: d.end_mile,
        effortMi: effort, speedMph: speed,
        departH: times.departH, workStartH: times.workStartH, rideUntilH: times.rideUntilH,
      }) : null;
      const workStop = workStopFor(d);
      const readiness = model
        ? readinessFor(d, model, workStop, riderNotes, a)
        : { state: a ? 'done' : 'unknown', issues: [] };
      return {
        dayNumber: d.day_number,
        date,
        rest: !!d.rest || d.end_mile - d.start_mile < 0.5,
        elevGainFt: elev?.gainFt ?? null, elevLossFt: elev?.lossFt ?? null,
        riderNotes,
        startMile: r1(d.start_mile), endMile: r1(d.end_mile),
        miles: r1(d.end_mile - d.start_mile),
        effortMiles: r1(effort),
        rideTimeMin: Math.round(rideMinutes(d.start_mile, d.end_mile, speed)),
        startName: d.start_name, endName: d.end_name,
        endState: stateAtMile(d.end_mile),
        lodgingCost: d.lodging_cost ?? null,
        miscCost: d.misc_cost ?? null,
        overnightCampId: d.overnight_camp_id ?? null,
        workStop,
        sun: model ? {
          zone: model.zone, workday: model.workday,
          dawn: model.dawn, sunrise: model.sunrise, sunset: model.sunset, dusk: model.dusk,
          work: model.work,
          usableRideMin: Math.round(model.usableH * 60),
          bufferMin: Math.round(model.bufferH * 60),
          fit: model.status,
        } : null,
        readiness,
        overnight: d.overnight_resource_id
          ? { id: d.overnight_resource_id, name: d.overnight_name,
              category: d.overnight_category, offRouteMi: r2(d.overnight_off_mi),
              address: d.overnight_address, phone: d.overnight_phone,
              website: d.overnight_website, hours: d.overnight_hours,
              lat: d.overnight_lat, lng: d.overnight_lng,
              attributes: d.overnight_attrs,
              // Town from the bed's OWN coordinates — a motel 3 mi off route
              // belongs to the town it sits in, not the one nearest its mile.
              ...placeOf(d.overnight_lat, d.overnight_lng, d.overnight_mile),
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
    // Trip-level rollups: readiness counts (the Trip view's headline) and the
    // money picture, both derived from the same canonical days.
    const rollup = { ready: 0, done: 0 };
    for (const d of out) {
      const s = d.readiness?.state ?? 'unknown';
      rollup[s] = (rollup[s] ?? 0) + 1;
    }
    const costTotal = out.reduce(
      (s, d) => s + (d.lodgingCost ?? 0) + (d.miscCost ?? 0) + (d.workStop?.cost ?? 0), 0
    );
    return {
      revision: { id: rev.id, createdAt: rev.created_at, reason: rev.reason },
      days: out, geometry, totalMiles: r1(totalMiles), history,
      schedule: scheduleInfo(out),
      // The route is always 2,972.5 mi; the RIDE is what's left from the
      // rider's real start point.
      tripStartMile: r1(tripStartMile()),
      tripStartName: nameNearMile(tripStartMile()),
      tripMiles: r1(totalMiles - tripStartMile()),
      readinessRollup: rollup,
      costs: {
        total: Math.round(costTotal),
        avgPerDay: out.length ? Math.round(costTotal / out.length) : 0,
      },
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
        if (miles > capForDayNumber(dayNum)) {
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
  /**
   * Flags describe the day as it now stands. An over-cap day the rider chose
   * on purpose is allowed — it is marked, not blocked. Shared with the Today
   * layer so a PREVIEW of a proposed endpoint carries the same flags the save
   * will write.
   */
  function dayFlags(startM, endM, hasAnchor, dayNumber = null) {
    const cap = capForDayNumber(dayNumber);
    const f = [];
    const len = endM - startM;
    if (len > cap + 0.5) f.push('over_cap');
    if (len < DAY_BOUNDS.veryShort) f.push('very_short');
    if (!hasAnchor) f.push('no_anchor');
    return JSON.stringify(f);
  }

  /**
   * Move a day's endpoint (and bed) — the writes only, NO transaction of its
   * own, so a caller that has to change more than one thing atomically (the
   * Day Builder replaces the day's stops in the same breath) can wrap it in
   * one. The WASM database cannot nest transactions, so this split is what
   * makes an atomic save possible on Netlify at all. editDayEnd below is the
   * stand-alone, transactional form.
   */
  function applyDayEnd({ dayNumber, endMile, endName, overnightResourceId, overnightCampId }) {
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
    // A different bed means the old bed's recorded price is stale.
    const sameBed =
      (overnightResourceId ?? null) === (day.overnight_resource_id ?? null) &&
      (overnightCampId ?? null) === (day.overnight_camp_id ?? null);
    db.prepare(
      `UPDATE planned_days SET end_mile=?, end_name=?, overnight_resource_id=?,
         overnight_camp_id=?, flags=?,
         lodging_cost = CASE WHEN ? THEN lodging_cost ELSE NULL END
       WHERE revision_id=? AND day_number=?`
    ).run(endMile, name, overnightResourceId ?? null, overnightCampId ?? null,
      dayFlags(day.start_mile, endMile, !!(overnightResourceId ?? overnightCampId ?? null), dayNumber),
      sameBed ? 1 : 0,
      rev.id, dayNumber);
    if (next) {
      db.prepare(
        `UPDATE planned_days SET start_mile=?, start_name=?, flags=?
         WHERE revision_id=? AND day_number=?`
      ).run(endMile, name,
        dayFlags(endMile, next.end_mile, !!(next.overnight_resource_id ?? next.overnight_camp_id), next.day_number),
        rev.id, next.day_number);
    }
    geomCache.delete(rev.id);
    return {
      ok: true,
      day: { dayNumber, miles: r1(endMile - day.start_mile) },
      next: next ? { dayNumber: next.day_number, miles: r1(next.end_mile - endMile) } : null,
    };
  }

  function editDayEnd(args) {
    return db.transaction(() => applyDayEnd(args))();
  }

  // Per-day money. Sleeping and riding decisions are one decision on a
  // self-funded tour, so cost lives on the plan row, not in a separate ledger.
  function setDayCosts({ dayNumber, lodgingCost, miscCost }) {
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const day = days.find((d) => d.day_number === Number(dayNumber));
    if (!day) throw new Error(`No day ${dayNumber}`);
    const num = (v) => (v == null || v === '' ? null : Number(v));
    db.prepare(
      `UPDATE planned_days SET
         lodging_cost = CASE WHEN ? THEN ? ELSE lodging_cost END,
         misc_cost    = CASE WHEN ? THEN ? ELSE misc_cost END
       WHERE revision_id=? AND day_number=?`
    ).run(
      lodgingCost !== undefined ? 1 : 0, num(lodgingCost),
      miscCost !== undefined ? 1 : 0, num(miscCost),
      rev.id, day.day_number
    );
    return { ok: true };
  }

  // Free-text notes for a day — the rider's own words ("stopped early, headwind",
  // "library closes at 5"). Kept on the plan row so they survive replans that
  // keep the day, and shown on the canvas and in the trip list.
  function setDayNotes({ dayNumber, notes }) {
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const day = days.find((d) => d.day_number === Number(dayNumber));
    if (!day) throw new Error(`No day ${dayNumber}`);
    const text = typeof notes === 'string' ? notes.trim() : '';
    db.prepare(`UPDATE planned_days SET notes=? WHERE revision_id=? AND day_number=?`)
      .run(text || null, rev.id, day.day_number);
    return { ok: true, dayNumber: day.day_number, notes: text || null };
  }

  // The day's WORK ANCHOR: one mile-anchored stop marked kind='work'. Setting
  // a new one replaces the old one for that day; the dwell defaults to the
  // full owed work block.
  // Pick the best real wi-fi venue nearest a target mile — this is what makes
  // "make my morning 30 miles" a legal move: a work stop has to be an actual
  // place, so the mile snaps to the best one near it.
  function workStopNearMile({ dayNumber, atMile }) {
    const { days } = activeDays();
    const day = days.find((d) => d.day_number === Number(dayNumber));
    if (!day) throw new Error(`No day ${dayNumber}`);
    const target = Math.min(Math.max(Number(atMile), day.start_mile + 0.3), day.end_mile - 0.3);
    const rows = db.prepare(
      `SELECT id, name, route_mile, off_route_mi, wifi_status FROM resources
       WHERE category_id='wifi_work' AND status='active'
         AND route_mile BETWEEN ? AND ? AND off_route_mi <= 3`
    ).all(Math.max(day.start_mile + 0.3, target - 12), Math.min(day.end_mile - 0.3, target + 12));
    if (!rows.length) return null;
    const w = { confirmed: 3, likely: 2, unknown: 0.5, none: -5 };
    // Distance to the asked-for mile dominates: the rider said "make my
    // morning N miles", so land near N — wi-fi quality only breaks near-ties.
    const cost = (r) => Math.abs(r.route_mile - target) * 2 - (w[r.wifi_status] ?? 0) * 0.8 + r.off_route_mi;
    rows.sort((a, b) => cost(a) - cost(b));
    return rows[0];
  }

  function setWorkStop({ dayNumber, resourceId, routeMile, name, category, offRouteMi, cost, atMile, append = false, dwellMin }) {
    const { days } = activeDays();
    const day = days.find((d) => d.day_number === Number(dayNumber));
    if (!day) throw new Error(`No day ${dayNumber}`);
    // "Morning = N miles" → snap to the best venue near start + N.
    if (atMile != null && !resourceId && routeMile == null) {
      const hit = workStopNearMile({ dayNumber, atMile });
      if (!hit) throw new Error(`No wi-fi stop within 12 mi of mile ${r1(Number(atMile))} on this day`);
      resourceId = hit.id;
    }
    const tx = db.transaction(() => {
      // `append` adds a second (or third) sit-down; the default replaces the
      // day's work anchors, which is what "change work stop" means.
      if (!append) {
        db.prepare(
          `DELETE FROM planned_stops WHERE kind='work' AND route_mile > ? AND route_mile < ?`
        ).run(day.start_mile, day.end_mile);
      }
      if (resourceId || routeMile != null) {
        let mile = routeMile, nm = name, cat = category ?? 'wifi_work', off = offRouteMi ?? null;
        if (resourceId) {
          const r = db.prepare(`SELECT * FROM resources WHERE id = ?`).get(resourceId);
          if (!r) throw new Error(`No resource ${resourceId}`);
          mile = r.route_mile; nm = r.name; cat = r.category_id; off = r.off_route_mi;
        }
        if (mile <= day.start_mile + 0.05 || mile >= day.end_mile - 0.05) {
          throw new Error(`That stop (mi ${r1(mile)}) is outside day ${dayNumber}'s ride`);
        }
        // A single anchor owes the whole work day. Adding a second one splits
        // the remaining owed minutes between the sit-downs rather than
        // silently doubling the workload.
        const owed = workSettings().minutes;
        let dwell = Number(dwellMin);
        if (!Number.isFinite(dwell) || dwell <= 0) {
          if (append) {
            // The day still owes ONE work day. Whatever is already being
            // ridden on the clock comes off the top, and the seated remainder
            // splits evenly across every sit-down including this new one.
            const existing = workStopsFor(day);
            const comboMin = combosFor(day).reduce((s, c) => s + c.minutes, 0);
            const seatedTarget = Math.max(30, owed - comboMin);
            const per = Math.max(30, Math.round(seatedTarget / (existing.length + 1)));
            const upd = db.prepare(`UPDATE planned_stops SET dwell_min=? WHERE id=?`);
            for (const x of existing) upd.run(per, x.id);
            dwell = seatedTarget - per * existing.length;
            if (dwell < 30) dwell = 30;
          } else {
            dwell = Math.max(30, owed - combosFor(day).reduce((s, c) => s + c.minutes, 0));
          }
        }
        db.prepare(
          `INSERT INTO planned_stops (route_mile, resource_id, name, category, off_route_mi, dwell_min, kind, cost, notes)
           VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(mile, resourceId ?? null, nm || 'Work stop', cat, off,
          Math.round(dwell), 'work', cost ?? null, null);
      }
    });
    tx();
    return { ok: true };
  }

  // Unified sleep decision (spec: choosing tonight's bed IS setting the day's
  // endpoint — one action, never two divergent facts). Works for resources
  // (hotels/campgrounds), curated camping-guide spots, or a bare mile.
  function setSleep({ dayNumber, endMile, endName, overnightResourceId, campId, cost }) {
    const res = editDayEnd({
      dayNumber: Number(dayNumber),
      endMile: Number(endMile),
      endName,
      overnightResourceId: overnightResourceId ?? null,
      overnightCampId: campId ?? null,
    });
    if (cost !== undefined) setDayCosts({ dayNumber, lodgingCost: cost });
    return res;
  }

  // Everything keyed by DAY NUMBER rather than route mile has to move when days
  // renumber, or it silently attaches to a different ride: the rider's per-day
  // time overrides (day_plans) and their day-scoped canvas marks. Two-step so
  // the shift never collides with itself. Called from every renumbering path —
  // rest-day insert/remove, merge and split.
  const shiftDayKeyed = (from, delta) => {
    db.prepare(`UPDATE day_plans SET day_number = day_number + 1000 WHERE day_number >= ?`).run(from);
    db.prepare(`UPDATE day_plans SET day_number = day_number - 1000 + ? WHERE day_number >= 1000`).run(delta);
    db.prepare(
      `UPDATE canvas_marks SET day_number = day_number + 1000 WHERE scope='day' AND day_number >= ?`
    ).run(from);
    db.prepare(
      `UPDATE canvas_marks SET day_number = day_number - 1000 + ? WHERE scope='day' AND day_number >= 1000`
    ).run(delta);
  };

  // Rest day: zero miles, same bed another night. Represented as a planned day
  // whose start and end are equal — the chain stays gap-free by construction.
  function insertRestDay({ afterDay }) {
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const day = days.find((d) => d.day_number === Number(afterDay));
    if (!day) throw new Error(`No day ${afterDay}`);
    const lastActual = db.prepare(`SELECT MAX(day_number) n FROM actual_days`).get()?.n ?? 0;
    if (day.day_number < lastActual) throw new Error('Cannot insert a rest day before completed days');
    const tx = db.transaction(() => {
      db.prepare(`UPDATE planned_days SET day_number = day_number + 1000 WHERE revision_id=? AND day_number > ?`)
        .run(rev.id, day.day_number);
      db.prepare(`UPDATE planned_days SET day_number = day_number - 999 WHERE revision_id=? AND day_number > 1000`)
        .run(rev.id);
      insertDay.run(
        rev.id, day.day_number + 1, day.end_mile, day.end_mile,
        day.end_name, day.end_name, day.overnight_resource_id,
        'planned', '[]', null,
        1, day.lodging_cost ?? null, null, day.overnight_camp_id ?? null
      );
      shiftDayKeyed(day.day_number + 1, 1);
    });
    tx();
    geomCache.delete(rev.id);
    return { ok: true, dayNumber: day.day_number + 1 };
  }

  // Replace every planned day from `fromDay` onward with an explicit list.
  // Used once after a route retrace: the old tail's endpoints no longer exist
  // on the line, so re-cutting them is meaningless — the rider's chosen towns
  // are written in directly. Rest days are rows with rest=1 and no distance.
  function replaceTail({ fromDay, days }) {
    const { rev, days: cur } = activeDays();
    if (!rev) throw new Error('No active plan');
    const from = Number(fromDay);
    const prev = cur.find((d) => d.day_number === from - 1);
    if (!prev) throw new Error(`No day ${from - 1} to start from`);
    const lastActual = db.prepare(`SELECT MAX(day_number) n FROM actual_days`).get()?.n ?? 0;
    if (from <= lastActual) throw new Error(`Day ${from} is already ridden`);
    if (!Array.isArray(days) || !days.length) throw new Error('days required');
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM planned_days WHERE revision_id=? AND day_number>=?`).run(rev.id, from);
      db.prepare(`DELETE FROM planned_stops WHERE route_mile>?`).run(prev.end_mile + 0.01);
      for (const t of ['day_plans', 'canvas_marks']) db.prepare(`DELETE FROM ${t} WHERE day_number>=?`).run(from);
      let start = prev.end_mile, startName = prev.end_name, n = from;
      for (const d of days) {
        const rest = d.rest ? 1 : 0;
        const end = rest ? start : Number(d.endMile);
        if (!rest && !(end > start)) throw new Error(`Day ${n}: end ${end} is not past start ${start}`);
        const endName = d.endName ?? (rest ? startName : nameNearMile(end));
        insertDay.run(rev.id, n, start, end, startName, endName, d.overnightResourceId ?? null,
          'planned', '[]', d.notes ?? null, rest, d.lodgingCost ?? null, null, d.overnightCampId ?? null);
        start = end; startName = endName; n++;
      }
    });
    tx();
    geomCache.delete(rev.id);
    return planResponse();
  }

  function removeRestDay({ dayNumber }) {
    const { rev, days } = activeDays();
    if (!rev) throw new Error('No active plan');
    const day = days.find((d) => d.day_number === Number(dayNumber));
    if (!day) throw new Error(`No day ${dayNumber}`);
    if (!day.rest && day.end_mile - day.start_mile > 0.5) {
      throw new Error('Only rest days can be removed — merge riding days instead');
    }
    if (day.status !== 'planned') throw new Error(`Day ${dayNumber} is ${day.status}`);
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM planned_days WHERE revision_id=? AND day_number=?`).run(rev.id, day.day_number);
      db.prepare(`UPDATE planned_days SET day_number = day_number + 1000 WHERE revision_id=? AND day_number > ?`)
        .run(rev.id, day.day_number);
      db.prepare(`UPDATE planned_days SET day_number = day_number - 1001 WHERE revision_id=? AND day_number > 1000`)
        .run(rev.id);
      // The removed day's OWN day-keyed rows go first: day_plans.day_number is
      // the primary key, so shifting the next day down onto a surviving row
      // would fail the whole transaction. A mark on the rest day happens on
      // whatever day now occupies that slot.
      db.prepare(`DELETE FROM day_plans WHERE day_number=?`).run(day.day_number);
      db.prepare(`UPDATE canvas_marks SET day_number=? WHERE scope='day' AND day_number=?`)
        .run(day.day_number + 1, day.day_number);
      shiftDayKeyed(day.day_number + 1, -1);
    });
    tx();
    geomCache.delete(rev.id);
    return { ok: true };
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
    const merged = next.end_mile - day.start_mile;
    const flags = [];
    if (merged > capForDayNumber(dayNumber) + 0.5) flags.push('over_cap');
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
      // The swallowed day's fixed appointments still happen — on the merged
      // day now. Its time overrides do not survive (the merged day keeps this
      // day's), so drop them before the shift can collide with them.
      db.prepare(`UPDATE canvas_marks SET day_number=? WHERE scope='day' AND day_number=?`)
        .run(dayNumber, next.day_number);
      db.prepare(`DELETE FROM day_plans WHERE day_number=?`).run(next.day_number);
      shiftDayKeyed(next.day_number + 1, -1);
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
      // Day-keyed data on the days after the split follows its ride up a number.
      shiftDayKeyed(dayNumber + 1, 1);
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
      ...placeOf(u.lat, u.lng, u.route_mile),
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
        // A curated camp spot has no resource row; its name IS the endpoint name.
        overnightName: today.overnight_name ?? (today.overnight_camp_id ? today.end_name : null),
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
    editDayEnd, splitDay, mergeDays, completeDay, unlockDay, fitToDates, replaceTail,
    dayItinerary, stopCandidates, addStop, updateStop, removeStop, setDayStart,
    proposeDayItinerary, autoItineraries, previewAutoPlan,
    locate, positionInfo, elevationForRange, activeDays,
    // canonical-plan extensions
    setDayCosts, setWorkStop, setSleep, insertRestDay, removeRestDay, applyDayEnd, dayFlags,
    activateRevision, workStopFor, workStopsFor, combosFor, addCombo,
    readinessFor, placeOf, tripStartMile, workSettings, setDayNotes,
    setDayTimes, dayTimes, addBreak, breaksFor, mileAfterRideMinutes, modelForDay,
    addMark, updateMark, removeMark, marksFor, MARK_COLORS,
    // internals shared with the Today layer
    daylight, effortMiles, dayShape, stateAtMile, ridingSpeed, rideMinutes,
    workSettings, dateForDay, isWorkday,
    settingsGet: (k) => settingStmt.get(k)?.value,
  };
}

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
