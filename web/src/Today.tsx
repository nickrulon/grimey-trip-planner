import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGet, apiPost } from './api';
import {
  DayCanvas, PlanResponse, SleepOption, WorkOption, FitOptions, DayWeather, ReplanPreview,
  CanvasMark, DayTransit, MarkColor,
} from './types';
import type { PickerContext, PickCandidate } from './MapPicker';
import type { IntelRecord } from './types';
import {
  clockH, clockMin, durMin, money, stampDate, wifiMeta, readinessMeta, NOTE_ICON, r1,
  fullAddress, pasteAddress, appleMapsUrl, googleMapsUrl, googleSearchUrl,
} from './format';

// TODAY — the Day Canvas. One day, understood at a glance before it is edited:
// where I wake up, when I leave, how far to work, what hours (local AND
// Eastern), how reliable the wi-fi is, how far after, where I sleep, whether
// it all fits inside daylight, what it costs, and what's still unresolved.

const PHASE_COLOR: Record<string, string> = {
  night: '#232946', astro: '#31395e', naut: '#4d5b82',
  civil: '#d99a55', low: '#eec984', day: '#c9e2f2',
};

function skyGradient(phases: string[] | undefined, t0: number, t1: number): string {
  if (!phases?.length) return PHASE_COLOR.day;
  const stops: string[] = [];
  const span = t1 - t0;
  for (let i = 0; i < 48; i++) {
    const h0 = i / 2, h1 = (i + 1) / 2;
    if (h1 < t0 || h0 > t1) continue;
    const c = PHASE_COLOR[phases[i]] ?? PHASE_COLOR.day;
    stops.push(`${c} ${(((Math.max(h0, t0) - t0) / span) * 100).toFixed(2)}%`);
    stops.push(`${c} ${(((Math.min(h1, t1) - t0) / span) * 100).toFixed(2)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

const hhmm = (min: number) => {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

const minOf = (hm: string): number | null => {
  const [h, m] = String(hm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
};

// The eight mark colours. Mirrors MARK_COLORS in server/plan.mjs and the
// .mk-* tokens in styles.css — the DB stores the NAME, never a hex value, so a
// palette change here updates every mark already drawn.
const MARK_COLORS: MarkColor[] = ['slate', 'red', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];

const markTitle = (m: CanvasMark) => [
  m.endMin != null
    ? `${m.label} · ${clockMin(m.startMin)}–${clockMin(m.endMin)}`
    : `${m.label} · ${clockMin(m.startMin)}`,
  m.notes,
  m.scope === 'mile' ? `pinned to mi ${m.routeMile}` : 'pinned to this day',
  'fixed — does not move when you change roll-out',
].filter(Boolean).join(' · ');

// ---- the timeline ------------------------------------------------------------
// The bars are the controls. Drag the ride block to change when you roll out;
// drag the work block to hold the same owed hours later or earlier; drag the
// dusk handle to say how late you are willing to ride. Duration of a ride
// block is NOT draggable — it is distance ÷ speed, and distance is set by the
// anchors (work stop, bed). Dragging a block earlier against an anchored work
// block simply opens a gap, which is exactly what waiting looks like.
function Timeline({ c, full, editable, onCommit, onEditMark }: {
  c: DayCanvas; full: boolean;
  editable: boolean;
  onCommit: (patch: { startTime?: string | null; workStart?: string | null; rideUntil?: string | null }) => void;
  onEditMark?: (m: CanvasMark) => void;
}) {
  const sun = c.sun;
  const laneRef = useRef<HTMLDivElement>(null);
  // Live lane width, so a mark can decide whether its label fits inside its
  // block or has to hang beside it.
  const [laneW, setLaneW] = useState(600);
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLaneW(el.clientWidth || 600));
    ro.observe(el);
    setLaneW(el.clientWidth || 600);
    return () => ro.disconnect();
  }, []);
  const [drag, setDrag] = useState<null | {
    what: 'ride' | 'work' | 'until';
    startX: number; origMin: number; deltaMin: number;
  }>(null);
  const lastEnd = c.blocks.length ? c.blocks[c.blocks.length - 1].endMin / 60 : 18;
  // The focused window has to stretch to cover the rider's own marks. A mark is
  // the fixed thing the ride has to meet — a 9pm one silently clipped out of the
  // default view would be the opposite of drawing it on the bar.
  const marks = c.marks ?? [];
  const markLo = marks.length ? Math.min(...marks.map((m) => m.startMin / 60)) - 0.3 : Infinity;
  const markHi = marks.length
    ? Math.max(...marks.map((m) => (m.endMin ?? m.startMin) / 60)) + 0.3
    : -Infinity;
  const t0 = full ? 0
    : Math.max(0, Math.min((sun?.dawn ?? 6) - 1, c.departMin / 60 - 0.5, markLo));
  const t1 = full ? 24
    : Math.min(24, Math.max((sun?.dusk ?? 19) + 1.2, lastEnd + 0.5, markHi));
  const X = (h: number) => `${(((h - t0) / (t1 - t0)) * 100).toFixed(2)}%`;
  const W = (a: number, b: number) => `${(((b - a) / (t1 - t0)) * 100).toFixed(2)}%`;

  const hourTicks: number[] = [];
  for (let h = Math.ceil(t0); h <= Math.floor(t1); h++) {
    if (full ? h % 3 === 0 : h % 2 === 0) hourTicks.push(h);
  }

  // dawn/sunset label above the sky band, sunrise/dusk below — the pairs sit
  // minutes apart and would otherwise collide.
  const events = sun ? [
    { h: sun.dawn, label: 'dawn', row: 'top' }, { h: sun.sunrise, label: 'sunrise', row: 'bot' },
    { h: sun.sunset, label: 'sunset', row: 'top' }, { h: sun.dusk, label: 'dusk', row: 'bot' },
  ].filter((e) => e.h != null && e.h >= t0 && e.h <= t1) : [];

  const duskH = sun?.dusk ?? null;

  // ---- dragging -------------------------------------------------------------
  const minsPerPx = () => {
    const w = laneRef.current?.clientWidth ?? 600;
    return ((t1 - t0) * 60) / Math.max(1, w);
  };
  const snap = (m: number) => Math.round(m / 5) * 5;

  const beginDrag = (what: 'ride' | 'work' | 'until', origMin: number) =>
    (e: React.PointerEvent) => {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      setDrag({ what, startX: e.clientX, origMin, deltaMin: 0 });
    };

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      setDrag((d) => d && { ...d, deltaMin: snap((e.clientX - d.startX) * minsPerPx()) });
    };
    const up = () => {
      setDrag((d) => {
        if (d && d.deltaMin !== 0) {
          const next = hhmm(d.origMin + d.deltaMin);
          if (d.what === 'ride') onCommit({ startTime: next });
          if (d.what === 'work') onCommit({ workStart: next });
          if (d.what === 'until') onCommit({ rideUntil: next });
        }
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.what, drag?.origMin, drag?.startX]);

  // Live offsets while dragging, so the bars follow the finger before saving.
  const rideShift = drag?.what === 'ride' ? drag.deltaMin : 0;
  const workShift = drag?.what === 'work' ? drag.deltaMin : 0;
  const untilShift = drag?.what === 'until' ? drag.deltaMin : 0;

  const workStartMin = sun?.work ? Math.round(sun.work.localStart * 60) + workShift : null;
  const workEndMin = sun?.work ? Math.round(sun.work.localEnd * 60) + workShift : null;
  const rideToMin = (c.times?.rideToMin ?? (duskH != null ? duskH * 60 : null));
  const untilMin = rideToMin != null ? rideToMin + untilShift : null;

  // Marks are the rider's own fixed appointments. They are NEVER passed through
  // shiftFor: the 3:30 boat leaves at 3:30 whatever time you roll out, and that
  // is the entire reason they live in their own array instead of in `blocks`.
  const blockMarks = marks.filter(
    (m) => m.shape === 'block' && m.endMin != null
      && m.endMin / 60 > t0 && m.startMin / 60 < t1
  );
  const lineMarks = marks.filter(
    (m) => m.shape === 'line' && m.startMin / 60 >= t0 && m.startMin / 60 <= t1
  );
  const pxPerH = laneW / Math.max(0.1, t1 - t0);
  // Overlapping block marks stack into sub-rows, as a calendar does, so a
  // short "buy ticket" never paints over the ferry behind it. Greedy: each
  // mark takes the first row whose previous mark has already ended.
  const rowEnds: number[] = [];
  const markRow = blockMarks.map((m) => {
    let r = rowEnds.findIndex((e) => e <= m.startMin);
    if (r === -1) { r = rowEnds.length; rowEnds.push(0); }
    rowEnds[r] = m.endMin!;
    return r;
  });
  // Line flags live in the sky band, staggered onto a second row only when
  // two flags would actually collide.
  const flagW = (m: CanvasMark) => (m.label.length + 7) * 5.6 + 10;
  const flagEnds: number[] = [];
  const lineRow = lineMarks.map((m) => {
    const x = (m.startMin / 60 - t0) * pxPerH;
    const flip = (m.startMin / 60 - t0) / (t1 - t0) > 0.62;
    const x0 = flip ? x - flagW(m) : x, x1 = flip ? x : x + flagW(m);
    let r = flagEnds.findIndex((e) => e <= x0);
    if (r === -1) { r = flagEnds.length; flagEnds.push(0); }
    if (r > 1) r = 1;                       // two rows fit in the band; beyond that, overlap
    flagEnds[r] = x1;
    return r;
  });

  // A ride block keeps its duration and slides; work slides with its own shift.
  const shiftFor = (b: { kind: string }, i: number) => {
    if (b.kind === 'work') return workShift;
    // the morning ride is what "roll out" moves; the afternoon ride is pinned
    // to the end of the work block, so it follows the WORK shift
    if (b.kind === 'ride') return i === 0 ? rideShift : workShift;
    return 0;
  };

  return (
    <div className="tl-canvas">
      {/* The sky and the three lanes are one stack, so a line mark can cross
          all of them — a 3:30 ferry has to visibly cut the ride block. */}
      <div className="tl-stack">
      {/* SKY — immutable reality, behind everything */}
      <div className="tl-sky" style={{ background: skyGradient(sun?.phases, t0, t1) }}>
        {events.map((e) => (
          <div key={e.label} className={`tl-sun-ev ev-${e.row}`} style={{ left: X(e.h!) }}>
            <span>{e.label} {clockH(e.h)}</span>
          </div>
        ))}
      </div>

      {/* OBLIGATIONS — the work window: draggable, but always the same hours */}
      <div className="tl-lane tl-obl">
        {sun?.workday && sun.work && workStartMin != null && workEndMin != null && (
          <div className={`tl-work-window${editable ? ' draggable' : ''}${drag?.what === 'work' ? ' dragging' : ''}`}
            onPointerDown={beginDrag('work', Math.round(sun.work.localStart * 60))}
            style={{
              left: X(Math.max(t0, workStartMin / 60)),
              width: W(Math.max(t0, workStartMin / 60), Math.min(t1, workEndMin / 60)),
            }}
            title={editable ? 'Drag to hold the same work hours later or earlier' : undefined}>
            <span>
              WORK {clockMin(workStartMin)}–{clockMin(workEndMin)}{' '}
              <i>({clockH(sun.work.etStart + workShift / 60)}–{clockH(sun.work.etEnd + workShift / 60)} ET)</i>
            </span>
          </div>
        )}
        {!sun?.workday && <div className="tl-nowork hand">no work owed today</div>}
      </div>

      {/* MARKS — fixed appointments, in their own lane so they never fight the
          RIDE block's label for space */}
      {blockMarks.length > 0 && (
        <div className="tl-lane tl-marks" style={{ height: rowEnds.length * 20 + (rowEnds.length - 1) * 2 }}>
          {blockMarks.map((m, i) => {
            const a = Math.max(m.startMin / 60, t0), z = Math.min(m.endMin! / 60, t1);
            // A 40-minute ferry on a 13-hour canvas is a sliver: when the label
            // cannot fit inside, hang it beside the block instead of clipping
            // it to "Fe". Near the right edge it hangs left, like every flag.
            const inside = (z - a) * pxPerH >= m.label.length * 6.5 + 12;
            const flip = (z - t0) / (t1 - t0) > 0.62;
            return (
              <div key={m.id}
                className={`tl-mark mk-${m.color}${inside ? '' : ' narrow'}${!inside && flip ? ' flip' : ''}`}
                style={{ left: X(a), width: W(a, z), top: markRow[i] * 22 }}
                title={markTitle(m)}
                onClick={onEditMark ? () => onEditMark(m) : undefined}>
                <span className={inside ? 'tl-mark-label' : 'tl-mark-flag'}>{m.label}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* PLAN — what the rider is choosing */}
      <div className="tl-lane tl-plan" ref={laneRef}>
        {c.blocks.map((b, i) => {
          const sh = shiftFor(b, i) / 60;
          const a = b.startMin / 60 + sh, z = b.endMin / 60 + sh;
          if (z <= t0 || a >= t1) return null;
          const limit = untilMin != null ? untilMin / 60 : duskH;
          const overLimit = b.kind === 'ride' && limit != null && z > limit;
          const isMorningRide = b.kind === 'ride' && i === 0;
          return (
            <div key={i}
              className={`tl-block tl-${b.kind}${overLimit ? ' tl-over' : ''}${editable && isMorningRide ? ' draggable' : ''}${drag?.what === 'ride' && isMorningRide ? ' dragging' : ''}`}
              onPointerDown={isMorningRide ? beginDrag('ride', c.departMin) : undefined}
              style={{ left: X(Math.max(a, t0)), width: W(Math.max(a, t0), Math.min(z, t1)) }}
              title={isMorningRide && editable
                ? `Drag to change roll-out — ${b.miles} mi takes ${durMin(b.rideMin)} whatever time you leave`
                : `${b.label} · ${clockMin(b.startMin)}–${clockMin(b.endMin)}`}>
              <span className="tl-block-label">
                {b.kind === 'ride' ? `RIDE ${b.miles} mi`
                  : b.kind === 'work' ? 'WORK'
                  : b.kind === 'combo' ? `WORK+BIKE ${b.miles} mi`
                  : b.kind === 'break' ? durMin(b.dwellMin) : ''}
              </span>
              {overLimit && limit != null && (
                <div className="tl-overhatch" style={{
                  left: `${((Math.max(limit, a) - a) / (z - a)) * 100}%`,
                }} />
              )}
            </div>
          );
        })}
        {c.rest && <div className="tl-rest hand">rest day — same bed, another night</div>}

        {/* "I'll ride until…" handle — drag past dusk to allow lights */}
        {editable && !c.rest && untilMin != null && untilMin / 60 >= t0 && untilMin / 60 <= t1 && (
          <div className={`tl-until${drag?.what === 'until' ? ' dragging' : ''}${
              (untilMin / 60 - t0) / (t1 - t0) > 0.62 ? ' flip' : ''}`}
            style={{ left: X(untilMin / 60) }}
            onPointerDown={beginDrag('until', rideToMin ?? 0)}
            title="Drag to say how late you are willing to ride">
            <span className="tl-until-flag">
              ride until {clockMin(untilMin)}
              {duskH != null && untilMin / 60 > duskH + 0.02 && (
                <b> · {durMin(untilMin - duskH * 60)} dark</b>
              )}
            </span>
          </div>
        )}
      </div>

      {/* LINE MARKS — a moment, not a span. Drawn over every lane, on the same
          flip rule as the "ride until" flag so the label never runs off the
          card near the right edge. */}
      {lineMarks.length > 0 && (
        <div className="tl-marklines">
          {lineMarks.map((m, i) => (
            <div key={m.id}
              className={`tl-markline mk-${m.color}${
                (m.startMin / 60 - t0) / (t1 - t0) > 0.62 ? ' flip' : ''}${lineRow[i] ? ' row2' : ''}`}
              style={{ left: X(m.startMin / 60) }}>
              {/* The flag is the click target and sits in the sky band, where
                  nothing is draggable — the line itself lets pointers through
                  so it never steals a drag from the WORK window or the ride. */}
              <span className="tl-markline-flag" title={markTitle(m)}
                onClick={onEditMark ? () => onEditMark(m) : undefined}>
                {m.label} {clockMin(m.startMin)}
              </span>
            </div>
          ))}
        </div>
      )}
      </div>

      {drag && (
        <div className="tl-drag-readout">
          {drag.what === 'ride' && <>roll out <b>{clockMin(c.departMin + drag.deltaMin)}</b></>}
          {drag.what === 'work' && sun?.work && (
            <>work <b>{clockMin(Math.round(sun.work.localStart * 60) + drag.deltaMin)}</b> local
              {' '}· {clockH(sun.work.etStart + drag.deltaMin / 60)} ET</>
          )}
          {drag.what === 'until' && <>ride until <b>{clockMin((rideToMin ?? 0) + drag.deltaMin)}</b></>}
          <span className="dim"> — release to save</span>
        </div>
      )}

      <div className="tl-axis">
        {hourTicks.map((h) => (
          <span key={h} className="tl-tick" style={{ left: X(h) }}>{clockH(h).replace(':00', '')}</span>
        ))}
      </div>
    </div>
  );
}

// ---- elevation sparkline (ported) ---------------------------------------------
function ElevProfile({ data }: { data: [number, number][] }) {
  if (data.length < 2) return null;
  const W = 300, H = 56;
  const m0 = data[0][0], m1 = data[data.length - 1][0];
  const es = data.map((d) => d[1]);
  const e0 = Math.min(...es), e1 = Math.max(...es);
  const x = (m: number) => 2 + ((m - m0) / Math.max(0.1, m1 - m0)) * (W - 4);
  const y = (e: number) => H - 12 - ((e - e0) / Math.max(1, e1 - e0)) * (H - 20);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(d[0]).toFixed(1)},${y(d[1]).toFixed(1)}`).join('');
  const area = `${line}L${x(m1).toFixed(1)},${H - 10}L${x(m0).toFixed(1)},${H - 10}Z`;
  return (
    <svg className="elev-svg" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
      <path d={area} fill="#6c8a5f" opacity="0.15" />
      <path d={line} fill="none" stroke="#57503f" strokeWidth="1.8" strokeLinejoin="round" />
      <text x={W - 2} y={9} textAnchor="end" fontSize="9" fill="#8a8270">{e1.toLocaleString()} ft</text>
      <text x={2} y={H - 1} fontSize="9" fill="#8a8270">mi {Math.round(m0)}–{Math.round(m1)}</text>
    </svg>
  );
}

const COST_CHIPS_LODGE_CAMP = [0, 10, 20, 35];
const COST_CHIPS_LODGE_ROOM = [60, 80, 100, 130];
const COST_CHIPS_MISC = [0, 5, 12, 25];

export default function Today({ curDay, setCurDay, plan, refetchPlan, showDayOnMap, showPointOnMap, armMapPick, openPicker, gotoRide }: {
  curDay: number | null;
  setCurDay: (n: number) => void;
  plan: PlanResponse | null;
  refetchPlan: () => void;
  showDayOnMap: (n: number) => void;
  showPointOnMap: (lng: number, lat: number, html?: string) => void;
  armMapPick: (prompt: string) => Promise<[number, number]>;
  openPicker: (ctx: PickerContext | null) => void;
  gotoRide: () => void;
}) {
  const n = curDay ?? 1;
  const [canvas, setCanvas] = useState<DayCanvas | null>(null);
  const [full24, setFull24] = useState(false);
  const [canvasAdd, setCanvasAdd] = useState(false);
  // The + block panel offers two different things. A break is mile-anchored and
  // slides; a mark is time-anchored and does not. editMark holds the mark being
  // edited, so one form serves both create and edit.
  const [addMode, setAddMode] = useState<'break' | 'mark'>('break');
  const [editMark, setEditMark] = useState<CanvasMark | null>(null);
  // Opening the panel from the list (which can sit a screen below the canvas
  // on a phone) scrolls the panel into view; the nonce makes each open count.
  const addPanelRef = useRef<HTMLDivElement>(null);
  const [panelNonce, setPanelNonce] = useState(0);
  useEffect(() => {
    // Instant, not smooth: smooth scrolling inside the fixed .page container is
    // unreliable, and a panel that silently stays off-screen is the bug here.
    if (panelNonce) addPanelRef.current?.scrollIntoView({ block: 'nearest' });
  }, [panelNonce]);
  const openMarkPanel = (m: CanvasMark | null, scroll = false) => {
    setEditMark(m); setAddMode('mark'); setCanvasAdd(true);
    if (scroll) setPanelNonce((k) => k + 1);
  };
  // true = the next work pick ADDS a stop instead of replacing the day's one
  const [appendWork, setAppendWork] = useState(false);
  const [sheet, setSheet] = useState<null | 'sleep' | 'work' | 'fit'>(null);
  const [sleepOpts, setSleepOpts] = useState<SleepOption[] | null>(null);
  const [sleepFilter, setSleepFilter] = useState<'recommended' | 'cheapest' | 'free' | 'camp' | 'room'>('recommended');
  const [openSleep, setOpenSleep] = useState<string | null>(null);
  const [workOpts, setWorkOpts] = useState<WorkOption[] | null>(null);
  const [fit, setFit] = useState<FitOptions | null>(null);
  const [wx, setWx] = useState<Record<number, DayWeather>>({});
  const [profile, setProfile] = useState<[number, number][] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [actualMile, setActualMile] = useState('');
  const [actualNotes, setActualNotes] = useState('');
  const [preview, setPreview] = useState<ReplanPreview | null>(null);
  const [replanMode, setReplanMode] = useState<'rebuild' | 'anchors'>('rebuild');
  const [endDraft, setEndDraft] = useState('');

  const dayCount = plan?.days.length ?? canvas?.dayCount ?? 1;

  const load = useCallback(async () => {
    try {
      setErr(null);
      setCanvas(await apiGet<DayCanvas>(`/api/plan/day/${n}/canvas`));
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  }, [n]);

  useEffect(() => {
    setSheet(null); setSleepOpts(null); setWorkOpts(null); setFit(null);
    setProfile(null); setEditing(false); setPreview(null); setEndDraft(''); setAppendWork(false);
    setCanvasAdd(false); setEditMark(null);
    load();
  }, [load]);

  useEffect(() => {
    apiGet<{ byDay: Record<number, DayWeather> }>('/api/weather')
      .then((w) => setWx(w.byDay ?? {})).catch(() => { /* best-effort */ });
  }, []);

  useEffect(() => {
    if (!canvas || canvas.rest) return;
    apiGet<{ profile: [number, number][] | null }>(`/api/plan/day/${n}/profile`)
      .then((p) => setProfile(p.profile)).catch(() => setProfile(null));
  }, [n, canvas?.startMile, canvas?.endMile]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(async (fn: () => Promise<unknown>, keepSheet = false) => {
    setBusy(true); setErr(null);
    try {
      await fn();
      await load();
      refetchPlan();
      if (!keepSheet) setSheet(null);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  }, [load, refetchPlan]);

  const openSleepSheet = async () => {
    setSheet('sleep'); setOpenSleep(null);
    try {
      const r = await apiGet<{ options: SleepOption[] }>(`/api/plan/day/${n}/sleep-options`);
      setSleepOpts(r.options);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };
  const openWorkSheet = async () => {
    setSheet('work');
    try {
      const r = await apiGet<{ candidates: WorkOption[] }>(`/api/plan/day/${n}/work-options`);
      setWorkOpts(r.candidates);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  // ---- map pickers: geography first, list as the fallback ---------------------
  interface SleepResp {
    dayNumber: number; startMile: number; startName: string;
    endMile: number; endName: string; speedMph: number; options: SleepOption[];
  }
  interface WorkResp {
    dayNumber: number; startMile: number; startName: string;
    endMile: number; endName: string; idealMile: number; speedMph: number;
    candidates: WorkOption[];
  }

  const openSleepMap = useCallback(async (fwd = 20) => {
    setSheet(null); setErr(null);
    try {
      const r = await apiGet<SleepResp>(`/api/plan/day/${n}/sleep-options?fwd=${fwd}&back=20`);
      openPicker({
        mode: 'sleep',
        dayNumber: r.dayNumber,
        startMile: r.startMile, startName: r.startName,
        endMile: r.endMile, endName: r.endName,
        speedMph: r.speedMph,
        candidates: r.options as unknown as PickCandidate[],
        widened: fwd,
        onWiden: (next) => { openSleepMap(next); },
        onList: () => { openPicker(null); openSleepSheet(); },
        onClose: () => openPicker(null),
        onPick: async (c) => {
          await apiPost('/api/plan/day/sleep', c.kind === 'camp'
            ? { dayNumber: n, campId: c.id }
            : { dayNumber: n, resourceId: c.id });
          openPicker(null);
          await load();
          refetchPlan();
        },
      });
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, openPicker, load, refetchPlan]);

  const openWorkMap = useCallback(async () => {
    setSheet(null); setErr(null);
    try {
      const r = await apiGet<WorkResp>(`/api/plan/day/${n}/work-options`);
      openPicker({
        mode: 'work',
        dayNumber: r.dayNumber,
        startMile: r.startMile, startName: r.startName,
        endMile: r.endMile, endName: r.endName,
        idealMile: r.idealMile,
        speedMph: r.speedMph,
        candidates: r.candidates as unknown as PickCandidate[],
        onList: () => { openPicker(null); openWorkSheet(); },
        onClose: () => openPicker(null),
        onPick: async (c) => {
          await apiPost('/api/plan/day/work-stop',
            { dayNumber: n, resourceId: c.id, append: appendWork });
          setAppendWork(false);
          openPicker(null);
          await load();
          refetchPlan();
        },
      });
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, openPicker, load, refetchPlan]);
  const openFit = async () => {
    setSheet('fit');
    try { setFit(await apiGet<FitOptions>(`/api/plan/day/${n}/fit-options`)); }
    catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  const sleepShown = useMemo(() => {
    if (!sleepOpts) return [];
    let list = [...sleepOpts];
    if (sleepFilter === 'cheapest') list.sort((a, b) => (a.price ?? 900) - (b.price ?? 900));
    if (sleepFilter === 'free') list = list.filter((o) => o.free);
    if (sleepFilter === 'camp') list = list.filter((o) => o.type !== 'hotel');
    if (sleepFilter === 'room') list = list.filter((o) => o.type === 'hotel');
    const chosen = list.filter((o) => o.chosen);
    return [...chosen, ...list.filter((o) => !o.chosen)].slice(0, 30);
  }, [sleepOpts, sleepFilter]);

  if (err && !canvas) return <div className="wrap"><div className="error">{err}</div></div>;
  if (!canvas) return <div className="wrap"><div className="dim-note">Loading day…</div></div>;

  const c = canvas;
  const sun = c.sun;
  const rd = readinessMeta(c.readiness.state);
  const dayWx = wx[n];
  const isFrontier = plan ? (() => {
    const last = plan.days.filter((d) => d.actual).reduce((m, d) => Math.max(m, d.dayNumber), 0);
    return n === last + 1;
  })() : false;
  // Legs aggregate across breaks: a morning cut by two coffee stops is still
  // one morning. Only the work block splits a day into morning and afternoon.
  const workIdx = c.blocks.findIndex((b) => b.kind === 'work');
  const workBlock = workIdx >= 0 ? c.blocks[workIdx] : null;
  const sumLeg = (from: number, to: number) => {
    const rides = c.blocks.slice(from, to).filter((b) => b.kind === 'ride');
    if (!rides.length) return null;
    return {
      miles: r1(rides.reduce((s, b) => s + (b.miles ?? 0), 0)),
      rideMin: rides.reduce((s, b) => s + (b.rideMin ?? 0), 0),
      startMin: rides[0].startMin,
      endMin: rides[rides.length - 1].endMin,
      legs: rides.length,
    };
  };
  const morning = sumLeg(0, workIdx >= 0 ? workIdx : c.blocks.length);
  const afternoon = workIdx >= 0 ? sumLeg(workIdx + 1, c.blocks.length) : null;
  const locked = c.status !== 'planned' || !!c.actual;

  const wifi = c.workStop ? wifiMeta(c.workStop.wifiStatus) : null;

  return (
    <div className="wrap today">
      {/* ---------- header: the day stamp ---------- */}
      <header className="day-head">
        <button className="pager" disabled={n <= 1} onClick={() => setCurDay(n - 1)} aria-label="Previous day">←</button>
        <div className="day-id">
          <div className="stamp-box">
            <span className="stamp-day">DAY {c.dayNumber}</span>
            <span className="stamp-date">{stampDate(c.date) || `of ${dayCount}`}</span>
          </div>
          <div className="day-titles">
            <div className="day-route">{c.startName} → {c.endName}{c.endState ? `, ${c.endState}` : ''}</div>
            <div className="day-sub">
              {c.rest ? 'REST DAY' : <>
                <b>{c.miles} mi</b> · ~{durMin(sun?.rideMin ?? Math.round((c.effortMiles / 11) * 60))} riding
                {c.elevGainFt != null && c.elevGainFt > 100 && <> · ↑{c.elevGainFt.toLocaleString()} ft</>}
                {' '}· mi {c.startMile} → {c.endMile}
              </>}
              {sun && <span className="zone-chip">{sun.zone}</span>}
              {sun?.workday ? <span className="work-chip">WORK DAY</span> : <span className="weekend-chip">WEEKEND</span>}
            </div>
          </div>
        </div>
        <button className="pager" disabled={n >= dayCount} onClick={() => setCurDay(n + 1)} aria-label="Next day">→</button>
      </header>

      {/* readiness + conflict banner */}
      <div className="day-status-row">
        <span className={`rd-chip ${rd.cls}`}>{c.actual ? 'DONE' : rd.label}</span>
        {sun && !c.rest && !c.actual && (
          <span className="dim">
            {sun.fit === 'fits'
              ? `fits daylight with ${durMin(sun.bufferMin)} to spare`
              : sun.fit === 'tight'
                ? `tight — ${durMin(-sun.bufferMin)} over the comfortable window`
                : `${durMin(-sun.bufferMin)} more riding than daylight allows`}
          </span>
        )}
        <span className="spacer" />
        <button className="ghost" onClick={() => showDayOnMap(n)}>Map</button>
        {isFrontier && <button className="ghost" onClick={gotoRide}>▶ Ride</button>}
        {!locked && <button className={editing ? 'on' : 'ghost'} onClick={() => setEditing(!editing)}>{editing ? 'Done editing' : 'Edit day'}</button>}
      </div>

      {(c.readiness.issues.length > 0 && !c.actual) && (
        <div className="issues-row">
          {c.readiness.issues.map((i, k) => <span key={k} className={`issue issue-${i.kind}`}>{i.label}</span>)}
          {(c.readiness.issues.some((i) => ['daylight', 'daylight_tight', 'mileage'].includes(i.kind))) && (
            <button className="fit-btn" onClick={openFit}>Help me make this fit</button>
          )}
        </div>
      )}

      {err && <div className="error">{err}</div>}

      {/* ---------- the canvas ---------- */}
      <section className="canvas-card">
        <Timeline c={c} full={full24} editable={!locked}
          onCommit={(patch) => act(() => apiPost('/api/plan/day/times', { dayNumber: n, ...patch }), true)}
          onEditMark={locked || c.rest ? undefined : (m) => openMarkPanel(m)} />
        <div className="canvas-foot">
          <button className="linkish" onClick={() => setFull24(!full24)}>
            {full24 ? 'Focus on the day' : 'Show full 24 hours'}
          </button>
          {!locked && !c.rest && (
            <button className="tl-add"
              onClick={() => { if (canvasAdd) setEditMark(null); setCanvasAdd(!canvasAdd); }}
              title="Add a block to this day">+ block</button>
          )}
          {!locked && <span className="hand tl-tip">drag the bars · or use the dials below</span>}
          {c.conflict && <span className="conflict-note">⚠ {c.conflict.detail}</span>}
        </div>
        {canvasAdd && !locked && !c.rest && (
          <div className="tl-add-panel" ref={addPanelRef}>
            <div className="tl-add-tabs">
              <button className={addMode === 'break' ? 'on' : 'ghost'}
                onClick={() => { setAddMode('break'); setEditMark(null); }}>Break</button>
              <button className={addMode === 'mark' ? 'on' : 'ghost'}
                onClick={() => setAddMode('mark')}>Mark</button>
            </div>
            {/* The difference is not obvious, and it is the thing most likely to
                confuse him in six months. So it is stated, not implied. */}
            <div className="tl-add-why">
              <b>Break</b> — time off the bike. Slides if you roll out later.<br />
              <b>Mark</b> — a fixed appointment. Stays put whatever time you leave.
            </div>
            {addMode === 'break' ? (
              <AddBreak busy={busy} onAdd={(afterRideMin, dwellMin, name) => {
                act(() => apiPost('/api/plan/day/break',
                  { dayNumber: n, afterRideMin, dwellMin, note: name }), true);
                setCanvasAdd(false);
              }} />
            ) : (
              <MarkForm key={editMark?.id ?? 'new'}
                dayNumber={n} transits={c.transits ?? []} initial={editMark}
                onSubmit={async (payload) => {
                  // Awaited, so a failed save keeps the form (and the typed
                  // mark) on screen with the reason beside the button.
                  await apiPost(editMark
                    ? '/api/plan/day/mark/update'
                    : '/api/plan/day/mark', editMark ? { id: editMark.id, ...payload } : payload);
                  setEditMark(null);
                  setCanvasAdd(false);
                  await load();
                  refetchPlan();
                }}
                onDelete={editMark ? async () => {
                  await apiPost('/api/plan/day/mark/remove', { id: editMark.id });
                  setEditMark(null);
                  setCanvasAdd(false);
                  await load();
                  refetchPlan();
                } : undefined}
                onCancel={() => { setEditMark(null); setCanvasAdd(false); }} />
            )}
          </div>
        )}
      </section>

      {/* ---------- the dials: change any one, everything else follows ---------- */}
      {!c.rest && !locked && (
        <section className="dials">
          <div className="leg-kicker">SET ANY ONE — THE REST FOLLOWS</div>
          <div className="dial-row">
            <label className="dial">
              <span className="dial-k">Roll out{c.sun?.overrides?.depart && <i> ·set</i>}</span>
              <input type="time" value={hhmm(c.departMin)}
                onChange={(e) => act(() => apiPost('/api/plan/day/times', { dayNumber: n, startTime: e.target.value }), true)} />
              {c.sun?.overrides?.depart && (
                <button className="dial-reset" title="Back to civil dawn"
                  onClick={() => act(() => apiPost('/api/plan/day/times', { dayNumber: n, startTime: null }), true)}>↺ dawn</button>
              )}
            </label>

            {c.sun?.workday && c.sun.work && (
              <label className="dial">
                <span className="dial-k">Work starts (local){c.sun.overrides?.workStart && <i> ·set</i>}</span>
                <input type="time" value={hhmm(c.sun.work.localStart * 60)}
                  onChange={(e) => act(() => apiPost('/api/plan/day/times', { dayNumber: n, workStart: e.target.value }), true)} />
                <span className="dial-sub dim">= {clockH(c.sun.work.etStart)} ET</span>
                {c.sun.overrides?.workStart && (
                  <button className="dial-reset" title="Back to the standard Eastern window"
                    onClick={() => act(() => apiPost('/api/plan/day/times', { dayNumber: n, workStart: null }), true)}>↺ 9–4:30 ET</button>
                )}
              </label>
            )}

            <label className="dial">
              <span className="dial-k">Ride until{c.sun?.overrides?.rideUntil && <i> ·set</i>}</span>
              <input type="time" value={hhmm(c.times?.rideToMin ?? c.times?.defaultRideUntilMin ?? 19 * 60)}
                onChange={(e) => act(() => apiPost('/api/plan/day/times', { dayNumber: n, rideUntil: e.target.value }), true)} />
              {c.sun?.overrides?.rideUntil && (
                <button className="dial-reset" title="Back to civil dusk"
                  onClick={() => act(() => apiPost('/api/plan/day/times', { dayNumber: n, rideUntil: null }), true)}>↺ dusk</button>
              )}
            </label>

            {c.sun?.workday && (
              <label className="dial">
                <span className="dial-k">Morning miles</span>
                <input type="number" min={1} step="1" defaultValue={morning?.miles ?? ''}
                  key={`mm-${morning?.miles}`}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v <= 0 || v === morning?.miles) return;
                    act(() => apiPost('/api/plan/day/work-stop', { dayNumber: n, atMile: r1(c.startMile + v) }), true);
                  }} />
                <span className="dial-sub dim">snaps to the nearest wi-fi stop</span>
              </label>
            )}

            <label className="dial">
              <span className="dial-k">Day miles</span>
              <input type="number" min={1} step="1" defaultValue={c.miles}
                key={`dm-${c.miles}`}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v) || v <= 0 || v === c.miles) return;
                  act(() => apiPost('/api/plan/day', { dayNumber: n, endMile: r1(c.startMile + v) }), true);
                }} />
              <span className="dial-sub dim">moves tonight's endpoint</span>
            </label>
          </div>
          {/* Work + bike: logged in AND moving. The clock and the odometer
              both run, so these minutes count toward the work day. */}
          {c.sun?.workday && (
            <div className="breaks combo-block">
              <div className="leg-kicker">WORK + BIKE COMBO
                <span className="dim"> — ride a meeting, still on the clock</span>
              </div>
              {c.work && (
                <div className={`combo-tally${c.work.shortMin > 0 || c.work.overMin > 0 ? ' short' : ''}`}>
                  <b>{durMin(c.work.creditMin)}</b> of {durMin(c.work.owedMin)} owed
                  {c.work.comboMin > 0 && <> · {durMin(c.work.comboMin)} of it from the saddle</>}
                  {c.work.shortMin > 0 ? <b> · {durMin(c.work.shortMin)} still unplaced</b>
                    : c.work.overMin > 0 ? <b> · {durMin(c.work.overMin)} more than a work day</b>
                    : <span className="dim"> · the day adds up</span>}
                </div>
              )}
              {c.combos.length > 0 && (
                <ul className="break-list">
                  {c.combos.map((cb) => (
                    <li key={cb.id}>
                      <span className="brk-when">
                        🚴💻 <b>{cb.name}</b>
                        <span className="dim"> · from mi {cb.routeMile}</span>
                      </span>
                      <span className="brk-len">
                        <input type="number" min={10} step={5} defaultValue={cb.minutes}
                          key={`cb-${cb.id}-${cb.minutes}`}
                          onBlur={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v) || v === cb.minutes) return;
                            act(() => apiPost('/api/plan/stop/update', { id: cb.id, dwellMin: v }), true);
                          }} /> min
                      </span>
                      <button className="brk-x" title="Remove" disabled={busy}
                        onClick={() => act(() => apiPost('/api/plan/stop/remove', { id: cb.id }), true)}>✕</button>
                    </li>
                  ))}
                </ul>
              )}
              <AddCombo busy={busy} workStops={c.workStops}
                onAdd={(minutes, name, afterWorkStopId) =>
                  act(() => apiPost('/api/plan/day/combo',
                    { dayNumber: n, minutes, name, afterWorkStopId }), true)} />
              {c.workStops.length === 0 && (
                <div className="dim">Pick a work stop first — the combo slots in around it.</div>
              )}
            </div>
          )}

          {/* Breaks — any day, weekends included. Time off the bike needs no
              venue; it just needs to be somewhere along the ride. */}
          <div className="breaks">
            <div className="leg-kicker">BREAKS &amp; CUSTOM BLOCKS</div>
            {c.breaks.length === 0 && (
              <div className="dim">One long block right now — cut it up below. Name it whatever you like: lunch, swim, nap, laundry.</div>
            )}
            {c.breaks.length > 0 && (
              <ul className="break-list">
                {c.breaks.map((b) => (
                  <li key={b.id}>
                    <span className="brk-when">
                      <b>{b.name}</b> · after {durMin(b.rideMinFromStart)} riding
                      <span className="dim"> · {b.milesFromStart} mi in · mi {b.routeMile}</span>
                    </span>
                    <span className="brk-len">
                      <input type="number" min={5} step={5} defaultValue={b.dwellMin}
                        key={`bk-${b.id}-${b.dwellMin}`}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v) || v === b.dwellMin) return;
                          act(() => apiPost('/api/plan/stop/update', { id: b.id, dwellMin: v }), true);
                        }} /> min
                    </span>
                    <button className="brk-x" title="Remove this break" disabled={busy}
                      onClick={() => act(() => apiPost('/api/plan/stop/remove', { id: b.id }), true)}>✕</button>
                  </li>
                ))}
              </ul>
            )}
            <AddBreak busy={busy} onAdd={(afterRideMin, dwellMin, name) =>
              act(() => apiPost('/api/plan/day/break',
                { dayNumber: n, afterRideMin, dwellMin, note: name }), true)} />

            {/* Marks — the other half of this section. Listed separately from
                breaks because they answer a different question: not "when do I
                get off the bike" but "what time do I have to be somewhere". */}
            {(c.marks ?? []).length > 0 && (
              <ul className="break-list">
                {(c.marks ?? []).map((m) => (
                  <li key={`mk-${m.id}`}>
                    <span className="brk-when">
                      <span className={`mk-dot mk-${m.color}`} />
                      <b>{m.label}</b>
                      {' · '}{m.endMin != null
                        ? `${clockMin(m.startMin)}–${clockMin(m.endMin)}`
                        : clockMin(m.startMin)}
                      <span className="dim"> · {m.shape === 'line' ? 'line' : 'block'}</span>
                      {m.scope === 'mile'
                        ? <span className="mk-pinned"> · pinned to mi {m.routeMile}</span>
                        : <span className="dim"> · this day</span>}
                      {m.notes && <span className="dim"> · {m.notes}</span>}
                    </span>
                    <span className="brk-len">
                      <button className="linkish" onClick={() => openMarkPanel(m, true)}>edit</button>
                    </span>
                    <button className="brk-x" title="Remove this mark" disabled={busy}
                      onClick={() => {
                        // Removing the mark that is open in the editor closes the editor.
                        if (editMark?.id === m.id) { setEditMark(null); setCanvasAdd(false); }
                        act(() => apiPost('/api/plan/day/mark/remove', { id: m.id }), true);
                      }}>✕</button>
                  </li>
                ))}
              </ul>
            )}
            <button className="linkish" onClick={() => openMarkPanel(null, true)}>
              + Add a mark — a fixed time you have to meet
            </button>
          </div>

          {(c.sun?.darkBeforeMin || c.sun?.darkAfterMin) ? (
            <div className="dark-note">
              🔆 Riding {c.sun.darkBeforeMin ? `${durMin(c.sun.darkBeforeMin)} before dawn` : ''}
              {c.sun.darkBeforeMin && c.sun.darkAfterMin ? ' and ' : ''}
              {c.sun.darkAfterMin ? `${durMin(c.sun.darkAfterMin)} after dusk` : ''}
              {' '}— your choice, but you'll need lights.
            </div>
          ) : null}
        </section>
      )}

      {/* ---------- legs ---------- */}
      {!c.rest && (
        <section className="legs">
          <div className="leg-card">
            {/* A day only splits into morning/afternoon when a work block cuts
                it in two. Otherwise it is simply the ride. */}
            <div className="leg-kicker">{workBlock ? 'MORNING LEG' : 'THE RIDE'}</div>
            <div className="leg-main"><b>{morning?.miles ?? 0} mi</b> · {durMin(morning?.rideMin)}</div>
            <div className="leg-sub">
              {(morning?.legs ?? 1) > 1 && (
                <><b>{morning!.legs} stretches</b> with {morning!.legs - 1} break{morning!.legs > 2 ? 's' : ''}<br /></>
              )}
              wake at {c.prevOvernight}
              <br />roll out {clockMin(c.departMin)}{sun?.dawn != null && ` · dawn ${clockH(sun.dawn)}`}
              {!workBlock && morning && sun?.dusk != null && (
                morning.endMin / 60 <= sun.dusk
                  ? <><br />arrive {clockMin(morning.endMin)} · {durMin((sun.dusk - morning.endMin / 60) * 60)} of light left</>
                  : <><br /><span className="over-text">arrive {clockMin(morning.endMin)} — {durMin((morning.endMin / 60 - sun.dusk) * 60)} after dusk</span></>
              )}
            </div>
          </div>

          <div className={`leg-card work-card${!c.workStop && sun?.workday ? ' missing' : ''}`}>
            <div className="leg-kicker">WORK STOP</div>
            {c.workStop ? (<>
              <div className="leg-main"><b>{c.workStop.name}</b></div>
              <div className="leg-sub">
                mi {c.workStop.routeMile}
                {c.workStop.offRouteMi != null && c.workStop.offRouteMi > 0.1 && <> · {c.workStop.offRouteMi} mi off route</>}
              </div>
              {fullAddress(c.workStop) && <div className="addr-line">{fullAddress(c.workStop)}</div>}
              {wifi && <div className={`wifi-badge ${wifi.cls}`}>{wifi.icon} {wifi.label}</div>}
              {sun?.work ? (
                <div className="leg-sub">
                  {clockH(sun.work.localStart)}–{clockH(sun.work.localEnd)} local
                  · {clockH(sun.work.etStart)}–{clockH(sun.work.etEnd)} ET
                </div>
              ) : (
                <div className="leg-sub hand">no work owed today — kept as a wi-fi stop</div>
              )}
              {c.workStop.hours
                ? <div className="leg-sub dim">Hours: {c.workStop.hours}</div>
                : <div className="leg-sub dim">Opening hours unknown — verify before relying on it</div>}
              {c.workFallbacks.length > 0 && (
                <div className="leg-sub dim">
                  Fallback: {c.workFallbacks[0].name} · mi {c.workFallbacks[0].routeMile} ({wifiMeta(c.workFallbacks[0].wifiStatus).label.toLowerCase()})
                </div>
              )}
              {c.workStop.lat != null && c.workStop.lng != null && (
                <div className="dest-actions">
                  <a className="act" target="_blank" rel="noreferrer" href={appleMapsUrl(c.workStop.lat, c.workStop.lng, c.workStop)}>Apple Maps</a>
                  <a className="act" target="_blank" rel="noreferrer" href={googleMapsUrl(c.workStop.lat, c.workStop.lng)}>Google Maps</a>
                  <a className="act" target="_blank" rel="noreferrer" href={googleSearchUrl(c.workStop)}>Look up</a>
                  {c.workStop.phone && <a className="act" href={`tel:${c.workStop.phone}`}>Call</a>}
                  <CopyBtn text={pasteAddress(c.workStop)} />
                </div>
              )}
              {editing && !locked && (
                <div className="leg-actions">
                  <button className="ghost" onClick={openWorkMap}>Change on map</button>
                  <button className="ghost" onClick={openWorkSheet}>List</button>
                  <button className="ghost" onClick={() => act(() => apiPost('/api/plan/day/work-stop', { dayNumber: n }))}>Remove</button>
                </div>
              )}
              {!editing && !locked && <button className="linkish" onClick={openWorkMap}>change on map</button>}

              {/* A day can hold more than one sit-down: work the morning
                  somewhere, ride on, finish the afternoon somewhere else. */}
              {c.workStops.length > 1 && (
                <div className="extra-work">
                  {c.workStops.slice(1).map((w) => (
                    <div key={w.id} className="extra-work-row">
                      <span>
                        then <b>{w.name}</b>
                        <span className="dim"> · mi {w.routeMile} · {durMin(w.dwellMin)}</span>
                        {w.town && <span className="dim"> · {w.town}{w.state ? `, ${w.state}` : ''}</span>}
                      </span>
                      <span className={`wifi-pill ${wifiMeta(w.wifiStatus).cls}`}>{wifiMeta(w.wifiStatus).icon}</span>
                      {!locked && (
                        <button className="brk-x" title="Remove this work stop" disabled={busy}
                          onClick={() => act(() => apiPost('/api/plan/stop/remove', { id: w.id }), true)}>✕</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!locked && (
                <button className="linkish" onClick={() => { setAppendWork(true); openWorkMap(); }}>
                  + add another work stop
                </button>
              )}
            </>) : sun?.workday ? (<>
              <div className="leg-main missing-text">No work stop chosen</div>
              <div className="leg-sub">You owe {durMin(sun.work?.minutes ?? 450)} of desk time this day.</div>
              {!locked && <button className="primary" onClick={openWorkMap}>Pick a work stop on the map</button>}
            </>) : (
              <div className="leg-main hand">weekend — just ride</div>
            )}
            {c.movingMeeting && sun?.workday && (
              <details className="mm-note">
                <summary>Moving meeting possibility</summary>
                <div className="leg-sub">
                  Next reliable work stop from your midday position (mi {c.movingMeeting.fromMile}):{' '}
                  <b>{c.movingMeeting.stop.name}</b> — {c.movingMeeting.stop.milesAhead} mi · ~{c.movingMeeting.stop.rideMin} min ahead.
                  Riding a ~1h call is worth about +{c.movingMeeting.gainMi} mi of daylight. Only if the call genuinely allows it.
                </div>
              </details>
            )}
          </div>

          {afternoon && (
            <div className="leg-card">
              <div className="leg-kicker">AFTERNOON LEG</div>
              <div className="leg-main"><b>{afternoon.miles} mi</b> · {durMin(afternoon.rideMin)}</div>
              <div className="leg-sub">
                {afternoon.legs > 1 && (
                  <><b>{afternoon.legs} stretches</b> with {afternoon.legs - 1} break{afternoon.legs > 2 ? 's' : ''}<br /></>
                )}
                {sun?.dusk != null && (
                  afternoon.endMin / 60 <= sun.dusk
                    ? <>arrive {clockMin(afternoon.endMin)} · {durMin((sun.dusk - afternoon.endMin / 60) * 60)} of light left</>
                    : <span className="over-text">arrive {clockMin(afternoon.endMin)} — {durMin((afternoon.endMin / 60 - sun.dusk) * 60)} after dusk</span>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------- sleep ---------- */}
      <section className={`sleep-card${!c.sleep.resource && !c.sleep.campSpot ? ' missing' : ''}`}>
        <div className="leg-kicker">SLEEP TONIGHT</div>
        {c.sleep.resource ? (<>
          <div className="sleep-main">
            <b>{c.sleep.resource.category === 'campground' ? '⛺' : '🏨'} {c.sleep.resource.name}</b>
            <span className="sleep-cost">{c.sleep.cost != null ? money(c.sleep.cost) : ''}</span>
          </div>
          <div className="leg-sub">
            mi {c.sleep.resource.routeMile}
            {c.sleep.resource.offRouteMi != null && c.sleep.resource.offRouteMi > 0.1 && <> · {c.sleep.resource.offRouteMi} mi off route</>}
          </div>
          {fullAddress(c.sleep.resource) && <div className="addr-line">{fullAddress(c.sleep.resource)}</div>}
          <div className="dest-actions">
            <a className="act" target="_blank" rel="noreferrer" href={appleMapsUrl(c.sleep.resource.lat, c.sleep.resource.lng, c.sleep.resource)}>Apple Maps</a>
            <a className="act" target="_blank" rel="noreferrer" href={googleMapsUrl(c.sleep.resource.lat, c.sleep.resource.lng)}>Google Maps</a>
            <a className="act" target="_blank" rel="noreferrer" href={googleSearchUrl(c.sleep.resource)}>Look up</a>
            {c.sleep.resource.website && <a className="act" target="_blank" rel="noreferrer" href={c.sleep.resource.website}>Site</a>}
            {c.sleep.resource.phone && <a className="act" href={`tel:${c.sleep.resource.phone}`}>Call</a>}
            <CopyBtn text={pasteAddress(c.sleep.resource)} />
            {!locked && <button className="act" onClick={() => openSleepMap()}>Change on map</button>}
          </div>
        </>) : c.sleep.campSpot ? (<>
          <div className="sleep-main">
            <b>⛺ {String(c.sleep.campSpot.name)}</b>
            <span className="sleep-cost">{c.sleep.cost != null ? money(c.sleep.cost) : ''}</span>
          </div>
          <div className="leg-sub">
            mi {String(c.sleep.campSpot.routeMile)}
            {c.sleep.campSpot.locationNote ? ` · ${c.sleep.campSpot.locationNote}` : ''}
          </div>
          {fullAddress(c.sleep.campSpot as Record<string, string>) && (
            <div className="addr-line">{fullAddress(c.sleep.campSpot as Record<string, string>)}</div>
          )}
          {!!c.sleep.campSpot.legalityNote && <div className="leg-sub camp-legal">✔ {String(c.sleep.campSpot.legalityNote)}</div>}
          {!!c.sleep.campSpot.cyclistIntel && <div className="leg-sub camp-intel">🚲 {String(c.sleep.campSpot.cyclistIntel)}</div>}
          {!!c.sleep.campSpot.seasonalNote && <div className="leg-sub dim">🗓 {String(c.sleep.campSpot.seasonalNote)}</div>}
          <div className="dest-actions">
            <a className="act" target="_blank" rel="noreferrer"
              href={appleMapsUrl(Number(c.sleep.campSpot.lat), Number(c.sleep.campSpot.lng), c.sleep.campSpot as Record<string, string>)}>Apple Maps</a>
            <a className="act" target="_blank" rel="noreferrer"
              href={googleMapsUrl(Number(c.sleep.campSpot.lat), Number(c.sleep.campSpot.lng))}>Google Maps</a>
            {!!c.sleep.campSpot.website && <a className="act" target="_blank" rel="noreferrer" href={String(c.sleep.campSpot.website)}>Site</a>}
            {!!c.sleep.campSpot.phone && <a className="act" href={`tel:${String(c.sleep.campSpot.phone)}`}>Call</a>}
            <button className="act" onClick={() => showPointOnMap(Number(c.sleep.campSpot!.lng), Number(c.sleep.campSpot!.lat))}>Map</button>
            <CopyBtn text={pasteAddress(c.sleep.campSpot as Record<string, string>)} />
            {!locked && <button className="act" onClick={() => openSleepMap()}>Change on map</button>}
          </div>
        </>) : (<>
          <div className="leg-main missing-text">{c.rest ? 'Same bed as yesterday (not recorded)' : 'Not resolved'}</div>
          {!locked && <button className="primary" onClick={() => openSleepMap()}>Where do I sleep? — on the map</button>}
        </>)}
      </section>

      {/* ---------- money ---------- */}
      <section className="money-row">
        <span className="leg-kicker">SPEND</span>
        <CostEditor label="Bed" value={c.costs.lodging}
          chips={c.sleep.resource?.category === 'hotel' ? COST_CHIPS_LODGE_ROOM : COST_CHIPS_LODGE_CAMP}
          disabled={locked}
          onSet={(v) => act(() => apiPost('/api/plan/day/costs', { dayNumber: n, lodgingCost: v }), true)} />
        <CostEditor label="Other" value={c.costs.misc} chips={COST_CHIPS_MISC}
          disabled={locked}
          onSet={(v) => act(() => apiPost('/api/plan/day/costs', { dayNumber: n, miscCost: v }), true)} />
        <span className="money-total">Day total <b>${c.costs.total}</b></span>
      </section>

      {/* ---------- weather + warnings ---------- */}
      {(dayWx && !dayWx.error) ? (
        <div className="wx-line">
          {dayWx.tempF}° · {dayWx.shortForecast}
          {dayWx.precipPct != null && <> · {dayWx.precipPct}% rain</>}
          {dayWx.windSpeed && <> · wind {dayWx.windSpeed} {dayWx.windDirection}
            {dayWx.windClass && <b className={`wind-${dayWx.windClass}`}> ({dayWx.windClass})</b>}</>}
          <span className="dim"> — NWS</span>
        </div>
      ) : (
        <div className="wx-line dim">No forecast yet — NWS covers ~7 days out.</div>
      )}

      {c.riderNotes.length > 0 && (
        <section className="notes-block">
          <div className="leg-kicker">WHAT TO EXPECT</div>
          {c.riderNotes.map((note) => (
            <details key={note.id} className="note-item">
              <summary>
                <span className="note-ic">{NOTE_ICON[note.kind] ?? '•'}</span>
                <b>{note.title}</b>
                <span className="dim"> mi {note.startMile}{note.endMile > note.startMile + 0.5 ? `–${note.endMile}` : ''}</span>
              </summary>
              <div className="note-detail">{note.detail}
                {note.source && <div className="dim">{note.source}{note.confidence !== 'high' ? ` · ${note.confidence} confidence` : ''}</div>}
              </div>
            </details>
          ))}
        </section>
      )}

      {/* ---------- what other riders found on this exact stretch ---------- */}
      {c.intel && (c.intel.anchored.length > 0 || c.intel.road.length > 0 || c.intel.regional.length > 0) && (
        <section className="notes-block">
          <div className="leg-kicker">RIDER REPORTS
            <span className="dim"> — mined from other people's journals</span>
          </div>
          {c.intel.anchored.map((r) => <IntelItem key={r.id} r={r} />)}
          {c.intel.road.map((r) => <IntelItem key={r.id} r={r} road />)}
          {c.intel.regional.length > 0 && (
            <details className="note-item intel-regional">
              <summary>
                <span className="note-ic">◇</span>
                <b>{c.intel.regional.length} more for {c.endState ?? 'this region'}</b>
                <span className="dim"> — no exact position</span>
              </summary>
              <div className="note-detail">
                {c.intel.regional.map((r) => <IntelItem key={r.id} r={r} />)}
              </div>
            </details>
          )}
        </section>
      )}

      {profile && <ElevProfile data={profile} />}

      {/* ---------- actuals: record where the day really ended ---------- */}
      {isFrontier && !c.actual && (
        <section className="record-block">
          <div className="leg-kicker">RECORD THE DAY</div>
          <div className="record-row">
            <input type="number" placeholder={`ended at mile (planned ${c.endMile})`}
              value={actualMile} onChange={(e) => setActualMile(e.target.value)} />
            <button className="primary" disabled={busy || !actualMile} onClick={() => act(async () => {
              const res = await apiPost<{ preview: ReplanPreview }>('/api/actual/replan', {
                dayNumber: n, endMile: Number(actualMile), notes: actualNotes || undefined, mode: replanMode,
              });
              setActualMile(''); setActualNotes('');
              setPreview(res.preview ?? null);
            }, true)}>
              {busy ? 'Saving…' : 'Save & propose replan'}
            </button>
          </div>
          <input className="record-notes" placeholder="notes (optional)"
            value={actualNotes} onChange={(e) => setActualNotes(e.target.value)} />
          <button className="linkish" disabled={busy} onClick={() => act(() => apiPost('/api/plan/day/complete', { dayNumber: n }))}>
            ✓ Rode it as planned
          </button>
        </section>
      )}
      {c.actual && (
        <section className="record-block done">
          <div className="leg-kicker">RIDDEN</div>
          <div>Rode <b>{c.actual.miles} mi</b> to {c.actual.endName} (mi {c.actual.endMile})
            {c.actual.notes && <span className="dim"> — {c.actual.notes}</span>}</div>
          <button className="linkish" disabled={busy} onClick={() => act(() => apiPost('/api/plan/day/unlock', { dayNumber: n }))}>↩ Unlock this day</button>
        </section>
      )}

      {/* ---------- replan preview (after recording an actual) ---------- */}
      {preview && (
        <section className="proposal">
          <div className="proposal-head">
            <b>Proposed replan</b> from mile {preview.baselineMile}
            <span className="dim"> — nothing changes until you accept</span>
          </div>
          <div className="mode-row">
            <button className={preview.mode === 'rebuild' ? 'on' : 'ghost'} disabled={busy}
              onClick={() => act(async () => setPreview(await apiGet<ReplanPreview>('/api/replan/preview?mode=rebuild')), true)}>Re-spread days</button>
            <button className={preview.mode === 'anchors' ? 'on' : 'ghost'} disabled={busy}
              onClick={() => act(async () => { setReplanMode('anchors'); setPreview(await apiGet<ReplanPreview>('/api/replan/preview?mode=anchors')); }, true)}>Keep my beds</button>
          </div>
          <div className="dim">{preview.summary.remainingMiles} mi left · finishes day {preview.summary.newFinishDay}
            {preview.summary.dayDelta !== 0 && <b> ({preview.summary.dayDelta > 0 ? '+' : ''}{preview.summary.dayDelta} day{Math.abs(preview.summary.dayDelta) === 1 ? '' : 's'})</b>}
          </div>
          {preview.issues.map((i, k) => <div key={k} className="warn">⚠ {i}</div>)}
          <ul className="diff-list">
            {preview.days.slice(0, 8).map((d) => (
              <li key={d.day_number}>
                D{d.day_number}: {d.miles} mi
                {d.origMiles != null && Math.abs(d.deltaMiles ?? 0) > 0.5 && (
                  <span className="dim"> (was {d.origMiles}, {(d.deltaMiles ?? 0) > 0 ? '+' : ''}{d.deltaMiles})</span>
                )} → {d.end_name}
              </li>
            ))}
            {preview.days.length > 8 && <li className="dim">…and {preview.days.length - 8} more days</li>}
          </ul>
          <div className="proposal-actions">
            <button className="primary" disabled={busy} onClick={() => act(async () => {
              await apiPost('/api/replan/apply', { mode: preview.mode });
              setPreview(null);
            })}>Accept new plan</button>
            <button className="ghost" onClick={() => setPreview(null)}>Keep current plan</button>
          </div>
        </section>
      )}

      {/* ---------- progressive editing tools ---------- */}
      {editing && !locked && (
        <section className="adjust-block">
          <div className="leg-kicker">ADJUST DAY {n}</div>
          <div className="nudge-row">
            {[-10, -5, -1].map((v) => (
              <button key={v} className="nudge" disabled={busy}
                onClick={() => act(() => apiPost('/api/plan/day', { dayNumber: n, endMile: r1(c.endMile + v) }), true)}>{v}</button>
            ))}
            <input className="nudge-in" type="number" placeholder={`${c.endMile}`}
              value={endDraft} onChange={(e) => setEndDraft(e.target.value)} />
            <button className="nudge" disabled={busy || !endDraft}
              onClick={() => act(() => apiPost('/api/plan/day', { dayNumber: n, endMile: Number(endDraft) }), true)}>Set</button>
            {[1, 5, 10].map((v) => (
              <button key={v} className="nudge" disabled={busy}
                onClick={() => act(() => apiPost('/api/plan/day', { dayNumber: n, endMile: r1(c.endMile + v) }), true)}>+{v}</button>
            ))}
          </div>
          <div className="dim">Miles moved here trade with day {n + 1} — its start follows this endpoint automatically.</div>
          <div className="adjust-actions">
            <button className="ghost" disabled={busy}
              onClick={() => act(async () => {
                const [lng, lat] = await armMapPick(`Tap the map to end Day ${n} there`);
                const pos = await apiGet<{ mile: number }>(`/api/position?lat=${lat}&lng=${lng}`);
                await apiPost('/api/plan/day/sleep', { dayNumber: n, endMile: pos.mile });
              }, true)}>End day on map…</button>
            <button className="ghost" disabled={busy} onClick={() => act(() => apiPost('/api/plan/day/rest', { afterDay: n }), true)}>+ Rest day after</button>
            {c.rest && <button className="ghost" disabled={busy} onClick={() => act(() => apiPost('/api/plan/day/rest/remove', { dayNumber: n }))}>Remove this rest day</button>}
            <button className="ghost" disabled={busy} onClick={() => act(() => apiPost('/api/plan/day/merge', { dayNumber: n }), true)}>Merge with day {n + 1}</button>
          </div>
        </section>
      )}

      {/* ================= SHEETS ================= */}
      {sheet === 'sleep' && (
        <Sheet title="Where do I sleep?" onClose={() => setSheet(null)}>
          <div className="chips">
            {(['recommended', 'cheapest', 'free', 'camp', 'room'] as const).map((f) => (
              <button key={f} className={sleepFilter === f ? 'chip on' : 'chip'} onClick={() => setSleepFilter(f)}>
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          {!sleepOpts && <div className="dim-note">Finding beds…</div>}
          {sleepOpts && sleepShown.length === 0 && (
            <div className="gap-note">
              <b>No verified option under this filter.</b> This may be a genuine gap night —
              check the researched camps on the map, or stretch the day.
            </div>
          )}
          <ul className="sleep-list">
            {sleepShown.map((o) => {
              const open = openSleep === `${o.kind}-${o.id}`;
              return (
                <li key={`${o.kind}-${o.id}`} className={`sleep-opt${o.chosen ? ' chosen' : ''}${open ? ' open' : ''}`}>
                  <div className="sleep-row" onClick={() => setOpenSleep(open ? null : `${o.kind}-${o.id}`)}>
                    <span className={`price-chip tier-${o.tier}`}>{o.price != null ? money(o.price) : o.type === 'hotel' ? '$$' : '$?'}</span>
                    <span className="sleep-name">
                      {o.type === 'hotel' ? '🏨' : '⛺'} {o.name}
                      {o.chosen && <span className="chosen-tag">CURRENT</span>}
                      {o.kind === 'camp' && <span className="veri-tag">RESEARCHED</span>}
                    </span>
                    <span className="sleep-delta dim">
                      {Math.abs(o.deltaMi) < 1 ? 'at day end' : o.deltaMi < 0 ? `${Math.abs(o.deltaMi)} mi short` : `${o.deltaMi} mi past`}
                    </span>
                  </div>
                  {open && (
                    <div className="sleep-detail">
                      <div className="dim">
                        mi {o.routeMile}
                        {o.offRouteMi != null && o.offRouteMi > 0.1 && <> · {o.offRouteMi} mi off route</>}
                        {' '}· makes today <b>{o.newDayMiles} mi</b>
                        {o.nextDayMiles != null && <> · tomorrow {o.nextDayMiles} mi</>}
                      </div>
                      <div className="amen-row">
                        {o.water && <span>💧 water</span>}
                        {o.showers && <span>🚿 showers</span>}
                        {o.toilets && <span>🚻 toilets</span>}
                        {o.tentsOk === false && <span className="warn">⚠ verify tents</span>}
                        {o.wifiNear > 0 && <span>ᯤ {o.wifiNear} wi-fi nearby</span>}
                      </div>
                      {fullAddress(o) && <div className="addr-line">{fullAddress(o)}</div>}
                      {o.priceNote && <div className="dim">{o.priceNote}</div>}
                      {o.legalityNote && <div className="camp-legal">✔ {o.legalityNote}</div>}
                      {o.cyclistIntel && <div className="camp-intel">🚲 {o.cyclistIntel}</div>}
                      {o.seasonalNote && <div className="dim">🗓 {o.seasonalNote}</div>}
                      {o.booking && <div className="dim">Booking: {o.booking}</div>}
                      {o.confidence && <div className="dim">confidence: {o.confidence}</div>}
                      {(o.sources?.length ?? 0) > 0 && (
                        <div className="dim">{o.sources!.slice(0, 3).map((u, i) => (
                          <a key={i} href={u} target="_blank" rel="noreferrer">[{i + 1}] </a>))}
                        </div>
                      )}
                      <div className="dest-actions">
                        <button className="act" onClick={() => showPointOnMap(o.lng, o.lat)}>Map</button>
                        <a className="act" target="_blank" rel="noreferrer" href={appleMapsUrl(o.lat, o.lng, o)}>Apple Maps</a>
                        <a className="act" target="_blank" rel="noreferrer" href={googleMapsUrl(o.lat, o.lng)}>Google Maps</a>
                        <a className="act" target="_blank" rel="noreferrer" href={googleSearchUrl(o)}>Look up</a>
                        {o.website && <a className="act" href={o.website} target="_blank" rel="noreferrer">Site</a>}
                        {o.phone && <a className="act" href={`tel:${o.phone}`}>Call</a>}
                        <CopyBtn text={pasteAddress(o)} />
                        {!o.chosen && (
                          <button className="act commit" disabled={busy} onClick={() => act(() => apiPost('/api/plan/day/sleep',
                            o.kind === 'camp'
                              ? { dayNumber: n, campId: o.id }
                              : { dayNumber: n, resourceId: o.id }))}>
                            Sleep here — end day at mi {o.routeMile}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Sheet>
      )}

      {sheet === 'work' && (
        <Sheet title="Where do I work?" onClose={() => setSheet(null)}>
          {!workOpts && <div className="dim-note">Scoring wi-fi stops…</div>}
          {workOpts && workOpts.length === 0 && (
            <div className="gap-note"><b>No wi-fi stop on this stretch.</b> The work block has nowhere to land — consider reshaping the day.</div>
          )}
          <ul className="work-list">
            {(workOpts ?? []).slice(0, 20).map((o) => {
              const w = wifiMeta(o.wifiStatus);
              return (
                <li key={o.id} className="work-opt">
                  <div className="work-row">
                    <span className={`wifi-pill ${w.cls}`}>{w.icon}</span>
                    <span className="work-name">
                      <b>{o.name}</b>
                      <span className="dim"> mi {o.routeMile}{(o.offRouteMi ?? 0) > 0.1 ? ` · ${o.offRouteMi} off` : ''}</span>
                    </span>
                    <button className="act commit" disabled={busy}
                      onClick={() => act(async () => {
                        await apiPost('/api/plan/day/work-stop',
                          { dayNumber: n, resourceId: o.id, append: appendWork });
                        setAppendWork(false);
                      })}>
                      {appendWork ? 'Add' : 'Pick'}
                    </button>
                  </div>
                  <div className="work-sub dim">
                    <span className={w.cls}>{w.label}</span>
                    {' '}· morning {o.morningMi} mi ({durMin(o.morningMin)}) · afternoon {o.afternoonMi} mi ({durMin(o.afternoonMin)})
                    {o.hours && <> · {o.hours}</>}
                    {fullAddress(o) && <div>{fullAddress(o)}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        </Sheet>
      )}

      {sheet === 'fit' && (
        <Sheet title="Help me make this fit" onClose={() => setSheet(null)}>
          {!fit && <div className="dim-note">Working the options…</div>}
          {fit && (
            <>
              <div className="dim" style={{ marginBottom: 8 }}>
                {fit.deficitMi > 0
                  ? <>Day {fit.dayNumber} is ~<b>{fit.deficitMi} mi</b> more than its daylight allows. Concrete ways out, from the actual trip data:</>
                  : <>Day {fit.dayNumber} fits — but here are the levers anyway:</>}
              </div>
              {fit.options.length === 0 && <div className="gap-note">No clean options here — this stretch may need the Trip-level tools (redistribute, dates, or the mileage cap).</div>}
              {fit.options.map((o) => (
                <div key={o.id} className="fit-option">
                  <div className="fit-title">Option — {o.title}</div>
                  <ul className="fit-lines">{o.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
                  {o.assumptions.length > 0 && (
                    <div className="fit-assume">Assumes: {o.assumptions.join(' · ')}</div>
                  )}
                  {o.applyable ? (
                    <button className="primary" disabled={busy}
                      onClick={() => act(() => apiPost('/api/plan/day/fit-apply', { dayNumber: n, optionId: o.id }))}>
                      Apply this
                    </button>
                  ) : <span className="dim">informational — your call, on the road</span>}
                </div>
              ))}
              <button className="ghost" onClick={() => setSheet(null)}>Keep current plan</button>
            </>
          )}
        </Sheet>
      )}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet-ovl" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        <div className="sheet-head">
          <b>{title}</b>
          <button className="sheet-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/**
 * One mined observation. Severity is shown as rated — it was already rated for
 * Nick's direction and his loaded bike, so it is never re-scored here. Age and
 * the fact the source rider was supported are stated, not buried.
 */
function IntelItem({ r, road = false }: { r: IntelRecord; road?: boolean }) {
  const sev = r.severity ?? 0;
  const cls = sev >= 5 ? 'sev-5' : sev >= 4 ? 'sev-4' : sev >= 3 ? 'sev-3' : sev >= 2 ? 'sev-2' : 'sev-1';
  return (
    <details className={`note-item intel-item ${cls}`}>
      <summary>
        <span className="intel-sev" title={`severity ${sev || '—'}`}>{sev || '·'}</span>
        <b>{r.summary}</b>
        {r.startMile != null && (
          <span className="dim"> mi {r.startMile}{r.endMile && r.endMile !== r.startMile ? `–${r.endMile}` : ''}
            {r.anchorApprox ? ' approx' : ''}</span>
        )}
        {road && <span className="dim"> somewhere on today's {r.road}</span>}
      </summary>
      <div className="note-detail">
        {r.cyclistIntel && <div className="intel-lede">{r.cyclistIntel}</div>}
        {r.detail && <div>{r.detail}</div>}
        {r.quote && <div className="intel-quote">“{r.quote}”</div>}
        {r.photos?.slice(0, 2).map((p, i) => (
          <div key={i} className="dim">📷 {p.caption || p.shows}</div>
        ))}
        <div className="dim intel-src">
          {r.type}{r.road ? ` · ${r.road}` : ''}{r.state ? ` · ${r.state}` : ''}
          {r.observedDate && <> · seen {r.observedDate}</>}
          {r.confidence && <> · {r.confidence}</>}
          {r.anchorMethod === 'one_town' && <> · position approximate ({r.from ?? r.to})</>}
          {r.mustVerify && <b> · VERIFY BEFORE RELYING ON THIS</b>}
        </div>
      </div>
    </details>
  );
}

/** A meeting taken from the saddle: on the clock and gaining miles. */
function AddCombo({ onAdd, busy, workStops }: {
  onAdd: (minutes: number, name: string, afterWorkStopId?: number) => void;
  busy: boolean;
  workStops: { id: number; name: string; routeMile: number }[];
}) {
  const [mins, setMins] = useState('60');
  const [name, setName] = useState('');
  const [after, setAfter] = useState('');
  return (
    <div className="add-break">
      <span>Ride while logged in for</span>
      <input type="number" min={10} step={5} value={mins}
        onChange={(e) => setMins(e.target.value)} aria-label="minutes" />
      <span>min</span>
      {workStops.length > 1 && (
        <>
          <span>after</span>
          <select value={after} onChange={(e) => setAfter(e.target.value)} aria-label="after which work stop">
            <option value="">the last block</option>
            {workStops.map((w) => (
              <option key={w.id} value={w.id}>{w.name.slice(0, 22)} (mi {w.routeMile})</option>
            ))}
          </select>
        </>
      )}
      <input className="brk-name" type="text" placeholder="Zoom standup" value={name}
        onChange={(e) => setName(e.target.value)} aria-label="meeting name" />
      <button className="ghost" disabled={busy || !(Number(mins) > 0)}
        onClick={() => onAdd(Number(mins), name.trim() || 'Work + bike', after ? Number(after) : undefined)}>
        + Add combo
      </button>
    </div>
  );
}

/**
 * "Ride two hours, then break." Breaks stack from whatever is already
 * scheduled, so adding 2h then 3h gives you exactly that shape.
 */
function AddBreak({ onAdd, busy }: {
  onAdd: (afterRideMin: number, dwellMin: number, name: string) => void; busy: boolean;
}) {
  const [h, setH] = useState('2');
  const [m, setM] = useState('0');
  const [len, setLen] = useState('30');
  const [name, setName] = useState('');
  const afterMin = (Number(h) || 0) * 60 + (Number(m) || 0);
  return (
    <div className="add-break">
      <span>Ride</span>
      <input type="number" min={0} max={12} value={h} onChange={(e) => setH(e.target.value)} aria-label="hours" />
      <span>h</span>
      <input type="number" min={0} max={55} step={5} value={m} onChange={(e) => setM(e.target.value)} aria-label="minutes" />
      <span>m, then</span>
      <input className="brk-name" type="text" placeholder="Break" value={name}
        onChange={(e) => setName(e.target.value)} aria-label="block name" />
      <span>for</span>
      <input type="number" min={5} step={5} value={len} onChange={(e) => setLen(e.target.value)} aria-label="length" />
      <span>min</span>
      <button className="ghost" disabled={busy || afterMin <= 0}
        onClick={() => onAdd(afterMin, Number(len) || 30, name.trim() || 'Break')}>+ Add break</button>
    </div>
  );
}

interface MarkPayload {
  scope: 'day' | 'mile';
  dayNumber: number;
  routeMile: number | null;
  label: string;
  shape: 'block' | 'line';
  color: MarkColor;
  startMin: number;
  endMin: number | null;
  notes: string | null;
}

/**
 * "Meet the ferry at 3:30." Creating or editing one mark.
 *
 * Colour is a fixed palette of eight named tokens, not a free hex picker —
 * the canvas sits on a live sky gradient that changes per day and per latitude,
 * and block labels are text on the fill, so an arbitrary colour is invisible
 * against some skies and illegible against others.
 *
 * The save is awaited: a failed POST (one bar of signal at a campground) keeps
 * the form and the typed mark on screen with the reason beside the button,
 * instead of vanishing and leaving an error banner a screen away.
 */
function MarkForm({ dayNumber, transits, initial, onSubmit, onDelete, onCancel }: {
  dayNumber: number;
  transits: DayTransit[];
  initial: CanvasMark | null;
  onSubmit: (payload: MarkPayload) => Promise<void>;
  onDelete?: () => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [shape, setShape] = useState<'block' | 'line'>(initial?.shape ?? 'block');
  // Violet by default: the canvas already spends red on work and green on
  // riding, so a mark left on its default has to read as the rider's own.
  const [color, setColor] = useState<MarkColor>(initial?.color ?? 'violet');
  const [start, setStart] = useState(hhmm(initial?.startMin ?? 12 * 60));
  const [end, setEnd] = useState(hhmm(initial?.endMin ?? 12 * 60 + 40));
  const [endTouched, setEndTouched] = useState(initial != null);
  const [touched, setTouched] = useState(false);
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [scope, setScope] = useState<'day' | 'mile'>(initial?.scope ?? 'day');
  const [routeMile, setRouteMile] = useState<number | null>(initial?.routeMile ?? null);
  const [offerDone, setOfferDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const startMin = minOf(start);
  const endMin = minOf(end);

  // Until the rider says otherwise, the end follows the start — 3:30 in gives
  // 4:10 out, not a greyed-out button because "Ends" is still on 1:00pm.
  const changeStart = (v: string) => {
    setStart(v); setTouched(true); setOfferDone(false);
    const sm = minOf(v);
    if (!endTouched && sm != null) setEnd(hhmm(Math.min(1439, sm + 40)));
  };
  const changeEnd = (v: string) => { setEnd(v); setEndTouched(true); setTouched(true); setOfferDone(false); };
  const changeShape = (v: 'block' | 'line') => {
    setShape(v);
    if (v === 'block' && startMin != null && (endMin == null || endMin <= startMin)) {
      setEnd(hhmm(Math.min(1439, startMin + 40)));
    }
  };

  const problem = !label.trim() ? 'Give it a name'
    : startMin == null ? 'Set a start time'
    : shape === 'block' && endMin == null ? 'Set an end time'
    : shape === 'block' && endMin! <= startMin ? 'The end has to be after the start'
    : null;

  // The one question worth asking, at the one moment it is obviously right: if
  // this mark's window lands on a crossing the day already knows about, the
  // mark really belongs to that MILE, not to a day number that renumbers on
  // every replan. Transits carry no timetable of their own, so "lands on" means
  // "near when the simulated ride reaches it" — within 90 minutes either side.
  // Asked only once the rider has actually set a time (never on the untouched
  // defaults), and never again for a mark they already chose to keep on the day.
  const eligible = scope === 'day' && !offerDone && touched && startMin != null
    && !(initial && initial.scope === 'day');
  const pinTo = eligible
    ? transits.find((t) => t.atMin != null
        && t.atMin >= startMin! - 90
        && t.atMin <= (shape === 'block' && endMin != null ? endMin : startMin!) + 90)
    : undefined;

  const run = async (fn: () => Promise<void>) => {
    setSaving(true); setErr(null);
    try { await fn(); } catch (e) { setErr(String((e as Error).message ?? e)); }
    setSaving(false);
  };

  return (
    <div className="mk-form">
      <label className="mk-field">
        <span>What is it</span>
        <input type="text" value={label} placeholder="e.g. Ferry, dentist, call home"
          onChange={(e) => { setLabel(e.target.value); setTouched(true); }} />
      </label>

      <div className="mk-field">
        <span>Shape</span>
        <div className="mk-shape">
          <button className={shape === 'block' ? 'on' : ''} aria-pressed={shape === 'block'}
            onClick={() => changeShape('block')} title="A span of time — start and stop">Block</button>
          <button className={shape === 'line' ? 'on' : ''} aria-pressed={shape === 'line'}
            onClick={() => changeShape('line')} title="A single moment, drawn across the whole canvas">Line</button>
        </div>
      </div>

      <div className="mk-field">
        <span>Colour</span>
        <div className="mk-swatches">
          {MARK_COLORS.map((k) => (
            <button key={k} className={`mk-swatch mk-${k}${color === k ? ' on' : ''}`}
              aria-label={k} aria-pressed={color === k} title={k} onClick={() => setColor(k)} />
          ))}
        </div>
      </div>

      {/* Start and end wrap together — they are one decision */}
      <div className="mk-times">
        <label className="mk-field">
          <span>Starts</span>
          <input type="time" value={start} onChange={(e) => changeStart(e.target.value)} />
        </label>
        <label className="mk-field">
          <span>{shape === 'line' ? 'Ends (n/a)' : 'Ends'}</span>
          <input type="time" value={shape === 'line' ? '' : end} disabled={shape === 'line'}
            onChange={(e) => changeEnd(e.target.value)} />
        </label>
      </div>

      <label className="mk-field">
        <span>Note (optional)</span>
        <input type="text" value={notes} placeholder="last boat of the day"
          onChange={(e) => setNotes(e.target.value)} />
      </label>

      {scope === 'mile' && routeMile != null && (
        <div className="mk-pin-offer">
          <span>Pinned to <b>mi {routeMile}</b> — follows that spot if a replan shifts your days.</span>
          <button className="ghost" onClick={() => { setScope('day'); setOfferDone(true); }}>
            Pin to day {dayNumber} instead
          </button>
        </div>
      )}

      {pinTo && (
        <div className="mk-pin-offer">
          <span>
            Day {dayNumber} crosses <b>{pinTo.name}</b> (mi {pinTo.startMile}) around{' '}
            {pinTo.atMin != null ? clockMin(pinTo.atMin) : '—'}. Pin this to mile {pinTo.startMile}
            {' '}so it follows the crossing if your days shift?
          </span>
          <button className="ghost"
            onClick={() => { setScope('mile'); setRouteMile(pinTo.startMile); setOfferDone(true); }}>
            Pin to mi {pinTo.startMile}
          </button>
          <button className="linkish" onClick={() => setOfferDone(true)}>Keep it on day {dayNumber}</button>
        </div>
      )}

      {err && <div className="mk-err">{err}</div>}
      {!err && problem && touched && <div className="mk-err">{problem}</div>}

      <button className="primary" disabled={saving || !!problem}
        onClick={() => run(() => onSubmit({
          scope,
          dayNumber,
          routeMile: scope === 'mile' ? routeMile : null,
          label: label.trim(),
          shape, color,
          startMin: startMin!,
          endMin: shape === 'block' ? endMin! : null,
          notes: notes.trim() || null,
        }))}>
        {saving ? 'Saving…' : initial ? 'Save mark' : '+ Add mark'}
      </button>
      {onDelete && (
        <button className="ghost" disabled={saving} onClick={() => run(onDelete)}>Delete</button>
      )}
      <button className="linkish" onClick={onCancel}>Cancel</button>
    </div>
  );
}

/** Copies "Name, street, City, ST" — for a booking form or a phone call. */
function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button className="act" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      } catch { /* clipboard blocked — the address is on screen to read */ }
    }}>{done ? '✓ Copied' : 'Copy'}</button>
  );
}

function CostEditor({ label, value, chips, onSet, disabled }: {
  label: string; value: number | null; chips: number[];
  onSet: (v: number) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="cost-editor">
      <button className="cost-btn" disabled={disabled} onClick={() => setOpen(!open)}>
        {label}: <b>{value != null ? money(value) : '—'}</b>
      </button>
      {open && (
        <span className="cost-pop">
          {chips.map((v) => (
            <button key={v} className="chip" onClick={() => { onSet(v); setOpen(false); }}>${v}</button>
          ))}
          <input type="number" min={0} placeholder="$" onKeyDown={(e) => {
            if (e.key === 'Enter') { onSet(Number((e.target as HTMLInputElement).value) || 0); setOpen(false); }
          }} />
        </span>
      )}
    </span>
  );
}
