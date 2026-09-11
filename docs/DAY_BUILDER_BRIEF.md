# Brief: Build the Day — composing a day on the map

**For Claude Code, in `~/App Projects/grimey-trip-planner`.**
Written 2026-09-11 from a Cowork session that read the repo but could not run it.
Nothing here is typechecked. This is a spec.

---

## The problem in one line

The app asks Nick to declare a day's **endpoint**, but he thinks in a **chain**: wake → ride
25 → work 7h at a library → ride 2 → work 1.5h → ride 30 → sleep. The endpoint should be the
*output* of that chain, not the input to it. And on a workday the true anchor is the ET work
window, not mileage — the ride is what fits around the sit.

Doing that through numeric dials means holding six things in his head at once. Doing it on a
map with the timeline updating beside it means seeing them.

---

## Do not rebuild anything

This is the important part. **The chain engine already exists and is correct.** Read
`server/today.mjs` ~line 118–215 before writing any code:

- It merges `breaksFor(d)` + `workStopsFor(d)` + `combosFor(d)`, **sorts by route mile**, and
  walks them with a `cursorMile` / `cursorMin` pair.
- It emits `ride` blocks for the gaps between stops and `work` / `combo` / `break` blocks for
  the stops themselves.
- It already handles **multiple work stops in one day** — `workStopsFor` is plural. Nick's
  library-then-McDonald's-then-library scenario is already representable today.
- It already inserts a `slack` "Buffer" block when he arrives before the work clock starts,
  and already raises `conflict: 'work_late'` when he arrives after it.
- It already emits **`progress[]`** — `(mile, localMinute)` samples along the day, added for
  the marks feature. That is precisely the "when am I at mile X" primitive a builder needs.

And `planned_stops` **is** the chain: rows with `route_mile`, `kind` ('work' | 'break'),
`dwell_min`. Ordered by mile, that is the day.

So the data model is done, the simulation is done, and multi-stop days are done. What is
missing is a **composition surface** and one honest gap in the candidate query. Nothing gets
torn out.

---

## What is actually missing — three things

### 1. `stopCandidates` cannot see past the day's endpoint

`plan.mjs` ~line 844 already takes a **`fromMile`** parameter and already returns `rideMiles`
and `rideMinutes` measured from it. The cursor concept is half-built.

Two problems:

- It clamps `hi = day.end_mile - 0.05`. In a builder the endpoint is an outcome, so clamping
  to it makes the last leg unplannable — you can never see the campground you would reach by
  riding *further* than the current plan says.
- It returns ride *minutes*, not **arrival clock time**. "Library, 25 mi, 2h20" is far less
  useful than "arrive 9:47a," because on a workday the question is whether he can be sitting
  down before the ET window opens.

Extend it (keep the existing signature working):

```js
stopCandidates({
  dayNumber, fromMile, fromMin,      // fromMin: local minutes, the cursor's clock
  reachMi,                            // how far forward to look; default day.end_mile - fromMile
  cats, limit,
})
```

Each candidate gains:

```js
arriveMin,          // fromMin + rideMinutes  → the headline number on the pin
arriveClock,        // 'h:mm a' for display
beforeWorkOpen,     // bool: arriveMin <= work.localStart (workdays only)
minsLateForWork,    // null, or how late this pick makes him
lightLeftMin,       // dusk - arriveMin
wifiStatus,         // already returned — surface it as pin colour
```

`today.mjs → workOptions()` (~line 411) already has the scoring weights for wifi confidence
(`{confirmed: 4, likely: 2.5, unknown: 0.5, none: -6}`). Reuse them; do not invent a second
scoring scheme.

### 2. There is no dry run

Everything today writes first and recomputes after. A builder needs **preview before commit**
— hover a pin, see what the day becomes, without a DB write.

Do this as a **refactor, not a rewrite**: extract the existing walk from `dayCanvas` into a
pure function.

```js
// today.mjs
function simulateDay(day, stops, opts) -> { blocks, progress, conflict, endMile, endMin, workCredit }
```

`dayCanvas` then calls it with the stops read from the DB. A new endpoint calls it with a
**proposed** stop list:

```
POST /api/plan/day/:n/simulate   { stops: [{ routeMile, kind, dwellMin, name }] }
  -> { blocks, conflict, endMile, endMin, workCredit, owedMin, readiness }
```

This is the single highest-value change in the whole brief. It makes the builder responsive,
and it makes the walk independently testable — which matters, because `test/regress.mjs`
currently can only exercise it through the canvas.

Keep `simulateDay` **pure**: no DB reads, no writes. Pass everything in.

### 3. The picker is a one-shot modal

`MapPicker.tsx` is already the right surface — it draws candidates into the **shared** map
canvas with consequence attached (`milesFromStart`, `rideMinFromStart`, `deltaMi`,
`direction`, `score`), and it already has sensible filters.

But `PickerContext` is `{ mode: 'sleep' | 'work', ... onPick, onClose }` — open it to answer
one question, pick, it closes. There is no mode where it stays open and you build a day.

Add a third mode rather than a second component:

```ts
mode: 'sleep' | 'work' | 'build'
```

In `build` mode:

- The picker **stays open** after `onPick`.
- It keeps a **draft chain** in component state — an array of proposed stops, not yet saved.
- After each pick the cursor advances to that stop's mile and its departure clock
  (`arriveMin + dwellMin`), and candidates are re-fetched with the new `fromMile` / `fromMin`.
- Every pin label shows **arrival time**, and on a workday is tinted by `beforeWorkOpen`.
- A **chain panel** sits beside the map: wake → ride 25.0 mi (2h20) → Library 7h → ride 2.1 mi
  → McDonald's 1h30 → … → sleep. Each row deletable; each stop's dwell editable inline.
- The **timeline bar renders live** from the `simulate` response. This is not optional — see
  below.
- One **Save day** button commits the whole chain: `POST /api/plan/stop` per stop, or better,
  a new `POST /api/plan/day/:n/stops` that replaces the day's stop set in one transaction so a
  half-saved chain is impossible.

---

## Why the timeline must stay visible while building

Nick framed this as wanting a map instead of a list. The map is right for *where*, but his
binding constraint is *time*, and a map cannot show time. Both need to be on screen.

The proof is his own worked example: ride 25, work 7h, short hop, work 1.5h, work 5h, ride 30.
That is **13.5 hours of sitting plus ~5 hours of riding — a 19-hour day.** It does not fit,
and nothing in the current UI says so until he does the arithmetic himself.

With the timeline live beside the map, it goes red the moment the second work stop lands. That
instant infeasibility signal *is* the feature. Build the panel so the conflict and readiness
chips are impossible to miss — reuse the existing `issues-row` / `issue issue-${kind}` markup
from `Today.tsx` (~line 512) rather than inventing new treatment.

Add one readiness kind while you are here: **`work_short`** — the chain's `workCredit` is less
than `owedMin` for a workday. Right now a day can quietly under-serve the work obligation and
nothing says anything.

---

## Where it lives in the UI

Do **not** make this a fourth nav tab. It is a mode of the day he is already looking at.

Add a **"Build the day"** button next to `Edit day` in the day header (`Today.tsx` ~line 505).
It opens the shared map with `mode: 'build'`, chain panel and timeline docked. `Done` returns
to the normal day view. That keeps one mental model: Today is the day, this is a way of
editing it.

Existing `Edit day` stays exactly as it is. Some days are a two-second dial nudge and the
builder would be overkill.

---

## Build order

1. Extract `simulateDay` from `dayCanvas`; prove `npm test` still passes. **Commit.**
2. Add `POST /api/plan/day/:n/simulate`. Add unit tests against the pure function — a
   weekend day, a workday with one stop, a workday with three stops, an infeasible day.
   **Commit.**
3. Extend `stopCandidates` with `fromMin` / `reachMi` and the arrival fields, keeping the old
   call sites working. **Commit.**
4. Add `POST /api/plan/day/:n/stops` (transactional replace). **Commit.**
5. Client: `mode: 'build'`, draft chain state, live timeline. **Commit.**
6. `work_short` readiness kind. **Commit.**

Steps 1–4 are shippable without any UI change and make the whole thing testable. If the
budget runs out after step 4, nothing is broken and the groundwork is real.

---

## Verification

Standing rule from `docs/ARCHITECTURE.md`: *run a review pass on anything substantial — the
plan engine has enough interacting state that plausible-looking code is regularly wrong.*
Phase 5 shipped and an adversarial pass then found 13 real bugs, including a replan that grew
the plan by a day every time it ran.

1. `npm test` green after **every** commit above, not just at the end.
2. The refactor in step 1 must be behaviour-preserving: capture `/api/plan/day/:n/canvas`
   JSON for days 1, 9, 19 and 39 **before** the change and diff after. Any difference is a bug.
3. Build Nick's real day 1: Perdido Key → work stop → Dauphin Island Campground, with the
   3:30pm ferry mark already on the canvas. The builder must show the ferry constraint and
   flag a chain that arrives at mile 86.5 after 3:30p.
4. Build his 19-hour example deliberately. Confirm it goes red rather than silently accepting.
5. Save a chain, reload, confirm it persisted as `planned_stops` rows and the canvas matches
   what the builder previewed. **Preview and saved state must agree exactly** — if they can
   diverge, the builder is lying.
6. Run a replan and confirm the day's stops survive by mile anchoring.
7. Review pass on the diff.

---

## Notes

- `canvas_marks` (the marks feature) is already implemented — `plan.mjs` ~line 721,
  `migrate.mjs` ~line 67. The builder should render existing marks on its timeline so a
  fixed appointment like the ferry is visible while composing. Do not re-implement it.
- Candidate data comes from `resources` (~9,881 rows, categories `wifi_work`, `campground`,
  `hotel`, with `wifi_status` and `off_route_mi`). Campground research also lives in
  `data/camping/camping.json` — the sleep picker already blends both; the builder should too.
- `stopCandidates` filters `off_route_mi <= 4`; `workOptions` uses `<= 3`. Pick one and say
  why in a comment, or expose it as a filter in build mode.
