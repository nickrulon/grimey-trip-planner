// The whole trip-planning API, running serverless.
//
// Reference data (route, resources, camping) ships inside the bundle as a
// read-only SQLite file. Everything the rider can change — settings, plan
// revisions, planned days, actuals, stops — is small, so it is mirrored into
// Netlify Blobs after every write and restored on the way in. That keeps the
// engine code identical to the local server while surviving a platform where
// the filesystem is throwaway and instances come and go.
import fs from 'node:fs';
import path from 'node:path';
import serverless from 'serverless-http';
import { getStore } from '@netlify/blobs';
import { openWasmDb } from '../../server/db-wasm.mjs';
import { createApp } from '../../server/app.mjs';
import { applyMigrations } from '../../server/migrate.mjs';

// Everything the rider can change has to round-trip through Blobs, or an edit
// made on the phone is invisible to the next instance. route_transits belongs
// here for the same reason planned_stops does: the rider creates them.
const STATE_TABLES = [
  'settings', 'plan_revisions', 'planned_days', 'actual_days', 'planned_stops', 'day_plans',
  'route_transits', 'canvas_marks',
];
const STATE_KEY = 'db-state';
const MUTATING = /^(POST|PUT|PATCH|DELETE)$/;

function findFile(rel) {
  const roots = [process.cwd(), process.env.LAMBDA_TASK_ROOT, '/var/task', path.join(process.cwd(), '..')];
  for (const r of roots) {
    if (!r) continue;
    const p = path.join(r, rel);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`bundled file not found: ${rel} (cwd=${process.cwd()})`);
}

let ready = null;
async function boot() {
  const dbFile = findFile('data/trip.sqlite');
  const wasmPath = findFile('node_modules/sql.js/dist/sql-wasm.wasm');
  const db = await openWasmDb(fs.readFileSync(dbFile), { wasmPath });
  applyMigrations(db); // the bundled .sqlite may predate this deploy's schema
  const app = createApp(db);
  // Keep the shipped state so an instance can heal itself if the shared store
  // is ever cleared — otherwise a warm instance would keep serving whatever it
  // happened to be holding.
  return { db, handler: serverless(app), loadedStamp: null, bundled: dumpState(db) };
}

function dumpState(db) {
  const out = {};
  for (const t of STATE_TABLES) out[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return out;
}

function restoreState(db, state) {
  db.transaction(() => {
    for (const t of STATE_TABLES) {
      const rows = state[t];
      if (!Array.isArray(rows)) continue;
      db.exec(`DELETE FROM ${t}`);
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]);
      const stmt = db.prepare(
        `INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      );
      for (const r of rows) stmt.run(...cols.map((c) => r[c]));
    }
  })();
}

// Netlify v2 (web-standard) function. v2 is required here, not optional:
// Lambda-style handlers can't do strong-consistency Blobs reads, and without
// those a save on the laptop is invisible to the phone until a cache expires.
// serverless-http speaks the Lambda event shape, so translate at the edges.
async function toEvent(req) {
  const url = new URL(req.url);
  const headers = {};
  req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return {
    httpMethod: req.method,
    path: url.pathname.replace(/^\/\.netlify\/functions\/api/, '/api') || '/api',
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.text(),
    isBase64Encoded: false,
    rawUrl: req.url,
  };
}

export default async (req, context) => {
  ready ??= boot();
  const ctx = await ready;
  const store = getStore({ name: 'trip', consistency: 'strong' });
  const method = req.method.toUpperCase();

  if (MUTATING.test(method)) {
    const expected = process.env.TRIP_WRITE_KEY;
    if (!expected || req.headers.get('x-trip-key') !== expected) {
      return Response.json({ error: 'Enter the trip key on this device to make changes.' }, { status: 401 });
    }
  }

  // Pull shared state in. A failure here must NOT be swallowed on the write
  // path: serving a stale database and then saving it would erase real edits.
  let saved = null;
  try {
    saved = await store.get(STATE_KEY, { type: 'json' });
  } catch (err) {
    if (MUTATING.test(method)) {
      return Response.json(
        { error: `Could not read shared trip state, so refusing to overwrite it: ${err.message}` },
        { status: 503 }
      );
    }
  }
  if (saved && saved.stamp !== ctx.loadedStamp) {
    restoreState(ctx.db, saved.tables ?? {});
    ctx.loadedStamp = saved.stamp;
  } else if (!saved && ctx.loadedStamp !== null) {
    // Shared state was cleared: fall back to what shipped, so every instance
    // agrees instead of drifting apart.
    restoreState(ctx.db, ctx.bundled);
    ctx.loadedStamp = null;
  }

  const res = await ctx.handler(await toEvent(req), context);

  if (MUTATING.test(method) && res.statusCode < 400) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await store.setJSON(STATE_KEY, {
      stamp, updatedAt: new Date().toISOString(), tables: dumpState(ctx.db),
    });
    ctx.loadedStamp = stamp;
  }
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
};
