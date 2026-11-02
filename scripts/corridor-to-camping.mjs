// Corridor study → the planner's camping research. After the 2026-11-01 I-10
// retrace the app's route IS the I-10 line west of Casa Grande, so every usable
// camp the corridor research found within reach of that line becomes a
// camping-research option (data/camping/research/seg-i10-corridor.json), keyed
// to synthetic research days ≥ 1050 (stops.json), exactly like
// seg-i8-corridor.json. build-camping.mjs then folds it into camping.json and
// syncCampSpots() mirrors it into resources, where the bed search sees it.
//
//   node scripts/build-corridor-study.mjs && node scripts/corridor-to-camping.mjs && node scripts/build-camping.mjs
import fs from 'node:fs';

const A_MILE = 2142.12;          // route mile of downtown Casa Grande = I-10 corridor mile 0
const MAX_OFF = 12;              // riding miles off the line worth listing
const camps = JSON.parse(fs.readFileSync('data/corridors/camps-merged.json', 'utf8'));
const lines = JSON.parse(fs.readFileSync('data/corridors/lines.json', 'utf8'));
const towns = lines.corridors.find((c) => c.id === 'i10').towns;

// Older research files cover some of the same places (the pre-retrace Southern
// Tier went through Quartzsite and Blythe). A new option supersedes an old one
// within 1.5 mi that shares a distinctive name token ("B-10"/"B10", "La Posa").
const GENERIC = new Set(['rv', 'park', 'resort', 'campground', 'camping', 'camp', 'area', 'blm', 'day', 'the', 'and', 'county',
  'state', 'beach', 'regional', 'site', 'sites', 'dispersed', 'land', 'road', 'rd', 'ltva', 'long', 'term', 'visitor', 'of', 'at', 'formerly', 'north', 'south', 'west', 'east', '14day']);
const tokens = (n) => new Set(String(n).toLowerCase().replace(/(\w)-(\w)/g, '$1$2').split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t)));
const older = fs.readdirSync('data/camping/research').filter((f) => /^seg-.*\.json$/.test(f) && f !== 'seg-i10-corridor.json')
  .flatMap((f) => JSON.parse(fs.readFileSync(`data/camping/research/${f}`, 'utf8')).flatMap((d) => d.options ?? []));
const hav = (a, b) => { const r = Math.PI / 180, x = Math.sin((b[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin((b[0] - a[0]) * r / 2) ** 2; return 7917.5 * Math.asin(Math.sqrt(x)); };
const supersedesFor = (c) => {
  const t = tokens(c.name);
  return older.filter((o) => Number.isFinite(o.lat) && hav([o.lng, o.lat], [c.lng, c.lat]) < 2 && [...tokens(o.name)].some((x) => t.has(x)))
    .map((o) => o.name);
};

const usable = camps.filter((c) => c.tier !== 'no' && c.anchors?.i10
  && (c.corridor === 'i10' ? c.anchors.i10.off <= MAX_OFF : c.anchors.i10.off <= 5))
  .sort((a, b) => a.anchors.i10.mile - b.anchors.i10.mile);

const priceOf = (s) => {
  if (!s) return null;
  s = String(s);
  if (/^\s*free\b/i.test(s)) return 0;          // "Free; 14-day limit" — not "free electricity"
  if (/placeholder|not published|no tent rate|unknown/i.test(s) && !/\$\s?\d/.test(s.split(/[.;]/)[0])) return null;
  const m = s.match(/\$\s?(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
};
// BLM "open to camping" only when the research does not doubt it
const DOUBT = /no (overnight )?camping|closed|prohibit|bans? camping|if the parcel|if camping is legal|state trust|unverified|not one of|isn't one of|not a documented/i;
const legalOk = (o) => DOUBT.test(`${o.name} ${o.priceTent} ${o.cyclistNotes ?? ''} ${o.verifyNote ?? ''}`) ? false
  : (o.confidence !== 'low' || /legal by land status/i.test(o.cyclistNotes ?? ''));
// dead "unknown…" contact fields become nothing (the text moves to booking)
const PHONE_RE = /(?:\+?1[\s.-]*)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/;
const phoneOf = (p) => (p && PHONE_RE.test(p) ? p : null);
const siteOf = (w) => (w && /^https?:\/\/\S+$/i.test(w.trim()) ? w.trim() : null);
const typeOf = (k) => ({
  rv_park: 'rv_park', private_campground: 'private_campground', koa: 'private_campground', state_park: 'state_park',
  county_or_city_park: 'county_park', national_park_or_forest: 'federal', blm_campground: 'federal', blm_dispersed: 'dispersed',
  ltva: 'dispersed', hike_bike_site: 'state_park', hipcamp_private: 'private_campground', casino_or_business: 'other',
  church_or_community: 'other', other: 'other',
}[k] ?? 'other');

// group into research "days" by the nearest town anchor, so the guide reads as stops
const days = new Map();
for (const c of usable) {
  const m = c.anchors.i10.mile;
  const town = towns.reduce((b, t) => (Math.abs(t.mile - m) < Math.abs(b.mile - m) ? t : b));
  if (!days.has(town.name)) days.set(town.name, { town, options: [] });
  days.get(town.name).options.push(c);
}
const research = []; const stops = [];
let day = 1050;
for (const { town, options } of [...days.values()].sort((a, b) => a.town.mile - b.town.mile)) {
  const best = options.find((o) => o.tier === 'full') ?? options.find((o) => o.tier === 'basic') ?? options[0];
  research.push({
    day,
    bestBet: `${best.name}${best.tier === 'full' ? ' — tents, showers, water' : best.tier === 'basic' ? ' — tents allowed' : ' — call first: tents not confirmed'}`,
    gap: false,
    options: options.map((o) => ({
      name: o.name,
      type: typeOf(o.kind),
      price: priceOf(o.priceTent),
      priceNote: o.priceTent || 'rate not found',
      lat: o.lat, lng: o.lng,
      locationNote: `${o.address ? o.address + ' — ' : ''}${o.anchors.i10.off} mi off the I-10 line at corridor mile ${Math.round(o.anchors.i10.mile)} from Casa Grande${o.access ? '. ' + o.access : ''}`,
      routeMile: +(A_MILE + o.anchors.i10.mile).toFixed(1),
      website: siteOf(o.website),
      phone: phoneOf(o.phone),
      booking: [o.reservations, phoneOf(o.phone) ? null : o.phone].filter(Boolean).join(' · ') || null,
      tentsOk: o.tents === 'yes' ? true : o.tents === 'no' ? false : null,
      water: o.water === 'potable' ? true : o.water === 'none' ? false : null,
      showers: o.showers === 'yes' ? true : o.showers === 'no' ? false : null,
      toilets: o.toilets === 'flush' || o.toilets === 'vault_or_pit' ? true : o.toilets === 'none' ? false : null,
      legalityNote: o.kind === 'blm_dispersed' || o.kind === 'ltva'
        ? (legalOk(o) ? 'BLM land open to camping (check the posted stay limit)' : 'Legality not confirmed: read the notes before you pitch')
        : null,
      cyclistIntel: [o.cyclistNotes, o.verifyNote].filter(Boolean).join(' ') || null,
      seasonalNote: o.openNov2026 === 'yes' ? 'Open in November 2026.' : o.openNov2026 === 'no' ? 'CLOSED in November 2026.' : 'November 2026 status not confirmed.',
      confidence: o.confidence,
      sources: o.sources ?? [],
      maxOffMi: MAX_OFF + 1,
      detourMi: o.anchors.i10.off,
      supersedes: supersedesFor(o),
    })),
  });
  stops.push({ day, date: null, endMile: +(A_MILE + town.mile).toFixed(1), miles: 0, endName: `${town.name} (I-10 corridor research)`, lat: null, lng: null });
  day++;
}
fs.writeFileSync('data/camping/research/seg-i10-corridor.json', JSON.stringify(research, null, 1));
const allStops = JSON.parse(fs.readFileSync('data/camping/research/stops.json', 'utf8')).filter((s) => s.day < 1050 || s.day >= 1100);
fs.writeFileSync('data/camping/research/stops.json', JSON.stringify([...allStops, ...stops], null, 1));
console.log(`seg-i10-corridor.json: ${research.length} stops, ${usable.length} camps (${usable.filter((c) => c.tier === 'full').length} full, ${usable.filter((c) => c.tier === 'basic').length} basic, ${usable.filter((c) => c.tier === 'maybe').length} call-first)`);
