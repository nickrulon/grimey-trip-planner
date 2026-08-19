// Rider-note ingestion: projects data/route/notes.json anchors ([lng,lat]
// points or spans) onto route miles and loads route_notes. Idempotent —
// wipes and reloads, so edit notes.json and re-run.
// Usage: node scripts/ingest-notes.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { haversineMi } from './lib/geo.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { notes } = JSON.parse(fs.readFileSync(path.join(root, 'data/route/notes.json'), 'utf8'));

const db = openDb();
const ref = [];
{
  let nextAt = -1;
  for (const p of db.prepare(`SELECT lat, lng, mile FROM route_points ORDER BY mile`).all()) {
    if (p.mile >= nextAt) { ref.push(p); nextAt = p.mile + 0.25; }
  }
}
if (!ref.length) { console.error('No route loaded — run ingest:route first.'); process.exit(1); }

function mileAt([lng, lat]) {
  let best = null, bestD = Infinity;
  for (const p of ref) {
    const d = haversineMi([lng, lat], [p.lng, p.lat]);
    if (d < bestD) { bestD = d; best = p; }
  }
  return { mile: best.mile, offMi: bestD };
}

db.exec('DELETE FROM route_notes');
const ins = db.prepare(
  `INSERT INTO route_notes (kind, title, detail, start_mile, end_mile, source, confidence)
   VALUES (?,?,?,?,?,?,?)`
);

let warned = 0;
for (const n of notes) {
  let start, end;
  if (n.at) {
    const p = mileAt(n.at);
    if (p.offMi > 5) { console.warn(`  ⚠ "${n.title}" anchor is ${p.offMi.toFixed(1)} mi off route`); warned++; }
    start = end = p.mile;
  } else {
    const a = mileAt(n.span[0]);
    const b = mileAt(n.span[1]);
    start = Math.min(a.mile, b.mile);
    end = Math.max(a.mile, b.mile);
    if (Math.max(a.offMi, b.offMi) > 5) { console.warn(`  ⚠ "${n.title}" span endpoint off route`); warned++; }
  }
  ins.run(n.kind, n.title, n.detail, start, end, n.source ?? null, n.confidence ?? 'medium');
  console.log(`mi ${start.toFixed(0).padStart(4)}–${end.toFixed(0).padEnd(4)} [${n.kind.padEnd(11)}] ${n.title}`);
}
console.log(`\n${notes.length} notes loaded${warned ? `, ${warned} anchor warning(s)` : ''}.`);
db.close();
