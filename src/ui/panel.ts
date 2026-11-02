import type { App } from '../app';
import { formatCoordinates, parseCoordinates } from '../geo/coords';
import { BOAT_ICONS } from '../map/icons';
import { customProblem, STYLES } from '../map/styles';
import { legColor } from '../route/model';
import { downloadProject, parseProject } from '../project/storage';
import type { AspectLock, CoordFormat, CustomMap, Easing, LabelTheme, Stop, StyleId } from '../types';
import { clear, h } from './dom';

type Refresh = () => void;

interface NumOpts {
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export class Panel {
  private refreshers: Refresh[] = [];
  private stopList = h('ul', { class: 'stop-list' });
  private coordInputs = new Map<string, HTMLInputElement>();
  private modeButtons = new Map<string, HTMLButtonElement>();
  private nameInput!: HTMLInputElement;
  private keyInput!: HTMLInputElement;
  private styleNote = h('p', { class: 'note' });
  private styleSelect!: HTMLSelectElement;
  private customRow = h('div', { class: 'field' });
  private customMapBox: HTMLElement | null = null;

  constructor(
    private app: App,
    private root: HTMLElement,
  ) {
    this.build();
    app.on('structure', () => this.renderStops());
    app.on('load', () => this.refreshAll());
    app.on('selection', () => this.markSelection(true));
    app.on('leg', () => this.markLeg());
    app.on('geometry', () => this.syncCoordInputs());
    app.on('settings', () => {
      this.syncCoordInputs();
      this.updateStyleNote();
    });
    app.on('mode', () => this.markMode());
  }

  // ───────────────────────── field builders ─────────────────────────

  private field(label: string, control: HTMLElement, hint?: string): HTMLElement {
    return h('label', { class: 'field' }, h('span', { class: 'field-label', text: label, title: hint }), control);
  }

  private num(label: string, get: () => number, set: (v: number) => void, o: NumOpts = {}): HTMLElement {
    const input = h('input', { type: 'number', min: o.min, max: o.max, step: o.step ?? 1 });
    const unit = o.unit ? h('span', { class: 'unit', text: o.unit }) : null;
    const sync = () => {
      if (document.activeElement !== input) input.value = String(get());
    };
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        set(Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v)));
        this.app.commit('settings');
      }
    });
    input.addEventListener('blur', () => {
      input.value = String(get());
    });
    sync();
    this.refreshers.push(sync);
    return this.field(label, h('span', { class: 'ctl' }, input, unit));
  }

  private check(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const input = h('input', { type: 'checkbox' });
    const sync = () => {
      input.checked = get();
    };
    input.addEventListener('change', () => {
      set(input.checked);
      this.app.commit('settings');
    });
    sync();
    this.refreshers.push(sync);
    return h('label', { class: 'field field-check' }, input, h('span', { class: 'field-label', text: label }));
  }

  private select<T extends string>(
    label: string,
    options: { value: T; label: string; disabled?: boolean }[],
    get: () => T,
    set: (v: T) => void,
  ): { el: HTMLElement; select: HTMLSelectElement } {
    const sel = h('select');
    for (const o of options) sel.append(h('option', { value: o.value, text: o.label, disabled: o.disabled }));
    const sync = () => {
      sel.value = get();
    };
    sel.addEventListener('change', () => {
      set(sel.value as T);
      this.app.commit('settings');
    });
    sync();
    this.refreshers.push(sync);
    return { el: this.field(label, sel), select: sel };
  }

  private color(label: string, get: () => string, set: (v: string) => void): HTMLElement {
    const input = h('input', { type: 'color' });
    const sync = () => {
      input.value = get();
    };
    input.addEventListener('input', () => {
      set(input.value);
      this.app.commit('settings');
    });
    sync();
    this.refreshers.push(sync);
    return this.field(label, input);
  }

  private section(title: string, open: boolean, ...children: (Node | null)[]): HTMLElement {
    return h('details', { class: 'sec', open }, h('summary', { text: title }), h('div', { class: 'sec-body' }, ...children));
  }

  private button(label: string, onClick: () => void, cls = 'btn', title?: string): HTMLButtonElement {
    return h('button', { type: 'button', class: cls, text: label, title, onclick: onClick });
  }

  // ───────────────────────── layout ─────────────────────────

  private build(): void {
    const app = this.app;
    const s = () => app.project.settings;

    this.nameInput = h('input', { class: 'name-input', type: 'text', value: app.project.name, 'aria-label': 'Project name' });
    this.nameInput.addEventListener('input', () => {
      app.project.name = this.nameInput.value;
      app.labelsChanged();
    });
    this.refreshers.push(() => {
      this.nameInput.value = app.project.name;
    });

    const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      try {
        const project = parseProject(await file.text());
        if (app.project.stops.length > 0 && !confirm('Open this file? Unsaved changes in the current project will be lost.')) return;
        app.loadProject(project);
        app.toast(`Opened ${file.name}`);
      } catch (e) {
        app.toast(e instanceof Error ? e.message : 'Could not open that file.');
      }
    });

    const modeSwitch = h('div', { class: 'seg', role: 'tablist' });
    for (const [mode, label] of [
      ['edit', 'Edit route'],
      ['preview', 'Preview'],
    ] as const) {
      const b = h('button', { type: 'button', role: 'tab', class: 'seg-btn', text: label, onclick: () => app.setMode(mode) });
      this.modeButtons.set(mode, b);
      modeSwitch.append(b);
    }

    const head = h(
      'header',
      { class: 'panel-head' },
      this.nameInput,
      modeSwitch,
      h(
        'div',
        { class: 'row' },
        this.button('New', () => {
          if (app.project.stops.length === 0 || confirm('Start a new project? Unsaved changes in this one will be lost.')) app.newProject();
        }),
        this.button('Open…', () => fileInput.click()),
        this.button('Save', () => downloadProject(app.project), 'btn btn-primary', 'Download the project as a .route.json file'),
        this.button('Hide interface', () => app.setClean(true), 'btn', 'Clean view for recording (H)'),
      ),
      fileInput,
    );

    // Stops
    const coordInput = h('input', { type: 'text', placeholder: '60.1699, 24.9384  or  60°10.2′N 24°56.3′E', 'aria-label': 'Coordinates' });
    const coordError = h('p', { class: 'error', role: 'alert' });
    const addByCoords = () => {
      const r = parseCoordinates(coordInput.value);
      if (!r.ok) {
        coordError.textContent = r.error;
        return;
      }
      coordError.textContent = '';
      coordInput.value = '';
      app.addStopAt(r.lngLat);
    };
    coordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addByCoords();
    });
    const stopsSection = this.section(
      'Stops',
      true,
      this.stopList,
      h('div', { class: 'add-coords' }, coordInput, this.button('Add stop', addByCoords)),
      coordError,
      h('p', { class: 'note', text: 'You can also click the map in Edit route mode. Use Bend route in the toolbar to shape a leg around land.' }),
    );

    // Timing
    const easing = this.select<Easing>(
      'Boat movement',
      [
        { value: 'linear', label: 'Even pace' },
        { value: 'ease', label: 'Ease in and out (cruise)' },
      ],
      () => s().easing,
      (v) => (s().easing = v),
    );
    const timing = this.section(
      'Timing',
      false,
      this.num('Time per leg', () => s().legDurationSec, (v) => (s().legDurationSec = v), { min: 0.5, max: 300, step: 0.5, unit: 's' }),
      this.num('Pause at each stop', () => s().defaultPauseSec, (v) => (s().defaultPauseSec = v), { min: 0, max: 60, step: 0.5, unit: 's' }),
      easing.el,
      h('p', { class: 'note', text: 'Every leg takes the same time by default, so the boat moves faster on long legs. Override a single leg in the stop list.' }),
    );

    // Camera
    const useView = (label: string, apply: (z: number) => void) =>
      this.button(
        label,
        () => {
          apply(Math.round(app.designZoom() * 10) / 10);
          app.commit('settings');
          this.refreshAll();
        },
        'btn btn-small',
        'Sets this to the zoom of the map as you see it now (Edit route mode)',
      );
    const camera = this.section(
      'Camera',
      false,
      this.num('Zoom at stops', () => s().camera.stopZoom, (v) => (s().camera.stopZoom = v), { min: 0, max: 19, step: 0.5 }),
      useView('Use current view for stops', (z) => (s().camera.stopZoom = z)),
      this.num('Zoom while sailing', () => s().camera.travelZoom, (v) => (s().camera.travelZoom = v), { min: 0, max: 19, step: 0.5 }),
      useView('Use current view for sailing', (z) => (s().camera.travelZoom = z)),
      this.check('Camera follows the boat', () => s().camera.follow, (v) => (s().camera.follow = v)),
      this.check('Load map tiles before playing (interface hidden)', () => s().camera.preload, (v) => (s().camera.preload = v)),
      this.check('Fly in from the whole route at the start', () => s().camera.intro, (v) => (s().camera.intro = v)),
      h(
        'div',
        { class: 'row' },
        this.button('Use current view as start', () => {
          s().camera.startView = app.currentView();
          app.commit('settings');
          this.refreshAll();
        }, 'btn btn-small', 'The fly-in starts from the map as you see it now (Edit route mode)'),
        this.button('Auto-fit start', () => {
          s().camera.startView = null;
          app.commit('settings');
          this.refreshAll();
        }, 'btn btn-small', 'Start the fly-in from the whole route'),
      ),
      this.num('Fly-in time', () => s().camera.introSec, (v) => (s().camera.introSec = v), { min: 0.5, max: 30, step: 0.5, unit: 's' }),
      this.check('Zoom out to the whole route at the end', () => s().camera.outro, (v) => (s().camera.outro = v)),
      this.num('Zoom-out time', () => s().camera.outroSec, (v) => (s().camera.outroSec = v), { min: 0.5, max: 30, step: 0.5, unit: 's' }),
      this.num('Hold at the end', () => s().camera.outroHoldSec, (v) => (s().camera.outroHoldSec = v), { min: 0, max: 30, step: 0.5, unit: 's' }),
      h('p', { class: 'note', text: 'Zoom values are for a 1080 px stage. Smaller windows are scaled to match, so what you preview is what you record. With follow off, the camera frames the whole route while sailing.' }),
    );

    // Map
    const style = this.select<StyleId>(
      'Map style',
      STYLES.map((d) => ({ value: d.id, label: d.label, disabled: false })),
      () => s().style,
      (v) => (s().style = v),
    );
    this.styleSelect = style.select;
    const customMap = this.customMapFields();
    const aspect = this.select<AspectLock>(
      'Frame shape',
      [
        { value: 'free', label: 'Fit window' },
        { value: '16:9', label: '16:9 widescreen' },
        { value: '9:16', label: '9:16 vertical' },
        { value: '1:1', label: '1:1 square' },
        { value: '4:3', label: '4:3' },
        { value: '21:9', label: '21:9 cinematic' },
      ],
      () => s().aspectLock,
      (v) => (s().aspectLock = v),
    );
    const coordFmt = this.select<CoordFormat>(
      'Coordinate format',
      [
        { value: 'degmin', label: 'Degrees and minutes' },
        { value: 'decimal', label: 'Decimal degrees' },
        { value: 'dms', label: 'Degrees, minutes, seconds' },
      ],
      () => s().coordFormat,
      (v) => (s().coordFormat = v),
    );
    this.keyInput = h('input', { type: 'password', placeholder: 'Optional MapTiler key', autocomplete: 'off', 'aria-label': 'MapTiler API key' });
    this.keyInput.value = app.mapTilerKey ?? '';
    const keyRow = h(
      'div',
      { class: 'add-coords' },
      this.keyInput,
      this.button('Save key', () => {
        app.setMapTilerKey(this.keyInput.value);
        this.updateStyleOptions();
        app.toast(app.mapTilerKey ? 'MapTiler key saved in this browser.' : 'MapTiler key removed.');
      }),
    );
    const map = this.section(
      'Map',
      false,
      style.el,
      customMap,
      this.styleNote,
      keyRow,
      h('p', { class: 'note', text: 'The key stays in this browser and is not written to project files.' }),
      this.check('Nautical marks (OpenSeaMap)', () => s().seaMarks, (v) => (s().seaMarks = v)),
      aspect.el,
      this.check('Show map credit', () => s().showAttribution, (v) => (s().showAttribution = v)),
      coordFmt.el,
    );
    this.updateStyleOptions();

    // Trail
    const trail = this.section(
      'Trail',
      false,
      this.color('Colour', () => s().trail.color, (v) => (s().trail.color = v)),
      this.num('Width', () => s().trail.width, (v) => (s().trail.width = v), { min: 1, max: 24, step: 0.5, unit: 'px' }),
      this.num('Dash length', () => s().trail.dash[0], (v) => (s().trail.dash[0] = v), { min: 0.2, max: 8, step: 0.1 }),
      this.num('Gap length', () => s().trail.dash[1], (v) => (s().trail.dash[1] = v), { min: 0.2, max: 8, step: 0.1 }),
      this.num('Opacity', () => s().trail.opacity, (v) => (s().trail.opacity = v), { min: 0.1, max: 1, step: 0.05 }),
    );

    // Boat
    const icon = this.select(
      'Icon',
      BOAT_ICONS.map((i) => ({ value: i.id, label: i.label })),
      () => s().boat.icon,
      (v) => {
        s().boat.icon = v;
        this.updateCustomRow();
      },
    );
    const upload = h('input', { type: 'file', accept: 'image/*', hidden: true });
    upload.addEventListener('change', async () => {
      const file = upload.files?.[0];
      upload.value = '';
      if (!file) return;
      try {
        s().boat.customImage = await shrinkImage(file, 256);
        s().boat.icon = 'custom';
        app.commit('settings');
        this.refreshAll();
      } catch {
        app.toast('Could not read that image.');
      }
    });
    clear(this.customRow);
    this.customRow.append(
      this.button('Choose image…', () => upload.click()),
      h('span', { class: 'note', text: 'Draw it pointing up so it turns correctly.' }),
      upload,
    );
    const boat = this.section(
      'Boat',
      false,
      icon.el,
      this.customRow,
      this.num('Size', () => s().boat.size, (v) => (s().boat.size = v), { min: 16, max: 200, step: 2, unit: 'px' }),
      this.color('Colour', () => s().boat.color, (v) => (s().boat.color = v)),
      this.check('Turn to face the direction of travel', () => s().boat.rotate, (v) => (s().boat.rotate = v)),
      this.num('Rotation offset', () => s().boat.rotationOffset, (v) => (s().boat.rotationOffset = v), { min: -180, max: 180, step: 5, unit: '°' }),
    );
    this.updateCustomRow();
    icon.select.addEventListener('change', () => this.updateCustomRow());

    // Labels
    const theme = this.select<LabelTheme>(
      'Label style',
      [
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      () => s().labels.theme,
      (v) => (s().labels.theme = v),
    );
    const labels = this.section(
      'Labels',
      false,
      this.num('Text size', () => s().labels.size, (v) => (s().labels.size = v), { min: 10, max: 72, step: 1, unit: 'px' }),
      theme.el,
      this.check('Keep names of places already visited', () => s().labels.showVisited, (v) => (s().labels.showVisited = v)),
      this.check('Show stops before the boat arrives', () => s().labels.showUpcoming, (v) => (s().labels.showUpcoming = v)),
    );

    const keys = h(
      'p',
      { class: 'note keys' },
      'Space plays or pauses. H hides the interface for recording. R restarts. Esc brings the interface back.',
    );

    this.root.append(head, stopsSection, timing, camera, map, trail, boat, labels, keys);
    this.renderStops();
    this.markMode();
  }

  // ───────────────────────── dynamic parts ─────────────────────────

  private updateCustomRow(): void {
    this.customRow.style.display = this.app.project.settings.boat.icon === 'custom' ? '' : 'none';
  }

  private updateStyleOptions(): void {
    const hasKey = !!this.app.mapTilerKey;
    for (const opt of Array.from(this.styleSelect.options)) {
      const def = STYLES.find((d) => d.id === opt.value);
      opt.disabled = !!def?.needsKey && !hasKey;
    }
    this.updateStyleNote();
  }

  /** URL fields for the "Custom map" style; shown only while it is selected. */
  private customMapFields(): HTMLElement {
    const app = this.app;
    const c = () => app.project.settings.customMap;
    const kind = this.select<CustomMap['kind']>(
      'Map source',
      [
        { value: 'style', label: 'Style file (style.json)' },
        { value: 'raster', label: 'Raster tiles ({z}/{x}/{y})' },
      ],
      () => c().kind,
      (v) => (c().kind = v),
    );
    const text = (label: string, placeholder: string, get: () => string, set: (v: string) => void) => {
      const input = h('input', { type: 'text', placeholder, autocomplete: 'off', spellcheck: false, 'aria-label': label });
      const sync = () => {
        input.value = get();
      };
      // 'change' (blur or Enter), not 'input': every commit reloads the map style.
      input.addEventListener('change', () => {
        set(input.value.trim());
        app.commit('settings');
      });
      sync();
      this.refreshers.push(sync);
      return this.field(label, input);
    };
    const box = h(
      'div',
      { class: 'custom-map' },
      kind.el,
      text('Map URL', 'https://…/style.json?key={key}', () => c().url, (v) => (c().url = v)),
      text('Credit text', '© Your map provider', () => c().attribution, (v) => (c().attribution = v)),
      h('p', { class: 'note', text: 'Use {key} where your MapTiler key goes. The key itself is never saved in the project. Raster tile URLs need {z}, {x} and {y}.' }),
    );
    this.customMapBox = box;
    return box;
  }

  private updateStyleNote(): void {
    const style = this.app.project.settings.style;
    if (this.customMapBox) this.customMapBox.style.display = style === 'custom' ? '' : 'none';
    if (this.app.styleFellBack && style === 'custom') {
      this.styleNote.textContent = `${customProblem(this.app.project.settings.customMap, this.app.mapTilerKey) ?? 'Custom map unavailable.'} Showing Voyager meanwhile.`;
    } else {
      const needs = STYLES.find((d) => d.id === style)?.needsKey;
      this.styleNote.textContent = needs && !this.app.mapTilerKey ? 'This style needs a MapTiler key. Showing Voyager until you add one.' : '';
    }
    this.styleNote.style.display = this.styleNote.textContent ? '' : 'none';
  }

  private refreshAll(): void {
    this.refreshers.forEach((r) => r());
    this.keyInput.value = this.app.mapTilerKey ?? '';
    this.updateStyleOptions();
    this.updateCustomRow();
    this.renderStops();
    this.markMode();
  }

  private markMode(): void {
    for (const [mode, b] of this.modeButtons) {
      const active = mode === this.app.mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    }
  }

  private markLeg(): void {
    this.stopList.querySelectorAll<HTMLElement>('.leg-row').forEach((row) => {
      row.classList.toggle('is-active', Number(row.dataset.leg) === this.app.activeLeg);
    });
  }

  private markSelection(scroll: boolean): void {
    const id = this.app.selectedStopId;
    this.stopList.querySelectorAll<HTMLElement>('.stop-row').forEach((row) => {
      const on = row.dataset.id === id;
      row.classList.toggle('is-selected', on);
      if (on && scroll) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  private syncCoordInputs(): void {
    const fmt = this.app.project.settings.coordFormat;
    for (const [id, input] of this.coordInputs) {
      const stop = this.app.project.stops.find((s) => s.id === id);
      if (stop && document.activeElement !== input) input.value = formatCoordinates(stop.lngLat, fmt);
    }
  }

  private renderStops(): void {
    const app = this.app;
    const { stops, legs, settings } = app.project;
    clear(this.stopList);
    this.coordInputs.clear();

    if (stops.length === 0) {
      this.stopList.append(h('li', { class: 'empty', text: 'No stops yet. Click the map to place the first one, or type coordinates below.' }));
      return;
    }

    stops.forEach((stop, i) => {
      this.stopList.append(this.stopRow(stop, i, stops.length));
      const leg = legs[i];
      if (leg && i < stops.length - 1) {
        const dur = h('input', {
          type: 'number',
          min: 0.5,
          step: 0.5,
          placeholder: String(settings.legDurationSec),
          value: leg.durationSec ?? '',
          'aria-label': `Time for leg ${i + 1}`,
        });
        dur.addEventListener('input', () => {
          const v = parseFloat(dur.value);
          leg.durationSec = Number.isFinite(v) && v > 0 ? v : null;
          app.commit('settings');
        });
        const zoom = h('input', {
          type: 'number',
          min: 0,
          max: 19,
          step: 0.5,
          placeholder: String(settings.camera.travelZoom),
          value: leg.travelZoom ?? '',
          'aria-label': `Zoom while sailing leg ${i + 1}`,
          title: 'Camera zoom while sailing this leg. Empty uses the project default.',
        });
        zoom.addEventListener('input', () => {
          const v = parseFloat(zoom.value);
          leg.travelZoom = Number.isFinite(v) ? Math.min(19, Math.max(0, v)) : null;
          app.commit('settings');
        });
        const bends = leg.waypoints.length;
        this.stopList.append(
          h(
            'li',
            {
              class: 'leg-row',
              'data-leg': String(i),
              style: `--leg: ${legColor(i)}`,
              title: 'Click to make this the leg that Bend route edits',
              onclick: (e: Event) => {
                if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
                app.setActiveLeg(app.activeLeg === i ? null : i);
              },
            },
            h('span', { class: 'leg-label', text: `Leg ${i + 1} to ${i + 2}` }),
            h('span', { class: 'ctl' }, dur, h('span', { class: 'unit', text: 's' })),
            h('span', { class: 'ctl' }, zoom, h('span', { class: 'unit', text: 'zoom' })),
            h('span', { class: 'leg-bends', text: bends === 0 ? 'straight' : `${bends} bend${bends === 1 ? '' : 's'}` }),
            bends > 0
              ? this.button('Straighten', () => {
                  leg.waypoints = [];
                  app.commit('structure');
                }, 'btn btn-small')
              : null,
          ),
        );
      }
    });
    this.markSelection(false);
    this.markLeg();
  }

  private stopRow(stop: Stop, i: number, total: number): HTMLElement {
    const app = this.app;
    const s = app.project.settings;

    const name = h('input', { class: 'stop-name', type: 'text', value: stop.name, placeholder: `Stop ${i + 1}`, 'aria-label': `Name of stop ${i + 1}` });
    name.addEventListener('input', () => {
      stop.name = name.value;
      app.labelsChanged();
    });
    name.addEventListener('focus', () => {
      if (app.selectedStopId !== stop.id) app.select(stop.id, true);
    });

    const head = h(
      'div',
      { class: 'stop-head', onclick: (e: Event) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLButtonElement) return;
        app.select(app.selectedStopId === stop.id ? null : stop.id, true);
      } },
      h('span', { class: 'badge', text: String(i + 1) }),
      name,
      this.iconButton('Move up', '↑', () => app.shiftStop(stop.id, -1), i === 0),
      this.iconButton('Move down', '↓', () => app.shiftStop(stop.id, 1), i === total - 1),
      this.iconButton('Delete stop', '×', () => app.deleteStop(stop.id), false),
    );

    const coords = h('input', { type: 'text', value: formatCoordinates(stop.lngLat, s.coordFormat), 'aria-label': 'Coordinates' });
    const coordError = h('p', { class: 'error', role: 'alert' });
    this.coordInputs.set(stop.id, coords);
    coords.addEventListener('change', () => {
      const r = parseCoordinates(coords.value);
      if (!r.ok) {
        coordError.textContent = r.error;
        return;
      }
      coordError.textContent = '';
      stop.lngLat = r.lngLat;
      app.commit('geometry');
      coords.value = formatCoordinates(stop.lngLat, app.project.settings.coordFormat);
      app.map.easeTo({ center: stop.lngLat, duration: 500 });
    });

    const optNum = (label: string, get: () => number | null, set: (v: number | null) => void, ph: () => string, o: NumOpts) => {
      const input = h('input', { type: 'number', min: o.min, max: o.max, step: o.step ?? 1, placeholder: ph(), value: get() ?? '' });
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        set(Number.isFinite(v) ? v : null);
        app.commit('settings');
      });
      return { el: this.field(label, h('span', { class: 'ctl' }, input, o.unit ? h('span', { class: 'unit', text: o.unit }) : null)), input };
    };

    const pause = optNum('Pause here', () => stop.pauseSec, (v) => (stop.pauseSec = v === null ? null : Math.max(0, v)), () => String(s.defaultPauseSec), { min: 0, max: 60, step: 0.5, unit: 's' });
    const zoom = optNum('Zoom here', () => stop.zoom, (v) => (stop.zoom = v), () => String(s.camera.stopZoom), { min: 0, max: 19, step: 0.5 });
    const popup = h('input', { type: 'checkbox', checked: stop.popup });
    popup.addEventListener('change', () => {
      stop.popup = popup.checked;
      app.commit('settings');
    });

    const details = h(
      'div',
      { class: 'stop-details' },
      this.field('Coordinates', coords),
      coordError,
      pause.el,
      zoom.el,
      this.button('Use current view as zoom', () => {
        stop.zoom = Math.round(app.designZoom() * 10) / 10;
        zoom.input.value = String(stop.zoom);
        app.commit('settings');
      }, 'btn btn-small', 'Uses the zoom of the map as you see it now (Edit route mode)'),
      h('label', { class: 'field field-check' }, popup, h('span', { class: 'field-label', text: 'Show name and coordinates card' })),
    );

    return h('li', { class: 'stop-row', 'data-id': stop.id }, head, details);
  }

  private iconButton(title: string, glyph: string, onClick: () => void, disabled: boolean): HTMLButtonElement {
    return h('button', { type: 'button', class: 'icon-btn', title, 'aria-label': title, text: glyph, disabled, onclick: onClick });
  }
}

/** Downscale an uploaded image so project files stay small. */
async function shrinkImage(file: File, maxSide: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * k));
  canvas.height = Math.max(1, Math.round(bitmap.height * k));
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}
