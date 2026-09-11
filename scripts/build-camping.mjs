// Assemble data/camping/camping.json from the per-segment research files in
// data/camping/research/. Research is day-keyed (day numbers from the plan
// revision it was researched against); the output is MILE-keyed spots plus
// mile-anchored day advice, so the guide survives replans and renumbering.
//
//   node scripts/build-camping.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

spots.sort((a, b) => a.routeMile - b.routeMile);
dayAdvice.sort((a, b) => a.nearMile - b.nearMile);

const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  planRevisionResearched: 21,
  spots,
  dayAdvice,
  laws,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
const free = spots.filter((s) => s.price === 0).length;
console.log(`camping.json: ${spots.length} spots (${free} free), ${dayAdvice.length} day-advice anchors, laws: ${laws ? 'yes' : 'MISSING'}`);
