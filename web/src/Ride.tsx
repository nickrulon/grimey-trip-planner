import { useEffect, useRef, useState } from 'react';
import { ResourceInfo } from './Detail';
import { PositionInfo } from './types';
import { fullAddress, appleMapsUrl, googleMapsUrl } from './format';

// RIDE — the roadside dashboard. Not the planning app shrunk onto a phone:
// current mile, on/off route, next thing that matters, tonight's bed, active
// warnings, and a navigate handoff. Big targets, high contrast, minimal prose.
// Position is computed from cached route data (deployed build), so it works
// with no signal — that is the whole point in west Texas.

const CAT_ICON: Record<string, string> = { wifi_work: '☕', campground: '⛺', hotel: '🏨' };
const NOTE_ICON: Record<string, string> = {
  ferry: '⛴', detour: '⚠', highway: '▲', no_services: '∅',
  climb: '⛰', bridge: '≈', traffic: '▲', trail: '↟', caution: '!',
};

export default function Ride({ info, onInfo, armMapPick, selectResource, selectedResource, closeResource, follow, setFollow, exit }: {
  info: PositionInfo | null;
  onInfo: (i: PositionInfo | null) => void;
  armMapPick: () => Promise<[number, number]>;
  selectResource: (r: ResourceInfo) => void;
  selectedResource: ResourceInfo | null;
  closeResource: () => void;
  follow: boolean;
  setFollow: (f: boolean) => void;
  exit: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [gpsOn, setGpsOn] = useState(false);
  const [mileInput, setMileInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const watchId = useRef<number | null>(null);

  async function query(params: string) {
    setErr(null);
    try {
      const res = await fetch(`/api/position?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      onInfo(data);
    } catch (e) { setErr(String((e as Error).message ?? e)); }
  }

  function stopGps() {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setGpsOn(false);
  }
  function startGps() {
    if (!('geolocation' in navigator)) { setErr('No geolocation on this device.'); return; }
    stopGps();
    setGpsOn(true);
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => query(`lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`),
      (e) => { setErr(`GPS: ${e.message} (HTTPS or localhost required)`); stopGps(); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
    );
  }
  useEffect(() => () => stopGps(), []);

  const activeNotes = (info?.notesAhead ?? []).filter((n) => n.active);
  const nextNote = (info?.notesAhead ?? []).find((n) => !n.active) ?? null;
  const nextWater = (info?.upcoming ?? []).find((u) => u.category === 'wifi_work' || u.category === 'campground');
  const nextUp = (info?.upcoming ?? [])[0] ?? null;

  return (
    <div className="ride">
      <div className="ride-top">
        <button className="ride-exit" onClick={() => { stopGps(); exit(); }}>✕ EXIT RIDE</button>
        <label className="follow-toggle">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
      </div>

      {selectedResource && (
        <div className="ride-detail-wrap">
          <RideDetail r={selectedResource} onClose={closeResource} />
        </div>
      )}

      <div className={`ride-hud${expanded ? ' expanded' : ''}`}>
        {err && <div className="error">{err}</div>}

        {!info && (
          <div className="ride-setpos">
            <div className="hand" style={{ fontSize: 18 }}>where are you, clown?</div>
            <div className="ride-btns">
              <button className="ride-big-btn" onClick={gpsOn ? stopGps : startGps}>
                {gpsOn ? '◉ GPS ON' : 'USE GPS'}
              </button>
              <button className="ride-big-btn" onClick={async () => {
                stopGps();
                const [lng, lat] = await armMapPick();
                query(`lat=${lat}&lng=${lng}`);
              }}>TAP MAP</button>
            </div>
            <div className="mile-set">
              <input type="number" placeholder="route mile" inputMode="decimal" value={mileInput}
                onChange={(e) => setMileInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && mileInput && (stopGps(), query(`mile=${mileInput}`))} />
              <button onClick={() => mileInput && (stopGps(), query(`mile=${mileInput}`))}>GO</button>
            </div>
          </div>
        )}

        {info && (<>
          <div className="ride-mile-row" onClick={() => setExpanded(!expanded)}>
            <div className="ride-mile">
              <span className="ride-mi-label">MI</span>
              <span className="ride-mi-big">{info.mile}</span>
            </div>
            <div className="ride-state">
              {info.offRouteMi > 0.5
                ? <span className="off-route">⚠ {info.offRouteMi} MI OFF ROUTE</span>
                : <span className="on-route">ON ROUTE</span>}
              <span className="ride-near">{info.nearPlace}</span>
            </div>
            <div className="ride-src">
              <button className={`ride-mini ${gpsOn ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); gpsOn ? stopGps() : startGps(); }}>
                {gpsOn ? 'GPS◉' : 'GPS'}
              </button>
            </div>
          </div>

          {activeNotes.map((n) => (
            <div key={n.id} className="ride-warning active">
              {NOTE_ICON[n.kind] ?? '!'} <b>{n.title}</b>
              <span className="dim"> now · to mi {n.endMile}</span>
            </div>
          ))}
          {(info.intelAhead ?? []).slice(0, 3).map((r) => (
            <div key={r.id} className={`ride-warning intel${r.active ? ' active' : ''}`}>
              <b>{r.severity ?? '·'}</b> {r.summary?.slice(0, 90)}
              <span className="dim">{r.active ? ' now' : ` in ${r.milesAhead} mi`} · rider report</span>
            </div>
          ))}
          {nextNote && (
            <div className="ride-warning">
              {NOTE_ICON[nextNote.kind] ?? '!'} <b>{nextNote.title}</b>
              <span className="dim"> in {nextNote.milesAhead} mi</span>
            </div>
          )}

          <div className="ride-facts">
            <div className="ride-fact">
              <span className="rf-k">NEXT</span>
              {nextUp ? (
                <button className="rf-v linkish" onClick={() => selectResource(nextUp as ResourceInfo)}>
                  {CAT_ICON[nextUp.category] ?? '·'} {nextUp.name} · {nextUp.milesAhead} mi
                </button>
              ) : <span className="rf-v dim">nothing for 45 mi</span>}
            </div>
            <div className="ride-fact">
              <span className="rf-k">TONIGHT</span>
              {info.day ? (
                <span className="rf-v">
                  {info.day.overnightName ?? info.day.endName} · <b>{info.day.milesToEnd} mi</b>
                </span>
              ) : <span className="rf-v dim">no planned day covers this point</span>}
            </div>
          </div>

          {expanded && (
            <div className="ride-list">
              {(info.upcoming ?? []).slice(0, 14).map((u) => (
                <button key={u.id} className="ride-row" onClick={() => selectResource(u as ResourceInfo)}>
                  <span className="up-ic">{CAT_ICON[u.category] ?? '·'}</span>
                  <span className="up-name">{u.name}
                    {u.wifiStatus && ['confirmed', 'likely'].includes(u.wifiStatus) && <span className="up-wifi"> ᯤ</span>}
                  </span>
                  <span className="up-mi"><b>{u.milesAhead}</b> mi</span>
                </button>
              ))}
            </div>
          )}

          <div className="ride-actions">
            {info.day && nextWater && (
              <a className="ride-nav-btn" target="_blank" rel="noreferrer"
                href={`https://www.google.com/maps/dir/?api=1&destination=${nextWater.lat},${nextWater.lng}&travelmode=bicycling`}>
                NAVIGATE → {nextWater.name.length > 18 ? nextWater.name.slice(0, 18) + '…' : nextWater.name}
              </a>
            )}
            <button className="ride-more" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'LESS' : `AHEAD (${info.upcoming?.length ?? 0})`}
            </button>
          </div>
        </>)}
      </div>
    </div>
  );
}

function RideDetail({ r, onClose }: { r: ResourceInfo; onClose: () => void }) {
  return (
    <div className="ride-detail">
      <div className="rd-head">
        <b>{r.name}</b>
        <button className="sheet-x" onClick={onClose}>✕</button>
      </div>
      <div className="dim">mi {r.routeMile}{r.milesAhead != null && <> · <b>{r.milesAhead} mi ahead</b></>}
        {r.offRouteMi != null && r.offRouteMi > 0.1 && <> · {r.offRouteMi} off route</>}</div>
      {fullAddress(r) && <div className="addr-line">{fullAddress(r)}</div>}
      <div className="dest-actions">
        <a className="act" target="_blank" rel="noreferrer" href={googleMapsUrl(r.lat, r.lng)}>🚲 Navigate</a>
        <a className="act" target="_blank" rel="noreferrer" href={appleMapsUrl(r.lat, r.lng, r)}>Apple Maps</a>
        {r.phone && <a className="act" href={`tel:${r.phone}`}>Call</a>}
      </div>
    </div>
  );
}
