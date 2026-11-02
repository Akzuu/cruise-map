/**
 * Geometry for the route is done in "world coordinates": Web Mercator
 * normalised to 0..1 (x east, y south). In this plane a north-up map has no
 * distortion, so splines, headings and camera blends match what is on screen.
 */
export type LngLat = [number, number];
export type Pt = [number, number];

const MAX_LAT = 85.0511287798;

export function toWorld([lng, lat]: LngLat): Pt {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  const x = (lng + 180) / 360;
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [x, y];
}

export function fromWorld([x, y]: Pt): LngLat {
  const lng = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lng, lat];
}

export const dist = (a: Pt, b: Pt): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpPt = (a: Pt, b: Pt, t: number): Pt => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Heading in degrees clockwise from north for a movement in world coordinates. */
export function headingOf(from: Pt, to: Pt): number {
  const deg = (Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Interpolate between two headings along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}
