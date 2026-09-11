// Ride intel: route intelligence mined from other riders' journals, joined to
// the plan by ROUTE MILE like everything else durable in this app.
//
// Two tiers, and the difference is stated rather than blurred:
//   · ANCHORED  — resolved to a mile against the route's own geometry, so it
//                 can be shown on a day and ahead of you in Ride mode.
//   · REGIONAL  — the journal named no place this route knows. Real advice,
//                 no position. Shown as reference for the state, never as a
//                 "3 miles ahead" warning.
//
// The source journal ran the route BACKWARDS (west→east) and was supported by
// a chase vehicle. Severity is already rated for Nick's direction and his
// loaded bike — it must never be re-rated here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function moduleDir(metaUrl, fallbackSub) {
  try { return path.dirname(fileURLToPath(metaUrl)); }
  catch { return path.join(process.cwd(), fallbackSub); }
}

function findDataFile() {
  const rel = path.join('data', 'intel', 'intel.json');
  const roots = [
    path.join(moduleDir(import.meta.url, 'server'), '..'),
    process.cwd(),
    process.env.LAMBDA_TASK_ROOT,
    '/var/task',
    path.join(process.cwd(), '..'),
  ];
  for (const r of roots) {
    if (!r) continue;
    const p = path.join(r, rel);
    try { if (fs.existsSync(p)) return p; } catch { /* next root */ }
  }
  return path.join(roots[0], rel);
}

const DATA_FILE = findDataFile();

export function makeIntel() {
  let cache = null; // { mtimeMs, data }

  function load() {
    let stat;
    try { stat = fs.statSync(DATA_FILE); } catch { return null; }
    if (!cache || cache.mtimeMs !== stat.mtimeMs) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // A superseded record must never be shown: a later page corrected it.
      data.records = (data.records ?? []).filter((r) => !r.superseded);
      data.anchored = data.records.filter((r) => r.startMile != null && !r.offRoute);
      // Road-scoped: no mile of its own, but the road it names was placed by
      // records that DID anchor. Wider than an anchor and labelled as such.
      data.roadScoped = data.records.filter((r) => r.startMile == null && r.roadMiles && !r.offRoute);
      data.regional = data.records.filter(
        (r) => r.startMile == null && !r.roadMiles && !r.offRoute);
      cache = { mtimeMs: stat.mtimeMs, data };
    }
    return cache.data;
  }

  const sev = (r) => r.severity ?? 0;

  /** Everything anchored that overlaps a mile range, worst first. */
  function forRange(startMile, endMile, { minSeverity = 0 } = {}) {
    const d = load();
    if (!d) return [];
    return d.anchored
      .filter((r) => r.endMile >= startMile && r.startMile <= endMile && sev(r) >= minSeverity)
      .sort((a, b) => sev(b) - sev(a) || a.startMile - b.startMile);
  }

  /** Records whose ROAD overlaps the day, without a mile of their own. */
  function roadFor(startMile, endMile) {
    const d = load();
    if (!d) return [];
    return d.roadScoped
      .filter((r) => r.roadMiles[1] >= startMile && r.roadMiles[0] <= endMile)
      .sort((a, b) => sev(b) - sev(a));
  }

  /** Regional advice for the states a day touches — no position claimed. */
  function regionalFor(states) {
    const d = load();
    if (!d) return [];
    const want = new Set(states.filter(Boolean));
    if (!want.size) return [];
    return d.regional
      .filter((r) => r.state && r.state.split('/').some((s) => want.has(s)))
      .sort((a, b) => sev(b) - sev(a));
  }

  /** Ride mode: what is genuinely ahead of you, within reach. */
  function ahead(mile, withinMi = 45, { minSeverity = 3 } = {}) {
    const d = load();
    if (!d) return [];
    return d.anchored
      .filter((r) => sev(r) >= minSeverity && r.endMile >= mile && r.startMile <= mile + withinMi)
      .map((r) => ({
        ...r,
        milesAhead: Math.max(0, Math.round((r.startMile - mile) * 10) / 10),
        active: r.startMile <= mile && r.endMile >= mile,
      }))
      .sort((a, b) => a.milesAhead - b.milesAhead || sev(b) - sev(a))
      .slice(0, 8);
  }

  /** Pre-trip checklist: the things the miner said must be verified. */
  function mustVerify() {
    const d = load();
    if (!d) return [];
    return d.records.filter((r) => r.mustVerify);
  }

  function summary() {
    const d = load();
    if (!d) return { ready: false, note: 'No ride intel built — run npm run build:intel.' };
    return {
      ready: true,
      generatedAt: d.generatedAt,
      source: d.source,
      calibration: d.calibration ?? null,
      counts: {
        total: d.records.length,
        anchored: d.anchored.length,
        roadScoped: d.roadScoped.length,
        regional: d.regional.length,
        bySeverity: d.anchored.reduce((acc, r) => {
          const k = r.severity ?? 'unrated';
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      },
      mustVerify: mustVerify(),
    };
  }

  return { forRange, roadFor, regionalFor, ahead, mustVerify, summary, load };
}
