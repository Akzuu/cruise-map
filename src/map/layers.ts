import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { LngLat, Settings } from '../types';

export type Geo = GeoJSON.FeatureCollection | GeoJSON.Feature;

export const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export const multiLine = (lines: LngLat[][]): GeoJSON.Feature => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'MultiLineString', coordinates: lines },
});

export const line = (coords: LngLat[]): GeoJSON.Feature =>
  coords.length < 2
    ? { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: [] } }
    : { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } };

export interface LayerData {
  preview: Geo;
  done: Geo;
  live: Geo;
  active: Geo;
}

const SOURCES = ['route-preview', 'trail-done', 'trail-live'] as const;
type SourceId = (typeof SOURCES)[number];

export function installLayers(map: MapLibreMap, settings: Settings, data: LayerData, scale: number, editing: boolean): void {
  if (settings.seaMarks && !map.getSource('seamarks')) {
    map.addSource('seamarks', {
      type: 'raster',
      tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 18,
      attribution: '© <a href="https://www.openseamap.org">OpenSeaMap</a> contributors',
    });
    map.addLayer({ id: 'seamarks', type: 'raster', source: 'seamarks' });
  }

  const geo: Record<SourceId, Geo> = { 'route-preview': data.preview, 'trail-done': data.done, 'trail-live': data.live };
  for (const id of SOURCES) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: geo[id] });
    if (!map.getLayer(`${id}-line`)) {
      map.addLayer({
        id: `${id}-line`,
        type: 'line',
        source: id,
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: {},
      });
    }
  }
  applyTrailPaint(map, settings, scale);
  if (!map.getSource('route-active')) map.addSource('route-active', { type: 'geojson', data: data.active });
  if (!map.getLayer('route-active-line')) {
    map.addLayer({
      id: 'route-active-line',
      type: 'line',
      source: 'route-active',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffd23f', 'line-width': Math.max(2, 6 * scale), 'line-opacity': 0.55 },
    });
  }
  setEditing(map, editing);
}

export function applyTrailPaint(map: MapLibreMap, settings: Settings, scale: number): void {
  const { color, width, dash, opacity } = settings.trail;
  for (const id of SOURCES) {
    const layer = `${id}-line`;
    if (!map.getLayer(layer)) continue;
    map.setPaintProperty(layer, 'line-color', color);
    map.setPaintProperty(layer, 'line-width', Math.max(0.5, width * scale));
    map.setPaintProperty(layer, 'line-opacity', opacity);
    map.setPaintProperty(layer, 'line-dasharray', [Math.max(0.1, dash[0]), Math.max(0.1, dash[1])]);
  }
}

/** Edit mode shows the whole route; playback shows only what has been sailed. */
export function setEditing(map: MapLibreMap, editing: boolean): void {
  const vis = (on: boolean) => (on ? 'visible' : 'none');
  if (map.getLayer('route-preview-line')) map.setLayoutProperty('route-preview-line', 'visibility', vis(editing));
  if (map.getLayer('route-active-line')) map.setLayoutProperty('route-active-line', 'visibility', vis(editing));
  for (const id of ['trail-done-line', 'trail-live-line']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(!editing));
  }
}

export function setSourceData(map: MapLibreMap, id: SourceId | 'route-active', data: Geo): void {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}
