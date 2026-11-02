import { sampleSpline } from '../geo/spline';
import { dist, fromWorld, headingOf, lerpPt, toWorld, type LngLat, type Pt } from '../geo/mercator';

export interface LegPath {
  /** Sampled curve in world coordinates. */
  pts: Pt[];
  /** The same curve as lng/lat, for map sources. */
  lngLat: LngLat[];
  /** Cumulative length at each sample (world units). */
  cum: number[];
  length: number;
  /** Index in `pts` where each control segment starts. */
  segmentStart: number[];
}

export function buildLegPath(from: LngLat, waypoints: LngLat[], to: LngLat): LegPath {
  const ctrl = [from, ...waypoints, to].map(toWorld);
  const { pts, segmentStart } = sampleSpline(ctrl);
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  return { pts, lngLat: pts.map(fromWorld), cum, length: cum[cum.length - 1]!, segmentStart };
}

/** Index i such that cum[i] <= d < cum[i+1] (clamped). */
function segmentIndex(path: LegPath, d: number): number {
  let lo = 0;
  let hi = path.cum.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path.cum[mid]! <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function pointAtDistance(path: LegPath, d: number): Pt {
  if (path.pts.length === 1) return path.pts[0]!;
  const dd = Math.max(0, Math.min(path.length, d));
  const i = segmentIndex(path, dd);
  const span = path.cum[i + 1]! - path.cum[i]!;
  const t = span > 0 ? (dd - path.cum[i]!) / span : 0;
  return lerpPt(path.pts[i]!, path.pts[i + 1]!, t);
}

/** Heading (deg clockwise from north) at distance d, measured over a short window for smoothness. */
export function headingAtDistance(path: LegPath, d: number): number {
  const w = Math.max(path.length * 0.01, 1e-9);
  const a = pointAtDistance(path, d - w);
  const b = pointAtDistance(path, d + w);
  if (a[0] === b[0] && a[1] === b[1]) return 0;
  return headingOf(a, b);
}

/** Lng/lat polyline from the start of the leg up to distance d. */
export function sliceTo(path: LegPath, d: number): LngLat[] {
  if (d <= 0) return [];
  if (d >= path.length) return path.lngLat;
  const i = segmentIndex(path, d);
  const out = path.lngLat.slice(0, i + 1);
  out.push(fromWorld(pointAtDistance(path, d)));
  return out;
}
