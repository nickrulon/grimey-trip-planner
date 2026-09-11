// Daylight & time engine, ported from the "Grimey's Daylight Blocks" prototype
// into shared application logic. The planner's plan is distance; a day on this
// trip is distance × time × daylight × the Eastern-anchored work window. This
// module owns the time half:
//
//   · solar altitude / twilight phases at any (lat, lng, instant)
//   · dawn / sunrise / sunset / dusk for a day, with the sun evaluated at the
//     rider's PROJECTED position through the day, not one fixed point
//   · US timezone by longitude, with calendar-correct DST (2nd Sunday of March
//     to 1st Sunday of November, any year — Arizona never observes it)
//   · the 9:00–4:30 Eastern work window mapped into that day's local clock
//   · a feasibility verdict: how much riding fits around work and daylight
//
// Everything here is pure arithmetic on the route's own geometry — no network,
// so it runs identically on the laptop, in the WASM serverless function, and
// (if ever needed) in the browser.

const RAD = Math.PI / 180;

// ---- calendar helpers (all date strings are YYYY-MM-DD) --------------------
const pdate = (s) => s.split('-').map(Number);

export function dayOfWeek(iso) {
  const [y, m, d] = pdate(iso);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun
}

export function isWorkday(iso) {
  const dow = dayOfWeek(iso);
  return dow >= 1 && dow <= 5;
}

/** nth (1-based) given weekday of a month, as YYYY-MM-DD. */
function nthWeekday(year, month1, weekday, nth) {
  const first = new Date(Date.UTC(year, month1 - 1, 1, 12)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  return `${year}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** US DST: in effect from the 2nd Sunday of March to the 1st Sunday of November. */
export function isUsDst(iso) {
  const [y] = pdate(iso);
  return iso >= nthWeekday(y, 3, 0, 2) && iso < nthWeekday(y, 11, 0, 1);
}

export function easternOffset(iso) {
  return isUsDst(iso) ? -4 : -5;
}

/**
 * Timezone by longitude along the corridor. The boundaries are where the
 * route itself crosses zone lines (Hudspeth County TX → MT, AZ line, CA line);
 * Arizona stays on MST year-round.
 */
export function zoneForLng(lng, iso) {
  const d = isUsDst(iso);
  if (lng >= -85.0) return { name: 'ET', off: d ? -4 : -5 };
  if (lng >= -105.0) return { name: 'CT', off: d ? -5 : -6 };
  if (lng >= -109.05) return { name: 'MT', off: d ? -6 : -7 };
  if (lng >= -114.6) return { name: 'AZ', off: -7 };
  return { name: 'PT', off: d ? -7 : -8 };
}

/** Local clock hours (float) on a date at a given UTC offset → UTC ms. */
export function localToUtc(iso, hours, offset) {
  const [y, m, d] = pdate(iso);
  return Date.UTC(y, m - 1, d) + (hours - offset) * 36e5;
}

// ---- solar position (NOAA low-precision, plenty for twilight bands) --------
export function sunAltitudeDeg(lat, lng, utcMs) {
  const n = utcMs / 864e5 - 10957.5;
  const g = (357.529 + 0.98560028 * n) * RAD;
  const q = 280.459 + 0.98564736 * n;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * n) * RAD;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  let ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD;
  ra = ((ra % 360) + 360) % 360;
  let gm = (18.697374558 + 24.06570982441908 * n) % 24;
  gm = (gm + 24) % 24;
  const H = (gm * 15 + lng - ra) * RAD;
  return Math.asin(
    Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(H)
  ) / RAD;
}

/** Sky phase for an altitude: day, low sun, civil/nautical/astro twilight, night. */
export function phaseOf(alt) {
  return alt >= 8 ? 'day'
    : alt >= -0.833 ? 'low'
    : alt >= -6 ? 'civil'
    : alt >= -12 ? 'naut'
    : alt >= -18 ? 'astro'
    : 'night';
}

// ---- formatting -------------------------------------------------------------
export function fmtClock(hours) {
  let m = Math.round(hours * 60);
  m = ((m % 1440) + 1440) % 1440;
  const H = Math.floor(m / 60), Mi = m % 60;
  return `${((H + 11) % 12) + 1}:${String(Mi).padStart(2, '0')}${H < 12 ? 'a' : 'p'}`;
}

export function fmtDur(hours) {
  const m = Math.max(0, Math.round(hours * 60));
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

// ---- factory bound to the route ---------------------------------------------
/**
 * db: the trip database (route_points). settingsGet: (key) => value|undefined.
 * Returns per-day daylight/work models. Results are cached by
 * (date|startMile|endMile|workKey) because planResponse asks for all ~53 days
 * on every request.
 */
export function makeDaylight(db, settingsGet) {
  // Route sampled every ~5 miles: enough for sun position (the sun does not
  // care about a two-mile wiggle) and small enough to interpolate instantly.
  const marks = [];
  {
    let nextAt = -1;
    for (const p of db.prepare(`SELECT lat, lng, mile FROM route_points ORDER BY mile`).all()) {
      if (p.mile >= nextAt) { marks.push(p); nextAt = p.mile + 5; }
    }
  }

  function posAtMile(mile) {
    if (!marks.length) return null;
    if (mile <= marks[0].mile) return [marks[0].lat, marks[0].lng];
    for (let i = 1; i < marks.length; i++) {
      if (mile <= marks[i].mile) {
        const a = marks[i - 1], b = marks[i];
        const t = (mile - a.mile) / (b.mile - a.mile);
        return [a.lat + t * (b.lat - a.lat), a.lng + t * (b.lng - a.lng)];
      }
    }
    const z = marks[marks.length - 1];
    return [z.lat, z.lng];
  }

  function workWindowET() {
    const s = settingsGet('workStartET') || '09:00';
    const e = settingsGet('workEndET') || '16:30';
    const toH = (t) => {
      const [h, m] = t.split(':').map(Number);
      return (Number.isFinite(h) ? h : 9) + (Number.isFinite(m) ? m : 0) / 60;
    };
    return { startH: toH(s), endH: toH(e) };
  }

  const cache = new Map();

  /**
   * The full time model for one riding day.
   *  date: YYYY-MM-DD · startMile/endMile: the day's stretch
   *  effortMi: effort-adjusted distance (falls back to raw miles)
   *  speedMph: riding speed
   */
  function dayModel({
    date, startMile, endMile, effortMi = null, speedMph = 11,
    // Rider overrides (local hours, floats). departH earlier than dawn and
    // rideUntilH later than dusk are allowed — riding in the dark is a choice
    // the rider is entitled to make, so the model reflects it and reports how
    // much of it is dark rather than refusing to consider it.
    departH = null, workStartH = null, rideUntilH = null,
  }) {
    const key = `${date}|${startMile.toFixed(1)}|${endMile.toFixed(1)}|${effortMi ?? ''}|${speedMph}`
      + `|${departH ?? ''}|${workStartH ?? ''}|${rideUntilH ?? ''}`;
    if (cache.has(key)) return cache.get(key);
    if (cache.size > 400) cache.clear();

    const p0 = posAtMile(startMile) ?? [30.4, -87.2];
    const p1 = posAtMile(endMile) ?? p0;
    const zone = zoneForLng((p0[1] + p1[1]) / 2, date);
    const eo = easternOffset(date);
    const et = workWindowET();
    // ET window on the local clock: moving west GAINS morning work-free hours.
    const etStartLocal = et.startH + (zone.off - eo);
    const workStartLocal = workStartH ?? etStartLocal;
    const workEndLocal = workStartLocal + (et.endH - et.startH);
    const workday = isWorkday(date);
    // A shifted work block is still the same owed hours — just held later or
    // earlier in the local day, which moves what it means in Eastern time.
    const workShiftH = workStartLocal - etStartLocal;

    // The sun is evaluated where the rider will actually BE: position eased
    // linearly across the riding window (7am→7pm) rather than pinned to the
    // start. On an 80-mile day that shifts sunset by real minutes.
    const projAt = (h) => {
      const f = Math.min(1, Math.max(0, (h - 7) / 12));
      return posAtMile(startMile + f * (endMile - startMile)) ?? p0;
    };

    // Minute scan for the four events (civil dawn, sunrise, sunset, civil dusk).
    let dawn = null, sunrise = null, sunset = null, dusk = null;
    for (let m = 0; m < 1440; m += 2) {
      const h = m / 60;
      const [la, ln] = projAt(h);
      const a = sunAltitudeDeg(la, ln, localToUtc(date, h, zone.off));
      if (a >= -6 && dawn === null) dawn = h;
      if (a >= -0.833 && sunrise === null) sunrise = h;
      if (a >= -0.833) sunset = h;
      if (a >= -6) dusk = h;
    }

    // 48 half-hour sky phases for the canvas background.
    const phases = [];
    for (let i = 0; i < 48; i++) {
      const h = i / 2 + 0.25;
      const [la, ln] = projAt(h);
      phases.push(phaseOf(sunAltitudeDeg(la, ln, localToUtc(date, h, zone.off))));
    }

    // The rider's actual riding window: from when they roll out (default civil
    // dawn) to when they stop (default civil dusk). Overriding either is what
    // makes "I'll start at 4:30" or "I'll ride an hour on lights" expressible.
    const rideFrom = departH ?? dawn ?? 6;
    const rideTo = rideUntilH ?? dusk ?? 19;

    const morningLightH = Math.max(0, Math.min(workStartLocal, rideTo) - rideFrom);
    const eveningLightH = Math.max(0, rideTo - Math.max(workEndLocal, rideFrom));
    const usableH = workday
      ? morningLightH + eveningLightH
      : Math.max(0, rideTo - rideFrom - 1);

    // How much of that window is outside civil twilight — i.e. actually dark.
    // Reported, never silently spent.
    const darkBeforeH = dawn != null ? Math.max(0, dawn - rideFrom) : 0;
    const darkAfterH = dusk != null ? Math.max(0, rideTo - dusk) : 0;

    const miles = endMile - startMile;
    const effort = effortMi ?? miles;
    const rideH = effort / Math.max(1, speedMph);
    const bufferH = usableH - rideH;

    // 'fits' / 'tight' / 'short'. The two honest tricks (a moving call + a
    // banked evening hour) are worth ~2 riding hours on a workday — enough to
    // call a small deficit 'tight' rather than 'short'.
    const trickH = workday ? 2 : 0;
    let status = 'fits';
    if (bufferH < 0) status = bufferH + trickH >= 0 ? 'tight' : 'short';
    else if (usableH > 0 && rideH > usableH * 0.88) status = 'tight';
    if (miles < 0.5) status = 'fits'; // rest day

    const model = {
      date, zone: zone.name, zoneOff: zone.off,
      workday,
      dawn, sunrise, sunset, dusk,
      daylightH: sunrise != null && sunset != null ? sunset - sunrise : 0,
      work: workday ? {
        localStart: workStartLocal, localEnd: workEndLocal,
        // What the shifted block means back in the office's timezone.
        etStart: et.startH + workShiftH, etEnd: et.endH + workShiftH,
        etDefaultStart: et.startH, etDefaultEnd: et.endH,
        shiftedH: workShiftH,
        minutes: Math.round((et.endH - et.startH) * 60),
      } : null,
      morningLightH, eveningLightH, usableH,
      rideFrom, rideTo,
      darkBeforeH, darkAfterH,
      overrides: {
        depart: departH != null, workStart: workStartH != null, rideUntil: rideUntilH != null,
      },
      rideH, effortMi: effort, bufferH, status,
      phases,
    };
    cache.set(key, model);
    return model;
  }

  return { posAtMile, dayModel, workWindowET, invalidate: () => cache.clear() };
}
