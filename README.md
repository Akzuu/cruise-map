# Boat route map

A localhost tool for making an animated route map for a video. Place the stops of a trip, shape the route around land, and a boat sails from stop to stop leaving a dashed trail. Screen-record it in clean mode and drop it into the edit.

```
pnpm install
pnpm dev          # http://localhost:5173
```

Node 20 or newer. Other scripts: `pnpm build`, `pnpm test`, `pnpm typecheck`.

## Making a map

1. **Edit route** mode, **Add stops**: click the map in trip order. Or type coordinates in the panel and press Enter. Decimal (`60.1699, 24.9384`), decimal comma (`60,1699 24,9384`), degrees and minutes (`60°10.2′N 24°56.3′E`) and degrees/minutes/seconds all work.
2. **Bend route** (toolbar): click near a leg to add a bend point. The boat follows a smooth curve through every bend, so drop a few along coastlines to keep it off the land. Drag a point to reshape, double-click to remove, or **Straighten** a leg in the stop list.
3. Click a stop in the list to name it and set its pause, zoom and whether its card shows.
4. **Preview** and scrub. Adjust timing, camera and look in the panel sections.
5. Press **H** to hide everything, **Space** to play, and record the window. **R** restarts, **Esc** brings the interface back.

Every leg takes the same time by default (so the boat moves faster on long legs). Set a time on any single leg in the stop list. Stops and legs left empty use the project defaults.

## Recording tips

- Pick a **Frame shape** (16:9, 9:16, 1:1…) to letterbox the stage to the shape of your video.
- Camera zooms, label sizes, boat size and trail width are all defined for a 1080 px stage and scale with the window. A small preview window frames the map exactly like a full-size recording, only smaller.
- For the sharpest result, record the browser at the video's resolution (1920×1080, or 1080×1920 for vertical).
- Satellite, Ocean and Dark styles keep the trail readable at sea. Try white or yellow trail colours on those.

## Maps

Works without any key: CARTO (Voyager, Light, Dark), OpenStreetMap, Esri Satellite, Esri Ocean, plus an optional OpenSeaMap nautical overlay. If you have a MapTiler key, paste it under **Map** to unlock four MapTiler styles. The key is stored in this browser only, never in project files. You can also put `VITE_MAPTILER_KEY=...` in a `.env.local` file.

These tile services have their own terms of use. Keep the map credit on (it is on by default) and check the terms before publishing commercially.

## Projects

**Save** downloads `<name>.route.json`; **Open** loads one. The project also autosaves in this browser and comes back on reload. The file holds the stops, the bend points of each leg and every setting, so you can reuse a look for the next trip by opening an old project, clearing the stops and adding new ones.

```jsonc
{
  "version": 1,
  "name": "Untitled route",
  "settings": { "legDurationSec": 6, "style": "osm", "trail": {…}, "boat": {…}, "camera": {…}, … },
  "stops": [{ "id": "…", "name": "Helsinki", "lngLat": [24.94, 60.17], "pauseSec": null, "popup": true, "zoom": null }],
  "legs":  [{ "from": "<stop id>", "to": "<stop id>", "waypoints": [[24.5, 59.9]], "durationSec": null }]
}
```

`null` means "use the project default".

## How it works

| Folder | Purpose |
| --- | --- |
| `src/geo` | Web Mercator maths, centripetal Catmull–Rom spline, coordinate parsing and formatting |
| `src/route` | Route model (stops, legs, bends), curve sampling, hit-testing for the bend tool |
| `src/playback` | Timeline (intro, pauses, legs, outro) and camera, both pure functions of time |
| `src/map` | Tile styles, trail layers, boat icons |
| `src/ui` | Side panel, toolbar, playback bar |
| `src/app.ts` | Ties it together: map, markers, playback loop |

Playback is a pure function of time: the same time always gives the same boat position, camera and trail, which is why scrubbing works and the result is repeatable. Each frame sets the camera and redraws the map synchronously so the boat, labels and tiles stay locked together.

## Limits

- Routes that cross the antimeridian (180° longitude) are not supported.
- The boat follows your bend points; it does not find sea routes on its own.
- Recording is by screen capture. There is no built-in video export.
