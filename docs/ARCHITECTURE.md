# Grimey's Cross-Country Bike Trip Planner

## Phase 0 Deliverable: Research Findings, Architecture, and Implementation Plan

**Status:** Approved 2026-08-17 with amendments — see "Approved decisions" below. Phase 1 in progress.
**Date:** 2026-08-17

> **Approved decisions (2026-08-17):**
> 1. **No ACA purchase** ($119+ declined). Route foundation instead uses a tiered public strategy that turned out better than expected: parts of the Southern Tier corridor are officially designated as **U.S. Bicycle Route 90** (a public government route, legitimately in OpenStreetMap). Coverage: Florida (OSM rel 4264377, from FDOT open data) and Arizona (rel 5509062) are active designations; Alabama (rel 3317163) and Louisiana (rel 3317164) exist as proposed-corridor relations contributed to OSM by ACA's own USBRS coordinator. That covers ~40% of the ride with official/near-official public geometry. The gaps — Mississippi, Texas, New Mexico, eastern California, SD→LA — are reconstructed by bicycle-routing (BRouter, Valhalla fallback) between corridor towns attested in public ride journals, with per-segment provenance and confidence stored and displayed. Nothing is labeled official ACA geometry.
> 2. **Local-first confirmed** — SQLite + Express on Nick's machine; deployment considered later.
>
> **⚠ Finding from Phase 1 (needs Nick's decision): USBR 90 is not the Southern Tier.**
> The two routes share a general corridor but diverge materially. Verified: the ACA Southern
> Tier crosses the Florida panhandle **inland** along the US‑90 road corridor
> (Pensacola → Milton → Holt → Crestview → Mossy Head → DeFuniak Springs), while the USBR 90
> geometry now ingested runs **coastal** — west out of Pensacola to Perdido Key, then the
> Mobile Bay Ferry (Fort Morgan → Dauphin Island) across Alabama. Both are real, rideable
> routes; they are not the same route. The current build therefore models a *southern-corridor
> composite*, and the UI says so explicitly. Options: **(a)** keep the composite (official
> signed geometry where it exists, coastal Gulf riding, the ferry is a genuinely nice day);
> **(b)** reconstruct the ST alignment consistently everywhere from journal towns, making the
> whole route `reconstructed` but faithful to the Southern Tier; **(c)** build both — ST
> corridor as the Layer 1 canonical route, USBR 90 as a comparison layer, which is what the
> layered architecture was designed for. Recommend **(c)** eventually, **(b)** next if Nick
> wants the real Southern Tier sooner.
> 3. **Google enrichment deferred** — it was only ever an optional paid "live-check this place's hours right now" layer; the free storable sources carry Phases 1–3.
**Trip:** Pensacola, FL → (Southern Tier, ridden east-to-west) → San Diego, CA → (separate continuation leg) → Los Angeles, CA

---

## 1. Executive Summary

The single most important research finding changes how we build the route foundation:

> **The official Adventure Cycling Southern Tier geometry is proprietary, paid data — and it is deliberately absent from OpenStreetMap.** The OSM wiki explicitly states that ACA route data is copyrighted and that entering it into OSM violates OSM's license. There is no legitimate free source of the official geometry.

The good news: Adventure Cycling sells the Southern Tier as a **Digital Route product delivered through Ride with GPS**, which includes GPX data access for the purchaser. The clean, legal, and *best-quality* path is:

1. **Nick purchases the Southern Tier Digital Route Set** (member pricing available), exports the section GPX files from Ride with GPS for personal use, and drops them into a local, gitignored `data/private/` directory.
2. The app ingests those GPX files through a **GPX import pipeline**, stitches the seven sections into one east-to-west route, computes cumulative mileage, and marks provenance as `authoritative / purchased / personal-use-only`.
3. If Nick declines to purchase, the app falls back to a **reconstructed approximation** built from public corridor documentation plus a bicycle routing engine — clearly labeled `reconstructed`, never presented as official.

Everything else — places, campgrounds, elevation, weather — has excellent free, legally storable sources (OSM/Overpass, Overture Maps, Recreation.gov RIDB, USGS 3DEP, NWS). Google Places is optional enrichment only, used in a policy-compliant on-demand way, because Google prohibits bulk caching of Places results.

The architectural centerpiece is the **route-mile coordinate system**: every route point and every resource gets a precomputed cumulative mile and off-route offset at ingest time. After that, nearly every product question ("overnight options between mile 620 and 700", "work stops in the next 120 miles") becomes an indexed one-dimensional range query — no spatial database needed.

---

## 2. Research Findings

### 2.1 Route Data Reality

**The canonical Southern Tier:**

- Adventure Cycling describes the Southern Tier as a **San Diego, CA → St. Augustine, FL** route of roughly **3,078 miles**, divided into **seven sections**. Grimey rides it in reverse, joining at Pensacola (in the Florida section), so the personal route covers approximately sections 1–6 plus part of section 7 — call it roughly 2,500–2,600 route miles of Southern Tier, plus the SD→LA leg.
- ACA no longer sells standalone GPX files. **Digital Routes are delivered via Ride with GPS**: purchase grants access to the route in RWGPS, including GPX data packages, turn-by-turn navigation, service/POI waypoints, and ACA field notes. The purchaser can export GPX for personal use.
- **License reality:** ACA route data is proprietary. The OSM community documents that ACA routes must NOT be entered into OSM ("These route data are private (proprietary / copyrighted by ACA), so their entry into OSM violates our ODbL"). Only a few scraps exist in OSM, tagged `cycle_network=US:ACA` at regional level.

**Consequences for this project:**

| Rule | Implementation |
|---|---|
| Purchased GPX is for Nick's personal use | Files live in `data/private/` (gitignored); never committed, never redistributed, never served publicly. The app is a personal tool. |
| Provenance must be honest | Every Route row carries `provenance: authoritative-purchased \| reconstructed \| user-drawn`, plus source, URL, retrieval date, confidence, notes. |
| Fallback must exist | A reconstruction pipeline (public corridor towns + bicycle routing engine) produces an approximate route, labeled as such. |

**The San Diego → Los Angeles leg:**

- This corridor is part of the (also proprietary) ACA Pacific Coast route, but unlike the desert Southwest, it is **densely and publicly documented**: the Pacific Coast Bike Route through San Diego/Orange/LA counties follows well-known public infrastructure (Coronado ferry, coastal bike paths, PCH segments, beach paths into Santa Monica), with public guides and local agency bike maps.
- Plan: model it as a **separate Route object** (`st-continuation-sd-la`), built from bicycle routing + public documentation, provenance `reconstructed`, confidence high (it's hard to get lost between San Diego and LA). Optionally Nick can purchase the ACA Pacific Coast section covering it and import that GPX the same way.

### 2.2 Provider Landscape and Licensing

| Concern | Recommended provider | Cost | Can we store the data? | Notes |
|---|---|---|---|---|
| **Map rendering** | MapLibre GL JS + OpenFreeMap vector tiles | Free, no API key | n/a (tiles rendered live) | Protomaps/PMTiles or MapTiler free tier as swap-ins. No Google Maps dependency. |
| **Route geometry** | Purchased ACA GPX via Ride with GPS | Paid (one-time; member pricing) | Yes — locally, personal use only, gitignored | The authoritative path. |
| **Places / POI (primary)** | OSM via Overpass API | Free | **Yes** (ODbL, attribution required) | Brands (`brand=McDonald's`), `amenity=fast_food/cafe/library`, `tourism=camp_site` are well-tagged along the corridor. |
| **Places / POI (secondary)** | Overture Maps Places | Free | **Yes** (CDLA-Permissive 2.0; Foursquare-sourced rows Apache 2.0) | ~59M+ US-relevant POIs with brand/category/hours-ish attributes; downloadable as GeoParquet from AWS Open Data; can be permanently stored — this is our bulk-storable complement to OSM. |
| **Places enrichment (optional)** | Google Places API | Pay-as-you-go (has free monthly credit) | **Mostly no** — place IDs may be stored; most fields cacheable max ~30 days; display rules apply | Use strictly on-demand ("live check" in a detail panel, not map markers), never bulk-harvested. Optional; can be deferred indefinitely. |
| **Campgrounds (federal)** | Recreation.gov RIDB API | Free (optional free API key raises limits) | Yes (US Gov open data) | NPS/USFS/BLM/Corps campgrounds with amenities, addresses, reservation links. Supplement with OSM `tourism=camp_site` and per-state park sources. |
| **Bicycle routing** | OpenRouteService (hosted) | Free tier ≈ 2,500 req/day, 40k/mo | Route results usable | `cycling-regular` / `cycling-touring` profiles. Self-hostable via Docker (unlimited) if volume grows; BRouter and Valhalla are swap-in alternatives. Also emit Google Maps *bicycling-mode deep links* for handoff navigation (no API needed). |
| **Geocoding** | Photon (Komoot) or Nominatim public | Free | Light use | Nominatim public instance = absolute max 1 req/s, light personal use only. Our geocoding needs are tiny (occasional address lookup). |
| **Elevation** | USGS 3DEP: EPQS for spot queries; Open Topo Data (self-host) or downloaded 3DEP DEM tiles for full-route profiles | Free, public domain | Yes | EPQS is free/no-key but one-point-per-request — fine for spot checks, not for a ~50,000-sample route profile. Full profile = batch job against local DEM data (Phase 4). |
| **Weather (later)** | NWS `api.weather.gov` | Free, public domain | Yes | US-only, gridpoint forecasts including **wind speed/direction** — exactly what a westbound cyclist obsesses over. Phase 4. |

**The licensing punchline:** OSM + Overture + RIDB + USGS + NWS are all free and legally storable, so the app's *owned* resource database is built from those. Google is a thin, optional, on-demand freshness layer. The ACA GPX is treated like a private key: local, gitignored, never redistributed.

---

## 3. Recommended Stack

Chosen to match the tooling already used across Nick's projects (React 19 + TS + Vite + Express, ESM, npm):

| Layer | Choice | Why |
|---|---|---|
| Frontend | **React 19 + TypeScript + Vite** | House standard. |
| Map | **MapLibre GL JS** | Open-source, vector tiles, no key, excellent performance with GeoJSON sources + built-in clustering; provider-agnostic basemaps. |
| Geometry math | **@turf/turf** | `nearestPointOnLine`, `along`, `length`, `lineSlice`, `buffer`, `pointToLineDistance`, `simplify` — everything the route-mile system needs, in JS, offline-capable. |
| Backend | **Node 20 + Express (ESM)** | House standard; owns API keys, provider adapters, and ingestion pipelines. |
| Database | **SQLite via better-sqlite3** | Deliberate choice — see below. |
| Ingestion/CLI | Node scripts (`npm run ingest:route`, `npm run ingest:resources -- --category=wifi`) | Pipelines are batch jobs, not request handlers. |

**Why SQLite and not Postgres/PostGIS:** this is a single-user app with one route (~3,300 mi) and at most tens of thousands of POIs. The entire trip database is **one file** — trivially backed up, copied to the road laptop, and taken offline (a real requirement in west Texas). We avoid spatial-database complexity via the route-mile trick: each resource's `route_mile` and `off_route_mi` are computed **once at ingest**, then every corridor query is an indexed `WHERE route_mile BETWEEN ? AND ?` scan plus a category filter. A bbox prefilter + turf handles the few genuinely spatial operations. If the project ever outgrows this, the data model ports to PostGIS cleanly.

---

## 4. Core Data Model

All distances stored in **miles** (float), coordinates in WGS84. `id`s are UUIDs. Sketch (SQLite DDL abbreviated to the meaningful columns):

```sql
-- One trip. (There is exactly one Grimey, but no reason to hard-code that.)
Trip(id, name, start_date, rider_prefs_json,          -- min/max daily miles, etc.
     active_plan_revision_id)

-- A route layer. kind distinguishes the brief's Layers 1, 2, and 4.
Route(id, trip_id, kind,                              -- 'canonical' | 'personal' | 'actual'
      name, total_miles,
      provenance,                                     -- 'authoritative-purchased' | 'reconstructed' | 'user-drawn' | 'ridden-gps'
      source, source_url, retrieved_at, confidence, notes)

-- Ordered pieces of a route (e.g. the 7 ACA sections + the SD→LA continuation).
RouteSegment(id, route_id, seq, name,
             start_mile, end_mile,
             provenance, source, source_url, retrieved_at, confidence, notes)

-- Densified geometry. THE core table. mile is cumulative from Pensacola = 0.
RoutePoint(id, segment_id, seq, lat, lng,
           mile,                                      -- cumulative route mile (indexed)
           elevation_m NULL)                          -- populated in Phase 4, schema-ready now

-- Config-driven categories; corridor width and brand lists live here, not in code.
ResourceCategory(id, key,                             -- 'wifi_work', 'hotel', 'campground', 'bike_shop', ...
                 label, corridor_width_mi, icon, enabled,
                 search_config_json)                  -- brands, OSM/Overture query fragments, providers to use

-- One deduplicated real-world place.
Resource(id, category_id, name, brand NULL, lat, lng,
         address NULL, phone NULL, website NULL, hours_json NULL,
         route_mile,                                  -- nearest point on personal route (indexed)
         off_route_mi,                                -- straight-line offset from route
         detour_mi NULL,                              -- actual cycling detour distance (computed lazily)
         attributes_json,                             -- category-specific: wifi, showers, tent sites, power...
         wifi_status NULL,                            -- 'confirmed' | 'likely' | 'unknown' | 'none'  (uncertainty is first-class)
         status,                                      -- 'active' | 'closed' | 'unverified'
         first_seen, last_verified, user_notes NULL)

-- Provenance: one row per provider that knows about this place (dedup preserved, not discarded).
ResourceSource(id, resource_id, provider,             -- 'osm' | 'overture' | 'ridb' | 'google' | 'manual'
               provider_ref, source_url NULL,
               retrieved_at, confidence, raw_snapshot_json NULL)  -- raw_snapshot only where license permits

-- ===== Planned vs. actual: NEVER conflated =====

-- Every replan creates a new revision; history is immutable.
PlanRevision(id, trip_id, created_at, reason,         -- 'initial' | 'replan-after-day-N' | 'manual-edit'
             supersedes_revision_id NULL)

PlannedDay(id, plan_revision_id, day_number,
           start_mile, end_mile, planned_miles,
           start_label, end_label,
           end_anchor_resource_id NULL,               -- "the plan is to sleep AT this campground"
           lodging_resource_id NULL,
           notes, status)                             -- 'planned' | 'active' | 'completed' | 'modified' | 'skipped'

-- What actually happened. Written once per ridden day; never rewritten by replans.
ActualDay(id, trip_id, date, day_number,
          planned_day_id NULL,                        -- which plan it corresponds to
          start_mile, end_mile, actual_miles,
          end_lat NULL, end_lng NULL,                 -- where Grimey actually stopped
          end_resource_id NULL, notes)

-- Intermediate intentions within a day (lunch at this Krystal, work 3h at this library).
Stop(id, planned_day_id, resource_id NULL, lat, lng, route_mile,
     kind,                                            -- 'work' | 'food' | 'lodging' | 'resupply' | 'poi' | 'custom'
     planned_duration_min NULL, seq, notes)

-- Route conditions: canonical geometry vs. current rideability (brief §18).
RouteEvent(id, route_id, start_mile, end_mile, kind,  -- 'closure' | 'construction' | 'detour' | 'hazard' | 'seasonal'
           severity, description, detour_route_json NULL,
           source, source_url NULL, reported_at, resolved_at NULL)

UserLocation(id, trip_id, at, lat, lng, route_mile NULL,
             method)                                  -- 'gps' | 'pin' | 'address' | 'manual'
```

**Key invariants:**

1. `ActualDay` rows are append-only. Replanning **never** edits history.
2. A replan = new `PlanRevision` + fresh `PlannedDay` rows; old revisions remain queryable ("Planned Day 17: 74 mi / Actual Day 17: 61 mi" is a join, not an archaeology dig).
3. Every `Resource` has `route_mile` + `off_route_mi` computed at ingest against the **personal** route. If the personal route changes materially, a re-projection job recomputes them.
4. Distances that are estimates (e.g. `detour_mi` from a routing engine) are labeled as such in the UI.

---

## 5. Provider Abstraction

Server-side TypeScript interfaces; concrete adapters registered via config. API keys live in `.env` (server-only), never in client code.

```ts
interface RoutingProvider {        // ORS hosted → ORS self-host / BRouter / Valhalla
  bikeRoute(from: LatLng, to: LatLng, opts?: BikeRouteOpts): Promise<RouteResult>;
}
interface GeocodingProvider {      // Photon → Nominatim (rate-limited) → others
  geocode(query: string): Promise<GeocodeResult[]>;
  reverse(pt: LatLng): Promise<GeocodeResult | null>;
}
interface PlaceSearchProvider {    // Overpass, Overture, RIDB, (optional) Google
  searchCorridor(corridor: Polygon, query: CategoryQuery): Promise<RawPlace[]>;
  readonly storagePolicy: 'storable' | 'cache-30d' | 'id-only';   // enforced by the ingest layer, not by convention
}
interface ElevationProvider {      // EPQS spot / local-DEM batch
  elevations(points: LatLng[]): Promise<number[]>;
}
interface WeatherProvider {        // NWS (Phase 4)
  forecastAt(pt: LatLng, date: string): Promise<Forecast | null>;
}
interface BasemapProvider {        // OpenFreeMap → Protomaps → MapTiler (client config, style URL swap)
  styleUrl(theme: 'light' | 'dark'): string;
}
```

`storagePolicy` is the load-bearing field: the ingestion layer refuses to persist anything beyond a provider reference for `id-only` providers (Google), so license compliance is structural rather than a comment someone forgets.

---

## 6. Route Ingestion Pipeline

`npm run ingest:route -- --source=data/private/aca-st-section-*.gpx`

1. **Parse** GPX (tracks + ACA's service waypoints, which are themselves useful seed resources — kept local/private like the geometry).
2. **Orient & stitch:** reverse each section to east→west, join sections in order, detect/heal small junction gaps (< ~200 m snap; larger gaps flagged for review, never silently bridged).
3. **Trim** to the Pensacola start point (Mile 0 = Pensacola).
4. **Resample** to a consistent density (~50–100 m spacing) for stable mile math; keep a simplified copy (Douglas-Peucker) per zoom band for rendering.
5. **Compute cumulative miles** (haversine along the resampled line) → `RoutePoint.mile`.
6. **Validate:** total mileage sanity vs. published section mileages (±2%), self-intersection check, gap report.
7. **Store** with full provenance. The SD→LA continuation runs through the same pipeline (source: routing engine + public docs) and appends beyond the San Diego terminus mile.

Fallback reconstruction (if no purchase): geocode the publicly documented corridor towns → bicycle-route between consecutive towns via ORS → same steps 3–7, provenance `reconstructed`, confidence per-leg.

## 7. Resource Search Pipeline

`npm run ingest:resources -- --category=wifi_work`

1. **Corridor build:** buffer the simplified personal route by the category's `corridor_width_mi`; split into ~50-mile chunks (Overpass-friendly request sizes).
2. **Query providers** per chunk, per category config: Overpass (brand + amenity queries), Overture Places extract (bulk GeoParquet filtered to corridor bbox), RIDB (lat/lng radius per chunk) — each behind its adapter, throttled to provider limits.
3. **Normalize** to the `RawPlace` shape.
4. **Deduplicate:** candidate pairs by name-similarity (token sort ratio) within ~150 m; merge into one `Resource`, keep every `ResourceSource` row. Conflicting attributes resolved by provider trust order + recency; conflicts logged.
5. **Project onto route:** `nearestPointOnLine` → `route_mile`, `off_route_mi`; direction/backtrack derivable at query time from current position.
6. **Uncertainty pass:** `wifi_status` set to `likely` for known-Wi-Fi brands (config list), `confirmed` only from a verified source or Nick's own notes, else `unknown`. Never fabricated.
7. **Store** with provenance + `retrieved_at`. Re-runs upsert by provider ref (refresh, not duplicate).

`detour_mi` (true cycling detour) is computed lazily via the RoutingProvider for resources Nick actually inspects, cached with a timestamp — not precomputed for thousands of places.

## 8. The Replan Algorithm (Plan vs. Actual)

Anchor-based, not blind redistribution:

1. Nick records Actual Day *N* (endpoint by pin, resource, or "I rode X miles").
2. Compute the actual end mile; write `ActualDay` (immutable).
3. Diff vs. plan. If |Δ| < a small tolerance (default 3 mi), no replan needed — just record.
4. Otherwise draft a new `PlanRevision`: Day *N+1* starts at the actual end mile; **future days keep their end anchors** (the specific campground/hotel/town they targeted) and their mileages recompute from the shifted start.
5. **Feasibility check** per recomputed day: mileage within Nick's min/max band? Overnight anchor still reachable? If a day breaks, search the resource DB for alternative overnight anchors within the acceptable mile window and propose the smallest set of changed days — flagging any window that genuinely has *no* overnight option (a real situation in west Texas, and exactly what the brief says must be surfaced, not papered over).
6. Present the draft as a diff ("Days 41–43 change; Day 44+ unaffected"). Nick accepts (revision becomes active) or edits (manual overrides re-run the feasibility check).

## 9. Map Architecture and Performance

- **Layers** (independently toggleable, per brief §24): canonical route, personal route, actual route, per-day segments (colored by status: completed / active / future), then one layer per resource category.
- **Performance:** resources ship to the client as viewport + mile-window filtered GeoJSON (server-side filtering); MapLibre clustering above ~200 visible points; simplified route geometry per zoom band; detail panels fetch full records on click. Thousands of points stay smooth because the browser never holds the whole country.
- **Visual hierarchy** (§25): canonical = muted dashed; personal planned = solid primary; actual = solid contrasting overlay; current day highlighted; category-specific icons. Details at implementation.
- **Interactions:** click day ↔ highlight segment (bidirectional with the timeline view); click route point → "mile 412.3" + create stop/endpoint here; click resource → details, provenance, freshness, "directions" (in-app bike route preview + Google Maps bicycling deep link for the road).
- **Offline posture (Phase 4-ready, not Phase 1):** SQLite is already a local file; PMTiles basemap extracts along the corridor + a service-worker cache of the app shell + "cache next 3 days" action make degraded mode feasible without rearchitecting.

---

## 10. Phased Implementation Plan

**Phase 1 — Minimum Viable Map** (first working build)
Route ingestion pipeline (GPX import + fallback), route-mile system, MapLibre map with canonical/personal route layers, zoom/pan, section boundaries, mile markers, `wifi_work` + `campground` + `hotel` ingestion for the first ~500 corridor miles (Pensacola → Louisiana) as the proving ground, clustered markers, click-for-details with provenance display.
*Exit test: pan the whole route, click a McDonald's near Milton, see its mile, offset, and data source.*

**Phase 2 — Trip Planning**
PlannedDay CRUD, day-split UI on the map ("end Day 1 here"), timeline/table view ↔ map sync, resource-aware endpoint suggestions ("~70 mi → here are the overnight anchors between mile 60–80"), stops within days, full-corridor resource ingestion for all categories, per-category corridor widths.
*Exit test: a complete Pensacola→LA draft plan with lodging anchors on every night.*

**Phase 3 — Dynamic Trip Adjustment**
ActualDay recording, plan revisions, the replan algorithm + feasibility surfacing, plan-vs-actual history views, manual overrides.
*Exit test: "rode 54 of 80 planned miles" produces a sane, accepted revision without touching history.*

**Phase 4 — Advanced Cycling Intelligence**
Elevation profiles (local 3DEP batch job → per-day gain, climbs), RouteEvents/closures, NWS weather + wind by day-segment, current-position mode ("Where am I?"), offline caching, optional Google enrichment panel.

Each phase ends with a review checkpoint before the next begins.

---

## 11. Decisions Needed from Nick (before Phase 1)

1. **Buy the ACA Southern Tier Digital Route Set?** (~$50–120 depending on membership; one-time.) **Recommended** — it's the authoritative geometry plus ACA's own service waypoints, and the entire fallback reconstruction becomes unnecessary. If yes: purchase, export section GPX from Ride with GPS, drop into `data/private/`. The SD→LA leg we reconstruct either way (or add ACA Pacific Coast section 5 to the order).
2. **Local-first SQLite + Express app** (runs on your machine, DB is one portable file) — confirm this fits how you'll use it on the road, vs. wanting it hosted (hosted is possible later; local-first is the right start and the offline story is better).
3. **Google Places enrichment:** defer (recommended — OSM/Overture/RIDB cover Phase 1–3 needs), or set up a Google billing account now for the on-demand freshness layer.

---

## 12. Sources

- [Adventure Cycling — Southern Tier](https://www.adventurecycling.org/routes-and-maps/adventure-cycling-route-network/southern-tier/) · [Digital Routes](https://www.adventurecycling.org/routes-and-maps/digital-routes/) · [Southern Tier Digital Route Set](https://www.adventurecycling.org/shop/southern-tier-digital-route-set/) · [Digital Routes on Ride with GPS](https://www.adventurecycling.org/member_news/rolling-out-adventure-cycling-digital-routes-on-ride-with-gps/) · [Route Network FAQ](https://www.adventurecycling.org/routes-and-maps/route-network-faq/)
- [OSM Wiki — United States/Bicycle Networks](https://wiki.openstreetmap.org/wiki/United_States/Bicycle_Networks) (ACA routes proprietary, not in OSM)
- [Overture Maps — Attribution & Licensing](https://docs.overturemaps.org/attribution/) · [Places guide](https://docs.overturemaps.org/guides/places/) · [AWS Open Data registry](https://registry.opendata.aws/overture/)
- [openrouteservice — API restrictions](https://openrouteservice.org/restrictions/) · [Self-hosting docs](https://giscience.github.io/openrouteservice/run-instance/)
- [Recreation.gov RIDB API](https://ridb.recreation.gov/) (free federal campground data)
- [USGS EPQS API](https://epqs.nationalmap.gov/v1/docs) · [3DEP elevation FAQs](https://www.usgs.gov/faqs/what-types-elevation-datasets-are-available-what-formats-do-they-come-and-where-can-i-download)
- [Pacific Coast route (ACA)](https://www.adventurecycling.org/routes-and-maps/adventure-cycling-route-network/pacific-coast/) · [Pacific Coast Bike Route guides](https://www.biketheusforms.org/pacific-coast-bike-route/) · [cycleCalCoast PCBR](https://cyclecalcoast.com/rides/pcbr/)
