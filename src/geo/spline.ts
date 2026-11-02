import { dist, type Pt } from './mercator';

const EPS = 1e-12;
/** World-unit step between samples; ~400 m at 60 degrees north. */
const STEP = 2e-5;
const MIN_SAMPLES = 24;
const MAX_SAMPLES = 320;

function reflect(a: Pt, b: Pt): Pt {
  return [2 * a[0] - b[0], 2 * a[1] - b[1]];
}

function mix(a: Pt, b: Pt, wa: number, wb: number): Pt {
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb];
}

/** Barry–Goldman evaluation of a centripetal Catmull–Rom segment. */
function evalSegment(p0: Pt, p1: Pt, p2: Pt, p3: Pt, knots: number[], t: number): Pt {
  const [t0, t1, t2, t3] = knots as [number, number, number, number];
  const a1 = mix(p0, p1, (t1 - t) / (t1 - t0), (t - t0) / (t1 - t0));
  const a2 = mix(p1, p2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
  const a3 = mix(p2, p3, (t3 - t) / (t3 - t2), (t - t2) / (t3 - t2));
  const b1 = mix(a1, a2, (t2 - t) / (t2 - t0), (t - t0) / (t2 - t0));
  const b2 = mix(a2, a3, (t3 - t) / (t3 - t1), (t - t1) / (t3 - t1));
  return mix(b1, b2, (t2 - t) / (t2 - t1), (t - t1) / (t2 - t1));
}

export interface SampledSpline {
  pts: Pt[];
  /** Index in `pts` where each control segment starts (length = control points - 1). */
  segmentStart: number[];
}

/**
 * Samples a smooth curve that passes exactly through every control point.
 * Centripetal parametrisation avoids loops and overshoot, so the curve hugs
 * the control polygon and rarely strays far from where the user put waypoints.
 */
export function sampleSpline(ctrl: Pt[]): SampledSpline {
  if (ctrl.length < 2) return { pts: ctrl.slice(), segmentStart: [] };
  const pts: Pt[] = [];
  const segmentStart: number[] = [];

  for (let i = 0; i < ctrl.length - 1; i++) {
    const p1 = ctrl[i]!;
    const p2 = ctrl[i + 1]!;
    const p0 = i > 0 ? ctrl[i - 1]! : reflect(p1, p2);
    const p3 = i + 2 < ctrl.length ? ctrl[i + 2]! : reflect(p2, p1);

    const t0 = 0;
    const t1 = t0 + Math.sqrt(Math.max(dist(p0, p1), EPS));
    const t2 = t1 + Math.sqrt(Math.max(dist(p1, p2), EPS));
    const t3 = t2 + Math.sqrt(Math.max(dist(p2, p3), EPS));
    const knots = [t0, t1, t2, t3];

    const n = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(dist(p1, p2) / STEP)));
    segmentStart.push(pts.length);
    // Include the start of every segment; the final point is added after the loop.
    for (let k = 0; k < n; k++) {
      pts.push(evalSegment(p0, p1, p2, p3, knots, t1 + ((t2 - t1) * k) / n));
    }
  }
  pts.push(ctrl[ctrl.length - 1]!);
  return { pts, segmentStart };
}
