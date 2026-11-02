// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── A just-enough MapLibre double: records calls, never touches WebGL. ──
const rec = vi.hoisted(() => ({
  jumps: [] as { center: [number, number]; zoom: number }[],
  sourceData: {} as Record<string, unknown[]>,
  handlers: {} as Record<string, ((e: unknown) => void)[]>,
  markers: [] as { el: HTMLElement; lngLat: [number, number] | null; draggable: boolean; removed: boolean }[],
  redraws: 0,
}));

vi.mock('maplibre-gl', () => {
  const noop = () => {};
  const handler = () => ({ enable: noop, disable: noop, disableRotation: noop });
  class Map {
    touchZoomRotate = handler();
    dragPan = handler();
    scrollZoom = handler();
    boxZoom = handler();
    keyboard = handler();
    doubleClickZoom = handler();
    private sources = new globalThis.Map<string, { setData: (d: unknown) => void }>();
    private layers = new Set<string>();
    on(ev: string, cb: (e: unknown) => void) {
      (rec.handlers[ev] ??= []).push(cb);
    }
    once(_ev: string, cb: () => void) {
      cb(); // tiles are "loaded" immediately
    }
    off = noop;
    addControl = noop;
    resize = noop;
    addSource(id: string) {
      rec.sourceData[id] = [];
      this.sources.set(id, { setData: (d) => rec.sourceData[id]!.push(d) });
    }
    getSource(id: string) {
      return this.sources.get(id);
    }
    addLayer(l: { id: string }) {
      this.layers.add(l.id);
    }
    getLayer(id: string) {
      return this.layers.has(id) ? {} : undefined;
    }
    setPaintProperty = noop;
    setLayoutProperty = noop;
    setStyle = noop;
    jumpTo(o: { center: [number, number]; zoom: number }) {
      rec.jumps.push(o);
    }
    redraw() {
      rec.redraws++;
    }
    easeTo = noop;
    fitBounds = noop;
    cameraForBounds() {
      return { center: { lng: 24.8, lat: 60.2 }, zoom: 7 };
    }
    project(ll: { lng: number; lat: number }) {
      return { x: ll.lng * 1000, y: -ll.lat * 1000 };
    }
    getZoom() {
      return 7;
    }
    getCanvas() {
      return { style: {} };
    }
  }
  class Marker {
    private rec: (typeof rec.markers)[number];
    constructor(o: { element: HTMLElement; draggable?: boolean }) {
      this.rec = { el: o.element, lngLat: null, draggable: !!o.draggable, removed: false };
      rec.markers.push(this.rec);
    }
    setLngLat(ll: [number, number]) {
      this.rec.lngLat = ll;
      return this;
    }
    getLngLat() {
      return { lng: this.rec.lngLat![0], lat: this.rec.lngLat![1], wrap() { return this; } };
    }
    addTo() {
      document.body.append(this.rec.el);
      this.rec.removed = false;
      return this;
    }
    remove() {
      this.rec.el.remove();
      this.rec.removed = true;
      return this;
    }
    on() {
      return this;
    }
    setDraggable(d: boolean) {
      this.rec.draggable = d;
      return this;
    }
    getElement() {
      return this.rec.el;
    }
  }
  class AttributionControl {}
  const LngLat = {
    convert: (v: unknown) => (Array.isArray(v) ? { lng: v[0], lat: v[1] } : v),
  };
  return { Map, Marker, AttributionControl, LngLat, setWorkerUrl: noop };
});

import { App } from '../src/app';
import { parseProject, serializeProject } from '../src/project/storage';
import { customProblem, resolveStyle } from '../src/map/styles';
import { Panel } from '../src/ui/panel';
import { Playbar, Toast, Toolbar } from '../src/ui/controls';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function mount(size?: { w: number; h: number }) {
  document.body.innerHTML = `
    <aside id="panel"></aside>
    <main id="area"><div id="stage"><div id="map"></div></div>
    <div id="toolbar"></div><div id="playbar"></div><div id="toast"></div></main>`;
  const $ = (id: string) => document.getElementById(id)!;
  if (size) {
    for (const id of ['area', 'stage']) {
      Object.defineProperty($(id), 'clientWidth', { value: size.w, configurable: true });
      Object.defineProperty($(id), 'clientHeight', { value: size.h, configurable: true });
    }
  }
  const app = new App($('stage'), $('area'), $('map'));
  const panel = new Panel(app, $('panel'));
  const toolbar = new Toolbar(app, $('toolbar'));
  const playbar = new Playbar(app, $('playbar'));
  const toast = new Toast($('toast'), app);
  rec.handlers['style.load']!.at(-1)!({}); // map finished loading its style
  return { app, panel, toolbar, playbar, toast, $ };
}

const click = (app: App, lng: number, lat: number) => {
  for (const cb of rec.handlers['click']!.slice(-1)) cb({ lngLat: { lng, lat, wrap() { return this; } } });
  void app;
};

beforeEach(() => {
  rec.jumps = [];
  rec.sourceData = {};
  rec.handlers = {};
  rec.markers = [];
  rec.redraws = 0;
  localStorage.clear();
});

describe('editing', () => {
  it('adds stops by clicking the map and by coordinates, building rows, legs and markers', () => {
    const { app, $ } = mount();
    click(app, 24.9, 60.1);
    click(app, 25.5, 60.4);
    expect(app.project.stops.map((s) => s.name)).toEqual(['Stop 1', 'Stop 2']);
    expect(app.project.legs.length).toBe(1);

    const input = $('panel').querySelector<HTMLInputElement>('.add-coords input')!;
    input.value = '60°30.0′N 26°00.0′E';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(app.project.stops.length).toBe(3);
    expect(app.project.stops[2]!.lngLat[0]).toBeCloseTo(26, 6);
    expect(app.project.stops[2]!.lngLat[1]).toBeCloseTo(60.5, 6);

    expect($('panel').querySelectorAll('.stop-row').length).toBe(3);
    expect($('panel').querySelectorAll('.leg-row').length).toBe(2);
    expect(document.querySelectorAll('.stop').length).toBe(3);
  });

  it('shows a readable error for bad coordinates and adds nothing', () => {
    const { app, $ } = mount();
    const input = $('panel').querySelector<HTMLInputElement>('.add-coords input')!;
    input.value = '95, 10';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(app.project.stops.length).toBe(0);
    expect($('panel').querySelector('.error')!.textContent).toMatch(/Latitude/);
  });

  it('bend tool inserts a waypoint on the nearest leg and creates a draggable handle', () => {
    const { app } = mount();
    click(app, 24, 60);
    click(app, 26, 60);
    app.setTool('bend');
    click(app, 25, 60.3);
    expect(app.project.legs[0]!.waypoints.length).toBe(1);
    expect(document.querySelectorAll('.wp').length).toBe(1);
    expect(rec.markers.filter((m) => m.el.classList.contains('wp') && !m.removed)[0]!.draggable).toBe(true);
  });

  it('bend tool without a route tells the user instead of failing', () => {
    const { app, $ } = mount();
    app.setTool('bend');
    click(app, 25, 60);
    expect(app.project.legs.length).toBe(0);
    expect($('toast').textContent).toMatch(/two stops/);
  });

  it('reorders and deletes stops and keeps legs consistent', () => {
    const { app, $ } = mount();
    for (const [x, y] of [[24, 60], [25, 60.2], [26, 60.1]]) click(app, x!, y!);
    const first = app.project.stops[0]!.id;
    app.shiftStop(first, 1);
    expect(app.project.stops[1]!.id).toBe(first);
    app.deleteStop(first);
    expect(app.project.stops.length).toBe(2);
    expect(app.project.legs.length).toBe(1);
    expect($('panel').querySelectorAll('.stop-row').length).toBe(2);
    expect(document.querySelectorAll('.stop').length).toBe(2);
  });

  it('settings inputs drive the project and the timeline', () => {
    const { app, $ } = mount();
    click(app, 24, 60);
    click(app, 26, 60);
    const before = app.tl.total;
    const legInput = Array.from($('panel').querySelectorAll<HTMLElement>('.field'))
      .find((f) => f.textContent?.startsWith('Time per leg'))!
      .querySelector('input')!;
    legInput.value = '12';
    legInput.dispatchEvent(new Event('input'));
    expect(app.project.settings.legDurationSec).toBe(12);
    expect(app.tl.total).toBeCloseTo(before + 6);
  });

  it('per-leg override input sets durationSec and clears back to default', () => {
    const { app, $ } = mount();
    click(app, 24, 60);
    click(app, 26, 60);
    const dur = $('panel').querySelector<HTMLInputElement>('.leg-row input')!;
    dur.value = '10';
    dur.dispatchEvent(new Event('input'));
    expect(app.project.legs[0]!.durationSec).toBe(10);
    dur.value = '';
    dur.dispatchEvent(new Event('input'));
    expect(app.project.legs[0]!.durationSec).toBeNull();
  });
});

describe('playback', () => {
  function route() {
    const ctx = mount();
    for (const [x, y] of [[24, 60], [25, 60.4], [26, 60.1]]) click(ctx.app, x!, y!);
    ctx.app.project.stops[0]!.name = 'Start';
    ctx.app.labelsChanged();
    ctx.app.settings.camera.preload = false; // play() starts synchronously
    return ctx;
  }

  it('scrubbing through the whole timeline never throws and produces finite output', () => {
    const { app } = route();
    app.setMode('preview');
    for (let t = 0; t <= app.tl.total; t += 0.05) app.renderAt(t);
    expect(rec.jumps.length).toBeGreaterThan(100);
    for (const j of rec.jumps) {
      expect(Number.isFinite(j.zoom)).toBe(true);
      expect(j.center.every(Number.isFinite)).toBe(true);
      expect(Math.abs(j.center[1])).toBeLessThanOrEqual(85.06);
    }
    expect(rec.redraws).toBeGreaterThan(100);
  });

  it('shows the card only while paused at a stop, and keeps visited stops', () => {
    const { app } = route();
    app.setMode('preview');
    const stops = () => Array.from(document.querySelectorAll('.stop'));
    app.renderAt(0.5);
    expect(stops().every((s) => !s.classList.contains('is-visible'))).toBe(true); // intro: nothing yet
    const t1 = app.tl.arrival[1]! + 0.5;
    app.renderAt(t1);
    expect(stops()[1]!.classList.contains('is-active')).toBe(true);
    expect(stops()[0]!.classList.contains('is-visible')).toBe(true);
    expect(stops()[0]!.classList.contains('is-active')).toBe(false);
    expect(stops()[2]!.classList.contains('is-visible')).toBe(false);
    expect(stops()[1]!.querySelector('.stop-card-name')!.textContent).toBe('Stop 2');
    expect(stops()[1]!.querySelector('.stop-card-coords')!.textContent).toMatch(/°.*′ N.*°.*′ E/);
    app.renderAt(app.tl.total);
    expect(stops().every((s) => s.classList.contains('is-visible') && !s.classList.contains('is-active'))).toBe(true);
  });

  it('grows the trail leg by leg and moves finished legs into the done source', () => {
    const { app } = route();
    app.setMode('preview');
    const mid = (app.tl.legStart[0]! + app.tl.legEnd[0]!) / 2;
    app.renderAt(mid);
    const live = rec.sourceData['trail-live']!.at(-1) as GeoJSON.Feature<GeoJSON.LineString>;
    expect(live.geometry.type).toBe('LineString');
    const n1 = live.geometry.coordinates.length;
    app.renderAt(mid + 1);
    const n2 = (rec.sourceData['trail-live']!.at(-1) as GeoJSON.Feature<GeoJSON.LineString>).geometry.coordinates.length;
    expect(n2).toBeGreaterThan(n1);
    app.renderAt(app.tl.legEnd[0]! + 0.5);
    const done = rec.sourceData['trail-done']!.at(-1) as GeoJSON.Feature<GeoJSON.MultiLineString>;
    expect(done.geometry.coordinates.length).toBe(1);
  });

  it('rotates the boat to its heading and respects the rotate setting', () => {
    const { app } = route();
    app.setMode('preview');
    app.renderAt((app.tl.legStart[0]! + app.tl.legEnd[0]!) / 2);
    const rot = document.querySelector<HTMLElement>('.boat-rot')!;
    expect(rot.style.transform).toMatch(/^rotate\(/);
    app.project.settings.boat.rotate = false;
    app.commit('settings');
    expect(rot.style.transform).toBe('none');
  });

  it('play/pause/replay state machine and playbar labels', () => {
    const { app, $ } = route();
    const play = $('playbar').querySelector<HTMLButtonElement>('.pb-play')!;
    expect(app.mode).toBe('edit');
    app.play();
    expect(app.mode).toBe('preview');
    expect(app.playing).toBe(true);
    expect(play.textContent).toBe('Pause');
    app.pause();
    expect(play.textContent).toBe('Play');
    app.seek(app.tl.total);
    expect(play.textContent).toBe('Replay');
    app.restart();
    expect(app.t).toBe(0);
    app.setMode('edit');
    expect($('playbar').style.display).toBe('none');
    expect($('toolbar').style.display).toBe('');
  });

  it('preloads tiles along the whole route before playing, once, and can be skipped', async () => {
    const { app } = route();
    app.settings.camera.preload = true;
    // Previews never preload; only the hidden-interface (recording) view does.
    app.play();
    expect(app.playing).toBe(true);
    app.pause();
    app.setClean(true);
    const progress: number[] = [];
    app.on('preload', (p) => progress.push(p));
    rec.jumps = [];
    app.play();
    expect(app.preloading).toBe(true);
    expect(app.playing).toBe(false);
    await vi.waitFor(() => expect(app.playing).toBe(true));
    expect(rec.jumps.length).toBeGreaterThan(20);
    expect(progress.at(-1)).toBe(-1);
    expect(Math.max(...progress)).toBe(1);

    // Same route and camera: no second pass.
    app.pause();
    rec.jumps = [];
    app.play();
    expect(app.playing).toBe(true);

    // Changing the route preloads again, and skipping it still starts playback.
    app.pause();
    app.project.stops[1]!.zoom = 14;
    app.commit('settings');
    app.play();
    app.cancelPreload();
    await vi.waitFor(() => expect(app.playing).toBe(true));
    expect(app.preloading).toBe(false);
  });

  it('play with no stops explains why instead of starting', () => {
    const { app, $ } = mount();
    app.play();
    expect(app.playing).toBe(false);
    expect($('toast').textContent).toMatch(/Add a stop/);
  });

  it('edits made during preview keep time in range', () => {
    const { app } = route();
    app.seek(app.tl.total);
    app.deleteStop(app.project.stops[2]!.id);
    expect(app.t).toBeLessThanOrEqual(app.tl.total);
    app.renderAt(app.t);
  });
});

describe('projects', () => {
  it('round-trips through JSON and survives older/partial files', () => {
    const { app } = mount();
    click(app, 24, 60);
    click(app, 26, 60.5);
    app.project.legs[0]!.waypoints.push([25, 59.9]);
    app.project.legs[0]!.durationSec = 9;
    app.project.settings.trail.color = '#00ff00';
    const copy = parseProject(serializeProject(app.project));
    expect(copy.stops).toEqual(app.project.stops);
    expect(copy.legs).toEqual(app.project.legs);
    expect(copy.settings).toEqual(app.project.settings);

    const partial = parseProject(JSON.stringify({ stops: [{ lngLat: [1, 2] }], settings: { trail: { width: 9 } } }));
    expect(partial.stops.length).toBe(1);
    expect(partial.settings.trail.width).toBe(9);
    expect(partial.settings.trail.color).toBe('#d6246e');
    expect(partial.settings.camera.intro).toBe(true);
  });

  it('rejects files that are not projects and ignores junk fields', () => {
    expect(() => parseProject('[]')).toThrow();
    expect(() => parseProject('{"hello":1}')).toThrow();
    expect(() => parseProject('not json')).toThrow();
    const p = parseProject(JSON.stringify({ stops: [{ lngLat: ['x', 2] }, { lngLat: [1, 2], pauseSec: 'long' }], settings: { legDurationSec: 'fast' } }));
    expect(p.stops.length).toBe(1);
    expect(p.stops[0]!.pauseSec).toBeNull();
    expect(p.settings.legDurationSec).toBe(6);
  });

  it('never writes the MapTiler key into the project file', () => {
    const { app } = mount();
    app.setMapTilerKey('secret-key-123');
    expect(serializeProject(app.project)).not.toContain('secret-key-123');
    expect(localStorage.getItem('boat-route:maptiler-key')).toBe('secret-key-123');
  });

  it('loading a project refreshes the form and rebuilds the list', () => {
    const { app, $ } = mount();
    click(app, 24, 60);
    const other = parseProject(JSON.stringify({ name: 'Archipelago', stops: [{ lngLat: [1, 2] }, { lngLat: [2, 3] }, { lngLat: [3, 3] }], settings: { legDurationSec: 20 } }));
    app.loadProject(other);
    expect($('panel').querySelectorAll('.stop-row').length).toBe(3);
    expect(($('panel').querySelector('.name-input') as HTMLInputElement).value).toBe('Archipelago');
    const legInput = Array.from($('panel').querySelectorAll<HTMLElement>('.field')).find((f) => f.textContent?.startsWith('Time per leg'))!.querySelector('input')!;
    expect(legInput.value).toBe('20');
    expect(app.mode).toBe('edit');
  });

  it('autosaves after edits', async () => {
    vi.useFakeTimers();
    const { app } = mount();
    click(app, 24, 60);
    vi.advanceTimersByTime(500);
    vi.useRealTimers();
    expect(JSON.parse(localStorage.getItem('boat-route:project')!).stops.length).toBe(1);
  });
});

describe('clean mode', () => {
  it('toggles the body class', () => {
    const { app } = mount();
    app.setClean(true);
    expect(document.body.classList.contains('clean')).toBe(true);
    app.setClean(false);
    expect(document.body.classList.contains('clean')).toBe(false);
  });
});

describe('resolution independence', () => {
  const zoomAtFirstStop = (w: number, h: number) => {
    const { app } = mount({ w, h });
    click(app, 24, 60);
    click(app, 26, 60.5);
    app.setMode('preview');
    rec.jumps = [];
    app.renderAt(app.tl.arrival[0]! + 0.5); // resting on stop 1 at the default stop zoom
    return { app, zoom: rec.jumps.at(-1)!.zoom };
  };

  it('the same design zoom frames the same area in a window half the size', () => {
    const full = zoomAtFirstStop(1920, 1080);
    const half = zoomAtFirstStop(960, 540);
    expect(full.zoom).toBeCloseTo(full.app.project.settings.camera.stopZoom, 9);
    expect(full.zoom - half.zoom).toBeCloseTo(1, 9);
    expect(full.app.scale).toBeCloseTo(1, 9);
    expect(half.app.scale).toBeCloseTo(0.5, 9);
  });

  it('uses the shorter side, so vertical and square frames match too', () => {
    const portrait = zoomAtFirstStop(1080, 1920);
    expect(portrait.zoom).toBeCloseTo(portrait.app.project.settings.camera.stopZoom, 9);
  });

  it('label, boat and trail sizes scale with the stage', () => {
    const { app } = mount({ w: 540, h: 960 });
    expect(app.scale).toBeCloseTo(0.5, 9);
    expect(document.getElementById('stage')!.style.getPropertyValue('--u')).toBe('0.5');
  });

  it('letterboxes the stage to the chosen frame shape', () => {
    const { app, $ } = mount({ w: 1000, h: 1000 });
    app.project.settings.aspectLock = '9:16';
    app.commit('settings');
    expect($('stage').style.width).toBe('562px');
    expect($('stage').style.height).toBe('1000px');
    app.project.settings.aspectLock = '16:9';
    app.commit('settings');
    expect($('stage').style.width).toBe('1000px');
    expect($('stage').style.height).toBe('562px');
    app.project.settings.aspectLock = 'free';
    app.commit('settings');
    expect($('stage').style.width).toBe('100%');
  });
});

describe('review fixes', () => {
  const stops = [{ lngLat: [24, 60] }, { lngLat: [25, 60.4] }];

  it('loaded files cannot inject markup or break the stage with bad values', () => {
    const evil = parseProject(
      JSON.stringify({
        stops,
        settings: {
          aspectLock: 'foo',
          boat: { icon: 'custom', customImage: 'x" onerror="alert(1)', color: 'red;background:url(x)', size: -5 },
          trail: { width: 1e9 },
        },
      }),
    );
    const s = evil.settings;
    expect(s.boat.customImage).toBeNull();
    expect(s.aspectLock).toBe('free');
    expect(s.boat.color).toBe('#ffffff');
    expect(s.boat.size).toBe(4);
    expect(s.trail.width).toBe(100);
    const ok = parseProject(JSON.stringify({ stops, settings: { boat: { icon: 'custom', customImage: 'data:image/png;base64,iVBORw0KGgo=' } } }));
    expect(ok.settings.boat.customImage).toMatch(/^data:image\/png/);
  });

  it('a file whose stops are all invalid is rejected instead of opening empty', () => {
    expect(() => parseProject(JSON.stringify({ stops: [{ nope: 1 }] }))).toThrow(/No valid stops/);
    expect(parseProject(JSON.stringify({ stops: [] })).stops).toEqual([]);
  });

  it('the second click of a double-click does not add another stop', () => {
    const { app } = mount();
    click(app, 24.9, 60.1);
    click(app, 24.9, 60.1);
    expect(app.project.stops.length).toBe(1);
  });

  it('showing the interface or leaving preview while tiles load does not start playback afterwards', async () => {
    const { app } = mount();
    click(app, 24, 60);
    // click() resets nothing: wait out the double-click guard by using a distant point
    click(app, 30, 65);
    app.setClean(true);
    app.play();
    expect(app.preloading).toBe(true);
    app.setClean(false);
    await vi.waitFor(() => expect(app.preloading).toBe(false));
    expect(app.playing).toBe(false);

    app.setClean(true);
    app.play();
    app.setMode('edit');
    await vi.waitFor(() => expect(app.preloading).toBe(false));
    expect(app.playing).toBe(false);
    expect(app.mode).toBe('edit');
  });
});

describe('custom map', () => {
  const style = { kind: 'style', url: 'https://example.com/style.json?key={key}', attribution: '' } as const;

  it('validates the URL and falls back to Voyager when unusable', () => {
    expect(customProblem({ ...style, url: '' }, 'k')).toMatch(/Enter/);
    expect(customProblem({ ...style, url: 'javascript:alert(1)' }, 'k')).toMatch(/https/);
    expect(customProblem({ ...style, url: 'http://evil.example/x.json' }, 'k')).toMatch(/https/);
    expect(customProblem(style, null)).toMatch(/key/);
    expect(customProblem({ kind: 'raster', url: 'https://t.example/{z}/{x}.png', attribution: '' }, null)).toMatch(/\{y\}/);
    expect(customProblem(style, 'k')).toBeNull();
    expect(resolveStyle('custom', null, style).fellBack).toBe(true);
    expect(resolveStyle('custom', 'k', style).def.id).toBe('custom');
  });

  it('fills in the key, and escapes credit text in raster maps', () => {
    const def = resolveStyle('custom', 'a b', style).def;
    expect(def.build('a b', style)).toBe('https://example.com/style.json?key=a%20b');
    const raster = { kind: 'raster', url: 'https://t.example/{z}/{x}/{y}.png', attribution: '<img src=x onerror=alert(1)>' } as const;
    const spec = def.build(null, raster) as unknown as { sources: { base: { attribution: string; tiles: string[] } } };
    expect(spec.sources.base.attribution).not.toContain('<');
    expect(spec.sources.base.tiles).toEqual([raster.url]);
  });

  it('is saved in the project file', () => {
    const { app } = mount();
    app.project.settings.style = 'custom';
    app.project.settings.customMap = { ...style };
    const copy = parseProject(serializeProject({ ...app.project, stops: [{ ...stopFixture }] }));
    expect(copy.settings.style).toBe('custom');
    expect(copy.settings.customMap.url).toBe(style.url);
  });
});

const stopFixture = { id: 's', name: 'A', lngLat: [24, 60] as [number, number], pauseSec: null, popup: true, zoom: null };
