// Camping guide: curated, web-researched sleep spots served alongside the plan.
// Spots live in data/camping/camping.json and are MILE-anchored (same rule as
// route notes — days renumber on every replan, a campground doesn't move).
// Each request re-joins spots to the CURRENT active plan, so the guide follows
// replans without any re-ingest.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


// Bundlers that emit CJS leave import.meta.url empty; fall back to the process
// working directory so this module can be bundled for serverless.
function moduleDir(metaUrl, fallbackSub) {
  try {
    return path.dirname(fileURLToPath(metaUrl));
  } catch {
    return path.join(process.cwd(), fallbackSub);
  }
}

// Serverless puts the bundle somewhere the module can't infer from cwd alone,
// and a missing file here does not fail loudly — it silently empties the
// camping research, so a night booked at a researched camp shows no bed at
// all. Try every root the platform is known to use.
function findDataFile() {
  const rel = path.join('data', 'camping', 'camping.json');
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
    try { if (fs.existsSync(p)) return p; } catch { /* try the next root */ }
  }
  return path.join(roots[0], rel); // report the expected path in the error
}

const DATA_FILE = findDataFile();

// A day's candidate window: the rider will stop up to 20 mi short or push up to
// 20 mi past the planned endpoint to reach a real campsite.
const BACK_MI = 20;
const FWD_MI = 20;

function tierOf(price) {
  if (price == null) return 'unknown';
  if (price === 0) return 'free';
  if (price <= 15) return 'budget';
  if (price <= 35) return 'moderate';
  return 'high';
}

export function makeCamping(db, planner) {
  let cache = null; // { mtimeMs, data }

  function loadData() {
    let stat;
    try {
      stat = fs.statSync(DATA_FILE);
    } catch {
      return null; // research not ingested yet
    }
    if (!cache || cache.mtimeMs !== stat.mtimeMs) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      data.spots = (data.spots ?? []).map((s, i) => ({ id: `camp-${i}`, ...s }));
      cache = { mtimeMs: stat.mtimeMs, data };
    }
    return cache.data;
  }

  const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

  function dateForDay(startDate, n) {
    const d = new Date(Date.parse(`${startDate}T12:00:00Z`) + (n - 1) * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function campingResponse() {
    const data = loadData();
    if (!data) {
      return { ready: false, note: 'No camping research ingested yet (data/camping/camping.json missing).' };
    }
    const { rev, days } = planner.activeDays();
    if (!rev) return { ready: false, note: 'No active plan.' };
    const startDate = db.prepare(`SELECT value FROM settings WHERE key='startDate'`).get()?.value;

    const out = days.map((d) => {
      // Never reach back past the day's start: a spot behind this morning's
      // start line belongs to the previous night.
      const lo = Math.max(d.start_mile + 1, d.end_mile - BACK_MI);
      const hi = d.end_mile + FWD_MI;
      const options = data.spots
        .filter((s) => s.routeMile >= lo && s.routeMile <= hi)
        .map((s) => ({ ...s, deltaMi: r1(s.routeMile - d.end_mile), tier: tierOf(s.price) }))
        .sort((a, b) =>
          (a.price ?? Infinity) - (b.price ?? Infinity)
          || Math.abs(a.deltaMi) - Math.abs(b.deltaMi));
      // Research-time advice (bestBet / gap notes) was keyed to a nearby mile;
      // match it to whichever advice anchor sits closest to this day's end.
      const advice = (data.dayAdvice ?? [])
        .filter((a) => Math.abs(a.nearMile - d.end_mile) <= 25)
        .sort((a, b) => Math.abs(a.nearMile - d.end_mile) - Math.abs(b.nearMile - d.end_mile))[0] ?? null;
      const cheapest = options.find((o) => o.price != null) ?? null;
      return {
        dayNumber: d.day_number,
        date: startDate ? dateForDay(startDate, d.day_number) : null,
        status: d.status,
        startMile: r1(d.start_mile), endMile: r1(d.end_mile),
        miles: r1(d.end_mile - d.start_mile),
        endName: d.end_name,
        options,
        cheapestPrice: cheapest?.price ?? null,
        bestBet: advice?.bestBet ?? null,
        gap: advice?.gap ?? options.length === 0,
        gapAdvice: advice?.gapAdvice ?? null,
      };
    });

    const priced = out.filter((d) => d.cheapestPrice != null);
    const summary = {
      nights: out.length,
      nightsWithOptions: out.filter((d) => d.options.length > 0).length,
      freeNights: out.filter((d) => d.cheapestPrice === 0).length,
      gapNights: out.filter((d) => d.gap).length,
      estMinCost: Math.round(priced.reduce((s, d) => s + d.cheapestPrice, 0)),
      pricedNights: priced.length,
    };

    return {
      ready: true,
      generatedAt: data.generatedAt ?? null,
      days: out,
      summary,
      laws: data.laws ?? null,
      spots: {
        type: 'FeatureCollection',
        features: data.spots.map((s) => ({
          type: 'Feature',
          properties: {
            id: s.id, name: s.name, kind: s.type, price: s.price ?? null,
            priceNote: s.priceNote ?? '', tier: tierOf(s.price),
            routeMile: r1(s.routeMile), locationNote: s.locationNote ?? '',
            website: s.website ?? '', phone: s.phone ?? '',
            booking: s.booking ?? '', legalityNote: s.legalityNote ?? '',
            cyclistIntel: s.cyclistIntel ?? '', seasonalNote: s.seasonalNote ?? '',
            confidence: s.confidence ?? 'medium',
            tentsOk: s.tentsOk !== false, water: !!s.water,
            showers: !!s.showers, toilets: !!s.toilets,
            sources: (s.sources ?? []).join(' '),
          },
          geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        })),
      },
    };
  }

  /** Curated spots near a mile — the sleep chooser merges these with OSM beds. */
  function spotsNear(mile, back = BACK_MI, fwd = FWD_MI) {
    const data = loadData();
    if (!data) return [];
    return data.spots
      .filter((s) => s.routeMile >= mile - back && s.routeMile <= mile + fwd)
      .map((s) => ({ ...s, tier: tierOf(s.price) }));
  }

  function spotById(id) {
    const data = loadData();
    return data?.spots.find((s) => s.id === id) ?? null;
  }

  return { campingResponse, spotsNear, spotById };
}
