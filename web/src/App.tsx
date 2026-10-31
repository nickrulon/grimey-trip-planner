import { useCallback, useEffect, useRef, useState } from 'react';
import { localISODate } from './format';
import maplibregl, { Map as MLMap, MapGeoJSONFeature } from 'maplibre-gl';
import Today from './Today';
import Ask from './Ask';
import Trip from './Trip';
import Ride from './Ride';
import More from './More';
import ResourceDetail, { ResourceInfo } from './Detail';
import MapPicker, { PickerContext } from './MapPicker';
import { apiGet, getTripKey, setTripKey, onSync, SyncStatus } from './api';
import { PlanResponse, PositionInfo } from './types';
import ALTERNATES from './alternates.json';
import ALT_POIS from './alternate-pois.json';
import OLD_ROUTE from './old-route.json';

// Shell: one persistent map canvas, three core surfaces over it —
//   TODAY  (time)   what exactly happens today?
//   TRIP   (days)   does the whole trip work; which days need attention?
//   MAP    (space)  where are the route, resources, warnings, beds, work?
// — plus RIDE (the roadside dashboard) and MORE (reference & settings).
// The map never unmounts; content surfaces are opaque pages laid over it.

export type Surface = 'today' | 'trip' | 'map' | 'more' | 'ride' | 'ask';

const CAT_META: Record<string, { label: string; color: string }> = {
  wifi_work: { label: 'Wi-Fi / Work', color: '#b06000' },
  campground: { label: 'Campgrounds', color: '#4f7942' },
  hotel: { label: 'Hotels / Motels', color: '#5b4a92' },
  // Gas stations, convenience stores and travel centres. In the desert west of
  // Gila Bend these ARE the water stops, and none of them were in the app.
  resupply: { label: 'Resupply (fuel / store)', color: '#b91c1c' },
};

const PROV_META: Record<string, { label: string; color: string; dashed?: boolean }> = {
  'official-public': { label: 'Official geometry (ST-concurrent USBR 90)', color: '#1d4ed8' },
  'osm-proposed': { label: 'ST-concurrent USBR 90 (proposed)', color: '#0d9488' },
  reconstructed: { label: 'Reconstructed ST (journal-attested)', color: '#ea580c', dashed: true },
  continuation: { label: 'SD → LA continuation', color: '#db2777', dashed: true },
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

// Where the route crosses a state line: binary-searched along the route
// geometry against the Census TIGER state polygons (so the Louisiana line
// is the East Pearl, and Texas is the Sabine past Merryville, not the town).
// Labels on the map read as stamps at the border: "TEXAS · mi 591".
const STATE_CROSSINGS: { state: string; mile: number; lat: number; lng: number }[] = [
  { state: 'Alabama', mile: 54.9, lat: 30.2814, lng: -87.5191 },
  { state: 'Mississippi', mile: 124.2, lat: 30.4726, lng: -88.4006 },
  { state: 'Louisiana', mile: 209.3, lat: 30.239, lng: -89.6153 },
  { state: 'Texas', mile: 590.6, lat: 30.7468, lng: -93.609 },
  { state: 'New Mexico', mile: 1753.9, lat: 31.9171, lng: -106.6211 },
  { state: 'Arizona', mile: 1932.1, lat: 32.2275, lng: -109.0484 },
  { state: 'California', mile: 2327.7, lat: 32.7375, lng: -114.6304 },
];
const STATE_CROSSINGS_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: STATE_CROSSINGS.map((c) => ({
    type: 'Feature',
    properties: { state: c.state, mile: Math.round(c.mile), label: `${c.state.toUpperCase()}\nmi ${Math.round(c.mile)}` },
    geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
  })),
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

interface SegmentProps {
  id: string; name: string; startMile: number; endMile: number;
  provenance: string; continuation: number; confidence: string;
  source: string; sourceUrl: string | null; notes: string | null;
}
export type RouteData = {
  route: { name: string; totalMiles: number; notes: string } | null;
  segments: GeoJSON.FeatureCollection<GeoJSON.LineString, SegmentProps>;
  mileMarkers: { mile: number; lat: number; lng: number }[];
};

export interface CampingResponse {
  ready: boolean; note?: string; generatedAt?: string | null;
  days?: unknown[];
  laws?: {
    states?: Record<string, Record<string, string>>;
    programs?: Record<string, string>;
    generalTips?: string[];
  } | null;
  spots?: GeoJSON.FeatureCollection;
  summary?: Record<string, number>;
}

function provOf(p: { continuation?: number; provenance?: string }) {
  return p.continuation ? PROV_META.continuation : PROV_META[p.provenance as string];
}

function segmentPopupHtml(p: SegmentProps): string {
  const prov = provOf(p);
  const link = p.sourceUrl
    ? `<div><a href="${esc(p.sourceUrl)}" target="_blank" rel="noreferrer">source</a></div>` : '';
  return `<div class="popup">
    <div class="popup-title" style="border-color:${prov?.color}">${esc(p.name)}</div>
    <div><b>Mile ${esc(p.startMile)} → ${esc(p.endMile)}</b> (${Math.round(p.endMile - p.startMile)} mi)</div>
    <div class="badge">${esc(prov?.label ?? p.provenance)} · confidence: ${esc(p.confidence)}</div>
    <div class="dim">${esc(p.source)}</div>
    ${p.notes ? `<div class="dim">${esc(p.notes)}</div>` : ''}
    ${link}
  </div>`;
}

function resourcePopupHtml(p: Record<string, unknown>): string {
  const cat = CAT_META[p.category as string];
  return `<div class="popup">
    <div class="popup-title" style="border-color:${cat?.color}">${esc(p.name)}</div>
    <div><b>Mile ${esc(p.routeMile)}</b> · ${esc(p.offRouteMi)} mi off route</div>
  </div>`;
}

function campPopupHtml(p: Record<string, unknown>): string {
  const price = p.price == null || p.price === ''
    ? '$?' : Number(p.price) === 0 ? 'FREE' : `$${p.price}`;
  return `<div class="popup">
    <div class="popup-title" style="border-color:#4f7942">⛺ ${esc(p.name)}</div>
    <div><b>${esc(price)}</b>${p.priceNote ? ` · ${esc(p.priceNote)}` : ''}</div>
    <div>Mile ${esc(p.routeMile)}${p.locationNote ? ` · ${esc(p.locationNote)}` : ''}</div>
    ${p.legalityNote ? `<div class="dim">✔ ${esc(p.legalityNote)}</div>` : ''}
  </div>`;
}

export default function App() {
  const mapRef = useRef<MLMap | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layersAdded = useRef(false);

  const [surface, setSurface] = useState<Surface>('today');
  const [curDay, setCurDay] = useState<number | null>(null);
  const [routeData, setRouteData] = useState<RouteData | null>(null);
  const [resources, setResources] = useState<GeoJSON.FeatureCollection | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [camping, setCamping] = useState<CampingResponse | null>(null);
  // The rider's own beds, live from the API (re-fetched with the plan).
  const [riderPlaces, setRiderPlaces] = useState<GeoJSON.FeatureCollection | null>(null);
  // The rider navigates by date, not by day index. One formatter, used by every
  // label that used to read "D24" / "Day 24".
  const dayDateLabel = useCallback((n: number | null | undefined) => {
    if (n == null) return '';
    const iso = plan?.days.find((d) => d.dayNumber === n)?.date;
    if (!iso) return `Day ${n}`;
    const [, m, dd] = iso.split('-');
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${MON[Number(m) - 1]} ${Number(dd)}`;
  }, [plan]);
  const [showMine, setShowMine] = useState(true);
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedResource, setSelectedResource] = useState<ResourceInfo | null>(null);
  const [ridePos, setRidePos] = useState<PositionInfo | null>(null);
  const [follow, setFollow] = useState(true);
  const [styleReady, setStyleReady] = useState(false);
  const [layersReady, setLayersReady] = useState(false);
  const [visibleCats, setVisibleCats] = useState<Record<string, boolean>>(
    { wifi_work: true, campground: true, hotel: true, resupply: true });
  const [showCamps, setShowCamps] = useState(false);
  // Rider-proposed alternate lines (scripts/build-alternates.mjs), off by
  // default: they are options to weigh against the route, not the route.
  const [showAlts, setShowAlts] = useState(true);
  const [showOld, setShowOld] = useState(true);
  // The legend covers a quarter of the map on a phone. Collapsing is a per-device
  // preference, so it survives reloads rather than reopening every time.
  const [legendOpen, setLegendOpen] = useState(() => {
    try { return localStorage.getItem('legendOpen') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('legendOpen', legendOpen ? '1' : '0'); } catch { /* private mode */ }
  }, [legendOpen]);
  // Population heat is ON by default: it is the glance-level "will there be
  // anything out here" read the rider plans a day around, not an overlay.
  const [showPop, setShowPop] = useState(true);
  const [population, setPopulation] = useState<GeoJSON.FeatureCollection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncStatus>({ state: 'idle', at: null });
  const [keyInput, setKeyInput] = useState('');
  const [pickPrompt, setPickPrompt] = useState<string | null>(null);
  const [picker, setPicker] = useState<PickerContext | null>(null);
  const pickResolver = useRef<((c: [number, number]) => void) | null>(null);
  const surfaceRef = useRef<Surface>('today');
  surfaceRef.current = surface;
  // While a picker is open its candidates own the map: the route/day/resource
  // click handlers must stand down, or clicking a candidate ALSO opens a
  // segment popup over it and re-selects the day underneath.
  const pickerRef = useRef<PickerContext | null>(null);
  pickerRef.current = picker;

  useEffect(() => onSync(setSync), []);

  // Picking is always "relative to today's stretch", so highlight it.
  useEffect(() => {
    if (picker) setSelectedDay(picker.dayNumber);
  }, [picker]);

  const refetchPlan = useCallback(async () => {
    try {
      const res = await fetch('/api/plan');
      if (res.ok) {
        const p: PlanResponse = await res.json();
        setPlan(p);
        setCurDay((c) => c ?? frontierDay(p));
      }
      apiGet<GeoJSON.FeatureCollection>('/api/rider-places').then(setRiderPlaces).catch(() => {});
    } catch { /* surfaces show their own errors */ }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [r, res, camp, pop] = await Promise.all([
          apiGet<RouteData>('/api/route'),
          apiGet<GeoJSON.FeatureCollection>('/api/resources'),
          apiGet<CampingResponse>('/api/camping').catch(() => null),
          apiGet<GeoJSON.FeatureCollection>('/api/population').catch(() => null),
        ]);
        setRouteData(r); setResources(res);
        if (camp) setCamping(camp);
        if (pop) setPopulation(pop);
      } catch (err) { setError(String(err)); }
    })();
    refetchPlan();
  }, [refetchPlan]);

  // ---- map bootstrap (unchanged architecture: styledata-gated, not load) ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-100, 31], zoom: 4,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    (window as unknown as { __map: MLMap }).__map = map;
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('error', (e) => console.error('[maplibre]', e.error?.message ?? e));
    if (map.isStyleLoaded()) setStyleReady(true);
    else map.once('styledata', () => setStyleReady(true));
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !routeData || !resources || layersAdded.current) return;
    layersAdded.current = true;

    // Population heat goes in first: layer order is add order, and this is
    // background context — the route and every pin must draw on top of it.
    // Weight is people per block group (cells are sized for ~600–3,000 people,
    // so heat comes mostly from how densely the centroids pack, which is the
    // honest signal). Radius grows with zoom so a town reads as a town at day
    // zoom and as a footprint when you zoom in; opacity fades past z11 where
    // the individual pins take over the job.
    map.addSource('population', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'population-heat', type: 'heatmap', source: 'population', maxzoom: 15,
      layout: { visibility: 'visible' },
      paint: {
        'heatmap-weight': ['interpolate', ['linear'], ['get', 'pop'],
          0, 0, 300, 0.25, 1500, 0.6, 4000, 1] as never,
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 8, 1.1, 12, 2.2] as never,
        // Wider at mid zoom so scattered rural cells merge into a faint haze
        // instead of reading as a field of separate dots.
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 6, 7, 22, 10, 40, 13, 56] as never,
        // Field-manual warmth, not weather-radar neon: parchment → ochre → rust.
        // The bottom stop is kept very faint on purpose: a lone block group
        // is a few hundred people and must not look like a town.
        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
          0, 'rgba(0,0,0,0)',
          0.18, 'rgba(232,217,168,0.28)',
          0.4, 'rgba(217,164,65,0.6)',
          0.68, 'rgba(194,116,10,0.78)',
          1, 'rgba(138,61,10,0.9)'] as never,
        'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 11, 0.75, 14, 0.2] as never,
      },
    });

    // State lines. The basemap draws admin_level 3–6 boundaries as one faint
    // grey dashed hairline that vanishes under the route and the heat; the
    // trip is organised by state, so redraw admin_level 4 (US states) bold:
    // a white casing under a dark dashed line, visible from the whole-route
    // zoom, sitting under the route so the ride still wins where they cross.
    {
      const boundarySource = (map.getLayer('boundary_3') as { source?: string } | undefined)?.source ?? 'openmaptiles';
      const stateFilter = ['all',
        ['==', ['get', 'admin_level'], 4],
        ['!=', ['get', 'maritime'], 1],
        ['!=', ['get', 'disputed'], 1],
      ] as never;
      map.addLayer({
        id: 'state-lines-casing', type: 'line', source: boundarySource, 'source-layer': 'boundary', minzoom: 2,
        filter: stateFilter,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#fbf8ef',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 3.5, 7, 6, 12, 9] as never,
          'line-opacity': 0.85,
        },
      });
      map.addLayer({
        id: 'state-lines', type: 'line', source: boundarySource, 'source-layer': 'boundary', minzoom: 2,
        filter: stateFilter,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#4b3f2a',
          'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.4, 7, 2.2, 12, 3] as never,
          'line-dasharray': [3, 1.6] as never,
          'line-opacity': 0.9,
        },
      });
    }

    map.addSource('route', { type: 'geojson', data: routeData.segments });
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      paint: { 'line-color': '#f6f2e6', 'line-width': 6, 'line-opacity': 0.7 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route',
      paint: {
        'line-color': [
          'case',
          ['==', ['get', 'continuation'], 1], PROV_META.continuation.color,
          ['match', ['get', 'provenance'],
            'official-public', PROV_META['official-public'].color,
            'osm-proposed', PROV_META['osm-proposed'].color,
            PROV_META.reconstructed.color],
        ] as never,
        'line-width': 3.5,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    map.addLayer({
      id: 'route-line-dashed', type: 'line', source: 'route',
      filter: ['any', ['==', ['get', 'continuation'], 1], ['==', ['get', 'provenance'], 'reconstructed']],
      paint: {
        'line-color': '#ffffff', 'line-width': 3.5, 'line-opacity': 0.85,
        'line-dasharray': [1.2, 1.6] as never,
      },
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
    });

    map.addSource('mile-markers', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: routeData.mileMarkers.map((m) => ({
          type: 'Feature' as const, properties: { mile: m.mile },
          geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] },
        })),
      },
    });
    map.addLayer({
      id: 'mile-marker-pts', type: 'circle', source: 'mile-markers', minzoom: 6,
      paint: {
        'circle-radius': 3.5, 'circle-color': '#3d3a30',
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'mile-marker-labels', type: 'symbol', source: 'mile-markers', minzoom: 6.5,
      layout: {
        'text-field': ['concat', 'mi ', ['get', 'mile']] as never,
        'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top',
        'text-font': ['Noto Sans Regular'],
      },
      paint: { 'text-color': '#3d3a30', 'text-halo-color': '#fff', 'text-halo-width': 1.2 },
    });

    const byCat: Record<string, GeoJSON.Feature[]> = {};
    for (const f of resources.features) {
      const c = (f.properties as { category: string }).category;
      (byCat[c] ||= []).push(f);
    }
    for (const [cat, meta] of Object.entries(CAT_META)) {
      map.addSource(`res-${cat}`, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: byCat[cat] ?? [] },
        cluster: true, clusterRadius: 42, clusterMaxZoom: 11,
      });
      map.addLayer({
        id: `res-${cat}-clusters`, type: 'circle', source: `res-${cat}`,
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': meta.color, 'circle-opacity': 0.8,
          'circle-radius': ['step', ['get', 'point_count'], 11, 10, 15, 50, 20] as never,
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: `res-${cat}-cluster-count`, type: 'symbol', source: `res-${cat}`,
        filter: ['has', 'point_count'],
        layout: {
          'text-field': ['get', 'point_count_abbreviated'] as never,
          'text-size': 11, 'text-font': ['Noto Sans Regular'],
        },
        paint: { 'text-color': '#fff' },
      });
      map.addLayer({
        id: `res-${cat}-pts`, type: 'circle', source: `res-${cat}`,
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-color': meta.color, 'circle-radius': 6,
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
        },
      });
      map.on('click', `res-${cat}-pts`, (e) => {
        if (pickResolver.current || pickerRef.current) return;
        const f = e.features?.[0] as MapGeoJSONFeature | undefined;
        if (!f) return;
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
        setSelectedResource({ ...(f.properties as unknown as ResourceInfo), lat, lng });
        new maplibregl.Popup({ maxWidth: '320px' })
          .setLngLat(e.lngLat).setHTML(resourcePopupHtml(f.properties)).addTo(map);
      });
      map.on('click', `res-${cat}-clusters`, (e) => {
        map.easeTo({ center: e.lngLat, zoom: map.getZoom() + 2 });
      });
      for (const layer of [`res-${cat}-pts`, `res-${cat}-clusters`]) {
        map.on('mouseenter', layer, () => (map.getCanvas().style.cursor = 'pointer'));
        map.on('mouseleave', layer, () => (map.getCanvas().style.cursor = ''));
      }
    }

    // Plan day bands + boundary labels
    map.addSource('plan-days', { type: 'geojson', data: EMPTY_FC });
    map.addSource('plan-bounds', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'plan-day-band', type: 'line', source: 'plan-days',
      paint: {
        'line-color': [
          'case',
          ['any', ['==', ['get', 'status'], 'completed'], ['==', ['get', 'status'], 'modified']],
          '#a39e8c',
          ['==', ['%', ['get', 'dayNumber'], 2], 0], '#7db7d6',
          '#94a86e',
        ] as never,
        'line-width': 9, 'line-opacity': 0.5,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, 'route-casing');
    map.addLayer({
      id: 'plan-day-selected', type: 'line', source: 'plan-days',
      filter: ['==', ['get', 'dayNumber'], -999],
      paint: { 'line-color': '#f2a900', 'line-width': 13, 'line-opacity': 0.9 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, 'route-casing');
    map.addLayer({
      id: 'plan-bound-pts', type: 'circle', source: 'plan-bounds', minzoom: 4,
      paint: {
        'circle-radius': 4, 'circle-color': '#1a1814',
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'plan-bound-labels', type: 'symbol', source: 'plan-bounds', minzoom: 5,
      layout: {
        'text-field': ['get', 'label'] as never,
        'text-size': 10.5, 'text-anchor': 'bottom', 'text-offset': [0, -0.7],
        'text-font': ['Noto Sans Regular'],
      },
      paint: { 'text-color': '#1a1814', 'text-halo-color': '#fff', 'text-halo-width': 1.3 },
    });

    // Curated camping spots (Map surface toggle)
    map.addSource('camp-spots', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'camp-spot-pts', type: 'circle', source: 'camp-spots',
      layout: { visibility: 'none' },
      paint: {
        'circle-color': ['match', ['get', 'tier'],
          'free', '#2f7d32', 'budget', '#4f7942', 'moderate', '#b06000', 'high', '#b3402a',
          '#8a8270'] as never,
        'circle-radius': 7.5, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'camp-spot-labels', type: 'symbol', source: 'camp-spots', minzoom: 9,
      layout: {
        visibility: 'none',
        'text-field': ['get', 'name'] as never,
        'text-size': 10.5, 'text-offset': [0, 1.2], 'text-anchor': 'top',
        'text-font': ['Noto Sans Regular'],
      },
      paint: { 'text-color': '#2f5d31', 'text-halo-color': '#fff', 'text-halo-width': 1.2 },
    });
    map.on('click', 'camp-spot-pts', (e) => {
      if (pickResolver.current || pickerRef.current) return;
      const f = e.features?.[0] as MapGeoJSONFeature | undefined;
      if (!f) return;
      new maplibregl.Popup({ maxWidth: '320px' })
        .setLngLat(e.lngLat).setHTML(campPopupHtml(f.properties)).addTo(map);
    });

    // Selected day's exact stretch
    map.addSource('day-section', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'day-section-line', type: 'line', source: 'day-section',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1d4ed8', 'line-width': 8, 'line-opacity': 0.5 },
    }, 'route-casing');

    // State-line crossings: a stamp at each border with the state you enter
    // and the route mile, so the whole-route view reads like a strip map.
    map.addSource('state-crossings', { type: 'geojson', data: STATE_CROSSINGS_FC });
    map.addLayer({
      id: 'state-crossing-pts', type: 'circle', source: 'state-crossings', minzoom: 3,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 8, 5] as never,
        'circle-color': '#4b3f2a', 'circle-stroke-color': '#fbf8ef', 'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'state-crossing-labels', type: 'symbol', source: 'state-crossings', minzoom: 3,
      layout: {
        'text-field': ['get', 'label'] as never,
        'text-font': ['Noto Sans Bold'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 7, 12, 11, 14] as never,
        'text-letter-spacing': 0.08,
        'text-line-height': 1.15,
        'text-anchor': 'top',
        'text-offset': [0, 0.7] as never,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#4b3f2a',
        'text-halo-color': '#fbf8ef', 'text-halo-width': 1.8,
      },
    });

    // Alternate routes: candidate lines that leave the ACA route and rejoin
    // it, drawn dashed in their own colour under the route so the official
    // line still wins where they share a road. Stops carry a McDonald's flag —
    // the rider's unit of "I can work here".
    // The ACA Southern Tier as it ran before the 2026-10-11 I-8 retrace: El Paso
    // over Emory Pass (8,228 ft) through Silver City, Globe and Tempe. Kept as a
    // dotted ghost under the live route so the rider can see what the reroute
    // actually bought him. It is reference geometry only — nothing plans on it.
    map.addSource('old-route', { type: 'geojson', data: OLD_ROUTE.line as GeoJSON.FeatureCollection });
    map.addSource('old-route-marks', { type: 'geojson', data: OLD_ROUTE.marks as GeoJSON.FeatureCollection });
    map.addLayer({
      id: 'old-route-line', type: 'line', source: 'old-route',
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'] as never, 'line-width': 2.6,
        'line-dasharray': [1.6, 2.2] as never, 'line-opacity': 0.85,
      },
    }, 'route-casing');
    map.addLayer({
      id: 'old-route-mark-pts', type: 'circle', source: 'old-route-marks', minzoom: 4,
      paint: {
        'circle-radius': 4, 'circle-color': '#f6f2e6',
        'circle-stroke-color': '#8a6d3b', 'circle-stroke-width': 2,
      },
    }, 'route-casing');
    map.addLayer({
      id: 'old-route-mark-labels', type: 'symbol', source: 'old-route-marks', minzoom: 5,
      layout: {
        'text-field': ['get', 'name'] as never, 'text-size': 10.5,
        'text-offset': [0, -1.2], 'text-anchor': 'bottom',
        'text-font': ['Noto Sans Regular'], 'text-optional': true,
      },
      paint: { 'text-color': '#6b5428', 'text-halo-color': '#fff', 'text-halo-width': 1.3 },
    });
    const oldLineClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (pickResolver.current || pickerRef.current) return;
      const f = e.features?.[0] as MapGeoJSONFeature | undefined;
      if (!f) return;
      const p = f.properties as {
        name: string; miles: number; climbFt: number; highPointFt: number;
        summary: string; savedMiles: number; savedClimbFt: number;
      };
      new maplibregl.Popup({ maxWidth: '330px' }).setLngLat(e.lngLat).setHTML(
        `<div class="alt-pop"><b>${p.name}</b> · ${p.miles} mi` +
        `<p class="alt-taken">You are NOT riding this. It is here to compare against.</p>` +
        `<p>${p.summary}</p>` +
        `<ul><li>Climb <b>${p.climbFt.toLocaleString()} ft</b>, topping out at ${p.highPointFt.toLocaleString()} ft</li>` +
        `<li>Your I-10/I-8 line saves <b>${p.savedMiles} mi</b> and <b>${p.savedClimbFt.toLocaleString()} ft</b> of climbing</li></ul></div>`
      ).addTo(map);
    };
    map.on('click', 'old-route-line', oldLineClick);
    map.on('mouseenter', 'old-route-line', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'old-route-line', () => { map.getCanvas().style.cursor = ''; });
    map.addSource('alt-lines', { type: 'geojson', data: ALTERNATES.lines as GeoJSON.FeatureCollection });
    map.addSource('alt-stops', { type: 'geojson', data: ALTERNATES.stops as GeoJSON.FeatureCollection });
    map.addLayer({
      id: 'alt-lines-casing', type: 'line', source: 'alt-lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#f6f2e6', 'line-width': 7, 'line-opacity': 0.8 },
    }, 'route-casing');
    map.addLayer({
      id: 'alt-lines', type: 'line', source: 'alt-lines',
      filter: ['!=', ['get', 'taken'], true] as never,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'] as never, 'line-width': 3.5, 'line-dasharray': [2.2, 1.4] as never, 'line-opacity': 0.9 },
    }, 'route-casing');
    // A line the rider actually rode is not a proposal any more. It is drawn
    // solid, heavier, and OVER the official route, because on the ground it is
    // the route — the ACA miles it replaces were never ridden. The route-mile
    // numbering still follows the ACA line: every anchored thing in this app
    // (intel, camping, resources, his own logged days) is keyed to it, so the
    // map tells the truth about the road without renumbering the world.
    map.addLayer({
      id: 'alt-lines-taken', type: 'line', source: 'alt-lines',
      filter: ['==', ['get', 'taken'], true] as never,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'] as never, 'line-width': 4.5, 'line-opacity': 1 },
    });
    map.addLayer({
      id: 'alt-stop-pts', type: 'circle', source: 'alt-stops', minzoom: 5,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3.5, 9, 6] as never,
        'circle-color': ['case', ['get', 'mcd'], '#f2a900', '#f6f2e6'] as never,
        'circle-stroke-color': '#7c3aed', 'circle-stroke-width': 2,
      },
    });
    map.addLayer({
      id: 'alt-stop-labels', type: 'symbol', source: 'alt-stops', minzoom: 7,
      layout: {
        'text-field': ['case', ['get', 'mcd'], ['concat', ['get', 'name'], ' · M'], ['get', 'name']] as never,
        'text-size': 10.5, 'text-offset': [0, 1.1], 'text-anchor': 'top',
        'text-font': ['Noto Sans Regular'], 'text-optional': true,
      },
      paint: { 'text-color': '#5b21b6', 'text-halo-color': '#fff', 'text-halo-width': 1.2 },
    });
    const altLineClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (pickResolver.current || pickerRef.current) return;
      const f = e.features?.[0] as MapGeoJSONFeature | undefined;
      if (!f) return;
      const p = f.properties as { name: string; miles: number; summary: string; legs: string; taken?: boolean };
      const legs = (typeof p.legs === 'string' ? JSON.parse(p.legs) : p.legs) as { from: string; to: string; miles: number; roads: string[] }[];
      new maplibregl.Popup({ maxWidth: '340px' }).setLngLat(e.lngLat).setHTML(
        `<div class="alt-pop"><b>${p.name}</b> · ${p.miles} mi` +
        (p.taken ? '<p class="alt-taken">You rode this. It is your route.</p>' : '') +
        `<p>${p.summary}</p><ul>` +
        legs.map((l) => `<li>${l.from} → ${l.to} <b>${l.miles} mi</b>${l.roads?.length ? `<br><span class="dim">${l.roads.join(' · ')}</span>` : ''}</li>`).join('') +
        '</ul></div>').addTo(map);
    };
    map.on('click', 'alt-lines', altLineClick);
    map.on('click', 'alt-lines-taken', altLineClick);
    map.on('click', 'alt-stop-pts', (e) => {
      if (pickResolver.current || pickerRef.current) return;
      const f = e.features?.[0] as MapGeoJSONFeature | undefined;
      if (!f) return;
      const p = f.properties as { name: string; state: string; note: string; mcd: boolean };
      new maplibregl.Popup({ maxWidth: '260px' }).setLngLat(e.lngLat).setHTML(
        `<div class="alt-pop"><b>${p.name}, ${p.state}</b><p>${p.mcd ? 'McDonald’s: yes' : 'No McDonald’s'}${p.note ? ' · ' + p.note : ''}</p></div>`).addTo(map);
    });
    for (const id of ['alt-lines', 'alt-lines-taken', 'alt-stop-pts']) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }

    // Work/sleep options within 10 mi of the alternate lines (McDonald's,
    // libraries, campsites, RV parks) — the rider's "can I work and sleep
    // along this detour" question, answered as pins that share the alternate
    // toggle. Colours: gold McDonald's, blue library, green camp, teal RV.
    map.addSource('alt-pois', { type: 'geojson', data: ALT_POIS.pois as GeoJSON.FeatureCollection });
    map.addLayer({
      id: 'alt-poi-pts', type: 'circle', source: 'alt-pois', minzoom: 6,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 9, 4.5, 12, 6] as never,
        'circle-color': ['match', ['get', 'kind'], 'mcd', '#f2a900', 'library', '#2563eb', 'camp', '#2f7d32', 'rv', '#0d9488', '#888'] as never,
        'circle-stroke-color': '#fff', 'circle-stroke-width': 1.2,
        'circle-opacity': ['interpolate', ['linear'], ['get', 'dist'], 0, 0.95, 10, 0.55] as never,
      },
    });
    map.addLayer({
      id: 'alt-poi-labels', type: 'symbol', source: 'alt-pois', minzoom: 10.5,
      layout: {
        'text-field': ['get', 'name'] as never,
        'text-size': 10, 'text-offset': [0, 0.9], 'text-anchor': 'top',
        'text-font': ['Noto Sans Regular'], 'text-optional': true,
      },
      paint: { 'text-color': '#3b3325', 'text-halo-color': '#fff', 'text-halo-width': 1.1 },
    });
    map.on('click', 'alt-poi-pts', (e) => {
      if (pickResolver.current || pickerRef.current) return;
      const f = e.features?.[0] as MapGeoJSONFeature | undefined;
      if (!f) return;
      const p = f.properties as { name: string; kind: string; dist: number; town: string; townDist: number; phone?: string; website?: string; addr?: string; fee?: string; tents?: string };
      const kind = { mcd: 'McDonald’s', library: 'Library', camp: 'Campsite', rv: 'RV park' }[p.kind] ?? p.kind;
      const bits = [`${kind} · ${p.dist} mi off the line`, `${Math.round(p.townDist)} mi from ${p.town}`];
      if (p.addr) bits.push(p.addr);
      if (p.tents) bits.push(`tents: ${p.tents}`);
      if (p.fee) bits.push(`fee: ${p.fee}`);
      if (p.phone) bits.push(p.phone);
      new maplibregl.Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setHTML(
        `<div class="alt-pop"><b>${p.name}</b><p>${bits.join('<br>')}${p.website ? `<br><a href="${p.website}" target="_blank" rel="noopener">website</a>` : ''}</p></div>`).addTo(map);
    });
    map.on('mouseenter', 'alt-poi-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'alt-poi-pts', () => { map.getCanvas().style.cursor = ''; });

    // The rider's own beds: filled pin where he slept, hollow where he plans
    // to, drawn above every other pin — these are the trip's spine.
    map.addSource('rider-places', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'rider-place-pts', type: 'circle', source: 'rider-places', minzoom: 4,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 9, 7] as never,
        'circle-color': ['case', ['==', ['get', 'status'], 'slept'], '#1a1814', '#faf7ee'] as never,
        'circle-stroke-color': '#d96f00', 'circle-stroke-width': 2.5,
      },
    });
    map.addLayer({
      id: 'rider-place-labels', type: 'symbol', source: 'rider-places', minzoom: 8,
      layout: {
        'text-field': ['case', ['has', 'dateLabel'], ['concat', ['get', 'dateLabel'], ' · ', ['get', 'name']], ['get', 'name']] as never,
        'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-max-width': 14,
        'text-font': ['Noto Sans Regular'], 'text-optional': true,
      },
      paint: { 'text-color': '#a54e00', 'text-halo-color': '#fff', 'text-halo-width': 1.3 },
    });
    map.on('click', 'rider-place-pts', (e) => {
      if (pickResolver.current || pickerRef.current) return;
      const f = e.features?.[0] as MapGeoJSONFeature | undefined;
      if (!f) return;
      const p = f.properties as Record<string, unknown>;
      const cost = p.cost == null || p.cost === '' ? '' : Number(p.cost) === 0 ? 'FREE' : `$${p.cost}`;
      const when = p.status === 'slept' ? `Slept · day ${p.dayNumber}${p.date ? ' · ' + p.date : ''}` : p.status === 'planned' ? `Planned · day ${p.dayNumber}` : 'Added';
      new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(e.lngLat).setHTML(
        `<div class="popup"><div class="popup-title" style="border-color:#d96f00">${p.category === 'campground' ? '⛺' : '🛏'} ${esc(p.name)}</div>` +
        `<div><b>${esc(when)}</b>${cost ? ' · ' + esc(cost) : ''}</div>` +
        `<div>Mile ${esc(p.routeMile)}${Number(p.offRouteMi) > 0.3 ? ` · ${esc(p.offRouteMi)} mi off` : ''}${p.address ? ' · ' + esc(p.address) : ''}</div>` +
        (p.notes ? `<div class="dim">${esc(p.notes)}</div>` : '') + '</div>').addTo(map);
    });
    map.on('mouseenter', 'rider-place-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'rider-place-pts', () => { map.getCanvas().style.cursor = ''; });

    // Ride position
    map.addSource('ride-pos', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'ride-pos-halo', type: 'circle', source: 'ride-pos',
      paint: { 'circle-radius': 13, 'circle-color': '#2563eb', 'circle-opacity': 0.25 },
    });
    map.addLayer({
      id: 'ride-pos-dot', type: 'circle', source: 'ride-pos',
      paint: {
        'circle-radius': 6.5, 'circle-color': '#2563eb',
        'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5,
      },
    });

    map.on('click', (e) => {
      if (pickResolver.current) {
        const res = pickResolver.current;
        pickResolver.current = null;
        setPickPrompt(null);
        map.getCanvas().style.cursor = '';
        res([e.lngLat.lng, e.lngLat.lat]);
      }
    });
    map.on('click', 'route-line', (e) => {
      if (pickResolver.current || pickerRef.current) return;
      const hits = map.queryRenderedFeatures(e.point);
      if (hits.some((f) => f.layer.id.startsWith('res-'))) return;
      const f = e.features?.[0];
      if (!f) return;
      const dayF = hits.find((x) => x.layer.id === 'plan-day-band');
      if (dayF) setSelectedDay((dayF.properties as { dayNumber: number }).dayNumber);
      new maplibregl.Popup({ maxWidth: '340px' })
        .setLngLat(e.lngLat).setHTML(segmentPopupHtml(f.properties as SegmentProps)).addTo(map);
    });
    map.on('mouseenter', 'route-line', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'route-line', () => (map.getCanvas().style.cursor = ''));

    fitTo(routeData.segments.features.flatMap((f) => f.geometry.coordinates as [number, number][]));
    setLayersReady(true);
  }, [styleReady, routeData, resources]);

  // Plan geometry → map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    (map.getSource('plan-days') as maplibregl.GeoJSONSource | undefined)
      ?.setData((plan?.geometry?.lines ?? EMPTY_FC) as GeoJSON.GeoJSON);
    (map.getSource('plan-bounds') as maplibregl.GeoJSONSource | undefined)
      ?.setData((plan?.geometry?.bounds ?? EMPTY_FC) as GeoJSON.GeoJSON);
  }, [plan, layersReady]);

  // Camping spots → map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    (map.getSource('camp-spots') as maplibregl.GeoJSONSource | undefined)
      ?.setData((camping?.spots ?? EMPTY_FC) as GeoJSON.GeoJSON);
  }, [camping, layersReady]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const vis = showCamps && !picker ? 'visible' : 'none';
    for (const id of ['camp-spot-pts', 'camp-spot-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }, [showCamps, layersReady, picker]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const vis = showAlts && !picker ? 'visible' : 'none';
    for (const id of ['alt-lines-casing', 'alt-lines', 'alt-lines-taken', 'alt-stop-pts', 'alt-stop-labels', 'alt-poi-pts', 'alt-poi-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }, [showAlts, layersReady, picker]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const vis = showOld && !picker ? 'visible' : 'none';
    for (const id of ['old-route-line', 'old-route-mark-pts', 'old-route-mark-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }, [showOld, layersReady, picker]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    (map.getSource('rider-places') as maplibregl.GeoJSONSource | undefined)
      ?.setData(({
        ...(riderPlaces ?? EMPTY_FC),
        features: (riderPlaces?.features ?? []).map((f) => {
          const n = (f.properties as { dayNumber?: number } | null)?.dayNumber;
          return n == null ? f : { ...f, properties: { ...f.properties, dateLabel: dayDateLabel(n) } };
        }),
      }) as GeoJSON.GeoJSON);
  }, [riderPlaces, layersReady, dayDateLabel]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const vis = showMine && !picker ? 'visible' : 'none';
    for (const id of ['rider-place-pts', 'rider-place-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }, [showMine, layersReady, picker]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    (map.getSource('population') as maplibregl.GeoJSONSource | undefined)
      ?.setData((population ?? EMPTY_FC) as GeoJSON.GeoJSON);
  }, [population, layersReady]);
  // Stays visible while a picker is open — choosing a stop is exactly when
  // "is there a town there" matters most.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady || !map.getLayer('population-heat')) return;
    map.setLayoutProperty('population-heat', 'visibility', showPop ? 'visible' : 'none');
  }, [showPop, layersReady]);

  // Resource cluster visibility. While a picker is open its own candidates are
  // the only markers that matter — the global clusters would bury them.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersAdded.current) return;
    for (const cat of Object.keys(CAT_META)) {
      const vis = !picker && visibleCats[cat] ? 'visible' : 'none';
      for (const suffix of ['clusters', 'cluster-count', 'pts']) {
        const id = `res-${cat}-${suffix}`;
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
      }
    }
  }, [visibleCats, layersReady, picker]);

  // Selected day highlight + section line
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady || !map.getLayer('plan-day-selected')) return;
    map.setFilter('plan-day-selected', ['==', ['get', 'dayNumber'], selectedDay ?? -999]);
    const d = plan?.days.find((x) => x.dayNumber === selectedDay);
    if (!d) {
      (map.getSource('day-section') as maplibregl.GeoJSONSource | undefined)
        ?.setData(EMPTY_FC as GeoJSON.GeoJSON);
      return;
    }
    (async () => {
      try {
        const { coords } = await apiGet<{ coords: [number, number][] }>(
          `/api/route/points?minMile=${d.startMile}&maxMile=${d.endMile}`);
        (map.getSource('day-section') as maplibregl.GeoJSONSource | undefined)?.setData(
          coords.length >= 2
            ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } } as GeoJSON.GeoJSON
            : EMPTY_FC as GeoJSON.GeoJSON);
      } catch { /* cosmetic */ }
    })();
  }, [selectedDay, layersReady, plan]);

  // "You are here": a live GPS/manual fix when Ride mode has one, otherwise
  // the start of the day the rider is on (last night's bed). The marker is a
  // DOM element so it can pulse with CSS — a MapLibre circle can't animate
  // without a render loop, and a phone on the roadside doesn't want one.
  const [homePos, setHomePos] = useState<{ lng: number; lat: number; mile: number } | null>(null);
  const hereMarker = useRef<maplibregl.Marker | null>(null);
  useEffect(() => {
    const day = plan?.days.find((d) => d.dayNumber === curDay);
    if (!day) { setHomePos(null); return; }
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/position?mile=${day.startMile}`);
        if (!res.ok) return;
        const p = await res.json();
        if (live && Number.isFinite(p.lat) && Number.isFinite(p.lng)) setHomePos({ lng: p.lng, lat: p.lat, mile: Number(p.mile) });
      } catch { /* marker is a convenience */ }
    })();
    return () => { live = false; };
  }, [plan, curDay]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const at = ridePos ? { lng: ridePos.lng, lat: ridePos.lat } : homePos;
    if (!at) { hereMarker.current?.remove(); hereMarker.current = null; return; }
    if (!hereMarker.current) {
      const el = document.createElement('div');
      el.className = 'you-are-here';
      el.title = 'You are here';
      el.innerHTML = '<span class="yah-ring"></span><span class="yah-dot"></span>';
      hereMarker.current = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(at).addTo(map);
    } else {
      hereMarker.current.setLngLat(at);
    }
    hereMarker.current.getElement().classList.toggle('live', !!ridePos);
  }, [ridePos, homePos, layersReady]);

  // Opening the map from the nav lands on the rider, not on the whole
  // route. The intent is recorded on the click and consumed once a position
  // exists, so a map opened before the day's start has loaded still centres
  // correctly a moment later. Day/point views set their own camera and do
  // not set this flag.
  const centerOnMe = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady || surface !== 'map' || !centerOnMe.current) return;
    const at = ridePos ? { lng: ridePos.lng, lat: ridePos.lat } : homePos;
    if (!at) return;
    centerOnMe.current = false;
    map.resize();
    map.easeTo({ center: [at.lng, at.lat], zoom: Math.max(map.getZoom(), 12.5), duration: 700 });
  }, [surface, ridePos, homePos, layersReady]);

  // Ride position marker + follow
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const fc: GeoJSON.FeatureCollection = ridePos
      ? {
          type: 'FeatureCollection',
          features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [ridePos.lng, ridePos.lat] } }],
        }
      : EMPTY_FC;
    (map.getSource('ride-pos') as maplibregl.GeoJSONSource | undefined)?.setData(fc);
    if (ridePos && follow && surfaceRef.current === 'ride') {
      map.easeTo({ center: [ridePos.lng, ridePos.lat], zoom: Math.max(map.getZoom(), 13.5), duration: 600 });
    }
  }, [ridePos, follow, layersReady]);

  function fitTo(coords: [number, number][]) {
    const map = mapRef.current;
    if (!map || !coords.length) return;
    const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(b, { padding: 60, animate: false });
  }

  // ---- cross-surface actions --------------------------------------------------
  const gotoDay = useCallback((n: number) => {
    setCurDay(n);
    setSelectedDay(n);
    setSurface('today');
  }, []);

  const showDayOnMap = useCallback((n: number) => {
    setSelectedDay(n);
    setSurface('map');
    const f = plan?.geometry?.lines.features.find(
      (x) => (x.properties as { dayNumber: number }).dayNumber === n);
    if (f && f.geometry.type === 'LineString') fitTo(f.geometry.coordinates as [number, number][]);
  }, [plan]);

  const showPointOnMap = useCallback((lng: number, lat: number, html?: string) => {
    setSurface('map');
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ center: [lng, lat], zoom: Math.max(map.getZoom(), 12), duration: 500 });
    if (html) new maplibregl.Popup({ maxWidth: '320px' }).setLngLat([lng, lat]).setHTML(html).addTo(map);
  }, []);

  /** Arm the map: next tap resolves to [lng, lat]. Switches to the map surface. */
  const armMapPick = useCallback((prompt: string): Promise<[number, number]> => {
    setSurface('map');
    setPickPrompt(prompt);
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = 'crosshair';
    return new Promise((res) => { pickResolver.current = res; });
  }, []);

  const cancelPick = useCallback(() => {
    pickResolver.current = null;
    setPickPrompt(null);
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = '';
  }, []);

  const unlock = () => {
    setTripKey(keyInput);
    setKeyInput('');
  };

  const segments = routeData?.segments.features.map((f) => f.properties) ?? [];
  const counts: Record<string, number> = {};
  for (const f of resources?.features ?? []) {
    const c = (f.properties as { category: string }).category;
    counts[c] = (counts[c] ?? 0) + 1;
  }

  const syncLabel: Record<string, string> = {
    idle: '', synced: 'Saved', saving: 'Saving…',
    offline: 'Offline — not saved', locked: 'Locked — trip key needed',
  };

  const navItems: { id: Surface; label: string; glyph: string }[] = [
    { id: 'today', label: 'Today', glyph: '☀' },
    { id: 'trip', label: 'Trip', glyph: '☰' },
    { id: 'map', label: 'Map', glyph: '✕' },
    { id: 'ask', label: 'Ask', glyph: '?' },
    { id: 'more', label: 'More', glyph: '⋯' },
  ];

  return (
    <div className="app">
      <div ref={containerRef} className="map" />

      {pickPrompt && (
        <div className="pick-banner">
          <span>{pickPrompt}</span>
          <button onClick={cancelPick}>Cancel</button>
        </div>
      )}

      {/* Map surface chrome (legend / toggles / detail) */}
      {surface === 'map' && !pickPrompt && (
        <div className={`map-panel${legendOpen ? '' : ' map-panel--min'}`}>
          <div className="map-panel-head">
            <span className="hand">{legendOpen ? 'the whole mess, on a map' : 'layers'}</span>
            <button
              type="button"
              className="map-panel-toggle"
              onClick={() => setLegendOpen((v) => !v)}
              aria-expanded={legendOpen}
              title={legendOpen ? 'Shrink the legend' : 'Show the legend'}
            >
              {legendOpen ? '–' : '+'}
            </button>
          </div>
          {legendOpen && (<>
          {Object.entries(CAT_META).map(([cat, meta]) => (
            <label key={cat} className="cat-toggle">
              <input type="checkbox" checked={visibleCats[cat]}
                onChange={(e) => setVisibleCats((v) => ({ ...v, [cat]: e.target.checked }))} />
              <span className="dot" style={{ background: meta.color }} />
              {meta.label}
              <span className="count">{counts[cat] ?? 0}</span>
            </label>
          ))}
          <label className="cat-toggle">
            <input type="checkbox" checked={showCamps} onChange={(e) => setShowCamps(e.target.checked)} />
            <span className="dot" style={{ background: '#2f7d32' }} />
            Researched camps
            <span className="count">{camping?.spots?.features?.length ?? 0}</span>
          </label>
          <label className="cat-toggle">
            <input type="checkbox" checked={showMine} onChange={(e) => setShowMine(e.target.checked)} />
            <span className="dot mine-swatch" />
            My stops
            <span className="count" title="beds you slept in (filled) and plan to (hollow)">{riderPlaces?.features.length ?? 0}</span>
          </label>
          <label className="cat-toggle">
            <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />
            <span className="dot old-swatch" />
            Old Southern Tier
            <span className="count" title="the ACA line you skipped: El Paso → Emory Pass → Silver City → Globe → Phoenix → San Diego">
              +{OLD_ROUTE.line.features[0].properties.savedMiles} mi
            </span>
          </label>
          {showOld && (
            <div className="alt-legend-note" title="what the I-10/I-8 reroute saved you">
              <span>Emory Pass 8,228 ft · {OLD_ROUTE.line.features[0].properties.savedClimbFt.toLocaleString()} ft less climbing</span>
            </div>
          )}
          <label className="cat-toggle">
            <input type="checkbox" checked={showAlts} onChange={(e) => setShowAlts(e.target.checked)} />
            <span className="dot alt-swatch" />
            Alternate lines
            <span className="count" title="rider-proposed detours; gold stop = McDonald’s">{ALTERNATES.lines.features.length}</span>
          </label>
          {showAlts && (() => {
            const n: Record<string, number> = {};
            for (const f of ALT_POIS.pois.features) n[f.properties.kind] = (n[f.properties.kind] ?? 0) + 1;
            return (
              <div className="alt-legend-note" title="within 10 mi of the alternate lines">
                <span><i style={{ background: '#f2a900' }} /> {n.mcd ?? 0} McDonald’s</span>
                <span><i style={{ background: '#2563eb' }} /> {n.library ?? 0} libraries</span>
                <span><i style={{ background: '#2f7d32' }} /> {n.camp ?? 0} camps</span>
                <span><i style={{ background: '#0d9488' }} /> {n.rv ?? 0} RV parks</span>
              </div>
            );
          })()}
          <label className="cat-toggle">
            <input type="checkbox" checked={showPop} onChange={(e) => setShowPop(e.target.checked)} />
            <span className="dot heat-swatch" />
            Population
            <span className="count" title="2020 Census block groups within 20 mi of the route">
              {population ? `${Math.round((population.features.length) / 1000)}k` : '…'}
            </span>
          </label>
          {selectedDay != null && (
            <div className="map-day-chip">
              {dayDateLabel(selectedDay)} highlighted
              <button className="linkish" onClick={() => gotoDay(selectedDay)}>open day</button>
              <button className="linkish" onClick={() => setSelectedDay(null)}>clear</button>
            </div>
          )}
          {selectedResource && (
            <ResourceDetail r={selectedResource} onClose={() => setSelectedResource(null)} />
          )}
          </>)}
        </div>
      )}

      {/* Current mileage, bottom-left. Same position the marker uses: a live
          fix when Ride mode has one, otherwise the start of today. Ridden and
          to-go are measured from the trip start (Perdido Key), not mile 0 of
          the traced route. */}
      {surface === 'map' && !pickPrompt && (() => {
        const mile = ridePos?.mile ?? homePos?.mile;
        if (mile == null || !Number.isFinite(mile)) return null;
        const start = plan?.tripStartMile ?? 0;
        const total = plan?.tripMiles ?? (plan ? plan.totalMiles - start : null);
        const ridden = Math.max(0, mile - start);
        const toGo = total != null ? Math.max(0, total - ridden) : null;
        const day = plan?.days.find((d) => d.dayNumber === curDay);
        return (
          <div className="mile-chip" title={ridePos ? 'live position' : `start of day ${curDay ?? ''}`}>
            <div className="mile-chip-main">mi <b>{mile.toFixed(1)}</b></div>
            <div className="mile-chip-sub">
              {Math.round(ridden).toLocaleString()} ridden{toGo != null && <> · {Math.round(toGo).toLocaleString()} to go</>}
            </div>
            <div className="mile-chip-src">{ridePos ? 'live' : day ? `${dayDateLabel(day.dayNumber)} start` : ''}</div>
          </div>
        );
      })()}

      {/* The map picker replaces the page: choosing a bed or a work stop is a
          geographic decision, so the map is the surface, not a thumbnail. */}
      {picker && <MapPicker ctx={picker} map={mapRef.current} />}

      {/* Content pages (opaque, over the map). Today stays MOUNTED behind an
          open picker — unmounting it would discard which sheet was open, so
          "List view" would land on a blank Today instead of the list. */}
      {surface === 'today' && (
        <div className={`page${picker ? ' page-hidden' : ''}`}>
          <Today
            curDay={curDay} setCurDay={setCurDay}
            plan={plan} refetchPlan={refetchPlan}
            showDayOnMap={showDayOnMap}
            showPointOnMap={showPointOnMap}
            armMapPick={armMapPick}
            openPicker={setPicker}
            gotoRide={() => setSurface('ride')}
          />
        </div>
      )}
      {surface === 'trip' && (
        <div className="page">
          <Trip plan={plan} refetch={refetchPlan} gotoDay={gotoDay} showDayOnMap={showDayOnMap} />
        </div>
      )}
      {surface === 'ask' && (
        <div className="page">
          <Ask curDay={curDay} />
        </div>
      )}
      {surface === 'more' && (
        <div className="page">
          <More plan={plan} camping={camping} segments={segments} refetchPlan={refetchPlan} />
        </div>
      )}

      {surface === 'ride' && (
        <Ride
          info={ridePos} onInfo={setRidePos}
          armMapPick={() => armMapPick('Tap the map to set your position')}
          selectResource={(r) => setSelectedResource(r)}
          selectedResource={selectedResource}
          closeResource={() => setSelectedResource(null)}
          follow={follow} setFollow={setFollow}
          exit={() => setSurface('today')}
        />
      )}

      {error && <div className="load-error">Failed to load: {error}</div>}

      {/* Sync + key */}
      {(sync.state === 'locked' || (sync.state === 'offline' && !getTripKey())) && (
        <div className="key-bar">
          <span>🔒 Enter the trip key to save from this device</span>
          <input type="text" placeholder="trip key" value={keyInput} autoCapitalize="none" autoCorrect="off"
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && unlock()} />
          <button onClick={unlock} disabled={!keyInput.trim()}>Unlock</button>
        </div>
      )}
      {sync.state !== 'idle' && surface !== 'ride' && (
        <div className={`sync-chip sync-${sync.state}`}>
          {syncLabel[sync.state]}
          {sync.state === 'synced' && sync.at && (
            <span className="dim"> {new Date(sync.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          )}
        </div>
      )}

      {/* Navigation — the picker is a focused task with its own way out */}
      {surface !== 'ride' && !picker && (
        <nav className="nav">
          {navItems.map((it) => (
            <button key={it.id} className={surface === it.id ? 'on' : ''}
              onClick={() => { cancelPick(); if (it.id === 'map') centerOnMe.current = true; setSurface(it.id); }}>
              <span className="nav-glyph">{it.glyph}</span>
              {it.label}
            </button>
          ))}
          <button className="nav-ride" onClick={() => { cancelPick(); setSurface('ride'); }}>
            <span className="nav-glyph">▶</span>
            Ride
          </button>
        </nav>
      )}
    </div>
  );
}

function frontierDay(p: PlanResponse): number {
  // The day the rider is "on". The calendar decides: the day dated today.
  // Only if no day carries today's date (before the trip, after it, or a
  // plan with no dates) fall back to the first day after the last actual —
  // otherwise a morning where yesterday's ride wasn't recorded yet would
  // still open on yesterday.
  const today = localISODate();
  const dated = p.days.find((d) => d.date === today);
  if (dated) return dated.dayNumber;
  const last = p.days.filter((d) => d.actual).reduce((m, d) => Math.max(m, d.dayNumber), 0);
  const next = p.days.find((d) => d.dayNumber > last);
  return next?.dayNumber ?? p.days[0]?.dayNumber ?? 1;
}
