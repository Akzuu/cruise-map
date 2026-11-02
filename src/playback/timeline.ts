import { clamp, lerpAngle, toWorld, type Pt } from '../geo/mercator';
import { headingAtDistance, pointAtDistance, type LegPath } from '../route/path';
import type { Project } from '../types';

export type SegmentKind = 'intro' | 'pause' | 'leg' | 'outro';

export interface Segment {
  kind: SegmentKind;
  start: number;
  end: number;
  /** Stop index for pauses, leg index for legs. */
  index: number;
}

export interface Timeline {
  segments: Segment[];
  total: number;
  /** Time the boat reaches each stop. */
  arrival: number[];
  /** Pause length at each stop (0 if none). */
  pause: number[];
  legStart: number[];
  legEnd: number[];
}

const MIN_LEG_SEC = 0.1;

export function stopPause(project: Project, i: number): number {
  return Math.max(0, project.stops[i]?.pauseSec ?? project.settings.defaultPauseSec);
}

export function legDuration(project: Project, i: number): number {
  return Math.max(MIN_LEG_SEC, project.legs[i]?.durationSec ?? project.settings.legDurationSec);
}

export function buildTimeline(project: Project): Timeline {
  const { stops, settings } = project;
  const segments: Segment[] = [];
  const tl: Timeline = { segments, total: 0, arrival: [], pause: [], legStart: [], legEnd: [] };
  if (stops.length === 0) return tl;

  let t = 0;
  const push = (kind: SegmentKind, index: number, dur: number) => {
    if (dur <= 0) return;
    segments.push({ kind, start: t, end: t + dur, index });
    t += dur;
  };

  if (settings.camera.intro) push('intro', 0, settings.camera.introSec);
  for (let i = 0; i < stops.length; i++) {
    tl.arrival.push(t);
    const p = stopPause(project, i);
    tl.pause.push(p);
    push('pause', i, p);
    if (i < stops.length - 1) {
      const d = legDuration(project, i);
      tl.legStart.push(t);
      push('leg', i, d);
      tl.legEnd.push(t);
    }
  }
  if (settings.camera.outro) push('outro', stops.length - 1, settings.camera.outroSec + settings.camera.outroHoldSec);
  tl.total = t;
  return tl;
}

export function segmentAt(tl: Timeline, t: number): Segment | null {
  for (const s of tl.segments) if (t >= s.start && t < s.end) return s;
  return null;
}

export interface Frame {
  t: number;
  seg: Segment | null;
  /** Progress through the current segment, 0..1. */
  u: number;
  boat: { pt: Pt; heading: number } | null;
  /** Number of stops the boat has reached. */
  visited: number;
  /** Stop whose card is showing, or -1. */
  activeStop: number;
  /** Number of completed legs. */
  doneLegs: number;
  live: { leg: number; dist: number } | null;
}

export interface FrameContext {
  project: Project;
  paths: LegPath[];
  tl: Timeline;
}

const TURN_BLEND = 0.12;

/** Fraction of a leg spent speeding up, and again slowing down. */
const RAMP = 0.25;

/**
 * Distance fraction after time fraction u. 'ease' is a cruise profile: the
 * speed eases up from rest over the first quarter of the leg, holds steady,
 * and eases back to rest over the last quarter, so the boat glides into and
 * out of each stop instead of snapping to full speed.
 */
export function ease(easing: Project['settings']['easing'], u: number): number {
  if (easing !== 'ease') return u;
  const x = clamp(u, 0, 1);
  const cruise = 1 / (1 - RAMP);
  // Distance covered while the speed eases (cosine) from 0 to full over fraction k of the leg.
  const ramp = (k: number) => cruise * RAMP * (k / 2 - Math.sin(Math.PI * k) / (2 * Math.PI));
  if (x < RAMP) return ramp(x / RAMP);
  if (x > 1 - RAMP) return 1 - ramp((1 - x) / RAMP);
  return cruise * (RAMP / 2 + (x - RAMP));
}

export function computeFrame(ctx: FrameContext, t: number): Frame {
  const { project, paths, tl } = ctx;
  const n = project.stops.length;
  const seg = segmentAt(tl, t);
  const u = seg ? (t - seg.start) / (seg.end - seg.start) : t >= tl.total ? 1 : 0;
  const frame: Frame = { t, seg, u, boat: null, visited: 0, activeStop: -1, doneLegs: 0, live: null };
  if (n === 0) return frame;

  for (let i = 0; i < n; i++) if (tl.arrival[i]! <= t) frame.visited = i + 1;
  for (let i = 0; i < n; i++) {
    if (tl.pause[i]! > 0 && t >= tl.arrival[i]! && t < tl.arrival[i]! + tl.pause[i]!) frame.activeStop = i;
  }
  for (let i = 0; i < tl.legEnd.length; i++) if (tl.legEnd[i]! <= t) frame.doneLegs = i + 1;

  let li = -1;
  for (let i = 0; i < tl.legStart.length; i++) {
    if (t >= tl.legStart[i]!) li = i;
    else break;
  }

  if (li === -1) {
    const first = paths[0];
    frame.boat = {
      pt: toWorld(project.stops[0]!.lngLat),
      heading: first ? headingAtDistance(first, 0) : 0,
    };
    return frame;
  }

  const path = paths[li]!;
  if (t >= tl.legEnd[li]!) {
    frame.boat = { pt: path.pts[path.pts.length - 1]!, heading: headingAtDistance(path, path.length) };
    return frame;
  }

  const lu = (t - tl.legStart[li]!) / (tl.legEnd[li]! - tl.legStart[li]!);
  const dist = clamp(ease(project.settings.easing, lu), 0, 1) * path.length;
  let heading = headingAtDistance(path, dist);
  if (li > 0 && lu < TURN_BLEND) {
    const prev = paths[li - 1]!;
    const k = lu / TURN_BLEND;
    heading = lerpAngle(headingAtDistance(prev, prev.length), heading, k * k * (3 - 2 * k));
  }
  frame.boat = { pt: pointAtDistance(path, dist), heading };
  frame.live = { leg: li, dist };
  return frame;
}

