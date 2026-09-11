# Brief: user-authored marks on the Day Canvas

**For Claude Code, in `~/App Projects/grimey-trip-planner`.**
Written 2026-09-11 from a Cowork session that could read the repo but not run it.
Nothing here has been typechecked. Treat it as a spec, not a patch.

---

## What Nick asked for

> I want to be able to add custom blocks, like on day one in particular. I know I'm going
> to need to meet the ferry at a certain time, and I just want to add that to that bar on
> the top. Custom little notes and blocks, and give me the option to color-code it however
> I want to: select the color · add a note for what it is · say what time it starts and
> stops · have it be either a block or a line.

---

## The one thing that must not be gotten wrong

**The existing blocks are mile-anchored and time-derived. What he is asking for is the
exact opposite: time-anchored and mile-indifferent.**

Look at `plan.mjs → addBreak()` (~line 610). It accepts `afterRideMin` / `afterMiles` /
`atMile`, converts all three to a **route mile**, and stores a row in `planned_stops`. The
block's position on the canvas is then *computed* by simulating the ride. That is correct
for a break: "45 minutes in" means 45 minutes of pedalling, so if Nick rolls out later, the
break slides later too.

A ferry departure does not work that way. **The 3:30 boat leaves at 3:30 whether or not he
is on it.** If this gets implemented as another `planned_stops` break, it will drift every
time he changes roll-out, which is precisely backwards — the whole point of drawing it on
the bar is that it is the fixed thing the ride has to meet.

So this is a genuinely new entity, not a variation on breaks. Do not reuse `planned_stops`.

---

## Where the code is

| Thing | File | Roughly |
|---|---|---|
| `Timeline` component — the bar itself | `web/src/Today.tsx` | ~line 125–245 |
| Block render loop (`c.blocks.map`) | `web/src/Today.tsx` | ~line 174 |
| Lanes: `tl-sky`, `tl-lane tl-obl`, `tl-lane tl-plan`, `tl-axis` | `web/src/Today.tsx` | ~143–240 |
| Vertical-line pattern to copy (`tl-until`) | `web/src/Today.tsx` | ~line 206 |
| Drag machinery (`beginDrag`, `drag.what`) | `web/src/Today.tsx` | ~line 125 + readout ~223 |
| `+ block` button and its panel | `web/src/Today.tsx` | ~line 532 and ~538 |
| "BREAKS & CUSTOM BLOCKS" section | `web/src/Today.tsx` | ~line 664 |
| `CanvasBlock` type | `web/src/types.ts` | line 95 |
| `DayCanvas.blocks` | `web/src/types.ts` | line 137 |
| Canvas assembly (`blocks.push`) | `server/today.mjs` | ~line 127–215 |
| `addBreak` | `server/plan.mjs` | ~line 610 |
| Routes | `server/app.mjs` | ~line 203–204 |
| Schema migrations | `server/migrate.mjs` | — |
| Styles (`tl-*`) | `web/src/styles.css` | — |

The ferry chip he pointed at ("Mobile Bay Ferry (Fort Morgan → Dauphin Island)") is a
**`route_transits`** row — see `migrate.mjs` ~line 41. Mile-anchored, has `minutes`, no
schedule. Relevant context, but do not overload that table for this feature.

---

## Data model

New table. Note `scope` — it is the interesting decision.

```sql
CREATE TABLE IF NOT EXISTS canvas_marks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT    NOT NULL,               -- 'day' | 'mile'
  day_number  INTEGER,                        -- set when scope='day'
  route_mile  REAL,                           -- set when scope='mile'
  label       TEXT    NOT NULL,
  shape       TEXT    NOT NULL DEFAULT 'block',  -- 'block' | 'line'
  color       TEXT    NOT NULL DEFAULT 'slate',  -- token name, NOT raw hex
  start_min   INTEGER NOT NULL,               -- minutes after local midnight
  end_min     INTEGER,                        -- NULL when shape='line'
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_canvas_marks_day  ON canvas_marks(day_number);
CREATE INDEX IF NOT EXISTS idx_canvas_marks_mile ON canvas_marks(route_mile);
```

**Why both scopes.** Nick said "day one in particular," so `scope='day'` is the literal ask
and should be the default in the UI. But `docs/ARCHITECTURE.md` is emphatic that anything
durable anchors to route miles so it survives replans, and day numbers renumber constantly.
A ferry schedule belongs to **mile 86.5**, not to "day 1" — if the plan shifts and the Fort
Morgan crossing lands on day 2, a day-anchored mark is now on the wrong day and silently
wrong.

Recommended behaviour: offer both, default to `day`, and when the mark's time window
overlaps a `route_transits` row on that day, **prompt once** — *"Pin this to the ferry at
mile 86.5 so it follows the crossing if your days shift?"* That is one question at the
moment it is obviously right, not a settings toggle.

Constraints worth enforcing server-side: exactly one of `day_number`/`route_mile` non-null
per `scope`; `end_min > start_min` when `shape='block'`; `end_min IS NULL` when
`shape='line'`; `start_min` in 0–1439.

---

## API

Mirror the existing shapes in `app.mjs` (~line 203):

```
POST /api/plan/day/mark          -> create   { scope, dayNumber|routeMile, label, shape, color, startMin, endMin, notes }
POST /api/plan/day/mark/update   -> edit     { id, ...same fields }
POST /api/plan/day/mark/remove   -> delete   { id }
```

Serve them on the canvas payload as a **separate array**, not mixed into `blocks`:

```ts
// types.ts
export interface CanvasMark {
  id: number;
  scope: 'day' | 'mile';
  label: string;
  shape: 'block' | 'line';
  color: MarkColor;
  startMin: number;
  endMin: number | null;
  notes: string | null;
  routeMile: number | null;
}
// add to DayCanvas:
marks: CanvasMark[];
```

Keeping them out of `blocks` matters: `blocks` is derived state the planner recomputes, and
`shiftFor()` (~line 134 in `Today.tsx`) slides ride and work blocks when Nick drags roll-out.
Marks must **never** take that shift — that is the whole point. A separate array makes it
impossible to get wrong by accident.

In `today.mjs`, select day-scoped marks by `day_number` and mile-scoped marks by
`route_mile BETWEEN day.start_mile AND day.end_mile`.

---

## UI

### Rendering

Add a lane between `tl-obl` and `tl-plan`:

```jsx
<div className="tl-lane tl-marks">
  {c.marks.filter(m => m.shape === 'block').map(m => (
    <div key={m.id} className={`tl-mark mk-${m.color}`}
      style={{ left: X(m.startMin/60), width: W(m.startMin/60, m.endMin!/60) }}
      title={`${m.label} · ${clockMin(m.startMin)}–${clockMin(m.endMin!)}${m.notes ? ' · ' + m.notes : ''}`}
      onClick={() => setEditingMark(m)}>
      <span className="tl-mark-label">{m.label}</span>
    </div>
  ))}
</div>
```

Lines render **full canvas height**, absolutely positioned over all lanes, so a 3:30 ferry
departure visibly crosses the ride block. Copy the `tl-until` pattern (~line 206) — it
already solves the flag-label-flips-left-near-the-right-edge problem via the `.flip` class.
Reuse that, including the flip threshold.

Clip to the visible window the same way blocks do: `if (z <= t0 || a >= t1) return null`,
and clamp with `Math.max(a, t0)` / `Math.min(z, t1)`. The canvas is not always 24h — the
"Show full 24 hours" toggle changes `t0`/`t1`.

### Creating and editing

The `+ block` button (~line 532) currently opens a panel containing only `<AddBreak>`.
Turn that panel into two choices — **Break** (existing, mile-anchored, time-derived) and
**Mark** (new, time-anchored) — with one line of copy distinguishing them, because the
difference is not obvious and it is the thing most likely to confuse him in six months:

> **Break** — time off the bike. Slides if you roll out later.
> **Mark** — a fixed appointment. Stays put whatever time you leave.

Mark form: label · shape (block/line toggle) · color swatches · start time · end time
(disabled when shape is line) · optional note. Use `<input type="time">` to match the
existing dials (~line 557).

Editing: click a mark to reopen the form. List them under "BREAKS & CUSTOM BLOCKS" (~line
664) with a ✕ to remove, matching the existing break-list markup.

Dragging a mark to move it is a nice-to-have — `beginDrag` already exists and takes a
`what` discriminator. Do it only after everything above works.

---

## Colour — read this before building a picker

He asked to "select the color however I want." **Recommend a fixed swatch palette of ~8
named tokens rather than a free hex picker**, and tell him why when you report back:

1. The canvas sits on a **live sky gradient** that changes per day and per latitude (see
   `skyGradient`, `tl-sky`). An arbitrary hex will be invisible against some skies and
   illegible against others.
2. Block labels are text on the fill. Free colour means unreadable text unless you also
   compute contrast, which is real work for little gain.
3. Eight swatches is still "however I want" in practice, and it keeps day 1 and day 40
   looking like the same app.

Define them as CSS custom properties in `styles.css` next to the existing `tl-*` rules,
each with a paired readable foreground:

```css
.mk-slate  { --mk: #64748b; --mk-fg: #fff; }
.mk-red    { --mk: #dc2626; --mk-fg: #fff; }
.mk-amber  { --mk: #d97706; --mk-fg: #fff; }
.mk-green  { --mk: #16a34a; --mk-fg: #fff; }
.mk-teal   { --mk: #0d9488; --mk-fg: #fff; }
.mk-blue   { --mk: #2563eb; --mk-fg: #fff; }
.mk-violet { --mk: #7c3aed; --mk-fg: #fff; }
.mk-pink   { --mk: #db2777; --mk-fg: #fff; }
```

Those first five already match `TIER_META` in the camping code, so the app keeps one colour
vocabulary. Store the **token name** in the DB, never the hex — that way a future palette
change updates every existing mark instead of stranding them.

If he still wants a raw picker after seeing it, add it as an "custom…" escape hatch that
stores hex and auto-picks black/white foreground by luminance.

---

## Phase 2 — the thing that makes this more than drawing

Once a mark is time-anchored and optionally mile-anchored, the app can **check it**.

`DayCanvas` already carries `readiness.issues[]`, rendered as chips (~line 512) with a
"Help me make this fit" button. Add an issue kind — `mark_missed` — raised when a mark is
mile-pinned and the simulated ride arrives at that mile **after** `start_min`.

That turns "meet the ferry at 3:30" from a note he has to remember into a constraint the
planner enforces: roll out late enough and the day lights up *"you reach mile 86.5 at 4:10,
the mark says 3:30."* Given the 2026 report of a rider stranded at Fort Morgan by a
cancelled boat, this is the highest-value part of the whole feature.

Do not build this until phase 1 is working and tested.

---

## Pre-existing things you will notice

- **`CanvasBlock.kind` looks out of sync with the server.** `types.ts` line 96 declares
  `'ride' | 'work' | 'slack' | 'break' | 'combo'`, but `today.mjs` pushes `'work_late'`
  (~144), `'daylight'` (~204) and `'dark'` (~211). Since the render does
  ``className={`tl-block tl-${b.kind}`}``, any kind without a matching CSS rule renders
  unstyled. Verify whether those extra kinds reach `c.blocks` or a different array — if they
  do, widen the union and add the CSS. Fix it in a separate commit from this feature.
- `web/src/dayplanStore.ts` and `DayPlanner.tsx` are referenced in older notes but no longer
  exist; the canvas now lives in `Today.tsx`. Ignore stale references.

---

## Verification before calling it done

`docs/ARCHITECTURE.md` and the project notes carry a standing rule: *run a review pass on
anything substantial — the plan engine has enough interacting state that plausible-looking
code is regularly wrong.* Phase 5 shipped and an adversarial pass then found 13 real bugs.

1. `npm test` stays green (28 assertions).
2. `npm run dev`, go to day 1, add a **block** mark 3:30–4:10pm called "Ferry — Fort Morgan",
   colour red. Confirm it renders in its own lane and does not overlap the RIDE block's label.
3. Add a **line** mark at 3:30pm. Confirm it crosses the full canvas height and its flag
   flips left near the right edge.
4. **The regression that matters:** drag roll-out earlier and later. Ride and work blocks
   must move. **Both marks must not.** If a mark moves, `shiftFor()` is being applied to it.
5. Toggle "Show full 24 hours" — marks clip correctly at both edges.
6. Create a mile-scoped mark, run a replan, confirm it still appears on whatever day now
   covers that mile.
7. Reload — everything persisted.
8. Review pass on the diff.
