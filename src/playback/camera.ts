import { clamp, lerp, lerpPt, toWorld, type Pt } from '../geo/mercator';
import type { Project } from '../types';
import type { Frame, Timeline } from './timeline';

/**
 * Camera state in "design zoom": the zoom you would use on a stage whose
 * shorter side is 1080 px. The app adds log2(stageSize / 1080) when applying
 * it, so framing is identical whatever the window size.
 */
export interface CameraState {
  center: Pt;
  zoom: number;
}

export interface CameraContext {
  project: Project;
  tl: Timeline;
  overview: CameraState;
}

/** Fraction of a leg spent zooming out of / into a stop. */
const ZOOM_FRAC = 0.3;

const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const smoother = (x: number): number => {
  const t = clamp(x, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
/**
 * Blends two cameras. Zoom is eased in log space, but the centre must move
 * by the fraction of the way the *view* has travelled: on screen a world
 * offset is scaled by 2^zoom, so a plain lerp of the centre barely moves
 * while zoomed out and then lurches at the end of a zoom-in. Interpolating in
 * inverse scale keeps the pan and the zoom in step.
 */
const blend = (a: CameraState, b: CameraState, w: number): CameraState => {
  const zoom = lerp(a.zoom, b.zoom, w);
  const inv = (z: number) => 2 ** -z;
  const span = inv(b.zoom) - inv(a.zoom);
  const k = Math.abs(a.zoom - b.zoom) < 1e-6 ? w : clamp((inv(zoom) - inv(a.zoom)) / span, 0, 1);
  return { center: lerpPt(a.center, b.center, k), zoom };
};

export function stopCamera(project: Project, i: number): CameraState {
  const stop = project.stops[i]!;
  return { center: toWorld(stop.lngLat), zoom: stop.zoom ?? project.settings.camera.stopZoom };
}

/** Where the intro starts: the saved start view, else the whole-route overview. */
function introOrigin(project: Project, overview: CameraState): CameraState {
  const v = project.settings.camera.startView;
  return v ? { center: toWorld(v.center), zoom: v.zoom } : overview;
}

export function cameraAt(ctx: CameraContext, frame: Frame): CameraState {
  const { project, tl, overview } = ctx;
  const n = project.stops.length;
  const cam = project.settings.camera;
  if (n === 0) return overview;

  const { seg, u } = frame;
  if (!seg) {
    if (frame.t >= tl.total && tl.total > 0) return cam.outro ? overview : stopCamera(project, n - 1);
    return cam.intro ? introOrigin(project, overview) : stopCamera(project, 0);
  }

  switch (seg.kind) {
    case 'intro':
      return blend(introOrigin(project, overview), stopCamera(project, 0), smoother(u));
    case 'pause':
      return stopCamera(project, seg.index);
    case 'outro': {
      const moving = cam.outroSec + cam.outroHoldSec;
      const k = moving > 0 ? (u * moving) / Math.max(cam.outroSec, 1e-6) : 1;
      return blend(stopCamera(project, n - 1), overview, smoother(k));
    }
    case 'leg': {
      const base = stopCamera(project, u < 0.5 ? seg.index : seg.index + 1);
      const target: CameraState =
        cam.follow && frame.boat
          ? { center: frame.boat.pt, zoom: project.legs[seg.index]?.travelZoom ?? cam.travelZoom }
          : overview;
      const w = smooth(0, ZOOM_FRAC, u) * (1 - smooth(1 - ZOOM_FRAC, 1, u));
      return blend(base, target, w);
    }
  }
}
