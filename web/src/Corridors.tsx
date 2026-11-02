import { useState } from 'react';
import STUDY_JSON from './corridor-study.json';

// Casa Grande → the Elysian: the I-10 line Nick is leaning toward, the I-8 line
// the plan runs on, and a Salton Sea hybrid, each with every tent-legal camp
// the research found and the gaps between them. Built offline by
// scripts/build-corridor-lines.mjs + scripts/build-corridor-study.mjs and
// bundled, so it works without the API (and on a bad signal).

export interface StudyNight { id: string; name: string; mile: number; dayMiles: number; tier: string; off: number; fallbacks?: { name: string; dayMiles: number; tier: string }[] }
export interface StudyPlan { target: number; nights: StudyNight[]; lastDay: number; days: number; arrive: string }
export interface StudyGap { fromName: string; fromMile: number; toName: string; toMile: number; miles: number }
export interface StudyCorridor {
  id: string; label: string; name: string; miles: number; climbFt: number | null; highPointFt: number | null;
  color: string; summary: string;
  camps: { usable: number; full: number; tentsYes: number; maybe: number; checked: number };
  per100: number; gaps: StudyGap[]; gapsTentsKnown: StudyGap[]; longestGap: number; longestGapTentsKnown: number;
  over50: number; towns: { name: string; mile: number }[]; plans: StudyPlan[];
  legs: { from: string; to: string; miles: number; roads: string[]; costing: string }[];
}
interface LegalLeg { corridor: string; leg: string; bikeLegal: string; detail: string; shoulderAndTraffic: string; hazards: string; sources: string[] }
interface WeatherRow { date: string; place: string; corridor: string; windDir: string; windMph: string; gustMph: string; forWestbound: string; hiF: number; loF: number; note: string }
interface Report { title: string; url: string; year: string; route: string; campsUsed: string[]; warnings: string[]; summary: string }
export interface Study {
  generatedAt: string; origin: string; startDate: string; runs: string[];
  corridors: StudyCorridor[];
  lines: GeoJSON.FeatureCollection; gaps: GeoJSON.FeatureCollection; marks: GeoJSON.FeatureCollection;
  camps: GeoJSON.FeatureCollection; services: GeoJSON.FeatureCollection;
  legality: { legs: LegalLeg[]; summary: string } | null;
  weather: { issued: string; rows: WeatherRow[]; advisories: string; climatology: string; summary: string; sources: string[] } | null;
  intel: { summary: string; reports: Report[] } | null;
  dryStretches: { corridor: string; from: string; to: string; miles: number; note: string }[];
  verdict?: { headline: string; bullets: string[]; updated: string } | null;
}
export const STUDY = STUDY_JSON as unknown as Study;
// Route mile of downtown Casa Grande, where the I-10 retrace (2026-11-01) joins the old line.
const ROUTE_MILE_AT_CASA_GRANDE = 2142.12;
const BY_ID = Object.fromEntries(STUDY.corridors.map((c) => [c.id, c])) as Record<string, StudyCorridor>;

export type CorrKey = 'i10' | 'i8' | 'hyb';
export const CORR_ROWS: { key: CorrKey; id: string; short: string }[] = [
  { key: 'i10', id: 'i10', short: 'I-10 camps (your route)' },
  { key: 'i8', id: 'i8', short: 'I-8 line + camps' },
  { key: 'hyb', id: 'hybrid', short: 'Salton Sea hybrid' },
];
export const CORR_LINE_IDS: Record<CorrKey, string[]> = { i10: ['i10', 'i10-salome', 'i10-mecca'], i8: ['i8'], hyb: ['hybrid'] };
export const CORR_GAP_IDS: Record<CorrKey, string[]> = { i10: ['i10'], i8: ['i8'], hyb: ['hybrid'] };

export const TIER_FILL: Record<string, string> = { full: '#15803d', basic: '#86efac', maybe: '#fdf6d8' };
export const TIER_LABEL: Record<string, string> = {
  full: 'Tents OK · shower · water', basic: 'Tents OK', maybe: 'Tents not confirmed: call first', no: 'No tents / closed',
};
const KIND_LABEL: Record<string, string> = {
  rv_park: 'RV park', private_campground: 'Private campground', koa: 'KOA', state_park: 'State park',
  county_or_city_park: 'County / city park', national_park_or_forest: 'National park / forest', blm_campground: 'BLM campground',
  blm_dispersed: 'BLM dispersed (free, no services)', ltva: 'BLM long-term visitor area', hike_bike_site: 'Hike-and-bike site',
  hipcamp_private: 'Hipcamp (private land)', casino_or_business: 'Business / casino', church_or_community: 'Church / community', other: 'Other',
};
const LINE_NAME: Record<string, string> = { i10: 'I-10', 'i10-salome': 'Salome variant', 'i10-mecca': 'Box Canyon variant', i8: 'I-8', hybrid: 'Hybrid', 'i10-offinterstate': 'I-10 via variants' };

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
const yn = (v: unknown, label: string) => {
  const s = String(v ?? 'unknown');
  const cls = s === 'yes' || s === 'potable' || s === 'flush' ? 'yes' : s === 'no' || s === 'none' ? 'no' : 'unk';
  const txt = s === 'potable' ? 'yes' : s === 'non_potable' ? 'not drinkable' : s === 'vault_or_pit' ? 'vault' : s === 'unknown' ? '?' : s;
  return `<span class="${cls}">${label} ${esc(txt)}</span>`;
};
const parse = <T,>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return (v as T) ?? fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
};

/** Popup for a camp pin. `active` = which corridor toggles are on. */
export function corrCampPopup(p: Record<string, unknown>, active: Record<CorrKey, boolean>): string {
  const anchors = parse<Record<string, { mile: number; off: number }>>(p.anchors, {});
  const show: string[] = [];
  const want = [
    ...(active.i10 ? ['i10', 'i10-salome', 'i10-mecca'] : []), ...(active.i8 ? ['i8'] : []), ...(active.hyb ? ['hybrid'] : []),
  ];
  for (const id of want) {
    const a = anchors[id];
    if (!a || a.off > 10) continue;
    const from = id === 'i10-salome' ? ' from Tonopah' : id === 'i10-mecca' ? ' from Chiriaco Summit' : ' from Casa Grande';
    // the app's own route IS the I-10 line west of Casa Grande (mile 2142.1)
    const routeMi = id === 'i10' ? ` (route mi ${Math.round(ROUTE_MILE_AT_CASA_GRANDE + a.mile)})` : '';
    show.push(`<b>${LINE_NAME[id]}</b> mile ${Math.round(a.mile)}${from}${routeMi}${a.off >= 0.5 ? ` · ${a.off} mi off` : ''}`);
  }
  const sources = parse<string[]>(p.sources, []);
  const tier = String(p.tier ?? 'maybe');
  const verdict = String(p.verdict ?? 'unchecked');
  const vLabel = verdict === 'confirmed' ? 'Checked twice' : verdict === 'corrected' ? 'Checked and corrected' : verdict === 'map-only' ? 'Map data only, not researched' : verdict === 'unverifiable' ? 'Could not be confirmed' : 'Researched once';
  const phone = String(p.phone ?? '');
  const tel = phone.replace(/[^\d+]/g, '');
  const web = String(p.website ?? '');
  return `<div class="popup corr-pop"><div class="popup-title" style="border-color:${TIER_FILL[tier] ?? '#999'}">⛺ ${esc(p.name)}</div>` +
    `<div><b>${esc(TIER_LABEL[tier] ?? tier)}</b> · ${esc(KIND_LABEL[String(p.kind)] ?? p.kind)}</div>` +
    (show.length ? `<div class="corr-anchor">${show.join('<br>')}</div>` : '') +
    `<div class="corr-amen">${yn(p.tents, 'tents')}${yn(p.showers, 'shower')}${yn(p.water, 'water')}${yn(p.toilets, 'toilets')}${yn(p.power, 'power')}</div>` +
    (p.price ? `<div>${esc(p.price)}</div>` : '') +
    ((tel.length >= 7 || web.startsWith('http')) ? `<div>${tel.length >= 7 ? `<a href="tel:${esc(tel)}">${esc(phone)}</a>` : ''}${tel.length >= 7 && web.startsWith('http') ? ' · ' : ''}${web.startsWith('http') ? `<a href="${esc(web)}" target="_blank" rel="noopener">website</a>` : ''}</div>` : '') +
    (p.open && p.open !== 'yes' ? `<div class="warn">Open in November: ${esc(p.open === 'no' ? 'NO' : 'not confirmed')}</div>` : '') +
    (p.reservations ? `<div class="dim">${esc(p.reservations)}</div>` : '') +
    (p.access ? `<div class="dim">Getting there: ${esc(p.access)}</div>` : '') +
    (p.notes ? `<div class="dim">${esc(p.notes)}</div>` : '') +
    `<div class="dim">${esc(vLabel)} · confidence ${esc(p.confidence ?? '?')}${sources.length ? ' · ' + sources.map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">src ${i + 1}</a>`).join(' ') : ''}</div></div>`;
}

export function corrLinePopup(p: Record<string, unknown>): string {
  const id = String(p.id);
  const c = BY_ID[id === 'i10-salome' || id === 'i10-mecca' ? 'i10' : id];
  const legs = (c?.legs ?? []).filter((l) => l.costing !== 'route' && l.costing !== 'shared');
  const variant = id === 'i10-salome' || id === 'i10-mecca';
  return `<div class="alt-pop"><b>${esc(p.name)}</b>${p.miles ? ` · ${esc(p.miles)} mi` : ''}` +
    (variant ? '<p class="alt-taken">An off-interstate option inside the I-10 corridor.</p>' : '') +
    (c && !variant ? `<p>${esc(c.summary)}</p><ul>` +
      `<li>Casa Grande → the Elysian: <b>${c.miles} mi</b>, ${c.climbFt?.toLocaleString() ?? '?'} ft of climbing</li>` +
      `<li>${c.camps.usable} places to pitch a tent (${c.camps.full} with showers); longest gap <b>${c.longestGap} mi</b></li>` +
      `<li>At 85 mi a day: ${c.plans.find((x) => x.target === 85)?.days ?? '?'} riding days</li></ul>` : '') +
    (legs.length && !variant ? `<ul>${legs.slice(0, 18).map((l) => `<li>${esc(l.from)} → ${esc(l.to)} <b>${l.miles} mi</b> <span class="dim">${esc(l.costing)}</span></li>`).join('')}</ul>` : '') +
    '</div>';
}

export function corrGapPopup(p: Record<string, unknown>): string {
  return `<div class="alt-pop"><b>${esc(p.miles)} mi with no known tent spot</b><p>${esc(p.from)} → ${esc(p.to)} (${esc(LINE_NAME[String(p.corridor)] ?? p.corridor)})</p>` +
    `<p class="dim">Carry water and plan to make the far end, or use the fallback in the compare sheet.</p></div>`;
}

export function corrServicePopup(p: Record<string, unknown>): string {
  const bits = [p.water ? 'water' : '', p.food ? 'food' : ''].filter(Boolean).join(' + ');
  return `<div class="alt-pop"><b>${esc(p.name)}</b><p>${esc(bits || p.kind)}${p.hours ? ` · ${esc(p.hours)}` : ''}</p>${p.note ? `<p class="dim">${esc(p.note)}</p>` : ''}</div>`;
}

/** Legend block: one toggle per corridor plus the compare button. */
export function CorridorLegend({ corr, setCorr, onOpen }: {
  corr: Record<CorrKey, boolean>; setCorr: (c: Record<CorrKey, boolean>) => void; onOpen: () => void;
}) {
  return (
    <div className="corr-block">
      <div className="corr-title">
        <span>Casa Grande → LA</span>
        <button type="button" className="linkish" onClick={onOpen}>compare</button>
      </div>
      {CORR_ROWS.map(({ key, id, short }) => {
        const c = BY_ID[id];
        if (!c) return null;
        return (
          <label key={key} className="cat-toggle">
            <input type="checkbox" checked={corr[key]} onChange={(e) => setCorr({ ...corr, [key]: e.target.checked })} />
            <span className="dot corr-swatch" style={{ background: c.color }} />
            {short}
            <span className="count" title={`${c.camps.usable} tent spots · longest gap ${c.longestGap} mi`}>{Math.round(c.miles)} mi</span>
          </label>
        );
      })}
      <div className="alt-legend-note corr-pins">
        <span><i style={{ background: TIER_FILL.full }} />tents + shower</span>
        <span><i style={{ background: TIER_FILL.basic }} />tents</span>
        <span><i className="maybe" style={{ background: TIER_FILL.maybe }} />call first</span>
        <span><i className="gapband" />40+ mi gap</span>
        <span>+100 = miles from Casa Grande</span>
      </div>
    </div>
  );
}

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
};

/** The full comparison, as a sheet over the map. */
export function CorridorSheet({ onClose, onShow }: { onClose: () => void; onShow: (key: CorrKey) => void }) {
  const [pace, setPace] = useState(85);
  const [open, setOpen] = useState<string>('i10');
  const cols = ['i10', 'i10-offinterstate', 'i8', 'hybrid'].map((id) => BY_ID[id]).filter(Boolean);
  const keyOf = (id: string): CorrKey => (id.startsWith('i10') ? 'i10' : id === 'i8' ? 'i8' : 'hyb');
  const w = STUDY.weather;
  const windByDay = (() => {
    if (!w?.rows?.length) return [];
    const days = [...new Set(w.rows.map((r) => r.date))].sort();
    return days.map((d) => {
      const cell = (cor: string) => {
        const rows = w.rows.filter((r) => r.date === d && String(r.corridor ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(cor));
        if (!rows.length) return '';
        const n = (k: string) => rows.filter((r) => r.forWestbound === k).length;
        const head = n('headwind'), tail = n('tailwind');
        return head > tail ? `head ${head}/${rows.length}` : tail > head ? `tail ${tail}/${rows.length}` : n('light') >= rows.length / 2 ? 'light' : 'mixed';
      };
      return { d, i10: cell('i10'), i8: cell('i8'), hyb: cell('hybrid') };
    });
  })();
  return (
    <div className="sheet-ovl" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet corr-sheet">
        <div className="sheet-head">
          <b>I-10 vs I-8 from Casa Grande</b>
          <button className="sheet-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sheet-body">
          {STUDY.verdict && (
            <div className="corr-verdict">
              <b>{STUDY.verdict.headline}</b>
              <ul>{STUDY.verdict.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
            </div>
          )}
          <table className="corr-table">
            <thead><tr><th />{cols.map((c) => <th key={c.id} style={{ borderTopColor: c.color }}>{c.label}</th>)}</tr></thead>
            <tbody>
              <tr><td>Miles to the Elysian</td>{cols.map((c) => <td key={c.id}><b>{Math.round(c.miles)}</b></td>)}</tr>
              <tr><td>Climbing</td>{cols.map((c) => <td key={c.id}>{c.climbFt ? `${c.climbFt.toLocaleString()} ft` : '–'}</td>)}</tr>
              <tr><td>Places to pitch a tent</td>{cols.map((c) => <td key={c.id}>{c.camps.usable} <span className="dim">({c.camps.full} w/ shower)</span></td>)}</tr>
              <tr><td>Tent spots per 100 mi</td>{cols.map((c) => <td key={c.id}>{c.per100}</td>)}</tr>
              <tr><td>Longest gap</td>{cols.map((c) => <td key={c.id} className={c.longestGap > 50 ? 'bad' : c.longestGap > 40 ? 'meh' : ''}>{c.longestGap} mi</td>)}</tr>
              <tr><td>Longest gap, tents confirmed</td>{cols.map((c) => <td key={c.id} className={c.longestGapTentsKnown > 50 ? 'bad' : ''}>{c.longestGapTentsKnown} mi</td>)}</tr>
              <tr><td>Gaps over 50 mi</td>{cols.map((c) => <td key={c.id} className={c.over50 ? 'bad' : ''}>{c.over50}</td>)}</tr>
              {[70, 85, 100].map((t) => (
                <tr key={t}><td>At {t} mi/day</td>{cols.map((c) => {
                  const p = c.plans.find((x) => x.target === t);
                  return <td key={c.id}>{p ? <>{p.days} days<br /><span className="dim">arrive {fmtDate(p.arrive)}</span></> : '–'}</td>;
                })}</tr>
              ))}
            </tbody>
          </table>
          <p className="dim corr-foot">Leaving Casa Grande {fmtDate(STUDY.startDate)}. A “day” ends at the camp nearest the target pace; the last day rolls into the Elysian. Pins on the map carry phone numbers and what each place has.</p>

          <div className="corr-pace">
            Sample nights at
            {[70, 85, 100].map((t) => <button key={t} type="button" className={pace === t ? 'on' : ''} onClick={() => setPace(t)}>{t} mi/day</button>)}
          </div>
          {cols.map((c) => {
            const p = c.plans.find((x) => x.target === pace);
            const isOpen = open === c.id;
            return (
              <div key={c.id} className="corr-card" style={{ borderLeftColor: c.color }}>
                <button type="button" className="corr-card-head" onClick={() => setOpen(isOpen ? '' : c.id)}>
                  <b>{c.label}</b><span className="dim">{p ? `${p.days} days · arrive ${fmtDate(p.arrive)}` : ''}</span><span>{isOpen ? '–' : '+'}</span>
                </button>
                {isOpen && p && (
                  <div>
                    {p.nights.map((n, i) => (
                      <div key={n.id + i} className="corr-night">
                        <span className="dim">{fmtDate(addDays(STUDY.startDate, i))}</span>
                        <span><i className={`tier ${n.tier}`} />{n.name}{n.off >= 1 ? <span className="dim"> · {n.off} mi off</span> : null}</span>
                        <b className={n.dayMiles > pace + 15 ? 'bad' : ''}>{Math.round(n.dayMiles)} mi</b>
                        {n.fallbacks && n.fallbacks.length > 0 && (
                          <span className="corr-fallback dim">short day: {n.fallbacks.map((f) => `${f.name} (${Math.round(f.dayMiles)})`).join(' · ')}</span>
                        )}
                        {n.fallbacks && n.fallbacks.length === 0 && n.dayMiles > 55 && (
                          <span className="corr-fallback bad">no camp short of this one</span>
                        )}
                      </div>
                    ))}
                    <div className="corr-night">
                      <span className="dim">{fmtDate(addDays(STUDY.startDate, p.nights.length))}</span>
                      <span>The Elysian Theater</span><b>{Math.round(p.lastDay)} mi</b>
                    </div>
                    {c.gaps.length > 0 && (
                      <div className="corr-gaps">
                        <b>Gaps of 25+ mi</b>
                        {c.gaps.map((g, i) => <div key={i} className={g.miles > 50 ? 'bad' : g.miles > 40 ? 'meh' : ''}>{g.miles} mi: {g.fromName} (mi {Math.round(g.fromMile)}) → {g.toName} (mi {Math.round(g.toMile)})</div>)}
                      </div>
                    )}
                    <button type="button" className="linkish" onClick={() => { onShow(keyOf(c.id)); onClose(); }}>show on map</button>
                  </div>
                )}
              </div>
            );
          })}

          {w && (
            <div className="corr-sec">
              <h4>Wind, next few days (westbound)</h4>
              <p>{w.summary}</p>
              {windByDay.length > 0 && (
                <table className="corr-table small">
                  <thead><tr><th>Day</th><th>I-10</th><th>I-8</th><th>Hybrid</th></tr></thead>
                  <tbody>{windByDay.map((r) => <tr key={r.d}><td>{fmtDate(r.d)}</td><td>{r.i10}</td><td>{r.i8}</td><td>{r.hyb}</td></tr>)}</tbody>
                </table>
              )}
              {w.advisories && <p className="dim">{w.advisories}</p>}
              {w.climatology && <p className="dim">{w.climatology}</p>}
              <p className="dim">Forecast issued {w.issued}. Head/tail = how many forecast points on that line show it.</p>
            </div>
          )}
          {STUDY.legality && (
            <div className="corr-sec">
              <h4>Is it legal on a bike?</h4>
              <p>{STUDY.legality.summary}</p>
              <ul className="corr-legal">
                {STUDY.legality.legs.map((l, i) => (
                  <li key={i}><b className={l.bikeLegal === 'no' ? 'bad' : l.bikeLegal === 'yes' ? 'good' : 'meh'}>{l.bikeLegal === 'yes' ? 'Legal' : l.bikeLegal === 'no' ? 'Not legal' : l.bikeLegal === 'partly' ? 'Partly' : 'Unclear'}</b> · {l.leg}. <span className="dim">{l.detail} {l.shoulderAndTraffic} {l.hazards}</span></li>
                ))}
              </ul>
            </div>
          )}
          {STUDY.dryStretches.length > 0 && (
            <div className="corr-sec">
              <h4>Longest stretches without water</h4>
              <ul>{STUDY.dryStretches.map((d, i) => <li key={i}><b>{d.miles} mi</b> {d.from} → {d.to} <span className="dim">({LINE_NAME[d.corridor] ?? d.corridor}) {d.note}</span></li>)}</ul>
            </div>
          )}
          {STUDY.intel && (
            <div className="corr-sec">
              <h4>What other riders did</h4>
              <p>{STUDY.intel.summary}</p>
              <ul>{STUDY.intel.reports.map((r, i) => <li key={i}><a href={r.url} target="_blank" rel="noopener">{r.title}</a> <span className="dim">({r.year}, {r.route})</span>{r.campsUsed.length ? <span className="dim"> · camped: {r.campsUsed.join(', ')}</span> : null}</li>)}</ul>
            </div>
          )}
          <p className="dim corr-foot">Research run {STUDY.runs.join(', ') || '(none yet)'} · built {STUDY.generatedAt.slice(0, 16).replace('T', ' ')} UTC. Things change: call ahead on any “call first” pin.</p>
        </div>
      </div>
    </div>
  );
}
