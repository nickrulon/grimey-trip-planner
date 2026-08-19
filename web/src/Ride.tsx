import { useEffect, useRef, useState } from 'react';
import { ResourceInfo } from './Detail';

// Ride Mode (brief §26): keep the rider on their line. GPS (or a manual
// position) is projected to a route mile; the panel answers "where am I,
// how far to tonight's stop, what's ahead" — the things Apple Maps can't
// know because it has never heard of this route.

export interface RideNote {
  id: number; kind: string; title: string; detail: string;
  startMile: number; endMile: number; milesAhead: number;
  active: boolean; source: string | null;
}

export interface PositionInfo {
  mile: number; offRouteMi: number; lat: number; lng: number;
  nearPlace: string; totalMiles: number;
  notesAhead: RideNote[];
  day: {
    dayNumber: number; endName: string; endMile: number;
    milesToEnd: number; overnightName: string | null;
  } | null;
  upcoming: (ResourceInfo & { milesAhead: number })[];
}

const CAT_ICON: Record<string, string> = {
  wifi_work: '☕', campground: '⛺', hotel: '🏨',
};

const NOTE_ICON: Record<string, string> = {
  ferry: '⛴️', detour: '🚧', highway: '🛣️', no_services: '🏜️',
  climb: '⛰️', bridge: '🌉', traffic: '🚗', trail: '🌿', caution: '⚠️',
};

export default function RidePanel({ info, onInfo, armMapPick, selectResource, follow, setFollow }: {
  info: PositionInfo | null;
  onInfo: (i: PositionInfo | null) => void;
  armMapPick: () => Promise<[number, number]>;
  selectResource: (r: ResourceInfo) => void;
  follow: boolean;
  setFollow: (f: boolean) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [gpsOn, setGpsOn] = useState(false);
  const [mileInput, setMileInput] = useState('');
  const [catFilter, setCatFilter] = useState<string>('all');
  const watchId = useRef<number | null>(null);

  async function query(params: string) {
    setErr(null);
    try {
      const res = await fetch(`/api/position?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onInfo(data);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  function stopGps() {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setGpsOn(false);
  }

  function startGps() {
    if (!('geolocation' in navigator)) { setErr('No geolocation on this device/browser.'); return; }
    stopGps();
    setGpsOn(true);
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => query(`lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`),
      (e) => { setErr(`GPS: ${e.message} (HTTPS or localhost required)`); stopGps(); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }

  useEffect(() => () => stopGps(), []);

  const pickOnMap = async () => {
    stopGps();
    const [lng, lat] = await armMapPick();
    query(`lat=${lat}&lng=${lng}`);
  };

  const setMile = () => {
    const m = Number(mileInput);
    if (!Number.isFinite(m)) { setErr('Enter a route mile'); return; }
    stopGps();
    query(`mile=${m}`);
  };

  const upcoming = (info?.upcoming ?? []).filter(
    (u) => catFilter === 'all' || u.category === catFilter
  );

  return (
    <div>
      <div className="ride-controls">
        <button className={gpsOn ? 'on' : 'ghost'} onClick={gpsOn ? stopGps : startGps}>
          {gpsOn ? '◉ GPS on' : 'Use GPS'}
        </button>
        <button className="ghost" onClick={pickOnMap}>Set on map</button>
        <div className="mile-set">
          <input type="number" placeholder="mile" value={mileInput}
            onChange={(e) => setMileInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setMile()} />
          <button className="ghost" onClick={setMile}>Go</button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}

      {!info && !err && (
        <p className="dim-note">
          Turn on GPS, tap a point on the map, or enter a route mile. Ride Mode
          shows your route mile, tonight's target, and everything ahead of you —
          then hands off to Apple/Google Maps for turn-by-turn to any stop.
        </p>
      )}

      {info && (
        <>
          <div className="hud">
            <div className="hud-mile">
              <span className="hud-big">mi {info.mile}</span>
              <span className="dim"> of {Math.round(info.totalMiles).toLocaleString()} · near {info.nearPlace}</span>
            </div>
            {info.offRouteMi != null && info.offRouteMi > 0.5 && (
              <div className="offroute">⚠ {info.offRouteMi} mi off route</div>
            )}
            {info.day ? (
              <div className="hud-day">
                <b>Day {info.day.dayNumber}</b> → {info.day.endName}
                {info.day.overnightName && <span className="dim"> ({info.day.overnightName})</span>}
                <div className="hud-togo">{info.day.milesToEnd} mi to go</div>
              </div>
            ) : (
              <div className="dim">No planned day covers this point.</div>
            )}
            <label className="follow-toggle">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              Follow me on the map
            </label>
          </div>

          {info.notesAhead?.length > 0 && (
            <div className="ride-notes">
              {info.notesAhead.map((n) => (
                <details key={n.id} className={`ride-note${n.active ? ' active' : ''}`}>
                  <summary>
                    <span className="note-kind-ic">{NOTE_ICON[n.kind] ?? '•'}</span>
                    <span className="rn-title">{n.title}</span>
                    <span className="rn-when">{n.active ? 'now' : `${n.milesAhead} mi`}</span>
                  </summary>
                  <div className="note-detail">{n.detail}</div>
                </details>
              ))}
            </div>
          )}

          <h2>Ahead of you (next 45 mi)</h2>
          <div className="ride-filter">
            {['all', 'wifi_work', 'campground', 'hotel'].map((c) => (
              <button key={c} className={catFilter === c ? 'on' : 'ghost'}
                onClick={() => setCatFilter(c)}>
                {c === 'all' ? 'All' : CAT_ICON[c]}
              </button>
            ))}
          </div>
          <ul className="upcoming">
            {upcoming.length === 0 && <li className="dim">Nothing in this category for 45 miles — plan accordingly.</li>}
            {upcoming.map((u) => (
              <li key={u.id} onClick={() => selectResource(u)}>
                <span className="up-ic">{CAT_ICON[u.category] ?? '·'}</span>
                <span className="up-name">
                  {u.name}
                  {u.wifiStatus && ['confirmed', 'likely'].includes(u.wifiStatus) && (
                    <span className="up-wifi"> ᯤ</span>
                  )}
                </span>
                <span className="up-mi">
                  in <b>{u.milesAhead}</b> mi
                  {u.offRouteMi != null && u.offRouteMi > 0.15 && (
                    <span className="dim"> · {u.offRouteMi} off</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
