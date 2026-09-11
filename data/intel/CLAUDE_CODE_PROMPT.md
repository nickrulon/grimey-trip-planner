# Prompt to paste into Claude Code

---

Add the ride-intel research dataset to the planner.

**Read these first, in this order, before writing any code:**

1. `data/intel/HANDOFF.md` — what the dataset is, what it can't do yet, the build order,
   and six traps that will produce wrong output.
2. `data/intel/README.md` — the field reference and the three anchoring rules.
3. `data/intel/ANCHOR_PILOT.md` — only when you get to step 3 below.

**Derive the schema from the actual file, never from anything I paste you.** Run something
like `head -3 data/intel/ride-intel.jsonl` and read `README.md`. An earlier draft of this
project used snake_case names (`needs_anchor`, `on_active_route`, `blogger_mile`,
`actionable`) and a `page_record` kind. **None of those exist.** The file is schema v1.0,
camelCase, 488 records, 7 `kind` values, and `source` is a string not an object. If you
find yourself writing any snake_case field name, stop and re-read the file.

## Build in this order

**1. Filters first.** Drop `transferable: false` and `onActiveRoute: false` before anything
else touches a record. There is exactly one `transferable: false` record today
(`p54-006`) and it must never reach a warning surface.

**2. The road-indexed warning tier — build this before anything mile-based.**
No record in the file has a route mile. Not one. So index every record on
`loc.road` + `loc.state` and surface it when the day's planned route touches that road,
with no mile: *"somewhere on today's US-61 stretch: rough forced shoulder riding,
severity 4."* Zero geometry work, and it turns all 412 unanchored records into working
intelligence immediately. Without it my top-priority feature — warn me about narrow
shoulders — does not function at all.

**3. Then run the anchor pilot** per `ANCHOR_PILOT.md` — and **start with its Tier 0**,
the cumulative-offset method. All 48 `day` records already carry `cumulativeMi` and `miles`,
which means every day boundary converts to my route mile by arithmetic, with no geometry.
It tests to 0.1 mi precision locally against known anchors. If Tier 0 works, the geometry
tiers are unnecessary — say so and stop. It is a ~25-record accuracy test
in four tiers, **not** a batch job over 412 records. Write results to
`anchor-pilot-results.json` and do not modify `ride-intel.jsonl` during the pilot. Report
the accuracy numbers to me and stop. I decide whether to anchor the rest.

**4. Only then**, the mile-anchored tier, using whatever the pilot proved.

**5. Route `mustVerify: true` records to a pre-trip checklist surface**, not the warning
layer. There are 5, each with a `verifyTarget` string. They're research tasks, not hazards.

**6. Day calibration** from the 31 `routeTrace` blocks on `day` records — real measured
speed, elevation and temperature from a loaded touring bike on my actual roads.

## Non-obvious things that will bite you

- **`needsAnchor: false` does NOT mean resolved.** All 27 such records have null miles.
  They're region-wide rules and data caveats — advice, not places.
- **`loc.dayMile` is NOT a route mile.** It's the journal rider's mileage into *his own
  day*. Reading it as a position puts West Texas at my mile 50, which is in Alabama.
  Combined with its day's start-cumulative, though, it converts precisely — see Tier 0.
- **Use `cumulativeMiCorrected`, never `cumulativeMi`.** The journal's own running total
  is understated by 54.3 mi from Day 37 onward (the author computed it off a rest-day
  figure and skipped a 54.29 mi day). Both fields are on every `day` record — the stated
  one is kept for provenance only. Using it corrupts every record from Sanderson TX
  eastward. See record `src:cumulative-error`. The corrected chain is continuous from
  mile 0 to 2,597.3 with no gaps.
- **Spans must be re-ordered into my mile system.** `loc.from`/`loc.to` are in the
  journal's direction (west→east). I ride east→west. Get this wrong and half the warnings
  fire at the wrong end.
- **Do not re-rate `severity`.** It is already rated for me, my direction, my speed, my
  loaded bike. The reasoning is in `cyclistIntel`. A second direction adjustment
  double-counts.
- **Render amended records as amended.** Follow `amendedBy` / `resolves`. Two records
  (`p54-003`, `p58-003`) were corrected by later evidence; showing the original claim would
  surface a hazard that was disproven.
- **Every temperature in the file is a high-end scenario**, not a baseline — the source ride
  happened in an unusually hot spring. See `heatCalibration` on the source record. Don't
  build water math off them as typical.

## Definition of done for this pass

The road-indexed tier works end to end on at least one planned day, the filters are
enforced, and the pilot has reported accuracy numbers. Do not attempt to anchor 412
records in this session.
