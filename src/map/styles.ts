import type { MapOptions } from 'maplibre-gl';
import type { CustomMap, StyleId } from '../types';

export type StyleSpec = Exclude<NonNullable<MapOptions['style']>, string>;

export interface StyleDef {
  id: StyleId;
  label: string;
  needsKey: boolean;
  build: (key: string | null, custom?: CustomMap) => StyleSpec | string;
}

const raster = (tiles: string[], tileSize: number, maxzoom: number, attribution: string): StyleSpec => ({
  version: 8,
  sources: { base: { type: 'raster', tiles, tileSize, maxzoom, attribution } },
  layers: [{ id: 'base', type: 'raster', source: 'base' }],
});

const carto = (name: string): StyleSpec =>
  raster(
    ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/${name}/{z}/{x}/{y}@2x.png`),
    256,
    20,
    '© <a href="https://carto.com/attributions">CARTO</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  );

const maptiler = (id: string) => (key: string | null) =>
  `https://api.maptiler.com/maps/${id}/style.json?key=${encodeURIComponent(key ?? '')}`;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Only https (or plain http on this machine), so a project file cannot point the map at arbitrary schemes. */
const isHttpUrl = (u: string): boolean => /^https:\/\/[^\s]+$/i.test(u) || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/[^\s]*$/i.test(u);

export const customUrlHasKey = (c: CustomMap): boolean => c.url.includes('{key}');

/** Why a custom map cannot be used right now, or null when it can. */
export function customProblem(c: CustomMap, key: string | null): string | null {
  const url = c.url.trim();
  if (!url) return 'Enter a map URL.';
  if (!isHttpUrl(url)) return 'The URL must start with https://.';
  if (c.kind === 'raster' && !['{z}', '{x}', '{y}'].every((t) => url.includes(t))) return 'Tile URLs need {z}, {x} and {y} in them.';
  if (customUrlHasKey(c) && !key) return 'This URL uses {key}, so add your MapTiler key first.';
  return null;
}

const buildCustom = (key: string | null, c?: CustomMap): StyleSpec | string => {
  const url = (c?.url ?? '').trim().split('{key}').join(encodeURIComponent(key ?? ''));
  if (c?.kind === 'raster') return raster([url], 256, 22, escapeHtml(c.attribution));
  return url;
};

export const STYLES: StyleDef[] = [
  { id: 'carto-voyager', label: 'Voyager (colour)', needsKey: false, build: () => carto('voyager') },
  { id: 'carto-light', label: 'Light', needsKey: false, build: () => carto('light_all') },
  { id: 'carto-dark', label: 'Dark', needsKey: false, build: () => carto('dark_all') },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    needsKey: false,
    build: () =>
      raster(
        ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        256,
        19,
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      ),
  },
  {
    id: 'esri-satellite',
    label: 'Satellite (Esri)',
    needsKey: false,
    build: () =>
      raster(
        ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        256,
        19,
        'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      ),
  },
  {
    id: 'esri-ocean',
    label: 'Ocean (Esri)',
    needsKey: false,
    build: () =>
      raster(
        ['https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}'],
        256,
        13,
        'Tiles © Esri — Sources: GEBCO, NOAA, CHS, OSU, UNH, CSUMB, National Geographic, DeLorme, NAVTEQ, and Esri',
      ),
  },
  { id: 'maptiler-streets', label: 'MapTiler Streets', needsKey: true, build: maptiler('streets-v2') },
  { id: 'maptiler-ocean', label: 'MapTiler Ocean', needsKey: true, build: maptiler('ocean') },
  { id: 'maptiler-hybrid', label: 'MapTiler Hybrid', needsKey: true, build: maptiler('hybrid') },
  { id: 'maptiler-dark', label: 'MapTiler Dark', needsKey: true, build: maptiler('dataviz-dark') },
  { id: 'maptiler-basic', label: 'MapTiler Basic', needsKey: true, build: maptiler('basic-v2') },
  { id: 'maptiler-outdoor', label: 'MapTiler Outdoor', needsKey: true, build: maptiler('outdoor-v2') },
  { id: 'maptiler-topo', label: 'MapTiler Topo', needsKey: true, build: maptiler('topo-v2') },
  { id: 'maptiler-satellite', label: 'MapTiler Satellite', needsKey: true, build: maptiler('satellite') },
  { id: 'maptiler-light', label: 'MapTiler Light', needsKey: true, build: maptiler('dataviz-light') },
  { id: 'maptiler-toner', label: 'MapTiler Toner', needsKey: true, build: maptiler('toner-v2') },
  { id: 'custom', label: 'Custom map…', needsKey: false, build: buildCustom },
];

export const FALLBACK_STYLE: StyleId = 'carto-voyager';

export function resolveStyle(id: StyleId, key: string | null, custom?: CustomMap): { def: StyleDef; fellBack: boolean } {
  const def = STYLES.find((s) => s.id === id) ?? STYLES[0]!;
  if (def.id === 'custom' && (!custom || customProblem(custom, key))) return { def: STYLES.find((s) => s.id === FALLBACK_STYLE)!, fellBack: true };
  if (def.needsKey && !key) return { def: STYLES.find((s) => s.id === FALLBACK_STYLE)!, fellBack: true };
  return { def, fellBack: false };
}
