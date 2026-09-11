import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { Map as MLMap, MapGeoJSONFeature } from 'maplibre-gl';
import Today from './Today';
import Trip from './Trip';
import Ride from './Ride';
import More from './More';
import ResourceDetail, { ResourceInfo } from './Detail';
import MapPicker, { PickerContext } from './MapPicker';
import { apiGet, getTripKey, setTripKey, onSync, SyncStatus } from './api';
import { PlanResponse, PositionInfo } from './types';

// Shell: one persistent map canvas, three core surfaces over it —
//   TODAY  (time)   what exactly happens today?
//   TRIP   (days)   does the whole trip work; which days need attention?
//   MAP    (space)  where are the route, resources, warnings, beds, work?
// — plus RIDE (the roadside dashboard) and MORE (reference & settings).
// The map never unmounts; content surfaces are opaque pages laid over it.

export type Surface = 'today' | 'trip' | 'map' | 'more' | 'ride';

const CAT_META: Record<string, { label: string; color: string }> = {
  wifi_work: { label: 'Wi-Fi / Work', color: '#b06000' },
  campground: { label: 'Campgrounds', color: '#4f7942' },
  hotel: { label: 'Hotels / Motels', color: '#5b4a92' },
};

const PROV_META: Record<string, { label: string; color: string; dashed?: boolean }> = {
  'official-public': { label: 'Official geometry (ST-concurrent USBR 90)', color: '#1d4ed8' },
  'osm-proposed': { label: 'ST-concurrent USBR 90 (proposed)', color: '#0d9488' },
  reconstructed: { label: 'Reconstructed ST (journal-attested)', color: '#ea580c', dashed: true },
  continuation: { label: 'SD → LA continuation', color: '#db2777', dashed: true },
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

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
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedResource, setSelectedResource] = useState<ResourceInfo | null>(null);
  const [ridePos, setRidePos] = useState<PositionInfo | null>(null);
  const [follow, setFollow] = useState(true);
  const [styleReady, setStyleReady] = useState(false);
  const [layersReady, setLayersReady] = useState(false);
  const [visibleCats, setVisibleCats] = useState<Record<string, boolean>>(
    { wifi_work: true, campground: true, hotel: true });
  const [showCamps, setShowCamps] = useState(false);
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
    } catch { /* surfaces show their own errors */ }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [r, res, camp] = await Promise.all([
          apiGet<RouteData>('/api/route'),
          apiGet<GeoJSON.FeatureCollection>('/api/resources'),
          apiGet<CampingResponse>('/api/camping').catch(() => null),
        ]);
        setRouteData(r); setResources(res);
        if (camp) setCamping(camp);
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
        <div className="map-panel">
          <div className="map-panel-head">
            <span className="hand">the whole mess, on a map</span>
          </div>
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
          {selectedDay != null && (
            <div className="map-day-chip">
              Day {selectedDay} highlighted
              <button className="linkish" onClick={() => gotoDay(selectedDay)}>open day</button>
              <button className="linkish" onClick={() => setSelectedDay(null)}>clear</button>
            </div>
          )}
          {selectedResource && (
            <ResourceDetail r={selectedResource} onClose={() => setSelectedResource(null)} />
          )}
        </div>
      )}

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
            <button key={it.id} className={surface === it.id ? 'on' : ''} onClick={() => { cancelPick(); setSurface(it.id); }}>
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
  // The day the rider is "on": first planned day after the last actual.
  const last = p.days.filter((d) => d.actual).reduce((m, d) => Math.max(m, d.dayNumber), 0);
  const next = p.days.find((d) => d.dayNumber > last);
  return next?.dayNumber ?? p.days[0]?.dayNumber ?? 1;
}
