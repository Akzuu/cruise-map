import type { LngLat } from './geo/mercator';

export type { LngLat };

export interface Stop {
  id: string;
  name: string;
  lngLat: LngLat;
  /** Seconds the boat rests here. null = use the project default. */
  pauseSec: number | null;
  /** Show the name + coordinates card while the boat is here. */
  popup: boolean;
  /** Camera zoom at this stop. null = use the project default. */
  zoom: number | null;
}

export interface Leg {
  from: string;
  to: string;
  /** Bend points that shape the curve between the two stops. */
  waypoints: LngLat[];
  /** Seconds this leg takes. null = use the project default. */
  durationSec: number | null;
  /** Camera zoom while sailing this leg. null = use the project default. */
  travelZoom: number | null;
}

export type StyleId =
  | 'carto-voyager'
  | 'carto-light'
  | 'carto-dark'
  | 'osm'
  | 'esri-satellite'
  | 'esri-ocean'
  | 'maptiler-streets'
  | 'maptiler-ocean'
  | 'maptiler-hybrid'
  | 'maptiler-dark'
  | 'maptiler-basic'
  | 'maptiler-outdoor'
  | 'maptiler-topo'
  | 'maptiler-satellite'
  | 'maptiler-light'
  | 'maptiler-toner'
  | 'custom';

/** A map the user points at: a MapLibre style.json, or a raster tile template. */
export interface CustomMap {
  kind: 'style' | 'raster';
  /** https URL. May contain {key}, replaced by the MapTiler key. Raster URLs need {z}, {x} and {y}. */
  url: string;
  /** Credit text for raster tiles (style files carry their own). */
  attribution: string;
}

export type CoordFormat = 'decimal' | 'degmin' | 'dms';
export type AspectLock = 'free' | '16:9' | '9:16' | '1:1' | '4:3' | '21:9';
export type BoatIconId = 'ship' | 'sailboat' | 'arrow' | 'dot' | 'custom';
export type Easing = 'linear' | 'ease';
export type LabelTheme = 'light' | 'dark';

export interface Settings {
  legDurationSec: number;
  defaultPauseSec: number;
  easing: Easing;

  style: StyleId;
  customMap: CustomMap;
  seaMarks: boolean;
  aspectLock: AspectLock;
  showAttribution: boolean;
  coordFormat: CoordFormat;

  trail: { color: string; width: number; dash: [number, number]; opacity: number };
  boat: {
    icon: BoatIconId;
    size: number;
    color: string;
    rotate: boolean;
    rotationOffset: number;
    /** Data URL of an uploaded image, used when icon is 'custom'. */
    customImage: string | null;
  };
  labels: { size: number; theme: LabelTheme; showVisited: boolean; showUpcoming: boolean };
  camera: {
    stopZoom: number;
    travelZoom: number;
    /** Where the intro flies in from (design zoom). null = fit the whole route. */
    startView: { center: LngLat; zoom: number } | null;
    follow: boolean;
    /** Load the map tiles along the whole animation before it plays. */
    preload: boolean;
    intro: boolean;
    introSec: number;
    outro: boolean;
    outroSec: number;
    outroHoldSec: number;
  };
}

export interface Project {
  version: 1;
  name: string;
  settings: Settings;
  stops: Stop[];
  legs: Leg[];
}

export function defaultSettings(): Settings {
  return {
    legDurationSec: 6,
    defaultPauseSec: 3,
    easing: 'ease',

    style: 'osm',
    customMap: { kind: 'style', url: '', attribution: '' },
    seaMarks: false,
    aspectLock: 'free',
    showAttribution: true,
    coordFormat: 'degmin',

    trail: { color: '#d6246e', width: 4, dash: [1.6, 1.4], opacity: 0.95 },
    boat: { icon: 'sailboat', size: 44, color: '#ffffff', rotate: true, rotationOffset: 0, customImage: null },
    labels: { size: 22, theme: 'light', showVisited: true, showUpcoming: false },
    camera: {
      stopZoom: 11,
      travelZoom: 8,
      startView: null,
      follow: true,
      preload: true,
      intro: true,
      introSec: 3,
      outro: true,
      outroSec: 3,
      outroHoldSec: 2,
    },
  };
}

export function emptyProject(): Project {
  return { version: 1, name: 'Untitled route', settings: defaultSettings(), stops: [], legs: [] };
}
