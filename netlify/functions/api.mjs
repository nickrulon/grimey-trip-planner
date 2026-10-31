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
import { syncRiderPlaces } from '../../server/rider-places.mjs';
import { applyMigrations } from '../../server/migrate.mjs';

// Everything the rider can change has to round-trip through Blobs, or an edit
// made on the phone is invisible to the next instance. route_transits belongs
// here for the same reason planned_stops does: the rider creates them.
const STATE_TABLES = [
  'settings', 'plan_revisions', 'planned_days', 'actual_days', 'planned_stops', 'day_plans',
  'route_transits', 'canvas_marks', 'rider_places',
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
  return { db, app, handler: serverless(app), loadedStamp: null, etag: null, backupDay: null, bundled: dumpState(db) };
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
      if (!Array.isArray(rows)) continue;   // older blob without this table: keep bundled rows
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

// Pull the first chunk eagerly so a configuration/auth error becomes a proper
// HTTP status instead of a 200 that streams an error string.
function prepend(first, iter) {
  let used = false;
  return { next: async () => { if (!used) { used = true; return first; } return iter.next(); } };
}

export default async (req, context) => {
  ready ??= boot();
  const ctx = await ready;
  const store = getStore({ name: 'trip', consistency: 'strong' });
  const method = req.method.toUpperCase();
  // A POST that only asks a question — the Day Builder's dry-run preview —
  // writes nothing: no key needed, and no state to push afterwards. Saving the
  // whole state blob on every keystroke of a preview would be the wrong kind
  // of durable.
  const pathname = new URL(req.url).pathname.replace(/^\/\.netlify\/functions\/api/, '/api');
  const isWrite = MUTATING.test(method) && !/^\/api\/plan\/day\/\d+\/simulate\/?$/.test(pathname);

  if (isWrite) {
    const expected = process.env.TRIP_WRITE_KEY;
    if (!expected || req.headers.get('x-trip-key') !== expected) {
      return Response.json({ error: 'Enter the trip key on this device to make changes.' }, { status: 401 });
    }
  }

  // Pull shared state in. A failure here must NOT be swallowed on the write
  // path: serving a stale database and then saving it would erase real edits.
  let saved = null, etag = null;
  try {
    const got = await store.getWithMetadata(STATE_KEY, { type: 'json' });
    if (got) { saved = got.data; etag = got.etag ?? null; }
  } catch (err) {
    if (isWrite) {
      return Response.json(
        { error: `Could not read shared trip state, so refusing to overwrite it: ${err.message}` },
        { status: 503 }
      );
    }
  }
  // A write with no readable shared state would be saved on top of whatever
  // this instance happens to hold — the bundled snapshot from deploy day, or
  // a stale copy — and silently erase weeks of logged days. That has happened
  // three times (Oct 4, 8, 16). Refuse instead; reads may still fall back.
  if (isWrite && !saved) {
    return Response.json(
      { error: 'Shared trip state is missing or unreadable right now; refusing to write so nothing is erased. Try again in a minute.' },
      { status: 503 }
    );
  }
  if (saved && saved.stamp !== ctx.loadedStamp) {
    restoreState(ctx.db, saved.tables ?? {});
    syncRiderPlaces(ctx.db);
    ctx.loadedStamp = saved.stamp;
  } else if (!saved && ctx.loadedStamp !== null) {
    // Shared state was cleared: fall back to what shipped for READS, so every
    // instance agrees instead of drifting apart. Writes were refused above.
    restoreState(ctx.db, ctx.bundled);
    syncRiderPlaces(ctx.db);
    ctx.loadedStamp = null;
  }
  ctx.etag = etag;

  // The assistant streams: serverless-http would buffer the whole answer
  // (and the platform would time it out), so it is served straight from the
  // app object as a streaming Response.
  if (method === 'POST' && new URL(req.url).pathname.replace(/^\/\.netlify\/functions\/api/, '') === '/api/assistant') {
    let body = {};
    try { body = await req.json(); } catch { /* empty */ }
    const enc = new TextEncoder();
    let iter;
    try { iter = ctx.app.assistant.stream(body); await iter.next().then((first) => { iter = prepend(first, iter); }); }
    catch (err) { return Response.json({ error: err.message ?? String(err) }, { status: err.status ?? 400 }); }
    const rs = new ReadableStream({
      async pull(c) {
        try { const { value, done } = await iter.next(); if (done) c.close(); else c.enqueue(enc.encode(value)); }
        catch (err) { c.enqueue(enc.encode('\n\n[error: ' + (err.message ?? err) + ']')); c.close(); }
      },
    });
    return new Response(rs, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const res = await ctx.handler(await toEvent(req), context);

  if (isWrite && res.statusCode < 400) {
    // Daily restore point: the first write of each UTC day files the state it
    // found (pre-write) under db-state-bak-YYYY-MM-DD. onlyIfNew keeps the
    // earliest snapshot of the day. Cheap insurance against the next wipe.
    const day = new Date().toISOString().slice(0, 10);
    if (ctx.backupDay !== day) {
      try { await store.setJSON(`${STATE_KEY}-bak-${day}`, saved, { onlyIfNew: true }); } catch { /* best effort */ }
      ctx.backupDay = day;
    }
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = { stamp, updatedAt: new Date().toISOString(), tables: dumpState(ctx.db) };
    // Optimistic concurrency: only overwrite the version this request read.
    // If the phone and the laptop write at the same moment, the loser gets a
    // 409 and nothing is lost; the next request reloads the winner's state.
    const result = await store.setJSON(STATE_KEY, payload, ctx.etag ? { onlyIfMatch: ctx.etag } : {});
    if (result && result.modified === false) {
      ctx.loadedStamp = null;   // force a reload: this instance's db now has an unsaved change
      return Response.json(
        { error: 'The shared plan changed while this was saving (another device wrote first). Reload and try again.' },
        { status: 409 }
      );
    }
    ctx.loadedStamp = stamp;
    ctx.etag = result?.etag ?? null;
  }
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
};
