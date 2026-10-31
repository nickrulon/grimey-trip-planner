// Shared formatting: times are LOCAL to the day's position unless marked ET.

export const r1 = (n: number) => Math.round(n * 10) / 10;

/** Hours-float (7.25) or minutes-from-midnight → "7:15a". */
export function clockH(hours: number | null | undefined): string {
  if (hours == null) return '—';
  let m = Math.round(hours * 60);
  m = ((m % 1440) + 1440) % 1440;
  const H = Math.floor(m / 60), Mi = m % 60;
  return `${((H + 11) % 12) + 1}:${String(Mi).padStart(2, '0')}${H < 12 ? 'a' : 'p'}`;
}
export const clockMin = (min: number | null | undefined) =>
  min == null ? '—' : clockH(min / 60);

export function durMin(min: number | null | undefined): string {
  if (min == null) return '—';
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, '0')}` : `${m}m`;
}

export function money(n: number | null | undefined): string {
  if (n == null) return '—';
  return n === 0 ? 'FREE' : `$${Math.round(n)}`;
}

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function stampDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return `${DOW[dt.getUTCDay()]} ${MON[m - 1]} ${d}`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${m}/${d}`;
}

export function dowOf(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return DOW[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()];
}

export const isWeekendDate = (iso: string | null | undefined) => {
  const d = dowOf(iso);
  return d === 'SAT' || d === 'SUN';
};

// Wi-Fi confidence: the four-valued distinction the planning depends on,
// rendered loudly (color + icon + words — never a lone glyph).
export const WIFI_META: Record<string, { label: string; cls: string; icon: string }> = {
  confirmed: { label: 'VERIFIED WI-FI', cls: 'wifi-ok', icon: '✓' },
  likely: { label: 'LIKELY WI-FI', cls: 'wifi-likely', icon: '~' },
  unknown: { label: 'WI-FI UNKNOWN', cls: 'wifi-unknown', icon: '?' },
  none: { label: 'NO WI-FI REPORTED', cls: 'wifi-none', icon: '✕' },
};
export const wifiMeta = (s: string | null | undefined) => WIFI_META[s ?? 'unknown'] ?? WIFI_META.unknown;

export const READINESS_META: Record<string, { label: string; cls: string }> = {
  ready: { label: 'READY', cls: 'rd-ready' },
  done: { label: 'DONE', cls: 'rd-done' },
  daylight: { label: 'DAYLIGHT CONFLICT', cls: 'rd-bad' },
  daylight_tight: { label: 'TIGHT', cls: 'rd-warn' },
  mileage: { label: 'MILEAGE', cls: 'rd-bad' },
  work: { label: 'NEEDS WORK STOP', cls: 'rd-warn' },
  work_wifi: { label: 'WI-FI UNVERIFIED', cls: 'rd-warn' },
  sleep: { label: 'NEEDS SLEEP', cls: 'rd-warn' },
  work_short: { label: 'WORK DAY SHORT', cls: 'rd-warn' },
  mark_missed: { label: 'MISSES A FIXED TIME', cls: 'rd-bad' },
  route: { label: 'ROUTE NOTE', cls: 'rd-note' },
  unknown: { label: '—', cls: 'rd-note' },
};
export const readinessMeta = (s: string | null | undefined) =>
  READINESS_META[s ?? 'unknown'] ?? READINESS_META.unknown;

// ---- addresses & map hand-off ------------------------------------------------
// OSM street addresses often stop at the street, and sometimes already end in
// the city. Complete them with the town the place actually sits in plus the
// state, so what's on screen is what you'd read to a motel clerk.
export interface Placeish {
  name?: string;
  address?: string | null;
  town?: string | null;
  state?: string | null;
}

export function fullAddress(p: Placeish): string {
  const parts: string[] = [];
  // OSM sometimes carries only a house number ("8660") with no street. That is
  // worse than nothing in an address line, so drop anything with no letters.
  const street = (p.address ?? '').trim();
  if (street && /[a-z]/i.test(street)) parts.push(street);
  const town = p.town ?? '';
  const bad = !town || town.startsWith('Mile ') || town.startsWith('near ');
  if (!bad && !(p.address ?? '').toLowerCase().includes(town.toLowerCase())) {
    parts.push(town);
  }
  const line = parts.join(', ');
  return [line, p.state].filter(Boolean).join(', ');
}

/** Name + full address — what you'd paste into a booking form or read aloud. */
export function pasteAddress(p: Placeish): string {
  return [p.name, fullAddress(p)].filter(Boolean).join(', ');
}

// Directions links target the exact COORDINATES (a pin cannot land in the
// wrong town), while the label carries the name so the destination is
// recognisable when it opens.
export function appleMapsUrl(lat: number, lng: number, p?: Placeish): string {
  const label = p?.name ? `&q=${encodeURIComponent(p.name)}` : '';
  return `https://maps.apple.com/?daddr=${lat},${lng}${label}`;
}
export function googleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=bicycling`;
}
/** Search by name + full address — for checking hours, photos, reviews. */
export function googleSearchUrl(p: Placeish): string {
  return `https://www.google.com/search?q=${encodeURIComponent(pasteAddress(p))}`;
}

export const NOTE_ICON: Record<string, string> = {
  ferry: '⛴', detour: '⚠', highway: '▲', no_services: '∅',
  climb: '⛰', bridge: '≈', traffic: '▲', trail: '↟', caution: '!',
};

/** Today's date in the device's local zone, as the plan writes dates (YYYY-MM-DD). */
export function localISODate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
