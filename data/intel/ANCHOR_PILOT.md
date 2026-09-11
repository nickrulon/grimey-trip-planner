# ANCHOR PILOT — read-only spec

**Status: NOT RUN.** Rewritten 2026-09-04 against the finished 488-record file.
(The previous version was written at page 33 against 354 records and named test ids that
no longer represent the dataset.)

## Why this exists

**412 of 488 records have no mile.** Nothing in the file is anchored — `needsAnchor: false`
means "needs no mile", not "resolved". Until miles exist, the narrow-shoulder-ahead layer
Nick cares most about **cannot fire at all**.

**BUT:** they are not as far from anchored as that sounds. The `day` records already carry
the conversion key — see Tier 0. Try that before anything else.

This is a **pilot, not a batch job.** Do not attempt all 412. The deliverable is an
**honest accuracy report** that tells us whether mile-anchoring is viable, at what
precision, and what to change in the capture format. Answer that on ~25 records, then stop
and report.

**Read-only. Do not write to `ride-intel.jsonl` during the pilot.** Emit a separate
`anchor-pilot-results.json`.

---

## ⭐ Tier 0 — the cumulative-offset method. Do this FIRST, before any geometry work.

**This was missed in the original spec and it is probably the whole answer.**

All 48 `day` records carry both `cumulativeMi` (the journal's "Total so far" from San Diego)
and `miles`. So **every day's start AND end cumulative is already known**, with no fetching
and no geometry. And 363 of 439 observation records trace to a day through their page id.

The journal runs San Diego→east; Nick runs Pensacola→west. So for the same physical point:

```
A  =  NickRouteMile  +  JournalCumulative
```

`A` is Nick's route mile at San Diego. If the two routes were identical, `A` would be a
constant and every record would convert in one line of arithmetic.

### ⚠ FIRST: use `cumulativeMiCorrected`, never `cumulativeMi`

The journal's own running total is **understated by 54.3 miles from Day 37 onward** — the
author computed Day 37's total from the Big Bend *rest day* figure and never added Day 36's
54.29 mi ride. Every later day inherits it. Verified three ways: the internal arithmetic,
page 39's text, and summing all 49 riding days (2,596.9 vs a stated finish of 2,543.0; the
corrected 2,597.3 lands within 0.4 mi).

Every `day` record now carries **both** — `cumulativeMi` (what the source said, kept for
provenance) and `cumulativeMiCorrected` (what to compute with). See record
`src:cumulative-error`. The corrected chain is continuous from mile 0 to 2,597.3 with no
gaps. **Using the stated figure corrupts every record from Sanderson TX eastward** — all of
east Texas, Louisiana, Mississippi and Alabama.

**Tested against Nick's own known route miles** (from `free-lodging-scout.md`, computed
against his real geometry):

| place | Nick mi | journal cum | A |
|---|---|---|---|
| Glamis CA | 2637 | 178.3 | **2815.3** |
| Quartzsite AZ | 2550 | 262.7 | **2812.7** |
| Fort Hancock TX | 1759 | 1015.9 | 2774.9 |
| Marfa TX | 1607 | 1154.0 | **2761.0** |
| Marathon TX | 1549 | 1211.9 | **2760.9** |
| Sanderson TX | 1479 | 1266.2 | 2745.2 |
| Brackettville TX | 1322 | 1421.8 *(corrected)* | **2743.8** |

**Read the result honestly.** Locally it is excellent: Marfa and Marathon agree to
**0.1 mi**, Sanderson and Brackettville to **1.4 mi**, Glamis and Quartzsite to **2.6 mi**.
Globally it drifts monotonically eastward, 2815 → 2744, about **71 mi total**, because of
the four route divergences.

The one large remaining step — Quartzsite → Fort Hancock, 37.8 mi — spans exactly the
NM/AZ divergence (Nick goes Silver City → Lordsburg → Duncan; the journal took the Mule
Creek line). That the residuals line up with the *known* divergences is the strongest
evidence the method is sound.

*Before the 54.3 mi correction, Sanderson and Brackettville disagreed by 55.7 mi and the
apparent global drift was 125.8. Almost all of that was one arithmetic error in the
source.*

So the conversion is **piecewise-linear, calibrated per segment** — not one global constant.

**What to build:** fit `A` per segment between known Nick-mile anchors, using the ~17
anchors already in `free-lodging-scout.md` (Bogalusa 250, Simmesport 522, Bunkie 552,
Oberlin 616, Merryville 672, Shepherd 803, Brackettville 1322, Sanderson 1479, Marathon
1549, Marfa 1607, Fort Hancock 1759, Iron Creek 1986, Quartzsite 2550, Glamis 2637,
Ocotillo 2728, Boulder Oaks 2770, Santa Monica 2972). Interpolate `A` between them, convert
all 48 day boundaries, then bracket every record to its day.

**Precision you get for free:** a record bracketed to a day lands in a window of that day's
length — typically 45–95 mi. Records carrying `loc.dayMile` narrow to near-exact. That is
already good enough to fire "coming up on today's ride" warnings, which is most of what
Nick asked for.

**Report:** per-segment `A` values, the residual at each known anchor, and how many of the
363 traceable records convert. If residuals stay under ~5 mi inside a segment, **stop —
you are done, and the geometry tiers below are unnecessary.**

## Then, only if Tier 0 disappoints — the geometry tiers

### Tier 0 — the 28 `anchor` records (do these FIRST)
These are hard geographic fixes and they are the **scaffolding for everything else**:
state lines, signed passes, named bridges and river crossings, mileposts, landmarks. Every
one sits on a named highway. If these don't resolve tightly, nothing else will.

Highest-precision cases to prove the method on:
- `anchor:al-fl-state-line` — a state line **and** the Flora-Bama on the same spot, so two
  independent fixes agree. Near Nick's mile ~15-20.
- `anchor:la-ms-state-line`, `anchor:ms-al-state-line`, `anchor:sabine-river-state-line`,
  `anchor:nm-state-line` — state lines on known highways, the cleanest fixes available.
- `anchor:emory-pass` — signed pass, 8,228 ft, the route high point.
- `anchor:audubon-bridge` — uniquely named structure, single fixed location, and it pins
  the whole Day 51 route.
- `anchor:mp227-az` — **ADOT milepost 227 + a signed elevation of 3,883 ft.** Arizona
  mileposts on state routes are statewide-continuous and published, so this should be the
  single tightest fix in the file. But its `loc.road` is still "AZ-188 or US-60
  (UNRESOLVED)" — resolving which route it is on is part of the test.

### Tier 1 — the 23 severity-5 spans and points
This is the warning layer's core. If these resolve, the system is worth building.

Named-endpoint spans (should be tractable): `p42-001` (Three Sisters, Camp Wood→Hunt,
TX-337/TX-39) · `p28-001` (Emory Pass climb, NM-152) · `p21-001`/`p21-002`/`p21-003`
(AZ-87 Beeline Highway climb/shoulder/descent, same corridor) · `p22-001` (AZ-188/US-60).

Hard cases that matter most: `p56-006` — the **1.5-mile no-shoulder US-90 bridge east of
New Orleans**, structure identity unresolved, candidates listed on the record. Resolving
*which bridge* is worth more than resolving its mile. · `p6-001`/`p6-003` (In-Ko-Pah grade,
I-8 vs Old Highway 80 — the roadway itself is unconfirmed) · `p33-001` (goatheads, a
border corridor with three road names).

### Tier 2 — the 6 `dayMile` records
`p33-006` `p36-003` `p39-002` `p47-003` `p48-003` `p50-006`. Each carries `loc.dayMile` —
the rider's mileage into **his own day**, not Nick's system. Combined with that day's
`from`/`to` and the matching `day` record's total miles, these should be the most
precisely resolvable non-anchor records in the file. **This tier is the real test of
whether day-relative mileage is convertible.** If it works, it is worth going back and
harvesting day-mileage from the prose systematically.

### Tier 3 — deliberate failures. These MUST come back rejected.
- `p54-006` — `transferable: false`. A one-off May 2025 news event. **If this gets a mile,
  the transferable filter is broken and that is a bigger finding than any success.**
- `p20-009`, `p21-009`, `p23-012` — `needsAnchor: false` data-provenance caveats. Not
  places. Must be skipped, not anchored.
- `d10-005`, `p24-001` — `scope: region`. Apply across many days by design. Must NOT be
  collapsed to a single mile.
- `p18-N1` — an off-route night (hosted by friends, `onActiveRoute: false`).

---

## Report this per record — the report IS the deliverable

```json
{
  "id": "p42-001",
  "outcome": "resolved | partial | rejected | failed",
  "startMile": null, "endMile": null,
  "uncertaintyMi": null,
  "geometrySegment": "which route-geometry segment matched",
  "geometrySource": "GPX file / ACA section / OSM — and its own confidence",
  "orderedForNick": true,
  "whyFailed": "if failed, the specific reason",
  "oneFieldThatWouldHaveFixedIt": "THE MOST VALUABLE FIELD IN THIS REPORT"
}
```

Three things matter more than the mile itself:

1. **`uncertaintyMi`** — a mile with no error bar is not usable. A ±0.3 mi span warning is
   actionable; ±8 mi trains Nick to ignore warnings. Report the width honestly, including
   when it is embarrassing.
2. **`geometrySource` and its own confidence** — an anchor resolved against geometry we
   don't trust is not resolved.
3. **`oneFieldThatWouldHaveFixedIt`** — for every failure, name the single extra capturable
   field that would have made it work. Mining is finished, but a **second targeted pass
   for one specific field** across 59 pages is cheap. A general "capture more detail" is
   not. This is how the pilot pays for itself.

## Control

**Glamis, route mile 2637**, and the **99.8-mile dry stretch at route miles 1689–1789**,
are both already known from `trip-planner-state.md`. Records touching Glamis (`p8-*`) and
the dry stretch should land on those numbers. **If the method can't hit a mile we already
know, the method is wrong** — check that before trusting any other output.

## Also build Tier 2 of the warning fallback

Independent of anchoring, and it works **today** with zero geometry:

Index every unresolved record on `loc.road` + `loc.state`. When Nick's day touches
US-61 in Louisiana, surface the US-61 records without a mile — "somewhere on today's US-61
stretch: rough forced shoulder riding, severity 4." Imperfect anchoring then costs
**precision, not coverage.**

**Ship this first.** It converts 412 dead records into working intelligence immediately,
and it is the safety net if the pilot reports that anchoring is only viable at ±5 miles.

## Stop condition

Report after Tier 0 + Tier 1 + Tier 2 + the Tier 3 rejections — roughly 25 records. Do not
proceed to the remaining ~390 until Nick has read the accuracy numbers and decided.
