// Weather layer (brief §28): National Weather Service forecasts mapped onto
// upcoming planned days, with wind classified against each day's travel
// direction. Free, no key; NWS requires a User-Agent. ~7-day horizon only —
// days beyond it honestly report no forecast rather than inventing one.

const UA = 'grimey-trip-planner (personal trip tool; nicklr@commercient.com)';
const CACHE_MS = 30 * 60 * 1000;

const COMPASS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

function bearingDeg([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Wind blows FROM windFromDeg. Riding along travelDeg:
// wind from ahead = headwind, from behind = tailwind, else crosswind.
function classifyWind(travelDeg, windFromDeg) {
  let diff = Math.abs(travelDeg - windFromDeg) % 360;
  if (diff > 180) diff = 360 - diff;
  if (diff <= 55) return 'headwind';
  if (diff >= 125) return 'tailwind';
  return 'crosswind';
}

const cache = new Map(); // url -> { at, data }
async function getJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`NWS ${res.status} for ${url}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  return data;
}

function dateStrForDay(startDate, dayNumber) {
  const d = new Date(`${startDate}T12:00:00`);
  d.setDate(d.getDate() + dayNumber - 1);
  return d.toISOString().slice(0, 10);
}

// days: [{dayNumber, startPt:[lng,lat], endPt:[lng,lat], endName}]
export async function forecastForDays(startDate, days) {
  const horizon = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const d of days) {
    const date = dateStrForDay(startDate, d.dayNumber);
    const daysOut = (new Date(`${date}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000;
    if (daysOut >= 0 && daysOut <= 6) horizon.push({ ...d, date });
  }
  const byDay = {};
  for (const d of horizon) {
    try {
      // Forecast at the day's midpoint-ish (endpoint biases toward tomorrow's
      // terrain; midpoint represents the riding). NWS wants ≤4 decimals.
      const [lng, lat] = d.endPt;
      const pt = await getJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`);
      const fc = await getJson(pt.properties.forecast);
      const period = fc.properties.periods.find(
        (p) => p.isDaytime && p.startTime.slice(0, 10) === d.date
      );
      if (!period) continue;
      const travelDeg = bearingDeg(d.startPt, d.endPt);
      const windFrom = COMPASS[period.windDirection] ?? null;
      byDay[d.dayNumber] = {
        date: d.date,
        tempF: period.temperature,
        shortForecast: period.shortForecast,
        precipPct: period.probabilityOfPrecipitation?.value ?? null,
        windSpeed: period.windSpeed,
        windDirection: period.windDirection,
        windClass: windFrom == null ? null : classifyWind(travelDeg, windFrom),
        source: 'NWS', retrievedAt: new Date().toISOString(),
      };
    } catch (err) {
      byDay[d.dayNumber] = { date: d.date, error: err.message };
    }
  }
  return byDay;
}
