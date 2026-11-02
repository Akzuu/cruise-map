import { describe, expect, it } from 'vitest';
import { formatCoordinates, parseCoordinates } from '../src/geo/coords';
import { fromWorld, headingOf, lerpAngle, toWorld, type LngLat } from '../src/geo/mercator';
import { buildLegPath, headingAtDistance, pointAtDistance, sliceTo } from '../src/route/path';
import { addStop, buildPaths, hitTestRoute, insertWaypoint, moveStop, removeStop, syncLegs } from '../src/route/model';
import { buildTimeline, computeFrame, ease, type FrameContext } from '../src/playback/timeline';
import { cameraAt, stopCamera, type CameraContext } from '../src/playback/camera';
import { emptyProject } from '../src/types';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('mercator', () => {
  it('round-trips', () => {
    for (const p of [[24.94, 60.17], [-57.5, -20.2], [0, 0], [179, 80]] as LngLat[]) {
      const q = fromWorld(toWorld(p));
      near(q[0], p[0], 1e-9);
      near(q[1], p[1], 1e-9);
    }
  });
  it('headings follow compass directions', () => {
    near(headingOf([0.5, 0.5], [0.5, 0.4]), 0); // north
    near(headingOf([0.5, 0.5], [0.6, 0.5]), 90); // east
    near(headingOf([0.5, 0.5], [0.5, 0.6]), 180); // south
    near(headingOf([0.5, 0.5], [0.4, 0.5]), 270); // west
  });
  it('lerpAngle takes the short way round', () => {
    near(lerpAngle(350, 10, 0.5), 0);
    near(lerpAngle(10, 350, 0.5), 0);
  });
});

describe('coordinates', () => {
  const cases: [string, LngLat][] = [
    ['60.1699, 24.9384', [24.9384, 60.1699]],
    ['60.1699,24.9384', [24.9384, 60.1699]],
    ['60,1699 24,9384', [24.9384, 60.1699]],
    ['60,1699, 24,9384', [24.9384, 60.1699]],
    ['60.1699 24.9384', [24.9384, 60.1699]],
    ['60°10.194′N 24°56.304′E', [24 + 56.304 / 60, 60 + 10.194 / 60]],
    ["60 10.194 N 24 56.304 E", [24 + 56.304 / 60, 60 + 10.194 / 60]],
    ['N 60 10 12  E 24 56 18', [24 + 56 / 60 + 18 / 3600, 60 + 10 / 60 + 12 / 3600]],
    ['E 24.9384 N 60.1699', [24.9384, 60.1699]],
    ['33.9S 18.4E', [18.4, -33.9]],
    ['-20.2, -57.5', [-57.5, -20.2]],
    ['20.2 S, 57.5 W', [-57.5, -20.2]],
  ];
  for (const [input, expected] of cases) {
    it(`parses ${input}`, () => {
      const r = parseCoordinates(input);
      expect(r.ok).toBe(true);
      if (r.ok) {
        near(r.lngLat[0], expected[0], 1e-9);
        near(r.lngLat[1], expected[1], 1e-9);
      }
    });
  }
  it('rejects nonsense', () => {
    for (const bad of ['', 'hello', '95, 10', '10, 200', '10N 20N', '10 20 30', '60.1 N 24.9']) {
      expect(parseCoordinates(bad).ok, bad).toBe(false);
    }
  });
  it('round-trips through every format', () => {
    for (const fmt of ['decimal', 'degmin', 'dms'] as const) {
      for (const p of [[24.9384, 60.1699], [-57.5, -20.2], [0.0003, 0.0002], [179.9999, -89.9]] as LngLat[]) {
        const r = parseCoordinates(formatCoordinates(p, fmt));
        expect(r.ok, `${fmt} ${p}`).toBe(true);
        if (r.ok) {
          near(r.lngLat[0], p[0], 1e-3);
          near(r.lngLat[1], p[1], 1e-3);
        }
      }
    }
  });
  it('carries minutes correctly when rounding', () => {
    expect(formatCoordinates([0, 10.99999999], 'degmin')).toContain('11°00.000′');
  });
});

describe('leg path', () => {
  const A: LngLat = [24, 60];
  const B: LngLat = [25, 60.5];
  it('passes through endpoints and waypoints', () => {
    const wp: LngLat = [24.6, 59.8];
    const path = buildLegPath(A, [wp], B);
    const first = fromWorld(path.pts[0]!);
    const last = fromWorld(path.pts[path.pts.length - 1]!);
    near(first[0], A[0], 1e-9);
    near(last[1], B[1], 1e-9);
    const w = toWorld(wp);
    const closest = Math.min(...path.pts.map((p) => Math.hypot(p[0] - w[0], p[1] - w[1])));
    expect(closest).toBeLessThan(1e-6);
  });
  it('is a straight line without waypoints', () => {
    const path = buildLegPath(A, [], B);
    const a = toWorld(A);
    const b = toWorld(B);
    for (const p of path.pts) {
      const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      expect(Math.abs(cross)).toBeLessThan(1e-9);
    }
  });
  it('has monotonically increasing cumulative length', () => {
    const path = buildLegPath(A, [[24.3, 60.4], [24.8, 59.7]], B);
    for (let i = 1; i < path.cum.length; i++) expect(path.cum[i]!).toBeGreaterThanOrEqual(path.cum[i - 1]!);
    near(path.length, path.cum[path.cum.length - 1]!, 1e-12);
  });
  const maxHeadingStep = (wps: LngLat[]) => {
    const path = buildLegPath(A, wps, B);
    let prev = headingAtDistance(path, 0);
    let worst = 0;
    for (let k = 1; k <= 500; k++) {
      const h = headingAtDistance(path, (path.length * k) / 500);
      worst = Math.max(worst, Math.abs(((h - prev + 540) % 360) - 180));
      prev = h;
    }
    return worst;
  };
  it('heading changes smoothly around a realistic headland bend', () => {
    expect(maxHeadingStep([[24.4, 60.35], [24.8, 60.45]])).toBeLessThan(5);
  });
  it('heading stays continuous even for a hairpin zigzag', () => {
    expect(maxHeadingStep([[24.3, 60.4], [24.8, 59.7]])).toBeLessThan(20);
  });
  it('points and slices agree', () => {
    const path = buildLegPath(A, [[24.5, 60.4]], B);
    const mid = path.length * 0.37;
    const slice = sliceTo(path, mid);
    const end = toWorld(slice[slice.length - 1]!);
    const p = pointAtDistance(path, mid);
    near(end[0], p[0], 1e-9);
    near(end[1], p[1], 1e-9);
    expect(sliceTo(path, 0)).toEqual([]);
    expect(sliceTo(path, path.length * 2).length).toBe(path.lngLat.length);
  });
  it('tolerates a waypoint sitting on a stop', () => {
    const path = buildLegPath(A, [A], B);
    expect(path.pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
  });
});

function demoProject() {
  const p = emptyProject();
  addStop(p, [24, 60], 'A');
  addStop(p, [25, 60.5], 'B');
  addStop(p, [26, 60]);
  p.legs[0]!.waypoints.push([24.5, 60.4]);
  return p;
}

describe('route model', () => {
  it('keeps one leg per pair and preserves waypoints on reorder/removal', () => {
    const p = demoProject();
    expect(p.legs.length).toBe(2);
    expect(p.legs[0]!.waypoints.length).toBe(1);
    const idB = p.stops[1]!.id;
    removeStop(p, idB);
    expect(p.legs.length).toBe(1);
    expect(p.legs[0]!.waypoints.length).toBe(0);
    moveStop(p, p.stops[0]!.id, 1);
    expect(p.stops[1]!.name).toBe('A');
    syncLegs(p);
    expect(p.legs[0]!.from).toBe(p.stops[0]!.id);
  });
  it('inserts a clicked bend into the nearest leg at the right position', () => {
    const p = demoProject();
    p.legs[0]!.waypoints.push([24.8, 60.45]);
    const paths = buildPaths(p);
    const toScreen = (w: [number, number]): [number, number] => [w[0] * 1e7, w[1] * 1e7];
    // click close to the second leg
    const midLeg2 = pointAtDistance(paths[1]!, paths[1]!.length / 2);
    const hit = hitTestRoute(paths, toScreen(midLeg2), toScreen)!;
    expect(hit.leg).toBe(1);
    expect(hit.insertAt).toBe(0);
    // click close to the end of leg 0 (after both waypoints)
    const nearEnd = pointAtDistance(paths[0]!, paths[0]!.length * 0.95);
    const hit0 = hitTestRoute(paths, toScreen(nearEnd), toScreen)!;
    expect(hit0.leg).toBe(0);
    expect(hit0.insertAt).toBe(2);
    insertWaypoint(p, hit0, [24.95, 60.3]);
    expect(p.legs[0]!.waypoints[2]).toEqual([24.95, 60.3]);
  });
});

function ctxFor(project = demoProject()) {
  const paths = buildPaths(project);
  const tl = buildTimeline(project);
  const frameCtx: FrameContext = { project, paths, tl };
  const camCtx: CameraContext = { project, tl, overview: { center: [0.5, 0.3], zoom: 6 } };
  return { project, paths, tl, frameCtx, camCtx };
}

describe('timeline', () => {
  it('lays out intro, pauses, equal legs and outro', () => {
    const { project, tl } = ctxFor();
    const c = project.settings.camera;
    const expected = c.introSec + 3 * project.settings.defaultPauseSec + 2 * project.settings.legDurationSec + c.outroSec + c.outroHoldSec;
    near(tl.total, expected);
    expect(tl.legEnd[0]! - tl.legStart[0]!).toBeCloseTo(project.settings.legDurationSec);
    expect(tl.legEnd[1]! - tl.legStart[1]!).toBeCloseTo(project.settings.legDurationSec);
  });
  it('honours per-leg and per-stop overrides, and zero pause', () => {
    const p = demoProject();
    p.legs[1]!.durationSec = 10;
    p.stops[1]!.pauseSec = 0;
    const tl = buildTimeline(p);
    expect(tl.legEnd[1]! - tl.legStart[1]!).toBeCloseTo(10);
    expect(tl.pause[1]).toBe(0);
    expect(tl.legStart[1]!).toBeCloseTo(tl.legEnd[0]!); // no pause between
    const f = computeFrame({ project: p, paths: buildPaths(p), tl }, tl.legEnd[0]! - 0.01);
    expect(f.activeStop).toBe(-1);
  });
  it('boat starts at the first stop, ends at the last, and visits in order', () => {
    const { project, frameCtx, tl } = ctxFor();
    const f0 = computeFrame(frameCtx, 0);
    const a = toWorld(project.stops[0]!.lngLat);
    near(f0.boat!.pt[0], a[0], 1e-12);
    expect(f0.visited).toBe(0);
    const f1 = computeFrame(frameCtx, tl.arrival[0]! + 0.1);
    expect(f1.visited).toBe(1);
    expect(f1.activeStop).toBe(0);
    const fEnd = computeFrame(frameCtx, tl.total);
    const c = toWorld(project.stops[2]!.lngLat);
    near(fEnd.boat!.pt[0], c[0], 1e-9);
    expect(fEnd.visited).toBe(3);
    expect(fEnd.doneLegs).toBe(2);
    expect(fEnd.activeStop).toBe(-1);
  });
  it('boat motion is continuous in time', () => {
    const { frameCtx, tl } = ctxFor();
    let prev = computeFrame(frameCtx, 0).boat!.pt;
    for (let t = 0.01; t <= tl.total; t += 0.01) {
      const cur = computeFrame(frameCtx, t).boat!.pt;
      expect(Math.hypot(cur[0] - prev[0], cur[1] - prev[1])).toBeLessThan(2e-4);
      prev = cur;
    }
  });
  it('handles empty and single-stop projects', () => {
    const empty = emptyProject();
    const f = computeFrame({ project: empty, paths: [], tl: buildTimeline(empty) }, 0);
    expect(f.boat).toBeNull();
    const one = emptyProject();
    addStop(one, [10, 10]);
    const c = ctxFor(one);
    expect(c.tl.total).toBeGreaterThan(0);
    expect(computeFrame(c.frameCtx, c.tl.total / 2).boat).not.toBeNull();
    expect(cameraAt(c.camCtx, computeFrame(c.frameCtx, c.tl.total / 2)).zoom).toBeGreaterThan(0);
  });
});

describe('camera', () => {
  it('has no jumps anywhere on the timeline (follow and overview modes)', () => {
    for (const follow of [true, false]) {
      const p = demoProject();
      p.settings.camera.follow = follow;
      const { frameCtx, camCtx, tl } = ctxFor(p);
      let prev = cameraAt(camCtx, computeFrame(frameCtx, 0));
      for (let t = 0.005; t <= tl.total + 1; t += 0.005) {
        const cur = cameraAt(camCtx, computeFrame(frameCtx, t));
        expect(Math.abs(cur.zoom - prev.zoom), `zoom @${t} follow=${follow}`).toBeLessThan(0.05);
        expect(Math.hypot(cur.center[0] - prev.center[0], cur.center[1] - prev.center[1]), `center @${t}`).toBeLessThan(5e-4);
        prev = cur;
      }
    }
  });
  it('rests on the stop camera during pauses and on the overview at the end', () => {
    const { project, frameCtx, camCtx, tl } = ctxFor();
    const mid = tl.arrival[1]! + tl.pause[1]! / 2;
    const c = cameraAt(camCtx, computeFrame(frameCtx, mid));
    const s = stopCamera(project, 1);
    near(c.zoom, s.zoom);
    near(c.center[0], s.center[0], 1e-12);
    const end = cameraAt(camCtx, computeFrame(frameCtx, tl.total));
    near(end.zoom, camCtx.overview.zoom);
  });
  it('uses per-stop zoom override', () => {
    const p = demoProject();
    p.stops[1]!.zoom = 14;
    expect(stopCamera(p, 1).zoom).toBe(14);
  });
  it('starts on the first stop when the intro is off', () => {
    const p = demoProject();
    p.settings.camera.intro = false;
    const { frameCtx, camCtx } = ctxFor(p);
    near(cameraAt(camCtx, computeFrame(frameCtx, 0)).zoom, stopCamera(p, 0).zoom);
  });
});

describe('boat easing', () => {
  it('cruise profile is monotonic, hits 0 and 1, and is slow at both ends but steady in the middle', () => {
    expect(ease('ease', 0)).toBe(0);
    expect(ease('ease', 1)).toBeCloseTo(1, 12);
    let prev = 0;
    for (let u = 0.01; u <= 1; u += 0.01) {
      const d = ease('ease', u);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    const speed = (u: number) => (ease('ease', u + 0.001) - ease('ease', u)) / 0.001;
    expect(speed(0.01)).toBeLessThan(speed(0.5) * 0.2);
    expect(speed(0.99 - 0.001)).toBeLessThan(speed(0.5) * 0.2);
    expect(speed(0.4)).toBeCloseTo(speed(0.6), 6);
    expect(ease('linear', 0.3)).toBe(0.3);
  });
});
