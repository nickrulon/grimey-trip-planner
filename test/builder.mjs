// Regression tests for the Day Builder's server side: candidates measured from
// a cursor (with arrival times, able to see past the day's planned end), and
// the transactional save of a proposed chain.
//
// Candidate queries are read-only on the live database. Anything that writes
// runs against a THROWAWAY COPY.
//
//   node test/builder.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH, openDb } from '../server/db.mjs';
import { applyMigrations } from '../server/migrate.mjs';
import { makePlanner } from '../server/plan.mjs';
import { makeCamping } from '../server/camping.mjs';
import { makeToday } from '../server/today.mjs';
import { makeIntel } from '../server/intel.mjs';

let pass = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
};
const stack = (db) => {
  const planner = makePlanner(db);
  return { planner, today: makeToday(db, planner, makeCamping(db, planner), makeIntel()) };
};

// ================= candidates (read-only, live DB) ============================
{
  const db = openDb();
  const { planner, today } = stack(db);
  const { days } = planner.activeDays();
  // a workday with room on both sides, and a next day to bump into
  const d = days.find((x) => x.day_number > 1 && x.end_mile - x.start_mile > 40 && days.some((y) => y.day_number === x.day_number + 1));
  const next = days.find((y) => y.day_number === d.day_number + 1);
  const canvas = today.dayCanvas(d.day_number);

  // ---- 1. the old call shape still clamps to the planned end ----------------
  const old = planner.stopCandidates({ dayNumber: d.day_number });
  ok('old signature: candidates exist', old.candidates.length > 0);
  ok('old signature: none past the planned end', old.candidates.every((c) => c.routeMile < d.end_mile));
  ok('old signature: no arrival fields without a clock', old.candidates.every((c) => c.arriveMin === null && c.arriveClock === null));
  ok('old signature: rideMiles measured from the day start', old.candidates.every((c) => Math.abs(c.rideMiles - (c.routeMile - Math.round(d.start_mile * 10) / 10)) < 0.11));

  // ---- 2. reachMi sees past the end, never past the next day's endpoint ------
  const far = planner.stopCandidates({ dayNumber: d.day_number, fromMile: d.start_mile, reachMi: 500, limit: 400 });
  ok('reachMi: candidates past the planned end appear', far.candidates.some((c) => c.routeMile > d.end_mile), `max ${Math.max(...far.candidates.map((c) => c.routeMile))} vs end ${d.end_mile}`);
  ok('reachMi: nothing at or past the next day\'s endpoint', far.candidates.every((c) => c.routeMile < next.end_mile - 0.04), `next end ${next.end_mile}`);
  ok('reachTo reports the cap', Math.abs(far.reachTo - Math.round((next.end_mile - 0.05) * 10) / 10) < 0.11, `${far.reachTo} vs ${next.end_mile}`);

  // ---- 3. the cursor: measured from where the chain has got to ----------------
  const mid = (d.start_mile + d.end_mile) / 2;
  const fromMid = planner.stopCandidates({ dayNumber: d.day_number, fromMile: mid, fromMin: 12 * 60, reachMi: 40, limit: 200 });
  ok('cursor: nothing behind it', fromMid.candidates.every((c) => c.routeMile > mid));
  ok('cursor: ride measured from it', fromMid.candidates.every((c) => Math.abs(c.rideMiles - (c.routeMile - Math.round(mid * 10) / 10)) < 0.11));
  ok('cursor: arrival = clock at cursor + ride', fromMid.candidates.every((c) => c.arriveMin === 12 * 60 + c.rideMinutes));
  ok('cursor: arrival printed like the UI', fromMid.candidates.every((c) => /^\d{1,2}:\d{2}[ap]$/.test(c.arriveClock)), fromMid.candidates[0]?.arriveClock);
  ok('cursor: light left = ride-until − arrival', fromMid.rideToMin != null && fromMid.candidates.every((c) => c.lightLeftMin === fromMid.rideToMin - c.arriveMin));
  ok('cursor: in ride order, nearest first', fromMid.candidates.every((c, i, a) => i === 0 || c.rideMinutes >= a[i - 1].rideMinutes));

  // ---- 4. the work clock -----------------------------------------------------
  if (canvas.sun?.workday) {
    const open = Math.round(canvas.sun.work.localStart * 60);
    const early = planner.stopCandidates({ dayNumber: d.day_number, fromMile: d.start_mile, fromMin: open - 6 * 60, reachMi: 200, limit: 400 });
    ok('workday: workOpenMin reported', early.workOpenMin === open, `${early.workOpenMin} vs ${open}`);
    ok('workday: beforeWorkOpen agrees with the arithmetic', early.candidates.every((c) => c.beforeWorkOpen === (c.arriveMin <= open)));
    ok('workday: minsLateForWork only when late, and exact', early.candidates.every((c) => c.arriveMin <= open ? c.minsLateForWork === null : c.minsLateForWork === c.arriveMin - open));
    ok('workday: some are reachable before the clock and some are not', early.candidates.some((c) => c.beforeWorkOpen) && early.candidates.some((c) => !c.beforeWorkOpen));
  }
  const weekend = days.find((x) => !today.dayCanvas(x.day_number).sun?.workday && x.end_mile - x.start_mile > 20);
  if (weekend) {
    const w = planner.stopCandidates({ dayNumber: weekend.day_number, fromMile: weekend.start_mile, fromMin: 8 * 60, reachMi: 30, limit: 50 });
    ok('weekend: no work clock, so beforeWorkOpen is null', w.workOpenMin === null && w.candidates.every((c) => c.beforeWorkOpen === null && c.minsLateForWork === null));
  }

  // ---- 5. one venue vocabulary ------------------------------------------------
  const wifi = far.candidates.filter((c) => c.category === 'wifi_work');
  const conf = wifi.filter((c) => c.wifiStatus === 'confirmed' && (c.offRouteMi ?? 0) < 0.2);
  const none = wifi.filter((c) => c.wifiStatus === 'none' && (c.offRouteMi ?? 0) < 0.2);
  if (conf.length && none.length) ok('confirmed wi-fi outscores none, like the work chooser', Math.min(...conf.map((c) => c.score)) > Math.max(...none.map((c) => c.score)));

  // ---- 6. buildCandidates: the three links -----------------------------------
  const work = today.buildCandidates(d.day_number, { fromMile: d.start_mile, fromMin: canvas.departMin, kind: 'work' });
  ok('work: only wi-fi stops', work.candidates.every((c) => c.type === 'wifi_work'));
  ok('work: within 3 mi of the route', work.candidates.every((c) => (c.offRouteMi ?? 0) <= 3));
  ok('work: sorted best first', work.candidates.every((c, i, a) => i === 0 || c.score <= a[i - 1].score));
  ok('work: carries the picker fields', work.candidates.every((c) => typeof c.milesFromStart === 'number' && typeof c.rideMinFromStart === 'number' && typeof c.direction === 'string' && typeof c.detour === 'boolean' && c.lat != null && c.lng != null));
  ok('work: arrival on every pin', work.candidates.every((c) => c.arriveClock));

  const sleep = today.buildCandidates(d.day_number, { fromMile: mid, fromMin: 15 * 60, reachMi: 120, kind: 'sleep', limit: 200 });
  ok('sleep: beds only', sleep.candidates.every((c) => c.kind === 'camp' || c.type === 'hotel' || c.type === 'campground'));
  ok('sleep: blends the researched camps', sleep.candidates.some((c) => c.kind === 'camp'), `${sleep.candidates.length} candidates`);
  ok('sleep: camps too are measured from the cursor with an arrival', sleep.candidates.filter((c) => c.kind === 'camp').every((c) => c.routeMile > mid && c.arriveClock && c.milesFromStart > 0));
  ok('sleep: nothing at or past the next day\'s endpoint', sleep.candidates.every((c) => c.routeMile < next.end_mile - 0.04));
  ok('sleep: within 6 mi of the route', sleep.candidates.every((c) => (c.offRouteMi ?? 0) <= 6));
  ok('sleep: consequence fields present', sleep.candidates.every((c) => typeof c.newDayMiles === 'number' && (c.nextDayMiles == null || typeof c.nextDayMiles === 'number')));
  ok('sleep: direction relative to the planned end', sleep.candidates.every((c) => c.direction === (c.deltaMi > 2 ? 'farther' : c.deltaMi < -2 ? 'earlier' : 'on_plan')));
  const late = sleep.candidates.filter((c) => c.lightLeftMin != null && c.lightLeftMin < -60);
  const fine = sleep.candidates.filter((c) => c.kind === 'camp' && c.lightLeftMin != null && c.lightLeftMin > 0);
  if (late.length && fine.length) ok('sleep: arriving after dark costs score', Math.max(...late.filter((c) => c.kind === 'camp').map((c) => c.score), -99) < Math.max(...fine.map((c) => c.score)));

  const brk = today.buildCandidates(d.day_number, { fromMile: d.start_mile, fromMin: canvas.departMin, kind: 'break' });
  ok('break: any place will do', brk.candidates.length >= work.candidates.length);
  ok('rejects an unknown kind', (() => { try { today.buildCandidates(d.day_number, { kind: 'nap' }); return false; } catch { return true; } })());
  ok('rejects a non-numeric cursor', (() => { try { today.buildCandidates(d.day_number, { fromMile: 'abc' }); return false; } catch { return true; } })());
  ok('response names the day and the cap', work.startName && work.endName && typeof work.farthestMile === 'number');
  db.close();
}

// ================= save (throwaway copy) ======================================
// filled in by step 4

console.log(`\nday builder: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('all green');
