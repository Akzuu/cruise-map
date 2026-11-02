import type { LngLat, Leg, Project, Stop } from '../types';
import { buildLegPath, type LegPath } from './path';
import type { Pt } from '../geo/mercator';

let counter = 0;
export function newId(prefix = 's'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * Keeps `legs` in step with `stops`: one leg per consecutive pair. Legs whose
 * pair still exists keep their waypoints and duration; new pairs start empty.
 */
export function syncLegs(project: Project): void {
  const old = new Map(project.legs.map((l) => [`${l.from}>${l.to}`, l]));
  const legs: Leg[] = [];
  for (let i = 0; i < project.stops.length - 1; i++) {
    const from = project.stops[i]!.id;
    const to = project.stops[i + 1]!.id;
    legs.push(old.get(`${from}>${to}`) ?? { from, to, waypoints: [], durationSec: null, travelZoom: null });
  }
  project.legs = legs;
}

export function addStop(project: Project, lngLat: LngLat, name?: string): Stop {
  const stop: Stop = {
    id: newId(),
    name: name ?? `Stop ${project.stops.length + 1}`,
    lngLat,
    pauseSec: null,
    popup: true,
    zoom: null,
  };
  project.stops.push(stop);
  syncLegs(project);
  return stop;
}

export function removeStop(project: Project, id: string): void {
  project.stops = project.stops.filter((s) => s.id !== id);
  syncLegs(project);
}

export function moveStop(project: Project, id: string, delta: -1 | 1): void {
  const i = project.stops.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= project.stops.length) return;
  const [s] = project.stops.splice(i, 1);
  project.stops.splice(j, 0, s!);
  syncLegs(project);
}

export function buildPaths(project: Project): LegPath[] {
  const paths: LegPath[] = [];
  for (let i = 0; i < project.stops.length - 1; i++) {
    paths.push(buildLegPath(project.stops[i]!.lngLat, project.legs[i]?.waypoints ?? [], project.stops[i + 1]!.lngLat));
  }
  return paths;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

const LEG_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#e03131', '#5c7cfa'];

/** Edit-only colour that tells a leg's bend dots (and its list row) apart. */
export const legColor = (leg: number): string => LEG_COLORS[leg % LEG_COLORS.length]!;

export interface RouteHit {
  leg: number;
  /** Index into that leg's waypoints where a new point belongs. */
  insertAt: number;
  distancePx: number;
}

/**
 * Finds which leg (and where along it) a click is closest to, measured on
 * screen. `toScreen` maps a world-coordinate point to pixels. `onlyLeg`
 * restricts the search to one leg, so overlapping legs stay unambiguous.
 */
export function hitTestRoute(paths: LegPath[], click: Pt, toScreen: (p: Pt) => Pt, onlyLeg?: number): RouteHit | null {
  let best: { leg: number; sample: number; d: number } | null = null;
  paths.forEach((path, leg) => {
    if (onlyLeg !== undefined && leg !== onlyLeg) return;
    let prev = toScreen(path.pts[0]!);
    for (let k = 1; k < path.pts.length; k++) {
      const cur = toScreen(path.pts[k]!);
      const d = distToSegment(click, prev, cur);
      if (!best || d < best.d) best = { leg, sample: k - 1, d };
      prev = cur;
    }
  });
  if (!best) return null;
  const { leg, sample, d } = best as { leg: number; sample: number; d: number };
  const starts = paths[leg]!.segmentStart;
  let insertAt = 0;
  for (let j = 0; j < starts.length; j++) if (starts[j]! <= sample) insertAt = j;
  return { leg, insertAt, distancePx: d };
}

export function insertWaypoint(project: Project, hit: RouteHit, lngLat: LngLat): void {
  project.legs[hit.leg]?.waypoints.splice(hit.insertAt, 0, lngLat);
}
