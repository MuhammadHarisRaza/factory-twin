# wAI Manufacturing Digital Twin — architecture

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
| All derived metrics (line/machine/stage, Pareto, bottleneck, trends, shifts, quality, fleet, energy, impact vs baseline, on-target rule) | `src/sim/metrics.ts` |
| Energy model (electricity + gas per consumer, expected vs actual, tariffs) | `src/sim/energy.ts` |
| Condition monitoring (simulated vibration / temperature / current, degradation, maintenance, rule-based assessment) | `src/sim/health.ts` |
| Live store, demo clock, baseline twin | `src/sim/store.ts` |
| **Event engine**: detection rules, dedupe / reopen, lifecycle, evidence, accumulated impact | `src/sim/events.ts` |
| Event report model (in-app report, PDF and copilot all render it) and per-event impact | `src/intel/report.ts` |
| Financial assumptions and estimate helpers | `src/sim/finance.ts` |
| Twin renderer bridge (camera views, snapshot image store), inspection-image rasteriser | `src/twin/` |
| Rule-based insights, recommendations, next actions | `src/intel/insights.ts` |
| Rule-based copilot (intent → answer from the state) | `src/intel/copilot.ts` |
| Simulated signal values (Assets & Data) | `src/sim/signals.ts` |
| Tests | `src/sim/__tests__/` |
| App shell, navigation, scenario drawer | `src/app/` |
| Design system (tokens, components) | `src/styles.css`, `src/ui/kit/` |
| Factory Twin overlays (KPI chips, search, line strip, timeline, live lists, inspector tabs) | `src/ui/`, `src/ui/twin/` |
| Copilot panel (Command Center + global drawer) | `src/ui/copilot/`, `src/app/CopilotDrawer.tsx` |
| 3D scene | `src/scene/` (vehicles: `SimVehicles.tsx`; selection: `Selectable.tsx`; status beacons, bottleneck, health/energy pins, inspection markers, product flow, vehicle route: `src/scene/status/`) |
| Workspaces (each with a pure `derive.ts` + tests where it computes anything) | `src/pages/` (`production/`, `quality/`, `health/`, `energy/`, `command/`, `scenarios/`, `fleet/`, `assets/`) |

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

Displayed OEE is rounded to 0.1 % from the unrounded components; when the rounded A, P and Q do not multiply
to the shown OEE, Production & OEE marks it with ≈ and states the product. This is a simplified demonstration
of OEE, explained on that page with the live inputs.

**On target** (`targetStatus` in metrics.ts) is one rule everywhere: ≥ 100 % ahead, ≥ 97 % on track, ≥ 90 %
behind, below that well behind. The plan is 88 % of the kiln's design rate (1,100 good tiles/h).

## Bottleneck

`bottleneck(s)` traces the constraint from the kiln (the designed constraint) over the last 2 h: if the kiln
was starved for more than 5 % of the window, walk upstream past every stage that was itself starved — the
first stage that was not is what the line is waiting for; if the kiln was blocked, walk downstream the same
way; otherwise the kiln is the constraint. Upstream stages carry an 8–15 % capacity surplus and a 700-tile
kiln infeed buffer, so at baseline the kiln is the constraint ~85 % of the time and short stops elsewhere
show up as brief, explainable shifts.

## Intelligence layer (rule-based)

- **Baseline twin**: the store keeps a second `SimState` built from the same seed without scenarios and
  advances it in lockstep. Because the engine is deterministic, `impactVsBaseline` is exactly "what would
  have happened" — output, OEE, downtime, reject rate, energy cost per good m².
- **Machine health** (`src/sim/health.ts`): degradation episodes drive simulated signals; the product only
  "knows" what the signals show — `assess()` compares observed vibration with the value expected for the
  current load, extrapolates the 3-h trend to the alarm/trip limits (ISO 10816-style zones) and checks a
  load-corrected temperature. No trained model and no physical sensor.
- **Energy** (`src/sim/energy.ts`): each consumer's expected electricity/gas follows its load; actual = expected
  × scenario anomaly × small noise. Tariffs and emission factors are editable assumptions.
- **Insights** (`src/intel/insights.ts`): deterministic rules over the state (stoppages, health, quality,
  energy, buffer time-to-empty, bottleneck, target gap, logistics, shift comparison), each with evidence,
  impact, recommendation and links into the twin / workspaces.
- **Copilot** (`src/intel/copilot.ts`): keyword intent matching → an answer composed from the same metrics and
  insights, with facts, links and follow-ups. No language model is connected; the UI says so.
- **Vision station**: inspection records carry an illustrative defect box and confidence; frames are drawn
  procedurally (SVG) from the record — no images, no vision model.

## Events, evidence and reports (shared by the four use cases)

One record per event (`OpEvent`, `src/model/types.ts`) for production, conveyors, OEE, quality, vehicles, energy
and data feeds. Detection rules run inside the deterministic simulation step (`stepEvents`), so the same seed
and scenario log always yield the same events; ~400 events are already in the 7-day pre-rolled history.

- **Rules** (`EVENT_RULE_DEFS`, thresholds in `s.rules`, editable): unexpected stop / fault (alarm code decides),
  conveyor stoppage, running below rate *at its own pace*, starvation / blockage (only for the kiln, or when a
  stopped / slowed neighbour explains it — normal line balancing is not an event), counter inactivity (stale feed),
  abnormal condition signals, input / output imbalance, reject rate, defect count, repeated defect,
  deterioration vs baseline, critical defect review, truck waiting, dock overstay, yard congestion, turnaround,
  restricted-zone entry (trajectory vs geofence), energy deviation. Proximity and route deviation are listed as
  unavailable (no sensing).
- **Lifecycle**: Detected → Active → Acknowledged → Investigating → Resolved. A condition that clears before
  anyone acknowledged it auto-resolves; acknowledged / investigating events wait for the owner. Repeated signals
  update the open event (dedupe key); a condition returning within 10 min reopens it. Events are never deleted on
  recovery; recovery time and final duration are recorded.
- **Observed vs inferred**: `facts` come from signals and records; `causes` carry a confidence (confirmed only for
  directly observed facts or scenario inputs; likely / possible for inferences such as "starved because CV-PACK
  stopped"). Consequence events link to their root (`consequenceOf`).
- **Evidence** (`s.evidence`, by event id): state transitions and per-minute counter series frozen from the minute
  log, condition-signal series, inspection frames (illustrations of simulated records), vehicle timelines, metric
  snapshots, and camera snapshots rendered from the digital twin (or grabbed from a configured live stream).
  Unavailable evidence is recorded with its reason, never fabricated.
- **Impact** is accumulated minute by minute while the condition is active: asset-level loss vs typical rate, and
  the minutes / tiles the kiln (line constraint) was held up *because of this event* — the only loss that costs
  line output. Consequence events report their loss under the root event, so totals never double count.
- **Report** (`buildEventReport`) is the single model for the in-app report, the PDF export and the copilot's
  event investigation: summary, asset, detection, visual evidence, signals, context, impact, cost estimate with
  assumptions, diagnosis (facts / causes / uncertainty), recommendations, resolution history, provenance.

## Conveyors, cameras, feeds

Seven conveyors (`CONVEYORS`) are operational assets: a stopped conveyor cuts the transfer it carries (no input
for the stages it feeds, no discharge for the ones feeding it), so starvation and blocking follow through the
buffers. Ten camera positions (`CAMERAS`) cover the plant; each renders a simulated view from the twin.
Per-asset data-feed health (`s.feeds`) drives *Unknown — data stale* states and frozen signal values.

See `INTEGRATION.md` for the path to real data.
