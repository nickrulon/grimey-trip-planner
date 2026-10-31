// Assemble data/camping/camping.json from the per-segment research files in
// data/camping/research/. Research is day-keyed (day numbers from the plan
// revision it was researched against); the output is MILE-keyed spots plus
// mile-anchored day advice, so the guide survives replans and renumbering.
//
//   node scripts/build-camping.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';
import { haversineMi } from './lib/geo.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH_DIR = path.join(ROOT, 'data', 'camping', 'research');
const OUT = path.join(ROOT, 'data', 'camping', 'camping.json');

const stops = JSON.parse(fs.readFileSync(path.join(RESEARCH_DIR, 'stops.json'), 'utf8'));
const mileForDay = Object.fromEntries(stops.map((s) => [s.day, s.endMile]));

const spots = [];
const dayAdvice = [];
let laws = null;
const seen = new Map(); // dedupe key -> index into spots

const unknownPrice = /unpublished|unknown|not published|unverified|could not/i;

for (const file of fs.readdirSync(RESEARCH_DIR).sort()) {
  if (file === 'stops.json' || !file.endsWith('.json')) continue;
  const data = JSON.parse(fs.readFileSync(path.join(RESEARCH_DIR, file), 'utf8'));
  if (!Array.isArray(data)) {
    if (data.states || data.programs) laws = data;
    continue;
  }
  for (const day of data) {
    const nearMile = mileForDay[day.day];
    if (nearMile == null) {
      console.warn(`${file}: day ${day.day} has no known end mile — skipped advice`);
    } else {
      dayAdvice.push({
        nearMile,
        researchDay: day.day,
        bestBet: day.bestBet ?? null,
        gap: !!day.gap,
        gapAdvice: day.gapAdvice || null,
      });
    }
    for (const o of day.options ?? []) {
      if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng) || !Number.isFinite(o.routeMile)) {
        console.warn(`${file}: dropped "${o.name}" (missing lat/lng/routeMile)`);
        continue;
      }
      // "price: 0" sometimes means "rate unknown", not "free" — null it out so
      // the UI never advertises an unverified $0.
      let price = Number.isFinite(o.price) ? o.price : null;
      if (price === 0 && unknownPrice.test(o.priceNote ?? '')) price = null;
      const spot = { ...o, price, researchDay: day.day };
      const key = `${o.name.toLowerCase().replace(/[^a-z0-9]/g, '')}@${Math.round(o.routeMile / 5)}`;
      const prior = seen.get(key);
      if (prior != null) {
        // Keep whichever record says more.
        if (JSON.stringify(spot).length > JSON.stringify(spots[prior]).length) spots[prior] = spot;
        continue;
      }
      seen.set(key, spots.length);
      spots.push(spot);
    }
  }
}

// Research was written against several route revisions. Any option whose
// coordinates sit far from the CURRENT line (e.g. Emory Pass campgrounds after
// the 2026-10-11 I-10/I-8 retrace) is retired, not shown: a spot pinned at the
// wrong mile is worse than no spot. Mile is also re-derived from the line.
const db = openDb();
const line = db.prepare(`SELECT lat, lng, mile FROM route_points ORDER BY mile`).all().filter((_, i) => i % 6 === 0);
const MAX_OFF_MI = 6;
const retired = [];
const nearest = (lat, lng) => { let b = null, bd = Infinity; for (const p of line) { const d = haversineMi([lng, lat], [p.lng, p.lat]); if (d < bd) { bd = d; b = p; } } return { mile: b.mile, off: bd }; };
for (let i = spots.length - 1; i >= 0; i--) {
  const s = spots[i]; const n = nearest(s.lat, s.lng);
  if (n.off > MAX_OFF_MI) { retired.push({ ...s, retiredReason: `${n.off.toFixed(0)} mi from the current route line` }); spots.splice(i, 1); continue; }
  if (Math.abs(n.mile - s.routeMile) > 2) s.routeMile = +n.mile.toFixed(1);
}
spots.sort((a, b) => a.routeMile - b.routeMile);
dayAdvice.sort((a, b) => a.nearMile - b.nearMile);

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  planRevisionResearched: 21,
  spots,
  dayAdvice,
  laws,
  retired,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const free = spots.filter((s) => s.price === 0).length;
console.log(`camping.json: ${spots.length} spots (${free} free), ${retired.length} retired as off-route, ${dayAdvice.length} day-advice anchors, laws: ${laws ? 'yes' : 'MISSING'}`);
