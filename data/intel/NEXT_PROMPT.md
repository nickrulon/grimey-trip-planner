# Round 2 — paste into Claude Code

---

Good report. Two corrections and one unlock, then a short list.

## 1. My road-tier premise was wrong. Your inversion was right — keep it.

I told you to build the road-indexed tier first because it needs "zero geometry work."
You found this route's geometry carries no road names, so there was nothing to match
against. That was my error, not a misread on your part. I've corrected `HANDOFF.md` so the
next session doesn't repeat it.

Anchoring on towns first and deriving the road tier from anchored records is now the
documented approach. Don't revisit it.

## 2. `nearestTown` is NOT a second mining pass. The towns were already in the file.

Your `oneFieldThatWouldHaveFixedIt` was right about *what* was missing and wrong about
*where it was*. The towns were sitting in `loc.near` as prose the whole time — "between
Valentine and Marfa", "between Langtry and Comstock", "10 mi south of Silver City". Your
resolver only reads `loc.from` / `loc.to`, so it never looked at `near`.

**25 records now carry structured town fields**, promoted by hand from that prose:

- `loc.betweenTowns: [A, B]` on **16** records — a bracketing PAIR, so you get a mile
  *envelope* with both ends known, which is better than a single point. Use both ends;
  set uncertainty to half the envelope, not a fixed ±3.
- `loc.nearestTown` on **9**, some with `offsetFromTownMi` and `offsetBearing`
  (e.g. Tyrone Mine: 10 mi south of Silver City).
- `anchor:iron-creek-cg` also carries `relativeTo: "anchor:emory-pass"` with
  `offsetFromAnchorMi: 3` — resolve Emory Pass first, then offset.
- `loc.townsSource` marks every one. **Validate each town against `route_places` before
  trusting it** — I named the town the feature is near, not necessarily a town your
  gazetteer holds. Where a name is absent, fall back to the nearest one that is present
  and widen the uncertainty. `anchor:roosevelt-bridge` carries a `nearestTownNote` naming
  fallbacks for exactly this reason.

**Re-run Tier 0.** That's the headline number: 22 of 28 failed last time. Report the new
split. If a record still fails with towns present, the gazetteer genuinely lacks the town
and *that* is worth telling me about.

## 3. `extentDirection` is derivable. Don't collect it — apply a rule.

Six of your partials asked for `extentDirection`. It isn't missing data.

**The journal rider always travels west-to-east.** So a span with only one named end,
recorded on day N which runs A→B, extends from that end **toward B** — the rider's
direction of travel. In my mile system (east-to-west, Pensacola = 0) that means it runs
toward **decreasing** route mile.

The rule is stamped on the `source` record as `extentDirectionRule`. Apply it and re-run
those six. One-ended spans should stop being partials.

## 4. Decisions you asked for

- **Keep the whole-file anchoring.** Median ±3 mi is right for "on today's stretch", the
  `approx` labelling is honest, and `anchorMethod` / `anchorApprox` make it reversible if I
  change my mind. Don't restrict to `both_towns`.
- **Keep good stretches rendering green.** That was the correct call.
- **Keep day calibration reported, never auto-applied.** Also correct.

## 5. Then

- **Add a regression test** for the bug you caught: `needsAnchor === false` and
  `scope === 'region'` must never receive a route mile. That class of bug returns silently
  — it belongs in `test/regress.mjs` next to the other 28 assertions, using `p20-009` as
  the fixture.
- **Rebuild the road tier after Tier 0 re-runs.** More anchored records means more roads
  gain a mile envelope to lend, so 38 road-scoped should grow. Report the new count.
- **Re-run both controls** (Glamis 2637, the 99.8-mi dry stretch at 1689–1789) and confirm
  they still pass after the changes. If either moves, stop and tell me before proceeding.
- **Retry the deploy** with `npm run deploy:site`. If it's still `Forbidden`, leave it —
  that's mine to fix in the Netlify dashboard. **Do not re-architect the deploy pipeline or
  switch providers to work around it.** Just confirm the build is clean locally and say so.

## Definition of done

Tier 0's new resolved/partial/failed split, the new road-scoped count, both controls
passing, and the regression test green. Update `INTEGRATION_NOTES.md` with the new numbers.
