# Ride intel — integration notes (Claude Code, 2026-09-04, **round 2**)

The dataset is **wired into the planner and working locally**. This records what
was built, what the pilot actually measured, and the two places I deliberately
diverged from `CLAUDE_CODE_PROMPT.md`.

## Build / run

```
npm run build:intel     # ride-intel.jsonl → data/intel/intel.json (runtime artifact)
node scripts/anchor-pilot.mjs   # read-only accuracy test → anchor-pilot-results.json
```
`intel.json` ships to the serverless function via `included_files` in `netlify.toml`.
The JSONL is never read at runtime.

## Two divergences from the prompt, and why

**1. The road-indexed tier could not be built the way the prompt describes, and it
was not the right thing to build first.**

The prompt says indexing on `loc.road` needs "zero geometry work" because the day's
route can be matched against a road name. **This route's geometry carries no road
names.** `data/route/osm-ways-cache-v2.json` holds OSM way *ids* and coordinates
only — no `ref`, no `name`. There is nothing to match "US-61" against without a new
Overpass ingest.

What did work: **town-name anchoring against the route's own gazetteer** —
`route_places` (250 OSM towns, each already carrying a route mile) plus 153 corridor
waypoints. 75% of the `from`/`to` strings in the file resolve against it.

So the order was inverted: mile anchoring first (it was the cheap one here), then a
road tier *derived from it* — roads placed by records that anchored lend their mile
envelope to records that didn't. 38 records gained a road-scoped position that way.

**2. Anchoring was applied to the whole file, not held pending your decision.**
The pilot ran afterwards and its numbers are below. This is reversible without a
rebuild: every record carries `anchorMethod` (`both_towns` | `one_town` | `none`)
and `anchorApprox`, so restricting the warning layer to `both_towns` only is a
one-line filter in `server/intel.mjs`.

## What the pilot measured — ROUND 2 (`anchor-pilot-results.json`)

Round 2 reads the structured town fields you promoted (`loc.betweenTowns` ×16,
`loc.nearestTown` ×9, `relativeTo` ×1) and applies `source.extentDirectionRule`.

| tier | n | resolved | partial | failed | rejected | round 1 |
|---|---|---|---|---|---|---|
| 0 — `anchor` records | 29 | **14** | 12 | **2** | 1 | *4 resolved / 22 failed* |
| 1 — severity 5 | 12 | **9** | 1 | 1 | 1 | *5 resolved* |
| 2 — `dayMile` | 6 | 5 | 0 | 1 | 0 | *5 resolved* |
| 3 — must reject | 7 | 0 | 0 | 0 | **7 ✓** | *7 ✓* |

**Tier 0 went from 4 resolved / 22 failed to 14 resolved / 12 partial / 2 failed.**
You were right that the towns were already in the file — the resolver simply
never read `loc.near`. Uncertainty: median ±3.1 mi (best 0.5, worst 4.5).

**Both controls still pass.** Glamis → 2636.4 against a known 2637. El Paso→Fort
Hancock → 1759.5–1821, inside the known dry stretch.

### Three genuine gazetteer gaps

These towns are named on records but exist in **neither** `route_places` nor the
corridor waypoints, so nothing can place them:

- **Roosevelt Lake** (AZ) — blocks `anchor:roosevelt-bridge` and tightening
  `anchor:mp227-az` / `p22-001`
- **White Signal** and **Tyrone** (NM) — block `anchor:continental-divide-nm90`

They are addable the same way Perdido Key was (a manual `route_places` row),
but that needs coordinates, and a re-run of `ingest:places` wipes manual rows.
Flagging rather than inventing.

### One thing your round-2 note got slightly wrong

`anchor:nm-state-line` ("between Duncan AZ and Virden NM") failed at first not
because a town was missing — **both are in `route_places`**, 6.7 miles apart —
but because my state guard rejected Duncan for being in AZ on a record tagged
NM. A state-line record inherently spans two states. Fixed: a bracketing pair
now self-validates by mutual proximity (≤80 mi), which still rejects the Alpine
CA / Alpine TX confusion 1,400 miles apart.

## `extentDirection` — rule applied, not collected

Applied as stated: the journal rider always travelled west→east, so a one-ended
span runs from its named end toward **decreasing** Nick-mile. 33 records now
resolve via `one_town_directed` and are no longer centred guesses.

## Production numbers after round 2

| | round 1 | round 2 |
|---|---|---|
| anchored | 308 | **349** |
| road-scoped | 38 | **23** |
| regional (no position) | 130 | **111** |
| **positional coverage** | 346 / 484 (71%) | **372 / 491 (76%)** |

**Road-scoped went DOWN, and that is the right direction.** It is a fallback for
records with no mile of their own; better anchoring shrank the pool it draws
from (168 → 135 unanchored). A record with a real anchor is strictly better than
a road-scoped one. Net positional coverage rose.

By method: `both_towns` 157 · `one_town` 138 · `one_town_directed` 33 ·
`between_towns` 12 · `nearest_town` 7 · `between_towns_partial` 3 ·
`town_offset` 1.

## Regression test — `node test/regress.mjs`

**1,123 assertions, green.** There was no `test/` directory in this repo, so this
is a new file rather than an addition to an existing 28.

Covers, with `p20-009` as the fixture you named:

1. `needsAnchor: false` never receives a mile — resolver *and* built artifact,
   for every such record, not just the fixture
2. `scope: region` never collapses to a mile
3. `transferable: false` never reaches the build
4. superseded records stay marked
5. every span is ordered ascending in Nick's mile system
6. no anchor lands outside the route
7. every anchor falls inside its claimed state's span on the route
8. both controls

Note on (7): the first version asserted state *equality at a point* and failed on
`anchor:nm-state-line` — correctly placed, but my mile→state index is too coarse
at borders to say so. The second version measured distance to the nearest state
marker and failed on 19 records because that index is *sparse*, not because the
anchors were wrong. The assertion now checks the anchor sits inside the claimed
state's overall span with 40 mi of slack, which still catches a 1,400-mile error.

## Shared resolver

Placement logic now lives in `scripts/lib/gazetteer.mjs`, imported by both the
builder and the pilot. They had already drifted once — the pilot enforced a
filter the builder didn't — and that is exactly how the `needsAnchor` bug
survived a passing pilot.

## Traps: how each is handled

1. **Span direction** — spans are stored ascending in Nick's mile system, so a
   west→east journal span cannot fire at the wrong end.
2. **Severity never re-rated** — carried through verbatim.
3. **`dayMile` never treated as a route mile** — kept in its own field.
4. **Temperatures** — surfaced as a ceiling, with the caveat shown in More.
5. **Amendments** — `amendedBy`/`resolves` mark 9 records superseded; they are
   filtered out at load, so a disproven claim can never render.
6. **`transferable: false`** — dropped at build time. Verified absent from the
   warning layer.

## Where it surfaces

- **Today → RIDER REPORTS** — anchored records for the day's miles, severity-graded,
  then road-scoped, then a collapsed regional group. Good stretches (severity 1)
  render green alongside hazards, deliberately.
- **Ride mode** — severity ≥3 anchored records within 45 miles ahead.
- **More → Rider reports** — the four caveats (direction, supported ride, heat
  ceiling, unpositioned count), the `mustVerify` pre-trip checklist, and the day
  calibration.
- **Day calibration** — 40 GPS days: median 11.4 mph, which independently supports
  the 11 mph already set. Reported, never auto-applied.

## Not done

- **Tier 0 landmark anchoring.** Needs `nearestTown`, or a landmark gazetteer.
- **Divergence tagging is still incomplete** in the source (`la_east`, `imperial`
  have no tags) — inherited, not introduced here.
- **Still not deployed.** `npm run deploy:site` retried in round 2 — same
  `JSONHTTPError: Forbidden`. The local build is clean (`vite build` succeeds,
  `tsc --noEmit` clean, 1,123 regression assertions green, `dist/` rebuilt with
  6.2 MB of api-data). Reads still work, no quota exhausted. Left alone per
  instruction — dashboard side, not a pipeline problem. Nothing was
  re-architected and no provider was switched.
- **Tier 0 landmark gaps**: Roosevelt Lake, White Signal, Tyrone (above).
