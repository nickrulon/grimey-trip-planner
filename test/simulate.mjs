// Unit tests for the pure day walk — simulateDay() in server/today.mjs.
//
// No database: legs ride a flat 11 mph, so every expected minute below can be
// checked by hand. Each case is a shape the Day Builder has to get right, and
// the last one is the rider's own 19-hour example, which must come out red.
//
//   node test/simulate.mjs
import { simulateDay, minAtMile } from '../server/today.mjs';

let pass = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
};

const MPH = 11;
const legMin = (a, b) => Math.round((Math.max(0, b - a) / MPH) * 60);
const mileAfter = (from, minutes) => from + (minutes / 60) * MPH;
const base = { legMin, mileAfter, departMin: 6 * 60 };
const kinds = (r) => r.blocks.map((b) => b.kind);
const monotonic = (p) => p.every((s, i) => i === 0 || (s.mile >= p[i - 1].mile && s.min >= p[i - 1].min));

// ---- weekend, two breaks ----------------------------------------------------
{
  const r = simulateDay({
    ...base, startMile: 0, endMile: 44, stops: [
      { type: 'break', routeMile: 11, dwellMin: 30, name: 'Coffee' },
      { type: 'break', routeMile: 22, dwellMin: 45, name: 'Swim' },
    ],
    workday: false, rideToMin: 19 * 60, duskMin: 19 * 60,
  });
  ok('weekend shape', JSON.stringify(kinds(r)) === '["ride","break","ride","break","ride"]', kinds(r).join());
  ok('first leg is an hour', r.blocks[0].startMin === 360 && r.blocks[0].endMin === 420 && r.blocks[0].miles === 11);
  ok('break starts on arrival and lasts its dwell', r.blocks[1].startMin === 420 && r.blocks[1].endMin === 450);
  ok('labels: Ride / Ride on', r.blocks[0].label === 'Ride' && r.blocks[2].label === 'Ride on');
  // 44 mi = 240 min riding + 75 dwell → home 11:15
  ok('arrives home when the arithmetic says', r.arriveEnd === 360 + 240 + 75, String(r.arriveEnd));
  ok('no conflict on a day that fits', r.conflict === null);
  ok('no work credit on a weekend', r.workCredit === 0);
  ok('progress is monotonic', monotonic(r.progress));
  ok('minAtMile inside a leg interpolates', Math.abs(minAtMile(r.progress, 5.5) - 390) < 0.01, String(minAtMile(r.progress, 5.5)));
  ok('minAtMile at a break returns the ARRIVAL, not the departure', minAtMile(r.progress, 11) === 420);
  ok('minAtMile past a break accounts for its dwell', Math.abs(minAtMile(r.progress, 16.5) - (450 + 30)) < 0.01);
  ok('minAtMile before the start is the start', minAtMile(r.progress, -3) === 360);
  ok('minAtMile past the end is the end', minAtMile(r.progress, 99) === r.arriveEnd);
}

// ---- stops arrive out of order and are walked by mile -----------------------
{
  const r = simulateDay({
    ...base, startMile: 0, endMile: 33, stops: [
      { type: 'break', routeMile: 22, dwellMin: 10, name: 'Second' },
      { type: 'break', routeMile: 11, dwellMin: 10, name: 'First' },
    ],
  });
  ok('stops are sorted by mile', r.blocks[1].label === 'First' && r.blocks[3].label === 'Second');
}

// ---- workday, one sit, arriving early → Buffer -------------------------------
{
  const r = simulateDay({
    ...base, startMile: 0, endMile: 44,
    stops: [{ id: 7, type: 'work', routeMile: 11, dwellMin: 450, name: 'Library' }],
    onTheClock: true, workStartMin: 8 * 60, firstWorkMile: 11, workday: true, owedMin: 450,
    rideToMin: 19 * 60 + 14, duskMin: 19 * 60 + 14,
  });
  ok('early arrival waits for the clock', JSON.stringify(kinds(r)) === '["ride","slack","work","ride"]', kinds(r).join());
  ok('the Buffer spans arrival → work start', r.blocks[1].startMin === 420 && r.blocks[1].endMin === 480);
  ok('work starts ON the clock, not on arrival', r.blocks[2].startMin === 480 && r.blocks[2].endMin === 930);
  ok('work block carries its id and mile', r.blocks[2].id === 7 && r.blocks[2].routeMile === 11);
  ok('leg labels split around the work stop', r.blocks[0].label === 'Morning ride' && r.blocks[3].label === 'Afternoon ride');
  ok('work credit is the sit', r.workCredit === 450);
  ok('no conflict: 33 mi after 15:30 lands 18:30', r.conflict === null && r.arriveEnd === 930 + 180, String(r.arriveEnd));
  ok('waiting happens standing still: mile 11 is reached at 7:00, not smeared', minAtMile(r.progress, 11) === 420);
  ok('the mile after the sit is timed after the sit', Math.abs(minAtMile(r.progress, 22) - (930 + 60)) < 0.01);
}

// ---- workday, arriving late → work_late --------------------------------------
{
  const r = simulateDay({
    ...base, departMin: 7 * 60 + 30, startMile: 0, endMile: 30,
    stops: [{ type: 'work', routeMile: 22, dwellMin: 450, name: 'Library' }],
    onTheClock: true, workStartMin: 8 * 60, firstWorkMile: 22, workday: true, owedMin: 450,
    rideToMin: 21 * 60, duskMin: 21 * 60,
  });
  // 22 mi = 120 min → arrive 9:30, 90 late
  ok('late arrival is flagged', r.conflict?.kind === 'work_late' && r.conflict.overMin === 90, JSON.stringify(r.conflict));
  ok('no Buffer when late', !kinds(r).includes('slack'));
  ok('work starts on arrival when late', r.blocks[1].startMin === 570);
}

// ---- combo: on the clock AND moving ------------------------------------------
{
  const r = simulateDay({
    ...base, startMile: 0, endMile: 66,
    stops: [
      { id: 1, type: 'work', routeMile: 22, dwellMin: 390, name: 'Library' },
      // combos sit at their work stop's (rounded) mile, as addCombo places them
      { id: 2, type: 'combo', routeMile: 22, dwellMin: 60, name: 'Standup' },
    ],
    onTheClock: true, workStartMin: 8 * 60, firstWorkMile: 22, workday: true, owedMin: 450,
    rideToMin: 22 * 60, duskMin: 22 * 60,
  });
  ok('combo follows the sit', JSON.stringify(kinds(r)) === '["ride","work","combo","ride"]', kinds(r).join());
  const combo = r.blocks[2];
  ok('combo covers 11 miles in its hour', combo.miles === 11 && combo.routeMile === 22);
  ok('combo minutes count as work', r.workCredit === 450);
  ok('the last leg starts where the combo ended', r.blocks[3].miles === 66 - 33);
  ok('progress stays monotonic through a moving work block', monotonic(r.progress));
  ok('a mile inside the combo is timed inside it', (() => {
    const t = minAtMile(r.progress, 27.5); return t > combo.startMin && t < combo.endMin;
  })());
}

// ---- Buffer before a COMBO: the wait must not smear over its miles ------------
{
  const r = simulateDay({
    ...base, startMile: 0, endMile: 44,
    stops: [{ type: 'combo', routeMile: 5.5, dwellMin: 60, name: 'Call from the saddle' }],
    onTheClock: true, workStartMin: 8 * 60, firstWorkMile: null, workday: true, owedMin: 450,
  });
  // arrive 6:30, wait to 8:00, then ride the hour
  ok('combo waits for the clock', kinds(r)[1] === 'slack' && r.blocks[2].startMin === 480);
  ok('mile 5.5 is reached at 6:30 and left at 8:00', minAtMile(r.progress, 5.5) === 390
    && Math.abs(minAtMile(r.progress, 11) - 510) < 0.01, `${minAtMile(r.progress, 5.5)} / ${minAtMile(r.progress, 11)}`);
}

// ---- weekend work stop kept as wi-fi: not walked, but still names the legs ---
{
  const r = simulateDay({
    ...base, startMile: 0, endMile: 44, stops: [],
    onTheClock: false, firstWorkMile: 22, workday: false,
  });
  ok('one leg, labelled Ride', kinds(r).length === 1 && r.blocks[0].label === 'Ride');
}
{
  const r = simulateDay({ ...base, startMile: 0, endMile: 44, stops: [], workday: true });
  ok('a workday with nothing set says so', r.blocks[0].label === 'Ride (no work stop set)');
}

// ---- daylight and dark ---------------------------------------------------------
{
  const r = simulateDay({
    ...base, startMile: 0, endMile: 110, stops: [],
    rideToMin: 19 * 60, duskMin: 19 * 60,
  });
  // 110 mi = 600 min → 16:00; fits
  ok('a long flat day that fits has no conflict', r.conflict === null);
  const late = simulateDay({ ...base, startMile: 0, endMile: 165, stops: [], rideToMin: 19 * 60, duskMin: 19 * 60 });
  // 165 mi = 900 min → 21:00, 120 over
  ok('past the ride-until time is a daylight conflict', late.conflict?.kind === 'daylight' && late.conflict.overMin === 120, JSON.stringify(late.conflict));
  const lights = simulateDay({ ...base, startMile: 0, endMile: 165, stops: [], rideToMin: 22 * 60, duskMin: 19 * 60, rideUntilOverridden: true });
  ok('allowed by the rider but after dusk is dark, not daylight', lights.conflict?.kind === 'dark' && lights.conflict.overMin === 120, JSON.stringify(lights.conflict));
  ok('the daylight message names the rider\'s own time when they set it',
    simulateDay({ ...base, startMile: 0, endMile: 165, stops: [], rideToMin: 20 * 60, duskMin: 19 * 60, rideUntilOverridden: true }).conflict.detail.includes('you set'));
}

// ---- a late-arrival day that ALSO runs past dusk reports the later problem ---
{
  const r = simulateDay({
    ...base, departMin: 7 * 60 + 30, startMile: 0, endMile: 88,
    stops: [{ type: 'work', routeMile: 22, dwellMin: 450, name: 'Library' }],
    onTheClock: true, workStartMin: 8 * 60, firstWorkMile: 22, workday: true, owedMin: 450,
    rideToMin: 19 * 60, duskMin: 19 * 60,
  });
  ok('daylight outranks work_late in the single conflict slot', r.conflict?.kind === 'daylight');
}

// ---- the rider's own example: 25 → 7h → 2 → 1.5h → 5h → 30 ---------------------
// 13.5 hours sitting plus ~5 hours riding is a 19-hour day. It must go red.
{
  const r = simulateDay({
    ...base, startMile: 0, endMile: 57,
    stops: [
      { type: 'work', routeMile: 25, dwellMin: 420, name: 'Library' },
      { type: 'work', routeMile: 27, dwellMin: 90, name: "McDonald's" },
      { type: 'work', routeMile: 27.05, dwellMin: 300, name: 'Library again' },
    ],
    onTheClock: true, workStartMin: 8 * 60, firstWorkMile: 25, workday: true, owedMin: 450,
    rideToMin: 19 * 60 + 14, duskMin: 19 * 60 + 14,
  });
  ok('19-hour day goes red', r.conflict?.kind === 'daylight', JSON.stringify(r.conflict));
  ok('…by hours, not minutes', r.conflict.overMin > 300, String(r.conflict.overMin));
  ok('work credit shows the 13.5 hours of sitting', r.workCredit === 810);
  ok('home after midnight is still a number the canvas can draw', r.arriveEnd > 24 * 60);
}

console.log(`\nsimulateDay: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log('  ✗', f);
  process.exit(1);
}
console.log('all green');
