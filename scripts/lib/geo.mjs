// Shared geometry helpers. Coordinates are [lng, lat] (GeoJSON order) unless noted.

const R_MI = 3958.7613;

export function haversineMi([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(a));
}

/** Cumulative miles along a coordinate array, starting from `startMile`. */
export function cumulativeMiles(coords, startMile = 0) {
  const miles = [startMile];
  for (let i = 1; i < coords.length; i++) {
    miles.push(miles[i - 1] + haversineMi(coords[i - 1], coords[i]));
  }
  return miles;
}

/** Remove consecutive duplicate coordinates (within ~1m). */
export function dedupeCoords(coords) {
  const out = [];
  for (const c of coords) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev[0] - c[0]) > 1e-5 || Math.abs(prev[1] - c[1]) > 1e-5) {
      out.push(c);
    }
  }
  return out;
}

/**
 * Stitch unordered OSM way geometries into one polyline.
 * ways: [{id, coords: [[lng,lat],...]}]. Starts at the way-endpoint nearest
 * `anchor` and greedily appends the nearest-endpoint unused way, reversing as
 * needed. Jumps larger than `gapWarnMi` are recorded; jumps larger than
 * `maxJumpMi` stop the chain (leftovers reported).
 */
export function stitchWays(ways, anchor, { gapWarnMi = 0.15, maxJumpMi = 15 } = {}) {
  const unused = new Set(ways.map((_, i) => i));
  let bestIdx = -1;
  let bestRev = false;
  let bestD = Infinity;
  for (const i of unused) {
    const w = ways[i];
    const dStart = haversineMi(anchor, w.coords[0]);
    const dEnd = haversineMi(anchor, w.coords[w.coords.length - 1]);
    if (dStart < bestD) { bestD = dStart; bestIdx = i; bestRev = false; }
    if (dEnd < bestD) { bestD = dEnd; bestIdx = i; bestRev = true; }
  }
  if (bestIdx === -1) return { coords: [], gaps: [], leftover: 0 };

  const first = ways[bestIdx];
  let chain = bestRev ? [...first.coords].reverse() : [...first.coords];
  unused.delete(bestIdx);
  const gaps = [];

  while (unused.size > 0) {
    const tail = chain[chain.length - 1];
    let nIdx = -1, nRev = false, nD = Infinity;
    for (const i of unused) {
      const w = ways[i];
      const dStart = haversineMi(tail, w.coords[0]);
      const dEnd = haversineMi(tail, w.coords[w.coords.length - 1]);
      if (dStart < nD) { nD = dStart; nIdx = i; nRev = false; }
      if (dEnd < nD) { nD = dEnd; nIdx = i; nRev = true; }
    }
    if (nIdx === -1 || nD > maxJumpMi) break;
    if (nD > gapWarnMi) {
      const w = ways[nIdx];
      const next = nRev ? w.coords[w.coords.length - 1] : w.coords[0];
      gaps.push({ from: tail, to: next, miles: nD });
    }
    const w = ways[nIdx];
    chain = chain.concat(nRev ? [...w.coords].reverse() : w.coords);
    unused.delete(nIdx);
  }
  return { coords: dedupeCoords(chain), gaps, leftover: unused.size };
}

const SKIP_ROLES = /alternate|spur|connection|link|excursion|approach|detour/i;

/**
 * Extract the trunk path of a (possibly messy) route relation between two
 * anchor points, via Dijkstra over a way-connectivity graph. Way endpoints
 * within ~60 m snap to shared nodes; endpoint pairs within `jumpMi` get
 * penalized jump edges (ferries, data gaps). Robust to unordered members,
 * branches, loops, and stray alternates.
 */
export function extractPath(waysIn, startPt, endPt, { jumpMi = 6 } = {}) {
  const ways = waysIn.filter((w) => !SKIP_ROLES.test(w.role || ''));
  const nodeKey = (c) => `${Math.round(c[1] * 1800)},${Math.round(c[0] * 1800)}`; // ~60m grid
  const nodes = new Map(); // key -> {c, edges: [{to, w, wayIdx, rev, jump}]}
  const getNode = (c) => {
    const k = nodeKey(c);
    if (!nodes.has(k)) nodes.set(k, { k, c, edges: [] });
    return nodes.get(k);
  };
  const wayLen = (coords) => cumulativeMiles(coords).pop();

  ways.forEach((w, i) => {
    const a = getNode(w.coords[0]);
    const b = getNode(w.coords[w.coords.length - 1]);
    const len = wayLen(w.coords);
    a.edges.push({ to: b.k, w: len, wayIdx: i, rev: false, jump: false });
    b.edges.push({ to: a.k, w: len, wayIdx: i, rev: true, jump: false });
  });

  // Jump edges between nearby-but-unsnapped nodes (sorted by lat for pruning).
  const all = [...nodes.values()].sort((x, y) => x.c[1] - y.c[1]);
  const latWindow = jumpMi / 69 + 0.001;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[j].c[1] - all[i].c[1] > latWindow) break;
      const d = haversineMi(all[i].c, all[j].c);
      if (d > 0.001 && d <= jumpMi) {
        all[i].edges.push({ to: all[j].k, w: d * 4, wayIdx: -1, jump: d });
        all[j].edges.push({ to: all[i].k, w: d * 4, wayIdx: -1, jump: d });
      }
    }
  }

  const nearest = (pt) => {
    let best = null, bestD = Infinity;
    for (const n of nodes.values()) {
      const d = haversineMi(pt, n.c);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  };
  const src = nearest(startPt), dst = nearest(endPt);

  // Dijkstra (simple array-based priority selection; graphs here are small).
  const dist = new Map([[src.k, 0]]);
  const prev = new Map();
  const visited = new Set();
  const frontier = new Set([src.k]);
  while (frontier.size) {
    let uk = null, ud = Infinity;
    for (const k of frontier) if (dist.get(k) < ud) { ud = dist.get(k); uk = k; }
    frontier.delete(uk);
    if (uk === dst.k) break;
    visited.add(uk);
    for (const e of nodes.get(uk).edges) {
      if (visited.has(e.to)) continue;
      const nd = ud + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: uk, edge: e });
        frontier.add(e.to);
      }
    }
  }
  if (!prev.has(dst.k) && src.k !== dst.k) {
    return { coords: [], gaps: [], error: 'no path between anchors' };
  }

  // Walk back and emit coordinates.
  const hops = [];
  for (let k = dst.k; k !== src.k; ) {
    const p = prev.get(k);
    hops.unshift(p.edge);
    k = p.from;
  }
  let coords = [src.c];
  const gaps = [];
  for (const e of hops) {
    if (e.wayIdx === -1) {
      gaps.push({ from: coords[coords.length - 1], miles: e.jump });
      coords.push(nodes.get(e.to).c);
    } else {
      const w = ways[e.wayIdx].coords;
      coords = coords.concat(e.rev ? [...w].reverse() : w);
    }
  }
  return { coords: dedupeCoords(coords), gaps, error: null };
}

/**
 * Assemble a route relation's ways using MEMBERSHIP ORDER (route relations are
 * usually member-sorted). Each way is oriented to connect to the chain tail;
 * ways whose nearest endpoint is beyond `skipMi` are skipped (stray alternates),
 * joins between `gapWarnMi` and `skipMi` are recorded as gaps (e.g. ferries).
 * Ways with alternate-ish roles are dropped up front.
 */
export function assembleOrdered(ways, { gapWarnMi = 0.15, skipMi = 6 } = {}) {
  const main = ways.filter((w) => !SKIP_ROLES.test(w.role || ''));
  if (!main.length) return { coords: [], gaps: [], skipped: 0, droppedByRole: ways.length };

  // Orient the first way toward the second.
  let chain;
  if (main.length === 1) {
    chain = [...main[0].coords];
  } else {
    const w0 = main[0].coords, w1 = main[1].coords;
    const dEnd = Math.min(
      haversineMi(w0[w0.length - 1], w1[0]),
      haversineMi(w0[w0.length - 1], w1[w1.length - 1])
    );
    const dStart = Math.min(
      haversineMi(w0[0], w1[0]),
      haversineMi(w0[0], w1[w1.length - 1])
    );
    chain = dEnd <= dStart ? [...w0] : [...w0].reverse();
  }

  const gaps = [];
  let skipped = 0;
  for (let i = 1; i < main.length; i++) {
    const w = main[i].coords;
    const tail = chain[chain.length - 1];
    const dStart = haversineMi(tail, w[0]);
    const dEnd = haversineMi(tail, w[w.length - 1]);
    const d = Math.min(dStart, dEnd);
    if (d > skipMi) { skipped++; continue; }
    if (d > gapWarnMi) gaps.push({ from: tail, miles: d });
    chain = chain.concat(dStart <= dEnd ? w : [...w].reverse());
  }
  return { coords: dedupeCoords(chain), gaps, skipped, droppedByRole: ways.length - main.length };
}

/** Trim a polyline to start at the vertex nearest `pt`. */
export function trimToNearest(coords, pt) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineMi(pt, coords[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { coords: coords.slice(best), trimmedMiles: null, nearestMi: bestD };
}
