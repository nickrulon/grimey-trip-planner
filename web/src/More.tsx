import { useEffect, useState } from 'react';
import { apiGet, apiPost } from './api';
import { PlanResponse, IntelRecord } from './types';
import type { CampingResponse } from './App';

// MORE — the reference shelf: route provenance, camping rules, settings,
// revision history (with append-only rollback), and the one-time import from
// the retired day-plan document. None of this competes with Today/Trip/Map.

interface SegmentProps {
  id: string; name: string; startMile: number; endMile: number;
  provenance: string; continuation: number; confidence: string;
  source: string; sourceUrl: string | null; notes: string | null;
}

const PROV_LABEL: Record<string, string> = {
  'official-public': 'Official geometry',
  'osm-proposed': 'USBR 90 (proposed)',
  reconstructed: 'Reconstructed · journal-attested',
};

interface IntelSummary {
  ready: boolean; note?: string; generatedAt?: string;
  source?: {
    blog?: string | null; author?: string | null; year?: number | null;
    direction?: string; supported?: boolean;
    heatCalibration?: string | null; caveats?: string | null;
  } | null;
  counts?: { total: number; anchored: number; roadScoped?: number; regional: number; bySeverity: Record<string, number> };
  calibration?: {
    days: number;
    speedMph?: { n: number; median: number; slowest: number; fastest: number } | null;
    milesPerDay?: { n: number; median: number; longest: number } | null;
    climbFtPerDay?: { n: number; median: number; biggest: number } | null;
    headwindDays?: number; caveat?: string;
  } | null;
  mustVerify?: IntelRecord[];
}

interface Migration {
  present: boolean; applied?: boolean; note: string;
  costImports?: { dayNumber: number }[];
  lodgingDiffs?: { dayNumber: number; docLodging: { name: string }; planOvernight: string | null }[];
}

export default function More({ plan, camping, segments, refetchPlan }: {
  plan: PlanResponse | null;
  camping: CampingResponse | null;
  segments: SegmentProps[];
  refetchPlan: () => void;
}) {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openState, setOpenState] = useState<string | null>(null);
  const [migration, setMigration] = useState<Migration | null>(null);
  const [intel, setIntel] = useState<IntelSummary | null>(null);

  useEffect(() => {
    apiGet<Record<string, string>>('/api/settings').then(setSettings).catch(() => { /* blank */ });
    apiGet<Migration>('/api/migrate/dayplan').then(setMigration).catch(() => { /* absent */ });
    apiGet<IntelSummary>('/api/intel').then(setIntel).catch(() => { /* not built */ });
  }, []);

  const save = async (key: string, value: string) => {
    setBusy(true); setErr(null);
    try {
      await apiPost('/api/settings', { [key]: value });
      setSettings((s) => ({ ...s, [key]: value }));
      refetchPlan();
    } catch (e) { setErr(String((e as Error).message ?? e)); }
    setBusy(false);
  };

  const laws = camping?.laws;

  return (
    <div className="wrap more">
      <header className="more-head">
        <div className="stamp-box small">
          <span className="stamp-day">FIELD REFERENCE</span>
          <span className="stamp-date">RULES · SOURCES · SETTINGS</span>
        </div>
      </header>
      {err && <div className="error">{err}</div>}

      {/* ---- settings ---- */}
      <details className="ref-block" open>
        <summary>Rider settings</summary>
        <div className="ref-body settings-grid">
          <label>Riding speed (mph)
            <input type="number" step="0.5" min={5} max={20} defaultValue={settings.ridingSpeedMph ?? '11'}
              onBlur={(e) => save('ridingSpeedMph', e.target.value)} disabled={busy} />
          </label>
          <label>Work starts (ET)
            <input type="time" defaultValue={settings.workStartET ?? '09:00'}
              onBlur={(e) => save('workStartET', e.target.value)} disabled={busy} />
          </label>
          <label>Work ends (ET)
            <input type="time" defaultValue={settings.workEndET ?? '16:30'}
              onBlur={(e) => save('workEndET', e.target.value)} disabled={busy} />
          </label>
          <label>Weekend max mi
            <input type="number" min={20} max={140} defaultValue={settings.weekendMaxMiles ?? ''}
              onBlur={(e) => e.target.value && save('weekendMaxMiles', e.target.value)} disabled={busy} />
          </label>
          <div className="dim" style={{ gridColumn: '1/-1' }}>
            Work hours are anchored to Eastern time; every day converts them to that day's local
            clock (and DST) automatically. Depart/arrive dates and the daily cap live on the Trip page.
          </div>
        </div>
      </details>

      {/* ---- one-time day-plan import ---- */}
      {migration?.present && ((migration.costImports?.length ?? 0) > 0 || (migration.lodgingDiffs?.length ?? 0) > 0) && (
        <details className="ref-block" open>
          <summary>Import from the old Day-plan tab</summary>
          <div className="ref-body">
            <p className="dim">The old Day-plan document is retired — the trip plan is the single
              source of truth now. It still holds some edits that never made it across:</p>
            <div>{migration.note}</div>
            {(migration.lodgingDiffs?.length ?? 0) > 0 && (
              <ul className="diff-list">
                {migration.lodgingDiffs!.slice(0, 10).map((l) => (
                  <li key={l.dayNumber}>D{l.dayNumber}: doc says <b>{l.docLodging.name}</b>, plan says {l.planOvernight ?? '—'}</li>
                ))}
              </ul>
            )}
            <div className="proposal-actions">
              <button className="primary" disabled={busy} onClick={async () => {
                setBusy(true);
                try {
                  setMigration(await apiPost<Migration>('/api/migrate/dayplan', { includeLodging: false }));
                  refetchPlan();
                } catch (e) { setErr(String((e as Error).message ?? e)); }
                setBusy(false);
              }}>Import costs only</button>
              {(migration.lodgingDiffs?.length ?? 0) > 0 && (
                <button className="ghost" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    setMigration(await apiPost<Migration>('/api/migrate/dayplan', { includeLodging: true }));
                    refetchPlan();
                  } catch (e) { setErr(String((e as Error).message ?? e)); }
                  setBusy(false);
                }}>Import costs + lodging picks</button>
              )}
            </div>
            {migration.applied && <div className="ok-note">✓ Imported.</div>}
          </div>
        </details>
      )}

      {/* ---- revision history + rollback ---- */}
      <details className="ref-block">
        <summary>Plan history ({plan?.history?.length ?? 0} revisions — nothing is ever overwritten)</summary>
        <div className="ref-body">
          <ul className="rev-list">
            {(plan?.history ?? []).slice(0, 20).map((h) => (
              <li key={h.id} className={h.active ? 'active' : ''}>
                <span className="rev-id">#{h.id}</span>
                <span className="rev-reason">{h.reason}</span>
                <span className="dim">{h.day_count} days · {String(h.created_at).slice(0, 10)}</span>
                {h.active
                  ? <span className="rev-current">CURRENT</span>
                  : <button className="linkish" disabled={busy} onClick={async () => {
                      if (!confirm(`Restore revision #${h.id}? The current plan stays in history.`)) return;
                      setBusy(true);
                      try { await apiPost('/api/plan/revision/activate', { revisionId: h.id }); refetchPlan(); }
                      catch (e) { setErr(String((e as Error).message ?? e)); }
                      setBusy(false);
                    }}>restore</button>}
              </li>
            ))}
          </ul>
        </div>
      </details>

      {/* ---- camping rules & tips (the research reference, intact) ---- */}
      {laws && (
        <details className="ref-block">
          <summary>Camping rules &amp; tips — state by state</summary>
          <div className="ref-body">
            {laws.generalTips && laws.generalTips.length > 0 && (<>
              <div className="leg-kicker">CORRIDOR TIPS</div>
              <ul className="camp-tips">{laws.generalTips.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </>)}
            {laws.states && (<>
              <div className="leg-kicker">STATE BY STATE</div>
              {Object.entries(laws.states).map(([st, info]) => (
                <div key={st} className="camp-state">
                  <button className="camp-state-head" onClick={() => setOpenState(openState === st ? null : st)}>
                    <b>{st}</b><span>{openState === st ? '▾' : '▸'}</span>
                  </button>
                  {openState === st && (
                    <div className="camp-state-body">
                      {Object.entries(info).map(([k, v]) => v ? (
                        <div key={k}><b className="camp-law-k">{k.replace(/([A-Z])/g, ' $1').toLowerCase()}</b>: {v}</div>
                      ) : null)}
                    </div>
                  )}
                </div>
              ))}
            </>)}
            {laws.programs && (<>
              <div className="leg-kicker">PROGRAMS &amp; FALLBACKS</div>
              <div className="camp-state-body">
                {Object.entries(laws.programs).map(([k, v]) => v ? (
                  <div key={k}><b className="camp-law-k">{k}</b>: {v}</div>
                ) : null)}
              </div>
            </>)}
          </div>
        </details>
      )}

      {/* ---- mined rider intel: what it is and what it is NOT ---- */}
      {intel?.ready && (
        <details className="ref-block">
          <summary>Rider reports — {intel.counts?.anchored} placed on the route, {intel.counts?.regional} regional</summary>
          <div className="ref-body">
            <p className="dim">
              Mined from <b>{intel.source?.blog ?? 'a touring journal'}</b>
              {intel.source?.author ? ` by ${intel.source.author}` : ''} and joined to the route by mile.
              Built {intel.generatedAt}.
            </p>
            <div className="intel-caveats">
              <div><b>That rider went the other way.</b> The journal runs west→east; you ride
                east→west. Climbs there are descents here. Severity is already rated for
                <i> your</i> direction — it is never re-scored in this app.</div>
              <div><b>It was a supported ride</b> — chase vehicle and a cook. Terrain, shoulder,
                surface, traffic and wind carry over; anything about lodging, water or food is
                weaker evidence for you.</div>
              <div><b>The temperatures are a ceiling, not a baseline</b> — that spring was
                record-setting. Use the operational advice, not the numbers.</div>
              <div><b>{intel.counts?.regional} reports have no exact position.</b> They show as
                regional advice on days in the right state, never as "3 miles ahead".</div>
            </div>
            {(intel.mustVerify?.length ?? 0) > 0 && (
              <>
                <div className="leg-kicker">VERIFY BEFORE YOU GO</div>
                <ul className="camp-tips">
                  {intel.mustVerify!.map((r) => (
                    <li key={r.id}>
                      <b>{r.verifyTarget ?? r.summary}</b>
                      {r.verifyTarget && r.summary && <div className="dim">{r.summary}</div>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {intel.calibration?.speedMph && (
              <div className="calib">
                <div className="leg-kicker">MEASURED ON THESE ROADS</div>
                <div>
                  {intel.calibration.speedMph.n} GPS days: median <b>{intel.calibration.speedMph.median} mph</b>
                  {' '}(slowest {intel.calibration.speedMph.slowest}, fastest {intel.calibration.speedMph.fastest})
                  {intel.calibration.milesPerDay && <> · median day {intel.calibration.milesPerDay.median} mi</>}
                  {intel.calibration.climbFtPerDay && <> · median climb {intel.calibration.climbFtPerDay.median.toLocaleString()} ft</>}
                </div>
                <div className="dim">
                  Your speed setting is <b>{settings.ridingSpeedMph ?? '11'} mph</b>.
                  {' '}{intel.calibration.caveat}
                </div>
              </div>
            )}
            <div className="dim">
              Severity spread: {Object.entries(intel.counts?.bySeverity ?? {})
                .sort((a, b) => Number(b[0]) - Number(a[0]))
                .map(([k, v]) => `${v}×sev${k}`).join(' · ')}
            </div>
          </div>
        </details>
      )}

      {/* ---- route provenance (the disclosure layer, intact) ---- */}
      <details className="ref-block">
        <summary>Route provenance — what's verified, what's inferred</summary>
        <div className="ref-body">
          <ul className="segments">
            {segments.map((s) => (
              <li key={s.id}>
                <span className={`swatch ${s.continuation || s.provenance === 'reconstructed' ? 'dashed' : ''} prov-${s.provenance}`} />
                <span className="seg-name">{s.name}</span>
                <span className="seg-prov dim">{s.continuation ? 'SD→LA continuation' : PROV_LABEL[s.provenance] ?? s.provenance} · {s.confidence}</span>
                <span className="seg-miles">{Math.round(s.endMile - s.startMile)} mi</span>
              </li>
            ))}
          </ul>
          <p className="note">
            <b>This follows the current ACA Southern Tier corridor (2021+ editions), reconstructed
            from public sources.</b> Solid lines are OSM USBR 90 geometry used only where it is
            verified concurrent with the Southern Tier. Dashed lines are bicycle-routed between
            towns attested by ACA's public pages and 2007–2026 ride journals — right corridor and
            towns, approximate streets, never claimed as official ACA geometry. Includes ACA's
            official Pearl River bridge detour (US 90 bridge closed since 2022). Tap any segment
            on the map for its sources. Dashes mean: <i>trust the towns, verify the streets.</i>
          </p>
        </div>
      </details>

      <div className="more-foot hand">ride far · work · eat trash · be happy</div>
    </div>
  );
}
