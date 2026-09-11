import { useEffect, useRef } from 'react';
import maplibregl, { Map as MLMap } from 'maplibre-gl';
import { apiGet } from './api';

// The map side of picking a place: candidate dots with labels, the day's
// anchors, hover/click, and a one-time frame of the stretch. Shared by the
// one-shot picker (choose a bed / a work stop) and the Day Builder, so the
// route, its provenance and every other layer stay exactly as drawn under
// both — one drawing implementation, two panels.

export const SRC = 'pick-cands';
export const LYR_DOT = 'pick-cand-dot';
export const LYR_LABEL = 'pick-cand-label';
export const SRC_ANCHOR = 'pick-anchors';
export const LYR_ANCHOR = 'pick-anchor-dot';
export const LYR_ANCHOR_LABEL = 'pick-anchor-label';

export interface CandFeature {
  id: string; name: string; lat: number; lng: number;
  /** lower sorts first: the best options keep their names when markers crowd */
  sort: number;
  chosen?: boolean;
  /** free-form properties the colour expression can match on */
  props?: Record<string, string | number | boolean | null>;
}
export interface AnchorFeature { label: string; lat: number; lng: number; kind?: string }

/**
 * Draw candidates into the shared map. `color` is a MapLibre expression over
 * the feature properties; `label` likewise (defaults to the name).
 */
export function useCandidateLayer(
  map: MLMap | null,
  cands: CandFeature[],
  color: unknown,
  label: unknown = ['get', 'name'],
) {
  useEffect(() => {
    if (!map) return;
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: cands.map((c) => ({
        type: 'Feature',
        properties: { id: c.id, name: c.name, sort: c.sort, chosen: c.chosen ? 1 : 0, ...(c.props ?? {}) },
        geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      })),
    };
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: fc });
      map.addLayer({
        id: LYR_DOT, type: 'circle', source: SRC,
        paint: {
          'circle-color': color as never,
          'circle-radius': ['case', ['==', ['get', 'chosen'], 1], 9, 7] as never,
          'circle-stroke-color': ['case', ['==', ['get', 'chosen'], 1], '#1a1814', '#ffffff'] as never,
          'circle-stroke-width': ['case', ['==', ['get', 'chosen'], 1], 3, 2] as never,
        },
      });
      map.addLayer({
        id: LYR_LABEL, type: 'symbol', source: SRC,
        layout: {
          'text-field': label as never,
          'text-size': 12, 'text-offset': [0, 0.9], 'text-anchor': 'top',
          'text-font': ['Noto Sans Regular'],
          'text-max-width': 11,
          'symbol-sort-key': ['get', 'sort'] as never,
          'text-padding': 3,
        },
        paint: {
          'text-color': '#1a1814',
          'text-halo-color': '#f3efe4', 'text-halo-width': 1.8,
        },
      });
    } else {
      (map.getSource(SRC) as maplibregl.GeoJSONSource).setData(fc);
      map.setPaintProperty(LYR_DOT, 'circle-color', color as never);
      map.setLayoutProperty(LYR_LABEL, 'text-field', label as never);
    }
    return () => {
      // The map itself can be torn down before this cleanup runs (unmount
      // order, hot reload) — in that case there is nothing left to clean.
      try {
        for (const l of [LYR_LABEL, LYR_DOT]) if (map.getLayer(l)) map.removeLayer(l);
        if (map.getSource(SRC)) map.removeSource(SRC);
      } catch { /* map already gone */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, cands, JSON.stringify(color), JSON.stringify(label)]);
}

/** Named anchor dots — the day's start and planned end, or a chain's stops. */
export function useAnchorLayer(map: MLMap | null, anchors: AnchorFeature[]) {
  useEffect(() => {
    if (!map) return;
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: anchors.map((a) => ({
        type: 'Feature', properties: { label: a.label, kind: a.kind ?? 'anchor' },
        geometry: { type: 'Point', coordinates: [a.lng, a.lat] },
      })),
    };
    if (!map.getSource(SRC_ANCHOR)) {
      map.addSource(SRC_ANCHOR, { type: 'geojson', data: fc });
      map.addLayer({
        id: LYR_ANCHOR, type: 'circle', source: SRC_ANCHOR,
        paint: {
          'circle-radius': 6, 'circle-color': '#1a1814',
          'circle-stroke-color': ['match', ['get', 'kind'], 'chain', '#2f7d32', 'end', '#d96f00', '#f2a900'] as never,
          'circle-stroke-width': 3,
        },
      });
      map.addLayer({
        id: LYR_ANCHOR_LABEL, type: 'symbol', source: SRC_ANCHOR,
        layout: {
          'text-field': ['get', 'label'] as never,
          'text-size': 10.5, 'text-offset': [0, -1.1], 'text-anchor': 'bottom',
          'text-font': ['Noto Sans Regular'], 'text-allow-overlap': true,
        },
        paint: { 'text-color': '#1a1814', 'text-halo-color': '#f3efe4', 'text-halo-width': 2 },
      });
    } else {
      (map.getSource(SRC_ANCHOR) as maplibregl.GeoJSONSource).setData(fc);
    }
    return () => {
      try {
        for (const l of [LYR_ANCHOR_LABEL, LYR_ANCHOR]) if (map.getLayer(l)) map.removeLayer(l);
        if (map.getSource(SRC_ANCHOR)) map.removeSource(SRC_ANCHOR);
      } catch { /* map already gone */ }
    };
  }, [map, anchors]);
}

/** Resolve a route mile to a point, for anchors. */
export async function pointAtMile(mile: number): Promise<{ lat: number; lng: number } | null> {
  try { return await apiGet<{ lat: number; lng: number }>(`/api/position?mile=${mile}`); } catch { return null; }
}

/** Hover highlights, click selects — over the candidate dots. */
export function useCandidateHover(
  map: MLMap | null,
  onHover: (id: string | null) => void,
  onClick: (id: string) => void,
  deps: unknown[] = [],
) {
  useEffect(() => {
    if (!map) return;
    const onMove = (e: maplibregl.MapLayerMouseEvent) => {
      const id = (e.features?.[0]?.properties as { id?: string })?.id;
      if (id) { onHover(String(id)); map.getCanvas().style.cursor = 'pointer'; }
    };
    const onLeave = () => { onHover(null); map.getCanvas().style.cursor = ''; };
    const onTap = (e: maplibregl.MapLayerMouseEvent) => {
      const id = (e.features?.[0]?.properties as { id?: string })?.id;
      if (id) onClick(String(id));
    };
    map.on('mousemove', LYR_DOT, onMove);
    map.on('mouseleave', LYR_DOT, onLeave);
    map.on('click', LYR_DOT, onTap);
    return () => {
      try {
        map.off('mousemove', LYR_DOT, onMove);
        map.off('mouseleave', LYR_DOT, onLeave);
        map.off('click', LYR_DOT, onTap);
      } catch { /* map already gone */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, ...deps]);
}

/**
 * Frame a stretch of route plus some points, ONCE per key — then leave the
 * camera alone so panning and zooming to inspect is never fought by a re-fit.
 */
export function useFitOnce(
  map: MLMap | null,
  key: string,
  lo: number, hi: number,
  points: [number, number][],
  padding: { top: number; bottom: number; left: number; right: number },
) {
  const fittedFor = useRef('');
  useEffect(() => {
    if (!map) return;
    if (fittedFor.current === key) return;
    fittedFor.current = key;
    (async () => {
      try {
        const { coords } = await apiGet<{ coords: [number, number][] }>(
          `/api/route/points?minMile=${lo}&maxMile=${hi}`);
        const pts: [number, number][] = [...coords, ...points];
        if (pts.length < 2) return;
        const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
        map.fitBounds(b, { padding, animate: false });
      } catch { /* keep whatever view the map already has */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
}
