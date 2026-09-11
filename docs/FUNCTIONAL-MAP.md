# Grimey's Trip Planner — Functional Map

**A brief for UX review.** Everything the app does, surface by surface: a single-rider
planning and navigation tool for one 2,972-mile bicycle tour from Pensacola to Los
Angeles, ridden while working remotely along the way.

| | |
|---|---|
| **Route** | ACA Southern Tier |
| **Distance** | 2,972.5 mi |
| **Current plan** | 53 days (plan revision 21) |
| **Departs** | 21 September 2026 |
| **Users** | One rider |
| **Surfaces** | 5 tabs + a shared map |

*Compiled 28 August 2026 from the live application.*

---

## 00 · What it is

Not a general-purpose route planner. It is a bespoke tool for one named trip, one
rider, and one set of constraints that no commercial app can express.

The rider is cycling the Adventure Cycling Association's Southern Tier from Pensacola,
Florida to San Diego, then continuing up to Los Angeles — departing 21 September 2026,
currently laid out as 53 riding days. He is **working a remote job while riding**, which
is the constraint that shapes almost every design decision in the app: a day is not
just "how far can I ride", it is "where can I sit with wi-fi for a work block, and still
reach a bed I can afford".

There are no accounts, no onboarding, and no concept of a second trip or a second user.
Authentication is a single shared phrase typed once per device, and it gates writing,
not reading. The app assumes it is being used in exactly two situations: at a table with
a laptop planning ahead, and one-handed on a phone at the roadside.

Everything is anchored to **route mile** — a number from 0 to 2,972.5 measured along the
traced route. Days get renumbered constantly as the plan changes, so nothing durable is
keyed to a day number. A campground sits at mile 1,986 forever, regardless of which day
the rider reaches it.

---

## 01 · Shell anatomy

One persistent map, one panel of five tabs. The panel is a sidebar on a laptop and a
bottom sheet on a phone; the map never unmounts or reloads between tabs.

```
DESKTOP / LAPTOP                          PHONE
┌──────────┬─────────────────┐            ┌──────────────────┐
│ Panel    │                 │            │                  │
│ title ·  │                 │            │       Map        │
│ 2,972 mi │                 │            │                  │
│ ┌──────┐ │                 │            ├───── ▬▬▬ ────────┤  drag to collapse
│ │5 TABS│ │   Map canvas    │            │  Bottom sheet    │
│ └──────┘ │  always mounted │            │  ┌────────────┐  │
│ ┌ ─ ─ ─┐ │                 │            │  │same 5 tabs │  │
│ │active│ │                 │            │  └────────────┘  │
│ │ tab  │◄┼──── two-way ────┤            │  thumb-reachable │
│ │scroll│ │                 │            │  short labels    │
│ └ ─ ─ ─┘ │                 │            │                  │
└──────────┴─────────────────┘            └──────────────────┘
   OVERLAYS: resource detail card · map popups
```

The panel and the map are peers, not parent and child: tapping a marker fills the panel,
and selecting a day in the panel flies the map. Layer visibility is scoped per tab, so
each tab shows only its own concern on the shared canvas.

**Persistent chrome**

- Trip title, subtitle (*Pensacola → San Diego → Los Angeles*), and total mileage badge.
- Five-tab bar: **Day plan · Trip days · Camping · Ride · Route**.
- A drag handle that collapses the panel to give the map the full screen.
- A resource detail card that can open over any tab.
- A load-failure banner naming which data feed broke.

---

## 02 · The five surfaces

Tab order is deliberate and follows the rider's distance from the decision: today's plan
first, the whole trip second, sleep third, the saddle fourth, and the route's own
provenance last.

### Tab 1 — Day plan *(default)*

The primary workspace: one full page per day, built around the rider's actual rhythm —
ride, work, ride, sleep — with money planned in the same breath as distance.

**What it does**

- **One day at a time.** Pager arrows, a day title (*Day 12 of 53*), the date, the miles,
  and an estimated riding time from a configurable average speed.
- **A fixed daily skeleton** the rider fills in: Start → *Ride today* distance → Morning
  leg → Midday stop → Afternoon leg → Sleep tonight → Other spend → day budget.
- **Start is never editable.** Each day begins exactly where the previous day ended; a
  link jumps back to adjust the day before. Every change cascades forward automatically.
- **Distance slider** (20–95 mi) sets the day's target — unless lodging is chosen, in
  which case the day's length is *pinned* to that bed's mile, the slider disables, and an
  "unpin" link explains why.
- **Midday stop picker** — the work block. Suggests wi-fi venues that fall inside the
  day's miles, scored by wi-fi confidence, closeness to the day's midpoint, and detour
  distance. Top 3 shown, "show all" expands and also plots them on the map.
- **Lodging picker** — hotels and campgrounds within 15 miles of the day's target end,
  scored by proximity and detour. Campground picks carry across their guide notes.
- **Cost entry on every slot** — preset chips tuned per type (campsites $0/10/20/35,
  rooms $60/80/100/130) plus a free numeric field, and a separate "other spend today" line.
- **Rest days** — insert after any day or remove; a rest day rides zero miles and keeps
  the previous night's bed.
- **Conflict warnings** in plain language when an earlier edit has stranded a choice:
  lodging now behind the day's start, or a midday stop that no longer falls inside the ride.
- **Trip roll-up** — total budget, day count, average per day, miles covered against
  total, and a strip of numbered day chips showing each day's cost, rest status, and
  conflict state.
- **Sync status bar** — saved / saving / offline / locked, with the time and which device
  saved last, plus a retry action and the trip-key unlock field.

**Why it's built this way**

Days are a chain, not a list. Because a day's start is derived rather than stored, there
is no way to create an impossible plan where day 12 begins somewhere day 11 never reached
— the model makes the error unrepresentable instead of validating against it after the fact.

Cost sits inside the day rather than in a separate budget screen because on a self-funded
tour the two decisions are the same decision: a cheaper night is usually a longer ride or
a worse bed.

### Tab 2 — Trip days

The whole-trip schedule, driven by a server-side planning engine. Where *Day plan* is
hand-crafted, this is generated, revisioned, and argued with.

**Schedule & feasibility**

- Plan summary: day count, average miles per day, revision number and the reason it was
  created.
- Progress line once riding starts: days ridden, miles done, and how many miles **ahead
  of or behind plan**.
- **Depart** and **Arrive by** date fields, feeding a schedule verdict: calendar days
  available versus days the plan needs, spare days or days late, projected arrival, and
  the average daily mileage required.
- Three-state urgency — comfortable, tight, or late — with explicit copy when there is no
  slack: *one weather day, mechanical, or short day puts you behind.*
- **"What would it take?"** computes the daily ceiling needed to land on the arrival date
  and reports it as a proposal. A separate **Fit to dates** action applies it.
- **Max mi/day** ceiling, and a rebuild that preserves already-ridden days
  (*Rebuild from day 14*).

**Work-aware planning**

- A toggle to **shorten weekdays to fit a work day**.
- **Check work schedule** previews how many work days can actually be scheduled and which
  days conflict; **Auto-plan every day** commits intra-day itineraries across the trip.

**Per-day detail & editing**

- Each day expands to miles, endpoints, status, an **elevation profile** microviz with
  hover readout, and ferry or detour icons.
- **"What to expect"** — curated rider notes for that stretch (ferry, detour, highway, no
  services, climb, bridge, traffic, trail, caution) each carrying its source and a
  confidence level.
- **Nudge the endpoint** — preset ± mile buttons or an exact mile entry. Miles shaved off
  tomorrow's front land on today's back.
- **Split** a day in two, or **merge** it with the next.
- **Endpoint suggestions** — real lodging near the day's end, with hours and detour, one
  tap to end the day there.
- **Intra-day itinerary** — depart time, ordered stops with arrival and departure times,
  work hours held at a stop, and an add-stop picker filtered by category and desired
  hours. Stops sort by route mile because you cannot reach mile 250 before mile 224 — so
  there is nothing to drag.
- **Record actuals** — the mile where the day really ended plus notes, which immediately
  proposes a reshuffle of everything after it.
- **Replan preview** in two modes — *rebuild* (recompute from here) or *anchors* (keep the
  booked beds, move the days) — shown side by side before anything is committed, with
  *Keep current plan* as an equal option.
- **Complete** and **unlock** individual days.

**Why it's built this way**

Every destructive action has a non-destructive twin. "What would it take?" precedes "Fit
to dates"; a replan preview precedes a replan; a work-schedule check precedes
auto-planning. The rider is never asked to accept a change they haven't seen the cost of.

Plan revisions are append-only and each carries a written reason, so the plan has a
history rather than a state. Nothing the rider built is ever silently overwritten.

Scores and confidences are shown rather than hidden. The engine ranks candidates on
*effort miles* — a flat-equivalent distance that charges for climbing — but it surfaces
the number instead of presenting its pick as the answer.

### Tab 3 — Camping

Answers a different question from the schedule tabs: not "where do I ride" but "where do
I sleep tonight, is it legal, and what does it cost".

- Two views: **Nights** (per-day options) and **Rules & tips** (reference).
- Per night, every researched spot within 20 miles behind or 20 miles past the day's
  planned end, sorted by price then proximity.
- Each spot carries a **price tier** — free, budget, moderate, high, unknown — plus its
  distance offset from the day's end, whether tents are allowed, water, showers, toilets,
  a legality note, a seasonal note, cyclist-specific intel, booking method, phone,
  website, sources, and a confidence level.
- **Gap nights** are called out explicitly — *"No verified campsite in reach"* — with
  written advice for that specific stretch rather than an empty list.
- A **best bet** recommendation per night where the research supports one.
- Actions per spot: **Map** plots it on the shared canvas; **end the day here** commits it
  back into the trip plan.
- Trip summary: total nights, nights with options, free nights, gap nights, and an
  estimated minimum lodging cost.
- Reference view: corridor-wide tips, state-by-state rules on where sleeping is actually
  permitted, and programs and fallbacks with their sources.

**Why it's built this way**

Camping data is anchored to mile, never to day, and re-joined to the current plan on every
request. When the schedule changes, the guide follows automatically — no re-ingest, no
stale night numbers.

A gap is treated as information, not as an absence. Knowing there is nothing for 40 miles
is more actionable than an empty list, so the app writes the gap down and offers advice
for it.

### Tab 4 — Ride

In-the-saddle mode. Keeps the rider on their line and answers the questions a general
mapping app cannot, because it has never heard of this route.

- Three ways to establish position: **live GPS**, **tap the map**, or **type a mile**.
- Any position is projected onto the route and reported as a **route mile**, plus how far
  off-route the rider currently is and the nearest named place.
- **Today's day**: which planned day covers this point, its destination name, miles
  remaining to the end, and tonight's booked overnight — or an honest "no planned day
  covers this point".
- **Rider notes ahead** for the next 45 miles, distinguishing notes that are active right
  now from ones still ahead.
- **"Ahead of you"** — every resource in the next 45 miles, filterable by category, each
  showing miles ahead, detour distance, and wi-fi status. Tapping one opens its full
  detail card.
- **Follow mode** keeps the map centred on the rider as the position updates.

**Why it's built this way**

Position is computed **on the phone** from route data cached in the browser, not by asking
the server. Long stretches of West Texas and southern New Mexico have no usable signal,
and a navigation screen that needs a network round-trip per GPS fix is worthless exactly
where it matters most.

Distances are framed as "miles ahead" rather than as coordinates or ETAs, because the only
question in the saddle is whether something is reachable before dark.

### Tab 5 — Route

The app's disclosure layer. The route is a reconstruction, and this tab exists so the
rider always knows which parts are verified and which are inference.

- All 11 route segments listed with a colour swatch, name, and mileage; tapping one zooms
  the map to it.
- Four **provenance classes**, each with its own line treatment on the map: official
  public geometry, proposed concurrent geometry, reconstructed and journal-attested (drawn
  dashed), and the San Diego → Los Angeles continuation (also dashed).
- Every segment's popup carries its source, a confidence level, a link to the source, and
  notes.
- **Resource layer toggles** with live counts for wi-fi/work, campgrounds, and hotels.
- A written statement of exactly what is and is not claimed — including that dashed
  sections have the right corridor and towns but approximate streets, and that the
  official Pearl River bridge detour is included.

**Why it's built this way**

Adventure Cycling's actual GPS data is a paid product and cannot be redistributed, so this
route was rebuilt from public pages, OpenStreetMap's verified concurrent sections, and
2007–2026 ride journals. Presenting that as one confident line would be a lie the rider
discovers at a closed bridge. Instead uncertainty is drawn into the map itself — dashes
mean "trust the towns, verify the streets".

---

## 03 · The map canvas

A single MapLibre canvas shared by all five tabs, on a free OpenFreeMap base style.
Layers are switched by tab rather than rebuilt.

| Layer | What it shows | Shown on |
|---|---|---|
| `route line + casing` | The route, coloured by provenance, with a white casing for contrast and a dashed overlay on reconstructed sections | All tabs |
| `mile markers` | Points and `mi 1240` labels, revealed as you zoom in | All tabs |
| `resource clusters` | Wi-fi, campgrounds, hotels as separate clustered sources — counts collapse at low zoom, individual pins appear at high zoom | All tabs, per toggle |
| `plan day bands` | Each planned day as a thick band under the route, alternating colours, greyed once completed; the selected day highlights in yellow | Trip days |
| `day boundaries` | Points and labels where each day starts and ends | Trip days |
| `camping spots` | Tier-coloured circles with a tent glyph and names at high zoom | Camping |
| `day section` | The open day's stretch of route, plus its candidate stops and chosen stops | Day plan |

**Interactions**

- Tap a resource pin — opens a popup *and* fills the detail card in the panel.
- Tap a cluster — zooms in two levels rather than listing its contents.
- Tap a route segment — shows its provenance, confidence, and source.
- Select a day in the panel — the map flies to it. Selecting on the map does *not* move
  the camera, so the rider never loses their place.
- **Map-pick mode** — some panel actions arm the map so the next tap returns a location,
  used for setting position in Ride mode and choosing stops.

---

## 04 · Systems & data

### What's in the box

| Dataset | Count | Notes |
|---|---:|---|
| Wi-fi / work stops | 7,162 | Cafés, libraries, restaurants — each with a wi-fi confidence: documented, likely by brand policy, unknown, or reported none |
| Hotels & motels | 2,111 | With address, phone, website, hours where known |
| Campgrounds | 608 | Plus amenity attributes such as showers |
| Curated camping spots | 164 | Hand-researched, with legality, seasonality, and cyclist intel; 53 per-night advice entries and state-by-state rules |
| Route points | 68,788 | Each with elevation, giving per-day climb and profiles |
| Named places | 249 | Weighted by size, so a village 1 mile away beats a city 7 miles away when naming a spot |
| Rider notes | 33 | Across 9 kinds: ferry, detour, highway, no services, climb, bridge, traffic, trail, caution |
| Route segments | 11 | Each with its own provenance and source |

### The planning engine

- **Effort miles.** Days are compared by flat-equivalent distance rather than raw distance
  — climbing is charged at a fixed rate, so a hilly 45-mile day and a flat 65-mile day
  rank as equal work. This is the trade the rider's legs actually make.
- **Anchor scoring.** Candidate overnights are ranked on how closely they hit the effort
  target, penalised for detour distance, and rewarded for nearby wi-fi and for showers.
- **Day shape.** Rider-tunable minimums, maximums, and effort targets, stored so they
  survive replans.
- **Append-only revisions.** Every rebuild creates a new numbered revision with a written
  reason; earlier ones remain.
- **Weather.** National Weather Service forecasts joined onto the plan, with a hard 7-day
  horizon — days beyond it report no forecast rather than inventing one.

### Multi-device state

The trip is edited from two places — a laptop while planning and a phone on the road — so
the plan lives on the server and every read and write also hits a local cache on the
device. The panel always shows which state it is in: **saved** (with the time and which
device saved last), **saving**, **offline — saved on this device only** with a retry, or
**locked** pending the trip key.

Writing requires a shared phrase entered once per device; reading never does. Losing
signal degrades to "keep planning, sync later" rather than to data loss.

---

## 05 · Design intentions

The rules the app holds itself to. Most of the interface follows from these rather than
from a screen-by-screen brief.

| Intention | |
|---|---|
| **One trip, one rider** | No accounts, no trip switcher, no generalisation. Every screen can assume this trip, these dates, this rider's job. |
| **Mile-anchored, never day-anchored** | Days renumber constantly; miles don't. Anything durable is keyed to route mile so the plan can be rebuilt without corrupting the research. |
| **Derive, don't store** | A day's start is computed from the previous day's end, so impossible plans cannot be represented — no validation pass needed. |
| **Preview before commit** | Every action that changes the plan has a non-destructive counterpart that shows the trade first, with "keep current plan" as an equal choice. |
| **Nothing is overwritten** | Plan revisions are append-only and reasoned, so the plan has a history the rider can fall back to. |
| **State uncertainty, don't hide it** | Provenance on route lines, confidence on notes and campsites, sources on everything, and "no forecast" instead of a guess. Dashes on the map mean "verify this". |
| **Work is a first-class constraint** | The midday wi-fi block is part of the day's skeleton, not an afterthought, and the engine can shorten weekdays to protect it. |
| **Money alongside distance** | Cost is entered inside the day being planned, because the two decisions are one decision on a self-funded tour. |
| **Offline where it matters** | Riding works with no signal; planning assumes a connection. The split follows the consequence of failure, not technical convenience. |
| **Phone-first for the road** | Bottom sheet, thumb-reachable controls, short labels, presets before free text — because the alternative context is one hand on a bike at a roadside. |
| **Decision support, not automation** | Scores, distances, and confidences are shown rather than resolved silently. The app ranks; the rider decides. |
| **Link out, don't scrape** | Live hours, photos, and turn-by-turn are handed to Apple or Google Maps on the rider's own device, in the provider's own app. |

---

## 06 · Seams to review

Structural facts a reviewer should know before judging the interface — these are
properties of the app as built, not bugs.

> ### ⚠ The app contains two different plans
>
> **Day plan** (tab 1) and **Trip days** (tab 2) are separate data models that both answer
> "how long is each day and where do I sleep". Tab 1 is a hand-edited document derived in
> the browser; tab 2 is generated by the server engine and stored as numbered revisions.
>
> They touch exactly once: the first time tab 1 is ever opened, it seeds itself from the
> engine's plan so the rider doesn't start from a blank slate. After that they diverge
> permanently and never reconcile.
>
> Downstream, they are consumed inconsistently by design: **Ride mode follows the Day
> plan** when one exists, falling back to the engine plan; **Camping's "end the day here"
> writes to the engine plan**. Editing a day in tab 1 and rebuilding in tab 2 produce two
> different answers to the same question, and the interface does not currently say which
> one is authoritative.

- **Two overlapping ways to set day length.** The distance slider in tab 1 and the
  nudge/split/merge controls in tab 2 both move day boundaries, through different
  mechanisms.
- **Density on a phone.** Tab 2's expanded day carries elevation, notes, six editing
  controls, suggestions, and an actuals form in a bottom sheet.
- **Cost lives in one plan only.** Budgeting exists in tab 1; the engine plan has no
  concept of money, and camping costs are estimated separately again in tab 3.
- **The trip key is the only gate.** One shared phrase, entered per device, with no
  recovery path and no per-device revocation.
- **Some engine actions are irreversible in the UI.** Revisions are kept server-side, but
  there is no in-app way to roll back to an earlier one.
- **Wi-fi confidence is four-valued** (documented / likely / unknown / none) and appears as
  a small glyph — a distinction the planning depends on but the interface barely weights.

---

## 07 · Functional surface

Every capability the app exposes, as its API. Useful as a completeness checklist — if a
capability isn't here, the interface can't offer it.

**Reference data**

```
GET  /api/route · /api/resources · /api/categories · /api/summary
GET  /api/route/points      route geometry for a mile window
GET  /api/position          project a coordinate or mile onto the route
```

**The schedule**

```
GET  /api/plan                     the whole schedule, with geometry and progress
GET  /api/plan/suggest             scored endpoint candidates for a window
GET  /api/plan/auto/preview
POST /api/plan/auto                generate a plan
GET  /api/plan/fit
POST /api/plan/fit                 what ceiling hits the arrival date
POST /api/plan/day                 move a day boundary
POST /api/plan/day/split
POST /api/plan/day/merge
POST /api/plan/day/complete
POST /api/plan/day/unlock
GET  /api/plan/day/:n/profile      elevation profile
GET  /api/plan/day/:n/itinerary
GET  /api/plan/day/:n/stop-candidates
POST /api/plan/stop
POST /api/plan/stop/update
POST /api/plan/stop/remove
POST /api/plan/day/start-time
GET  /api/plan/itinerary/auto
POST /api/plan/itinerary/auto      work-aware scheduling
```

**Reality vs plan**

```
POST /api/actual                   record where a day really ended
GET  /api/replan/preview
POST /api/replan/apply             rebuild, or keep anchors
POST /api/actual/replan            record and reshuffle in one call
```

**Everything else**

```
GET  /api/dayplan
POST /api/dayplan                  the shared day-plan document
GET  /api/camping                  nights, options, gaps, rules
GET  /api/settings
POST /api/settings                 dates, ceilings, speed, work-aware
GET  /api/weather                  NWS forecast joined to the plan
```

---

*Grimey's Trip Planner · functional map compiled 28 August 2026 from the live
application. Counts and the 53-day plan reflect plan revision 21.*
