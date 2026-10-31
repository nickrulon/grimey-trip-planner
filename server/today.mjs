// The Today layer: everything the Day Canvas needs to answer "where will I
// be, at what time, doing what, and is that plan viable?" — plus the decision
// systems (work chooser, unified sleep chooser) and the structured
// "help me make this fit" proposals.
//
// This layer READS the canonical plan and daylight engine and WRITES only
// through the planner's own mutations, so there is never a second plan.

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

import { LOITER, isLibrary, venueScore, clock12 } from './shared.mjs';

/**
 * Append a (mile, minute) sample, keeping the series monotonic in BOTH.
 * A combo can carry the rider past the mile of the next stop in the sorted
 * list, so the raw walk is not guaranteed to move only forwards — and a
 * backwards sample would make the interpolation below return nonsense.
 */
function pushProgress(progress, mile, min) {
  const last = progress[progress.length - 1];
  if (last && (mile < last.mile || min < last.min)) return;
  progress.push({ mile, min });
}

/**
 * When the ride reaches a given route mile, in local minutes. Built from the
 * same walk that produces the timeline blocks, so it already accounts for
 * break dwell, the work sit and the wait for the work clock to start. Returns
 * the FIRST time that mile is reached; null on a rest day, which covers none.
 */
export function minAtMile(progress, mile) {
  if (!progress.length) return null;
  if (mile <= progress[0].mile) return progress[0].min;
  for (let i = 1; i < progress.length; i++) {
    const a = progress[i - 1], b = progress[i];
    if (mile <= b.mile) {
      if (b.mile - a.mile < 1e-6) return a.min;
      return a.min + ((mile - a.mile) / (b.mile - a.mile)) * (b.min - a.min);
    }
  }
  return progress[progress.length - 1].min;
}

/** What a day with nothing in it simulates to. */
export function emptyDay() {
  return { blocks: [], progress: [], conflict: null, workCredit: 0, arriveEnd: null };
}

/**
 * The day, simulated: a walk along its stops in ROUTE-MILE order — breaks and
 * the work anchor alike — because you cannot reach mile 60 before mile 40.
 * Riding legs are whatever falls between them. That is why a weekend with
 * three breaks and a workday with a 7.5-hour sit use the same code: only the
 * work block is pinned to a clock, everything else is elapsed time.
 *
 * PURE: no database, no clock, no settings. Everything comes in as arguments,
 * so the same function previews a proposed chain of stops the rider has not
 * saved yet, and so it can be tested without a plan. Times are LOCAL
 * minutes-from-midnight; miles are route miles.
 *
 *   stops        [{ id?, type: 'break'|'work'|'combo', routeMile, dwellMin, name }], any order
 *   onTheClock   a workday with a work window (work/combo stops are walked)
 *   workStartMin when the work clock opens (local minutes), or null
 *   firstWorkMile the first work stop's mile, for leg labels (null when none)
 *   workday      whether the calendar says work is owed (labels only)
 *   owedMin      the work day owed, in minutes
 *   rideToMin    when the rider said they would stop riding; duskMin civil dusk
 *   legMin(a, b) effort-aware ride minutes between two miles
 *   mileAfter(from, minutes) the mile reached after riding that long
 *
 * Returns { blocks, progress, conflict, workCredit, arriveEnd } where progress
 * is a monotonic series of (mile, minute) samples — the walk's own answer to
 * "when am I at mile X".
 */
export function simulateDay({
  startMile, endMile, departMin, stops,
  onTheClock = false, workStartMin = null, firstWorkMile = null,
  workday = false, owedMin = 0,
  rideToMin = null, duskMin = null, rideUntilOverridden = false,
  legMin, mileAfter,
}) {
  let workCredit = 0;
  const blocks = [];
  const progress = [];
  let conflict = null;

  // Mile order, and where two stops round onto the SAME mile — the library
  // next door to the McDonald's — the order they were composed in. Relying on
  // sort stability for that would be relying on the order the caller happened
  // to concatenate its arrays.
  const ordered = [...stops].sort((a, b) => a.routeMile - b.routeMile || (a.seq ?? 0) - (b.seq ?? 0));

  let cursorMile = startMile;
  let cursorMin = departMin;
  let legIndex = 0;
  let workBegun = false;
  pushProgress(progress, cursorMile, cursorMin);
  const legLabel = () => {
    if (firstWorkMile == null) return legIndex === 0 ? 'Ride' : 'Ride on';
    return cursorMile < firstWorkMile ? 'Morning ride'
      : workBegun && workCredit < owedMin ? 'Midday ride' : 'Afternoon ride';
  };

  for (const st of ordered) {
    // A stop at a mile already passed happens WHERE YOU ARE — a combo can ride
    // straight through the next stop's mile, and "back to the library" is a
    // real link in a day. The cursor only ever moves forward, so no stretch is
    // ever ridden twice and the progress series is monotonic by construction.
    const atMile = Math.max(st.routeMile, cursorMile);
    const m = legMin(cursorMile, atMile);
    if (atMile > cursorMile + 0.01) {
      blocks.push({
        kind: 'ride', label: legLabel(),
        startMin: cursorMin, endMin: cursorMin + m,
        miles: r1(atMile - cursorMile), rideMin: m,
      });
      legIndex++;
    }
    let arrive = cursorMin + m;
    pushProgress(progress, atMile, arrive);

    // The work day starts on a clock, not on arrival: the first work-ish
    // block waits for it, and that wait is honest dead time.
    if ((st.type === 'work' || st.type === 'combo') && !workBegun) {
      if (arrive < workStartMin) {
        blocks.push({ kind: 'slack', label: 'Buffer', startMin: arrive, endMin: workStartMin });
        arrive = workStartMin;
        // The wait happens standing still at this mile. Without this sample a
        // combo (which then MOVES) would smear the buffer over its miles.
        pushProgress(progress, atMile, arrive);
      } else if (arrive > workStartMin + 5) {
        conflict ??= {
          kind: 'work_late',
          overMin: Math.round(arrive - workStartMin),
          detail: `Morning ride arrives ${Math.round(arrive - workStartMin)} min after work starts`,
        };
      }
      workBegun = true;
    }

    if (st.type === 'work') {
      blocks.push({
        kind: 'work', id: st.id, key: st.key, label: st.name,
        startMin: arrive, endMin: arrive + st.dwellMin,
        dwellMin: st.dwellMin, routeMile: r1(atMile),
      });
      workCredit += st.dwellMin;
      cursorMin = arrive + st.dwellMin;
      cursorMile = atMile;
    } else if (st.type === 'combo') {
      // Logged in AND moving: the clock and the odometer both run, from where
      // the rider actually is.
      const comboEnd = Math.min(endMile, mileAfter(atMile, st.dwellMin));
      blocks.push({
        kind: 'combo', id: st.id, key: st.key, label: st.name,
        startMin: arrive, endMin: arrive + st.dwellMin,
        dwellMin: st.dwellMin, miles: r1(comboEnd - atMile),
        routeMile: r1(atMile),
      });
      workCredit += st.dwellMin;
      cursorMin = arrive + st.dwellMin;
      cursorMile = comboEnd;
    } else {
      blocks.push({
        kind: 'break', id: st.id, key: st.key, label: st.name,
        startMin: arrive, endMin: arrive + st.dwellMin,
        dwellMin: st.dwellMin, routeMile: r1(atMile),
      });
      cursorMin = arrive + st.dwellMin;
      cursorMile = atMile;
    }
    pushProgress(progress, cursorMile, cursorMin);
  }

  // The last leg home.
  const mEnd = legMin(cursorMile, endMile);
  if (endMile > cursorMile + 0.01) {
    blocks.push({
      kind: 'ride',
      label: ordered.length ? legLabel() : (workday ? 'Ride (no work stop set)' : 'Ride'),
      startMin: cursorMin, endMin: cursorMin + mEnd,
      miles: r1(endMile - cursorMile), rideMin: mEnd,
    });
  }
  const arriveEnd = cursorMin + mEnd;
  pushProgress(progress, endMile, arriveEnd);

  // Measured against when the rider said they would stop riding, and
  // separately against actual darkness.
  if (rideToMin != null && arriveEnd > rideToMin + 5) {
    conflict = {
      kind: 'daylight',
      overMin: Math.round(arriveEnd - rideToMin),
      detail: `Day ends ~${Math.round(arriveEnd - rideToMin)} min after ${
        rideUntilOverridden ? 'the time you set to stop riding' : 'civil dusk'}`,
    };
  } else if (duskMin != null && arriveEnd > duskMin + 5) {
    conflict = {
      kind: 'dark',
      overMin: Math.round(arriveEnd - duskMin),
      detail: `Last ~${Math.round(arriveEnd - duskMin)} min of riding is after dark — lights`,
    };
  }

  return { blocks, progress, conflict, workCredit, arriveEnd };
}

export function makeToday(db, planner, camping, intel = null) {
  const {
    activeDays, daylight, effortMiles, ridingSpeed, rideMinutes, dayShape,
    nameNearMile, stateAtMile, dateForDay, settingsGet,
  } = planner;

  const startDate = () => settingsGet('startDate') ?? null;

  function dayRow(n) {
    const { days } = activeDays();
    const d = days.find((x) => x.day_number === Number(n));
    if (!d) throw new Error(`No day ${n}`);
    return { d, days };
  }

  // One builder for the day's daylight model, shared with the planner (the
  // builder's candidates judge arrival against the same work clock the canvas
  // draws).
  const modelFor = (d) => planner.modelForDay(d, ridingSpeed());

  const toMin = (hhmm, dflt = 6 * 60) => {
    if (!hhmm) return dflt;
    const [h, m] = String(hhmm).split(':').map(Number);
    return Number.isFinite(h) ? h * 60 + (Number.isFinite(m) ? m : 0) : dflt;
  };

  // ---- moving-meeting possibility (prototype's "zoom on the bike") ----------
  const nextWifiStmt = db.prepare(
    `SELECT id, name, brand, route_mile, off_route_mi, wifi_status
     FROM resources WHERE category_id='wifi_work' AND status='active'
       AND route_mile > ? AND route_mile <= ? AND off_route_mi <= 2
     ORDER BY route_mile`
  );
  function nextReliableStop(mile, maxAheadMi) {
    for (const x of nextWifiStmt.all(mile + 0.2, mile + maxAheadMi)) {
      if (x.wifi_status === 'confirmed' || x.wifi_status === 'likely'
        || (LOITER[x.brand] ?? 0) >= 1.5 || isLibrary(x.name)) return x;
    }
    return null;
  }

  // ---- crossings the day touches (ferries, shuttles, a lift round a closure) -
  // Two sources, because the trip data has them in two places: route_transits
  // rows the rider created, and the ingested route_notes of kind 'ferry' — the
  // Mobile Bay crossing at mile 86.5 is one of the latter. Both are the same
  // thing for our purposes: a fixed crossing at a known route mile that a mark
  // can pin itself to, so day renumbering never strands it.
  // Half-open on the far end, like marks: a crossing exactly on a day boundary
  // belongs to the day that starts there, not to both.
  const transitsStmt = db.prepare(
    `SELECT id, start_mile, end_mile, name, minutes, kind, notes FROM route_transits
     WHERE end_mile >= ? AND start_mile < ? ORDER BY start_mile`
  );
  const crossingNotesStmt = db.prepare(
    `SELECT id, start_mile, end_mile, title, detail FROM route_notes
     WHERE kind='ferry' AND end_mile >= ? AND start_mile < ? ORDER BY start_mile`
  );

  /** Crossings inside [startMile, endMile) with when the walk reaches them. */
  function crossingsFor({ startMile, endMile, isLastDay = false }, progress) {
    const at = (mile) => {
      const m = minAtMile(progress, mile);
      return m == null ? null : Math.round(m);
    };
    const hi = isLastDay ? endMile + 0.05 : endMile;
    return [
      ...transitsStmt.all(startMile, hi).map((t) => ({
        id: `t${t.id}`, source: 'transit', name: t.name, kind: t.kind,
        minutes: t.minutes, notes: t.notes,
        startMile: r1(t.start_mile), endMile: r1(t.end_mile), atMin: at(t.start_mile),
      })),
      ...crossingNotesStmt.all(startMile, hi).map((x) => ({
        id: `n${x.id}`, source: 'note', name: x.title, kind: 'ferry',
        minutes: null, notes: x.detail,
        startMile: r1(x.start_mile), endMile: r1(x.end_mile), atMin: at(x.start_mile),
      })),
    ].sort((a, b) => a.startMile - b.startMile);
  }

  // ---- proposals: a day the rider is still composing ------------------------
  // The builder previews a chain of stops (and possibly a new endpoint) before
  // anything is written. Both the preview and the eventual save go through the
  // two resolvers below, so what the builder shows is exactly what gets saved.

  /**
   * The rider's proposed stops in the shape the walk and the payload use.
   *
   *   stops: [{ kind: 'break'|'work'|'combo', routeMile? | afterRideMin?,
   *             dwellMin, name?, resourceId?, notes? }]   — in CHAIN order
   *
   * afterRideMin is measured from the previous stop in the list (or the day
   * start): "ride 45 minutes, then stop" is how a break is actually thought.
   * A combo with no mile of its own anchors just past the previous stop, as
   * addCombo does. Proposed stops get negative ids so they can never collide
   * with a saved row, carry their chain position as `seq` (so two stops that
   * round onto the same mile keep the order the rider composed them in), and
   * echo the client's `key` back on the block they produce — the client maps
   * blocks to chain entries by that key rather than by position.
   */
  function resolveProposedStops(d, raw, speed) {
    if (!Array.isArray(raw)) throw new Error('stops must be an array');
    const out = { breaks: [], workStops: [], combos: [] };
    let prevMile = d.start_mile;
    raw.forEach((st, i) => {
      const at = `stop ${i + 1}`;
      const kind = st.kind ?? st.type;
      if (!['break', 'work', 'combo'].includes(kind)) throw new Error(`${at}: kind must be break, work or combo`);
      const dwell = Math.round(Number(st.dwellMin));
      if (!Number.isFinite(dwell) || dwell < 0) throw new Error(`${at}: dwellMin must be a number of minutes`);
      let mile;
      if (st.routeMile != null && st.routeMile !== '') mile = Number(st.routeMile);
      else if (st.afterRideMin != null && st.afterRideMin !== '') {
        mile = planner.mileAfterRideMinutes(prevMile, Math.max(0, Number(st.afterRideMin)), speed);
      } else if (kind === 'combo') mile = prevMile + 0.02;
      else throw new Error(`${at}: routeMile or afterRideMin required`);
      if (!Number.isFinite(mile)) throw new Error(`${at}: could not work out where it lands`);
      // Miles are stored rounded to 0.1, and the readers take stops strictly
      // inside the day — so round FIRST and judge the mile that will actually
      // be saved. A stop the rounding pushes onto a boundary is nudged inside
      // rather than refused: it is a real stop, a tenth of a mile from the edge.
      mile = r1(mile);
      if (mile <= d.start_mile || mile >= d.end_mile) {
        const inside = Math.min(Math.max(mile, r1(d.start_mile + 0.1)), r1(d.end_mile - 0.1));
        if (Math.abs(inside - mile) > 0.25 || inside <= d.start_mile || inside >= d.end_mile) {
          throw new Error(`${at} lands at mi ${mile}, outside the day (mi ${r1(d.start_mile)}–${r1(d.end_mile)})`);
        }
        mile = inside;
      }
      const res = st.resourceId
        ? db.prepare(`SELECT * FROM resources WHERE id = ?`).get(String(st.resourceId)) ?? null
        : null;
      const fallback = kind === 'work' ? 'Work stop' : kind === 'combo' ? 'Work + bike' : 'Break';
      const name = String(st.name ?? res?.name ?? fallback).trim().slice(0, 80) || fallback;
      const notes = st.notes != null ? String(st.notes).slice(0, 400) : null;
      // Exactly the shapes breaksFor / combosFor / workStopsFor return, so a
      // preview and the canvas read back after saving are the same object.
      const id = -(i + 1);
      const seq = i;
      const key = st.key != null ? String(st.key).slice(0, 40) : null;
      if (kind === 'break') out.breaks.push({ id, seq, key, name, routeMile: mile, dwellMin: dwell, note: notes });
      else if (kind === 'combo') out.combos.push({ id, seq, key, name, routeMile: mile, minutes: dwell, note: notes });
      else {
        const place = planner.placeOf(res?.lat ?? null, res?.lng ?? null, mile);
        out.workStops.push({
          id, seq, key, resourceId: res?.id ?? null, name, brand: res?.brand ?? null,
          routeMile: mile, offRouteMi: r2(res?.off_route_mi),
          dwellMin: dwell, cost: null,
          wifiStatus: res?.wifi_status ?? null, hours: res?.hours ?? null,
          address: res?.address ?? null, phone: res?.phone ?? null, website: res?.website ?? null,
          lat: res?.lat ?? null, lng: res?.lng ?? null,
          town: place.town, state: place.state,
        });
      }
      // A combo RIDES for its dwell, so "then ride 45 minutes" after one starts
      // from where it puts you down, not from where it began.
      prevMile = kind === 'combo'
        ? Math.min(d.end_mile, planner.mileAfterRideMinutes(mile, dwell, speed))
        : mile;
    });
    for (const k of Object.keys(out)) out[k].sort((a, b) => a.routeMile - b.routeMile || a.seq - b.seq);
    return out;
  }

  /**
   * The day row as it WOULD stand if the proposal were saved: a new endpoint
   * and, optionally, a new bed. Same constraints editDayEnd enforces, so a
   * preview can never show a day the save would then refuse.
   */
  function proposedDay(d0, days, o) {
    if (o?.endMile == null || o.endMile === '') return d0;
    const endMile = Number(o.endMile);
    if (!Number.isFinite(endMile)) throw new Error('endMile must be a number');
    if (endMile <= d0.start_mile + 0.5) throw new Error('The day has to end past where it starts');
    const next = days.find((x) => x.day_number === d0.day_number + 1);
    if (next && endMile >= next.end_mile) {
      throw new Error(`Ending at mi ${r1(endMile)} would pass day ${next.day_number}'s endpoint (mi ${r1(next.end_mile)})`);
    }
    if (endMile > planner.totalMiles + 0.05) throw new Error('That is past the end of the route');
    const bed = o.end ?? {};
    const sameEnd = Math.abs(endMile - d0.end_mile) < 0.01;
    if (sameEnd && !bed.resourceId && !bed.campId) return d0;   // nothing about tonight changes
    const cleared = {
      overnight_resource_id: null, overnight_camp_id: null, overnight_name: null,
      overnight_category: null, overnight_off_mi: null, overnight_address: null,
      overnight_phone: null, overnight_website: null, overnight_hours: null,
      overnight_lat: null, overnight_lng: null, overnight_mile: null,
      overnight_attrs: null, lodging_cost: null,
    };
    // Same bed as tonight: its recorded price is still good (applyDayEnd keeps it).
    const sameBed = (bed.resourceId ?? null) === (d0.overnight_resource_id ?? null)
      && (bed.campId ?? null) === (d0.overnight_camp_id ?? null);
    let over = sameBed ? { ...cleared, lodging_cost: d0.lodging_cost } : cleared;
    let endName = o.endName ? String(o.endName) : null;
    if (bed.resourceId) {
      const r = db.prepare(`SELECT * FROM resources WHERE id = ?`).get(String(bed.resourceId));
      if (!r) throw new Error(`No resource ${bed.resourceId}`);
      over = {
        ...over, overnight_resource_id: r.id, overnight_name: r.name,
        overnight_category: r.category_id, overnight_off_mi: r.off_route_mi,
        overnight_address: r.address, overnight_phone: r.phone, overnight_website: r.website,
        overnight_hours: r.hours, overnight_lat: r.lat, overnight_lng: r.lng, overnight_mile: r.route_mile,
      };
      endName ??= nameNearMile(r.route_mile);
    } else if (bed.campId) {
      const spot = camping.spotById(String(bed.campId));
      if (!spot) throw new Error(`No camping spot ${bed.campId}`);
      over = { ...over, overnight_camp_id: spot.id };
      endName ??= spot.name;
    }
    return {
      ...d0, end_mile: endMile, end_name: endName ?? nameNearMile(endMile), ...over,
      // the same flags the save will write, so the mileage chip cannot differ
      flags: planner.dayFlags(d0.start_mile, endMile, !!(over.overnight_resource_id ?? over.overnight_camp_id), d0.day_number),
    };
  }

  /**
   * Save a proposed chain: replace the day's stops and, if given, move its
   * endpoint and bed — in ONE transaction, so a half-saved chain is impossible.
   * The chain IS the day: every break, work stop and combo inside it, up to
   * wherever it now ends, is replaced by the proposal; stops that a farther
   * endpoint swallows from the next day go too, because they are inside this
   * day now and the preview never showed them.
   *
   * Goes through exactly the resolvers the preview uses, then returns the
   * fresh canvas — which is why preview and saved state agree by construction.
   */
  function saveDayChain(n, body = {}) {
    const { d: d0, days } = dayRow(n);
    if (d0.status !== 'planned') throw new Error(`Day ${n} is ${d0.status}; only planned days can be edited`);
    if (db.prepare(`SELECT 1 FROM actual_days WHERE day_number = ?`).get(d0.day_number)) {
      throw new Error(`Day ${n} has already been ridden`);
    }
    const speed = ridingSpeed();
    const overrides = { endMile: body.endMile, endName: body.endName, end: body.end };
    const d = proposedDay(d0, days, overrides);
    const proposed = resolveProposedStops(d, body.stops ?? [], speed);
    const endChanged = d !== d0;

    const ins = db.prepare(
      `INSERT INTO planned_stops (route_mile, resource_id, name, category, off_route_mi, dwell_min, kind, cost, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    db.transaction(() => {
      db.prepare(
        `DELETE FROM planned_stops WHERE kind IN ('break','work','combo')
         AND route_mile > ? AND route_mile < ?`
      ).run(d0.start_mile, Math.max(d0.end_mile, d.end_mile));
      for (const b of proposed.breaks) ins.run(b.routeMile, null, b.name, null, null, b.dwellMin, 'break', null, b.note);
      for (const w of proposed.workStops) {
        ins.run(w.routeMile, w.resourceId, w.name, w.resourceId ? 'wifi_work' : null,
          w.offRouteMi, w.dwellMin, 'work', null, null);
      }
      for (const c of proposed.combos) ins.run(c.routeMile, null, c.name, null, null, c.minutes, 'combo', null, c.note);
      if (endChanged) {
        planner.applyDayEnd({
          dayNumber: d0.day_number, endMile: d.end_mile, endName: d.end_name,
          overnightResourceId: d.overnight_resource_id, overnightCampId: d.overnight_camp_id,
        });
      }
    })();
    if (endChanged && body.end && body.end.cost !== undefined) {
      planner.setDayCosts({ dayNumber: d0.day_number, lodgingCost: body.end.cost });
    }
    return dayCanvas(n);
  }

  // ---- the Day Canvas -------------------------------------------------------
  /**
   * One day, understood at a glance. With `overrides` ({ stops, endMile,
   * endName, end }) it is the same day AS PROPOSED — the builder's live
   * preview — assembled by exactly the same code, flagged `preview: true`, and
   * nothing is written.
   */
  function dayCanvas(n, overrides = null) {
    const { d: d0, days } = dayRow(n);
    const d = overrides ? proposedDay(d0, days, overrides) : d0;
    const model = modelFor(d);
    const speed = ridingSpeed();
    const proposed = overrides?.stops ? resolveProposedStops(d, overrides.stops, speed) : null;
    const workStop = proposed ? (proposed.workStops[0] ?? null) : planner.workStopFor(d);
    const prev = days.find((x) => x.day_number === d.day_number - 1) ?? null;
    const actual = db.prepare(`SELECT * FROM actual_days WHERE day_number = ?`).get(d.day_number) ?? null;
    const rest = !!d.rest || d.end_mile - d.start_mile < 0.5;
    const isLastDay = d.day_number === days[days.length - 1].day_number;
    // The miles this day is judged over: what was ridden, once that is known.
    const covered = actual
      ? { startMile: actual.start_mile, endMile: actual.end_mile }
      : { startMile: d.start_mile, endMile: d.end_mile };

    // Depart time: the rider's own override, else civil dawn (you ride at
    // first light on this trip), else 6:00.
    const times = planner.dayTimes(d.day_number);
    const departMin = times.startTime
      ? toMin(times.startTime)
      : model?.dawn != null ? Math.round(model.dawn * 60) : 360;

    // Timeline blocks (the plan layer). Times are LOCAL minutes-from-midnight.
    //
    // A day is a walk along its stops in ROUTE-MILE order — breaks and the work
    // anchor alike — because you cannot reach mile 60 before mile 40. Riding
    // legs are whatever falls between them. That is why a weekend with three
    // breaks and a workday with a 7.5-hour sit use the same code: only the work
    // block is pinned to a clock, everything else is elapsed time.
    const breaks = proposed ? proposed.breaks : planner.breaksFor(d);
    const workStops = proposed ? proposed.workStops : planner.workStopsFor(d);
    const combos = proposed ? proposed.combos : planner.combosFor(d);
    const owedMin = model?.workday ? planner.workSettings().minutes : 0;
    // The walk itself is a pure function (below), so the same code answers
    // "what does this day look like" for the saved stops AND for a proposed
    // set the rider is still composing.
    const onTheClock = !!(model?.workday && model.work);
    const sim = rest ? emptyDay() : simulateDay({
      startMile: d.start_mile, endMile: d.end_mile, departMin,
      // seq breaks ties at a shared mile. For a PROPOSAL it is the rider's
      // chain order (set by resolveProposedStops); for saved stops it is this
      // concatenation order, which is what the walk has always used.
      stops: [
        ...breaks.map((b) => ({ ...b, type: 'break' })),
        ...(onTheClock ? workStops.map((w) => ({ ...w, type: 'work' })) : []),
        ...(onTheClock ? combos.map((c) => ({ ...c, type: 'combo', dwellMin: c.minutes })) : []),
      ].map((st, i) => ({ ...st, seq: st.seq ?? i })),
      // Leg labels split the day around the FIRST work stop even on a weekend,
      // where the stop is kept as a wi-fi stop but not walked.
      firstWorkMile: workStops.length ? workStops[0].routeMile : null,
      onTheClock,
      workStartMin: onTheClock ? Math.round(model.work.localStart * 60) : null,
      workday: !!model?.workday, owedMin,
      rideToMin: model ? Math.round(model.rideTo * 60) : null,
      duskMin: model?.dusk != null ? model.dusk * 60 : null,
      rideUntilOverridden: !!model?.overrides?.rideUntil,
      legMin: (a, b) => Math.round(rideMinutes(a, b, speed)),
      mileAfter: (from, minutes) => planner.mileAfterRideMinutes(from, minutes, speed),
    });
    const { blocks, progress, conflict, workCredit } = sim;

    // Moving-meeting possibility: from the projected midday position, is a
    // reliable work stop reachable within ~60–90 min of riding?
    let movingMeeting = null;
    if (!rest && model?.workday && model.morningLightH > 0.3) {
      const midMile = Math.min(d.start_mile + model.morningLightH * speed, d.end_mile);
      const hop = nextReliableStop(midMile, speed * 1.5);
      if (hop) {
        movingMeeting = {
          fromMile: r1(midMile),
          stop: {
            id: hop.id, name: hop.name, routeMile: r1(hop.route_mile),
            milesAhead: r1(hop.route_mile - midMile),
            rideMin: Math.round(((hop.route_mile - midMile) / speed) * 60),
            wifiStatus: hop.wifi_status,
          },
          gainMi: Math.round(speed),
        };
      }
    }

    // Work fallbacks: the 3 next-best wi-fi sits near the chosen stop.
    let workFallbacks = [];
    if (workStop) {
      workFallbacks = db.prepare(
        `SELECT id, name, route_mile, off_route_mi, wifi_status FROM resources
         WHERE category_id='wifi_work' AND status='active'
           AND route_mile BETWEEN ? AND ? AND off_route_mi <= 2.5 AND id != ?
         ORDER BY (wifi_status='confirmed') DESC, (wifi_status='likely') DESC,
                  ABS(route_mile - ?) LIMIT 3`
      ).all(d.start_mile + 0.3, d.end_mile - 0.3, workStop.resourceId ?? '', workStop.routeMile)
        .map((f) => ({
          id: f.id, name: f.name, routeMile: r1(f.route_mile),
          offRouteMi: r2(f.off_route_mi), wifiStatus: f.wifi_status,
        }));
    }

    // Sleep detail: overnight resource, or the curated camp spot.
    const campSpot = d.overnight_camp_id ? camping.spotById(d.overnight_camp_id) : null;
    const notes = (db.prepare(
      `SELECT * FROM route_notes WHERE start_mile <= ? AND end_mile >= ? ORDER BY start_mile`
    ).all(d.end_mile, d.start_mile)).map((x) => ({
      id: x.id, kind: x.kind, title: x.title, detail: x.detail,
      startMile: r1(x.start_mile), endMile: r1(x.end_mile),
      source: x.source, confidence: x.confidence,
    }));

    const elev = planner.elevationForRange(d.start_mile, d.end_mile);
    const { effort } = effortMiles(d.start_mile, d.end_mile);

    // The rider's own marks. Deliberately NOT folded into `blocks`: blocks are
    // derived state that the canvas slides when roll-out moves, and a mark that
    // slid would be the one thing this feature exists to prevent.
    const marks = planner.marksFor(d, {
      isLastDay,
      // A ridden day is judged by the miles it actually covered, not the ones
      // it was planned to cover — otherwise a mile-pinned mark shows both on
      // the day that was ridden and on the day that now covers that mile.
      startMile: covered.startMile, endMile: covered.endMile,
    });
    // A fixed appointment the ride cannot make: a mile-pinned mark whose mile
    // the walk reaches after the mark's time. "Meet the 3:30 boat" stops being
    // a note to remember and becomes a constraint the day is checked against.
    // (A day-scoped mark has no mile to check — that is what the pin offer is
    // for.) Five minutes of grace, like every other check on the canvas.
    const missedMarks = rest ? [] : marks.flatMap((m) => {
      if (m.routeMile == null) return [];
      const at = minAtMile(progress, m.routeMile);
      if (at == null || at <= m.startMin + 5) return [];
      return [{
        id: m.id, lateMin: Math.round(at - m.startMin),
        label: `${m.label}: reach mi ${m.routeMile} at ${clock12(at)}, need ${clock12(m.startMin)}`,
      }];
    });

    return {
      dayNumber: d.day_number,
      preview: !!overrides,
      date: startDate() ? dateForDay(startDate(), d.day_number) : null,
      rest,
      startMile: r1(d.start_mile), endMile: r1(d.end_mile),
      miles: r1(d.end_mile - d.start_mile), effortMiles: r1(effort),
      startName: d.start_name, endName: d.end_name,
      endState: stateAtMile(d.end_mile),
      status: d.status, flags: JSON.parse(d.flags || '[]'),
      // Day 1 wakes wherever the ride actually begins — which is not route
      // mile 0 if the rider is dropped off further along.
      prevOvernight: prev
        ? (prev.overnight_name ?? prev.end_name)
        : `${nameNearMile(planner.tripStartMile())} (trip start)`,
      departMin, blocks, conflict,
      // The dials the rider can turn, and whether each is currently their own
      // choice or the app's default.
      times: {
        startTime: times.startTime, workStart: times.workStart, rideUntil: times.rideUntil,
        defaultDepartMin: model?.dawn != null ? Math.round(model.dawn * 60) : 360,
        defaultRideUntilMin: model?.dusk != null ? Math.round(model.dusk * 60) : 19 * 60,
        rideFromMin: model ? Math.round(model.rideFrom * 60) : departMin,
        rideToMin: model ? Math.round(model.rideTo * 60) : null,
      },
      sun: model ? {
        zone: model.zone, workday: model.workday,
        dawn: model.dawn, sunrise: model.sunrise, sunset: model.sunset, dusk: model.dusk,
        work: model.work, phases: model.phases,
        usableRideMin: Math.round(model.usableH * 60),
        rideMin: Math.round(model.rideH * 60),
        bufferMin: Math.round(model.bufferH * 60),
        darkBeforeMin: Math.round(model.darkBeforeH * 60),
        darkAfterMin: Math.round(model.darkAfterH * 60),
        overrides: model.overrides,
        fit: model.status,
      } : null,
      workStop: workStop && bare(workStop), workFallbacks, movingMeeting,
      workStops: workStops.map(bare), combos: combos.map(bare),
      // Does the day actually add up to a work day? Sitting + riding-on-a-call
      // both count; the shortfall is stated rather than assumed away.
      work: model?.workday ? {
        owedMin: owedMin,
        creditMin: Math.round(workCredit),
        shortMin: Math.max(0, Math.round(owedMin - workCredit)),
        overMin: Math.max(0, Math.round(workCredit - owedMin)),
        comboMin: combos.reduce((s, c) => s + c.minutes, 0),
      } : null,
      breaks: breaks.map((b) => ({
        ...bare(b),
        milesFromStart: r1(b.routeMile - d.start_mile),
        rideMinFromStart: Math.round(rideMinutes(d.start_mile, b.routeMile, speed)),
      })),
      marks,
      missedMarks,
      // Crossings this day touches, with when the ride reaches them. A mark
      // whose window lands on one of these is really the crossing's, not the
      // day's — that is the moment to offer pinning it to the mile. Same ridden
      // range as the marks, so a completed day never lists a boat it never met.
      transits: crossingsFor({ ...covered, isLastDay }, progress),
      sleep: {
        resource: d.overnight_resource_id ? {
          id: d.overnight_resource_id, name: d.overnight_name,
          category: d.overnight_category, offRouteMi: r2(d.overnight_off_mi),
          address: d.overnight_address, phone: d.overnight_phone,
          website: d.overnight_website, hours: d.overnight_hours,
          lat: d.overnight_lat, lng: d.overnight_lng, routeMile: r1(d.overnight_mile),
          ...planner.placeOf(d.overnight_lat, d.overnight_lng, d.overnight_mile),
        } : null,
        campSpot: campSpot ? {
          ...campSpot, routeMile: r1(campSpot.routeMile),
          ...planner.placeOf(campSpot.lat, campSpot.lng, campSpot.routeMile),
        } : null,
        cost: d.lodging_cost ?? null,
      },
      costs: {
        lodging: d.lodging_cost ?? null,
        work: workStop?.cost ?? null,
        misc: d.misc_cost ?? null,
        total: Math.round((d.lodging_cost ?? 0) + (workStop?.cost ?? 0) + (d.misc_cost ?? 0)),
      },
      elevGainFt: elev?.gainFt ?? null,
      riderNotes: notes,
      // What other riders reported on exactly this stretch. Anchored records
      // carry a mile; regional ones are advice for the state with no position.
      intel: intel ? {
        anchored: intel.forRange(d.start_mile, d.end_mile),
        road: intel.roadFor(d.start_mile, d.end_mile),
        regional: intel.regionalFor([
          stateAtMile(d.start_mile), stateAtMile(d.end_mile),
        ]).slice(0, 6),
      } : null,
      readiness: model
        ? planner.readinessFor(d, model, workStop, notes, actual,
          { workCreditMin: workCredit, owedMin, missedMarks })
        : { state: actual ? 'done' : 'unknown', issues: [] },
      actual: actual ? {
        endMile: r1(actual.end_mile), miles: r1(actual.end_mile - actual.start_mile),
        endName: actual.end_name, date: actual.date, notes: actual.notes,
      } : null,
      dayCount: days.length,
    };
  }

  // ---- work chooser ----------------------------------------------------------
  function workOptions(n) {
    const { d } = dayRow(n);
    const model = modelFor(d);
    const speed = ridingSpeed();
    // Ideal work mile: ride out the whole morning-light window, then sit down.
    const idealMile = model
      ? Math.min(d.start_mile + Math.max(0.5, model.morningLightH) * speed, d.end_mile - 1)
      : (d.start_mile + d.end_mile) / 2;
    const rows = db.prepare(
      `SELECT id, name, brand, route_mile, off_route_mi, wifi_status, hours, address, lat, lng
       FROM resources WHERE category_id='wifi_work' AND status='active'
         AND route_mile BETWEEN ? AND ? AND off_route_mi <= 3
       ORDER BY route_mile`
    ).all(d.start_mile + 0.3, d.end_mile - 0.3);
    const out = rows.map((x) => {
      const score = venueScore(x)
        - x.off_route_mi * 1.5
        - Math.abs(x.route_mile - idealMile) * 0.25;
      const morningMi = x.route_mile - d.start_mile;
      const afternoonMi = d.end_mile - x.route_mile;
      return {
        id: x.id, name: x.name, brand: x.brand,
        routeMile: r1(x.route_mile), offRouteMi: r2(x.off_route_mi),
        wifiStatus: x.wifi_status, hours: x.hours, address: x.address,
        lat: x.lat, lng: x.lng,
        ...planner.placeOf(x.lat, x.lng, x.route_mile),
        morningMi: r1(morningMi),
        morningMin: Math.round(rideMinutes(d.start_mile, x.route_mile, speed)),
        afternoonMi: r1(afternoonMi),
        afternoonMin: Math.round(rideMinutes(x.route_mile, d.end_mile, speed)),
        // Same vocabulary the sleep chooser uses, measured against the mile
        // where the morning daylight actually runs out.
        milesFromStart: r1(morningMi),
        rideMinFromStart: Math.round(rideMinutes(d.start_mile, x.route_mile, speed)),
        deltaMi: r1(x.route_mile - idealMile),
        detour: x.off_route_mi > 1.5,
        direction: x.route_mile - idealMile > 2 ? 'farther'
          : x.route_mile - idealMile < -2 ? 'earlier' : 'on_plan',
        score: r1(score),
      };
    }).sort((a, b) => b.score - a.score);
    // Dedupe name@half-mile (OSM double-entry)
    const seen = new Set();
    return {
      dayNumber: d.day_number,
      startMile: r1(d.start_mile), startName: d.start_name,
      endMile: r1(d.end_mile), endName: d.end_name,
      idealMile: r1(idealMile),
      speedMph: speed,
      candidates: out.filter((c) => {
        const k = `${c.name}@${Math.round(c.routeMile * 2)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 120),
    };
  }

  // ---- unified sleep chooser --------------------------------------------------
  function sleepOptions(n, { back = 20, fwd = 20 } = {}) {
    const { d, days } = dayRow(n);
    const next = days.find((x) => x.day_number === d.day_number + 1) ?? null;
    const lo = Math.max(d.start_mile + 1, d.end_mile - back);
    const hi = Math.min(planner.totalMiles, d.end_mile + fwd);

    const wifiNearStmt = db.prepare(
      `SELECT COUNT(*) c FROM resources WHERE category_id='wifi_work'
       AND route_mile BETWEEN ? AND ? AND off_route_mi <= 2`
    );

    const options = [];
    // OSM hotels + campgrounds
    for (const r of db.prepare(
      `SELECT id, category_id, name, route_mile, off_route_mi, attributes_json,
              address, phone, website, hours, lat, lng
       FROM resources WHERE category_id IN ('hotel','campground')
         AND status='active' AND route_mile BETWEEN ? AND ? AND off_route_mi <= 6`
    ).all(lo, hi)) {
      let attrs = {};
      try { attrs = JSON.parse(r.attributes_json); } catch { /* keep {} */ }
      options.push({
        kind: 'resource', id: r.id,
        name: r.name, type: r.category_id,
        routeMile: r1(r.route_mile), deltaMi: r1(r.route_mile - d.end_mile),
        offRouteMi: r2(r.off_route_mi),
        price: null, tier: r.category_id === 'campground' ? 'unknown' : 'room',
        water: attrs.drinking_water === 'yes', showers: !!attrs.shower && attrs.shower !== 'no',
        toilets: attrs.toilets === 'yes',
        address: r.address, phone: r.phone, website: r.website, hours: r.hours,
        lat: r.lat, lng: r.lng,
        ...planner.placeOf(r.lat, r.lng, r.route_mile),
        confidence: null, cyclist: false, free: false,
      });
    }
    // Curated camping-guide spots (the hand-researched gold)
    for (const s of camping.spotsNear(d.end_mile, d.end_mile - lo, hi - d.end_mile)) {
      options.push({
        kind: 'camp', id: s.id,
        name: s.name, type: s.type ?? 'campground',
        routeMile: r1(s.routeMile), deltaMi: r1(s.routeMile - d.end_mile),
        offRouteMi: null,
        price: s.price ?? null, priceNote: s.priceNote ?? null, tier: s.tier,
        water: !!s.water, showers: !!s.showers, toilets: !!s.toilets,
        tentsOk: s.tentsOk !== false,
        legalityNote: s.legalityNote ?? null, cyclistIntel: s.cyclistIntel ?? null,
        seasonalNote: s.seasonalNote ?? null, booking: s.booking ?? null,
        website: s.website ?? null, phone: s.phone ?? null,
        sources: s.sources ?? [], confidence: s.confidence ?? 'medium',
        lat: s.lat, lng: s.lng,
        ...planner.placeOf(s.lat, s.lng, s.routeMile),
        cyclist: !!s.cyclistIntel, free: s.price === 0,
        locationNote: s.locationNote ?? null,
      });
    }
    const speed = ridingSpeed();
    for (const o of options) {
      o.wifiNear = wifiNearStmt.get(o.routeMile - 2, o.routeMile + 2).c;
      // Consequence: what choosing this does to today (and therefore tomorrow).
      o.newDayMiles = r1(o.routeMile - d.start_mile);
      o.deltaDayMiles = r1(o.routeMile - d.end_mile);
      o.nextDayMiles = next ? r1(next.end_mile - o.routeMile) : null;
      // Riding cost from where the day actually started — effort-adjusted, so
      // a climb costs real minutes rather than pretending it is flat.
      o.milesFromStart = r1(o.routeMile - d.start_mile);
      o.rideMinFromStart = Math.round(rideMinutes(d.start_mile, o.routeMile, speed));
      // The rider's three real levers, named.
      o.detour = (o.offRouteMi ?? 0) > 1.5;
      o.direction = o.deltaMi > 2 ? 'farther' : o.deltaMi < -2 ? 'earlier' : 'on_plan';
      // Recommendation score: verified + cheap + close to plan + on-route.
      o.score = r1(
        10
        - Math.abs(o.deltaMi) * 0.35
        - (o.offRouteMi ?? 0) * 2
        + (o.kind === 'camp' ? 3 : 0)
        + (o.confidence === 'high' ? 2 : 0)
        + (o.free ? 2.5 : o.price != null && o.price <= 15 ? 1.5 : 0)
        + (o.showers ? 0.8 : 0)
        + Math.min(o.wifiNear, 4) * 0.3
      );
      o.chosen = (o.kind === 'resource' && o.id === d.overnight_resource_id)
        || (o.kind === 'camp' && o.id === d.overnight_camp_id);
    }
    options.sort((a, b) => b.score - a.score);
    return {
      dayNumber: d.day_number,
      startMile: r1(d.start_mile), startName: d.start_name,
      endMile: r1(d.end_mile), endName: d.end_name,
      plannedMiles: r1(d.end_mile - d.start_mile),
      nextDayEndMile: next ? r1(next.end_mile) : null,
      speedMph: speed,
      window: { lo: r1(lo), hi: r1(hi) },
      options: options.slice(0, 120),
    };
  }

  // ---- the Day Builder's candidates -------------------------------------------
  // One query for every link in the chain — the next place to WORK, to BREAK,
  // or to SLEEP — measured from the cursor (where the chain has got to, and
  // when), so each pin can say when you would arrive. The bed step blends the
  // hand-researched camping guide with OSM hotels and campgrounds exactly as
  // the sleep chooser does; the builder must not know less than the picker.
  //
  // Off-route limits are the ones each existing chooser already uses (work 3,
  // stop 4, sleep 6): a laptop sit tolerates less detour than a bed.
  const OFF_ROUTE_MI = { work: 3, break: 4, sleep: 6 };

  /** A resolved stop as the payload publishes it: without the walk's wiring. */
  const bare = ({ seq, key, ...rest }) => rest;
  const wifiNearStmt = db.prepare(
    `SELECT COUNT(*) c FROM resources WHERE category_id='wifi_work'
     AND route_mile BETWEEN ? AND ? AND off_route_mi <= 2`
  );

  function buildCandidates(n, { fromMile, fromMin, reachMi, kind = 'work', limit = 60 } = {}) {
    if (!['work', 'break', 'sleep'].includes(kind)) throw new Error('kind must be work, break or sleep');
    const { d, days } = dayRow(n);
    const speed = ridingSpeed();
    const from = fromMile != null && fromMile !== '' ? Number(fromMile) : d.start_mile;
    if (!Number.isFinite(from)) throw new Error('fromMile must be a number');
    const min = fromMin != null && fromMin !== '' ? Number(fromMin) : null;
    if (min != null && !Number.isFinite(min)) throw new Error('fromMin must be a number');
    const next = days.find((x) => x.day_number === d.day_number + 1) ?? null;
    const reach = reachMi != null && reachMi !== '' ? Number(reachMi) : d.end_mile - from;
    const lim = Math.max(1, Math.min(200, Number(limit) || 60));
    const cats = kind === 'work' ? ['wifi_work'] : kind === 'sleep' ? ['hotel', 'campground'] : ['wifi_work', 'campground', 'hotel'];
    const maxOff = OFF_ROUTE_MI[kind];
    const base = planner.stopCandidates({
      dayNumber: d.day_number, fromMile: from, fromMin: min, reachMi: reach, cats, limit: lim * 3,
      // a sit "next door" can be a step back along the route; a bed cannot
      behindMi: kind === 'sleep' ? 0 : 1,
      maxOffRouteMi: maxOff,
    });
    const rideTo = base.rideToMin ?? null;
    const direction = (mile) => {
      const delta = mile - d.end_mile;
      return delta > 2 ? 'farther' : delta < -2 ? 'earlier' : 'on_plan';
    };

    const out = base.candidates
      .filter((c) => (c.offRouteMi ?? 0) <= maxOff)
      .map((c) => ({
        id: c.resourceId, kind: 'resource', name: c.name, brand: c.brand, type: c.category,
        routeMile: c.routeMile, offRouteMi: c.offRouteMi, lat: c.lat, lng: c.lng,
        // consequence, measured from the CURSOR, not the day start
        milesFromStart: c.rideMiles, rideMinFromStart: c.rideMinutes, behind: !!c.behind,
        arriveMin: c.arriveMin, arriveClock: c.arriveClock,
        beforeWorkOpen: c.beforeWorkOpen, minsLateForWork: c.minsLateForWork, lightLeftMin: c.lightLeftMin,
        deltaMi: r1(c.routeMile - d.end_mile), direction: direction(c.routeMile),
        detour: (c.offRouteMi ?? 0) > 1.5,
        wifiStatus: c.wifiStatus, hours: c.hours, address: c.address, phone: c.phone, website: c.website,
        ...planner.placeOf(c.lat, c.lng, c.routeMile),
        price: null, tier: c.category === 'hotel' ? 'room' : c.category === 'campground' ? 'unknown' : undefined,
        wifiNear: 0, confidence: null,
        newDayMiles: r1(c.routeMile - d.start_mile),
        nextDayMiles: next ? r1(next.end_mile - c.routeMile) : null,
        score: c.score,
      }));

    if (kind === 'sleep') {
      // Curated camping-guide spots (the hand-researched gold), same as sleepOptions.
      for (const s of camping.spotsNear(from, -0.05, Math.max(0, base.farthestMile - from))) {
        const rideMin = Math.round(rideMinutes(from, s.routeMile, speed));
        const arriveMin = min != null ? Math.round(min + rideMin) : null;
        out.push({
          id: s.id, kind: 'camp', name: s.name, type: s.type ?? 'campground',
          routeMile: r1(s.routeMile), offRouteMi: null, lat: s.lat, lng: s.lng,
          milesFromStart: r1(s.routeMile - from), rideMinFromStart: rideMin,
          arriveMin, arriveClock: arriveMin != null ? clock12(arriveMin) : null,
          beforeWorkOpen: null, minsLateForWork: null,
          lightLeftMin: arriveMin != null && rideTo != null ? rideTo - arriveMin : null,
          deltaMi: r1(s.routeMile - d.end_mile), direction: direction(s.routeMile), detour: false,
          price: s.price ?? null, priceNote: s.priceNote ?? null, tier: s.tier,
          water: !!s.water, showers: !!s.showers, toilets: !!s.toilets, tentsOk: s.tentsOk !== false,
          legalityNote: s.legalityNote ?? null, cyclistIntel: s.cyclistIntel ?? null,
          seasonalNote: s.seasonalNote ?? null, booking: s.booking ?? null,
          website: s.website ?? null, phone: s.phone ?? null,
          sources: s.sources ?? [], confidence: s.confidence ?? 'medium',
          ...planner.placeOf(s.lat, s.lng, s.routeMile),
          wifiNear: 0,
          newDayMiles: r1(s.routeMile - d.start_mile),
          nextDayMiles: next ? r1(next.end_mile - s.routeMile) : null,
          score: 0,
        });
      }
      for (const o of out) {
        o.wifiNear = wifiNearStmt.get(o.routeMile - 2, o.routeMile + 2).c;
        // Same recommendation shape as the sleep chooser, plus: arriving after
        // the time you said you would stop riding costs a point per half hour.
        o.score = r1(
          10
          - (o.offRouteMi ?? 0) * 2
          + (o.kind === 'camp' ? 3 : 0)
          + (o.confidence === 'high' ? 2 : 0)
          + (o.price === 0 ? 2.5 : o.price != null && o.price <= 15 ? 1.5 : 0)
          + (o.showers ? 0.8 : 0)
          + Math.min(o.wifiNear, 4) * 0.3
          - (o.lightLeftMin != null && o.lightLeftMin < 0 ? Math.min(6, -o.lightLeftMin / 30) : 0)
        );
      }
    } else if (kind === 'break') {
      for (const o of out) o.score = r1(5 - (o.offRouteMi ?? 0) * 2);
    }
    out.sort((a, b) => b.score - a.score || a.rideMinFromStart - b.rideMinFromStart);

    return {
      dayNumber: d.day_number, kind, speedMph: speed,
      fromMile: r1(from), fromMin: min, reachTo: base.reachTo,
      startMile: r1(d.start_mile), startName: d.start_name,
      endMile: r1(d.end_mile), endName: d.end_name,
      farthestMile: base.farthestMile, nextDayEndMile: next ? r1(next.end_mile) : null,
      workOpenMin: base.workOpenMin ?? null, rideToMin: rideTo,
      candidates: out.slice(0, lim),
    };
  }

  // ---- "Help me make this fit" -------------------------------------------------
  // Deterministic structured proposals over the canonical plan. Every option
  // carries its diff and its assumptions; nothing applies without Accept.
  function fitOptions(n) {
    const { d, days } = dayRow(n);
    const model = modelFor(d);
    if (!model) return { dayNumber: n, options: [], note: 'Set a start date first.' };
    const speed = ridingSpeed();
    const shape = dayShape();
    const options = [];
    const deficitMi = Math.max(0, Math.round((model.rideH - model.usableH) * speed));
    const idx = days.findIndex((x) => x.day_number === d.day_number);
    const following = days.slice(idx + 1).filter((x) => x.status === 'planned');

    const feasibleForDay = (day) => {
      const date = dateForDay(startDate(), day.day_number);
      const { effort } = effortMiles(day.start_mile, day.end_mile);
      const t = planner.dayTimes(day.day_number);
      const m = daylight.dayModel({
        date, startMile: day.start_mile, endMile: day.end_mile,
        effortMi: effort, speedMph: speed,
        departH: t.departH, workStartH: t.workStartH, rideUntilH: t.rideUntilH,
      });
      return { model: m, capMi: Math.min(shape.maxMiles, Math.floor(m.usableH * speed)) };
    };

    // Option A — shorten today to what daylight allows, land on a real bed,
    // and push the shaved miles FORWARD along the chain. Miles can only move
    // past a day by shifting its endpoint, and a day with a chosen bed keeps
    // its endpoint — so the walk shifts bed-less days and stops at the first
    // fixed bed, which absorbs whatever is left. Every consequence is in the
    // diff; nothing lands silently.
    if (deficitMi > 2 && following.length) {
      const feasibleMi = Math.max(10, (d.end_mile - d.start_mile) - deficitMi);
      const sugs = planner.suggestEndpoints(d.start_mile, feasibleMi, 12, { ignoreCap: true })
        .filter((s) => s.routeMile < d.end_mile - 1);
      const anchor = sugs[0] ?? null;
      const newEnd = anchor ? anchor.routeMile : r1(d.start_mile + feasibleMi);
      const shaved = r1(d.end_mile - newEnd);
      const dowOf = (dayNum) => {
        const date = dateForDay(startDate(), dayNum);
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${date}T12:00:00Z`).getUTCDay()];
      };

      const diff = [{
        dayNumber: d.day_number,
        endMile: r1(newEnd),
        endName: anchor ? (anchor.town?.startsWith('Mile ') ? anchor.name : anchor.name) : nameNearMile(newEnd),
        overnightResourceId: anchor?.resourceId ?? null,
        fromMiles: r1(d.end_mile - d.start_mile), toMiles: r1(newEnd - d.start_mile),
      }];
      const lines = [`Stop ${shaved} mi earlier${anchor ? ` — sleep at ${anchor.name}` : ''}`];
      const assumptions = anchor ? [] : ['No verified bed at the new endpoint — endpoint is a bare mile'];

      let remaining = shaved;
      let prevEnd = newEnd;
      let overloaded = null;
      for (const day of following.slice(0, 6)) {
        if (remaining <= 0.5) break;
        const { capMi } = feasibleForDay(day);
        const origMiles = day.end_mile - day.start_mile;
        const hasBed = !!(day.overnight_resource_id || day.overnight_camp_id);
        if (hasBed) {
          // Fixed endpoint: this day absorbs everything still in flight.
          const newMiles = r1(day.end_mile - prevEnd);
          lines.push(`Day ${day.day_number} (${dowOf(day.day_number)}) grows to ${newMiles} mi — bed at ${day.overnight_name ?? day.end_name} kept`);
          if (newMiles > capMi + 2) overloaded = { dayNumber: day.day_number, newMiles, capMi: r1(capMi) };
          remaining = 0;
          break;
        }
        // Bed-less day: shift its end back too, keeping what it can absorb.
        const room = Math.max(0, capMi - origMiles);
        const absorb = Math.min(remaining, room);
        const shift = r1(remaining - absorb);
        const dayNewEnd = r1(day.end_mile - shift);
        const newMiles = r1(dayNewEnd - prevEnd);
        diff.push({
          dayNumber: day.day_number, endMile: dayNewEnd,
          endName: shift > 0.5 ? nameNearMile(dayNewEnd) : day.end_name,
          overnightResourceId: shift > 0.5 ? null : day.overnight_resource_id,
          fromMiles: r1(origMiles), toMiles: newMiles,
        });
        if (absorb > 0.5) lines.push(`Day ${day.day_number} (${dowOf(day.day_number)}) takes ${r1(absorb)} mi → ${newMiles} mi`);
        else lines.push(`Day ${day.day_number} shifts back ${shift} mi (still ${newMiles} mi)`);
        prevEnd = dayNewEnd;
        remaining = shift;
      }
      if (remaining > 0.5) lines.push(`⚠ ${remaining} mi still unplaced — needs a longer stretch`);
      else if (!overloaded) lines.push('All riding stays inside daylight');
      if (overloaded) {
        lines.push(`⚠ Day ${overloaded.dayNumber} would exceed its ~${overloaded.capMi} mi daylight capacity`);
        assumptions.push(`Day ${overloaded.dayNumber} runs past comfortable daylight unless its bed moves too`);
      }
      options.push({
        id: 'shorten',
        title: 'Shorten today',
        lines,
        assumptions,
        applyable: true,
        diff,
      });
    }

    // Option B — better-placed work anchor: sit down exactly where the
    // morning light runs out, at the most reliable wi-fi available.
    if (model.workday) {
      const { candidates, idealMile } = workOptions(n);
      const best = candidates.find((c) => c.wifiStatus === 'confirmed')
        ?? candidates.find((c) => c.wifiStatus === 'likely')
        ?? candidates[0];
      const cur = planner.workStopFor(d);
      if (best && (!cur || best.id !== cur.resourceId)) {
        const gainMi = cur
          ? r1(Math.abs(idealMile - cur.routeMile) - Math.abs(idealMile - best.routeMile))
          : null;
        options.push({
          id: 'work',
          title: cur ? 'Better work anchor' : 'Add a work anchor',
          lines: [
            `Work from ${best.name} (mi ${best.routeMile})`,
            `Wi-Fi: ${best.wifiStatus ?? 'unknown'}${best.wifiStatus === 'confirmed' ? ' — documented' : ''}`,
            `Morning ${best.morningMi} mi · afternoon ${best.afternoonMi} mi`,
            ...(gainMi && gainMi > 1 ? [`${gainMi} mi better placed against the daylight split`] : []),
          ],
          assumptions: best.wifiStatus === 'confirmed' ? [] : ['Wi-Fi is not documented — verify before relying on it'],
          applyable: true,
          workStop: { dayNumber: d.day_number, resourceId: best.id },
          diff: [],
        });
      }
    }

    // Option C — redistribute the stretch: spread today's overage evenly over
    // the next two days, respecting their own daylight caps and booked beds.
    if (deficitMi > 2 && following.length >= 2) {
      const targets = following.slice(0, 2);
      const per = Math.ceil(deficitMi / targets.length);
      const diff = [];
      let ok = true;
      let boundary = d.end_mile - deficitMi;
      diff.push({
        dayNumber: d.day_number, endMile: r1(boundary),
        endName: nameNearMile(boundary), overnightResourceId: null,
        fromMiles: r1(d.end_mile - d.start_mile), toMiles: r1(boundary - d.start_mile),
      });
      for (let i = 0; i < targets.length; i++) {
        const day = targets[i];
        if (day.overnight_resource_id || day.overnight_camp_id) { ok = false; break; }
        const give = Math.min(per, deficitMi - per * i);
        const newEnd = i === targets.length - 1 ? day.end_mile : day.end_mile - (deficitMi - per * (i + 1));
        const { capMi } = feasibleForDay(day);
        if (newEnd - boundary > capMi + 3) { ok = false; break; }
        diff.push({
          dayNumber: day.day_number, endMile: r1(newEnd),
          endName: day.end_name, overnightResourceId: day.overnight_resource_id,
          fromMiles: r1(day.end_mile - day.start_mile), toMiles: r1(newEnd - boundary),
        });
        boundary = newEnd;
        if (give <= 0) break;
      }
      if (ok && diff.length > 1) {
        options.push({
          id: 'redistribute',
          title: 'Redistribute the stretch',
          lines: diff.map((x) => `D${x.dayNumber}: ${x.fromMiles} → ${x.toMiles} mi`),
          assumptions: ['Endpoints between beds are bare miles until you pick sleep for them'],
          applyable: true,
          diff,
        });
      }
    }

    // Option D — the moving-meeting hour (informational; the rider decides).
    const canvas = dayCanvas(n);
    if (canvas.movingMeeting) {
      const mm = canvas.movingMeeting;
      options.push({
        id: 'moving-meeting',
        title: 'Moving meeting possibility',
        lines: [
          `Take a ~1h call riding from mi ${mm.fromMile}`,
          `Next reliable work stop: ${mm.stop.name} — ${mm.stop.milesAhead} mi · ~${mm.stop.rideMin} min ahead`,
          `Worth roughly +${mm.gainMi} mi of daylight riding`,
        ],
        assumptions: [
          'Only for a call you can genuinely take from the saddle',
          `Wi-Fi at ${mm.stop.name}: ${mm.stop.wifiStatus}`,
        ],
        applyable: false,
        diff: [],
      });
    }

    return {
      dayNumber: d.day_number,
      deficitMi,
      status: model.status,
      options,
    };
  }

  function applyFitOption(n, optionId) {
    const { options } = fitOptions(n);
    const opt = options.find((o) => o.id === optionId);
    if (!opt) throw new Error(`Option "${optionId}" is no longer available — re-check the previews`);
    if (!opt.applyable) throw new Error('That option is informational, not a plan change');
    if (opt.workStop) {
      planner.setWorkStop(opt.workStop);
      return { ok: true, applied: optionId };
    }
    // Boundary diffs apply in ascending day order; each edit cascades the next
    // day's start automatically (the chain is derived, never stored).
    for (const step of [...opt.diff].sort((a, b) => a.dayNumber - b.dayNumber)) {
      planner.editDayEnd({
        dayNumber: step.dayNumber,
        endMile: step.endMile,
        endName: step.endName,
        overnightResourceId: step.overnightResourceId ?? null,
      });
    }
    return { ok: true, applied: optionId, changedDays: opt.diff.map((x) => x.dayNumber) };
  }

  // ---- one-time import from the retired day-plan document ----------------------
  function dayplanMigration({ apply = false, includeLodging = false } = {}) {
    const raw = settingsGet('dayplanDoc');
    if (!raw) return { present: false, note: 'No old day-plan document found.' };
    let doc;
    try { doc = JSON.parse(raw); } catch { return { present: false, note: 'Old day-plan document unreadable.' }; }
    const docDays = Array.isArray(doc.days) ? doc.days : [];
    if (!docDays.length) return { present: false, note: 'Old day-plan document is empty.' };
    const { days } = activeDays();
    const costImports = [];
    const lodgingDiffs = [];
    for (let i = 0; i < Math.min(docDays.length, days.length); i++) {
      const dd = docDays[i], pd = days[i];
      const lodgeCost = dd.lodging?.cost;
      const misc = dd.miscCost;
      if ((lodgeCost != null && lodgeCost !== 0 && pd.lodging_cost == null)
        || (misc != null && misc !== 0 && pd.misc_cost == null)) {
        costImports.push({
          dayNumber: pd.day_number,
          lodgingCost: lodgeCost != null && lodgeCost !== 0 ? lodgeCost : undefined,
          miscCost: misc != null && misc !== 0 ? misc : undefined,
        });
      }
      if (dd.lodging?.id && dd.lodging.id !== pd.overnight_resource_id && pd.status === 'planned') {
        lodgingDiffs.push({
          dayNumber: pd.day_number,
          docLodging: { id: dd.lodging.id, name: dd.lodging.name, mile: dd.lodging.mile },
          planOvernight: pd.overnight_name ?? null,
        });
      }
    }
    if (apply) {
      for (const c of costImports) planner.setDayCosts(c);
      if (includeLodging) {
        for (const l of lodgingDiffs) {
          try {
            planner.editDayEnd({
              dayNumber: l.dayNumber, endMile: l.docLodging.mile,
              endName: l.docLodging.name, overnightResourceId: l.docLodging.id,
            });
          } catch { /* day since locked or boundary invalid — listed, not forced */ }
        }
      }
    }
    return {
      present: true, applied: apply,
      costImports, lodgingDiffs,
      note: `${costImports.length} day(s) with costs to import · ${lodgingDiffs.length} lodging pick(s) differ from the plan.`,
    };
  }

  return {
    dayCanvas, workOptions, sleepOptions, fitOptions, applyFitOption, dayplanMigration,
    buildCandidates, saveDayChain,
    // the proposal resolvers, shared with the save path so preview == saved
    resolveProposedStops, proposedDay,
  };
}
