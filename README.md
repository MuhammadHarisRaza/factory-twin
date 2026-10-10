# wAI Manufacturing Digital Twin

**AI-Powered Operational Intelligence** — an executive demonstration of a manufacturing digital twin, built
around an interactive 3D model of a representative ceramic tile plant (reference context: Ghani Ceramics —
the layout, equipment and figures are illustrative and do not reproduce any real plant).

**This is a simulation-backed demonstration.** Every operational value, event, inspection frame, sensor
signal and vehicle movement comes from a deterministic in-browser simulation. No PLC, SCADA, camera, sensor,
GPS, meter or language model is connected; the "AI" insights, the copilot, machine-health detection and the
vision classifications are rule-based and labelled as such in the interface.

The story it tells: physical factory → industrial data → digital twin → AI intelligence → operational
decisions → measurable business outcomes.

## Workspaces

| Workspace | What it shows |
|---|---|
| **Factory Twin** | Interactive 3D plant (12 zones, 50 equipment items): four-colour machine status beacons, bottleneck highlight, health and energy pins, inspection points, animated product flow scaled to live throughput, trucks and forklifts with route lines. Overlays: KPI chips (OEE, output vs target, downtime, defect rate, energy, trucks), global search (`/`), production-line status strip, shift timeline with event markers, tabbed live lists (alerts / machines / vehicles), site plan, machine inspector with Overview / Health / Events / Recommendations tabs, camera views incl. *Machine health* and *Bottleneck*. |
| **Production & OEE** | Actual vs target, OEE with A / P / Q, downtime, defect rate, energy per m²; planned vs actual cumulative output with end-of-shift projection; "How OEE is calculated" with the live inputs; loss waterfall, downtime Pareto, losses by machine, bottleneck trace, shifts, trends, events. |
| **Quality Intelligence** | Vision inspection station (illustrative frames with defect bounding boxes, classification, confidence, pass/reject, batch and station links), defect categories and trends, inspection stations, batches, inspection history. |
| **Machine Health** | Condition monitoring of ten assets (simulated vibration, temperature, motor current): health score and level, expected-vs-observed, trend and time-to-alarm/trip, findings, impact, recommended action, alarm and maintenance history, condition-based maintenance. |
| **Energy Intelligence** | Electricity and gas by consumer vs an energy model, anomaly detection with excess cost and monthly projection, specific energy (kWh per good m²), CO₂e, kiln idle burn, editable tariff assumptions. |
| **Command Center** | Plant situation strip, operational insights with evidence, recommended next actions, alerts, equipment needing attention, quality exceptions, losses, shift comparison, event timeline, and the copilot. |
| **Scenario Simulator** | Scenarios A–E plus logistics scenarios, live impact vs a no-scenario baseline run of the same seed, scenario log, presenter guide, **Reset Demo**. |
| Fleet & Logistics · Assets & Data | Site map, truck visits, docks, forklifts, geofences · equipment registry, signal mappings, data-source status (all *simulated*), simulation configuration. |

The header shows **Demo · simulated data**, the plant clock (pause, 1×–300×), the **Copilot** and the
**Scenarios** drawer on every workspace.

### Demo scenarios

| | Scenario | What happens (all workspaces react to the same state) |
|---|---|---|
| A | Production bottleneck | A stage loses capacity; its downstream buffers drain, the kiln starves, output and OEE fall; the bottleneck trace moves to that stage. |
| B | Machine breakdown | Unplanned stop with a downtime event; the 3D machine turns red, downstream stages starve, availability/OEE/output drop, the Command Center raises it as the top action. |
| C | Quality deterioration | Defects originating at a stage multiply; rejects, defect trend, quality rate and OEE reconcile; affected frames and batch are highlighted. |
| D | Energy anomaly | A consumer draws more than its model; deviation, excess cost (configurable tariffs) and CO₂ appear in Energy Intelligence and as an insight. |
| E | Developing machine fault | Vibration and temperature rise on an asset; the rule-based monitor detects it, predicts time to trip and recommends maintenance; scheduling condition-based maintenance prevents the breakdown, ignoring it lets it fail. |
| | Logistics | Truck arrival, yard congestion, prolonged dock stay, reduced production rate. |

**Reset Demo** (Scenario Simulator or the Scenarios drawer) rebuilds the seeded baseline: Mon 12 Oct 10:30
with seven days of history, no scenarios.

## Run

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulation, OEE, scenario workflow, vehicle and UI-derivation tests (vitest)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

## Factory Twin controls

Drag to orbit · right-drag to pan · scroll to zoom · click a machine or vehicle to inspect.
Keys (Factory Twin): `/` or `Ctrl+K` search · `1`–`0` camera views · `M` flow · `L` labels · `R` full factory · `F` fit.
Everywhere: `H` presentation mode · `Esc` back.

## Documentation

- `docs/ARCHITECTURE.md` — module map, the single operational state, simulation, OEE, intelligence layer.
- `docs/INTEGRATION.md` — signal ids, data sources and the boundary for future PLC/SCADA integration.
- `docs/PRESENTER.md` — a short presenter script for a live customer meeting.
