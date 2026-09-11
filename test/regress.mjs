// Regression tests for the ride-intel pipeline.
//
// These exist because each one is a bug that already happened, or a rule whose
// violation is SILENT — a provenance note pinned to a route mile still renders
// as a hazard, and nothing in the UI would look wrong.
//
//   node test/regress.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { makeGazetteer, resolveRecord } from '../scripts/lib/gazetteer.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0; const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; } else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); }
};

const db = openDb();
const gz = makeGazetteer(db, ROOT);
const src = fs.readFileSync(path.join(ROOT, 'data/intel/ride-intel.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const byId = new Map(src.map((r) => [r.id, r]));
const built = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/intel/intel.json'), 'utf8'));
const builtById = new Map(built.records.map((r) => [r.id, r]));

// ---- 1. needsAnchor:false must NEVER receive a mile -------------------------
// The bug: these records still name towns ("from Sun City West to New River
// Trailhead") but they are DATA CAVEATS, not places — p20-009 says the rider
// was DRIVEN part of the route. The first build pinned it to a route mile.
const fixture = byId.get('p20-009');
ok('p20-009 fixture still exists in the source', !!fixture);
if (fixture) {
  ok('p20-009 is still the needsAnchor:false fixture',
    fixture.loc?.needsAnchor === false, `got ${fixture.loc?.needsAnchor}`);
  ok('p20-009 still names towns (that is what makes it a trap)',
    !!(fixture.loc?.from || fixture.loc?.to));
  const res = resolveRecord(fixture, gz);
  ok('resolver refuses to place p20-009', res.startMile == null, `got ${res.startMile}`);
  const b = builtById.get('p20-009');
  ok('built artifact has no mile for p20-009', !b || b.startMile == null, `got ${b?.startMile}`);
}

// Every needsAnchor:false record, not just the fixture.
const naFalse = src.filter((r) => r.loc?.needsAnchor === false);
ok('there are needsAnchor:false records to check', naFalse.length > 0, `${naFalse.length}`);
for (const r of naFalse) {
  const b = builtById.get(r.id);
  ok(`needsAnchor:false unplaced — ${r.id}`, !b || b.startMile == null, `got ${b?.startMile}`);
}

// ---- 2. scope:region must never collapse to a single mile -------------------
const regional = src.filter((r) => r.scope === 'region');
for (const r of regional) {
  const b = builtById.get(r.id);
  ok(`scope:region unplaced — ${r.id}`, !b || b.startMile == null, `got ${b?.startMile}`);
}

// ---- 3. transferable:false must never reach the warning layer ---------------
const nonTransferable = src.filter((r) => r.transferable === false);
ok('the transferable:false fixture still exists', nonTransferable.length > 0);
for (const r of nonTransferable) {
  ok(`transferable:false dropped from the build — ${r.id}`, !builtById.has(r.id));
}

// ---- 4. superseded records must never render -------------------------------
// A later page disproved these. Showing the original is worse than showing
// nothing: it surfaces a hazard that was checked and found not to exist.
const supersededInBuild = built.records.filter((r) => r.superseded);
ok('amended records are marked superseded', supersededInBuild.length > 0,
  `${supersededInBuild.length}`);

// ---- 5. spans are ordered ascending in Nick's mile system -------------------
// The journal ran west→east and Nick rides east→west; an unordered span fires
// at the wrong end roughly half the time.
for (const r of built.records) {
  if (r.startMile == null || r.endMile == null) continue;
  ok(`span ordered ascending — ${r.id}`, r.endMile >= r.startMile,
    `${r.startMile} → ${r.endMile}`);
}

// ---- 6. no anchor may land outside the route -------------------------------
for (const r of built.records) {
  if (r.startMile == null) continue;
  ok(`anchor within the route — ${r.id}`,
    r.startMile >= 0 && r.endMile <= gz.totalMiles + 1,
    `${r.startMile}–${r.endMile} vs 0–${Math.round(gz.totalMiles)}`);
}

// ---- 7. the state guard: Alpine CA must never resolve as Alpine TX ----------
// The route passes both, 1,400 miles apart.
const alpineTx = gz.resolve('Alpine', 'TX');
const alpineCa = gz.resolve('Alpine', 'CA');
ok('Alpine resolves differently per state, or not at all for the absent one',
  !alpineTx || !alpineCa || Math.abs(alpineTx.mile - alpineCa.mile) < 1
    ? !(alpineTx && alpineCa && Math.abs(alpineTx.mile - alpineCa.mile) < 1 && alpineTx.state !== alpineCa.state)
    : true);
// The mile→state index is waypoint-derived and SPARSE — "distance to the
// nearest marker" measures the index's gaps, not the anchor's correctness. So
// build each state's actual SPAN along the route (stateAtMile forward-fills)
// and assert the anchor falls inside it, with slack for coarse borders. That
// still catches Alpine CA vs Alpine TX, 1,400 miles apart — the failure this
// guard exists for.
const SPAN_SLACK_MI = 40;
const stateSpan = new Map();
for (let m = 0; m <= gz.totalMiles; m += 5) {
  const st = gz.stateAtMile(m);
  if (!st) continue;
  const cur = stateSpan.get(st) ?? { lo: Infinity, hi: -Infinity };
  cur.lo = Math.min(cur.lo, m); cur.hi = Math.max(cur.hi, m);
  stateSpan.set(st, cur);
}
for (const r of built.records) {
  if (r.startMile == null || !r.state) continue;
  const spans = r.state.split('/').map((x) => stateSpan.get(x)).filter(Boolean);
  if (!spans.length) continue; // state never indexed — nothing to assert
  const inside = spans.some((sp) =>
    r.startMile >= sp.lo - SPAN_SLACK_MI && r.startMile <= sp.hi + SPAN_SLACK_MI);
  ok(`anchor inside its claimed state's span — ${r.id}`, inside,
    `claims ${r.state}, landed at mi ${r.startMile}; ${r.state} spans ` +
    spans.map((sp) => `${Math.round(sp.lo)}–${Math.round(sp.hi)}`).join(' / '));
}

// ---- 8. controls: known miles the method must hit --------------------------
const glamis = gz.resolve('Glamis', 'CA');
ok('CONTROL Glamis ≈ route mile 2637',
  !!glamis && Math.abs(glamis.mile - 2637) <= 3,
  glamis ? `got ${glamis.mile.toFixed(1)}` : 'not found');
const dry = builtById.get('p33-005');
ok('CONTROL El Paso→Fort Hancock overlaps the known dry stretch 1689–1789',
  !!dry && dry.startMile != null && dry.endMile >= 1689 && dry.startMile <= 1789,
  dry ? `got ${dry.startMile}–${dry.endMile}` : 'record missing');

db.close();

console.log(`\nride-intel regression: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures.slice(0, 25)) console.log('  ✗', f);
  if (failures.length > 25) console.log(`  …and ${failures.length - 25} more`);
  process.exit(1);
}
console.log('all green');
