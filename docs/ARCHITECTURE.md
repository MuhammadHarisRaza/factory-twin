# wAI Manufacturing Intelligence — architecture

## Starting point (stage 1 inspection)

Before this release the repository was a single-purpose **3D factory twin** (React 19, TypeScript,
three.js 0.186, React Three Fiber 9, drei 10, Zustand 5, Vite 8):

- procedural 3D model of a representative ceramic tile plant: 12 zones (A–L), 50 equipment items with
  stable ids (`src/data/equipment.ts`), buildings, structure, conveyors, site;
- camera presets (10), zone navigation, minimap, equipment selection/inspection, layer toggles
  (roof, walls, structure, equipment, conveyors, labels, minimap), material-flow overlay, presentation mode;
- descriptive metadata only — no operational data, no simulation, no other workspaces.

Everything above is preserved; the product is built around it.

## Module map

| Concern | Location |
|---|---|
| Shared data model (entities) | `src/model/types.ts` |
| Plant configuration (line, stages, buffers, equipment ops, signals, reasons, stations, docks, geofences, data sources) | `src/model/plant.ts` |
| Plant time, shifts | `src/sim/time.ts` |
| Deterministic randomness | `src/sim/rng.ts` |
| Production / quality / downtime simulation, scenarios | `src/sim/engine.ts` |
| Vehicle simulation (trucks, forklifts, loader), gate/dock/geofence events | `src/sim/logistics.ts` |
| OEE calculations (validated, no clamping) | `src/sim/oee.ts` |
| All derived metrics (line/machine/stage, Pareto, bottleneck, trends, shifts, quality, fleet) | `src/sim/metrics.ts` |
| Live store + demo clock | `src/sim/store.ts` |
| Simulated signal values (Assets & Data) | `src/sim/signals.ts` |
| Tests | `src/sim/__tests__/` |
| App shell, navigation, scenario drawer | `src/app/` |
| Design system (tokens, components) | `src/styles.css`, `src/ui/kit/` |
| Factory Twin overlays | `src/ui/` |
| 3D scene | `src/scene/` (simulated vehicles: `SimVehicles.tsx`; status in `Selectable.tsx`) |
| Workspaces | `src/pages/` |

## One operational state

`useSim` (src/sim/store.ts) owns a single `SimState`. Every workspace — including the 3D scene — reads it
through `useSimValue(fn)` and the functions in `src/sim/metrics.ts`. Nothing keeps a separate copy of machine,
counter or vehicle state, so the twin, the tables, the charts and the KPIs cannot disagree.

- **Equipment identity**: the equipment id (e.g. `E-PRS2`) is the 3D `<Selectable>` id, the key of
  `OPS_BY_ID`, the prefix of every signal (`E-PRS2.count_total`) and the `equipmentId` on every event.
- **Navigation surface**: `openEquipment(id)`, `openStation(stationId)`, `openVehicle(id)` (src/app/store.ts)
  switch to the twin and select/frame the object; the twin links back to the workspaces.

## Simulation

- **Clock**: integer plant minutes from Mon 5 Oct 2026 06:00. A fresh session pre-rolls 7 days of history
  (≈0.6 s) and starts on Mon 12 Oct 10:30. Demo speeds 1× / 10× / 60× / 300×; pause and reset in the header.
- **Production**: ten stages from body preparation to palletising, linked by finite WIP buffers (slip tanks,
  powder silos, buffer racks…). Each minute a stage makes min(capacity, input available, output space), so
  starvation/blocking propagate with realistic delays. Ideal rates per machine; bounded performance noise.
- **Downtime**: seeded failure model per machine (MTBF, bounded repair times, weighted reasons), planned cleaning
  each shift, product changeovers; starved/blocked spells ≥ 3 min become process-interaction events. Each event
  records lost output and the minutes the line constraint was held up while it was open.
- **Quality**: rejects detected at the gauge and vision tunnel by defect category, attributed back to the stage
  where the defect originates; illustrative inspection records (simulated) and hourly QC lab samples.
- **Logistics**: outbound trucks (gate → holding → dock → loading by forklift → paperwork → gate) and inbound
  tippers (gate → weighbridge → raw-material shed → gate) on fixed routes along roads; forklifts put pallets away
  and load trailers; geofences detect restricted-zone entries. Pallet stock links production to dispatch.
- **Determinism**: every random draw comes from a per-entity seeded stream; scenarios are timestamped inputs.
  Reset rebuilds the baseline from the seed.
- **Provenance**: every record carries a timestamp and `source: 'simulation' | 'scenario'`; the UI labels them.

## OEE definitions

- Availability = operating time / planned production time (planned stops are excluded from planned time;
  unplanned stops, starvation and blocking are availability losses).
- Performance = ideal cycle time × total count / operating time.
- Quality = good count / total count (machine level: rejects attributed to the machine's stage).
- **Line OEE** is measured at the line constraint (H-KILN: its availability and performance) × first-pass
  quality at sorting. Reporting periods start on hour boundaries; invalid inputs (e.g. operating > planned,
  performance > 100 %) are flagged with an explanation instead of clamped, and missing values are shown as
  unavailable rather than zero.

See `INTEGRATION.md` for the path to real data.
