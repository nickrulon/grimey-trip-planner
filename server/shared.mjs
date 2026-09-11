// Small facts both the planner and the Today layer need, kept in one place so
// the app has ONE vocabulary for "is this a good place to sit down" — the work
// chooser, the moving-meeting hint and the Day Builder's candidate pins all
// score a venue the same way.

// Brands where a laptop can genuinely sit for hours (from the Daylight Blocks
// prototype — loiterability is a real work-planning signal, not a joke).
export const LOITER = {
  "McDonald's": 3, Starbucks: 3, 'Panera Bread': 3, Panera: 3, "Dunkin'": 2.5, Dunkin: 2.5,
  'Burger King': 2.5, "Wendy's": 2.5, Whataburger: 2.5, "Denny's": 2.5, IHOP: 2,
  'Waffle House': 2, 'Jack in the Box': 2, "Carl's Jr.": 2, "Hardee's": 2,
  Subway: 1.5, 'Taco Bell': 1.5, Pilot: 2, "Love's": 2, 'Flying J': 2,
};
export const isLibrary = (name) => /librar|bibliot/i.test(name ?? '');

// How much to trust a wi-fi report. `none` is a hard negative: a stop that
// says it has no wi-fi is worse than one that says nothing.
export const WIFI_W = { confirmed: 4, likely: 2.5, unknown: 0.5, none: -6 };

/** The venue part of a work-stop score: wi-fi confidence + loiterability + library. */
export function venueScore({ wifi_status, brand, name }) {
  return (WIFI_W[wifi_status] ?? 0.5) + (LOITER[brand] ?? 0) + (isLibrary(name) ? 4 : 0);
}

/** Local minutes-from-midnight → "3:38p", the same shape the client prints. */
export function clock12(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const H = Math.floor(m / 60), Mi = m % 60;
  return `${((H + 11) % 12) + 1}:${String(Mi).padStart(2, '0')}${H < 12 ? 'a' : 'p'}`;
}
