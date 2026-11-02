# Boat route map: handoff notes

Localhost tool for a video creator. Given ordered stops (click map or type coordinates), it animates a boat along a smooth route with a dashed trail. The creator screen-records it in "clean mode". Built from a live-aboard trip, meant to be reused for future trips.

Stack: Vite + TypeScript + MapLibre GL, pnpm, no UI framework (vanilla DOM). Versions installed are recent (maplibre-gl 6.x, TypeScript 7, Vite 8, Vitest 5). maplibre-gl 6 has no default export: use `import * as maplibregl`.

Commands: `pnpm dev`, `pnpm test`, `pnpm typecheck`, `pnpm build`.

## Status

- 60 tests pass (`tests/core.test.ts` pure logic, `tests/app.test.ts` App+Panel+controls against a mocked maplibre in happy-dom). Typecheck and build are clean.
- **Never run in a real browser.** The sandbox had no browser. Everything WebGL/visual is unverified. Check these first:
  1. `map.redraw()` after `jumpTo` each frame keeps DOM markers (boat, stops, labels) locked to the tiles. If markers jitter, this is the place to look (`App.renderAt`).
  2. Dashed trail looks right: `line-dasharray` restarts per leg (done legs are one MultiLineString, live leg is its own source). Check no visible dash "pop" when a leg completes.
  3. Switching map style re-installs layers on `style.load` and the trail survives.
  4. Marker dragging (stops and bend handles), double-click to delete a bend, Bend-route click targeting.
  5. Tile URLs and MapTiler style ids (`streets-v2`, `ocean`, `hybrid`, `dataviz-dark`) were written from memory, not tested. CARTO uses `@2x` tiles with `tileSize: 256`.
  6. Space/H/R/Esc shortcuts in `main.ts`, and clean mode layout.

## Decisions from the requirements discussion

- Output is screen recording (no video export). Whole video frame is the map. Frame shape is configurable (letterboxed), default fit-window.
- Stops are entered by map click or coordinates (decimal, decimal comma, deg-min, DMS). No geocoding.
- Route: stops plus per-leg waypoints ("bends"). Smooth curve through bends (centripetal Catmull-Rom). No automatic sea routing; the user adds bends to stay off land.
- **Timing: every leg takes equal time by default** (boat speed varies with leg length), with per-leg override. Per-stop pause override. Easing option (even pace / ease in-out).
- Camera: global defaults (zoom in at stops, zoom out while sailing, follow boat, intro fly-in, outro zoom-out + hold), per-stop zoom override.
- Standard map layers, no pirate style. Dashed trail. Boat icons swappable, including a custom uploaded image. MapTiler key optional.
- Project save/load as JSON. pnpm. User is technical.

## Architecture

- `src/geo`: `mercator.ts` (world coords 0..1, headings), `spline.ts`, `coords.ts` (parse and format).
- `src/route`: `model.ts` (stops/legs, `syncLegs`, `hitTestRoute`), `path.ts` (sampled leg curve, `pointAtDistance`, `headingAtDistance`, `sliceTo`).
- `src/playback`: `timeline.ts` (segments: intro, pause, leg, outro; `computeFrame`), `camera.ts` (`cameraAt`). Both are pure functions of time `t`, which is why scrubbing works.
- `src/map`: `styles.ts`, `layers.ts` (route-preview, trail-done, trail-live), `icons.ts`.
- `src/ui`: `panel.ts`, `controls.ts` (Toolbar, Playbar, Toast), `dom.ts`.
- `src/app.ts`: `App` owns the map, markers, mode (edit/preview), playback loop, and `commit('structure' | 'settings' | 'geometry')` which re-derives paths, timeline and visuals.
- `src/project/storage.ts`: JSON parse with defaults merge, localStorage autosave, MapTiler key storage.

Key design choices:
- **Design zoom:** camera zoom is defined for a 1080 px shorter side. `App.applyCamera` adds `log2(scale)` with `scale = min(stageW, stageH) / 1080`. Labels, boat and trail width also scale by `--u`. This makes a small preview frame identical to a full-size recording.
- Leg `legs[]` is derived from `stops[]` by `syncLegs`; waypoints are keyed by from/to stop id and are dropped if the pair changes.
- Edit mode shows the full route preview and handles; preview mode shows only the sailed trail, with interaction disabled and the camera scripted.
- MapTiler key is deliberately kept out of project files.

## Project JSON (version 1)

`{ version, name, settings, stops[{id,name,lngLat,pauseSec|null,popup,zoom|null}], legs[{from,to,waypoints,durationSec|null}] }`. `null` means project default. Loading merges over defaults, so older files keep working.

## Known limits and ideas for next steps

- Antimeridian crossing unsupported. No sea routing. No built-in video/frame export.
- Fixed logical stage (for example always 1920x1080, CSS-scaled) would give pixel-identical output regardless of window; currently framing matches via design zoom but pixel density differs.
- Ideas: place-name search, frame-by-frame export (deterministic `renderAt(t)` makes this feasible), per-stop photo in the card, bearing-following camera, custom map style, undo/redo.
- Test gap: nothing exercises real WebGL, tiles, or pointer drag. If adding Playwright, point it at `pnpm dev`.