// Dump Day Canvas JSON for a spread of days, from the LIVE database and from a
// throwaway copy enriched with the stop shapes the live plan happens not to
// have (breaks, a combo, a rest day, a late arrival). Used to prove a refactor
// of the canvas walk is behaviour-preserving: run before, run after, diff.
//
//   node scripts/canvas-baseline.mjs <outDir>
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

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/canvas-baseline.mjs <outDir>'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });

const stack = (db) => {
  const planner = makePlanner(db);
  return { planner, today: makeToday(db, planner, makeCamping(db, planner), makeIntel()) };
};
const dump = (today, tag, dayNumbers) => {
  for (const n of dayNumbers) {
    const c = today.dayCanvas(n);
    fs.writeFileSync(path.join(out, `${tag}-day${String(n).padStart(2, '0')}.json`), JSON.stringify(c, null, 1));
  }
};

// 1. live, read-only
{
  const db = openDb();
  const { planner, today } = stack(db);
  const last = planner.activeDays().days.at(-1).day_number;
  dump(today, 'live', [1, 2, 3, 5, 9, 12, 19, 39, last]);
  db.close();
}

// 2. enriched copy: every branch of the walk gets exercised
{
  const copy = path.join(os.tmpdir(), `grimey-baseline-${process.pid}.sqlite`);
  const live = new Database(DB_PATH, { readonly: true });
  await live.backup(copy);
  live.close();
  const db = new Database(copy);
  applyMigrations(db);
  const { planner, today } = stack(db);
  // weekend with two breaks
  planner.addBreak({ dayNumber: 1, afterRideMin: 60, dwellMin: 30, note: 'Coffee' });
  planner.addBreak({ dayNumber: 1, afterRideMin: 90, dwellMin: 45, note: 'Swim' });
  // workday with a break before the sit, a combo after it, and a late roll-out
  // so the morning ride arrives after the work clock opens (work_late)
  planner.addBreak({ dayNumber: 2, afterRideMin: 45, dwellMin: 20, note: 'Snack' });
  planner.addCombo({ dayNumber: 2, minutes: 60, name: 'Standup on the bike' });
  planner.setDayTimes({ dayNumber: 3, startTime: '09:30' });
  // workday rolling out at 04:30 whose long morning still arrives late (work_late)
  planner.setDayTimes({ dayNumber: 4, startTime: '04:30' });
  // workday arriving well before the clock: the Buffer (slack) block
  planner.setDayTimes({ dayNumber: 5, startTime: '03:00' });
  // a rest day inserted after day 5; day 6 becomes the rest day
  planner.insertRestDay({ afterDay: 5 });
  // marks that interact with crossings and the mile window
  planner.addMark({ scope: 'mile', routeMile: 86.5, label: 'Boat', shape: 'line', color: 'red', startMin: 930 });
  planner.addMark({ scope: 'day', dayNumber: 2, label: 'Call', shape: 'block', color: 'blue', startMin: 700, endMin: 740 });
  dump(today, 'enriched', [1, 2, 3, 4, 5, 6, 7]);
  db.close();
  for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(f, { force: true });
}

console.log(`wrote ${fs.readdirSync(out).length} canvases to ${out}`);
