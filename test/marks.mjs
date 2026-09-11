// Regression tests for canvas marks — the rider's fixed appointments.
//
// Runs against a THROWAWAY COPY of data/trip.sqlite so a replan or a rest-day
// insert here can never touch the live plan. Each case is either a bug that
// already happened or an invariant whose violation is silent: a mark that
// quietly lands on the wrong day still renders perfectly well.
//
//   node test/marks.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH } from '../server/db.mjs';
import { applyMigrations } from '../server/migrate.mjs';
import { makePlanner } from '../server/plan.mjs';
import { makeCamping } from '../server/camping.mjs';
import { makeToday } from '../server/today.mjs';
import { makeIntel } from '../server/intel.mjs';

const copyPath = path.join(os.tmpdir(), `grimey-marks-test-${process.pid}.sqlite`);
// .backup rather than fs.copyFile: the live file is in WAL mode, so a plain
// copy of trip.sqlite alone can miss the newest writes.
{
  const live = new Database(DB_PATH, { readonly: true });
  await live.backup(copyPath);
  live.close();
}
const db = new Database(copyPath);
applyMigrations(db);
const p = makePlanner(db);
const today = makeToday(db, p, makeCamping(db, p), makeIntel());

let pass = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
};
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
// Which day numbers currently show a mark with this label.
const on = (label) => p.activeDays().days
  .filter((d) => today.dayCanvas(d.day_number).marks.some((m) => m.label === label))
  .map((d) => d.day_number);
const dayOf = (n) => p.activeDays().days.find((d) => d.day_number === n);

// ---- 1. a mark never moves when roll-out moves ------------------------------
// The entire reason marks exist. Blocks are time-derived and slide; a mark is
// time-anchored and must not.
{
  const d1 = dayOf(1);
  const m = p.addMark({ scope: 'day', dayNumber: 1, label: 'Fixed', shape: 'block', color: 'red', startMin: 930, endMin: 970 });
  const before = p.dayTimes(1).startTime;
  const at = (t) => { p.setDayTimes({ dayNumber: 1, startTime: t }); return today.dayCanvas(1); };
  const c7 = at('07:00'), c13 = at('13:00');
  ok('ride block slides with roll-out', c7.blocks[0].startMin !== c13.blocks[0].startMin);
  const mk = (c) => c.marks.find((x) => x.id === m.id);
  ok('mark does not slide with roll-out', mk(c7).startMin === 930 && mk(c13).startMin === 930 && mk(c7).endMin === 970);
  p.setDayTimes({ dayNumber: 1, startTime: before });
  p.removeMark({ id: m.id });
  void d1;
}

// ---- 2. day-keyed data follows its ride when days renumber ------------------
// The bug: insertRestDay/removeRestDay shifted day_plans but not canvas_marks,
// so every day-scoped mark after the insertion point landed on the wrong day —
// and on the new rest day, where the UI cannot edit it. merge/split shifted
// neither table.
{
  p.addMark({ scope: 'day', dayNumber: 2, label: 'Dentist', shape: 'line', color: 'red', startMin: 840 });
  p.addMark({ scope: 'day', dayNumber: 4, label: 'Call Mum', shape: 'block', color: 'blue', startMin: 1200, endMin: 1230 });
  const d3 = dayOf(3);
  p.addMark({ scope: 'mile', routeMile: (d3.start_mile + d3.end_mile) / 2, label: 'Mile mark', shape: 'line', color: 'teal', startMin: 600 });
  p.setDayTimes({ dayNumber: 4, startTime: '07:15' });

  p.insertRestDay({ afterDay: 1 });
  ok('rest day inserted as day 2', dayOf(2).end_mile - dayOf(2).start_mile < 0.5);
  ok('Dentist followed its ride to day 3', JSON.stringify(on('Dentist')) === '[3]', `on ${on('Dentist')}`);
  ok('Call Mum followed its ride to day 5', JSON.stringify(on('Call Mum')) === '[5]', `on ${on('Call Mum')}`);
  ok('day_plans followed too (07:15 now on day 5)', p.dayTimes(5).startTime === '07:15', p.dayTimes(5).startTime);
  ok('mile mark on exactly one day after the insert', JSON.stringify(on('Mile mark')) === '[4]', `on ${on('Mile mark')}`);
  ok('a rest day rides no miles, so it shows no mile marks', today.dayCanvas(2).marks.length === 0);

  p.removeRestDay({ dayNumber: 2 });
  ok('Dentist back on day 2 after the rest day is removed', JSON.stringify(on('Dentist')) === '[2]', `on ${on('Dentist')}`);
  ok('Call Mum back on day 4', JSON.stringify(on('Call Mum')) === '[4]', `on ${on('Call Mum')}`);
  ok('07:15 back on day 4', p.dayTimes(4).startTime === '07:15');

  p.mergeDays({ dayNumber: 2 });
  ok('merge: the swallowed day\'s mark lands on the merged day', JSON.stringify(on('Dentist')) === '[2]', `on ${on('Dentist')}`);
  ok('merge: later marks shift down', JSON.stringify(on('Call Mum')) === '[3]', `on ${on('Call Mum')}`);
  ok('merge: later day times shift down', p.dayTimes(3).startTime === '07:15', p.dayTimes(3).startTime);
  ok('merge: mile mark on the merged day', JSON.stringify(on('Mile mark')) === '[2]', `on ${on('Mile mark')}`);

  const m2 = dayOf(2);
  p.splitDay({ dayNumber: 2, atMile: (m2.start_mile + m2.end_mile) / 2 });
  ok('split: later marks shift up', JSON.stringify(on('Call Mum')) === '[4]', `on ${on('Call Mum')}`);
  ok('split: later day times shift up', p.dayTimes(4).startTime === '07:15', p.dayTimes(4).startTime);
  ok('split: the first half keeps its day-scoped marks', JSON.stringify(on('Dentist')) === '[2]', `on ${on('Dentist')}`);
  ok('split: mile mark still on exactly one day', on('Mile mark').length === 1, `on ${on('Mile mark')}`);
}

// ---- 3. a mile-pinned mark follows the mile through a replan ----------------
// The bug: planned_days keeps a completed day's PLANNED miles, so after a short
// day + replan the mark showed on both the ridden day and the day now covering it.
{
  const d1 = dayOf(1);
  const mile = d1.start_mile + (d1.end_mile - d1.start_mile) * 0.9;
  const m = p.addMark({ scope: 'mile', routeMile: mile, label: 'Ferry boat', shape: 'line', color: 'red', startMin: 930 });
  ok('mile mark shows on day 1 before the replan', JSON.stringify(on('Ferry boat')) === '[1]', `on ${on('Ferry boat')}`);
  p.recordActual({ dayNumber: 1, endMile: d1.start_mile + (d1.end_mile - d1.start_mile) * 0.3, notes: 'test: cut short' });
  p.replanApply('rebuild');
  const where = on('Ferry boat');
  ok('after the replan the mark is on exactly one day', where.length === 1, `on ${where}`);
  ok('…and not on the day that was ridden short of it', !where.includes(1), `on ${where}`);
  ok('a completed day lists no crossing it never reached',
    !today.dayCanvas(1).transits.some((t) => t.startMile > dayOf(1).start_mile + (dayOf(1).end_mile - dayOf(1).start_mile) * 0.3 + 0.5));
  void m;
}

// ---- 3b. a mile-pinned mark the ride cannot make is a readiness issue --------
// "Meet the 3:30 boat" stops being a note and becomes a constraint the day is
// checked against. Day-scoped marks have no mile, so they are never checked.
{
  const { days } = p.activeDays();
  const d = days.find((x) => x.day_number > 1 && x.end_mile - x.start_mile > 30);
  const mile = Math.round((d.start_mile + (d.end_mile - d.start_mile) * 0.8) * 10) / 10;
  const c0 = today.dayCanvas(d.day_number);
  ok('fixture day has no missed marks to begin with', c0.missedMarks.length === 0);
  // a mark at the day's very first minute of riding, 80% of the way along: unreachable
  const m = p.addMark({ scope: 'mile', routeMile: mile, label: 'Boat', shape: 'line', color: 'red', startMin: c0.departMin + 1 });
  const c1 = today.dayCanvas(d.day_number);
  ok('unreachable mile mark is reported as missed', c1.missedMarks.length === 1 && c1.missedMarks[0].id === m.id, JSON.stringify(c1.missedMarks));
  ok('…as a mark_missed readiness issue that names the times',
    c1.readiness.issues.some((i) => i.kind === 'mark_missed' && /Boat: reach mi .* at .*, need /.test(i.label)),
    JSON.stringify(c1.readiness.issues));
  ok('…and it is the day\'s headline state', c1.readiness.state === 'mark_missed', c1.readiness.state);
  p.updateMark({ id: m.id, startMin: 23 * 60 + 50 });
  ok('a mark late enough is not missed', today.dayCanvas(d.day_number).missedMarks.length === 0);
  p.updateMark({ id: m.id, scope: 'day', dayNumber: d.day_number, startMin: c0.departMin + 1 });
  ok('a day-scoped mark is never checked (no mile to check)', today.dayCanvas(d.day_number).missedMarks.length === 0);
  p.removeMark({ id: m.id });
  // work_short: a workday whose ONLY sit is two hours (a day with two sits keeps
  // its credit from the other one, and re-anchors on it — correctly)
  const wd = days.find((x) => {
    if (x.day_number <= 1) return false;
    const c = today.dayCanvas(x.day_number);
    return c.sun?.workday && c.workStops.length === 1 && c.combos.length === 0;
  });
  if (wd) {
    const before = today.dayCanvas(wd.day_number).readiness.issues.some((i) => i.kind === 'work_short');
    ok('a full work day is not short', !before);
    const ws = today.dayCanvas(wd.day_number).workStop;
    p.updateStop({ id: ws.id, dwellMin: 120 });
    const c = today.dayCanvas(wd.day_number);
    ok('two hours at the library is a short work day', c.readiness.issues.some((i) => i.kind === 'work_short' && /short by 5h30/.test(i.label)),
      JSON.stringify({ day: wd.day_number, date: c.date, workday: c.sun?.workday, workStop: c.workStop && [c.workStop.id, c.workStop.dwellMin], stops: c.workStops.map((w) => [w.id, w.dwellMin]), work: c.work, issues: c.readiness.issues.map((i) => i.kind) }));
    p.updateStop({ id: ws.id, dwellMin: ws.dwellMin });
    ok('restored', !today.dayCanvas(wd.day_number).readiness.issues.some((i) => i.kind === 'work_short'));
  }
}

// ---- 4. validation refuses what a half-filled form would leak ---------------
{
  ok('mile scope without routeMile rejected', /routeMile required/.test(throws(() => p.addMark({ scope: 'mile', label: 'x', shape: 'line', startMin: 600 })) ?? ''));
  ok('empty start rejected (not silently midnight)', /Start time is missing/.test(throws(() => p.addMark({ scope: 'day', dayNumber: 1, label: 'x', shape: 'line', startMin: '' })) ?? ''));
  ok('block without end rejected', /needs an end time/.test(throws(() => p.addMark({ scope: 'day', dayNumber: 1, label: 'x', shape: 'block', startMin: 600 })) ?? ''));
  ok('end before start rejected', /end after it starts/.test(throws(() => p.addMark({ scope: 'day', dayNumber: 1, label: 'x', shape: 'block', startMin: 600, endMin: 600 })) ?? ''));
  ok('end past 23:59 rejected', /End time must be/.test(throws(() => p.addMark({ scope: 'day', dayNumber: 1, label: 'x', shape: 'block', startMin: 600, endMin: 1440 })) ?? ''));
  ok('unknown colour rejected instead of silently slate', /Unknown colour/.test(throws(() => p.addMark({ scope: 'day', dayNumber: 1, label: 'x', shape: 'line', color: 'GREEN', startMin: 600 })) ?? ''));
  ok('a mile before the trip start rejected', /between/.test(throws(() => p.addMark({ scope: 'mile', routeMile: 1, label: 'x', shape: 'line', startMin: 600 })) ?? ''));
  ok('object label rejected', /must be text/.test(throws(() => p.addMark({ scope: 'day', dayNumber: 1, label: { a: 1 }, shape: 'line', startMin: 600 })) ?? ''));
  ok('unknown day rejected', /No day 999/.test(throws(() => p.addMark({ scope: 'day', dayNumber: 999, label: 'x', shape: 'line', startMin: 600 })) ?? ''));

  const last = p.activeDays().days.at(-1);
  const fin = p.addMark({ scope: 'mile', routeMile: Math.round(last.end_mile * 10) / 10, label: 'Finish beers', shape: 'line', startMin: 1020 });
  ok('finish-line mark at the ROUNDED end mile shows on the last day',
    JSON.stringify(on('Finish beers')) === JSON.stringify([last.day_number]), `on ${on('Finish beers')} vs ${last.day_number}`);
  ok('scope flip mile→day without dayNumber rejected', /dayNumber required/.test(throws(() => p.updateMark({ id: fin.id, scope: 'day' })) ?? ''));
  ok('bad colour on update rejected and the colour kept',
    /Unknown colour/.test(throws(() => p.updateMark({ id: fin.id, color: 'Red' })) ?? '')
      && db.prepare('SELECT color FROM canvas_marks WHERE id=?').get(fin.id).color === 'slate');
  const partial = p.updateMark({ id: fin.id, label: 'Finish beers!' });
  ok('partial update keeps every unsent field', partial.mark.color === 'slate' && partial.mark.startMin === 1020 && partial.mark.shape === 'line');
  const toBlock = p.updateMark({ id: fin.id, shape: 'block', endMin: 1080 });
  ok('line → block takes the new end', toBlock.mark.endMin === 1080);
  const toLine = p.updateMark({ id: fin.id, shape: 'line' });
  ok('block → line clears the end', toLine.mark.endMin === null);
  ok('remove reports what it removed', p.removeMark({ id: fin.id }).removed === 1 && p.removeMark({ id: fin.id }).removed === 0);
}

db.close();
fs.rmSync(copyPath, { force: true });
for (const ext of ['-wal', '-shm']) fs.rmSync(copyPath + ext, { force: true });

console.log(`\ncanvas marks: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('all green');
