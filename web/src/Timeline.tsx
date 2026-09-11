import { useEffect, useRef, useState } from 'react';
import type { CanvasMark, DayCanvas, MarkColor } from './types';
import { clockH, clockMin, durMin } from './format';

// THE TIMELINE — the Day Canvas's bar: sky, obligations, the rider's marks, the
// plan. Rendered by Today for the saved day and by the Day Builder for a day
// still being composed; both hand it a DayCanvas and it never asks which.

const PHASE_COLOR: Record<string, string> = {
  night: '#232946', astro: '#31395e', naut: '#4d5b82',
  civil: '#d99a55', low: '#eec984', day: '#c9e2f2',
};

export function skyGradient(phases: string[] | undefined, t0: number, t1: number): string {
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

export const hhmm = (min: number) => {
  const m = Math.max(0, Math.min(1439, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

export const minOf = (hm: string): number | null => {
  const [h, m] = String(hm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
};

// The eight mark colours. Mirrors MARK_COLORS in server/plan.mjs and the
// .mk-* tokens in styles.css — the DB stores the NAME, never a hex value, so a
// palette change here updates every mark already drawn.
export const MARK_COLORS: MarkColor[] = ['slate', 'red', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];

export const markTitle = (m: CanvasMark) => [
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
export function Timeline({ c, full, editable, onCommit, onEditMark }: {
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
