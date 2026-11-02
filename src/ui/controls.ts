import type { App, Tool } from '../app';
import { markWelcomeSeen, welcomeSeen } from '../project/storage';
import { clear, formatTime, h, isTypingTarget } from './dom';

/** Floating toolbar for Edit route mode. */
export class Toolbar {
  private tools = new Map<Tool, HTMLButtonElement>();
  private hint = h('span', { class: 'tb-hint' });
  private zoom = h('span', { class: 'tb-zoom', title: 'Zoom of the map as you see it, in recording units' });

  constructor(
    private app: App,
    private root: HTMLElement,
  ) {
    const mk = (tool: Tool, label: string, title: string) => {
      const b = h('button', { type: 'button', class: 'tb-btn', text: label, title, onclick: () => app.setTool(tool) });
      this.tools.set(tool, b);
      return b;
    };
    root.append(
      mk('stop', 'Add stops', 'Click the map to add a stop at the end of the route'),
      mk('bend', 'Bend route', 'Click near a leg to add a point that bends it'),
      h('button', { type: 'button', class: 'tb-btn', text: 'Fit route', title: 'Zoom to the whole route', onclick: () => app.fitToRoute() }),
      this.zoom,
      this.hint,
    );
    app.on('tool', () => this.update());
    app.on('mode', () => this.update());
    app.on('zoom', (z) => {
      this.zoom.textContent = `Zoom ${z.toFixed(1)}`;
    });
    this.update();
  }

  private update(): void {
    const editing = this.app.mode === 'edit';
    this.root.style.display = editing ? '' : 'none';
    for (const [tool, b] of this.tools) b.classList.toggle('is-active', tool === this.app.tool);
    this.hint.textContent =
      this.app.tool === 'stop'
        ? 'Click the map to add a stop. Drag a stop to move it.'
        : 'Bends go to the highlighted leg. Pick another in the stop list. Drag points to reshape, double-click to remove.';
    if (this.zoom.textContent === '') this.zoom.textContent = `Zoom ${this.app.designZoom().toFixed(1)}`;
  }
}

/** Transport controls for Preview mode. */
export class Playbar {
  private play: HTMLButtonElement;
  private scrub = h('input', { type: 'range', class: 'pb-scrub', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Position' });
  private time = h('span', { class: 'pb-time', text: '0:00 / 0:00' });
  private app: App;
  private dragging = false;

  constructor(app: App, private root: HTMLElement) {
    this.app = app;
    this.play = h('button', { type: 'button', class: 'pb-btn pb-play', text: 'Play', onclick: () => app.toggle() });
    const speed = h('select', { class: 'pb-speed', 'aria-label': 'Playback speed' });
    for (const v of [0.5, 1, 2, 4]) speed.append(h('option', { value: String(v), text: `${v}×`, selected: v === 1 }));
    speed.addEventListener('change', () => {
      app.speed = parseFloat(speed.value);
    });

    this.scrub.addEventListener('input', () => {
      this.dragging = true;
      app.pause();
      app.seek((parseFloat(this.scrub.value) / 1000) * app.tl.total);
    });
    this.scrub.addEventListener('change', () => {
      this.dragging = false;
    });

    root.append(
      this.play,
      h('button', { type: 'button', class: 'pb-btn', text: 'Restart', onclick: () => app.restart() }),
      this.scrub,
      this.time,
      speed,
      h('button', { type: 'button', class: 'pb-btn', text: 'Hide interface', title: 'Clean view for recording (H)', onclick: () => app.setClean(true) }),
    );
    app.on('time', () => this.update());
    app.on('play', () => this.update());
    app.on('mode', () => this.update());
    app.on('structure', () => this.update());
    app.on('settings', () => this.update());
    this.update();
  }

  private update(): void {
    const { app } = this;
    this.root.style.display = app.mode === 'preview' ? '' : 'none';
    this.play.textContent = app.playing ? 'Pause' : app.t >= app.tl.total && app.tl.total > 0 ? 'Replay' : 'Play';
    if (!this.dragging) this.scrub.value = String(app.tl.total > 0 ? Math.round((app.t / app.tl.total) * 1000) : 0);
    this.time.textContent = `${formatTime(app.t)} / ${formatTime(app.tl.total)}`;
  }
}

export class Toast {
  private timer = 0;
  constructor(private el: HTMLElement, app: App) {
    app.on('toast', (msg) => this.show(msg));
  }
  show(msg: string): void {
    clear(this.el);
    this.el.textContent = msg;
    this.el.classList.add('is-on');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('is-on'), 3200);
  }
}

/** Centered controls reminder shown in clean mode until the user presses R. */
export class CleanHint {
  constructor(el: HTMLElement, app: App) {
    el.append(
      h('div', { class: 'clean-hint-title', text: 'Interface hidden' }),
      h('div', { class: 'clean-hint-row' }, h('kbd', { text: 'Space' }), ' play / pause'),
      h('div', { class: 'clean-hint-row' }, h('kbd', { text: 'R' }), ' restart and dismiss this'),
      h('div', { class: 'clean-hint-row' }, h('kbd', { text: 'H' }), ' or ', h('kbd', { text: 'Esc' }), ' show interface'),
    );
    app.on('clean', () => {
      el.hidden = !app.clean;
    });
    window.addEventListener('keydown', (e) => {
      if (!el.hidden && (e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        el.hidden = true;
      }
    });
  }
}

/** Covers the stage while map tiles load ahead of playback. */
export class PreloadOverlay {
  constructor(el: HTMLElement, app: App) {
    const bar = h('div', { class: 'preload-bar' });
    el.append(
      h('div', { class: 'preload-title', text: 'Loading map tiles' }),
      h('div', { class: 'preload-track' }, bar),
      h('div', {
        class: 'preload-why',
        text: 'Fast zooms need map tiles that are not on screen yet. Loading them now, before the animation starts, keeps the map from showing blurry or blank areas while the camera moves.',
      }),
      h('div', { class: 'preload-note', text: 'Esc to skip and play right away. You can turn this off under Camera > Load map tiles before playing (interface hidden).' }),
    );
    app.on('preload', (p) => {
      el.hidden = p < 0;
      bar.style.width = `${Math.round(Math.max(0, p) * 100)}%`;
    });
  }
}

/** First-run quick start, shown once until dismissed. */
export class Welcome {
  constructor(el: HTMLElement) {
    if (welcomeSeen()) return;
    const close = () => {
      el.hidden = true;
      markWelcomeSeen();
      window.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    const step = (n: string, text: string) => h('li', {}, h('span', { class: 'welcome-n', text: n }), h('span', { text }));
    el.append(
      h('div', { class: 'clean-hint-title', text: 'Make a route map for your video' }),
      h(
        'ol',
        { class: 'welcome-steps' },
        step('1', 'Click the map to add stops in trip order.'),
        step('2', 'Use Bend route to shape each leg around land.'),
        step('3', 'Switch to Preview and press Space to play.'),
        step('4', 'Press H to hide the interface, then screen-record.'),
      ),
      h('button', { type: 'button', class: 'btn btn-primary', text: 'Got it', onclick: close }),
    );
    el.hidden = false;
    window.addEventListener('keydown', onKey, true);
  }
}
