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
import { simulateDay } from '../server/today.mjs';

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

  // ---- 6b. "next door": a sit can be a step back along the route; a bed cannot
  const cursor = work.candidates.find((c) => c.routeMile > d.start_mile + 5)?.routeMile ?? mid;
  const nextDoor = today.buildCandidates(d.day_number, { fromMile: cursor, fromMin: 12 * 60, reachMi: 30, kind: 'work', limit: 200 });
  const behind = nextDoor.candidates.filter((c) => c.behind);
  ok('work: candidates up to a mile behind the cursor are offered, flagged', behind.length > 0 && behind.every((c) => c.routeMile <= cursor && c.routeMile >= cursor - 1.01), `${behind.length}`);
  ok('work: a behind candidate rides nothing and arrives now', behind.every((c) => c.milesFromStart === 0 && c.rideMinFromStart === 0 && c.arriveMin === 12 * 60));
  ok('work: nothing more than a mile back', nextDoor.candidates.every((c) => c.routeMile >= cursor - 1.01));
  const bedsBehind = today.buildCandidates(d.day_number, { fromMile: cursor, fromMin: 12 * 60, reachMi: 60, kind: 'sleep', limit: 200 }).candidates.filter((c) => c.routeMile <= cursor);
  ok('sleep: never behind the cursor', bedsBehind.length === 0, `${bedsBehind.length}`);

  const brk = today.buildCandidates(d.day_number, { fromMile: d.start_mile, fromMin: canvas.departMin, kind: 'break' });
  ok('break: any place will do', brk.candidates.length >= work.candidates.length);
  ok('rejects an unknown kind', (() => { try { today.buildCandidates(d.day_number, { kind: 'nap' }); return false; } catch { return true; } })());
  ok('rejects a non-numeric cursor', (() => { try { today.buildCandidates(d.day_number, { fromMile: 'abc' }); return false; } catch { return true; } })());
  ok('response names the day and the cap', work.startName && work.endName && typeof work.farthestMile === 'number');
  db.close();
}

// ================= the walk never goes backwards ==============================
// Regressions from the adversarial review. A stop at a mile already passed —
// a combo rides through the next stop, or the rider goes back to the library
// next door — must happen WHERE THEY ARE, not send the cursor backwards so the
// last leg re-rides the stretch.
{
  const MPH = 11;
  const legMin = (a, b) => Math.round((Math.max(0, b - a) / MPH) * 60);
  const mileAfter = (from, m) => from + (m / 60) * MPH;
  const base = { legMin, mileAfter, departMin: 360, onTheClock: true, workStartMin: 300, workday: true, owedMin: 450 };
  const acct = (r) => r.blocks.reduce((s, b) => s + (b.miles ?? 0), 0);

  const combo = simulateDay({ ...base, startMile: 0, endMile: 60, stops: [
    { type: 'combo', routeMile: 30, dwellMin: 60, name: 'Call', seq: 0 },   // rides 30 -> 41
    { type: 'break', routeMile: 35, dwellMin: 10, name: 'Snack', seq: 1 },  // behind the combo's end
  ] });
  ok('a stop a combo rode past does not re-ride the stretch', Math.abs(acct(combo) - 60) < 0.15, `${acct(combo)} of 60`);
  ok('…and it is placed where the rider actually is', combo.blocks.find((b) => b.kind === 'break').routeMile === 41);
  ok('…and progress stays monotonic', combo.progress.every((s, i, a) => i === 0 || (s.mile >= a[i - 1].mile && s.min >= a[i - 1].min)));

  const back = simulateDay({ ...base, startMile: 0, endMile: 60, stops: [
    { type: 'work', routeMile: 30, dwellMin: 120, name: 'Library', seq: 0 },
    { type: 'work', routeMile: 30.2, dwellMin: 60, name: "McDonald's", seq: 1 },
    { type: 'work', routeMile: 30, dwellMin: 90, name: 'Library again', seq: 2 },
  ] });
  ok('going back next door rides nothing and never rewinds', Math.abs(acct(back) - 60) < 0.15, `${acct(back)} of 60`);
  ok('…all three sits are walked', back.blocks.filter((b) => b.kind === 'work').length === 3);

  // Two stops that round onto the SAME mile keep the order they were composed in.
  const tie = simulateDay({ ...base, startMile: 0, endMile: 60, stops: [
    { type: 'break', routeMile: 30, dwellMin: 15, name: 'SECOND', seq: 1 },
    { type: 'work', routeMile: 30, dwellMin: 120, name: 'FIRST', seq: 0 },
  ] });
  ok('a mile tie is broken by composition order, not array order',
    tie.blocks.filter((b) => b.kind !== 'ride').map((b) => b.label).join('>') === 'FIRST>SECOND',
    tie.blocks.filter((b) => b.kind !== 'ride').map((b) => b.label).join('>'));
}

// ================= save (throwaway copy) ======================================
{
  const copy = path.join(os.tmpdir(), `grimey-builder-test-${process.pid}.sqlite`);
  const live = new Database(DB_PATH, { readonly: true });
  await live.backup(copy);
  live.close();
  const db = new Database(copy);
  applyMigrations(db);
  const { planner, today } = stack(db);
  const { days } = planner.activeDays();
  const d = days.find((x) => x.day_number > 1 && x.end_mile - x.start_mile > 40 && days.some((y) => y.day_number === x.day_number + 1));
  const n = d.day_number;
  const next0 = days.find((y) => y.day_number === n + 1);
  const stopsIn = (lo, hi) => db.prepare(
    `SELECT id, kind, name, route_mile, dwell_min, resource_id FROM planned_stops
     WHERE kind IN ('break','work','combo') AND route_mile > ? AND route_mile < ? ORDER BY route_mile`).all(lo, hi);
  const before = stopsIn(d.start_mile, d.end_mile);
  ok('fixture day has saved work stops to replace', before.length > 0);

  // A chain: ride 45 min → 20 min break; work at a real wi-fi stop for 5h;
  // a 1h combo after it; then a bed PAST the planned end (a researched camp).
  const canvas0 = today.dayCanvas(n);
  const work = today.buildCandidates(n, { fromMile: d.start_mile, fromMin: canvas0.departMin, kind: 'work' })
    .candidates.find((c) => c.routeMile > d.start_mile + 8 && c.routeMile < d.end_mile - 8);
  const beds = today.buildCandidates(n, { fromMile: work.routeMile, fromMin: 15 * 60, reachMi: 120, kind: 'sleep', limit: 200 }).candidates;
  const bed = beds.find((c) => c.kind === 'camp' && c.routeMile > d.end_mile + 3) ?? beds.find((c) => c.routeMile > d.end_mile + 3);
  ok('fixture: a bed past the planned end exists', !!bed, `planned end ${d.end_mile}`);
  const body = {
    stops: [
      { kind: 'break', afterRideMin: 45, dwellMin: 20, name: 'Snack' },
      { kind: 'work', routeMile: work.routeMile, dwellMin: 300, resourceId: work.id },
      { kind: 'combo', dwellMin: 60, name: 'Standup on the bike' },
    ],
    endMile: bed.routeMile,
    end: bed.kind === 'camp' ? { campId: bed.id } : { resourceId: bed.id },
  };

  // ---- 7. preview == saved ------------------------------------------------------
  const preview = today.dayCanvas(n, body);
  const saved = today.saveDayChain(n, body);
  // Canonical (key-sorted) so only VALUES can differ; ids are the one thing
  // allowed to (proposed stops are negative, saved rows are real).
  const canon = (v) => Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
    : v;
  const strip = (c) => canon({
    ...c, preview: undefined, dayCount: undefined,
    // ids differ (proposed stops are negative) and `key` only exists on a
    // preview — it is how the builder maps a block back to its chain entry.
    blocks: c.blocks.map(({ id, key, ...b }) => b),
    breaks: c.breaks.map(({ id, ...b }) => b),
    workStops: c.workStops.map(({ id, ...w }) => w),
    combos: c.combos.map(({ id, ...x }) => x),
    workStop: c.workStop && (({ id, ...w }) => w)(c.workStop),
    workFallbacks: undefined, movingMeeting: undefined,
  });
  const sp = strip(preview), ss = strip(saved);
  ok('PREVIEW == SAVED (everything but the ids)', JSON.stringify(sp) === JSON.stringify(ss),
    Object.keys(sp).filter((k) => JSON.stringify(sp[k]) !== JSON.stringify(ss[k]))
      .map((k) => `${k}: ${JSON.stringify(sp[k]).slice(0, 160)} ≠ ${JSON.stringify(ss[k]).slice(0, 160)}`).join(' | '));
  ok('saved canvas is not a preview', saved.preview === false);
  ok('the chain has the expected shape', JSON.stringify(saved.blocks.map((b) => b.kind)).includes('"break","ride","work","combo"'), saved.blocks.map((b) => b.kind).join());
  ok('proposed stops carried negative ids; saved ones are real rows', preview.blocks.filter((b) => b.id != null).every((b) => b.id < 0) && saved.blocks.filter((b) => b.id != null).every((b) => b.id > 0));

  // ---- 7b. every proposed stop echoes its key, so the client never maps by position
  const keyed = today.dayCanvas(n, { stops: [
    { key: 'aa', kind: 'break', afterRideMin: 30, dwellMin: 15, name: 'One' },
    { key: 'bb', kind: 'work', routeMile: work.routeMile, dwellMin: 60, resourceId: work.id },
  ] });
  const echoed = keyed.blocks.filter((b) => b.kind !== 'ride' && b.kind !== 'slack').map((b) => b.key);
  ok('proposed stops echo their keys onto the blocks', JSON.stringify(echoed) === '["aa","bb"]', JSON.stringify(echoed));
  ok('a saved canvas carries no keys', today.dayCanvas(n).blocks.every((b) => b.key === undefined));
  ok('the payload arrays keep the saved shape (no seq/key leaking)',
    keyed.breaks.every((b) => !('seq' in b) && !('key' in b)) && keyed.workStops.every((w) => !('seq' in w) && !('key' in w)));

  // ---- 8. persisted rows -----------------------------------------------------
  const after = stopsIn(d.start_mile, bed.routeMile);
  ok('old stops gone, chain persisted as 3 rows', after.length === 3 && after.map((s) => s.kind).sort().join() === 'break,combo,work', after.map((s) => s.kind).join());
  ok('the work row keeps its resource', after.find((s) => s.kind === 'work').resource_id === work.id);
  const dNow = planner.activeDays().days.find((x) => x.day_number === n);
  const nextNow = planner.activeDays().days.find((x) => x.day_number === n + 1);
  ok('the endpoint moved to the bed', Math.abs(dNow.end_mile - bed.routeMile) < 0.01, `${dNow.end_mile} vs ${bed.routeMile}`);
  ok('the bed is recorded', bed.kind === 'camp' ? dNow.overnight_camp_id === bed.id : dNow.overnight_resource_id === bed.id);
  ok('the next day now starts at the new end', Math.abs(nextNow.start_mile - bed.routeMile) < 0.01);
  ok('the next day\'s end is untouched', Math.abs(nextNow.end_mile - next0.end_mile) < 0.01);

  // ---- 9. atomic: an invalid end changes NOTHING ------------------------------
  const rowsBefore = stopsIn(d.start_mile, bed.routeMile).map((s) => s.id).join();
  const endBefore = planner.activeDays().days.find((x) => x.day_number === n).end_mile;
  const err = (() => { try { today.saveDayChain(n, { stops: [{ kind: 'break', afterRideMin: 30, dwellMin: 10 }], endMile: next0.end_mile + 5 }); return null; } catch (e) { return e.message; } })();
  ok('an end past the next day is refused', /would pass day/.test(err ?? ''), err);
  ok('…and the stops were not touched', stopsIn(d.start_mile, bed.routeMile).map((s) => s.id).join() === rowsBefore);
  ok('…and the end was not touched', planner.activeDays().days.find((x) => x.day_number === n).end_mile === endBefore);
  const err2 = (() => { try { today.saveDayChain(n, { stops: [{ kind: 'work', routeMile: d.start_mile - 5, dwellMin: 60 }] }); return null; } catch (e) { return e.message; } })();
  ok('a stop outside the day is refused, nothing written', /outside the day/.test(err2 ?? '') && stopsIn(d.start_mile, bed.routeMile).map((s) => s.id).join() === rowsBefore);

  // ---- 10. an empty chain clears the day; a locked day refuses -----------------
  today.saveDayChain(n, { stops: [] });
  ok('empty chain clears the day\'s stops', stopsIn(d.start_mile, bed.routeMile).length === 0);
  ok('…and leaves the endpoint alone', Math.abs(planner.activeDays().days.find((x) => x.day_number === n).end_mile - bed.routeMile) < 0.01);
  planner.recordActual({ dayNumber: 1, endMile: days[0].end_mile - 1, notes: 'test' });
  const locked = (() => { try { today.saveDayChain(1, { stops: [] }); return null; } catch (e) { return e.message; } })();
  ok('a ridden day refuses a new chain', /already been ridden|is done|only planned/.test(locked ?? ''), locked);

  // ---- 11. the chain survives a replan by mile anchoring ------------------------
  today.saveDayChain(n, body);
  const rows = stopsIn(d.start_mile, bed.routeMile).map((s) => [s.kind, Math.round(s.route_mile * 10) / 10, s.dwell_min]);
  planner.replanApply('rebuild');
  const rowsAfter = stopsIn(d.start_mile, bed.routeMile).map((s) => [s.kind, Math.round(s.route_mile * 10) / 10, s.dwell_min]);
  ok('stops survive a replan at their miles', JSON.stringify(rows) === JSON.stringify(rowsAfter));
  const coveringDay = planner.activeDays().days.find((x) => x.start_mile < work.routeMile && x.end_mile > work.routeMile);
  ok('…and whichever day now covers that mile walks them', coveringDay && today.dayCanvas(coveringDay.day_number).blocks.some((b) => b.kind === 'work' && b.routeMile === work.routeMile));

  db.close();
  for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(f, { force: true });
}

console.log(`\nday builder: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('all green');
