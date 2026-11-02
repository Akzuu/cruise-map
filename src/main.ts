import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

import { App } from './app';
import { loadAutosave } from './project/storage';
import { Panel } from './ui/panel';
import { CleanHint, PreloadOverlay, Welcome, Playbar, Toast, Toolbar } from './ui/controls';
import { isTypingTarget } from './ui/dom';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const app = new App($('stage'), $('area'), $('map'));
new Panel(app, $('panel'));
new Toolbar(app, $('toolbar'));
new Playbar(app, $('playbar'));
new Toast($('toast'), app);
new CleanHint($('clean-hint'), app);
new PreloadOverlay($('preload'), app);
new Welcome($('welcome'));

const saved = loadAutosave();
if (saved && saved.stops.length > 0) {
  app.loadProject(saved);
} else if (saved) {
  app.project.settings = saved.settings;
  app.project.name = saved.name;
  app.commit('settings');
  app.emitLoad();
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      app.toggle();
      break;
    case 'h':
    case 'H':
      app.setClean(!app.clean);
      break;
    case 'r':
    case 'R':
      app.restart();
      break;
    case 'Escape':
      if (app.preloading) app.cancelPreload();
      else if (app.clean) app.setClean(false);
      break;
  }
});
// Stop Space from "clicking" whichever button last had focus.
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && !isTypingTarget(e.target)) e.preventDefault();
});
