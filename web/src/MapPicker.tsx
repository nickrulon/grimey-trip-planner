import { useEffect, useMemo, useState } from 'react';
import { Map as MLMap } from 'maplibre-gl';
import {
  durMin, money, wifiMeta, fullAddress, appleMapsUrl, googleMapsUrl, googleSearchUrl,
} from './format';
import type { DayCanvas } from './types';
import {
  useCandidateLayer, useAnchorLayer, useCandidateHover, useFitOnce, pointAtMile,
  type CandFeature, type AnchorFeature,
} from './pickerLayers';
import BuildPanel from './BuildPanel';

// MAP PICKER — choosing a bed or a work stop is a geographic decision, so it
// is made ON the map: every candidate is a named marker on the day's stretch
// of route, forward and back, with the mileage from where the day started and
// what picking it does to the day. Hover (or tap) for the numbers.
//
// It draws into the SHARED map canvas rather than spinning up a second one,
// so the route, its provenance and every other layer stay exactly as drawn.
//
// Three modes. 'sleep' and 'work' answer one question and close. 'build'
// stays open and composes a whole day, link by link (BuildPanel) — the same
// map, the same drawing code, a different panel.

export interface PickCandidate {
  id: string;
  kind?: 'resource' | 'camp';
  name: string;
  type?: string;
  routeMile: number;
  offRouteMi: number | null;
  lat: number;
  lng: number;
  // consequence / cost
  milesFromStart: number;
  rideMinFromStart: number;
  deltaMi: number;
  detour: boolean;
  direction: 'farther' | 'earlier' | 'on_plan';
  score: number;
  // sleep-only
  price?: number | null;
  priceNote?: string | null;
  tier?: string;
  showers?: boolean;
  water?: boolean;
  toilets?: boolean;
  newDayMiles?: number;
  nextDayMiles?: number | null;
  confidence?: string | null;
  cyclistIntel?: string | null;
  legalityNote?: string | null;
  // work-only
  wifiStatus?: string | null;
  hours?: string | null;
  afternoonMi?: number;
  afternoonMin?: number;
  address?: string | null;
  town?: string | null;
  state?: string | null;
  website?: string | null;
  phone?: string | null;
  booking?: string | null;
  seasonalNote?: string | null;
  tentsOk?: boolean;
  sources?: string[];
  wifiNear: number;
  chosen?: boolean;
}

export interface PickerContext {
  mode: 'sleep' | 'work' | 'build';
  dayNumber: number;
  startMile: number;
  startName: string;
  endMile: number;
  endName: string;
  idealMile?: number;
  speedMph: number;
  candidates: PickCandidate[];
  onPick: (c: PickCandidate) => Promise<void> | void;
  onClose: () => void;
  onList: () => void;
  onWiden?: (fwd: number) => void;
  widened?: number;
  // build mode: the day as it stands (the chain is seeded from it) and what
  // to do once a chain is saved
  canvas?: DayCanvas;
  onSaved?: () => void;
}

type Filter = 'all' | 'on_plan' | 'farther' | 'earlier' | 'onroute';

const filtersFor = (mode: 'sleep' | 'work'): { id: Filter; label: string; hint: string }[] => [
  { id: 'all', label: 'All', hint: 'every option in range' },
  { id: 'on_plan', label: 'On plan', hint: mode === 'sleep' ? 'within 2 mi of the planned end' : 'right where the morning light runs out' },
  { id: 'farther', label: mode === 'sleep' ? 'Ride farther' : 'Longer morning', hint: mode === 'sleep' ? 'more than 2 mi past the planned end' : 'ride more before sitting down' },
  { id: 'earlier', label: mode === 'sleep' ? 'Stop early' : 'Shorter morning', hint: mode === 'sleep' ? 'more than 2 mi short of the planned end' : 'sit down sooner, ride more after' },
  { id: 'onroute', label: 'Low detour', hint: 'under 1.5 mi off the route' },
];

export default function MapPicker({ ctx, map }: { ctx: PickerContext; map: MLMap | null }) {
  // Two components rather than one early return, so each keeps a stable hook order.
  return ctx.mode === 'build' ? <BuildPanel ctx={ctx} map={map} /> : <OneShotPicker ctx={ctx} map={map} />;
}

function OneShotPicker({ ctx, map }: { ctx: PickerContext; map: MLMap | null }) {
  const mode = ctx.mode as 'sleep' | 'work';
  const [filter, setFilter] = useState<Filter>('all');
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const shown = useMemo(() => ctx.candidates.filter((c) => {
    if (filter === 'all') return true;
    if (filter === 'onroute') return (c.offRouteMi ?? 0) <= 1.5;
    return c.direction === filter;
  }), [ctx.candidates, filter]);

  const sel = shown.find((c) => c.id === selId) ?? null;
  const hover = shown.find((c) => c.id === hoverId) ?? null;
  const card = sel ?? hover;

  // ---- draw candidates + the day's anchors -----------------------------------
  const dotColor = mode === 'work'
    ? ['match', ['get', 'wifi'],
        'confirmed', '#2f7d32', 'likely', '#8a6d00', 'none', '#b3402a', '#8a8270']
    : ['match', ['get', 'tier'],
        'free', '#2f7d32', 'budget', '#4f7942', 'moderate', '#d96f00',
        'high', '#b3402a', 'room', '#5b4a92', '#8a8270'];
  const feats = useMemo<CandFeature[]>(() => shown.map((c) => ({
    id: c.id, name: c.name, lat: c.lat, lng: c.lng,
    sort: -c.score, chosen: !!c.chosen,
    props: { wifi: c.wifiStatus ?? 'unknown', tier: c.tier ?? 'unknown' },
  })), [shown]);
  useCandidateLayer(map, feats, dotColor);

  // Day start + planned end, so "how far short / past" is visible, not just numeric.
  const [anchors, setAnchors] = useState<AnchorFeature[]>([]);
  useEffect(() => {
    let live = true;
    (async () => {
      const [s, e] = await Promise.all([pointAtMile(ctx.startMile), pointAtMile(ctx.endMile)]);
      if (!live) return;
      const a: AnchorFeature[] = [];
      if (s) a.push({ label: `START mi ${ctx.startMile}`, lat: s.lat, lng: s.lng });
      if (e) a.push({ label: `PLANNED END mi ${ctx.endMile}`, lat: e.lat, lng: e.lng });
      setAnchors(a);
    })();
    return () => { live = false; };
  }, [ctx.startMile, ctx.endMile]);
  useAnchorLayer(map, anchors);

  // ---- hover + click on the markers ------------------------------------------
  useCandidateHover(map, setHoverId, setSelId, [shown]);

  // Frame the day's stretch once per day/mode, then leave the camera alone so
  // panning and zooming to inspect is never fought by a re-fit.
  const lo = Math.min(ctx.startMile, ...ctx.candidates.map((c) => c.routeMile));
  const hi = Math.max(ctx.endMile, ...ctx.candidates.map((c) => c.routeMile));
  useFitOnce(map, `${mode}-${ctx.dayNumber}-${ctx.widened ?? 0}`, lo, hi,
    ctx.candidates.map((c) => [c.lng, c.lat] as [number, number]),
    { top: 120, bottom: 260, left: 60, right: 60 });

  const pick = async (c: PickCandidate) => {
    setBusy(true); setErr(null);
    try { await ctx.onPick(c); } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  const dirLabel = (c: PickCandidate) => {
    if (c.direction === 'on_plan') return 'on plan';
    if (mode === 'work') {
      return c.direction === 'farther'
        ? `${Math.abs(c.deltaMi)} mi longer morning`
        : `${Math.abs(c.deltaMi)} mi shorter morning`;
    }
    return c.direction === 'farther'
      ? `ride ${Math.abs(c.deltaMi)} mi farther`
      : `stop ${Math.abs(c.deltaMi)} mi early`;
  };

  return (
    <div className="picker-map">
      <div className="pm-top">
        <div className="pm-title">
          <b>{mode === 'sleep' ? 'WHERE DO I SLEEP?' : 'WHERE DO I WORK?'}</b>
          <span className="dim">
            Day {ctx.dayNumber} · starts {ctx.startName} (mi {ctx.startMile})
            {mode === 'sleep'
              ? <> · planned end {ctx.endName} (mi {ctx.endMile})</>
              : <> · daylight runs out near mi {ctx.idealMile}</>}
          </span>
        </div>
        <div className="pm-top-actions">
          <button className="ghost" onClick={ctx.onList}>List view</button>
          <button className="pm-x" onClick={ctx.onClose} aria-label="Close">✕ Done</button>
        </div>
      </div>

      <div className="pm-filters">
        {filtersFor(mode).map((f) => (
          <button key={f.id} title={f.hint}
            className={filter === f.id ? 'chip on' : 'chip'}
            onClick={() => { setFilter(f.id); setSelId(null); }}>
            {f.label}
            <span className="pm-count">{
              f.id === 'all' ? ctx.candidates.length
                : f.id === 'onroute' ? ctx.candidates.filter((c) => (c.offRouteMi ?? 0) <= 1.5).length
                : ctx.candidates.filter((c) => c.direction === f.id).length
            }</span>
          </button>
        ))}
        {ctx.onWiden && (
          <button className="chip" onClick={() => ctx.onWiden!((ctx.widened ?? 20) + 20)}>
            + look {(ctx.widened ?? 20) + 20} mi ahead
          </button>
        )}
      </div>

      {err && <div className="pm-err error">{err}</div>}

      {/* Hover / tap readout — the numbers the rider actually decides on */}
      <div className={`pm-card${card ? '' : ' empty'}`}>
        {!card ? (
          <div className="pm-hint hand">
            hover a name for the numbers · tap one to pick it
            <span className="dim"> — {shown.length} shown, riding {ctx.speedMph} mph incl. climbing</span>
          </div>
        ) : (<>
          <div className="pm-card-head">
            <span className="pm-name">
              {mode === 'sleep' ? (card.type === 'hotel' ? '🏨' : '⛺') : '☕'} {card.name}
              {card.chosen && <span className="chosen-tag">CURRENT</span>}
              {card.kind === 'camp' && <span className="veri-tag">RESEARCHED</span>}
            </span>
            {mode === 'sleep' && (
              <span className={`price-chip tier-${card.tier ?? 'unknown'}`}>
                {card.price != null ? money(card.price) : card.type === 'hotel' ? '$$' : '$?'}
              </span>
            )}
            {mode === 'work' && (
              <span className={`wifi-badge ${wifiMeta(card.wifiStatus).cls}`}>
                {wifiMeta(card.wifiStatus).icon} {wifiMeta(card.wifiStatus).label}
              </span>
            )}
          </div>

          <div className="pm-metrics">
            <div className="pm-metric">
              <span className="pm-k">FROM {ctx.startName.slice(0, 18).toUpperCase()}</span>
              <span className="pm-v"><b>{card.milesFromStart} mi</b> · {durMin(card.rideMinFromStart)}</span>
            </div>
            <div className="pm-metric">
              <span className="pm-k">VS PLAN</span>
              <span className={`pm-v ${card.direction !== 'on_plan' ? 'pm-warn' : ''}`}>{dirLabel(card)}</span>
            </div>
            <div className="pm-metric">
              <span className="pm-k">OFF ROUTE</span>
              <span className={`pm-v ${card.detour ? 'pm-warn' : ''}`}>
                {card.offRouteMi == null ? '—' : card.offRouteMi <= 0.1 ? 'on route' : `${card.offRouteMi} mi`}
                {card.detour && <span className="dim"> · short drive/walk</span>}
              </span>
            </div>
            <div className="pm-metric">
              <span className="pm-k">ROUTE MILE</span>
              <span className="pm-v">mi {card.routeMile}</span>
            </div>
            {mode === 'sleep' ? (
              <div className="pm-metric wide">
                <span className="pm-k">IF YOU PICK IT</span>
                <span className="pm-v">
                  Day {ctx.dayNumber} becomes <b>{card.newDayMiles} mi</b>
                  {card.nextDayMiles != null && <> · Day {ctx.dayNumber + 1} starts here and becomes {card.nextDayMiles} mi</>}
                </span>
              </div>
            ) : (
              <div className="pm-metric wide">
                <span className="pm-k">AFTER WORK</span>
                <span className="pm-v">
                  <b>{card.afternoonMi} mi</b> · {durMin(card.afternoonMin)} left to {ctx.endName}
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

          {/* Everything the research knows, on demand — the decision first,
              the reading material behind a disclosure. */}
          <details className="pm-more" open={detailsOpen}
            onToggle={(e) => setDetailsOpen((e.target as HTMLDetailsElement).open)}>
            <summary>Full details</summary>
            <div className="pm-more-body">
              {card.priceNote && <div><b>Price:</b> {card.priceNote}</div>}
              {card.legalityNote && <div className="camp-legal">✔ {card.legalityNote}</div>}
              {card.cyclistIntel && <div className="camp-intel">🚲 {card.cyclistIntel}</div>}
              {card.seasonalNote && <div className="dim">🗓 {card.seasonalNote}</div>}
              {card.booking && <div><b>Booking:</b> {card.booking}</div>}
              {card.tentsOk === false && <div className="warn">⚠ Tents not confirmed here — verify</div>}
              {card.type && <div className="dim">Type: {String(card.type).replace(/_/g, ' ')}</div>}
              {card.confidence && <div className="dim">Research confidence: {card.confidence}</div>}
              {card.wifiNear > 0 && <div className="dim">{card.wifiNear} wi-fi/work stop{card.wifiNear === 1 ? '' : 's'} within 2 mi</div>}
              {(card.sources?.length ?? 0) > 0 && (
                <div className="dim">Sources: {card.sources!.slice(0, 4).map((u, i) => (
                  <a key={i} href={u} target="_blank" rel="noreferrer">[{i + 1}] </a>))}
                </div>
              )}
              {!card.priceNote && !card.legalityNote && !card.cyclistIntel && !card.booking && (
                <div className="dim">
                  OpenStreetMap has little detail on this one — use “Look up” to check it before committing.
                </div>
              )}
              <div className="dest-actions">
                <a className="act" target="_blank" rel="noreferrer" href={appleMapsUrl(card.lat, card.lng, card)}>Apple Maps</a>
                <a className="act" target="_blank" rel="noreferrer" href={googleMapsUrl(card.lat, card.lng)}>Google Maps</a>
                <a className="act" target="_blank" rel="noreferrer" href={googleSearchUrl(card)}>Look up</a>
                {card.website && <a className="act" target="_blank" rel="noreferrer" href={card.website}>Site</a>}
                {card.phone && <a className="act" href={`tel:${card.phone}`}>Call</a>}
              </div>
            </div>
          </details>

          <div className="pm-actions">
            {card.chosen ? (
              <span className="dim">already today's {mode === 'sleep' ? 'bed' : 'work stop'}</span>
            ) : (
              <button className="primary" disabled={busy} onClick={() => pick(card)}>
                {busy ? 'Applying…'
                  : mode === 'sleep'
                    ? `Sleep here — end Day ${ctx.dayNumber} at mi ${card.routeMile}`
                    : `Work here — mi ${card.routeMile}`}
              </button>
            )}
            {sel && <button className="ghost" onClick={() => setSelId(null)}>Clear</button>}
          </div>
        </>)}
      </div>
    </div>
  );
}
