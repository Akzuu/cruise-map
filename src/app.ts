import * as maplibregl from 'maplibre-gl';
import { AttributionControl, type Map as MapLibreMap, type Marker } from 'maplibre-gl';
// Vite pre-bundles maplibre-gl, which breaks the worker URL it derives from its own location.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { formatCoordinates } from './geo/coords';
import { clamp, fromWorld, toWorld, type Pt } from './geo/mercator';
import { applyTrailPaint, EMPTY, installLayers, line, multiLine, setEditing, setSourceData, type LayerData } from './map/layers';
import { boatIconMarkup } from './map/icons';
import { customUrlHasKey, resolveStyle, STYLES } from './map/styles';
import { cameraAt, type CameraContext, type CameraState } from './playback/camera';
import { buildTimeline, computeFrame, type Frame, type Timeline } from './playback/timeline';
import { autosave, loadMapTilerKey, saveMapTilerKey } from './project/storage';
import { addStop, buildPaths, hitTestRoute, insertWaypoint, legColor, moveStop, removeStop } from './route/model';
import { sliceTo, type LegPath } from './route/path';
import { emptyProject, type LngLat, type Project, type Settings } from './types';
import { h } from './ui/dom';

export type Mode = 'edit' | 'preview';
export type Tool = 'stop' | 'bend';

interface Events {
  structure: void;
  settings: void;
  geometry: void;
  selection: void;
  mode: void;
  tool: void;
  leg: void;
  time: void;
  play: void;
  load: void;
  clean: void;
  zoom: number;
  /** Preload progress 0..1, or -1 when finished or cancelled. */
  preload: number;
  toast: string;
}

interface StopView {
  marker: Marker;
  el: HTMLElement;
  label: HTMLElement;
  cardName: HTMLElement;
  cardCoords: HTMLElement;
}

maplibregl.setWorkerUrl(workerUrl);

const DESIGN_SIZE = 1080;

export class App {
  project: Project = emptyProject();
  mode: Mode = 'edit';
  tool: Tool = 'stop';
  selectedStopId: string | null = null;
  /** Leg that Bend route edits; keeps overlapping legs unambiguous. */
  activeLeg: number | null = null;
  clean = false;
  mapTilerKey: string | null = loadMapTilerKey();
  styleFellBack = false;

  paths: LegPath[] = [];
  tl: Timeline = buildTimeline(this.project);
  t = 0;
  playing = false;
  speed = 1;
  /** Stage size relative to a 1080 px design size; scales labels, boat and trail width. */
  scale = 1;

  readonly map: MapLibreMap;
  private stopViews = new Map<string, StopView>();
  private waypointMarkers: Marker[] = [];
  private preloadedSig = '';
  private preloadCancel: (() => void) | null = null;
  /** Bumped whenever a pending play-after-preload must not start. */
  private playToken = 0;
  private boatKey = '';
  private layoutKey = '';
  private saveWarned = false;
  private lastClick: { t: number; x: number; y: number } | null = null;
  private boatMarker: Marker;
  private boatRot: HTMLElement;
  private data: LayerData = { preview: EMPTY, done: EMPTY, live: EMPTY, active: EMPTY };
  private styleReady = false;
  private styleSig = '';
  private overview: CameraState | null = null;
  private lastDone = -1;
  private liveShown = false;
  private raf = 0;
  private lastTick = 0;
  private saveTimer = 0;
  private listeners = new Map<keyof Events, Set<(p: never) => void>>();

  constructor(
    private stage: HTMLElement,
    private area: HTMLElement,
    mapEl: HTMLElement,
  ) {
    const { def } = resolveStyle(this.project.settings.style, this.mapTilerKey, this.project.settings.customMap);
    this.styleSig = this.sigFor(def.id);
    this.map = new maplibregl.Map({
      container: mapEl,
      style: def.build(this.mapTilerKey, this.project.settings.customMap),
      center: [24.9, 60.1],
      zoom: 5,
      attributionControl: false,
      fadeDuration: 0,
      pitchWithRotate: false,
      maxPitch: 0,
      dragRotate: false,
      maxZoom: 20,
      // Keep far more tiles than the default so zoomed-out views survive the zoom-in.
      maxTileCacheSize: 1024,
    });
    this.map.addControl(new AttributionControl({ compact: false }), 'bottom-right');
    this.map.touchZoomRotate.disableRotation();

    this.boatRot = h('div', { class: 'boat-rot' });
    this.boatMarker = new maplibregl.Marker({
      element: h('div', { class: 'boat' }, this.boatRot),
      anchor: 'center',
    });

    // Surface map errors (bad style, rejected key, shader failures) instead of a silent blank map.
    let lastMapError = '';
    this.map.on('error', (e) => {
      const msg = e.error?.message || 'Unknown map error';
      console.error('[map]', e.error ?? e);
      if (msg !== lastMapError) {
        lastMapError = msg;
        this.toast(`Map error: ${msg.slice(0, 140)}`);
      }
    });

    this.map.on('style.load', () => {
      this.styleReady = true;
      installLayers(this.map, this.project.settings, this.data, this.scale, this.mode === 'edit');
    });
    this.map.on('click', (e) => this.onMapClick(e.lngLat.wrap()));
    this.map.on('zoom', () => {
      if (this.mode === 'edit') this.emit('zoom', this.designZoom());
    });

    new ResizeObserver(() => this.layoutStage()).observe(area);
    this.layoutStage();
    this.commit('structure');
  }

  // ───────────────────────── events ─────────────────────────

  on<K extends keyof Events>(type: K, cb: (p: Events[K]) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb as (p: never) => void);
  }
  private emit<K extends keyof Events>(type: K, ...p: Events[K] extends void ? [] : [Events[K]]): void {
    this.listeners.get(type)?.forEach((cb) => (cb as (x: unknown) => void)(p[0]));
  }
  toast(msg: string): void {
    this.emit('toast', msg);
  }

  // ───────────────────────── project ─────────────────────────

  get settings(): Settings {
    return this.project.settings;
  }

  loadProject(p: Project): void {
    this.pause();
    this.project = p;
    this.selectedStopId = null;
    this.activeLeg = null;
    this.t = 0;
    this.setMode('edit');
    this.commit('structure');
    this.fitToRoute(false);
    this.emit('load');
  }

  /** Tell the UI to re-read project values (used after startup restore). */
  emitLoad(): void {
    this.emit('load');
  }

  newProject(): void {
    this.loadProject(emptyProject());
  }

  setMapTilerKey(key: string | null): void {
    this.mapTilerKey = key && key.trim() ? key.trim() : null;
    saveMapTilerKey(this.mapTilerKey);
    this.commit('settings');
  }

  /**
   * Re-derives everything that depends on the project and redraws.
   *  structure: stops/legs/waypoints added, removed or reordered
   *  settings:  any setting changed
   *  geometry:  a point is being dragged (cheap path, no marker rebuild)
   */
  commit(kind: 'structure' | 'settings' | 'geometry'): void {
    // Settings never change the route's shape, so skip rebuilding its paths.
    if (kind !== 'settings') {
      this.paths = buildPaths(this.project);
      this.data.preview = multiLine(this.paths.map((p) => p.lngLat));
      if (this.styleReady) setSourceData(this.map, 'route-preview', this.data.preview);
    }
    this.tl = buildTimeline(this.project);
    this.overview = null;
    if (this.activeLeg !== null && this.activeLeg >= this.paths.length) this.activeLeg = this.paths.length > 0 ? this.paths.length - 1 : null;
    this.updateActiveLeg();
    this.lastDone = -1;
    this.liveShown = false;

    if (kind === 'structure') {
      this.applyVisuals();
      this.syncStopViews();
      this.syncWaypoints();
    } else if (kind === 'settings') {
      this.applyVisuals();
      this.refreshStopText();
    } else {
      this.refreshStopText();
    }
    this.t = clamp(this.t, 0, this.tl.total);
    this.renderCurrent();
    this.scheduleSave();
    this.emit(kind);
  }

  /** Call after renaming a stop: refreshes labels and cards without rebuilding anything. */
  labelsChanged(): void {
    this.refreshStopText();
    this.scheduleSave();
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (autosave(this.project)) {
        this.saveWarned = false;
      } else if (!this.saveWarned) {
        this.saveWarned = true;
        this.toast('Could not autosave in this browser. Use Save to keep your work.');
      }
    }, 400);
  }

  // ───────────────────────── visuals ─────────────────────────

  private sigFor(styleId: string): string {
    // The key only matters to styles that use it; changing it must not reload the others.
    const custom = this.project.settings.customMap;
    const usesKey = styleId === 'custom' ? customUrlHasKey(custom) : STYLES.find((d) => d.id === styleId)?.needsKey;
    const key = usesKey ? (this.mapTilerKey ?? '') : '';
    const map = styleId === 'custom' ? `${custom.kind}|${custom.url}|${custom.attribution}` : '';
    return `${styleId}|${key}|${map}|${this.project.settings.seaMarks}`;
  }

  private applyVisuals(): void {
    const s = this.settings;

    const { def, fellBack } = resolveStyle(s.style, this.mapTilerKey, s.customMap);
    this.styleFellBack = fellBack;
    const sig = this.sigFor(def.id);
    if (sig !== this.styleSig) {
      this.styleSig = sig;
      this.styleReady = false;
      this.map.setStyle(def.build(this.mapTilerKey, s.customMap), { diff: false });
    }

    this.layoutStage();
    this.stage.classList.toggle('no-attrib', !s.showAttribution);
    this.stage.classList.toggle('theme-dark', s.labels.theme === 'dark');
    this.stage.style.setProperty('--trail', s.trail.color);
    this.stage.style.setProperty('--label-size', `${s.labels.size}px`);
    this.stage.style.setProperty('--boat-size', `${s.boat.size}px`);
    const boatKey = `${s.boat.icon}|${s.boat.customImage ?? ''}`;
    if (boatKey !== this.boatKey) {
      this.boatKey = boatKey;
      this.boatRot.innerHTML = boatIconMarkup(s.boat.icon, s.boat.customImage);
    }
    (this.boatRot.parentElement as HTMLElement).style.color = s.boat.color;
    if (this.styleReady) applyTrailPaint(this.map, s, this.scale);
  }

  /** Sizes the stage to the chosen aspect ratio and recomputes the size-dependent scale. */
  layoutStage(): void {
    const lock = this.settings.aspectLock;
    let w = this.area.clientWidth;
    let hgt = this.area.clientHeight;
    if (w === 0 || hgt === 0) return;
    if (lock !== 'free') {
      const [a, b] = lock.split(':').map(Number) as [number, number];
      const ratio = a / b;
      if (w / hgt > ratio) w = hgt * ratio;
      else hgt = w / ratio;
    }
    this.stage.style.width = lock === 'free' ? '100%' : `${Math.floor(w)}px`;
    this.stage.style.height = lock === 'free' ? '100%' : `${Math.floor(hgt)}px`;
    this.stage.classList.toggle('is-letterboxed', lock !== 'free');

    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const layoutKey = `${sw}x${sh}`;
    if (layoutKey === this.layoutKey) return; // nothing to resize or rescale
    this.layoutKey = layoutKey;
    this.map.resize();
    this.scale = Math.max(0.15, Math.min(sw, sh) / DESIGN_SIZE);
    this.stage.style.setProperty('--u', String(this.scale));
    if (this.styleReady) applyTrailPaint(this.map, this.settings, this.scale);
    this.overview = null;
    if (this.mode === 'preview') this.renderAt(this.t);
  }

  // ───────────────────────── markers ─────────────────────────

  private syncStopViews(): void {
    const ids = new Set(this.project.stops.map((s) => s.id));
    for (const [id, v] of this.stopViews) {
      if (!ids.has(id)) {
        v.marker.remove();
        this.stopViews.delete(id);
      }
    }
    for (const stop of this.project.stops) {
      if (!this.stopViews.has(stop.id)) this.stopViews.set(stop.id, this.createStopView(stop.id));
    }
    this.refreshStopText();
    this.updateBoat(this.frameAt(this.mode === 'preview' ? this.t : 0).boat);
  }

  private createStopView(id: string): StopView {
    const label = h('div', { class: 'stop-label' });
    const cardName = h('div', { class: 'stop-card-name' });
    const cardCoords = h('div', { class: 'stop-card-coords' });
    const el = h('div', { class: 'stop' }, h('div', { class: 'stop-dot' }), label, h('div', { class: 'stop-card' }, cardName, cardCoords));
    const stop = this.project.stops.find((s) => s.id === id)!;
    const marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: this.mode === 'edit' })
      .setLngLat(stop.lngLat)
      .addTo(this.map);

    marker.on('drag', () => {
      const ll = marker.getLngLat().wrap();
      const s = this.project.stops.find((x) => x.id === id);
      if (!s) return;
      s.lngLat = [ll.lng, ll.lat];
      this.commit('geometry');
    });
    marker.on('dragend', () => this.scheduleSave());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.mode === 'edit') this.select(id);
    });
    return { marker, el, label, cardName, cardCoords };
  }

  private refreshStopText(): void {
    const fmt = this.settings.coordFormat;
    this.project.stops.forEach((stop, i) => {
      const v = this.stopViews.get(stop.id);
      if (!v) return;
      const name = stop.name.trim() || `Stop ${i + 1}`;
      v.label.textContent = name;
      v.cardName.textContent = name;
      v.cardCoords.textContent = formatCoordinates(stop.lngLat, fmt);
      v.marker.setLngLat(stop.lngLat);
    });
  }

  private syncWaypoints(): void {
    this.waypointMarkers.forEach((m) => m.remove());
    this.waypointMarkers = [];
    if (this.mode !== 'edit') return;
    const { stops } = this.project;
    this.project.legs.forEach((leg, li) => {
      const from = stops[li]?.name || `Stop ${li + 1}`;
      const to = stops[li + 1]?.name || `Stop ${li + 2}`;
      leg.waypoints.forEach((wp, wi) => {
        const el = h('div', {
          class: 'wp',
          style: `--leg: ${legColor(li)}`,
          'data-leg': String(li),
          title: `Leg ${li + 1}: ${from} to ${to}. Drag to bend the route. Double-click to remove.`,
        });
        el.classList.toggle('is-active', li === this.activeLeg);
        const marker = new maplibregl.Marker({ element: el, anchor: 'center', draggable: true }).setLngLat(wp).addTo(this.map);
        marker.on('drag', () => {
          const ll = marker.getLngLat().wrap();
          leg.waypoints[wi] = [ll.lng, ll.lat];
          this.commit('geometry');
        });
        marker.on('dragend', () => this.scheduleSave());
        const remove = (e: Event) => {
          e.stopPropagation();
          e.preventDefault();
          leg.waypoints.splice(wi, 1);
          this.commit('structure');
        };
        el.addEventListener('dblclick', remove);
        el.addEventListener('click', (e) => e.stopPropagation());
        this.waypointMarkers.push(marker);
      });
    });
  }

  private updateBoat(boat: Frame['boat']): void {
    if (!boat || this.project.stops.length === 0) {
      this.boatMarker.remove();
      return;
    }
    // The position must be set before addTo(): a map move with an unpositioned marker throws.
    this.boatMarker.setLngLat(fromWorld(boat.pt));
    if (!this.boatMarker.getElement().isConnected) this.boatMarker.addTo(this.map);
    const b = this.settings.boat;
    this.boatRot.style.transform = b.rotate ? `rotate(${boat.heading + b.rotationOffset}deg)` : 'none';
  }

  private applyStopStates(frame: Frame | null): void {
    const { labels } = this.settings;
    this.project.stops.forEach((stop, i) => {
      const v = this.stopViews.get(stop.id);
      if (!v) return;
      const editing = this.mode === 'edit' || !frame;
      const visited = !!frame && i < frame.visited;
      const shown = editing || visited || labels.showUpcoming;
      const labelShown = editing || (visited ? labels.showVisited : labels.showUpcoming);
      v.el.classList.toggle('is-editing', editing);
      v.el.classList.toggle('is-visible', shown);
      v.el.classList.toggle('has-label', labelShown);
      v.el.classList.toggle('is-active', !editing && frame!.activeStop === i && stop.popup);
      v.el.classList.toggle('is-selected', editing && stop.id === this.selectedStopId);
    });
  }

  // ───────────────────────── rendering ─────────────────────────

  private frameAt(t: number): Frame {
    return computeFrame({ project: this.project, paths: this.paths, tl: this.tl }, t);
  }

  renderCurrent(): void {
    if (this.mode === 'preview') this.renderAt(this.t);
    else this.renderEdit();
  }

  private renderEdit(): void {
    const frame = this.frameAt(0);
    this.updateBoat(frame.boat);
    this.applyStopStates(null);
  }

  renderAt(t: number): void {
    this.t = clamp(t, 0, this.tl.total);
    const frame = this.frameAt(this.t);
    if (this.project.stops.length > 0) this.applyCamera(cameraAt(this.cameraContext(), frame));
    this.updateBoat(frame.boat);
    this.applyStopStates(frame);
    this.updateTrail(frame);
    this.emit('time');
    if (this.styleReady) this.map.redraw();
  }

  private updateTrail(frame: Frame): void {
    if (!this.styleReady) return;
    if (frame.doneLegs !== this.lastDone) {
      this.lastDone = frame.doneLegs;
      this.data.done = multiLine(this.paths.slice(0, frame.doneLegs).map((p) => p.lngLat));
      setSourceData(this.map, 'trail-done', this.data.done);
    }
    if (frame.live) {
      const path = this.paths[frame.live.leg]!;
      this.data.live = line(sliceTo(path, frame.live.dist));
      setSourceData(this.map, 'trail-live', this.data.live);
      this.liveShown = true;
    } else if (this.liveShown) {
      this.data.live = EMPTY;
      setSourceData(this.map, 'trail-live', EMPTY);
      this.liveShown = false;
    }
  }

  private applyCamera(cam: CameraState): void {
    const zoom = clamp(cam.zoom + Math.log2(this.scale), 0, 22);
    this.map.jumpTo({ center: fromWorld(cam.center), zoom, bearing: 0, pitch: 0 });
  }

  private cameraContext(): CameraContext {
    return { project: this.project, tl: this.tl, overview: this.getOverview() };
  }

  private routeBounds(): [LngLat, LngLat] | null {
    if (this.project.stops.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const add = ([x, y]: Pt) => {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };
    this.project.stops.forEach((s) => add(toWorld(s.lngLat)));
    this.paths.forEach((p) => p.pts.forEach((pt, i) => i % 6 === 0 && add(pt)));
    return [fromWorld([minX, maxY]), fromWorld([maxX, minY])];
  }

  /** Whole-route framing in design zoom, for the intro, outro and non-follow camera. */
  private getOverview(): CameraState {
    if (this.overview) return this.overview;
    const b = this.routeBounds();
    const cam = this.settings.camera;
    let result: CameraState = { center: [0.5, 0.4], zoom: 2 };
    if (b) {
      const [sw, ne] = b;
      const spanX = Math.abs(toWorld(ne)[0] - toWorld(sw)[0]);
      const spanY = Math.abs(toWorld(ne)[1] - toWorld(sw)[1]);
      if (spanX < 1e-6 && spanY < 1e-6) {
        result = { center: toWorld(sw), zoom: cam.travelZoom };
      } else {
        const pad = Math.round(0.12 * Math.min(this.stage.clientWidth, this.stage.clientHeight));
        const fit = this.map.cameraForBounds([sw, ne], { padding: { top: pad, bottom: pad, left: pad, right: pad } });
        if (fit && fit.center !== undefined && fit.zoom !== undefined) {
          const c = maplibregl.LngLat.convert(fit.center);
          result = { center: toWorld([c.lng, c.lat]), zoom: fit.zoom - Math.log2(this.scale) };
        }
      }
    }
    this.overview = result;
    return result;
  }

  // ───────────────────────── editing ─────────────────────────

  private onMapClick(ll: maplibregl.LngLat): void {
    if (this.mode !== 'edit') return;
    // The second click of a double-click must not place another point.
    const now = performance.now();
    const px = this.map.project(ll);
    const last = this.lastClick;
    this.lastClick = { t: now, x: px.x, y: px.y };
    if (last && now - last.t < 350 && Math.hypot(px.x - last.x, px.y - last.y) < 8) return;
    const point: LngLat = [ll.lng, ll.lat];
    if (this.tool === 'stop') {
      const stop = addStop(this.project, point);
      this.selectedStopId = stop.id;
      this.commit('structure');
      this.emit('selection');
      return;
    }
    if (this.paths.length === 0) {
      this.toast('Add at least two stops before bending the route.');
      return;
    }
    const click = this.map.project(ll);
    const leg = this.activeLeg ?? this.defaultLeg();
    if (this.activeLeg === null) this.setActiveLeg(leg);
    const hit = hitTestRoute(
      this.paths,
      [click.x, click.y],
      (p) => {
        const s = this.map.project(fromWorld(p));
        return [s.x, s.y];
      },
      leg,
    );
    if (!hit) return;
    insertWaypoint(this.project, hit, point);
    this.commit('structure');
  }

  addStopAt(lngLat: LngLat, name?: string): void {
    const stop = addStop(this.project, lngLat, name);
    this.selectedStopId = stop.id;
    this.commit('structure');
    this.emit('selection');
    if (this.mode === 'edit') this.map.easeTo({ center: lngLat, duration: 600 });
  }

  deleteStop(id: string): void {
    removeStop(this.project, id);
    if (this.selectedStopId === id) this.selectedStopId = null;
    this.commit('structure');
    this.emit('selection');
  }

  shiftStop(id: string, delta: -1 | 1): void {
    moveStop(this.project, id, delta);
    this.commit('structure');
  }

  select(id: string | null, fly = false): void {
    this.selectedStopId = id;
    this.applyStopStates(this.mode === 'preview' ? this.frameAt(this.t) : null);
    if (fly && id && this.mode === 'edit') {
      const s = this.project.stops.find((x) => x.id === id);
      if (s) this.map.easeTo({ center: s.lngLat, duration: 500 });
    }
    this.emit('selection');
  }

  /** The leg leaving the selected stop, else the first leg. */
  private defaultLeg(): number {
    const i = this.project.stops.findIndex((s) => s.id === this.selectedStopId);
    return i >= 0 && i < this.paths.length ? i : 0;
  }

  setActiveLeg(leg: number | null): void {
    this.activeLeg = leg !== null && leg >= 0 && leg < this.paths.length ? leg : null;
    this.updateActiveLeg();
    this.emit('leg');
  }

  private updateActiveLeg(): void {
    this.waypointMarkers.forEach((m) => m.getElement().classList.toggle('is-active', Number(m.getElement().dataset.leg) === this.activeLeg));
    const path = this.activeLeg === null ? undefined : this.paths[this.activeLeg];
    this.data.active = path ? line(path.lngLat) : EMPTY;
    if (this.styleReady) setSourceData(this.map, 'route-active', this.data.active);
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    if (tool === 'bend' && this.activeLeg === null && this.paths.length > 0) this.setActiveLeg(this.defaultLeg());
    this.map.getCanvas().style.cursor = '';
    this.emit('tool');
  }

  fitToRoute(animate = true): void {
    const b = this.routeBounds();
    if (!b) return;
    const [sw, ne] = b;
    if (Math.abs(sw[0] - ne[0]) < 1e-6 && Math.abs(sw[1] - ne[1]) < 1e-6) {
      this.map.jumpTo({ center: sw, zoom: 10 });
      return;
    }
    const pad = Math.round(0.12 * Math.min(this.stage.clientWidth, this.stage.clientHeight));
    this.map.fitBounds([sw, ne], { padding: pad, animate, duration: 600, maxZoom: 15 });
  }

  /** Current edit-view zoom in design units, so it can be saved as a stop or default zoom. */
  /** Map centre and zoom as you see them now, in design zoom. */
  currentView(): { center: LngLat; zoom: number } {
    const c = this.map.getCenter();
    return { center: [c.lng, c.lat], zoom: Math.round(this.designZoom() * 10) / 10 };
  }

  designZoom(): number {
    return this.map.getZoom() - Math.log2(this.scale);
  }

  // ───────────────────────── mode & playback ─────────────────────────

  private setInteractive(on: boolean): void {
    const m = this.map;
    // Double-click zoom stays off: a double-click on the map would also place points.
    const handlers = [m.dragPan, m.scrollZoom, m.boxZoom, m.keyboard, m.touchZoomRotate];
    for (const hd of handlers) (on ? hd.enable() : hd.disable());
    m.doubleClickZoom.disable();
    if (on) m.touchZoomRotate.disableRotation();
  }

  setMode(mode: Mode): void {
    if (mode === this.mode) return;
    if (mode === 'edit') this.pause();
    this.mode = mode;
    this.stage.classList.toggle('mode-preview', mode === 'preview');
    this.setInteractive(mode === 'edit');
    for (const v of this.stopViews.values()) v.marker.setDraggable(mode === 'edit');
    if (this.styleReady) setEditing(this.map, mode === 'edit');
    this.lastDone = -1;
    this.liveShown = false;
    this.syncWaypoints();
    if (mode === 'edit') this.emit('zoom', this.designZoom());
    this.renderCurrent();
    this.emit('mode');
  }

  setClean(on: boolean): void {
    if (on === this.clean) return;
    this.clean = on;
    if (!on) this.abortPendingPlay();
    document.body.classList.toggle('clean', on);
    this.emit('clean');
    // Layout changes size; let the browser apply it, then refit.
    requestAnimationFrame(() => this.layoutStage());
  }

  /** Everything that decides which tiles the animation needs. */
  private preloadSignature(): string {
    const { stops, legs, settings } = this.project;
    return JSON.stringify([
      stops.map((s) => [s.lngLat, s.zoom, s.pauseSec]),
      legs.map((l) => [l.waypoints, l.durationSec, l.travelZoom]),
      settings.camera,
      settings.legDurationSec,
      this.sigFor(settings.style),
      this.stage.clientWidth,
      this.stage.clientHeight,
    ]);
  }

  get preloading(): boolean {
    return this.preloadCancel !== null;
  }

  cancelPreload(): void {
    this.preloadCancel?.();
  }

  /**
   * The camera views worth loading tiles for: walks the animation finely, but
   * keeps a view only once it has moved about half a screen or changed zoom by
   * half a level since the last kept one. Pauses and slow stretches cost nothing.
   */
  private preloadViews(): CameraState[] {
    const out: CameraState[] = [];
    const total = this.tl.total;
    const width = Math.max(1, this.stage.clientWidth);
    const ctx = this.cameraContext();
    let last: CameraState | null = null;
    for (let t = 0; t <= total + 1e-6; t += 0.05) {
      const cam = cameraAt(ctx, this.frameAt(Math.min(t, total)));
      if (last) {
        const screenWorld = width / (512 * 2 ** (cam.zoom + Math.log2(this.scale)));
        const moved = Math.hypot(cam.center[0] - last.center[0], cam.center[1] - last.center[1]);
        if (moved < screenWorld * 0.5 && Math.abs(cam.zoom - last.zoom) < 0.5) continue;
      }
      out.push(cam);
      last = cam;
    }
    const end = cameraAt(ctx, this.frameAt(total));
    if (!last || last.center[0] !== end.center[0] || last.center[1] !== end.center[1] || last.zoom !== end.zoom) out.push(end);
    return out;
  }

  /**
   * Flies the camera through the whole animation without playing it, waiting at
   * each step until the tiles are in, so playback finds them cached.
   */
  private async preload(): Promise<boolean> {
    let cancelled = false;
    this.preloadCancel = () => {
      cancelled = true;
    };
    const sig = this.preloadSignature();
    const samples = this.preloadViews();
    const tilesIn = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          window.clearTimeout(timer);
          this.map.off('idle', done);
          resolve();
        };
        const timer = window.setTimeout(done, 1500);
        this.map.once('idle', done);
      });
    try {
      for (let i = 0; i < samples.length && !cancelled; i++) {
        this.applyCamera(samples[i]!);
        await tilesIn();
        this.emit('preload', (i + 1) / samples.length);
      }
    } finally {
      this.preloadCancel = null;
      this.emit('preload', -1);
      this.renderAt(this.t);
    }
    if (cancelled) return false;
    this.preloadedSig = sig;
    return true;
  }

  play(): void {
    if (this.project.stops.length === 0) {
      this.toast('Add a stop on the map first.');
      return;
    }
    if (this.preloading) return;
    if (this.mode !== 'preview') this.setMode('preview');
    // Only when recording: a preview should start at once.
    if (this.clean && this.settings.camera.preload && this.styleReady && this.preloadedSig !== this.preloadSignature()) {
      // Skipping the preload (Esc) still starts the animation, just without a warm cache.
      const token = ++this.playToken;
      void this.preload().then(() => {
        if (token === this.playToken) this.begin();
      });
      return;
    }
    this.begin();
  }

  private begin(): void {
    if (this.t >= this.tl.total) this.t = 0;
    this.playing = true;
    this.lastTick = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.tick);
    this.emit('play');
  }

  /** Drops a play request that is still waiting on the tile preload. */
  private abortPendingPlay(): void {
    this.playToken++;
    this.cancelPreload();
  }

  pause(): void {
    this.abortPendingPlay();
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit('play');
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    if (this.mode !== 'preview') this.setMode('preview');
    this.renderAt(t);
  }

  restart(): void {
    this.seek(0);
  }

  private tick = (now: number): void => {
    if (!this.playing) return;
    const dt = Math.min(0.2, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const next = this.t + dt * this.speed;
    if (next >= this.tl.total) {
      this.playing = false;
      this.renderAt(this.tl.total);
      this.emit('play');
      return;
    }
    this.renderAt(next);
    this.raf = requestAnimationFrame(this.tick);
  };
}
