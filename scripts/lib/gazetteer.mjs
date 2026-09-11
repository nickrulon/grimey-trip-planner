// Shared place resolver for the ride-intel dataset.
//
// The builder and the anchor pilot MUST resolve identically — they drifted once
// already (the pilot enforced a filter the builder didn't), so the logic lives
// here and both import it.
//
// Everything resolves against the route's OWN geometry: route_places (OSM towns
// already carrying a route mile and coordinates) plus the corridor waypoints.
// A mile is never eyeballed.
import fs from 'node:fs';
import path from 'node:path';

const R_EARTH = 3958.8;
const rad = (d) => (d * Math.PI) / 180;
export const havMi = ([lng1, lat1], [lng2, lat2]) => {
  const dLa = rad(lat2 - lat1), dLn = rad(lng2 - lng1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLn / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
};
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

export function makeGazetteer(db, root) {
  // Route sampled every ~0.2 mi — the surface everything projects onto.
  const refPts = [];
  {
    let nextAt = -1;
    for (const p of db.prepare(`SELECT lat, lng, mile FROM route_points ORDER BY mile`).all()) {
      if (p.mile >= nextAt) { refPts.push(p); nextAt = p.mile + 0.2; }
    }
  }
  const totalMiles = db.prepare(`SELECT total_miles FROM routes WHERE id='personal'`).get()?.total_miles ?? 0;

  function project(lng, lat) {
    let best = null, bestD = Infinity;
    for (const p of refPts) {
      const d = havMi([lng, lat], [p.lng, p.lat]);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { mile: best.mile, offMi: bestD } : null;
  }

  // ---- state by mile, from the corridor waypoints -------------------------
  const wp = JSON.parse(fs.readFileSync(path.join(root, 'data/route/waypoints.json'), 'utf8'));
  const stateMarks = [];
  const gaz = new Map();
  const add = (name, mile, lat, lng, off, src) => {
    if (!name || mile == null) return;
    const k = String(name).toLowerCase().trim();
    if (!gaz.has(k)) gaz.set(k, []);
    gaz.get(k).push({ name, mile, lat, lng, off: off ?? 0, src });
  };

  for (const leg of wp.reconLegs ?? []) {
    for (const t of leg.towns ?? []) {
      if (!t.lnglat) continue;
      const pr = project(t.lnglat[0], t.lnglat[1]);
      if (!pr || pr.offMi > 15) continue;
      const clean = t.name.replace(/\s*\(.*\)$/, '').replace(/,?\s+[A-Z]{2}$/, '');
      add(clean, pr.mile, t.lnglat[1], t.lnglat[0], pr.offMi, 'waypoint');
      if (t.state) stateMarks.push({ mile: pr.mile, state: t.state });
    }
  }
  const OSM_SEG_STATE = { 'st-fl': 'FL', 'st-al': 'AL', 'st-la-w': 'LA', 'st-az-w': 'AZ' };
  for (const seg of db.prepare(`SELECT id, start_mile FROM route_segments`).all()) {
    if (OSM_SEG_STATE[seg.id]) stateMarks.push({ mile: seg.start_mile, state: OSM_SEG_STATE[seg.id] });
  }
  stateMarks.sort((a, b) => a.mile - b.mile);
  function stateAtMile(mile) {
    let cur = null;
    for (const m of stateMarks) { if (m.mile > mile + 8) break; cur = m.state; }
    return cur;
  }
  for (const p of db.prepare(`SELECT name, route_mile, lat, lng, off_route_mi FROM route_places`).all()) {
    add(p.name, p.route_mile, p.lat, p.lng, p.off_route_mi, 'place');
  }
  for (const [, cands] of gaz) for (const c of cands) c.state = stateAtMile(c.mile);

  /** The candidate keys worth trying for a journal place string, best first. */
  function nameKeys(raw) {
    const s = String(raw ?? '').trim();
    if (!s || /^unknown/i.test(s)) return [];
    const out = [];
    const push = (v) => {
      const k = String(v).toLowerCase().trim();
      if (k && !out.includes(k)) out.push(k);
    };
    push(s);
    push(s.replace(/\s+[A-Z]{2}$/, ''));           // "Lordsburg NM"
    push(s.replace(/,\s*[A-Z]{2}$/, ''));          // "Pensacola, FL"
    push(s.replace(/\s*\(.*?\)/g, ''));
    push(s.replace(/\s+(area|vicinity|region|outskirts|side)$/i, ''));
    push(s.replace(/^near\s+/i, ''));
    if (s.includes(',')) {
      const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
      push(parts[parts.length - 1]);
      push(parts[0]);
    }
    for (const part of s.split(/\s*\/\s*/)) {
      push(part);
      push(part.replace(/^(west|east|north|south|downtown|central)\s+/i, ''));
      push(part.replace(/\s+[A-Z]{2}$/, ''));
    }
    return out;
  }

  /** Resolve one place name to a gazetteer entry, guarded by state. */
  function resolve(raw, stateHint) {
    const states = String(stateHint ?? '').split('/').map((x) => x.trim()).filter(Boolean);
    const pick = (cands) => {
      // The route passes BOTH Alpine CA and Alpine TX, 1,400 miles apart, so
      // the state check is not optional.
      const ok = states.length ? cands.filter((c) => c.state && states.includes(c.state)) : cands;
      const pool = ok.length ? ok : (states.length ? [] : cands);
      if (!pool.length) return null;
      return [...pool].sort((a, b) => (a.src === 'place' ? 0 : 1) - (b.src === 'place' ? 0 : 1))[0];
    };
    for (const key of nameKeys(raw)) {
      const hit = gaz.get(key) && pick(gaz.get(key));
      if (hit) return { ...hit, matchedKey: key, exact: key === String(raw).toLowerCase().trim() };
    }
    // Longer official name in the gazetteer than the journal used
    // ("Jacumba" vs "Jacumba Hot Springs").
    for (const key of nameKeys(raw)) {
      if (key.length < 4) continue;
      for (const [gk, cands] of gaz) {
        if (!gk.startsWith(`${key} `)) continue;
        const hit = pick(cands);
        if (hit) return { ...hit, matchedKey: gk, exact: false };
      }
    }
    return null;
  }

  /** A point a given distance and compass bearing from a town, on the route. */
  function offsetFromTown(town, offsetMi, bearing) {
    if (!town || !offsetMi || !bearing) return null;
    const b = String(bearing).toLowerCase();
    let { lat, lng } = town;
    if (lat == null || lng == null) return null;
    const dLat = offsetMi / 69;
    const dLng = offsetMi / (69 * Math.max(0.2, Math.cos(rad(lat))));
    if (b.includes('north')) lat += dLat;
    if (b.includes('south')) lat -= dLat;
    if (b.includes('east')) lng += dLng;
    if (b.includes('west')) lng -= dLng;
    return project(lng, lat);
  }

  return { resolve, offsetFromTown, project, stateAtMile, stateMarks, totalMiles, refPts, nameKeys, gaz };
}

/**
 * Resolve a record's location to a mile range.
 *
 * `anchorsById` supplies already-resolved anchors so `relativeTo` records can
 * offset from them (Iron Creek is 3 mi west of Emory Pass).
 */
export function resolveRecord(rec, gz, anchorsById = new Map()) {
  const loc = rec.loc ?? {};
  const state = loc.state ?? null;

  // `needsAnchor: false` means the record needs NO position — a data caveat or
  // a region-wide rule. Several still name towns, so this must veto outright.
  if (loc.needsAnchor === false || rec.scope === 'region') {
    return { method: 'none', reason: 'needsAnchor:false / scope:region — advice, not a place' };
  }

  const out = (o) => ({ approx: true, ...o });

  // 1. Offset from another anchor — the tightest fix available.
  if (rec.relativeTo && anchorsById.has(rec.relativeTo)) {
    const base = anchorsById.get(rec.relativeTo);
    const off = Number(rec.offsetFromAnchorMi) || 0;
    // West is toward INCREASING Nick-mile (Pensacola = 0 in the east).
    const dir = /west/i.test(loc.offsetBearing ?? rec.offsetBearing ?? '') ? 1
      : /east/i.test(loc.offsetBearing ?? rec.offsetBearing ?? '') ? -1 : 1;
    const m = base.mile + dir * off;
    return out({
      startMile: r1(m), endMile: r1(m), method: 'relative_to_anchor',
      uncertaintyMi: r1((base.uncertaintyMi ?? 1) + 1), approx: true,
      note: `${off} mi ${loc.offsetBearing ?? 'west'} of ${rec.relativeTo}`,
    });
  }

  // 2. A bracketing PAIR of towns — both ends known, so the envelope is real.
  const pair = loc.betweenTowns;
  if (Array.isArray(pair) && pair.length === 2) {
    let a = gz.resolve(pair[0], state), b = gz.resolve(pair[1], state);
    // A state-LINE record inherently spans two states, so a strict state check
    // rejects the town on the far side ("between Duncan AZ and Virden NM" is
    // tagged NM). When one end resolves, retry the other WITHOUT the state
    // constraint and accept it only if it lands nearby — which still rejects
    // the Alpine CA / Alpine TX confusion, 1,400 miles apart.
    // The mile→state index is waypoint-derived and coarse near borders: both
    // Duncan and Virden sit either side of the AZ/NM line but index as AZ, so a
    // record tagged NM rejects BOTH. A bracketing pair validates itself by
    // mutual proximity — two towns named as a bracket and found a few miles
    // apart cannot be the Alpine CA / Alpine TX confusion, 1,400 miles apart.
    const NEIGHBOUR_MI = 80;
    if (a && !b) {
      const loose = gz.resolve(pair[1], null);
      if (loose && Math.abs(loose.mile - a.mile) <= NEIGHBOUR_MI) b = loose;
    } else if (b && !a) {
      const loose = gz.resolve(pair[0], null);
      if (loose && Math.abs(loose.mile - b.mile) <= NEIGHBOUR_MI) a = loose;
    } else if (!a && !b) {
      const la = gz.resolve(pair[0], null), lb = gz.resolve(pair[1], null);
      if (la && lb && Math.abs(la.mile - lb.mile) <= NEIGHBOUR_MI) { a = la; b = lb; }
    }
    if (a && b) {
      const lo = Math.min(a.mile, b.mile), hi = Math.max(a.mile, b.mile);
      return out({
        startMile: r1(lo), endMile: r1(hi), method: 'between_towns',
        // Uncertainty is HALF the envelope: the feature is somewhere inside it.
        uncertaintyMi: r1(Math.max(0.5, (hi - lo) / 2)),
        approx: !(a.exact && b.exact),
        matched: [a.name, b.name],
      });
    }
    // One end known: the gazetteer is missing the other town.
    const one = a ?? b;
    if (one) {
      return out({
        startMile: r1(Math.max(0, one.mile - 6)), endMile: r1(Math.min(gz.totalMiles, one.mile + 6)),
        method: 'between_towns_partial', uncertaintyMi: 6,
        missingTown: a ? pair[1] : pair[0], matched: [one.name],
      });
    }
  }

  // 3. A named town with a distance and compass bearing — real geometry.
  if (loc.nearestTown) {
    const t = gz.resolve(loc.nearestTown, state);
    if (t) {
      if (loc.offsetFromTownMi && loc.offsetBearing) {
        const pr = gz.offsetFromTown(t, Number(loc.offsetFromTownMi), loc.offsetBearing);
        if (pr) {
          return out({
            startMile: r1(pr.mile), endMile: r1(pr.mile), method: 'town_offset',
            // The projected point sits offMi from the route; that is the error.
            uncertaintyMi: r1(Math.max(1, pr.offMi)),
            matched: [t.name],
            note: `${loc.offsetFromTownMi} mi ${loc.offsetBearing} of ${t.name}`,
          });
        }
      }
      const rad2 = loc.extentMi ? Math.min(loc.extentMi, 20) / 2 : 3;
      return out({
        startMile: r1(Math.max(0, t.mile - rad2)), endMile: r1(Math.min(gz.totalMiles, t.mile + rad2)),
        method: 'nearest_town', uncertaintyMi: r1(Math.max(1, (t.off ?? 0) + rad2)),
        matched: [t.name],
      });
    }
  }

  // 4. from → to, the original path.
  const a = loc.from ? gz.resolve(loc.from, state) : null;
  const b = loc.to ? gz.resolve(loc.to, state) : null;
  if (a && b && Math.abs(a.mile - b.mile) > 0.05) {
    // Stored ASCENDING in Nick's mile system: the journal ran the other way, and
    // an unordered span fires at the wrong end half the time.
    return out({
      startMile: r1(Math.min(a.mile, b.mile)), endMile: r1(Math.max(a.mile, b.mile)),
      method: 'both_towns',
      uncertaintyMi: r1(Math.max(a.off ?? 0, b.off ?? 0) + 0.5),
      approx: !(a.exact && b.exact), matched: [a.name, b.name],
    });
  }

  // 5. One named end + the direction rule.
  const one = a ?? b ?? (loc.near ? gz.resolve(loc.near, state) : null);
  if (one) {
    const extent = Number(loc.extentMi);
    if (Number.isFinite(extent) && extent > 0) {
      // extentDirection is DERIVABLE: the journal rider always travelled
      // west→east, so a one-ended span runs from its named end in his
      // direction of travel — toward DECREASING Nick-mile.
      const lo = Math.max(0, one.mile - Math.min(extent, 60));
      return out({
        startMile: r1(lo), endMile: r1(one.mile), method: 'one_town_directed',
        uncertaintyMi: r1(Math.max(1, (one.off ?? 0) + 1)),
        matched: [one.name], note: 'extent applied west→east per the source rule',
      });
    }
    return out({
      startMile: r1(Math.max(0, one.mile - 3)), endMile: r1(Math.min(gz.totalMiles, one.mile + 3)),
      method: 'one_town', uncertaintyMi: r1(Math.max(1, (one.off ?? 0) + 3)),
      matched: [one.name],
    });
  }

  return {
    method: 'none',
    reason: `no place in from="${loc.from ?? ''}" to="${loc.to ?? ''}" near="${loc.near ?? ''}" betweenTowns=${JSON.stringify(loc.betweenTowns ?? null)} matches the route gazetteer`,
  };
}
