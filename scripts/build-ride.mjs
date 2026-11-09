// Build the "ride as ridden" page data: every Strava GPS track of Grimey's
// Great American Trash Tour, stitched into one line, with the stretches the
// phone missed filled in from the planned route (Days 7–8) or routed along
// roads (short dropouts), plus the final planned leg to the Elysian.
//
//   node scripts/build-ride.mjs   → web/public/ride/ride-data.js
//
// Inputs (data/ride/strava/): acts.json = Strava activity metadata for the 47
// trip rides; b1..b4.json = simplified (5 m Douglas-Peucker) GPS tracks pulled
// from Strava's stream endpoint, encoded as Google polylines (precision 5),
// split at GPS gaps (> 1.5 km, or > 300 m across a pause longer than 15 min).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = path.join(ROOT, 'data/ride/strava');
const OUT = path.join(ROOT, 'web/public/ride/ride-data.js');
const UA = 'grimey-trip-planner/1.0 (ride map; nickrulon@gmail.com)';
const MI = 1609.344;
const FT = 3.28084;

// ---- helpers ---------------------------------------------------------------
const dec = (str) => { const out = []; let i = 0, lat = 0, lng = 0; while (i < str.length) { for (const k of [0, 1]) { let sh = 0, res = 0, b; do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); const d = (res & 1) ? ~(res >> 1) : (res >> 1); if (k === 0) lat += d; else lng += d; } out.push([lat / 1e5, lng / 1e5]); } return out; };
const enc = (pts) => { let s = '', pl = 0, pg = 0; const e = (v) => { v = v < 0 ? ~(v << 1) : (v << 1); let r = ''; while (v >= 0x20) { r += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return r + String.fromCharCode(v + 63); }; for (const [la, lo] of pts) { const a = Math.round(la * 1e5), b = Math.round(lo * 1e5); s += e(a - pl) + e(b - pg); pl = a; pg = b; } return s; };
const hav = (a, b) => { const R = 6371000, t = Math.PI / 180; const dLat = (b[0] - a[0]) * t, dLon = (b[1] - a[1]) * t; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const lineLen = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += hav(pts[i - 1], pts[i]); return L; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dp = (pts, tol) => { const n = pts.length; if (n <= 2) return pts.slice(); const lat0 = pts[0][0] * Math.PI / 180; const kx = 111320 * Math.cos(lat0), ky = 110540; const X = pts.map((p) => p[1] * kx), Y = pts.map((p) => p[0] * ky); const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1; const st = [[0, n - 1]]; while (st.length) { const [a, b] = st.pop(); if (b - a < 2) continue; const ax = X[a], ay = Y[a], dx = X[b] - ax, dy = Y[b] - ay, L2 = dx * dx + dy * dy; let md = 0, idx = -1; for (let i = a + 1; i < b; i++) { let t = L2 ? ((X[i] - ax) * dx + (Y[i] - ay) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; const d = Math.hypot(X[i] - (ax + t * dx), Y[i] - (ay + t * dy)); if (d > md) { md = d; idx = i; } } if (md > tol) { keep[idx] = 1; st.push([a, idx], [idx, b]); } } return pts.filter((_, i) => keep[i]); };

// Decode Valhalla's precision-6 shape.
const dec6 = (str) => { const out = []; let i = 0, lat = 0, lng = 0; while (i < str.length) { for (const k of [0, 1]) { let sh = 0, res = 0, b; do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20); const d = (res & 1) ? ~(res >> 1) : (res >> 1); if (k === 0) lat += d; else lng += d; } out.push([lat / 1e6, lng / 1e6]); } return out; };

// Road route between two points. Bicycle costing first (it follows the
// street he was actually on; car costing U-turns around divided highways),
// car costing with highways discouraged as the fallback, and a straight line
// only if both fail or come back absurdly long for the gap.
async function roadRoute(a, b, { costings = ['bicycle', 'auto'] } = {}) {
  const straight = hav(a, b);
  for (const costing of costings) {
    const body = { locations: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }], costing, costing_options: { auto: { use_highways: 0, use_tolls: 0, use_ferry: 0 }, bicycle: { bicycle_type: 'Hybrid', use_roads: 0.7, use_ferry: 0 } }, units: 'miles' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch('https://valhalla1.openstreetmap.de/route', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': UA }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`Valhalla ${r.status}`);
        const j = await r.json();
        const pts = j.trip.legs.flatMap((l) => dec6(l.shape));
        const L = lineLen(pts);
        if (L > 1.8 * straight + 1500) throw new Error(`${costing} route ${(L / MI).toFixed(1)} mi for a ${(straight / MI).toFixed(1)} mi gap`);
        await sleep(250);
        return { pts: dp(pts, 4), m: L, routed: true, costing };
      } catch (err) {
        console.warn(`  ${costing} ${a.map((v) => v.toFixed(4))} → ${b.map((v) => v.toFixed(4))}: ${err.message}`);
        if (/Valhalla 5|fetch failed/.test(err.message) && attempt < 3) { await sleep(1500 * attempt); continue; }
        break;
      }
    }
  }
  console.warn('  using a straight line');
  return { pts: [a, b], m: straight, routed: false };
}

// Elevation gain (3 m hysteresis, like the per-day Strava figure) along a line,
// sampled every ~300 m from Open-Meteo's elevation API.
async function elevGain(pts) {
  const L = lineLen(pts);
  if (L < 2000) return 0;
  const step = Math.max(300, L / 400);
  const samples = [pts[0]]; let acc = 0;
  for (let i = 1; i < pts.length; i++) { acc += hav(pts[i - 1], pts[i]); if (acc >= step) { samples.push(pts[i]); acc = 0; } }
  const alts = [];
  for (let i = 0; i < samples.length; i += 100) {
    const chunk = samples.slice(i, i + 100);
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map((p) => p[0].toFixed(5)).join(',')}&longitude=${chunk.map((p) => p[1].toFixed(5)).join(',')}`;
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try { const r = await fetch(url, { headers: { 'User-Agent': UA } }); if (!r.ok) throw new Error(`open-meteo ${r.status}`); const j = await r.json(); alts.push(...j.elevation); ok = true; } catch (err) { console.warn(`  elevation fetch failed (${err.message})`); await sleep(1500 * attempt); }
    }
    if (!ok) return null;
    await sleep(300);
  }
  let gain = 0, base = alts[0];
  for (const a of alts.slice(1)) { if (a > base + 3) { gain += a - base; base = a; } else if (a < base - 3) base = a; }
  return gain;
}

// ---- inputs ----------------------------------------------------------------
const acts = JSON.parse(fs.readFileSync(path.join(IN, 'acts.json'), 'utf8'));
const tracks = {};
for (const f of ['b1', 'b2', 'b3', 'b4']) for (const t of JSON.parse(fs.readFileSync(path.join(IN, `${f}.json`), 'utf8'))) tracks[t.id] = t;

const db = openDb();
const ROUTE = db.prepare('SELECT lat, lng, mile FROM route_points ORDER BY mile').all();
const projectOnRoute = (p) => { let best = null; for (const q of ROUTE) { const d = hav(p, [q.lat, q.lng]); if (!best || d < best.d) best = { d, mile: q.mile, pt: [q.lat, q.lng] }; } return best; };
const routeBetween = (m0, m1) => ROUTE.filter((q) => q.mile >= m0 && q.mile <= m1).map((q) => [q.lat, q.lng]);

// Where he slept each night (from the trip log), keyed by day number.
const STOPS = {
  1: ['Perdido Key, FL', 'Dauphin Island, AL', 'Dauphin Island Campground, after the Fort Morgan ferry'],
  2: ['Dauphin Island, AL', 'Gautier, MS', 'The Magnolia Inn'],
  3: ['Gautier, MS', 'Bay St. Louis, MS', 'Sunshine RV Park'],
  4: ['Bay St. Louis, MS', 'New Orleans, LA', 'Country Inn & Suites, New Orleans East'],
  5: ['New Orleans, LA', 'LaPlace, LA', 'Colonial RV Park'],
  6: ['LaPlace, LA', 'Convent, LA', 'River Road camp'],
  7: ['Convent, LA', 'Ventress, LA', "Jim's camp on False River"],
  8: ['Ventress, LA', 'Bunkie, LA', 'Bunkie (laundry with the firemen)'],
  9: ['Bunkie, LA', 'Ville Platte, LA', 'Best Western'],
  10: ['Ville Platte, LA', 'Fenton, LA', 'Quiet Oaks RV Park'],
  11: ['Fenton, LA', 'Vinton, LA', 'Snow White Sanctuary'],
  12: ['Vinton, LA', 'Vidor, TX', 'Motel'],
  13: ['Vidor, TX', 'Thicket, TX', 'The beauty salon at Thicket RV Park'],
  14: ['Thicket, TX', 'Montgomery, TX', 'The city park'],
  15: ['Montgomery, TX', 'Navasota, TX', 'Comfort Inn & Suites'],
  16: ['Navasota, TX', 'Yegua Creek Park, TX', 'Lake Somerville campground'],
  17: ['Yegua Creek Park, TX', 'Buescher State Park, TX', 'Screened shelter'],
  18: ['Buescher State Park, TX', 'Austin, TX', 'Austin'],
  19: ['Austin, TX', 'Dripping Springs, TX', 'Holiday Inn'],
  20: ['Dripping Springs, TX', 'Fredericksburg, TX', 'Fredericksburg'],
  21: ['Fredericksburg, TX', 'Vanderpool, TX', 'Lost Maples RV & Camping'],
  22: ['Vanderpool, TX', 'Camp Wood, TX', 'Camp Wood'],
  23: ['Camp Wood, TX', 'Brackettville, TX', 'Fort Clark Springs'],
  24: ['Brackettville, TX', 'Del Rio, TX', 'Del Rio'],
  25: ['Del Rio, TX', 'Del Rio, TX', 'Rest day'],
  26: ['Del Rio, TX', 'Comstock, TX', 'Comstock Motel'],
  27: ['Comstock, TX', 'Langtry, TX', 'Langtry'],
  28: ['Langtry, TX', 'Sanderson, TX', 'Canyons RV Park'],
  29: ['Sanderson, TX', 'Alpine, TX', 'Quality Inn'],
  30: ['Alpine, TX', 'Marfa, TX', 'Marfa'],
  31: ['Marfa, TX', 'Van Horn, TX', 'Van Horn'],
  32: ['Van Horn, TX', 'Van Horn, TX', 'Rest day'],
  33: ['Van Horn, TX', 'Fort Hancock, TX', 'Fort Hancock'],
  34: ['Fort Hancock, TX', 'El Paso, TX', 'El Paso'],
  35: ['El Paso, TX', 'Las Cruces, NM', 'Las Cruces'],
  36: ['Las Cruces, NM', 'Lordsburg, NM', 'Lordsburg KOA'],
  37: ['Lordsburg, NM', 'Bowie, AZ', 'Bowie'],
  38: ['Bowie, AZ', 'Willcox, AZ', 'Willcox'],
  39: ['Willcox, AZ', 'Benson, AZ', 'Benson'],
  40: ['Benson, AZ', 'Tucson, AZ', 'Tucson'],
  41: ['Tucson, AZ', 'Tucson, AZ', 'Days Inn, Tucson City Center'],
  42: ['Tucson, AZ', 'Casa Grande, AZ', 'Pinal County Fairgrounds, Eleven Mile Corner'],
  43: ['Casa Grande, AZ', 'Casa Grande, AZ', 'Super 8'],
  44: ['Casa Grande, AZ', 'Goodyear, AZ', 'Goodyear'],
  45: ['Goodyear, AZ', 'Salome, AZ', 'KOA Journey'],
  46: ['Salome, AZ', 'Mesa Verde, CA', 'Wild camp behind the Chevron'],
  47: ['Mesa Verde, CA', 'Chiriaco Summit, CA', 'Patton Museum dry camp'],
  48: ['Chiriaco Summit, CA', 'Indio, CA', 'Shadow Hills RV Resort'],
  49: ['Indio, CA', 'Banning, CA', 'Banning Stagecoach KOA'],
  50: ['Banning, CA', 'Rancho Cucamonga, CA', "Travis's aunt's place"],
  51: ['Rancho Cucamonga, CA', 'Rancho Cucamonga, CA', 'Rest day'],
  52: ['Rancho Cucamonga, CA', 'Rancho Cucamonga, CA', 'Rest day'],
  53: ['Rancho Cucamonga, CA', 'Rancho Cucamonga, CA', 'Rest day'],
  54: ['Rancho Cucamonga, CA', 'The Elysian Theater, Los Angeles', 'The finish line'],
};
const DAY0 = new Date('2026-09-20T12:00:00Z');
const dateOf = (day) => new Date(DAY0.getTime() + (day - 1) * 86400000).toISOString().slice(0, 10);
const FERRY_TERMINAL = [30.2516119, -88.0819303]; // Mobile Bay Ferry, Dauphin Island side (OSM)
const VENTRESS = [30.6818525, -91.4081679];

// ---- per-day assembly ------------------------------------------------------
const days = [];
const byDay = Object.fromEntries(acts.map((a) => [a.day, a]));
let prevEnd = null;
const connectors = [];
let ferry = null;

for (let day = 1; day <= 54; day++) {
  const [from, to, sleepAt] = STOPS[day];
  const act = byDay[day];
  const d = { day, date: dateOf(day), from, to, sleepAt, kind: 'ride', segs: [], fills: [], notes: [], mi: 0, elevFt: 0, movingSec: 0 };
  if (act) { d.stravaId = act.id; d.title = act.name; d.desc = act.desc; d.flagged = act.flagged; d.movingSec = act.moving; d.mi = act.dist / MI; d.elevFt = act.elev * FT; }

  const t = act && tracks[act.id];
  if (t) {
    let segs = t.segs.map(dec);
    let gaps = t.gaps.slice();
    // Drop one- or two-point spikes bracketed by two huge jumps (a bad GPS fix
    // that jumped 100 km and came straight back) and stitch across them.
    for (let k = segs.length - 2; k >= 1; k--) {
      if (segs[k].length <= 3 && gaps[k - 1] && gaps[k] && hav(gaps[k - 1].from, gaps[k].to) < 500 && Math.min(gaps[k - 1].m, gaps[k].m) > 1500) {
        segs.splice(k, 1); gaps.splice(k - 1, 2);
        segs[k - 1] = segs[k - 1].concat(segs[k]); segs.splice(k, 1);
        d.notes.push('One bad GPS fix (a 60-mile spike) removed.');
      }
    }
    d.prof = t.prof;
    d.segs = segs.map(enc);
    // Fill real dropouts along the road.
    for (let k = 0; k < gaps.length; k++) {
      const g = gaps[k];
      if (g.m < 300) continue;
      const counted = g.sd > 0.5 * g.m; // Strava's distance already spans it
      const r = await roadRoute(g.from, g.to);
      console.log(`D${day}: dropout ${(g.m / MI).toFixed(1)} mi straight → ${(r.m / MI).toFixed(1)} mi by ${r.costing ?? 'straight line'} (${counted ? 'counted by Strava' : 'not counted'})`);
      const fill = { enc: enc(r.pts), mi: r.m / MI, kind: 'dropout', counted, routed: r.routed };
      d.fills.push(fill);
      if (!counted) { d.mi += fill.mi; const gain = await elevGain(r.pts); if (gain) d.elevFt += gain * FT; }
    }
    const uncounted = d.fills.filter((f) => !f.counted).reduce((s, f) => s + f.mi, 0);
    if (uncounted >= 0.5) d.notes.push(`Strava slept through ${uncounted.toFixed(1)} mi mid-ride; that stretch is routed along the road (dashed) and added back.`);
    const start = segs[0][0], end = segs[segs.length - 1].slice(-1)[0];
    d.start = start; d.end = end;
    // Overnight repositioning between where one ride ended and the next began.
    if (prevEnd && day !== 2 && day !== 9) {
      const jump = hav(prevEnd, start);
      if (jump > 800) { const r = await roadRoute(prevEnd, start); connectors.push({ enc: enc(r.pts), mi: r.m / MI, fromDay: prevEnd.day, toDay: day }); console.log(`D${prevEnd.day}→D${day}: ${(r.m / MI).toFixed(1)} mi moved without recording`); }
    }
    prevEnd = Object.assign(end.slice(), { day });
  }

  if (day === 1) {
    // Ferry: Fort Morgan → Dauphin Island (not ridden).
    ferry = { enc: enc([d.end, FERRY_TERMINAL]), mi: hav(d.end, FERRY_TERMINAL) / MI };
    d.notes.push('Ends at the Fort Morgan landing; the Mobile Bay Ferry (dotted) carried the bike across to Dauphin Island.');
  }
  if (day === 2) {
    // Lost morning: ferry terminal → where the recording starts (Bayou La Batre).
    const r = await roadRoute(FERRY_TERMINAL, d.start);
    const fill = { enc: enc(r.pts), mi: r.m / MI, kind: 'lost', counted: false, routed: r.routed };
    d.fills.unshift(fill); d.mi += fill.mi;
    const gain = await elevGain(r.pts); if (gain) d.elevFt += gain * FT;
    d.notes.push(`Strava lost the morning: Dauphin Island → Bayou La Batre (${fill.mi.toFixed(1)} mi, dashed) is routed along AL 193 and AL 188 and added back. Nick logged the day as 55 miles.`);
    console.log(`D2: lost morning ${fill.mi.toFixed(1)} mi`);
  }
  if (day === 7 || day === 8) {
    // No usable GPS either day: follow the planned route (the ACA line he was
    // riding that week) from where Day 6's recording ended to Ventress, then
    // on to where Day 9's recording began in Bunkie.
    const d6end = days[5].end, d9start = tracks[byDay[9].id] ? dec(tracks[byDay[9].id].segs[0])[0] : null;
    const pA = projectOnRoute(d6end), pV = projectOnRoute(VENTRESS), pB = projectOnRoute(d9start);
    let pts;
    if (day === 7) { const r1 = await roadRoute(d6end, pA.pt); const r2 = await roadRoute(pV.pt, VENTRESS); pts = [...r1.pts, ...routeBetween(pA.mile, pV.mile), ...r2.pts]; }
    else { const r1 = await roadRoute(VENTRESS, pV.pt); pts = [...r1.pts, ...routeBetween(pV.mile, pB.mile)]; if (hav(pts[pts.length - 1], d9start) > 50) pts.push(d9start); }
    pts = dp(pts, 4);
    const m = lineLen(pts);
    const gain = await elevGain(pts);
    d.fills.push({ enc: enc(pts), mi: m / MI, kind: 'planned-line', counted: false, routed: true });
    d.start = pts[0]; d.end = pts[pts.length - 1]; d.approx = true;
    if (day === 7) {
      d.mi = 81; d.elevFt = (gain ?? 0) * FT;
      d.notes.push(`Strava fell asleep (it recorded 70.0 mi with no map). The line follows the planned route through Baton Rouge and over the Audubon Bridge (${(m / MI).toFixed(0)} route miles); Nick called the day 81 miles, which is the figure counted here.`);
    } else {
      d.mi = m / MI; d.elevFt = (gain ?? 0) * FT;
      d.notes.push(`No Strava activity this day. The line follows the planned route from False River through Morganza and Simmesport to Bunkie (${(m / MI).toFixed(0)} route miles), where Day 9's recording starts.`);
    }
    prevEnd = Object.assign(d.end.slice(), { day });
    console.log(`D${day}: planned-line fill ${(m / MI).toFixed(1)} mi, gain ${gain == null ? 'n/a' : Math.round(gain * FT) + ' ft'}`);
  }
  if ([25, 32, 51, 52, 53].includes(day)) { d.kind = 'rest'; d.mi = 0; }
  if (day === 41 || day === 43) d.notes.push('Rest day with a short ride around town.');
  if (day === 54) {
    d.kind = 'planned';
    const d50end = days[49].end; const p = projectOnRoute(d50end);
    const r = await roadRoute(d50end, p.pt);
    const pts = dp([...r.pts, ...routeBetween(p.mile, 9999)], 4);
    const m = lineLen(pts); const gain = await elevGain(pts);
    d.fills.push({ enc: enc(pts), mi: m / MI, kind: 'planned', counted: false, routed: true });
    d.mi = m / MI; d.elevFt = (gain ?? 0) * FT; d.start = pts[0]; d.end = pts[pts.length - 1];
    d.notes.push('The last leg, Thursday Nov 12: Foothill Boulevard and the Pacific Electric Trail to Pasadena, then down into Los Angeles to the Elysian. Planned line; it will be replaced by the real track once ridden.');
    console.log(`D54: planned finish ${(m / MI).toFixed(1)} mi, gain ${gain == null ? 'n/a' : Math.round(gain * FT) + ' ft'}`);
  }
  if (d.flagged) d.notes.push('Strava flagged this activity (it was quick).');
  days.push(d);
}

// ---- totals ----------------------------------------------------------------
const ridden = days.filter((d) => d.day <= 50);
const recordedMi = acts.filter((a) => a.latlng).reduce((s, a) => s + a.dist, 0) / MI; // GPS-recorded
const stravaMi = acts.reduce((s, a) => s + a.dist, 0) / MI; // everything Strava shows, incl. Day 7's manual entry
const totalMi = ridden.reduce((s, d) => s + d.mi, 0);
const elevFt = ridden.reduce((s, d) => s + d.elevFt, 0);
const movingSec = ridden.reduce((s, d) => s + d.movingSec, 0);
const rideDays = ridden.filter((d) => d.kind === 'ride' && d.mi >= 15).length;
const longest = ridden.reduce((b, d) => (d.mi > b.mi ? d : b), ridden[0]);
const out = {
  generatedAt: new Date().toISOString(),
  totals: { recordedMi, stravaMi, totalMi, estimatedMi: totalMi - recordedMi, elevFt, movingSec, rideDays, restDays: ridden.length - rideDays, calendarDays: ridden.length, longest: { day: longest.day, mi: longest.mi }, plannedMi: days[53].mi, connectorsMi: connectors.reduce((s, c) => s + c.mi, 0) },
  days: days.map((d) => ({ ...d, mi: +d.mi.toFixed(2), elevFt: Math.round(d.elevFt), start: d.start && d.start.map((v) => +v.toFixed(5)), end: d.end && d.end.map((v) => +v.toFixed(5)), fills: d.fills.map((f) => ({ ...f, mi: +f.mi.toFixed(2) })) })),
  connectors: connectors.map((c) => ({ ...c, mi: +c.mi.toFixed(2) })),
  ferry: ferry && { ...ferry, mi: +ferry.mi.toFixed(2) },
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `window.RIDE=${JSON.stringify(out)};\n`);
console.log(`\nwrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
console.log(`recorded ${recordedMi.toFixed(1)} mi · with fills ${totalMi.toFixed(1)} mi · ${Math.round(elevFt).toLocaleString()} ft · ${(movingSec / 3600).toFixed(0)} h moving · ${rideDays} ride days / ${ridden.length - rideDays} rest · longest D${longest.day} ${longest.mi.toFixed(1)} mi · final leg ${days[53].mi.toFixed(1)} mi`);
