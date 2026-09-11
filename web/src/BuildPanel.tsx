import { useEffect, useMemo, useRef, useState } from 'react';
import type { Map as MLMap } from 'maplibre-gl';
import { apiGet, apiPost, apiQuery } from './api';
import type {
  DayCanvas, BuildCandidate, BuildCandidatesResponse, ChainStop, ChainEnd,
} from './types';
import type { PickerContext } from './MapPicker';
import { Timeline } from './Timeline';
import {
  clockMin, durMin, money, wifiMeta, fullAddress, appleMapsUrl, googleMapsUrl, googleSearchUrl,
} from './format';
import {
  useCandidateLayer, useAnchorLayer, useCandidateHover, useFitOnce, pointAtMile,
  type CandFeature, type AnchorFeature,
} from './pickerLayers';

// BUILD THE DAY — compose a day on the map, link by link: wake → ride → sit →
// ride → sit → ride → sleep. The endpoint is the OUTPUT of that chain, not the
// input to it. The map answers WHERE; the timeline beside it answers WHEN, and
// goes red the moment the day stops fitting — which is the whole point.
//
// Nothing is written until Save. Every change is a dry run through the same
// code that will save it (POST …/simulate), so what the panel shows is exactly
// what the day becomes.

type Kind = 'work' | 'break' | 'sleep';
const KIND_WORD: Record<ChainStop['kind'], string> = { work: 'work', break: 'break', combo: 'work + bike' };
const KIND_ICON: Record<ChainStop['kind'], string> = { work: '💻', break: '☕', combo: '🚴💻' };

let keySeq = 0;
const newKey = () => `k${++keySeq}`;

/** The day's saved stops, as the chain to start from. Saving unchanged is a no-op. */
function seedChain(c: DayCanvas): ChainStop[] {
  return sortChain([
    ...c.breaks.map((b) => ({ key: newKey(), kind: 'break' as const, routeMile: b.routeMile, dwellMin: b.dwellMin, name: b.name })),
    ...c.workStops.map((w) => ({
      key: newKey(), kind: 'work' as const, routeMile: w.routeMile, dwellMin: w.dwellMin, name: w.name,
      resourceId: w.resourceId, lat: w.lat ?? undefined, lng: w.lng ?? undefined,
    })),
    ...c.combos.map((x) => ({ key: newKey(), kind: 'combo' as const, routeMile: x.routeMile, dwellMin: x.minutes, name: x.name })),
  ]);
}

/** Mile order, unresolved stops ("after 45 min") last — where the server measures them from. */
function sortChain(chain: ChainStop[]): ChainStop[] {
  return [...chain].sort((a, b) => {
    if (a.routeMile == null && b.routeMile == null) return 0;
    if (a.routeMile == null) return 1;
    if (b.routeMile == null) return -1;
    return a.routeMile - b.routeMile;
  });
}

/**
 * After a preview, pin every stop to the mile the walk gave it. The k-th stop
 * block is the k-th chain entry — both are in mile order — so an "after 45
 * minutes" break becomes a fixed mile and the chain stays stable from then on.
 */
function resolveMiles(chain: ChainStop[], c: DayCanvas): ChainStop[] {
  const stops = c.blocks.filter((b) => b.kind === 'work' || b.kind === 'break' || b.kind === 'combo');
  if (stops.length !== chain.length) return chain;
  let changed = false;
  const next = chain.map((s, i) => {
    const b = stops[i];
    if (b.routeMile == null || (s.routeMile != null && s.afterRideMin == null)) return s;
    changed = true;
    const { afterRideMin: _drop, ...rest } = s;
    void _drop;
    return { ...rest, routeMile: b.routeMile };
  });
  return changed ? sortChain(next) : chain;
}

const msg = (e: unknown) => String((e as Error).message ?? e);

export default function BuildPanel({ ctx, map }: { ctx: PickerContext; map: MLMap | null }) {
  const day = ctx.canvas!;
  const n = ctx.dayNumber;
  const [chain, setChain] = useState<ChainStop[]>(() => seedChain(day));
  const [end, setEnd] = useState<ChainEnd | null>(null);
  const [preview, setPreview] = useState<DayCanvas>(day);
  const [simErr, setSimErr] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>(day.sun?.workday && day.workStops.length === 0 ? 'work' : day.sun?.workday ? 'work' : 'sleep');
  const [cands, setCands] = useState<BuildCandidatesResponse | null>(null);
  const [candErr, setCandErr] = useState<string | null>(null);
  const [extraReach, setExtraReach] = useState(0);
  const [wifiOnly, setWifiOnly] = useState(false);
  const [lowDetour, setLowDetour] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [full24, setFull24] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [brkAfter, setBrkAfter] = useState('45');
  const [brkLen, setBrkLen] = useState('30');
  const [comboLen, setComboLen] = useState('60');
  const [dirty, setDirty] = useState(false);

  // ---- the proposal, as the server wants it ------------------------------------
  const body = useMemo(() => ({
    stops: chain.map((s) => ({
      kind: s.kind, routeMile: s.routeMile, afterRideMin: s.afterRideMin,
      dwellMin: s.dwellMin, name: s.name, resourceId: s.resourceId ?? undefined,
    })),
    endMile: end?.endMile, endName: end?.endName,
    end: end ? { resourceId: end.resourceId, campId: end.campId } : undefined,
  }), [chain, end]);

  // ---- dry run on every change (debounced; stale answers dropped) ---------------
  const seq = useRef(0);
  useEffect(() => {
    const me = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const c = await apiQuery<DayCanvas>(`/api/plan/day/${n}/simulate`, body);
        if (me !== seq.current) return;
        setPreview(c); setSimErr(null);
        setChain((cur) => resolveMiles(cur, c));
      } catch (e) { if (me === seq.current) setSimErr(msg(e)); }
    }, 120);
    return () => clearTimeout(t);
  }, [body, n]);

  // ---- the cursor: where the chain has got to, and when --------------------------
  const stopBlocks = preview.blocks.filter((b) => b.kind === 'work' || b.kind === 'break' || b.kind === 'combo');
  const lastStop = stopBlocks[stopBlocks.length - 1] ?? null;
  const cursorMile = lastStop
    ? (lastStop.kind === 'combo' ? (lastStop.routeMile ?? preview.startMile) + (lastStop.miles ?? 0) : lastStop.routeMile ?? preview.startMile)
    : preview.startMile;
  const cursorMin = lastStop ? lastStop.endMin : preview.departMin;
  const rideToMin = preview.times?.rideToMin ?? (preview.sun?.dusk != null ? Math.round(preview.sun.dusk * 60) : cursorMin + 8 * 60);
  // How far to look: what is reachable before the time you said you would stop
  // riding, plus a margin — and farther on request.
  const reach = Math.max(10, Math.min(220, ((rideToMin - cursorMin) / 60) * ctx.speedMph + 15 + extraReach));

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await apiGet<BuildCandidatesResponse>(
          `/api/plan/day/${n}/build-candidates?fromMile=${cursorMile}&fromMin=${cursorMin}&reachMi=${reach.toFixed(1)}&kind=${kind}&limit=90`);
        if (live) { setCands(r); setCandErr(null); }
      } catch (e) { if (live) setCandErr(msg(e)); }
    })();
    return () => { live = false; };
  }, [n, cursorMile, cursorMin, reach, kind]);

  const inChain = (c: BuildCandidate) =>
    chain.some((s) => s.resourceId && s.resourceId === c.id) || end?.resourceId === c.id || end?.campId === c.id;
  const shown = useMemo(() => (cands?.candidates ?? []).filter((c) => {
    if (wifiOnly && kind === 'work' && !['confirmed', 'likely'].includes(c.wifiStatus ?? '')) return false;
    if (lowDetour && (c.offRouteMi ?? 0) > 1.5) return false;
    return true;
  }), [cands, wifiOnly, lowDetour, kind]);

  const sel = shown.find((c) => c.id === selId) ?? null;
  const hover = shown.find((c) => c.id === hoverId) ?? null;
  const card = sel ?? hover;

  // ---- the map: pins say when you would arrive, tinted by what that means -------
  const tintOf = (c: BuildCandidate) => {
    if (kind === 'work') {
      if (c.wifiStatus === 'none') return 'bad';
      return c.beforeWorkOpen === true ? 'ok' : c.beforeWorkOpen === false ? 'late' : 'none';
    }
    if (kind === 'sleep') return c.lightLeftMin == null ? 'none' : c.lightLeftMin >= 0 ? 'ok' : 'late';
    return 'none';
  };
  const feats = useMemo<CandFeature[]>(() => shown.map((c) => ({
    id: c.id, name: c.name, lat: c.lat, lng: c.lng, sort: -c.score, chosen: inChain(c),
    props: { tint: tintOf(c), arrive: c.arriveClock ?? '' },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [shown, chain, end]);
  useCandidateLayer(map, feats,
    ['match', ['get', 'tint'], 'ok', '#2f7d32', 'late', '#d96f00', 'bad', '#b3402a', '#8a8270'],
    ['concat', ['get', 'name'], '\n', ['get', 'arrive']]);
  useCandidateHover(map, setHoverId, setSelId, [shown]);

  // The chain itself on the map: start, every stop, and where the day ends.
  const [anchors, setAnchors] = useState<AnchorFeature[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const out: AnchorFeature[] = [];
      const s = await pointAtMile(preview.startMile);
      if (s) out.push({ label: `START · ${clockMin(preview.departMin)}`, lat: s.lat, lng: s.lng, kind: 'start' });
      for (const [i, st] of chain.entries()) {
        if (st.routeMile == null) continue;
        const b = stopBlocks[i];
        const pt = st.lat != null && st.lng != null ? { lat: st.lat, lng: st.lng } : await pointAtMile(st.routeMile);
        if (pt) out.push({ label: `${st.name.slice(0, 22)}${b ? ` · ${clockMin(b.startMin)}` : ''}`, lat: pt.lat, lng: pt.lng, kind: 'chain' });
      }
      const e = end ? { lat: end.lat, lng: end.lng } : await pointAtMile(preview.endMile);
      const arrive = preview.blocks.length ? preview.blocks[preview.blocks.length - 1].endMin : null;
      if (e) out.push({ label: `${end ? 'SLEEP' : 'PLANNED END'} · ${preview.endName.slice(0, 20)}${arrive != null ? ` · ${clockMin(arrive)}` : ''}`, lat: e.lat, lng: e.lng, kind: 'end' });
      if (live) setAnchors(out);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, end, preview.startMile, preview.endMile, preview.departMin, preview.blocks]);
  useAnchorLayer(map, anchors);

  const wide = typeof window !== 'undefined' && window.innerWidth >= 900;
  useFitOnce(map, `build-${n}`, day.startMile, Math.max(day.endMile, day.startMile + 30) + 15, [],
    wide ? { top: 110, bottom: 60, left: 60, right: 500 } : { top: 110, bottom: Math.round(window.innerHeight * 0.55), left: 40, right: 40 });

  // ---- editing the chain ----------------------------------------------------------
  const touch = () => setDirty(true);
  const addStop = (s: Omit<ChainStop, 'key'>) => { setChain((cur) => sortChain([...cur, { ...s, key: newKey() }])); setSelId(null); touch(); };
  const removeStop = (i: number) => { setChain((cur) => cur.filter((_, k) => k !== i)); touch(); };
  const setDwell = (i: number, v: number) => {
    if (!Number.isFinite(v) || v < 0) return;
    setChain((cur) => cur.map((s, k) => (k === i ? { ...s, dwellMin: Math.round(v) } : s))); touch();
  };
  const owed = preview.work?.owedMin ?? 0;
  const credit = preview.work?.creditMin ?? 0;
  // What is still owed, or an hour's top-up once the day is already covered.
  const defaultWorkDwell = owed - credit > 30 ? owed - credit : 60;

  const addCandidate = (c: BuildCandidate) => {
    if (kind === 'sleep') {
      setEnd({
        endMile: c.routeMile, endName: c.name, lat: c.lat, lng: c.lng,
        ...(c.kind === 'camp' ? { campId: c.id } : { resourceId: c.id }),
      });
      setSelId(null); touch();
      return;
    }
    // A place at or behind the cursor — the library beside the McDonald's you
    // are sitting in — happens WHERE YOU ARE: anchored just past the last stop,
    // as combos are, so the chain keeps the order the rider meant.
    const here = c.behind || c.routeMile <= cursorMile;
    addStop({
      kind: kind === 'work' ? 'work' : 'break',
      routeMile: here ? Math.round((cursorMile + 0.02) * 100) / 100 : c.routeMile,
      dwellMin: kind === 'work' ? defaultWorkDwell : 30,
      name: c.name, resourceId: c.kind === 'resource' ? c.id : null, lat: c.lat, lng: c.lng,
    });
  };

  const save = async () => {
    setSaving(true); setSaveErr(null);
    try {
      await apiPost(`/api/plan/day/${n}/stops`, body);
      ctx.onSaved?.();
    } catch (e) { setSaveErr(msg(e)); }
    setSaving(false);
  };
  const discard = () => {
    if (dirty && !window.confirm('Discard this chain? Nothing has been saved.')) return;
    ctx.onClose();
  };

  const issues = preview.readiness?.issues ?? [];
  const red = preview.conflict?.kind === 'daylight' || issues.some((i) => ['daylight', 'mark_missed', 'mileage'].includes(i.kind));
  const dayHours = preview.blocks.length
    ? (preview.blocks[preview.blocks.length - 1].endMin - preview.departMin) / 60 : 0;

  return (
    <div className="picker-map">
      <div className="pm-top">
        <div className="pm-title">
          <b>BUILD THE DAY</b>
          <span className="dim">
            Day {n}{preview.date ? ` · ${preview.date}` : ''} · from {preview.startName} (mi {preview.startMile})
            {preview.sun?.workday ? ' · work day' : ' · weekend'}
          </span>
        </div>
        <div className="pm-top-actions">
          <button className="ghost" onClick={discard}>Discard</button>
          <button className="pm-x" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save day'}</button>
        </div>
      </div>

      {/* what to add next, and how far to look */}
      <div className="pm-filters bd-filters">
        {(['work', 'break', 'sleep'] as Kind[]).map((k) => (
          <button key={k} className={kind === k ? 'chip on' : 'chip'} onClick={() => { setKind(k); setSelId(null); }}
            title={k === 'work' ? 'a wi-fi stop to sit at' : k === 'break' ? 'any place to get off the bike' : 'tonight\'s bed — this ends the day'}>
            {k === 'work' ? '💻 Work' : k === 'break' ? '☕ Break' : '⛺ Bed'}
            {cands && kind === k && <span className="pm-count">{shown.length}</span>}
          </button>
        ))}
        {kind === 'work' && (
          <button className={wifiOnly ? 'chip on' : 'chip'} onClick={() => setWifiOnly(!wifiOnly)} title="confirmed or likely wi-fi only">wi-fi ✓</button>
        )}
        <button className={lowDetour ? 'chip on' : 'chip'} onClick={() => setLowDetour(!lowDetour)} title="under 1.5 mi off the route">low detour</button>
        <button className="chip" onClick={() => setExtraReach((x) => x + 25)}>+ look 25 mi farther</button>
        <span className="bd-cursor hand">from mi {Math.round(cursorMile * 10) / 10} at {clockMin(cursorMin)}</span>
      </div>

      {candErr && <div className="pm-err error">{candErr}</div>}

      <div className={`bd-dock${red ? ' red' : ''}`}>
        {/* WHEN — the timeline, live. Not optional: the map cannot show time. */}
        <div className="bd-timeline">
          <Timeline c={preview} full={full24} editable={false} onCommit={() => {}} />
          <div className="bd-tl-foot">
            <button className="linkish" onClick={() => setFull24(!full24)}>{full24 ? 'Focus on the day' : 'Show full 24 hours'}</button>
            <span className={`bd-total${dayHours > 14 ? ' over' : ''}`}>
              {durMin(Math.round(dayHours * 60))} door to door
              {preview.work && <> · {durMin(preview.work.creditMin)} of {durMin(preview.work.owedMin)} owed</>}
            </span>
          </div>
          {simErr && <div className="error">{simErr}</div>}
          {(issues.length > 0 || preview.conflict) && (
            <div className="issues-row">
              {issues.map((i, k) => <span key={k} className={`issue issue-${i.kind}`}>{i.label}</span>)}
              {preview.conflict && !issues.some((i) => i.kind === 'daylight') && (
                <span className={`issue issue-${preview.conflict.kind}`}>{preview.conflict.detail}</span>
              )}
            </div>
          )}
          {preview.conflict && issues.some((i) => i.kind === 'daylight') && (
            <div className="conflict-note">⚠ {preview.conflict.detail}</div>
          )}
        </div>

        {/* THE CHAIN — the day as a list of links, each with its clock */}
        <ol className="bd-chain">
          <li className="bd-node">
            <span className="bd-ic">🛏</span>
            <span>wake at <b>{preview.prevOvernight}</b> · roll out {clockMin(preview.departMin)}</span>
          </li>
          {preview.blocks.map((b, i) => {
            if (b.kind === 'ride') {
              return (
                <li key={`r${i}`} className="bd-leg">
                  <span className="bd-ic">↓</span>
                  <span>ride <b>{b.miles} mi</b> · {durMin(b.rideMin)} · arrive {clockMin(b.endMin)}</span>
                </li>
              );
            }
            if (b.kind === 'slack') {
              return (
                <li key={`s${i}`} className="bd-leg dim">
                  <span className="bd-ic">⏳</span>
                  <span>wait {durMin(b.endMin - b.startMin)} for the work clock ({clockMin(b.endMin)})</span>
                </li>
              );
            }
            const idx = stopBlocks.indexOf(b);
            const st = chain[idx];
            return (
              <li key={`b${i}`} className={`bd-stop bd-${b.kind}`}>
                <span className="bd-ic">{KIND_ICON[b.kind as ChainStop['kind']]}</span>
                <span className="bd-stop-main">
                  <b>{b.label}</b>
                  <span className="dim"> · {KIND_WORD[b.kind as ChainStop['kind']]} · mi {b.routeMile}</span>
                  <br />
                  {clockMin(b.startMin)}–{clockMin(b.endMin)} ·{' '}
                  {st ? (
                    <input className="bd-dwell" type="number" min={0} step={5} defaultValue={st.dwellMin}
                      key={`${st.key}-${st.dwellMin}`}
                      onBlur={(e) => { const v = Number(e.target.value); if (v !== st.dwellMin) setDwell(idx, v); }}
                      aria-label={`${b.label} minutes`} />
                  ) : durMin(b.dwellMin)} min
                </span>
                {st && <button className="brk-x" title="Remove this stop" onClick={() => removeStop(idx)}>✕</button>}
              </li>
            );
          })}
          <li className={`bd-node bd-end${end ? ' chosen' : ''}`}>
            <span className="bd-ic">{end ? '⛺' : '🏁'}</span>
            <span>
              {end
                ? <><b>{end.endName}</b> · sleep · mi {end.endMile}</>
                : <>planned end <b>{preview.endName}</b> (mi {preview.endMile}) — <span className="dim">keep it, or pick a bed</span></>}
              {preview.blocks.length > 0 && <> · {clockMin(preview.blocks[preview.blocks.length - 1].endMin)}</>}
            </span>
            {end && <button className="brk-x" title="Back to the planned end" onClick={() => { setEnd(null); touch(); }}>✕</button>}
          </li>
        </ol>

        {/* links that need no venue */}
        <div className="bd-quick">
          <span>+ break after riding</span>
          <input type="number" min={5} step={5} value={brkAfter} onChange={(e) => setBrkAfter(e.target.value)} aria-label="minutes of riding" />
          <span>min, for</span>
          <input type="number" min={5} step={5} value={brkLen} onChange={(e) => setBrkLen(e.target.value)} aria-label="break length" />
          <span>min</span>
          <button className="ghost" disabled={!(Number(brkAfter) > 0)}
            onClick={() => addStop({ kind: 'break', afterRideMin: Number(brkAfter), dwellMin: Number(brkLen) || 30, name: 'Break' })}>Add</button>
          {preview.sun?.workday && (<>
            <span className="bd-sep">·</span>
            <span>+ work from the saddle</span>
            <input type="number" min={10} step={5} value={comboLen} onChange={(e) => setComboLen(e.target.value)} aria-label="combo minutes" />
            <span>min</span>
            <button className="ghost" disabled={!(Number(comboLen) > 0) || !chain.some((s) => s.kind === 'work')}
              title={chain.some((s) => s.kind === 'work') ? 'a call taken while riding, after the last stop' : 'add a work stop first'}
              onClick={() => addStop({ kind: 'combo', dwellMin: Number(comboLen) || 60, name: 'Work + bike' })}>Add</button>
          </>)}
        </div>

        {/* the candidate under the pointer — ARRIVAL is the headline */}
        <div className={`bd-card${card ? '' : ' empty'}`}>
          {!card ? (
            <div className="pm-hint hand">
              {shown.length
                ? <>hover a pin for the numbers · tap one to add it as the next {kind === 'sleep' ? 'bed' : kind}</>
                : cands ? <>nothing within {Math.round(reach)} mi of the cursor — look farther, or loosen the filters</> : <>finding places…</>}
            </div>
          ) : (<>
            <div className="pm-card-head">
              <span className="pm-name">
                {kind === 'sleep' ? (card.type === 'hotel' ? '🏨' : '⛺') : kind === 'work' ? '💻' : '☕'} {card.name}
                {inChain(card) && <span className="chosen-tag">IN THE CHAIN</span>}
                {card.kind === 'camp' && <span className="veri-tag">RESEARCHED</span>}
              </span>
              {kind === 'sleep' && (
                <span className={`price-chip tier-${card.tier ?? 'unknown'}`}>
                  {card.price != null ? money(card.price) : card.type === 'hotel' ? '$$' : '$?'}
                </span>
              )}
              {kind !== 'sleep' && card.type === 'wifi_work' && (
                <span className={`wifi-badge ${wifiMeta(card.wifiStatus).cls}`}>
                  {wifiMeta(card.wifiStatus).icon} {wifiMeta(card.wifiStatus).label}
                </span>
              )}
            </div>
            <div className="bd-arrive">
              {card.behind
                ? <>next door <span className="dim">· at or just behind where the chain is — no riding</span></>
                : <>arrive <b>{card.arriveClock ?? '—'}</b>
                    <span className="dim"> · {card.milesFromStart} mi · {durMin(card.rideMinFromStart)} from the cursor</span></>}
            </div>
            <div className="pm-metrics">
              {card.beforeWorkOpen != null && (
                <div className="pm-metric">
                  <span className="pm-k">WORK CLOCK</span>
                  <span className={`pm-v${card.beforeWorkOpen ? '' : ' pm-warn'}`}>
                    {card.beforeWorkOpen ? 'sitting down before it opens' : `${durMin(card.minsLateForWork)} late`}
                  </span>
                </div>
              )}
              {card.lightLeftMin != null && (
                <div className="pm-metric">
                  <span className="pm-k">RIDING TIME LEFT</span>
                  <span className={`pm-v${card.lightLeftMin < 0 ? ' pm-warn' : ''}`}>
                    {card.lightLeftMin >= 0 ? `${durMin(card.lightLeftMin)} until you said you'd stop` : `${durMin(-card.lightLeftMin)} past your stop time`}
                  </span>
                </div>
              )}
              <div className="pm-metric">
                <span className="pm-k">OFF ROUTE</span>
                <span className={`pm-v ${card.detour ? 'pm-warn' : ''}`}>
                  {card.offRouteMi == null ? '—' : card.offRouteMi <= 0.1 ? 'on route' : `${card.offRouteMi} mi`}
                </span>
              </div>
              <div className="pm-metric">
                <span className="pm-k">ROUTE MILE</span>
                <span className="pm-v">mi {card.routeMile}</span>
              </div>
              {kind === 'sleep' && (
                <div className="pm-metric wide">
                  <span className="pm-k">IF YOU SLEEP HERE</span>
                  <span className="pm-v">
                    Day {n} becomes <b>{card.newDayMiles} mi</b>
                    {card.nextDayMiles != null && <> · Day {n + 1} becomes {card.nextDayMiles} mi</>}
                    {card.direction !== 'on_plan' && <span className="dim"> · {card.direction === 'farther' ? `${Math.abs(card.deltaMi)} mi past` : `${Math.abs(card.deltaMi)} mi short of`} the planned end</span>}
                  </span>
                </div>
              )}
            </div>
            {(card.showers || card.water || card.toilets || card.hours) && (
              <div className="pm-amen dim">
                {card.water && <span>💧 water</span>}
                {card.showers && <span>🚿 showers</span>}
                {card.toilets && <span>🚻 toilets</span>}
                {card.hours && <span>open {card.hours}</span>}
              </div>
            )}
            {fullAddress(card) && <div className="addr-line">{fullAddress(card)}</div>}
            {card.cyclistIntel && <div className="camp-intel">🚲 {card.cyclistIntel}</div>}
            {card.legalityNote && <div className="camp-legal">✔ {card.legalityNote}</div>}
            <div className="dest-actions">
              <a className="act" target="_blank" rel="noreferrer" href={appleMapsUrl(card.lat, card.lng, card)}>Apple Maps</a>
              <a className="act" target="_blank" rel="noreferrer" href={googleMapsUrl(card.lat, card.lng)}>Google Maps</a>
              <a className="act" target="_blank" rel="noreferrer" href={googleSearchUrl(card)}>Look up</a>
              {card.website && <a className="act" target="_blank" rel="noreferrer" href={card.website}>Site</a>}
            </div>
            <div className="pm-actions">
              {/* A venue can appear twice — library, McDonald's next door, back to
                  the library is exactly the day the rider described. */}
              <button className="primary" onClick={() => addCandidate(card)}>
                {kind === 'sleep' ? (end && (end.resourceId === card.id || end.campId === card.id)
                    ? 'This is tonight\'s bed' : `Sleep here — end Day ${n} at mi ${card.routeMile}`)
                  : kind === 'work' ? `Work here${inChain(card) ? ' again' : ''} — ${durMin(defaultWorkDwell)}`
                  : `Break here${inChain(card) ? ' again' : ''} — 30 min`}
              </button>
              {sel && <button className="ghost" onClick={() => setSelId(null)}>Clear</button>}
            </div>
          </>)}
        </div>

        {saveErr && <div className="error">{saveErr}</div>}
      </div>
    </div>
  );
}
