# Grimey's Cross-Country Bike Trip Planner

Trip planning and trip-management app for Grimey's Pensacola → San Diego (Southern Tier, east-to-west) → Los Angeles bicycle ride. Interactive map is the interface; the trip model (route miles, planned vs. actual days, resources with provenance) is the product.

**Current status: Phases 1–4 working, on the true current ACA Southern Tier corridor
(2021+ editions), rebuilt 2026-08-18 from public research.** 2,972.5-mile route
(2,833 Pensacola→San Diego via New Orleans, Baton Rouge, Emory Pass, and the Gila
corridor + 139.5 SD→LA), 9,881 resources over the full corridor, US-only corridor
towns for naming, interactive map, and the full trip-plan loop (days capped at a rider-set ceiling, default 65 mi, with
climbing days shortened automatically via an effort model): auto-built days anchored to real overnight options, endpoint
suggestions, day splitting, actual-day recording, and anchor-preserving replans
(append-only plan revisions — history is never rewritten). Phase 4 adds:
**phone-first layout** (map fullscreen, bottom-sheet UI), **Ride Mode** (GPS or
manual position → route mile, off-route warning, miles to tonight's stop, next
45 mi of resources, follow camera), **resource detail cards** with Apple
Maps/Google Maps (bicycling) deep links, **elevation** (full-route USGS NED 10m:
per-day gain/loss + profile sparkline), and **weather + wind** (NWS forecast per
upcoming day with headwind/tailwind/crosswind vs. the day's travel direction;
set the trip start date in the Trip days tab).

Navigation philosophy: this app owns *route-following* (Apple/Google don't know
this route exists); turn-by-turn to any specific stop is a one-tap handoff to
Apple/Google Maps via deep links — no routing API, no keys, no stored provider data.
Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for research findings, data model, provider strategy, and the phased plan — including the open question about route alignment.

## Run it

```bash
npm install --cache /tmp/npm-cache
npm run ingest:route                        # builds the route into data/trip.sqlite
npm run ingest:resources -- --maxMile=2975  # corridor search via OpenStreetMap
npm run ingest:places                       # corridor towns/cities for day names
npm run ingest:elevation                    # USGS NED 10m via opentopodata (rate-limited, ~3 min)
npm run ingest:notes                        # rider notes (ferries, detours, dry stretches) → route miles
npm run dev                                 # web on :5179, API on :5181
```

Note: browser GPS (Ride Mode) requires HTTPS or localhost. On a phone over plain
LAN http, use "Set on map" or the mile input — or serve the app over HTTPS
(e.g. Tailscale serve) when the trip actually starts.

## Trip-plan API

- `GET /api/plan` — active plan + actuals + per-day geometry, elevation, rider notes
- `POST /api/plan/auto {maxMiles, fromScratch}` — (re)build days. Keeps every day
  you have locked and re-cuts only the road ahead, unless `fromScratch: true`.
- `GET /api/plan/suggest?fromMile&target&window&ignoreCap` — scored endpoint
  candidates with full contact details
- `POST /api/plan/day` — move a day's endpoint (trades miles with the next day)
- `POST /api/plan/day/split` / `.../merge` — split one day into two, or fold it into the next
- `GET /api/plan/day/:n/itinerary` — the day's timeline: legs, stops, arrival times
- `GET /api/plan/day/:n/stop-candidates?fromMile&cats` — reachable stops with ride times
- `POST /api/plan/stop` / `.../update` / `.../remove` — build the day's itinerary
- `POST /api/plan/day/start-time` — when you roll out that morning
- `POST /api/plan/day/complete` / `.../unlock` — lock a day as ridden, or release it
- `GET /api/plan/fit` / `POST /api/plan/fit` — given the depart + arrive dates,
  find the lowest daily ceiling that still lands on time (GET proposes, POST applies)
- `POST /api/actual {dayNumber, endMile}` — record what actually happened
- `POST /api/actual/replan` — record it *and* return the proposed reshuffle in one call
- `GET /api/replan/preview?mode=` / `POST /api/replan/apply {mode}` — `rebuild`
  re-cuts every remaining day under the cap; `anchors` keeps chosen lodging and
  only shifts mileage. Nothing commits until apply.

### Planning a single day

Open a day and use **Plan this day**: set a departure time, then add stops. The
picker lists everything reachable further along that day, labelled with how long
the ride there takes (chips for ~1h / ~2h / ~3h / ~4h), so "ride three hours to a
coffee shop, work till noon, ride on" is a couple of taps. Each stop shows its
arrival time and takes a *leave* time — dwell is derived, because that is how
people actually think about a stop. Ride times use the effort model, so climbing
stretches take longer than flat ones.

Stops are stored against route miles rather than day numbers, so they survive
replans and renumbering, and they always sort geographically — there is nothing
to drag and nothing to reorder.

### Dates

Set a depart date and an arrive-by date and the plan is measured against the
calendar: available days, projected arrival, spare days, and the average needed.
When the route doesn't fit, **Fit to dates** finds the lowest daily ceiling that
does and rebuilds — the mileage cap is negotiable against the calendar, and the
app says exactly what the trade costs. Note that the required *cap* always sits
above the required *average*, because days are anchored to real lodging and
climbing days are deliberately shortened.

### Day shaping

Days never exceed `maxDayMiles` (a setting; default 65). Within that ceiling the
planner aims at a constant *effort* budget where **1 mile ≈ 100 ft of climbing**,
so flat days stretch toward the cap and mountain days come out shorter on their
own. Days that end nowhere useful are flagged (`no_anchor` / `very_short` /
`over_cap`) rather than silently "fixed" — and any flag can be overridden by
merging days or dragging a boundary, because the rider is allowed to decide.

Both ingest scripts cache aggressively (`data/route/*-cache.json`), so re-runs are cheap and safe. Overpass occasionally returns 504 for a chunk — just re-run, it upserts rather than duplicating.

## Route provenance — read this

This follows the **current ACA Southern Tier corridor (2021+ editions)**,
reconstructed from public sources. Solid segments are OpenStreetMap USBR 90
geometry used *only* where it is verified concurrent with the Southern Tier
(coastal FL/AL with the Mobile Bay Ferry, New Roads→Merryville LA,
Morristown→Ehrenberg AZ). Dashed segments are bicycle-routed between towns
attested by ACA's public pages and 2007–2026 ride journals: right corridor,
right towns, approximate streets — never claimed as official ACA geometry.
Includes ACA's official Pearl River detour (US 90 bridge closed since 2022).
Every segment stores its source, confidence, and retrieval date, shown when you
click it.

If Adventure Cycling GPX is ever purchased, it goes in `data/private/` — gitignored, personal use only, never committed or redistributed.
