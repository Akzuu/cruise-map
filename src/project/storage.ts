import { defaultSettings, emptyProject, type Project, type Settings } from '../types';
import { syncLegs } from '../route/model';
import { isImageDataUrl } from '../map/icons';
import { STYLES } from '../map/styles';

const PROJECT_KEY = 'boat-route:project';
const KEY_KEY = 'boat-route:maptiler-key';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Overlay loaded values onto defaults, keeping only keys (and types) the defaults know about. */
function mergeInto<T>(base: T, incoming: unknown): T {
  if (!isObj(base) || !isObj(incoming)) return base;
  const out: Json = { ...(base as Json) };
  for (const k of Object.keys(base as Json)) {
    const b = (base as Json)[k];
    const v = incoming[k];
    if (v === undefined) continue;
    if (isObj(b)) out[k] = mergeInto(b, v);
    else if (Array.isArray(b)) {
      if (Array.isArray(v) && v.length === b.length && v.every((x, i) => typeof x === typeof b[i])) out[k] = v;
    } else if (typeof b === typeof v || b === null) out[k] = v;
  }
  return out as T;
}

const isLngLat = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

const pick = <T extends string>(v: T, allowed: readonly T[], fallback: T): T => (allowed.includes(v) ? v : fallback);
const num = (v: number, min: number, max: number, fallback: number): number =>
  Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const color = (v: string, fallback: string): string => (/^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback);

/** Loaded files are untrusted: force every value into the range the app can render. */
function sanitizeSettings(s: Settings): Settings {
  const d = defaultSettings();
  s.legDurationSec = num(s.legDurationSec, 0.5, 300, d.legDurationSec);
  s.defaultPauseSec = num(s.defaultPauseSec, 0, 60, d.defaultPauseSec);
  s.easing = pick(s.easing, ['linear', 'ease'], d.easing);
  s.style = pick(s.style, STYLES.map((x) => x.id), d.style);
  s.aspectLock = pick(s.aspectLock, ['free', '16:9', '9:16', '1:1', '4:3', '21:9'], d.aspectLock);
  s.customMap.kind = pick(s.customMap.kind, ['style', 'raster'], 'style');
  s.customMap.url = s.customMap.url.slice(0, 2000);
  s.customMap.attribution = s.customMap.attribution.slice(0, 300);
  s.coordFormat = pick(s.coordFormat, ['decimal', 'degmin', 'dms'], d.coordFormat);

  s.trail.color = color(s.trail.color, d.trail.color);
  s.trail.width = num(s.trail.width, 0.5, 100, d.trail.width);
  s.trail.opacity = num(s.trail.opacity, 0, 1, d.trail.opacity);
  s.trail.dash = [num(s.trail.dash[0], 0.1, 50, d.trail.dash[0]), num(s.trail.dash[1], 0.1, 50, d.trail.dash[1])];

  s.boat.icon = pick(s.boat.icon, ['ship', 'sailboat', 'arrow', 'dot', 'custom'], d.boat.icon);
  s.boat.size = num(s.boat.size, 4, 400, d.boat.size);
  s.boat.color = color(s.boat.color, d.boat.color);
  s.boat.rotationOffset = num(s.boat.rotationOffset, -360, 360, d.boat.rotationOffset);
  if (!isImageDataUrl(s.boat.customImage)) s.boat.customImage = null;

  s.labels.size = num(s.labels.size, 6, 120, d.labels.size);
  s.labels.theme = pick(s.labels.theme, ['light', 'dark'], d.labels.theme);

  const c = s.camera;
  c.stopZoom = num(c.stopZoom, 0, 19, d.camera.stopZoom);
  c.travelZoom = num(c.travelZoom, 0, 19, d.camera.travelZoom);
  c.introSec = num(c.introSec, 0.5, 30, d.camera.introSec);
  c.outroSec = num(c.outroSec, 0.5, 30, d.camera.outroSec);
  c.outroHoldSec = num(c.outroHoldSec, 0, 30, d.camera.outroHoldSec);
  return s;
}

export function parseProject(text: string): Project {
  const raw: unknown = JSON.parse(text);
  if (!isObj(raw) || !Array.isArray(raw.stops)) throw new Error('This file does not look like a route project.');
  const project = emptyProject();
  if (typeof raw.name === 'string' && raw.name.trim()) project.name = raw.name.trim();
  project.settings = sanitizeSettings(mergeInto<Settings>(defaultSettings(), raw.settings));
  const sv = isObj(raw.settings) && isObj(raw.settings.camera) ? raw.settings.camera.startView : null;
  project.settings.camera.startView =
    isObj(sv) && isLngLat(sv.center) && typeof sv.zoom === 'number' && Number.isFinite(sv.zoom)
      ? { center: sv.center, zoom: num(sv.zoom, 0, 22, 8) }
      : null;

  for (const s of raw.stops) {
    if (!isObj(s) || !isLngLat(s.lngLat)) continue;
    project.stops.push({
      id: typeof s.id === 'string' && s.id ? s.id : `s${project.stops.length}${Date.now().toString(36)}`,
      name: typeof s.name === 'string' ? s.name : `Stop ${project.stops.length + 1}`,
      lngLat: s.lngLat,
      pauseSec: typeof s.pauseSec === 'number' ? s.pauseSec : null,
      popup: typeof s.popup === 'boolean' ? s.popup : true,
      zoom: typeof s.zoom === 'number' && Number.isFinite(s.zoom) ? num(s.zoom, 0, 19, 11) : null,
    });
  }
  const loadedLegs = Array.isArray(raw.legs) ? raw.legs : [];
  project.legs = loadedLegs.flatMap((l) =>
    isObj(l) && typeof l.from === 'string' && typeof l.to === 'string'
      ? [
          {
            from: l.from,
            to: l.to,
            waypoints: Array.isArray(l.waypoints) ? l.waypoints.filter(isLngLat) : [],
            durationSec: typeof l.durationSec === 'number' ? l.durationSec : null,
            travelZoom: typeof l.travelZoom === 'number' && Number.isFinite(l.travelZoom) ? num(l.travelZoom, 0, 19, 8) : null,
          },
        ]
      : [],
  );
  if (raw.stops.length > 0 && project.stops.length === 0) throw new Error('No valid stops were found in that file.');
  syncLegs(project);
  return project;
}

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

export function downloadProject(project: Project): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = project.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'route';
  a.href = url;
  a.download = `${safe}.route.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Returns false when the browser refused the write (quota, private mode). */
export function autosave(project: Project): boolean {
  try {
    localStorage.setItem(PROJECT_KEY, serializeProject(project));
    return true;
  } catch {
    return false;
  }
}

export function loadAutosave(): Project | null {
  let text: string | null = null;
  try {
    text = localStorage.getItem(PROJECT_KEY);
    return text ? parseProject(text) : null;
  } catch {
    // Keep what we could not read: the next autosave would otherwise overwrite it for good.
    try {
      if (text) localStorage.setItem(`${PROJECT_KEY}-unreadable`, text);
    } catch {
      /* ignore */
    }
    return null;
  }
}

const WELCOME_KEY = 'boat-route:welcome-seen';

export function welcomeSeen(): boolean {
  try {
    return localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return true; // without storage we could not remember the dismissal, so don't nag
  }
}

export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(WELCOME_KEY, '1');
  } catch {
    /* ignore */
  }
}

/** The MapTiler key lives only in this browser, never in the project file, so shared projects don't leak it. */
export function loadMapTilerKey(): string | null {
  try {
    const stored = localStorage.getItem(KEY_KEY);
    if (stored) return stored;
  } catch {
    /* ignore */
  }
  const fromEnv = import.meta.env.VITE_MAPTILER_KEY as string | undefined;
  return fromEnv || null;
}

export function saveMapTilerKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_KEY, key);
    else localStorage.removeItem(KEY_KEY);
  } catch {
    /* ignore */
  }
}
