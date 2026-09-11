// Deployed-build shim.
//
// Everything stateful now runs server-side in the planning engine function, so
// this does only two things the network can't:
//   1. Ride Mode's position is computed ON THE PHONE from snapshotted route
//      data. A GPS fix must not depend on cell service — that is the whole
//      point of the desert stretches.
//   2. Writes carry the trip key, so the app's existing fetch calls don't each
//      need to know about auth.
(() => {
  const real = window.fetch.bind(window);
  const base = new URL('.', location.href).href;
  const json = (obj, status) => Promise.resolve(new Response(
    JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));

  const slots = {};
  const load = (file) => (slots[file] ||= real(base + 'api-data/' + file).then((r) => r.json())
    .then((d) => { slots[file] = Promise.resolve(d); return d; }));

  const TRIP_KEY = 'grimey-trip-key';
  const tripKey = () => { try { return localStorage.getItem(TRIP_KEY) ?? ''; } catch { return ''; } };

  const RAD = Math.PI / 180, R = 3958.8;
  const havMi = (lng1, lat1, lng2, lat2) => {
    const dLa = (lat2 - lat1) * RAD, dLn = (lng2 - lng1) * RAD;
    const a = Math.sin(dLa / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLn / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  const r1 = (n) => Math.round(n * 10) / 10, r2 = (n) => Math.round(n * 100) / 100;

  function placeAt(places, mile) {
    let near = null, ns = -Infinity, nearest = null, nd = Infinity;
    for (const p of places) {
      const dist = Math.abs(p.mile - mile);
      if (dist < nd) { nd = dist; nearest = p; }
      if (dist > 8) continue;
      const sc = p.weight * 2 - dist;
      if (sc > ns) { ns = sc; near = p; }
    }
    return near ? near.name : (nearest && nd <= 14 ? 'near ' + nearest.name : 'Mile ' + Math.round(mile));
  }

  // Ride Mode follows THE plan — there is exactly one now (the old day-plan
  // document is retired), so the snapshot's plan.json is the truth offline.
  async function activeDays() {
    const plan = await load('plan.json');
    return (plan.days ?? []).map((d) => ({
      dayNumber: d.dayNumber, endName: d.endName, endMile: d.endMile,
      overnightName: d.overnight?.name ?? (d.overnightCampId ? d.endName : null), status: d.status,
    }));
  }

  async function position(params) {
    const [{ pts }, pd, res] = await Promise.all([
      load('route-points.json'), load('position-data.json'), load('resources.json'),
    ]);
    let mile, offMi, lat, lng;
    if (params.get('mile') != null && params.get('mile') !== '') {
      mile = Number(params.get('mile'));
      let best = pts[0], bd = Infinity;
      for (const p of pts) { const x = Math.abs(p[2] - mile); if (x < bd) { bd = x; best = p; } }
      lng = best[0]; lat = best[1]; offMi = 0;
    } else {
      lat = Number(params.get('lat')); lng = Number(params.get('lng'));
      let best = pts[0], bd = Infinity;
      for (const p of pts) { const x = havMi(lng, lat, p[0], p[1]); if (x < bd) { bd = x; best = p; } }
      mile = best[2]; offMi = bd;
    }
    const days = await activeDays();
    const today = days.find((x) => x.status === 'planned' && mile < x.endMile - 0.5)
      ?? days.find((x) => x.status === 'planned') ?? null;
    const upcoming = (res.features ?? [])
      .map((f) => ({ ...f.properties, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }))
      .filter((p) => p.routeMile > mile + 0.05 && p.routeMile <= mile + 45)
      .sort((a, b) => a.routeMile - b.routeMile).slice(0, 60)
      .map((p) => ({ id: p.id, category: p.category, name: p.name, brand: p.brand,
        routeMile: r1(p.routeMile), milesAhead: r1(p.routeMile - mile), offRouteMi: r2(p.offRouteMi),
        wifiStatus: p.wifiStatus, lat: p.lat, lng: p.lng, address: p.address, phone: p.phone,
        website: p.website, hours: p.hours }));
    const notesAhead = (pd.notes ?? [])
      .filter((n) => n.end_mile >= mile && n.start_mile <= mile + 45).slice(0, 8)
      .map((n) => ({ id: n.id, kind: n.kind, title: n.title, detail: n.detail,
        startMile: r1(n.start_mile), endMile: r1(n.end_mile),
        milesAhead: n.start_mile <= mile ? 0 : r1(n.start_mile - mile),
        active: n.start_mile <= mile && n.end_mile >= mile,
        source: n.source, confidence: n.confidence }));
    return json({
      mile: r1(mile), offRouteMi: r2(offMi), lat, lng,
      nearPlace: placeAt(pd.places ?? [], mile), totalMiles: pd.totalMiles, notesAhead,
      day: today ? { dayNumber: today.dayNumber, endName: today.endName, endMile: r1(today.endMile),
        milesToEnd: r1(Math.max(0, today.endMile - mile)), overnightName: today.overnightName } : null,
      upcoming,
    });
  }

  async function routePoints(params) {
    const { pts } = await load('route-points.json');
    const lo = Number(params.get('minMile') ?? 0), hi = Number(params.get('maxMile') ?? 1e9);
    const win = pts.filter((p) => p[2] >= lo && p[2] <= hi);
    const step = Math.max(1, Math.floor(win.length / 800));
    return json({ coords: win.filter((_, i) => i % step === 0 || i === win.length - 1).map((p) => [p[0], p[1]]) });
  }

  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return real(input, init);
    const [p, qs] = url.split('?');
    const method = ((init && init.method) || 'GET').toUpperCase();

    // Computed on-device so riding never depends on signal.
    if (p === '/api/position') return position(new URLSearchParams(qs || ''));
    if (p === '/api/route/points') return routePoints(new URLSearchParams(qs || ''));

    if (method !== 'GET') {
      const next = { ...(init || {}) };
      next.headers = { ...(next.headers || {}), 'x-trip-key': tripKey() };
      return real(input, next);
    }
    return real(input, init);
  };
})();
