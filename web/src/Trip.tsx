import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from './api';
import { PlanResponse, PlanDay, ReplanPreview } from './types';
import { shortDate, dowOf, isWeekendDate, durMin, money, readinessMeta, wifiMeta } from './format';

// TRIP — does the whole trip work, and which days need attention?
// A scanable overview first; the engine's heavy levers live below it.

interface FitResult {
  feasible: boolean; changed: boolean; cap?: number; previousCap?: number;
  dayCount: number; availableDays: number; daysLeft: number;
  slackDays?: number; note: string; revisionId?: number;
}
interface AutoItinResult {
  applied: boolean; dayCount: number; workdays: number; fullyScheduled: number;
  problemDays: { dayNumber: number; date: string | null; issues: string[] }[];
}

const ROLLUP_ORDER: [string, string][] = [
  ['ready', 'ready'], ['done', 'ridden'],
  ['daylight', 'daylight conflicts'], ['daylight_tight', 'tight days'],
  ['sleep', 'sleep gaps'], ['work', 'need a work stop'],
  ['work_wifi', 'weak wi-fi'], ['mileage', 'over cap'], ['route', 'route notes'],
];

export default function Trip({ plan, refetch, gotoDay, showDayOnMap }: {
  plan: PlanResponse | null;
  refetch: () => void;
  gotoDay: (n: number) => void;
  showDayOnMap: (n: number) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [startDate, setStartDate] = useState('');
  const [arriveDate, setArriveDate] = useState('');
  const [maxMiles, setMaxMiles] = useState(65);
  const [startMile, setStartMile] = useState('0');
  const [startMilePreview, setStartMilePreview] = useState<{ mile: number; place: string } | null>(null);
  const [fit, setFit] = useState<FitResult | null>(null);
  const [workAware, setWorkAware] = useState(false);
  const [itin, setItin] = useState<AutoItinResult | null>(null);
  const [preview, setPreview] = useState<ReplanPreview | null>(null);
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const s = await apiGet<Record<string, string>>('/api/settings');
        if (s.startDate) setStartDate(s.startDate);
        if (s.arriveDate) setArriveDate(s.arriveDate);
        if (s.maxDayMiles) setMaxMiles(Number(s.maxDayMiles));
        setStartMile(s.tripStartMile ?? '0');
        setWorkAware(s.workAwarePlanning === '1');
      } catch { /* dates stay blank */ }
    })();
  }, [plan?.revision?.id]);

  const days = plan?.days ?? [];
  const rollup = plan?.readinessRollup ?? {};
  const sched = plan?.schedule;
  const riddenDays = days.filter((d) => d.actual);

  const shown = useMemo(() => {
    if (!filter) return days;
    return days.filter((d) => d.readiness?.state === filter);
  }, [days, filter]);

  // Weekday-vs-weekend picture: planned miles vs what daylight+work allow.
  const loadBars = useMemo(() => days
    .filter((d) => !d.rest && !d.actual && d.sun)
    .slice(0, 60)
    .map((d) => ({
      n: d.dayNumber,
      weekend: isWeekendDate(d.date),
      planned: d.miles,
      feasible: Math.max(0, Math.round((d.sun!.usableRideMin / Math.max(1, d.rideTimeMin)) * d.miles)),
      fit: d.sun!.fit,
    })), [days]);
  const maxBar = Math.max(60, ...loadBars.map((b) => Math.max(b.planned, b.feasible)));

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setErr(null);
    try { await fn(); } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(null);
  }

  const saveSetting = (key: string, value: string, after?: () => void) => run('set', async () => {
    await apiPost('/api/settings', { [key]: value });
    after?.();
    refetch();
  });

  if (!plan) return <div className="wrap"><div className="dim-note">Loading trip…</div></div>;

  if (!plan.revision) {
    return (
      <div className="wrap">
        <p className="dim-note">No trip plan yet. Build one — the planner walks the route picking
          real overnight anchors, never exceeding your daily ceiling.</p>
        <div className="build-row">
          <label>Max mi/day
            <input type="number" min={20} max={140} value={maxMiles} onChange={(e) => setMaxMiles(Number(e.target.value))} />
          </label>
          <button className="primary" disabled={busy !== null}
            onClick={() => run('build', async () => { await apiPost('/api/plan/auto', { maxMiles }); refetch(); })}>
            {busy === 'build' ? 'Building…' : 'Build plan'}
          </button>
        </div>
        {err && <div className="error">{err}</div>}
      </div>
    );
  }

  return (
    <div className="wrap trip">
      <header className="trip-head">
        <div className="stamp-box small">
          <span className="stamp-day">THE WHOLE MESS</span>
          <span className="stamp-date">
            {days.length} DAYS · {Math.round(plan.tripMiles ?? plan.totalMiles).toLocaleString()} MI
          </span>
        </div>
        <div className="trip-facts">
          {(plan.tripStartMile ?? 0) > 0 && (
            <span>starts mi {plan.tripStartMile}{plan.tripStartName ? ` · ${plan.tripStartName}` : ''}</span>
          )}
          {riddenDays.length > 0 && (
            <span>{riddenDays.length} ridden · {Math.round(riddenDays.reduce((s, d) => s + (d.actual?.miles ?? 0), 0))} mi done</span>
          )}
          <span className="dim">rev #{plan.revision.id}</span>
          {plan.costs && <span>est. spend ${plan.costs.total}</span>}
        </div>
      </header>

      {/* readiness rollup — the whole trip's to-do list in one line */}
      <div className="rollup">
        {ROLLUP_ORDER.filter(([k]) => rollup[k]).map(([k, label]) => (
          <button key={k}
            className={`rollup-chip ${readinessMeta(k).cls}${filter === k ? ' on' : ''}`}
            onClick={() => setFilter(filter === k ? null : k)}>
            <b>{rollup[k]}</b> {label}
          </button>
        ))}
        {filter && <button className="linkish" onClick={() => setFilter(null)}>show all</button>}
      </div>

      {/* schedule verdict */}
      <section className="sched-block">
        <div className="date-grid">
          <label>Depart
            <input type="date" value={startDate}
              onChange={(e) => { setStartDate(e.target.value); if (e.target.value) saveSetting('startDate', e.target.value); }} />
          </label>
          <label>Arrive by
            <input type="date" value={arriveDate}
              onChange={(e) => { setArriveDate(e.target.value); setFit(null); if (e.target.value) saveSetting('arriveDate', e.target.value); }} />
          </label>
          <label>Max mi/day
            <input type="number" min={20} max={140} value={maxMiles}
              onChange={(e) => setMaxMiles(Number(e.target.value))}
              onBlur={(e) => saveSetting('maxDayMiles', String(Number(e.target.value)))} />
          </label>
          <label>Start at mile
            <input type="number" min={0} max={Math.floor(plan.totalMiles)} step="0.1" value={startMile}
              onChange={(e) => setStartMile(e.target.value)}
              onBlur={async (e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v) || v === (plan.tripStartMile ?? 0)) return;
                try {
                  const pos = await apiGet<{ mile: number; nearPlace: string }>(`/api/position?mile=${v}`);
                  setStartMilePreview({ mile: pos.mile, place: pos.nearPlace });
                } catch { setStartMilePreview({ mile: v, place: '' }); }
              }} />
          </label>
        </div>

        {/* Moving the start point is a rebuild of every unridden day — shown
            before it happens, never applied on a keystroke. */}
        {startMilePreview && (
          <div className="proposal">
            <div className="proposal-head">
              <b>Start the ride at mile {startMilePreview.mile}</b>
              {startMilePreview.place && <> — {startMilePreview.place}</>}
            </div>
            <ul className="fit-lines">
              <li>Day 1 begins at mile {startMilePreview.mile} instead of {plan.tripStartMile ?? 0}</li>
              <li>{Math.round(plan.totalMiles - startMilePreview.mile).toLocaleString()} mi to ride
                {' '}({Math.round(Math.abs(startMilePreview.mile - (plan.tripStartMile ?? 0)))} mi {startMilePreview.mile > (plan.tripStartMile ?? 0) ? 'less' : 'more'} than now)</li>
              <li>Every unridden day is rebuilt from there — chosen beds and work stops on those days are re-picked</li>
              <li className="dim">The route, its resources, camping research and warnings keep their same mile markers</li>
            </ul>
            <div className="proposal-actions">
              <button className="primary" disabled={busy !== null}
                onClick={() => run('startmile', async () => {
                  await apiPost('/api/settings', { tripStartMile: String(startMilePreview.mile) });
                  await apiPost('/api/plan/auto', { maxMiles, fromScratch: true });
                  setStartMilePreview(null);
                  refetch();
                })}>
                {busy === 'startmile' ? 'Rebuilding…' : 'Move the start & rebuild'}
              </button>
              <button className="ghost" onClick={() => {
                setStartMile(String(plan.tripStartMile ?? 0));
                setStartMilePreview(null);
              }}>Keep current plan</button>
            </div>
          </div>
        )}
        {sched && sched.availableDays != null && (
          <div className={`sched ${(sched.daysLate ?? 0) > 0 ? 'late' : (sched.slackDays ?? 0) <= 2 ? 'tight' : 'ok'}`}>
            <b>{sched.availableDays} calendar days</b> · plan needs {sched.plannedDays}
            {(sched.daysLate ?? 0) > 0 ? <b> — {sched.daysLate} too many</b> : <> — {sched.slackDays} spare</>}
            <div className="dim">Arrives {sched.projectedArrival}
              {sched.requiredAvgMiles != null && <> · needs {sched.requiredAvgMiles} mi/day average</>}</div>
            {(sched.daysLate ?? 0) === 0 && (sched.slackDays ?? 0) <= 2 && (
              <div className="sched-tight">
                {sched.slackDays === 0 ? 'No spare days' : `Only ${sched.slackDays} spare day(s)`} —
                one weather day or mechanical puts you behind.
              </div>
            )}
            <div className="sched-actions">
              <button className="ghost" disabled={busy !== null}
                onClick={() => run('fit', async () => setFit(await apiGet<FitResult>('/api/plan/fit')))}>
                {busy === 'fit' ? 'Working…' : 'What would it take?'}
              </button>
              {(sched.daysLate ?? 0) > 0 && (
                <button className="primary" disabled={busy !== null}
                  onClick={() => run('fit', async () => {
                    const res = await apiPost<FitResult>('/api/plan/fit', {});
                    setFit(res);
                    if (res.cap) setMaxMiles(res.cap);
                    refetch();
                  })}>Fit to dates</button>
              )}
            </div>
          </div>
        )}
        {fit && (
          <div className={`fit-note ${fit.feasible ? '' : 'warn'}`}>
            {fit.note}
            {fit.feasible && fit.changed && !fit.revisionId && (
              <button className="linkish" disabled={busy !== null}
                onClick={() => run('fit', async () => {
                  const res = await apiPost<FitResult>('/api/plan/fit', {});
                  setFit(res);
                  if (res.cap) setMaxMiles(res.cap);
                  refetch();
                })}>Raise cap to {fit.cap} and rebuild</button>
            )}
            {fit.revisionId && <> ✓ Applied — {fit.dayCount} days.</>}
          </div>
        )}
      </section>

      {err && <div className="error">{err}</div>}

      {/* weekday-vs-weekend load: planned miles against feasible miles */}
      {loadBars.length > 0 && (
        <section className="load-chart">
          <div className="leg-kicker">PLANNED vs FEASIBLE MILES
            <span className="dim"> — weekdays create mileage debt; weekends repay it</span>
          </div>
          <div className="bars-wrap">
            {/* Mileage gridlines every 25 mi, so a bar's height is readable as
                a number instead of only as a comparison. */}
            <div className="bars-axis">
              {Array.from({ length: Math.floor(maxBar / 25) + 1 }, (_, i) => i * 25)
                .filter((v) => v > 0)
                .map((v) => (
                  <div key={v} className="axis-line" style={{ bottom: `${(v / maxBar) * 100}%` }}>
                    <span>{v}</span>
                  </div>
                ))}
            </div>
            <div className="bars">
            {loadBars.map((b) => (
              <button key={b.n} className={`bar-col${b.weekend ? ' weekend' : ''}`}
                title={`D${b.n}: planned ${b.planned}, feasible ~${b.feasible}`}
                onClick={() => gotoDay(b.n)}>
                <span className="bar feas" style={{ height: `${(b.feasible / maxBar) * 100}%` }} />
                <span className={`bar plan fit-${b.fit}`} style={{ height: `${(b.planned / maxBar) * 100}%` }} />
              </button>
            ))}
            </div>
          </div>
          <div className="bars-legend dim">
            <span className="lg plan" /> planned <span className="lg feas" /> feasible (daylight − work) ·
            shaded columns = weekends
          </div>
        </section>
      )}

      {/* the day list — compact, scanable, tap to open the Day Canvas */}
      <ul className="trip-list">
        {shown.map((d) => <TripRow key={d.dayNumber} d={d} gotoDay={gotoDay} showDayOnMap={showDayOnMap} />)}
      </ul>

      {/* replan proposal */}
      {preview && (
        <section className="proposal">
          <div className="proposal-head"><b>Proposed replan</b> from mile {preview.baselineMile}</div>
          <div className="mode-row">
            <button className={preview.mode === 'rebuild' ? 'on' : 'ghost'} disabled={busy !== null}
              onClick={() => run('replan', async () => setPreview(await apiGet<ReplanPreview>('/api/replan/preview?mode=rebuild')))}>Re-spread days</button>
            <button className={preview.mode === 'anchors' ? 'on' : 'ghost'} disabled={busy !== null}
              onClick={() => run('replan', async () => setPreview(await apiGet<ReplanPreview>('/api/replan/preview?mode=anchors')))}>Keep my beds</button>
          </div>
          {preview.issues.map((i, k) => <div key={k} className="warn">⚠ {i}</div>)}
          <ul className="diff-list">
            {preview.days.slice(0, 10).map((d) => (
              <li key={d.day_number}>D{d.day_number}: {d.miles} mi → {d.end_name}
                {d.overnightName && <span className="dim"> · {d.overnightName}</span>}</li>
            ))}
          </ul>
          <div className="proposal-actions">
            <button className="primary" disabled={busy !== null}
              onClick={() => run('replan', async () => { await apiPost('/api/replan/apply', { mode: preview.mode }); setPreview(null); refetch(); })}>
              Accept new plan
            </button>
            <button className="ghost" onClick={() => setPreview(null)}>Keep current plan</button>
          </div>
        </section>
      )}

      {/* engine room — powerful, rarely needed, deliberately below the fold */}
      <details className="engine">
        <summary>Engine room — rebuild, work-aware planning, replans</summary>
        <div className="engine-body">
          <label className="work-toggle">
            <input type="checkbox" checked={workAware} disabled={busy !== null}
              onChange={(e) => { setWorkAware(e.target.checked); saveSetting('workAwarePlanning', e.target.checked ? '1' : '0'); }} />
            Shorten weekdays to fit the work day
          </label>
          <div className="engine-actions">
            <button className="ghost" disabled={busy !== null}
              onClick={() => run('itin', async () => setItin(await apiGet<AutoItinResult>('/api/plan/itinerary/auto')))}>
              {busy === 'itin' ? 'Checking…' : 'Check work schedule'}
            </button>
            <button className="ghost" disabled={busy !== null}
              onClick={() => run('itin', async () => { setItin(await apiPost<AutoItinResult>('/api/plan/itinerary/auto', {})); refetch(); })}>
              Auto-place every work stop
            </button>
            <button className="ghost" disabled={busy !== null}
              onClick={() => run('build', async () => { await apiPost('/api/plan/auto', { maxMiles }); setPreview(null); refetch(); })}>
              {busy === 'build' ? 'Rebuilding…'
                : riddenDays.length ? `Rebuild from day ${riddenDays.length + 1}` : 'Rebuild plan'}
            </button>
            {riddenDays.length > 0 && (
              <button className="ghost" disabled={busy !== null}
                onClick={() => run('replan', async () => setPreview(await apiGet<ReplanPreview>('/api/replan/preview?mode=rebuild')))}>
                Preview replan from last actual
              </button>
            )}
          </div>
          {itin && (
            <div className="work-report">
              <div><b>{itin.fullyScheduled}/{itin.workdays}</b> work days fully scheduled{itin.applied && <span className="dim"> · applied</span>}</div>
              {itin.problemDays.slice(0, 8).map((p) => (
                <button key={p.dayNumber} className="work-issue" onClick={() => gotoDay(p.dayNumber)}>
                  <b>D{p.dayNumber}</b> {p.date?.slice(5)} — {p.issues[0]}
                </button>
              ))}
              {itin.problemDays.length > 8 && <div className="dim">…and {itin.problemDays.length - 8} more</div>}
            </div>
          )}
          <div className="dim">Days never exceed the cap; climbing days come out shorter (~100 ft ≈ 1 mi of effort).
            {riddenDays.length > 0 && <> Ridden days stay exactly as ridden.</>}</div>
        </div>
      </details>
    </div>
  );
}

function TripRow({ d, gotoDay, showDayOnMap }: {
  d: PlanDay; gotoDay: (n: number) => void; showDayOnMap: (n: number) => void;
}) {
  const rd = readinessMeta(d.actual ? 'done' : d.readiness?.state);
  const sleepGlyph = d.overnight
    ? (d.overnight.category === 'campground' ? '⛺' : '🏨')
    : d.overnightCampId ? '⛺' : d.rest ? '↻' : '·';
  const workGlyph = !d.sun?.workday ? '—'
    : d.workStop ? wifiMeta(d.workStop.wifiStatus).icon : '✕';
  return (
    <li className={`trip-row${d.actual ? ' done' : ''}${d.rest ? ' rest' : ''}`}>
      <button className="trip-row-main" onClick={() => gotoDay(d.dayNumber)}>
        <span className="tr-day">{d.dayNumber}</span>
        <span className="tr-date"><span className="tr-dow">{dowOf(d.date)} </span>{shortDate(d.date)}</span>
        <span className="tr-dest">
          {d.rest ? <i>Rest — {d.endName}</i> : d.endName}
          {d.riderNotes?.some((x) => x.kind === 'ferry') && ' ⛴'}
        </span>
        <span className="tr-mi">{d.actual ? <b>{d.actual.miles}</b> : d.miles} mi</span>
        <span className="tr-time dim">{d.rest ? '' : durMin(d.rideTimeMin)}</span>
        <span className={`tr-work ${d.workStop ? wifiMeta(d.workStop.wifiStatus).cls : d.sun?.workday ? 'wifi-none' : 'dim'}`}
          title={d.sun?.workday ? (d.workStop ? `${d.workStop.name} — ${d.workStop.wifiStatus}` : 'no work stop') : 'weekend'}>
          {workGlyph}
        </span>
        <span className="tr-sleep" title={d.overnight?.name ?? (d.overnightCampId ? 'researched camp' : 'no bed chosen')}>{sleepGlyph}</span>
        <span className="tr-light dim" title="daylight buffer">
          {d.sun && !d.rest ? `${d.sun.bufferMin >= 0 ? '+' : '−'}${durMin(Math.abs(d.sun.bufferMin))}` : ''}
        </span>
        <span className={`tr-ready ${rd.cls}`}>{d.actual ? '✓' : rd.label}</span>
      </button>
      <button className="tr-map" title="Show on map" onClick={() => showDayOnMap(d.dayNumber)}>◎</button>
    </li>
  );
}
