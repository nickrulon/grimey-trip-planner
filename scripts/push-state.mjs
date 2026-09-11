// Push the laptop's authoritative plan state into the cloud store.
// Used to seed a fresh deployment, or to roll the cloud back to a known-good
// local snapshot. Writes the same shape netlify/functions/api.mjs expects.
import { openDb } from './../server/db.mjs';
import fs from 'node:fs';

// Must match STATE_TABLES in netlify/functions/api.mjs — anything missing here
// is silently left at whatever the cloud already had.
const TABLES = [
  'settings', 'plan_revisions', 'planned_days', 'actual_days', 'planned_stops', 'day_plans',
  'route_transits', 'canvas_marks',
];
const db = openDb();
db.pragma('wal_checkpoint(TRUNCATE)');
const tables = {};
for (const t of TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all();
const rev = db.prepare('SELECT id FROM plan_revisions WHERE active=1').get();
db.close();

const out = {
  stamp: `push-${Date.now()}`,
  updatedAt: new Date().toISOString(),
  tables,
};
fs.writeFileSync('/tmp/db-state.json', JSON.stringify(out));
console.log(`state: active rev ${rev?.id}, ${tables.planned_days.length} planned_days rows, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
