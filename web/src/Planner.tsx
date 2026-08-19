import { useEffect, useState } from 'react';
import Itinerary from './Itinerary';

// ---- API types (mirror server/plan.mjs responses) ----
export interface DayNote {
  id: number; kind: string; title: string; detail: string;
  startMile: number; endMile: number; source: string | null; confidence: string;
}

export interface PlanDay {
  dayNumber: number; startMile: number; endMile: number; miles: number;
  elevGainFt: number | null; elevLossFt: number | null;
  riderNotes: DayNote[];
  startName: string; endName: string;
  endState: string | null;
  overnight: {
    id: string; name: string; category: string; offRouteMi: number | null;
    address: string | null; phone: string | null; website: string | null;
    hours: string | null; lat: number; lng: number; attributes: string | null;
    town: string | null; state: string | null; routeMile: number | null;
  } | null;
  status: string; flags: string[]; notes: string | null;
  resourceCounts: Record<string, number>;
  actual: { endMile: number; miles: number; endName: string; date: string | null; notes: string | null } | null;
  date?: string | null;
}
export interface Schedule {
  startDate: string | null; arriveDate: string | null;
  plannedDays: number; projectedArrival?: string; maxDayMiles?: number;
  availableDays?: number; slackDays?: number;
  requiredAvgMiles?: number | null; daysLate?: number;
}
interface AutoItinResult {
  applied: boolean; dayCount: number; workdays: number; fullyScheduled: number;
  problemDays: { dayNumber: number; date: string | null; issues: string[];
    scheduledMin: number; requiredMin: number }[];
}
interface FitResult {
  feasible: boolean; changed: boolean; cap?: number; previousCap?: number;
  dayCount: number; availableDays: number; daysLeft: number;
  slackDays?: number; note: string; revisionId?: number;
}
export interface PlanResponse {
  revision: { id: number; createdAt: string; reason: string } | null;
  days: PlanDay[];
  geometry: {
    lines: GeoJSON.FeatureCollection;
    bounds: GeoJSON.FeatureCollection;
  } | null;
  totalMiles: number;
  schedule?: Schedule;
  history?: { id: number; created_at: string; reason: string; active: number; day_count: number }[];
}
interface Suggestion {
  resourceId: string; name: string; brand: string | null; category: string;
  routeMile: number; dayMiles: number; offRouteMi: number; wifiNear: number;
  town: string; score: number;
  effortMiles: number; climbFt: number | null; state: string | null;
  address: string | null; phone: string | null; website: string | null;
  hours: string | null; lat: number; lng: number; attributes: string | null;
}
interface ReplanDay {
  day_number: number; start_mile: number; end_mile: number;
  start_name: string; end_name: string; miles: number; climbFt: number | null;
  overnightName: string | null;
  origDayNumber: number | null; origMiles: number | null;
  deltaMiles: number | null; flags: string[];
}
interface ReplanPreview {
  mode: 'rebuild' | 'anchors';
  baselineMile: number; afterDay: number; baselineName: string | null;
  days: ReplanDay[]; issues: string[]; maxDayMiles: number;
  summary: { oldFinishDay: number; newFinishDay: number; dayDelta: number; remainingMiles: number };
}

const OVERNIGHT_ICON: Record<string, string> = { campground: '⛺', hotel: '🏨' };

const NOTE_ICON: Record<string, string> = {
  ferry: '⛴️', detour: '🚧', highway: '🛣️', no_services: '🏜️',
  climb: '⛰️', bridge: '🌉', traffic: '🚗', trail: '🌿', caution: '⚠️',
};
const STATUS_LABEL: Record<string, string> = {
  planned: 'planned', completed: 'done', modified: 'changed', skipped: 'skipped',
};

interface DayWeather {
  date: string; tempF?: number; shortForecast?: string; precipPct?: number | null;
  windSpeed?: string; windDirection?: string; windClass?: string | null; error?: string;
}

// Single-series elevation microviz: one ink hue, thin line, hover readout.
function ElevProfile({ data }: { data: [number, number][] }) {
  const [hi, setHi] = useState<number | null>(null);
  if (data.length < 2) return null;
  const W = 264, H = 64;
  const m0 = data[0][0], m1 = data[data.length - 1][0];
  const es = data.map((d) => d[1]);
  const e0 = Math.min(...es), e1 = Math.max(...es);
  const x = (m: number) => 2 + ((m - m0) / Math.max(0.1, m1 - m0)) * (W - 4);
  const y = (e: number) => H - 14 - ((e - e0) / Math.max(1, e1 - e0)) * (H - 24);
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(d[0]).toFixed(1)},${y(d[1]).toFixed(1)}`).join('');
  const area = `${line}L${x(m1).toFixed(1)},${H - 12}L${x(m0).toFixed(1)},${H - 12}Z`;
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mile = m0 + ((e.clientX - rect.left) / rect.width) * (m1 - m0);
    let best = 0;
    for (let i = 1; i < data.length; i++) {
      if (Math.abs(data[i][0] - mile) < Math.abs(data[best][0] - mile)) best = i;
    }
    setHi(best);
  };
  return (
    <svg className="elev-svg" viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
      onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      <path d={area} fill="#64748b" opacity="0.14" />
      <path d={line} fill="none" stroke="#475569" strokeWidth="2" strokeLinejoin="round" />
      <text x={W - 2} y={9} textAnchor="end" fontSize="9" fill="#64748b">{e1.toLocaleString()} ft</text>
      <text x={W - 2} y={H - 2} textAnchor="end" fontSize="9" fill="#64748b">{e0.toLocaleString()} ft</text>
      <text x={2} y={H - 2} fontSize="9" fill="#64748b">mi {Math.round(m0)}–{Math.round(m1)}</text>
      {hi != null && (
        <>
          <line x1={x(data[hi][0])} x2={x(data[hi][0])} y1={4} y2={H - 12} stroke="#94a3b8" strokeWidth="1" />
          <circle cx={x(data[hi][0])} cy={y(data[hi][1])} r="3" fill="#475569" stroke="#fff" strokeWidth="1.5" />
          <text x={x(data[hi][0]) > W / 2 ? x(data[hi][0]) - 6 : x(data[hi][0]) + 6} y={12}
            textAnchor={x(data[hi][0]) > W / 2 ? 'end' : 'start'} fontSize="10" fill="#334155">
            mi {Math.round(data[hi][0])} · {data[hi][1].toLocaleString()} ft
          </text>
        </>
      )}
    </svg>
  );
}

function fullAddress(
  d: { name: string; address: string | null; town: string | null; state: string | null }
): string {
  // OSM addresses already end in the city, so only add the town when it is
  // missing — "809 Bloodworth Lane Pensacola, FL" not "…Pensacola Pensacola, FL".
  const parts = [d.address];
  if (d.town && !d.town.startsWith('Mile ') && !d.town.startsWith('near ') &&
      !(d.address ?? '').toLowerCase().includes(d.town.toLowerCase())) {
    parts.push(d.town);
  }
  const line = parts.filter(Boolean).join(', ');
  return [line, d.state].filter(Boolean).join(', ');
}

function DestinationCard({ o, endName }: {
  o: NonNullable<PlanDay['overnight']>; endName: string;
}) {
  const [copied, setCopied] = useState(false);
  const addr = fullAddress(o);
  const paste = [o.name, addr].filter(Boolean).join(', ');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(paste);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — the text is on screen to copy by hand */ }
  };
  return (
    <div className="dest-card">
      <div className="dest-head">
        <span className="dest-ic">{OVERNIGHT_ICON[o.category] ?? '📍'}</span>
        <div>
          <div className="dest-name">{o.name}</div>
          <div className="dest-sub dim">
            Tonight in {endName}
            {o.offRouteMi != null && <> · {o.offRouteMi} mi off route</>}
            {o.routeMile != null && <> · mile {o.routeMile}</>}
          </div>
        </div>
      </div>
      {addr && <div className="dest-addr">{addr}</div>}
      {o.hours && <div className="dim dest-hours">Hours: {o.hours}</div>}
      <div className="dest-actions">
        <a className="act" target="_blank" rel="noreferrer"
          href={`https://maps.apple.com/?daddr=${o.lat},${o.lng}`}> Apple Maps</a>
        <a className="act" target="_blank" rel="noreferrer"
          href={`https://www.google.com/maps/dir/?api=1&destination=${o.lat},${o.lng}&travelmode=bicycling`}>🚲 Google Maps</a>
        {o.website && <a className="act" target="_blank" rel="noreferrer" href={o.website}>🌐 Site</a>}
        {o.phone && <a className="act" href={`tel:${o.phone}`}>📞 Call</a>}
        <button className="act" onClick={copy}>{copied ? '✓ Copied' : '📋 Copy'}</button>
      </div>
    </div>
  );
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export default function PlannerPanel({ plan, selectedDay, onSelectDay, refetch }: {
  plan: PlanResponse | null;
  selectedDay: number | null;
  onSelectDay: (day: number | null) => void;
  refetch: () => void;
}) {
  const [maxMiles, setMaxMiles] = useState(65);
  const [replanMode, setReplanMode] = useState<'rebuild' | 'anchors'>('rebuild');
  const [openSug, setOpenSug] = useState<string | null>(null);
  const [endDraft, setEndDraft] = useState('');
  const [arriveDate, setArriveDate] = useState('');
  const [fit, setFit] = useState<FitResult | null>(null);
  const [itin, setItin] = useState<AutoItinResult | null>(null);
  const [workAware, setWorkAware] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [suggestMode, setSuggestMode] = useState<'move' | 'split'>('move');
  const [actualMile, setActualMile] = useState('');
  const [actualNotes, setActualNotes] = useState('');
  const [preview, setPreview] = useState<ReplanPreview | null>(null);
  const [startDate, setStartDate] = useState('');
  const [wx, setWx] = useState<Record<number, DayWeather>>({});
  const [profiles, setProfiles] = useState<Record<number, [number, number][] | null>>({});

  // Settings + weather ride along with the plan revision.
  useEffect(() => {
    (async () => {
      try {
        const s = await api<Record<string, string>>('/api/settings');
        if (s.startDate) setStartDate(s.startDate);
        if (s.maxDayMiles) setMaxMiles(Number(s.maxDayMiles));
        if (s.arriveDate) setArriveDate(s.arriveDate);
        setWorkAware(s.workAwarePlanning === '1');
        const w = await api<{ byDay: Record<number, DayWeather> }>('/api/weather');
        setWx(w.byDay ?? {});
      } catch { /* weather is best-effort */ }
    })();
  }, [plan?.revision?.id]);

  // Elevation profile for the selected day, fetched once and cached.
  useEffect(() => {
    if (selectedDay == null || profiles[selectedDay] !== undefined) return;
    (async () => {
      try {
        const p = await api<{ profile: [number, number][] | null }>(
          `/api/plan/day/${selectedDay}/profile`);
        setProfiles((prev) => ({ ...prev, [selectedDay]: p.profile }));
      } catch {
        setProfiles((prev) => ({ ...prev, [selectedDay]: null }));
      }
    })();
  }, [selectedDay, profiles]);

  const saveStartDate = async (v: string) => {
    setStartDate(v);
    if (!v) return;
    try {
      await api('/api/settings', { startDate: v });
      const w = await api<{ byDay: Record<number, DayWeather> }>('/api/weather');
      setWx(w.byDay ?? {});
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  };

  const days = plan?.days ?? [];
  const riddenDays = days.filter((d) => d.actual);
  const nextRideable = days.find(
    (d) => !d.actual && (d.dayNumber === 1 || days.find((p) => p.dayNumber === d.dayNumber - 1)?.actual)
  );

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label); setErr(null);
    try { await fn(); } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(null);
  }

  const buildPlan = () => run('build', async () => {
    await api('/api/plan/auto', { maxMiles });
    onSelectDay(null); setSuggestions(null); setPreview(null);
    refetch();
  });

  const loadSuggestions = (day: PlanDay, mode: 'move' | 'split') => run('suggest', async () => {
    const t = mode === 'split' ? Math.round(day.miles / 2) : Math.round(day.miles);
    const w = mode === 'split' ? 18 : 15;
    setSuggestMode(mode);
    setSuggestions(await api<Suggestion[]>(
      `/api/plan/suggest?fromMile=${day.startMile}&target=${t}&window=${w}`
    ));
  });

  const applySuggestion = (day: PlanDay, s: Suggestion) => run('apply', async () => {
    if (suggestMode === 'split') {
      await api('/api/plan/day/split', {
        dayNumber: day.dayNumber, atMile: s.routeMile,
        endName: s.town.startsWith('Mile ') ? s.name : s.town,
        overnightResourceId: s.resourceId,
      });
    } else {
      await api('/api/plan/day', {
        dayNumber: day.dayNumber, endMile: s.routeMile,
        endName: s.town.startsWith('Mile ') ? s.name : s.town,
        overnightResourceId: s.resourceId,
      });
    }
    setSuggestions(null);
    refetch();
  });

  const recordActual = (day: PlanDay) => run('record', async () => {
    const mile = Number(actualMile);
    if (!Number.isFinite(mile)) throw new Error('Enter the mile you stopped at');
    // One call: save what actually happened AND get the proposed reshuffle.
    const res = await api<{ preview: ReplanPreview }>('/api/actual/replan', {
      dayNumber: day.dayNumber, endMile: mile,
      notes: actualNotes || undefined, mode: replanMode,
    });
    setActualMile(''); setActualNotes('');
    refetch();
    setPreview(res.preview ?? null);
  });

  const switchReplanMode = (mode: 'rebuild' | 'anchors') => run('replan', async () => {
    setReplanMode(mode);
    setPreview(await api<ReplanPreview>(`/api/replan/preview?mode=${mode}`));
  });

  const acceptReplan = () => run('replan', async () => {
    await api('/api/replan/apply', { mode: replanMode });
    setPreview(null); setSuggestions(null); onSelectDay(null);
    refetch();
  });

  // Move the boundary between this day and the next: miles shaved off the front
  // of tomorrow land on the back of today, and vice versa.
  const moveBoundary = (day: PlanDay, newEnd: number) => run('nudge', async () => {
    const next = days.find((x) => x.dayNumber === day.dayNumber + 1);
    const end = Math.round(newEnd * 10) / 10;
    if (end <= day.startMile + 1) throw new Error('That would leave day ' + day.dayNumber + ' with no distance');
    if (next && end >= next.endMile - 1) throw new Error(`That would swallow day ${next.dayNumber} — merge them instead`);
    if (!next && end > plan!.totalMiles) throw new Error('Past the end of the route');
    // Keep the overnight only if the new endpoint is still essentially at it.
    const keep = day.overnight && day.overnight.routeMile != null &&
      Math.abs(end - day.overnight.routeMile) < 0.5 ? day.overnight.id : undefined;
    await api('/api/plan/day', {
      dayNumber: day.dayNumber, endMile: end, overnightResourceId: keep,
    });
    setEndDraft('');
    refetch();
  });

  const mergeWithNext = (day: PlanDay) => run('merge', async () => {
    await api('/api/plan/day/merge', { dayNumber: day.dayNumber });
    onSelectDay(null);
    refetch();
  });

  const lockDay = (day: PlanDay) => run('lock', async () => {
    await api('/api/plan/day/complete', { dayNumber: day.dayNumber });
    refetch();
  });

  const unlockDay = (day: PlanDay) => run('lock', async () => {
    await api('/api/plan/day/unlock', { dayNumber: day.dayNumber });
    setPreview(null);
    refetch();
  });

  const saveArriveDate = (v: string) => run('dates', async () => {
    setArriveDate(v);
    setFit(null);
    if (v) await api('/api/settings', { arriveDate: v });
    refetch();
  });

  // Ask what ceiling it would take to land on the arrive date — a proposal, not
  // a change, so the rider sees the trade before agreeing to it.
  const checkFit = () => run('fit', async () => {
    setFit(await api<FitResult>('/api/plan/fit'));
  });

  const applyFit = () => run('fit', async () => {
    const res = await api<FitResult>('/api/plan/fit', {});
    setFit(res);
    if (res.cap) setMaxMiles(res.cap);
    onSelectDay(null);
    refetch();
  });

  const previewItineraries = () => run('itin', async () => {
    setItin(await api<AutoItinResult>('/api/plan/itinerary/auto'));
  });

  const applyItineraries = () => run('itin', async () => {
    setItin(await api<AutoItinResult>('/api/plan/itinerary/auto', {}));
    refetch();
  });

  const toggleWorkAware = (on: boolean) => run('cap', async () => {
    setWorkAware(on);
    await api('/api/settings', { workAwarePlanning: on ? '1' : '0' });
  });

  const saveMaxMiles = (v: number) => run('cap', async () => {
    setMaxMiles(v);
    await api('/api/settings', { maxDayMiles: String(v) });
  });

  if (!plan) return <div className="dim-note">Loading plan…</div>;

  // ---- No plan yet: the build form ----
  if (!plan.revision) {
    return (
      <div>
        <p className="dim-note">
          No trip plan yet. Auto-build one: the planner walks the route and picks
          real overnight anchors (campgrounds / hotels near the route), never
          exceeding your daily ceiling and shortening days that climb hard.
        </p>
        <div className="build-row">
          <label>Max mi/day
            <input type="number" min={20} max={140} value={maxMiles}
              onChange={(e) => setMaxMiles(Number(e.target.value))} />
          </label>
          <button disabled={busy !== null} onClick={buildPlan}>
            {busy === 'build' ? 'Building…' : 'Build plan'}
          </button>
        </div>
        {err && <div className="error">{err}</div>}
      </div>
    );
  }

  const sched = plan.schedule;
  const plannedSoFar = riddenDays.reduce((s, d) => s + d.miles, 0);
  const actualSoFar = riddenDays.reduce((s, d) => s + (d.actual?.miles ?? 0), 0);
  const behind = plannedSoFar - actualSoFar;

  return (
    <div>
      <div className="plan-summary">
        <b>{days.length} days</b> · avg {Math.round(plan.totalMiles / days.length)} mi/day
        {riddenDays.length > 0 && (
          <div className="dim">
            {riddenDays.length} ridden · {Math.round(actualSoFar)} mi done
            {Math.abs(behind) > 1 && (
              <b className={behind > 0 ? 'behind' : 'ahead'}>
                {' '}({Math.round(Math.abs(behind))} mi {behind > 0 ? 'behind' : 'ahead of'} plan)
              </b>
            )}
          </div>
        )}
        <div className="dim">rev #{plan.revision.id}: {plan.revision.reason}</div>
        <div className="date-grid">
          <label>Depart
            <input type="date" value={startDate} onChange={(e) => saveStartDate(e.target.value)} />
          </label>
          <label>Arrive by
            <input type="date" value={arriveDate} onChange={(e) => saveArriveDate(e.target.value)} />
          </label>
        </div>
        {sched && sched.availableDays != null && (
          <div className={`sched ${(sched.daysLate ?? 0) > 0 ? 'late'
            : (sched.slackDays ?? 0) <= 2 ? 'tight' : 'ok'}`}>
            <div>
              <b>{sched.availableDays} calendar days</b> · plan needs {sched.plannedDays}
              {(sched.daysLate ?? 0) > 0
                ? <b> — {sched.daysLate} too many</b>
                : <> — {sched.slackDays} spare</>}
            </div>
            <div className="dim">
              Arrives {sched.projectedArrival}
              {sched.requiredAvgMiles != null && <> · needs {sched.requiredAvgMiles} mi/day average</>}
            </div>
            {(sched.daysLate ?? 0) === 0 && (sched.slackDays ?? 0) <= 2 && (
              <div className="sched-tight">
                {sched.slackDays === 0 ? 'No spare days' : `Only ${sched.slackDays} spare day(s)`} —
                one weather day, mechanical, or short day puts you behind. Pull the
                arrive date later, or plan to make it up with longer days.
              </div>
            )}
            <div className="sched-actions">
              <button className="ghost" disabled={busy !== null} onClick={checkFit}>
                {busy === 'fit' ? 'Working…' : 'What would it take?'}
              </button>
              {(sched.daysLate ?? 0) > 0 && (
                <button disabled={busy !== null} onClick={applyFit}>Fit to dates</button>
              )}
            </div>
          </div>
        )}
        {fit && (
          <div className={`fit-note ${fit.feasible ? '' : 'warn'}`}>
            {fit.note}
            {fit.feasible && fit.changed && !fit.revisionId && (
              <button className="fit-apply" disabled={busy !== null} onClick={applyFit}>
                Raise cap to {fit.cap} and rebuild
              </button>
            )}
            {fit.revisionId && <> ✓ Applied — {fit.dayCount} days.</>}
          </div>
        )}
        <div className="cap-row">
          <label>Max mi/day
            <input type="number" min={20} max={140} value={maxMiles}
              onChange={(e) => setMaxMiles(Number(e.target.value))}
              onBlur={(e) => saveMaxMiles(Number(e.target.value))} />
          </label>
          <button className="ghost" disabled={busy !== null} onClick={buildPlan}>
            {busy === 'build' ? 'Rebuilding…'
              : riddenDays.length ? `Rebuild from day ${riddenDays.length + 1}` : 'Rebuild plan'}
          </button>
        </div>
        <div className="work-panel">
          <label className="work-toggle">
            <input type="checkbox" checked={workAware} disabled={busy !== null}
              onChange={(e) => toggleWorkAware(e.target.checked)} />
            Shorten weekdays to fit a work day
          </label>
          <div className="work-actions">
            <button className="ghost" disabled={busy !== null} onClick={previewItineraries}>
              {busy === 'itin' ? 'Checking…' : 'Check work schedule'}
            </button>
            <button disabled={busy !== null} onClick={applyItineraries}>
              Auto-plan every day
            </button>
          </div>
          {itin && (
            <div className="work-report">
              <div>
                <b>{itin.fullyScheduled}/{itin.workdays}</b> work days fully scheduled
                {itin.applied && <span className="dim"> · applied</span>}
              </div>
              {itin.problemDays.length === 0 && <div className="dim">No conflicts.</div>}
              {itin.problemDays.slice(0, 8).map((p) => (
                <div key={p.dayNumber} className="work-issue"
                  onClick={() => onSelectDay(p.dayNumber)}>
                  <b>D{p.dayNumber}</b> {p.date?.slice(5)} — {p.issues[0]}
                </div>
              ))}
              {itin.problemDays.length > 8 && (
                <div className="dim">…and {itin.problemDays.length - 8} more days with warnings</div>
              )}
            </div>
          )}
        </div>
        <div className="dim cap-note">
          Days never exceed the cap; climbing days come out shorter automatically
          (~100 ft of climb ≈ 1 mile of effort).
          {riddenDays.length > 0 && (
            <> Days 1–{riddenDays.length} are locked and stay exactly as ridden.</>
          )}
        </div>
      </div>

      {err && <div className="error">{err}</div>}

      {preview && (
        <div className="replan">
          <div className="replan-title">
            Replan from mile {preview.baselineMile}
            {preview.baselineName ? ` (${preview.baselineName})` : ''}?
          </div>
          <div className="mode-row">
            <button className={preview.mode === 'rebuild' ? 'on' : 'ghost'}
              disabled={busy !== null} onClick={() => switchReplanMode('rebuild')}>
              Re-spread all days
            </button>
            <button className={preview.mode === 'anchors' ? 'on' : 'ghost'}
              disabled={busy !== null} onClick={() => switchReplanMode('anchors')}>
              Keep my stops
            </button>
          </div>
          <div className="replan-sum">
            {preview.summary.remainingMiles} mi left · finish day {preview.summary.oldFinishDay}
            {preview.summary.dayDelta !== 0 && (
              <b> → {preview.summary.newFinishDay} ({preview.summary.dayDelta > 0 ? '+' : ''}{preview.summary.dayDelta} day{Math.abs(preview.summary.dayDelta) === 1 ? '' : 's'})</b>
            )}
            {preview.summary.dayDelta === 0 && <> (unchanged)</>}
            <span className="dim"> · capped at {preview.maxDayMiles} mi</span>
          </div>
          {preview.issues.map((i, k) => <div key={k} className="warn">⚠ {i}</div>)}
          <ul className="replan-days">
            {preview.days.slice(0, 10).map((d) => (
              <li key={d.day_number}>
                D{d.day_number}: {d.miles} mi
                {d.origMiles != null && Math.abs(d.deltaMiles ?? 0) > 0.5 && (
                  <span className="dim"> (was {d.origMiles}, {(d.deltaMiles ?? 0) > 0 ? '+' : ''}{d.deltaMiles})</span>
                )}
                {' '}→ {d.end_name}
                {d.overnightName && <span className="dim"> · {d.overnightName}</span>}
                {d.flags.length > 0 && <span className="flag"> {d.flags.join(', ')}</span>}
              </li>
            ))}
            {preview.days.length > 10 && (
              <li className="dim">…and {preview.days.length - 10} more days</li>
            )}
          </ul>
          <div className="dim" style={{ fontSize: 11 }}>
            {preview.mode === 'rebuild'
              ? 'Every remaining day is re-cut from where you actually stopped, under your cap, with climbing days shortened.'
              : 'Your chosen overnight stops are kept; only start points and mileages shift.'}
            {' '}Nothing is saved until you accept — the current plan stays in history either way.
          </div>
          <div className="replan-actions">
            <button disabled={busy !== null} onClick={acceptReplan}>
              {busy === 'replan' ? 'Applying…' : 'Accept new plan'}
            </button>
            <button className="ghost" onClick={() => setPreview(null)}>Keep current plan</button>
          </div>
        </div>
      )}

      <ul className="day-list">
        {days.map((d) => {
          const sel = d.dayNumber === selectedDay;
          const isNext = nextRideable?.dayNumber === d.dayNumber;
          return (
            <li key={d.dayNumber} className={sel ? 'sel' : ''}>
              <div className="day-row" onClick={() => {
                onSelectDay(sel ? null : d.dayNumber);
                setSuggestions(null);
              }}>
                <span className={`day-chip st-${d.status}`}>D{d.dayNumber}</span>
                {d.date && <span className="day-date">{d.date.slice(5).replace('-', '/')}</span>}
                <span className="day-dest">
                  {d.endName}
                  {d.overnight && <span className="ov-ic"> {OVERNIGHT_ICON[d.overnight.category] ?? ''}</span>}
                  {d.riderNotes?.some((n) => n.kind === 'ferry') && <span className="note-ic" title="Ferry crossing"> ⛴️</span>}
                  {d.riderNotes?.some((n) => n.kind === 'detour') && <span className="note-ic" title="Detour on this stretch"> 🚧</span>}
                </span>
                {d.flags.length > 0 && <span className="flag" title={d.flags.join(', ')}>⚠</span>}
                <span className="day-mi">
                  {d.actual
                    ? <><b>{d.actual.miles}</b><span className="dim">/{d.miles}</span></>
                    : <>{d.miles}</>} mi
                </span>
              </div>

              {sel && (
                <div className="day-detail">
                  <div>{d.startName} (mi {d.startMile}) → {d.endName} (mi {d.endMile})</div>
                  <div className="dim">status: {STATUS_LABEL[d.status] ?? d.status}
                    {d.flags.length > 0 && <> · flags: {d.flags.join(', ')}</>}
                  </div>
                  {d.elevGainFt != null && (
                    <div className="elev-line">
                      ↑ {d.elevGainFt.toLocaleString()} ft · ↓ {(d.elevLossFt ?? 0).toLocaleString()} ft climbing
                    </div>
                  )}
                  {profiles[d.dayNumber] && <ElevProfile data={profiles[d.dayNumber]!} />}
                  {wx[d.dayNumber] && !wx[d.dayNumber].error && (
                    <div className="wx-line">
                      {wx[d.dayNumber].date}: {wx[d.dayNumber].tempF}° · {wx[d.dayNumber].shortForecast}
                      {wx[d.dayNumber].precipPct != null && <> · {wx[d.dayNumber].precipPct}% rain</>}
                      {wx[d.dayNumber].windSpeed && (
                        <> · wind {wx[d.dayNumber].windSpeed} {wx[d.dayNumber].windDirection}
                          {wx[d.dayNumber].windClass && (
                            <b className={`wind-${wx[d.dayNumber].windClass}`}> ({wx[d.dayNumber].windClass})</b>
                          )}
                        </>
                      )}
                      <span className="dim"> — NWS</span>
                    </div>
                  )}
                  {d.overnight && (
                    <DestinationCard o={d.overnight}
                      endName={[d.endName, d.endState].filter(Boolean).join(', ')} />
                  )}
                  {sel && <Itinerary dayNumber={d.dayNumber} />}

                  {d.actual && (
                    <div className="actual-line">
                      Rode <b>{d.actual.miles} mi</b> to {d.actual.endName} (mi {d.actual.endMile})
                      {d.actual.notes && <span className="dim"> — {d.actual.notes}</span>}
                    </div>
                  )}
                  {d.riderNotes?.length > 0 && (
                    <div className="day-notes">
                      <div className="notes-head">What to expect</div>
                      {d.riderNotes.map((n) => (
                        <div key={n.id} className="note-item">
                          <span className="note-kind-ic">{NOTE_ICON[n.kind] ?? '•'}</span>
                          <div className="note-body">
                            <b>{n.title}</b>
                            <span className="dim"> · mi {n.startMile}{n.endMile > n.startMile + 0.5 ? `–${n.endMile}` : ''}</span>
                            <div className="note-detail">{n.detail}</div>
                            {n.source && <div className="note-src dim">{n.source}{n.confidence !== 'high' ? ` · ${n.confidence} confidence` : ''}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="res-badges">
                    {Object.entries(d.resourceCounts).map(([cat, n]) => (
                      <span key={cat} className={`res-badge rb-${cat}`}>{n} {cat.replace('_', '/')}</span>
                    ))}
                  </div>

                  {!d.actual && (() => {
                    const nextDay = days.find((x) => x.dayNumber === d.dayNumber + 1);
                    const canMerge = nextDay && !nextDay.actual;
                    return (
                      <>
                        <div className="day-actions">
                          <button className="ghost" disabled={busy !== null}
                            onClick={() => loadSuggestions(d, 'move')}>
                            Suggest endpoints
                          </button>
                          <button className="ghost" disabled={busy !== null}
                            onClick={() => loadSuggestions(d, 'split')}>
                            Split into 2 days
                          </button>
                          <button className="ghost" disabled={busy !== null}
                            onClick={() => lockDay(d)}>
                            {busy === 'lock' ? '…' : '✓ Mark done'}
                          </button>
                        </div>

                        <div className="adjust">
                          <div className="adjust-title">
                            Trade miles with day {d.dayNumber + (nextDay ? 1 : 0)}
                          </div>
                          <div className="nudge-row">
                            {[-10, -5, -1].map((n) => (
                              <button key={n} className="nudge" disabled={busy !== null}
                                onClick={() => moveBoundary(d, d.endMile + n)}>{n}</button>
                            ))}
                            <input className="nudge-in" type="number" placeholder={`${d.endMile}`}
                              value={endDraft} onChange={(e) => setEndDraft(e.target.value)} />
                            <button className="nudge" disabled={busy !== null || !endDraft}
                              onClick={() => moveBoundary(d, Number(endDraft))}>Set</button>
                            {[1, 5, 10].map((n) => (
                              <button key={n} className="nudge" disabled={busy !== null}
                                onClick={() => moveBoundary(d, d.endMile + n)}>+{n}</button>
                            ))}
                          </div>
                          <div className="dim adjust-hint">
                            {nextDay
                              ? <>Now D{d.dayNumber} {d.miles} mi · D{nextDay.dayNumber} {nextDay.miles} mi.
                                  Moving this endpoint shaves miles off one and adds them to the other.</>
                              : <>Moving this endpoint changes the final day's length.</>}
                          </div>
                          {canMerge && (
                            <button className="ghost merge-btn" disabled={busy !== null}
                              onClick={() => mergeWithNext(d)}>
                              {busy === 'merge' ? 'Merging…'
                                : `Merge with day ${nextDay!.dayNumber} → ${Math.round((d.miles + nextDay!.miles) * 10) / 10} mi`}
                            </button>
                          )}
                        </div>
                      </>
                    );
                  })()}

                  {d.actual && (
                    <div className="day-actions">
                      <button className="ghost" disabled={busy !== null}
                        onClick={() => unlockDay(d)}>
                        {busy === 'lock' ? '…' : '↩ Unlock this day'}
                      </button>
                    </div>
                  )}

                  {suggestions && (
                    <ul className="suggestions">
                      {suggestions.length === 0 && (
                        <li className="dim">No overnight anchors in that window — resources may
                          not be ingested here yet, or it's a genuinely empty stretch.</li>
                      )}
                      {suggestions.map((s) => {
                        const open = openSug === s.resourceId;
                        const addr = fullAddress({ name: s.name, address: s.address, town: s.town, state: s.state });
                        return (
                          <li key={s.resourceId} className={open ? 'sug open' : 'sug'}>
                            <div className="sug-row"
                              onClick={() => setOpenSug(open ? null : s.resourceId)}
                              title={`score ${s.score} · ${s.wifiNear} wifi/work stops within 2 mi`}>
                              <span className="sug-name">
                                {OVERNIGHT_ICON[s.category]} {s.name}
                                <span className="dim"> {s.town.startsWith('Mile ') ? '' : `· ${s.town}`}</span>
                              </span>
                              <span className="sug-mi">
                                {suggestMode === 'split' ? `mi ${s.routeMile}` : `${s.dayMiles} mi`}
                                <span className="dim"> · {s.offRouteMi} off</span>
                              </span>
                              <span className="sug-caret">{open ? '▾' : '▸'}</span>
                            </div>
                            {open && (
                              <div className="sug-detail">
                                {addr && <div className="dest-addr">{addr}</div>}
                                <div className="dim">
                                  {s.climbFt != null && <>↑ {s.climbFt.toLocaleString()} ft · </>}
                                  {s.effortMiles} effort mi
                                  {s.wifiNear > 0 && <> · {s.wifiNear} wifi/work stop{s.wifiNear === 1 ? '' : 's'} within 2 mi</>}
                                </div>
                                {s.hours && <div className="dim">Hours: {s.hours}</div>}
                                <div className="dest-actions">
                                  <a className="act" target="_blank" rel="noreferrer"
                                    href={`https://maps.apple.com/?daddr=${s.lat},${s.lng}`}> Maps</a>
                                  <a className="act" target="_blank" rel="noreferrer"
                                    href={`https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=bicycling`}>🚲 Google</a>
                                  <a className="act" target="_blank" rel="noreferrer"
                                    href={`https://www.google.com/search?q=${encodeURIComponent([s.name, addr].filter(Boolean).join(' '))}`}>🔎 Search</a>
                                  {s.website && <a className="act" target="_blank" rel="noreferrer" href={s.website}>🌐 Site</a>}
                                  {s.phone && <a className="act" href={`tel:${s.phone}`}>📞 {s.phone}</a>}
                                </div>
                                <button className="sug-pick" disabled={busy !== null}
                                  onClick={() => applySuggestion(d, s)}>
                                  {busy === 'apply' ? 'Setting…' : `Set as day ${d.dayNumber} ${suggestMode === 'split' ? 'split point' : 'destination'}`}
                                </button>
                                {!s.website && !s.phone && !s.address && (
                                  <div className="dim sug-thin">
                                    OSM has little detail on this one — the search link is your best check.
                                  </div>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {isNext && (
                    <div className="record">
                      <div className="record-title">Record where day {d.dayNumber} actually ended</div>
                      <div className="record-row">
                        <input type="number" placeholder={`mile (planned ${d.endMile})`}
                          value={actualMile} onChange={(e) => setActualMile(e.target.value)} />
                        <button disabled={busy !== null} onClick={() => recordActual(d)}>
                          {busy === 'record' ? 'Saving…' : 'Save & reshuffle'}
                        </button>
                      </div>
                      <input className="record-notes" placeholder="notes (optional)"
                        value={actualNotes} onChange={(e) => setActualNotes(e.target.value)} />
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <details className="rebuild">
        <summary>Rebuild plan from scratch</summary>
        <p className="dim-note">
          Replaces the active plan with a fresh auto-build (old revisions are kept
          in history, but day edits and statuses move on).
        </p>
        <div className="build-row">
          <label>Max mi/day
            <input type="number" min={20} max={140} value={maxMiles}
              onChange={(e) => setMaxMiles(Number(e.target.value))} />
          </label>
          <button disabled={busy !== null} onClick={buildPlan}>
            {busy === 'build' ? 'Building…' : 'Rebuild'}
          </button>
        </div>
        {plan.history && plan.history.length > 1 && (
          <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
            {plan.history.length} revisions kept: {plan.history.slice(0, 4)
              .map((h) => `#${h.id} ${h.reason}`).join(' · ')}
          </div>
        )}
      </details>
    </div>
  );
}
