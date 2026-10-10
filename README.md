# wAI Ceramic Factory Twin

Interactive 3D model of a representative ceramic tile plant, built with React 19, React Three Fiber,
drei, three.js and Zustand. All geometry is procedural; there are no external model files.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

## Controls

Drag to orbit · right-drag to pan · scroll to zoom · click a machine to inspect.
Keys: `1`–`0` camera views · `M` flow mode · `H` hide UI · `R` reset · `F` fit · `L` labels · `Esc` back.

## Layout

```
src/
  data/            plant data: zones, equipment, camera views, roads, material-flow routes
  store.ts         app state (layers, selection, zone, camera requests)
  ui/              HTML overlay: top bar, zone panel, inspector, toolbar, minimap, loader
  scene/
    Scene.tsx      <Canvas>, lights, environment, camera rig, zone labels
    materials.ts   shared materials and procedural canvas textures
    primitives.tsx Box, Cyl, Pipe, Instances, Railing, Stair, Silo, Tank, Door…
    Selectable.tsx hit box, outline and name tag for each equipment item
    vehicles.tsx   trucks, forklifts, cars, wheel loader, PathMover animation
    Ground / Buildings / Structure / Site / Conveyors / FlowOverlay
    zones/         one file per process area (raw materials → warehouse)
```

To add a machine: add an entry to `src/data/equipment.ts`, then draw it inside a
`<Selectable id="...">` in the matching `src/scene/zones/*` file.
