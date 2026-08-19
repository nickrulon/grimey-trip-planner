// Elevation ingestion: samples the route every ~0.25 mi and fills
// route_points.elevation_m from the USGS NED 10m dataset via opentopodata.org
// (public instance: max 100 locations/request, 1 request/second).
// Usage: node scripts/ingest-elevation.mjs
import { openDb } from '../server/db.mjs';

const DATASET = 'ned10m';
const BATCH = 100;
const SLEEP_MS = 1100;

const db = openDb();
const rows = db.prepare(
  `SELECT segment_id, seq, lat, lng, mile FROM route_points ORDER BY mile`
).all();

const sample = [];
let nextAt = -1;
for (const r of rows) {
  if (r.mile >= nextAt) { sample.push(r); nextAt = r.mile + 0.25; }
}
// Always include the final point.
if (sample[sample.length - 1] !== rows[rows.length - 1]) sample.push(rows[rows.length - 1]);

const todo = sample.filter((r) =>
  db.prepare(`SELECT elevation_m FROM route_points WHERE segment_id=? AND seq=?`)
    .get(r.segment_id, r.seq)?.elevation_m == null
);
console.log(`${sample.length} sample points, ${todo.length} missing elevation`);

const update = db.prepare(
  `UPDATE route_points SET elevation_m=? WHERE segment_id=? AND seq=?`
);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let done = 0, nulls = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  const locations = batch.map((r) => `${r.lat.toFixed(6)},${r.lng.toFixed(6)}`).join('|');
  let results = null;
  for (let attempt = 0; attempt < 3 && !results; attempt++) {
    if (attempt > 0) await sleep(5000);
    try {
      const res = await fetch(`https://api.opentopodata.org/v1/${DATASET}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.status !== 'OK') throw new Error(data.error ?? 'bad status');
      results = data.results;
    } catch (err) {
      console.log(`batch ${i / BATCH + 1}: ${err.message}${attempt < 2 ? ' — retrying' : ' — GIVING UP'}`);
    }
  }
  if (!results) { await sleep(SLEEP_MS); continue; }
  const tx = db.transaction(() => {
    for (let j = 0; j < batch.length; j++) {
      const elev = results[j]?.elevation;
      if (elev == null) { nulls++; continue; }
      update.run(elev, batch[j].segment_id, batch[j].seq);
      done++;
    }
  });
  tx();
  process.stdout.write(`\r${done}/${todo.length} points`);
  await sleep(SLEEP_MS);
}
console.log(`\nDone. ${done} elevations stored, ${nulls} nulls (outside dataset).`);
db.close();
