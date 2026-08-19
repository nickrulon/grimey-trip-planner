import { useCallback, useEffect, useState } from 'react';

// Intra-day itinerary: leave at 6, ride to a coffee shop, work till noon, ride
// on. Stops are ordered by route mile rather than by hand — you cannot reach
// mile 250 before mile 224, so there is nothing to drag and nothing to reorder.

interface Stop {
  id: number; name: string; category: string | null; resourceId: string | null;
  routeMile: number; offRouteMi: number | null;
  rideMiles: number; rideMinutes: number;
  arriveTime: string; departTime: string; dwellMin: number; notes: string | null;
}
interface ItineraryData {
  dayNumber: number; startTime: string; speedMph: number;
  startMile: number; endMile: number; endName: string; overnightName: string | null;
  items: Stop[];
  finish: { rideMiles: number; rideMinutes: number; arriveTime: string; pastMidnight: boolean };
  totalRideMinutes: number; totalDwellMinutes: number;
}
interface Candidate {
  resourceId: string; name: string; category: string;
  routeMile: number; offRouteMi: number; rideMiles: number; rideMinutes: number;
  wifiStatus: string | null; address: string | null;
}

const CAT_ICON: Record<string, string> = {
  wifi_work: '☕', campground: '⛺', hotel: '🏨',
};

// 08:22 → 8:22a — short enough for a phone row.
function fmt(t: string): string {
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'p' : 'a';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, '0')}${ampm}`;
}
function dur(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}h${m ? String(m).padStart(2, '0') : ''}` : `${m}m`;
}

async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export default function Itinerary({ dayNumber }: { dayNumber: number }) {
  const [it, setIt] = useState<ItineraryData | null>(null);
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [cat, setCat] = useState('wifi_work');
  const [hours, setHours] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setIt(await api<ItineraryData>(`/api/plan/day/${dayNumber}/itinerary`)); }
    catch (e) { setErr(String((e as Error).message)); }
  }, [dayNumber]);

  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); }
    catch (e) { setErr(String((e as Error).message)); }
    finally { setBusy(false); }
  };

  const openPicker = async () => {
    setErr(null);
    const from = it?.items.length ? it.items[it.items.length - 1].routeMile : it?.startMile;
    try {
      const r = await api<{ candidates: Candidate[] }>(
        `/api/plan/day/${dayNumber}/stop-candidates?fromMile=${from}&cats=${cat === 'all' ? '' : cat}`
      );
      setCands(r.candidates);
    } catch (e) { setErr(String((e as Error).message)); }
  };

  useEffect(() => { if (cands) openPicker(); /* refilter on category change */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat]);

  if (!it) return <div className="dim itin-loading">Loading itinerary…</div>;

  const shown = (cands ?? []).filter((c) =>
    hours == null || Math.abs(c.rideMinutes - hours * 60) <= 45
  );

  return (
    <div className="itin">
      <div className="itin-head">
        <span className="itin-title">Plan this day</span>
        <label className="itin-start">
          leave
          <input type="time" value={it.startTime} disabled={busy}
            onChange={(e) => act(() => api('/api/plan/day/start-time', {
              dayNumber, startTime: e.target.value,
            }))} />
        </label>
      </div>

      <div className="tl">
        <div className="tl-row">
          <span className="tl-time">{fmt(it.startTime)}</span>
          <span className="tl-ic">🏁</span>
          <span className="tl-body dim">Depart</span>
        </div>

        {it.items.map((s) => (
          <div key={s.id}>
            <div className="tl-row leg">
              <span className="tl-time" />
              <span className="tl-ic">🚴</span>
              <span className="tl-body dim">{dur(s.rideMinutes)} · {s.rideMiles} mi</span>
            </div>
            <div className="tl-row stop">
              <span className="tl-time">{fmt(s.arriveTime)}</span>
              <span className="tl-ic">{CAT_ICON[s.category ?? ''] ?? '📍'}</span>
              <span className="tl-body">
                <span className="tl-name">{s.name}</span>
                <span className="dim tl-meta">
                  mi {s.routeMile}{s.offRouteMi ? ` · ${s.offRouteMi} off` : ''}
                </span>
                <span className="tl-leave">
                  leave
                  <input type="time" value={s.departTime} disabled={busy}
                    onChange={(e) => act(() => api('/api/plan/stop/update', {
                      id: s.id, departTime: e.target.value, dayNumber,
                    }))} />
                  <span className="dim">({dur(s.dwellMin)})</span>
                </span>
              </span>
              <button className="tl-x" disabled={busy} aria-label="Remove stop"
                onClick={() => act(() => api('/api/plan/stop/remove', { id: s.id }))}>×</button>
            </div>
          </div>
        ))}

        <div className="tl-row leg">
          <span className="tl-time" />
          <span className="tl-ic">🚴</span>
          <span className="tl-body dim">{dur(it.finish.rideMinutes)} · {it.finish.rideMiles} mi</span>
        </div>
        <div className={`tl-row arrive${it.finish.pastMidnight ? ' late' : ''}`}>
          <span className="tl-time">{fmt(it.finish.arriveTime)}</span>
          <span className="tl-ic">🛏️</span>
          <span className="tl-body">
            <span className="tl-name">{it.overnightName ?? it.endName}</span>
            <span className="dim tl-meta">
              {it.finish.pastMidnight ? 'next day — too much to fit' : it.endName}
            </span>
          </span>
        </div>
      </div>

      <div className="itin-sum dim">
        {dur(it.totalRideMinutes)} riding · {dur(it.totalDwellMinutes)} stopped
        <span className="dim"> · {it.speedMph} mph incl. climbing</span>
      </div>

      {err && <div className="error">{err}</div>}

      {!cands && (
        <button className="itin-add" disabled={busy} onClick={openPicker}>+ Add a stop</button>
      )}

      {cands && (
        <div className="picker">
          <div className="picker-head">
            <span>Add a stop</span>
            <button className="tl-x" onClick={() => { setCands(null); setHours(null); }}>×</button>
          </div>
          <div className="chips">
            {[['wifi_work', '☕ Work'], ['campground', '⛺ Camp'], ['hotel', '🏨 Hotel']].map(([v, l]) => (
              <button key={v} className={cat === v ? 'chip on' : 'chip'}
                onClick={() => setCat(v)}>{l}</button>
            ))}
          </div>
          <div className="chips">
            <span className="dim chips-label">ride</span>
            {[1, 2, 3, 4].map((h) => (
              <button key={h} className={hours === h ? 'chip on' : 'chip'}
                onClick={() => setHours(hours === h ? null : h)}>~{h}h</button>
            ))}
          </div>
          <ul className="cand-list">
            {shown.length === 0 && (
              <li className="dim">
                Nothing in that range on this stretch — try another category or ride window.
              </li>
            )}
            {shown.slice(0, 25).map((c) => (
              <li key={c.resourceId} onClick={() => act(async () => {
                await api('/api/plan/stop', {
                  routeMile: c.routeMile, resourceId: c.resourceId, name: c.name,
                  category: c.category, offRouteMi: c.offRouteMi, dwellMin: 30,
                });
                setCands(null); setHours(null);
              })}>
                <span className="cand-in">{dur(c.rideMinutes)}</span>
                <span className="cand-name">
                  {CAT_ICON[c.category] ?? '📍'} {c.name}
                  {c.wifiStatus && ['confirmed', 'likely'].includes(c.wifiStatus) && (
                    <span className="up-wifi"> ᯤ</span>
                  )}
                </span>
                <span className="dim cand-off">{c.offRouteMi} off</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
