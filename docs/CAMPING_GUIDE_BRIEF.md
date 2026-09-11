# Brief: render the camping Guide view + fix the off-route bug

**For Claude Code, running locally in `~/App Projects/grimey-trip-planner`.**
Written 2026-08-27 by a Cowork session that could edit files but could not run the app
(the device Linux VM failed to start, and `better-sqlite3` is a macOS binary anyway).
**Everything below needs to be typechecked and run — none of it has been.**

---

## What already happened (do not redo)

`data/camping/camping.json` has already been updated and committed to disk. Changes:

- **155 → 164 spots.** Nine added: Big Lagoon SP (mi 47), Franklinton PD (mi 261, off-route),
  Bunkie Fire Station (552), Allen Parish Tourist Commission / Oberlin (616),
  Atakapa-Coushatta Trace Visitors Center / Merryville (672), Shepherd Sanctuary (803),
  Pecos River picnic area (1400), First Baptist Sanderson (1479), Boulder Oaks CG (2770).
  All nine carry the full 21-field schema — verified, no missing keys.
- **`laws.states.FL` added** (was missing; the route has 13 Florida miles and they are the
  strictest on the trip). States reordered to route order: FL, AL, MS, LA, TX, NM, AZ, CA.
- **`laws.programs.campPendleton`** — recreational bike passes are SUSPENDED as of Aug 2026.
  This corrects a live error: the San Mateo spot's `cyclistIntel` assumed the base bike path
  works. Falls on Day 52.
- **`laws.programs.acaSection1Detour`** — ACA now publishes an official detour avoiding SR-78
  between Brawley and Blythe, which is the corridor Days 46–47 ride.
- **3 new `generalTips`**, **4 `dayAdvice` entries extended** (days 1, 10, 11, 50).
- **New top-level `guide` key** — see below. This is the content you are rendering.

Validation already run against the live DB (`plan_revisions` id 21, 53 days): JSON parses,
all 164 spots have all 21 fields, no unknown `type` values, all 53 days receive an advice
anchor, zero days have zero options.

---

## Task 1 — render `guide` as a third view in the Camping tab

`web/src/Camping.tsx` currently has `const [view, setView] = useState<'nights' | 'rules'>('nights')`
and a `.ride-filter` button pair. Add a third: **Guide**.

Suggested order: `Nights | Guide | Rules & tips`. Guide is strategy, Nights is tonight,
Rules is reference — that is roughly descending frequency of use on the road.

### The shape you are rendering

```ts
interface GuideItem { h: string; body: string }
interface GuideLedgerRow { nights: number; what: string; rate: string; cost: number }
interface GuideSection {
  id: string;
  title: string;
  intro?: string;
  items?: GuideItem[];
  ledger?: GuideLedgerRow[];   // only on the "budget" section
  total?: string;              // only on the "budget" section
}
interface Guide {
  title: string; updated: string; sourceReport: string; intro: string;
  sections: GuideSection[];
}
```

Add `guide?: Guide` to `CampingResponse`.

### Server change required

`server/camping.mjs` → `campingResponse()` returns a whitelist of keys. It currently returns
`ready, generatedAt, days, summary, laws, spots`. **Add `guide: data.guide ?? null`.**
One line. Without it the key never reaches the client.

### Rendering notes

- Six sections, all uniform except `budget` — render `items[]` as an `<h3>`/prose pair list,
  and if `ledger` exists render it as a small table above the items with a `total` line.
- Reuse the existing collapsible pattern from the `rules` view (`camp-state` / `camp-state-head`
  / `camp-state-body`) if the whole guide is too long open — but **default the `system` and
  `divergence` sections to open**, they are the two worth seeing without a click.
- The `divergence` section is the most operationally important thing in the guide: it lists
  the four places Grimey's route leaves the classic ACA line, so guidebook advice misleads.
  Consider giving it a warning-ish treatment.
- Footer: `updated` date and a link to `sourceReport` (the full narrative artifact).
- Styles go in `web/src/styles.css` alongside the existing `camp-*` rules. Match the existing
  visual language; do not introduce a new one.

---

## Task 2 — fix the off-route bug (this is a real correctness issue)

**The bug:** `CampSpot.deltaMi` is computed in `server/camping.mjs` as
`s.routeMile - d.end_mile` — distance *along the route*. For a spot that sits well off the
line, that number is a lie. Franklinton PD projects onto the route at mi 261 and Day 4 ends
at 263.1, so it renders as **"2.1 mi short of the end"** when reaching it is a 34-mile round
trip. Worse, it is free, so it sorts to the top of Day 4's options and becomes the day's
headline `FREE` chip and its `cheapestPrice`.

I mitigated it in data by renaming the spot to
`"Franklinton Police Dept — 17 mi OFF ROUTE (bail-out only)"` so the card header cannot
mislead. That is a band-aid. The structural fix:

1. Add an **`offRouteMi`** number field to the spot schema (default 0).
   Set it on Franklinton (17). Every other spot currently in the file is on-route (≤1 mi)
   except a handful that already say so in `locationNote` — grep for `off route` and
   backfill: Green Valley (3.2), San Mateo (1.5), San Clemente (1.0), Crystal Cove Lower
   Moro (2.0), Yellow Bayou (1.5). Verify each against `locationNote` rather than guessing.
2. Render it as a chip on `SpotCard` when `> 1`, and make `deltaText()` say
   *"2 mi short of the end, but 17 mi off route"* rather than just the along-route number.
3. **Exclude spots with `offRouteMi > 5` from `cheapestPrice` and from the `summary`
   free-nights count**, while still listing them as options. Right now Day 4 counts as a
   free night on the strength of a detour nobody would ride, which inflates
   `summary.freeNights` by one.

There is a `route_places.off_route_mi` column in the DB already — the concept exists
elsewhere in this codebase, so this is consistent, not novel.

---

## Task 3 (optional, only if 1 and 2 land clean)

**Mid-day spots are invisible.** `BACK_MI`/`FWD_MI` are both 20, so a day only shows spots
within ±20 mi of its endpoint. Four of the nine spots I added fall outside every window:
Big Lagoon (31 mi before D1's end), Bunkie (39 before D10), Oberlin (37 before D11), and
Boulder Oaks (27 before D50). They are on the map layer, and I surfaced each in the relevant
`dayAdvice` text as a workaround.

But Bunkie is a free indoor bed with a shower and Boulder Oaks is $5 with potable water —
these are stops worth *reshaping a day around*, and the UI cannot see them. Options, cheapest
first:

- Widen `BACK_MI` to ~45 and show anything beyond 20 under a collapsed
  "earlier on this day" group.
- Or add a `worthReshaping: true` flag to such spots and always include them, sorted last.

Do not solve this by editing `routeMile`. Mile anchoring is load-bearing across this codebase
(the map, the "End day here" button, replan survival) and falsifying a mile to game a UI
window would corrupt all three.

---

## Verification (the project's own standing rule)

`docs/ARCHITECTURE.md` and the project notes say: *"Run a review pass on anything substantial
before calling it done here — the plan engine has enough interacting state that plausible-looking
code is regularly wrong."* Phase 5 shipped and an adversarial pass then found 13 real bugs.

Minimum before calling this done:

1. `npm test` — the 28-assertion regression suite must stay green.
2. `npm run dev`, open the Camping tab, click all three views, expand several days.
3. Confirm Day 4's summary no longer counts Franklinton as a free night (Task 2).
4. Confirm `summary.freeNights` and `estMinCost` still compute — a simulated run of the
   current join logic gave **26 free nights, $574 est. min across 52 priced nights,
   0 zero-option nights**. If your numbers differ wildly after Task 2, that is expected for
   `freeNights` (should drop by ~1) but not for the rest.
5. Then a review pass on the diff.

---

## Content provenance

The `guide` prose and the nine new spots come from a six-pass research sweep (state camping
law, churches, and four route segments) plus a verification pass against primary sources on
2026-08-26/27. Live-verified this cycle: California hike/bike pricing, Texas Transp. Code
545.411, the San Carlos Apache permit rule, the Camp Pendleton suspension, the ACA Section 1
detour, and El Cosmico's closure. Every spot carries `sources[]` and a `confidence` value.
Anything older or shakier is labelled in-line rather than smoothed over.

Full narrative report: https://claude.ai/code/artifact/978fec0b-94bc-4880-b261-e2d29052b499
Project doc: `claude/free-lodging-scout.md`
