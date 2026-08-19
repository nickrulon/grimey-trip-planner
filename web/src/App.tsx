import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { Map as MLMap, MapGeoJSONFeature } from 'maplibre-gl';
import PlannerPanel, { PlanResponse } from './Planner';
import ResourceDetail, { ResourceInfo } from './Detail';
import RidePanel, { PositionInfo } from './Ride';

const CAT_META: Record<string, { label: string; color: string }> = {
  wifi_work: { label: 'Wi-Fi / Work', color: '#d97706' },
  campground: { label: 'Campgrounds', color: '#059669' },
  hotel: { label: 'Hotels / Motels', color: '#7c3aed' },
};

const PROV_META: Record<string, { label: string; color: string; dashed?: boolean }> = {
  'official-public': { label: 'Official geometry (ST-concurrent USBR 90)', color: '#1d4ed8' },
  'osm-proposed': { label: 'ST-concurrent USBR 90 (proposed)', color: '#0d9488' },
  reconstructed: { label: 'Reconstructed ST (journal-attested)', color: '#ea580c', dashed: true },
  continuation: { label: 'SD → LA continuation', color: '#db2777', dashed: true },
};

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

const WIFI_BADGE: Record<string, string> = {
  confirmed: 'Wi-Fi: documented in OSM',
  likely: 'Wi-Fi: likely (brand policy — unverified)',
  unknown: 'Wi-Fi: unknown',
  none: 'Wi-Fi: reported none',
};

interface SegmentProps {
  id: string; name: string; startMile: number; endMile: number;
  provenance: string; continuation: number; confidence: string;
  source: string; sourceUrl: string | null; notes: string | null;
}
type RouteData = {
  route: { name: string; totalMiles: number; notes: string } | null;
  segments: GeoJSON.FeatureCollection<GeoJSON.LineString, SegmentProps>;
  mileMarkers: { mile: number; lat: number; lng: number }[];
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string)
  );
}

function provOf(p: { continuation?: number; provenance?: string }) {
  return p.continuation ? PROV_META.continuation : PROV_META[p.provenance as string];
}

function resourcePopupHtml(p: Record<string, unknown>): string {
  const cat = CAT_META[p.category as string];
  const wifi = p.wifiStatus
    ? `<div class="badge">${esc(WIFI_BADGE[p.wifiStatus as string] ?? p.wifiStatus)}</div>` : '';
  const site = p.website
    ? `<div><a href="${esc(p.website)}" target="_blank" rel="noreferrer">website</a></div>` : '';
  const hours = p.hours ? `<div class="dim">Hours: ${esc(p.hours)}</div>` : '';
  const src = p.sources
    ? `<div class="dim">Source: ${esc(p.sources)} · retrieved ${esc(String(p.lastVerified ?? '').slice(0, 10))}</div>`
    : '';
  return `<div class="popup">
    <div class="popup-title" style="border-color:${cat?.color}">${esc(p.name)}</div>
    ${p.brand ? `<div class="dim">${esc(p.brand)}</div>` : ''}
    <div><b>Mile ${esc(p.routeMile)}</b> · ${esc(p.offRouteMi)} mi off route</div>
    ${wifi}${hours}${site}${src}
    <div class="dim">Offset is straight-line; cycling detour may be longer.</div>
  </div>`;
}

interface DayLineProps {
  dayNumber: number; status: string; miles: number;
  startName: string; endName: string; startMile: number; endMile: number;
  actualMiles: number | null;
}

function dayPopupHtml(p: DayLineProps): string {
  const actual = p.actualMiles != null
    ? `<div><b>Rode ${esc(p.actualMiles)} mi</b> (planned ${esc(p.miles)})</div>` : '';
  return `<div class="popup">
    <div class="popup-title" style="border-color:#818cf8">Day ${esc(p.dayNumber)} · ${esc(p.status)}</div>
    <div>${esc(p.startName)} → ${esc(p.endName)}</div>
    <div><b>${esc(p.miles)} mi</b> · mile ${esc(p.startMile)} → ${esc(p.endMile)}</div>
    ${actual}
  </div>`;
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

export default function App() {
  const mapRef = useRef<MLMap | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const layersAdded = useRef(false);

  const [routeData, setRouteData] = useState<RouteData | null>(null);
  const [resources, setResources] = useState<GeoJSON.FeatureCollection | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [tab, setTab] = useState<'days' | 'ride' | 'route'>('days');
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [selectedResource, setSelectedResource] = useState<ResourceInfo | null>(null);
  const [ridePos, setRidePos] = useState<PositionInfo | null>(null);
  const [follow, setFollow] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(true);
  const pickResolver = useRef<((c: [number, number]) => void) | null>(null);
  const [styleReady, setStyleReady] = useState(false);
  const [layersReady, setLayersReady] = useState(false);
  const [visibleCats, setVisibleCats] = useState<Record<string, boolean>>(
    Object.fromEntries(Object.keys(CAT_META).map((k) => [k, true]))
  );
  const [error, setError] = useState<string | null>(null);

  const refetchPlan = useCallback(async () => {
    try {
      const res = await fetch('/api/plan');
      if (res.ok) setPlan(await res.json());
    } catch { /* plan panel shows its own errors */ }
  }, []);

  // 1. Load trip data independently of the map — the timeline/sidebar must work
  //    even if the map canvas is slow, blocked, or offline.
  useEffect(() => {
    (async () => {
      try {
        const [r, res] = await Promise.all([fetch('/api/route'), fetch('/api/resources')]);
        if (!r.ok) throw new Error(`route API ${r.status}`);
        if (!res.ok) throw new Error(`resources API ${res.status}`);
        setRouteData(await r.json());
        setResources(await res.json());
      } catch (err) {
        setError(String(err));
      }
    })();
    refetchPlan();
  }, [refetchPlan]);

  // 2. Create the map. Style readiness is gated on 'styledata' (fetch-driven),
  //    not 'load' (which needs a completed render pass).
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-100, 31],
      zoom: 4,
      attributionControl: { compact: false },
    });
    mapRef.current = map;
    (window as unknown as { __map: MLMap }).__map = map; // dev console access
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('error', (e) => console.error('[maplibre]', e.error?.message ?? e));
    if (map.isStyleLoaded()) setStyleReady(true);
    else map.once('styledata', () => setStyleReady(true));
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // 3. Add sources/layers once both the style and the data are ready.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady || !routeData || !resources || layersAdded.current) return;
    layersAdded.current = true;

    map.addSource('route', { type: 'geojson', data: routeData.segments });
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.65 },
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
    // Dashes can't vary per-feature in one layer, so reconstructed segments get
    // their own overlay filtered to those features.
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
          type: 'Feature' as const,
          properties: { mile: m.mile },
          geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] },
        })),
      },
    });
    map.addLayer({
      id: 'mile-marker-pts', type: 'circle', source: 'mile-markers', minzoom: 6,
      paint: {
        'circle-radius': 3.5, 'circle-color': '#334155',
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
      paint: { 'text-color': '#334155', 'text-halo-color': '#fff', 'text-halo-width': 1.2 },
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
        if (pickResolver.current) return;
        const f = e.features?.[0] as MapGeoJSONFeature | undefined;
        if (!f) return;
        const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates;
        setSelectedResource({ ...(f.properties as unknown as ResourceInfo), lat, lng });
        setSheetOpen(true);
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

    // ---- Trip-plan layers (Phase 2). Sources start empty; a sync effect
    // pushes data whenever /api/plan changes. Bands sit UNDER the route line.
    map.addSource('plan-days', { type: 'geojson', data: EMPTY_FC });
    map.addSource('plan-bounds', { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: 'plan-day-band', type: 'line', source: 'plan-days',
      paint: {
        'line-color': [
          'case',
          ['any', ['==', ['get', 'status'], 'completed'], ['==', ['get', 'status'], 'modified']],
          '#94a3b8',
          ['==', ['%', ['get', 'dayNumber'], 2], 0], '#38bdf8',
          '#818cf8',
        ] as never,
        'line-width': 9, 'line-opacity': 0.5,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, 'route-casing');
    map.addLayer({
      id: 'plan-day-selected', type: 'line', source: 'plan-days',
      filter: ['==', ['get', 'dayNumber'], -999],
      paint: { 'line-color': '#facc15', 'line-width': 13, 'line-opacity': 0.9 },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    }, 'route-casing');
    map.addLayer({
      id: 'plan-bound-pts', type: 'circle', source: 'plan-bounds', minzoom: 4,
      paint: {
        'circle-radius': 4, 'circle-color': '#0f172a',
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
      paint: { 'text-color': '#0f172a', 'text-halo-color': '#fff', 'text-halo-width': 1.3 },
    });

    // Ride Mode position marker (data pushed by a sync effect below).
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

    // "Set on map": while armed, the next click resolves to coordinates and
    // every popup handler stands down.
    map.on('click', (e) => {
      if (pickResolver.current) {
        const res = pickResolver.current;
        pickResolver.current = null;
        map.getCanvas().style.cursor = '';
        res([e.lngLat.lng, e.lngLat.lat]);
      }
    });

    map.on('click', 'route-line', (e) => {
      if (pickResolver.current) return;
      const hits = map.queryRenderedFeatures(e.point);
      if (hits.some((f) => f.layer.id.startsWith('res-'))) return;
      const f = e.features?.[0];
      if (!f) return;
      const dayF = hits.find((x) => x.layer.id === 'plan-day-band');
      let html = segmentPopupHtml(f.properties as SegmentProps);
      if (dayF) {
        html = dayPopupHtml(dayF.properties as DayLineProps) + html;
        setSelectedDay((dayF.properties as DayLineProps).dayNumber);
      }
      new maplibregl.Popup({ maxWidth: '340px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('click', 'plan-day-band', (e) => {
      if (pickResolver.current) return;
      const hits = map.queryRenderedFeatures(e.point);
      if (hits.some((f) => f.layer.id.startsWith('res-') || f.layer.id === 'route-line')) return;
      const f = e.features?.[0];
      if (!f) return;
      setSelectedDay((f.properties as DayLineProps).dayNumber);
      new maplibregl.Popup({ maxWidth: '320px' })
        .setLngLat(e.lngLat).setHTML(dayPopupHtml(f.properties as DayLineProps)).addTo(map);
    });
    map.on('mouseenter', 'route-line', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'route-line', () => (map.getCanvas().style.cursor = ''));

    fitTo(routeData.segments.features.flatMap((f) => f.geometry.coordinates as [number, number][]));
    setLayersReady(true);
  }, [styleReady, routeData, resources]);

  // Push plan geometry into the map whenever the plan changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    (map.getSource('plan-days') as maplibregl.GeoJSONSource | undefined)
      ?.setData((plan?.geometry?.lines ?? EMPTY_FC) as GeoJSON.GeoJSON);
    (map.getSource('plan-bounds') as maplibregl.GeoJSONSource | undefined)
      ?.setData((plan?.geometry?.bounds ?? EMPTY_FC) as GeoJSON.GeoJSON);
  }, [plan, layersReady]);

  // Highlight the selected day.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady || !map.getLayer('plan-day-selected')) return;
    map.setFilter('plan-day-selected', ['==', ['get', 'dayNumber'], selectedDay ?? -999]);
  }, [selectedDay, layersReady]);

  // Ride Mode: position marker + follow camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersReady) return;
    const fc: GeoJSON.FeatureCollection = ridePos
      ? {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature', properties: {},
            geometry: { type: 'Point', coordinates: [ridePos.lng, ridePos.lat] },
          }],
        }
      : EMPTY_FC;
    (map.getSource('ride-pos') as maplibregl.GeoJSONSource | undefined)?.setData(fc);
    if (ridePos && follow) {
      map.easeTo({
        center: [ridePos.lng, ridePos.lat],
        zoom: Math.max(map.getZoom(), 13.5),
        duration: 600,
      });
    }
  }, [ridePos, follow, layersReady]);

  const armMapPick = useCallback((): Promise<[number, number]> => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = 'crosshair';
    return new Promise((res) => { pickResolver.current = res; });
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layersAdded.current) return;
    for (const cat of Object.keys(CAT_META)) {
      const vis = visibleCats[cat] ? 'visible' : 'none';
      for (const suffix of ['clusters', 'cluster-count', 'pts']) {
        const id = `res-${cat}-${suffix}`;
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
      }
    }
  }, [visibleCats]);

  function fitTo(coords: [number, number][]) {
    const map = mapRef.current;
    if (!map || !coords.length) return;
    const b = coords.reduce(
      (acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(b, { padding: 50, animate: false });
  }

  const segments = routeData?.segments.features.map((f) => f.properties) ?? [];
  const counts: Record<string, number> = {};
  for (const f of resources?.features ?? []) {
    const c = (f.properties as { category: string }).category;
    counts[c] = (counts[c] ?? 0) + 1;
  }

  // Selecting a day from the panel zooms to it; selecting on the map does not.
  const selectDayFromPanel = (day: number | null) => {
    setSelectedDay(day);
    if (day == null) return;
    const f = plan?.geometry?.lines.features.find(
      (x) => (x.properties as { dayNumber: number }).dayNumber === day
    );
    if (f && f.geometry.type === 'LineString') {
      fitTo(f.geometry.coordinates as [number, number][]);
    }
  };

  return (
    <div className="app">
      <aside className={`sidebar ${sheetOpen ? '' : 'collapsed'}`}>
        <div className="sheet-handle" onClick={() => setSheetOpen((o) => !o)} />
        <div className="head-row" onClick={() => setSheetOpen(true)}>
          <div>
            <h1>Grimey's Trip Planner</h1>
            <div className="subtitle">Pensacola → San Diego → Los Angeles</div>
          </div>
          {routeData?.route && (
            <div className="total">{Math.round(routeData.route.totalMiles).toLocaleString()} mi</div>
          )}
        </div>
        {error && <div className="error">Failed to load: {error}. Did you run the ingest scripts?</div>}

        <div className="tabs">
          <button className={tab === 'days' ? 'on' : ''} onClick={() => setTab('days')}>Trip days</button>
          <button className={tab === 'ride' ? 'on' : ''} onClick={() => setTab('ride')}>Ride</button>
          <button className={tab === 'route' ? 'on' : ''} onClick={() => setTab('route')}>Route</button>
        </div>

        {selectedResource && (
          <ResourceDetail r={selectedResource} onClose={() => setSelectedResource(null)} />
        )}

        {tab === 'days' && (
          <PlannerPanel
            plan={plan}
            selectedDay={selectedDay}
            onSelectDay={selectDayFromPanel}
            refetch={refetchPlan}
          />
        )}

        {tab === 'ride' && (
          <RidePanel
            info={ridePos}
            onInfo={setRidePos}
            armMapPick={armMapPick}
            selectResource={(r) => { setSelectedResource(r); setSheetOpen(true); }}
            follow={follow}
            setFollow={setFollow}
          />
        )}

        {tab === 'route' && (<>
        <h2>Route segments</h2>
        <ul className="segments">
          {segments.map((s) => {
            const prov = provOf(s);
            return (
              <li
                key={s.id}
                onClick={() => {
                  const f = routeData?.segments.features.find((x) => x.properties.id === s.id);
                  if (f) fitTo(f.geometry.coordinates as [number, number][]);
                }}
                title={`Mile ${s.startMile}–${s.endMile} · ${prov?.label}`}
              >
                <span
                  className="swatch"
                  style={
                    prov?.dashed
                      ? { backgroundImage: `repeating-linear-gradient(90deg, ${prov.color} 0 5px, transparent 5px 8px)` }
                      : { background: prov?.color }
                  }
                />
                <span className="seg-name">{s.name}</span>
                <span className="seg-miles">{Math.round(s.endMile - s.startMile)} mi</span>
              </li>
            );
          })}
        </ul>

        <h2>Resources</h2>
        {Object.entries(CAT_META).map(([cat, meta]) => (
          <label key={cat} className="cat-toggle">
            <input
              type="checkbox"
              checked={visibleCats[cat]}
              onChange={(e) => setVisibleCats((v) => ({ ...v, [cat]: e.target.checked }))}
            />
            <span className="dot" style={{ background: meta.color }} />
            {meta.label}
            <span className="count">{counts[cat] ?? 0}</span>
          </label>
        ))}
        <div className="note">
          <b>This follows the current ACA Southern Tier corridor (2021+ editions),
          reconstructed from public sources.</b> Solid lines are OSM USBR 90 geometry
          used only where it is verified concurrent with the Southern Tier (coastal
          FL/AL with the Mobile Bay Ferry, New Roads→Merryville LA, Morristown→Ehrenberg
          AZ). Dashed lines are bicycle-routed between towns attested by ACA's public
          pages and 2007–2026 ride journals — right corridor and towns, approximate
          streets, never claimed as official ACA geometry. Includes ACA's official
          Pearl River bridge detour (US 90 bridge closed since 2022). Click any
          segment for its sources.
        </div>
        </>)}
      </aside>
      <div ref={containerRef} className="map" />
    </div>
  );
}
