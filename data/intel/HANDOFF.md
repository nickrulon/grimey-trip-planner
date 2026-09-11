# HANDOFF — ride intel → planning app

**Read this first.** Then `README.md` for the field reference, then `ANCHOR_PILOT.md`.

Written 2026-09-04. Mining is **complete**. Nothing more needs to be extracted from the
source journal.

---

## What you have

`data/intel/ride-intel.jsonl` — **488 records, schema v1.0**, valid JSON, no duplicate ids.
Append-only ingest log. Compile it to a built artifact (`intel.json`) the way
`camping.json` is built. Do not query the JSONL at runtime.

Mined from one source: **"Dave & Mike's Southern Tier Ride"** (crazyguyonabike.com,
UrbandaleDave / David Van Woert, 2025), pages 3–59 of 68, hand-pasted page by page and
synthesized with a purpose-built skill. It covers the rider's **full San Diego → Pensacola
run, 2,543 miles, seven states, Days 1–57** — which is the entire overlap with Nick's
route. Pages 60–68 are Florida east of Nick's start and were deliberately skipped.

| kind | n | drives |
|---|---|---|
| `span` | 176 | **hazard-ahead / narrow-shoulder warnings** |
| `point` | 107 | resupply, services, where others slept |
| `dayNote` | 82 | morning briefing |
| `day` | 48 | speed & heat calibration from real GPS |
| `overnight` | 46 | the lodging chain, nights 1–57 |
| `anchor` | 28 | resolving everything else |
| `source` | 1 | provenance & caveats |

---

## ⚠ What it CANNOT do yet — read before you promise Nick anything

**No record in this file has a route mile. Not one.** All 412 `needsAnchor: true` records
have `routeMile`/`startMile`/`endMile` set to `null`, and the 27 `needsAnchor: false`
records are advice that needs no mile (region-wide rules, data caveats, off-route notes) —
**`false` does not mean "resolved."**

So today: **the positional warning layer does not work.** "Warn me where there will be
narrow shoulders" — Nick's stated top priority — is inert until anchoring runs.

**⚠ CORRECTED 2026-09-04 — the original advice here was wrong for this repo.**
I said to ship a road-indexed tier first because matching the day's route against
`loc.road` needs "zero geometry work". **It doesn't work: this route's geometry carries no
road names.** `data/route/osm-ways-cache-v2.json` holds OSM way ids and coordinates only —
no `ref`, no `name` — so there is nothing to match "US-61" against without a new Overpass
ingest.

**What actually works, and is cheap: town-name anchoring against the route's own
gazetteer.** `route_places` holds 250 OSM towns each already carrying a route mile, plus
153 corridor waypoints, and ~75% of the `from`/`to` strings in this file resolve against
it. Anchor on towns FIRST, then derive a road tier from the records that anchored — roads
placed by anchored records lend their mile envelope to records that didn't.
See `INTEGRATION_NOTES.md`.

Then run `ANCHOR_PILOT.md` — a ~25-record accuracy test, not a batch job.

---

## Build order

1. **Filter first, always.** Drop `transferable: false` and `onActiveRoute: false`. See traps.
2. **Road-indexed warning tier** (works now).
3. **Run the anchor pilot.** Report accuracy before anchoring the rest.
4. **Mile-anchored warning tier** — `anchor` records first, they're the tightest fixes.
5. **Route `mustVerify` records to a pre-trip checklist**, not the warning layer.
6. **Day calibration** from the 31 `routeTrace` blocks.

---

## Six traps that will produce wrong output

**1. Spans must be re-ordered into Nick's mile system.**
`loc.from` / `loc.to` are in the **journal's** direction (west→east). Nick rides east→west.
Store spans ordered by increasing Nick-mile or **roughly half your warnings fire at the
wrong end.**

**2. Do not re-rate severity.**
`severity` is *already* rated for Nick — his direction, his speed, his loaded bike. The
reasoning is in `cyclistIntel`. Applying a second direction adjustment double-counts it.
A punishing climb that reverses into a descent is already not a 5.

**3. `loc.dayMile` is NOT a route mile.**
6 records carry it. It's the journal rider's mileage into **his own day**. Reading it as a
position puts Fort Hancock, West Texas at Nick's mile 50 — which is in Alabama. It is a
resolution *hint*, to be combined with that day's `from`/`to` and the `day` record's total.

**4. Every temperature is a high-end scenario.**
This ride happened in an unusually hot spring — record-setting in Arizona, "flirting with
record highs" in Louisiana. See `heatCalibration` on the source record. **Operational
rules transfer; the numbers are a ceiling, not a baseline.** Do not build water math off
them as if typical.

**5. Amended records must render as amended.**
Later pages contradicted earlier ones and the records were fixed in place. Follow
`amendedBy` / `resolves` and show the amendment, never the original claim:
- `p54-003` downgraded 4→2 by `p56-001` (a trail closure I flagged as live; the rider
  later actually rode that segment and found 13 miles open and busy)
- `p58-003` resolved by `p59-001` (ferry timing)
- `p33-001` amended by `p35-002` (goathead mitigation was only half a mitigation)

**6. `transferable: false` must never reach the warning layer.**
Currently one record, `p54-006` — a specific May 2025 news event, filed only so a later
pass can't mine it into a standing hazard. If the pilot assigns it a mile, your filter is
broken.

**Also:** their day lengths were set by **RV hookup availability, not cycling** — the rider
says so outright. Anchoring is to **miles, never to their days**. Discard their itinerary.
And every lodging/water/food/services record is capped at `likely` because this was a
supported ride with a chase vehicle and a cook.

---

## Known gaps — recorded, not hidden

- **Pages 30–31 uncaptured.** The one real on-route content gap; **overnight nights 23–29
  sit behind them** (the rider was off route visiting family). Pages 4, 19, 51, 55 are
  rest/low-content. Day 5's page number is still ambiguous (6 or 7).
- **Overnight chain holes:** nights 2, 3, 13, 20, 23–29.
- **Divergence tagging is incomplete.** Only `az_central` (18) and `nm_az` (17) records
  carry a tag. **`la_east` and `imperial` have ZERO.** Don't assume divergence filtering
  is complete.
- **`p59-OV57` is a deliberate `gap: true`** — Pensacola day-zero lodging, which is Nick's
  actual start point, and the journal never names one.
- **5 `mustVerify` research tasks**, all with `verifyTarget` set: Mobile Bay ferry
  schedule (incl. **last** sailing), the unidentified 1.5-mile US-90 bridge, the
  unidentified Mississippi River crossing between Carville and River Ridge, MRT closure
  status, NAS Pensacola public access.

---

## The five findings most likely to change the plan

**1. Nick's Day 1 has the trip's worst failure mode.** `day:57` / `p59-N2` is his opening
day run backwards. The Dauphin Island ferry crossing is only ~30 min, but the rider camped
*at* the terminal, was **first in line for the 8am sailing**, and still started riding two
hours late — which alone made it **the hottest day of his 2,500 miles: 96.5 °F average,
~115 °F spikes, on 45 flat miles.** Nothing changed but the clock. **For Nick the ferry is
at the END of day one, and Fort Morgan is a dead-end peninsula.** Miss the last sailing and
he's stranded 20+ miles out a spur. This is also the cleanest proof in the dataset that
**start time is the most powerful lever he has** — more than mileage, fitness, or route.

**2. Wind is the dominant schedule risk, and it's measured.** Same rider, consecutive days:
60 mi at 8.7 mph into a headwind (his slowest in 50 years), then 95 mi at 14.7 mph with
one. Daily range swung 60–95 miles on wind alone. **Nick's plan has zero spare days across
53.** A run of headwind days in West Texas costs days tailwinds cannot bank back. This is a
plan problem, not a data problem.

**3. Narrow shoulders come in three clean tiers**, and the app should show all three:
severity 5 (the 1.5-mile no-shoulder US-90 bridge east of New Orleans — he only survived it
because roadwork had coned off a lane, and **Nick gets the traffic-mixed half on the
climb**); severity 4 (US-61 through Baton Rouge, and River Road, where he had to **stop and
pull off** for queues of drivers); and **severity 1 — the good stretches**, confirmed twice
on US-90 through coastal Mississippi and Alabama. **Record the good ones.** A system that
only knows hazards makes every mile feel equally risky.

**4. Route toward things, not just away.** `offHighway` + `routingPriority: high` marks
three off-highway assets on the Gulf leg alone: ~20 mi of Mississippi levee trail through
Baton Rouge, 13 mi out of New Orleans (**ridden and confirmed open**), hours of separated
Mississippi Sound beach path, and a fully-canopied Perdido Key trail. `shade` and
`windSheltered` flag where the pines cancel the wind on US-90.

**5. Asking locally works, five-plus for five.** Thatcher City Park, Langtry, Camp Wood,
Hunt, and best of all **Dauphin Island on Memorial Day Saturday** — every RV park showed
sold out; walking through the door of the one beside the ferry terminal produced an open
spot immediately. This is the main reason the six unanchored nights in Nick's own plan are
recoverable rather than fatal.

---

## Files

| file | what it is |
|---|---|
| `ride-intel.jsonl` | the dataset — 488 records, schema v1.0 |
| `README.md` | field reference, the three rules, direction-inversion table, compile step |
| `ANCHOR_PILOT.md` | the ~25-record accuracy test. **Not run.** Highest-value hour left. |
| `HANDOFF.md` | this file |
| `ride-intel.jsonl.bak-preNormalize` | pre-normalization backup, safe to delete |

Wider plan context lives in the project docs, `trip-planner-state.md` and
`ride-intel-mining.md`.
