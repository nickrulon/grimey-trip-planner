// The on-the-road assistant: answers questions about THIS trip from the live
// plan. It is a planning capability layered over the canonical plan (it reads
// the same tables the screens do), not a general chatbot — every answer is
// grounded in a compact snapshot assembled per question. Dependency-free
// beyond the Anthropic SDK: this runs inside the serverless WASM function.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const money = (n) => (n == null ? '—' : `$${Math.round(n)}`);

// Stable across requests so it caches; anything that changes per request
// goes in the user turn, after this.
const PERSONA = `You are the assistant built into Grimey's Trip Planner — a bespoke app for one rider (Nick, riding as "Grimey") cycling the Southern Tier from Perdido Key, Florida to San Diego and on to Los Angeles, working a remote job as he goes. He reads your answers on a phone, often at a roadside or in a motel, so:
- Lead with the answer. Short paragraphs. No headers. Use specific names, route miles, distances, prices and phone numbers from the snapshot.
- Distances are route miles along his line. "Mile 284" is a position on the route; "48 mi" is a distance.
- His rules: he aims for 55 miles on weekdays and 65 on weekends and will not plan past 65. The day is wake-up → sleep; he decides where and when to work himself, so never schedule work for him — but if he asks, point out wi-fi/work places by mile.
- WORK RULE (his, 2026-09-28): he rides 50–60 mi a day and works from McDonald's (any fast-food/library wi-fi counts). A day works if there is a work spot near the start for the morning and another near the end for the afternoon, and hopping between two spots ≤20 mi apart mid-day is easy. He does NOT need to sleep in a town with a McDonald's — a campground or ask-on-arrival bed is fine as long as a work spot is within ~20 mi in the morning or afternoon. When you propose a day, name the work spot(s) by mile. If a stretch has none for 40+ mi, say so plainly and suggest which side of it to work from.
- SAFETY: never put him on an interstate in Louisiana (illegal) and avoid shoulderless bridges; when a road is bad for a bike, say so and name the parallel option if the snapshot has one.
- He is fine asking a church, fire station or town hall for a patch of grass; those "ask on arrival" spots are real options, but say plainly when a bed is unverified or ask-on-arrival.
- When the snapshot says nothing exists somewhere, say so — do not invent a motel or a campground. If you are unsure, say what you'd check.
- He may fall short of his Nov 12 arrival; treat that as information, not a failure. Never nag.
- Keep it under ~180 words unless he asks for detail.`;

export function makeAssistant(db, planner, today, camping) {
  let client = null;
  const ready = () => !!process.env.ANTHROPIC_API_KEY;
  const getClient = () => (client ??= new Anthropic());

  function campingSpots(fromMile, toMile) {
    try {
      const resp = camping.campingResponse();
      const feats = resp?.spots?.features ?? [];
      return feats
        .map((f) => f.properties)
        .filter((p) => p.routeMile >= fromMile && p.routeMile <= toMile)
        .sort((a, b) => a.routeMile - b.routeMile);
    } catch { return []; }
  }

  /** A compact, human-readable snapshot of everything relevant to "today". */
  function buildContext(dayNumber) {
    const plan = planner.planResponse();
    const days = plan.days;
    const day = days.find((d) => d.dayNumber === dayNumber) ?? days.find((d) => d.status === 'planned') ?? days[0];
    const s = plan.schedule ?? {};
    const L = [];
    L.push(`TODAY IS ${day.date ?? 'unknown'} — DAY ${day.dayNumber} of ${days.length}.`);
    L.push(`Trip: ${s.remainingMiles ?? '?'} mi left over ${s.calendarDaysLeft ?? '?'} calendar days to ${s.arriveDate ?? '?'}; needs ${s.requiredAvgMiles ?? '?'} mi/day; the plan currently averages ${s.plannedAvgMiles ?? '?'} and projects ${s.projectedArrival ?? '?'} (${s.daysLate ?? 0} days late). Targets: ${s.maxDayMiles ?? 55} weekday / ${s.weekendMaxMiles ?? 65} weekend. Spend so far ${money(plan.costs?.total)}.`);

    // recent reality
    const done = days.filter((d) => d.actual).slice(-3);
    if (done.length) L.push('RECENT DAYS: ' + done.map((d) => `D${d.dayNumber} ${d.date} ${d.startName} → ${d.endName} ${d.actual.miles} mi${d.lodgingCost != null ? ' ' + money(d.lodgingCost) : ''}`).join(' | '));

    // today in detail
    let c = null;
    try { c = today.dayCanvas(day.dayNumber); } catch { /* fine */ }
    const sun = c?.sun ?? day.sun ?? {};
    const fmt = (h) => (h == null ? '?' : `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`);
    L.push(`TODAY (D${day.dayNumber}): start ${day.startName} (mi ${day.startMile}) → planned end ${day.endName} (mi ${day.endMile}), ${day.miles} mi, ~${Math.round((day.rideTimeMin ?? 0) / 60 * 10) / 10} h riding, climb ${day.elevGainFt ?? '?'} ft. Dawn ${fmt(sun.dawn)} sunrise ${fmt(sun.sunrise)} sunset ${fmt(sun.sunset)} dusk ${fmt(sun.dusk)} (${sun.zone ?? ''}). Daylight fit: ${sun.fit ?? '?'} (${c?.sun?.bufferMin != null ? Math.round(c.sun.bufferMin) + ' min spare' : ''}). Status ${day.status}; readiness ${day.readiness?.state ?? '?'}${day.readiness?.issues?.length ? ' — ' + day.readiness.issues.map((i) => i.label).join(', ') : ''}.`);
    if (c?.sleep?.resource || c?.sleep?.campSpot) {
      const b = c.sleep.resource ?? c.sleep.campSpot;
      L.push(`Tonight's bed as planned: ${b.name} (mi ${r1(b.route_mile ?? b.routeMile)}${b.off_route_mi != null ? `, ${r1(b.off_route_mi)} mi off` : ''})${b.address ? ', ' + b.address : ''}${b.phone ? ', ' + b.phone : ''}${c.sleep.cost != null ? ', ' + money(c.sleep.cost) : ''}.`);
    } else L.push('Tonight\'s bed: NOT chosen yet.');
    if (c?.workStop) L.push(`Work bookmark (optional): ${c.workStop.name} mi ${c.workStop.routeMile}, wi-fi ${c.workStop.wifiStatus ?? 'unknown'}.`);
    if (day.notes) L.push(`Rider's notes for today: ${day.notes}`);
    const wx = c?.weather ?? day.weather;
    if (wx && !wx.error && wx.shortForecast) L.push(`Weather: ${wx.tempF ?? ''}° ${wx.shortForecast}${wx.windSpeed ? ', wind ' + wx.windSpeed + ' ' + (wx.windDirection ?? '') : ''}.`);

    // next days
    const nxt = days.filter((d) => d.dayNumber > day.dayNumber).slice(0, 3);
    if (nxt.length) L.push('NEXT DAYS AS PLANNED: ' + nxt.map((d) => `D${d.dayNumber} ${d.date} → ${d.endName} (mi ${d.endMile}) ${d.miles} mi${(d.overnight?.name) ? ', bed ' + d.overnight.name : d.overnightCampId ? ', camp' : ', NO BED'}${d.readiness?.state && d.readiness.state !== 'ready' ? ' [' + d.readiness.state + ']' : ''}`).join(' | '));

    // beds within reach: from today's start out 130 miles
    const from = day.startMile, to = day.startMile + 130;
    const beds = db.prepare(`SELECT name, category_id, route_mile, off_route_mi, phone FROM resources
      WHERE category_id IN ('hotel','campground') AND status='active' AND route_mile BETWEEN ? AND ? AND off_route_mi <= 4 ORDER BY route_mile`).all(from, to);
    const byTown = new Map();
    for (const b of beds) {
      const key = `${Math.round(b.route_mile / 4) * 4}`;
      const e = byTown.get(key) ?? { mile: r1(b.route_mile), hotels: 0, camps: 0, names: [] };
      if (b.category_id === 'hotel') e.hotels++; else e.camps++;
      if (e.names.length < 2) e.names.push(b.name);
      byTown.set(key, e);
    }
    const bedLine = [...byTown.values()].map((e) => `mi ${e.mile} (+${r1(e.mile - from)}): ${e.hotels ? e.hotels + ' hotel' + (e.hotels > 1 ? 's' : '') : ''}${e.hotels && e.camps ? ', ' : ''}${e.camps ? e.camps + ' campground' + (e.camps > 1 ? 's' : '') : ''} e.g. ${e.names.join(', ')}`).join(' | ');
    L.push(`LISTED BEDS in the next 130 mi (hotels/campgrounds within 4 mi of the route; "+" = miles from today's start): ${bedLine || 'NONE'}`);
    const camps = campingSpots(from, to);
    if (camps.length) L.push('RESEARCHED CAMPING (curated, may be ask-on-arrival): ' + camps.map((p) => `${p.name} mi ${p.routeMile} (+${r1(p.routeMile - from)}) ${p.price == null ? 'price ?' : p.price === 0 ? 'FREE' : '$' + p.price}${p.booking ? ' · ' + p.booking : ''}${p.tentsOk === false ? ' · no tents' : ''}`).join(' | '));

    // gaps
    const marks = [...byTown.values()].map((e) => e.mile).concat(camps.map((p) => p.routeMile)).sort((a, b) => a - b);
    let prev = from; const gaps = [];
    for (const m of [...marks, to]) { if (m - prev >= 35) gaps.push(`mi ${r1(prev)} → ${r1(m)} (${r1(m - prev)} mi with nothing listed)`); prev = m; }
    if (gaps.length) L.push('BED GAPS AHEAD: ' + gaps.join('; '));

    // wi-fi / work within the day
    const wifi = db.prepare(`SELECT name, route_mile, off_route_mi, wifi_status FROM resources
      WHERE category_id='wifi_work' AND status='active' AND route_mile BETWEEN ? AND ? AND off_route_mi <= 2 AND wifi_status IN ('confirmed','likely') ORDER BY route_mile`).all(from, from + 80);
    if (wifi.length) {
      const sample = wifi.filter((_, i) => i % Math.max(1, Math.floor(wifi.length / 10)) === 0).slice(0, 10);
      L.push(`WI-FI / WORK PLACES in the next 80 mi (${wifi.length} total): ` + sample.map((w) => `${w.name} mi ${r1(w.route_mile)} (${w.wifi_status})`).join(' | '));
    } else L.push('WI-FI / WORK PLACES in the next 80 mi: none with confirmed or likely wi-fi.');

    // warnings ahead
    const notes = db.prepare(`SELECT kind, title, detail, start_mile, end_mile FROM route_notes WHERE end_mile >= ? AND start_mile <= ? ORDER BY start_mile`).all(from, from + 120);
    if (notes.length) L.push('ROUTE NOTES AHEAD: ' + notes.map((n) => `[${n.kind}] ${n.title} (mi ${r1(n.start_mile)}${n.end_mile > n.start_mile + 0.5 ? '–' + r1(n.end_mile) : ''}): ${String(n.detail).slice(0, 220)}`).join(' | '));

    // population ahead (sparse zones)
    const pop = db.prepare(`SELECT (CAST(route_mile/20 AS INT)*20) AS band, SUM(pop) people FROM population_cells WHERE route_mile BETWEEN ? AND ? AND off_route_mi <= 5 GROUP BY band ORDER BY band`).all(from, from + 120);
    if (pop.length) L.push('PEOPLE WITHIN 5 MI OF THE ROUTE, per 20-mi band ahead: ' + pop.map((p) => `mi ${p.band}: ${Math.round(p.people / 1000)}k`).join(', ') + ' (under ~5k = expect no services).');

    return L.join('\n');
  }

  /** Async iterator of text deltas. history = [{role, content}] prior turns. */
  async function* stream({ question, history = [], dayNumber }) {
    if (!ready()) throw Object.assign(new Error('assistant not configured: set ANTHROPIC_API_KEY on the site'), { status: 503 });
    const ctx = buildContext(Number(dayNumber) || undefined);
    const msgs = history.slice(-8).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));
    msgs.push({ role: 'user', content: `SNAPSHOT OF THE TRIP RIGHT NOW:\n${ctx}\n\nQUESTION: ${String(question).trim()}` });
    const s = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 1200,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: [{ type: 'text', text: PERSONA, cache_control: { type: 'ephemeral' } }],
      messages: msgs,
    });
    for await (const ev of s) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield ev.delta.text;
    }
    const fin = await s.finalMessage();
    if (fin.stop_reason === 'refusal') yield '\n\n(I can\'t help with that one.)';
  }

  return { ready, buildContext, stream };
}
