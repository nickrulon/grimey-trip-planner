# `ride-intel.jsonl` — schema and rules

**Schema version 1.0. 488 records. Mining COMPLETE.** Append-only ingest log, one JSON
object per line. Compile it to a built artifact (`intel.json`) the way `camping.json` is
built — do not query the JSONL at runtime.

Field naming is camelCase and deliberately matched to `data/camping/camping.json`
(`routeMile`, `tentsOk`, `water`, `showers`, `toilets`, `cyclistIntel`) so no translation
layer is needed.

> **Start with `HANDOFF.md`, not this file.** This is the field reference. `HANDOFF.md`
> says what the dataset can and cannot do, and in what order to build.

---

## The three rules

1. **NEVER estimate a `routeMile`.** If a record says `needsAnchor: true`, its mile is
   genuinely unknown. Resolve it once, against real route geometry, in the app. A guessed
   mile is worse than no mile: it fires a warning at the wrong place, which trains the
   rider to ignore warnings.
2. **`loc.from` / `loc.to` are in the JOURNAL's direction (west→east).** Nick rides
   east→west. When you compile a span you must store it **ordered in Nick's increasing-mile
   system**, or roughly half the warnings fire at the wrong end of the span.
3. **`severity` is ALREADY rated for Nick** — in his direction, at his speed, on his loaded
   bike. Do not re-rate it, and do not apply a second direction adjustment. The reasoning
   is written into `cyclistIntel`.

---

## Record kinds

| kind | count | anchors on | drives |
|---|---|---|---|
| `span` | 176 | `loc.startMile` + `loc.endMile` | **hazard-ahead and narrow-shoulder warnings** |
| `point` | 107 | `loc.routeMile` | resupply, services, single-location hazards, where others slept |
| `dayNote` | 82 | mile *range* + `scope` | the morning briefing |
| `day` | 48 | — (whole-day container) | calibration: real miles/ascent/speed/temps per day |
| `overnight` | 46 | `loc.routeMile` | the lodging chain |
| `anchor` | 28 | hard geographic fix | **resolving everything else** |
| `source` | 1 | — | provenance, caveats, coverage |

`span` exists because Nick's top-priority requirement is a span, not a point: "narrow
shoulder for 11 miles" has a start and an end.

`dayNote.scope` is `day` or `region`. A `region` note (e.g. hurricane season, `p57-N2`)
applies across many days and should not be attached to one mile.

`day` and `source` records have **no `loc`** — that is by design, not missing data.

---

## Core fields (present on every observation record)

```
id            string, stable, page-derived: "p53-001", "day:51", "anchor:audubon-bridge"
kind          span | point | dayNote | day | overnight | anchor | source
type          climb descent shoulder surface traffic hazard wind weather water
              food_resupply services lodging logistics people wildlife dogs
              scenery checkpoint alt_route            (null on day/overnight/anchor)
severity      1-5, integer, RATED FOR NICK          (null where not applicable)
summary       one line. Leading *** marks the highest-value records.
detail        what the source actually said
cyclistIntel  THE PAYLOAD — the synthesis, the direction reasoning, the action
loc           see below
onActiveRoute BOOLEAN true/false, or null when unknown (+ onActiveRouteUnknown: true)
divergence    la_east | nm_az | az_central | imperial | null   ⚠ see gap note below
observedDate  ISO date
stalenessYrs  integer, or null when the observation is older than this trip
confidence    confirmed | likely | unknown | unresolved
              | reported_earlier_ride | one_off_event
quote         the rider's own words, verbatim
photos        [{caption, shows}] — `shows` is my reading of the image, not the caption
conflictsWith [] or record ids
source        "vanwoert-2025"
```

### `loc`

```
state         "TX", or "MS/AL" for a record spanning a line
from / to     endpoints IN THE JOURNAL'S DIRECTION (see rule 2)
road          highway or trail designation — the fallback index key
near, place   for points
extentMi      length of the span
startMile / endMile / routeMile    Nick's route miles — NULL on all 412 unresolved
              records. There is currently NO numeric mile anywhere in the file.
dayMile       ⚠ NOT a route mile. The journal rider's mileage into HIS OWN day
              (6 records). A resolution HINT only — combine it with that day's
              `from`/`to` and the `day` record's total miles. Never read it as
              a position in Nick's system.
needsAnchor   BOOLEAN. true on 412, false on 27.
              ⚠ `false` does NOT mean "resolved". It means "needs no mile":
              region-scope rules ("no shade at Arizona RV parks"), data caveats,
              source-provenance notes, off-route nights, and the one
              non-transferable record. They are advice, not places.
              NOTHING in this file is anchored yet. The pilot has not run.
ascentFt, climbExtentMi, gradePct (numeric), elevFt
```

---

## Two-tier warning fallback — build BOTH

Anchoring will not be perfect. Design for that from the start:

1. **Tier 1, mile-anchored.** Resolved records fire positionally as Nick approaches.
2. **Tier 2, road-indexed.** Unresolved records index on `loc.road` + `loc.state` and
   surface when the day's route *touches that road*, without a mile.

Tier 2 means imperfect anchoring degrades **precision**, not coverage. Without it, 412
records are dead weight. Ship Tier 2 first — it works today with zero geometry work.

---

## Fields that change behaviour — do not ignore these

**Amendment chain.** Later pages contradicted earlier records and the records were fixed in
place rather than left standing. **Always render the amendment, never the original claim.**

- `amendedBy` — this record was corrected by another. Read that one too.
- `amendmentNote` — what changed and why.
- `resolves` — this record answers an open question on the id named.
- Currently: `p54-003` (downgraded 4→2 by `p56-001`), `p58-003` (resolved by `p59-001`),
  `p33-001` (amended by `p35-002`).

**`transferable: false`** — the observation is real but does **NOT** apply to Nick's ride.
Currently `p54-006`, a one-off May 2025 news event. **Must never reach the warning layer.**
Filter on this before anything else.

**`mustVerify: true` + `verifyTarget`** — a pre-trip research task, not a warning. Route
these to a checklist surface, not the morning briefing. 5 records: the ferry schedule, two
unidentified bridges, MRT closure status, NAS Pensacola access.

**`gap: true` + `gapNote`** — a known hole recorded deliberately so it isn't mistaken for
absence of risk (`p59-OV57`, Pensacola day-zero lodging).

**Routing fields, positive intelligence.** `offHighway`, `routingPriority: high`, `shade`,
`windSheltered`. These mark stretches to **route toward** — three off-highway assets on the
Gulf leg alone. A system that only knows hazards makes every mile feel equally risky.

**Lodging fields.** `lodgingType`, `booked`, `walkedIn`, `tentsOk`, `rvOnlyRisk`,
`offRouteMi`, `shuttle`, `adjacentTo`, `riderRecommended`, `holidayWeekendPressure`.
`rvOnlyRisk: true` means the night was RV-hookup-driven — recorded for the chain, **not**
promoted as a cyclist option.

**Ferry / hard dependencies.** `ferry{}` on `day:57`, `hardDependency: true`,
`crossingMin`, `firstSailing`, `offAt`, `dayStartDelayHrs`, `criticalForNick`.

**Day calibration.** `routeTrace{}` on 31 day records: `ordered` place/road sequence,
`speedBanding`, `waypointMarkers`, `elevationOverTime`, `temperatureOverTime`,
`contextLabels`, plus `elevationNote` / `temperatureNote` where the chart says something
the summary stats hide. This is real measured data from a loaded touring bike on Nick's
actual roads — the best speed and heat calibration available.

---

## ⚠ Divergence tagging is INCOMPLETE

Only `az_central` (18) and `nm_az` (17) records carry a tag. **`la_east` and `imperial`
have ZERO tagged records.** Do not assume a divergence filter is complete. The Louisiana
and Imperial Valley records were written before the tagging was consistent; they are
correct as observations but not filterable by divergence.

---

## Source caveats — these govern every record

1. **Supported ride.** RV, crew, a cook. Lodging / water / food / services records are
   capped at `likely` no matter how confident the prose sounds.
2. **Their day lengths were set by RV hookup availability, not cycling** — the rider says
   so outright (`p26-004`, and again at `p52-N2`). Use mile-anchored observations.
   **Discard their itinerary entirely.** Anchoring is to MILES, never to their days.
3. **The whole ride was unseasonably hot** — record-setting in Arizona, "flirting with
   record highs" in Louisiana. See `heatCalibration` on the source record. Every
   temperature is a **high-end scenario, not a baseline.** Operational rules transfer; the
   numbers are a ceiling.

## Direction inversion — what flips and what does not

The journal runs **west→east**; Nick rides **east→west**.

**Inverts:** climb ↔ descent · headwind ↔ tailwind · morning ↔ afternoon sun and heat ·
resupply order · fitness stage (their day 57 is his day 1) · day shape (their last high
point is his first) · gear order (they descend out of mountains cold-to-hot; he climbs into
them hot-to-cold).

**Does NOT invert:** crosswind · road surface · **shoulder width** · debris · wildlife and
dogs · services · rules and permits · storm and flood risk.

`severity` and `cyclistIntel` already account for all of this. Rule 3.

## Compile step

1. Filter `transferable: false` and `onActiveRoute: false`.
2. Resolve anchors — `anchor` records first, they are the highest-precision fixes.
3. Order every span in Nick's increasing-mile system (rule 2).
4. Route `mustVerify` records to a pre-trip checklist, not the warning layer.
5. Build both warning tiers.
6. Collapse amended records to their amended form.
