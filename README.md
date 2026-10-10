# wAI Manufacturing Digital Twin

**AI-Powered Operational Intelligence** — a demonstration of a manufacturing digital twin, built around an
interactive 3D model of a representative ceramic tile plant (reference context: Ghani Ceramics — the layout,
equipment and figures are illustrative and do not reproduce any real plant).

**This is a simulation-backed demonstration.** Every operational value, event, inspection frame, camera view,
sensor signal and vehicle movement comes from a deterministic in-browser simulation. No PLC, SCADA, camera,
sensor, GPS, meter, vision model or language model is connected; camera views are rendered from the twin and
labelled as such, classifications and confidences are simulated, and the copilot and detection rules are
deterministic. A real camera stream can be configured per camera; it is shown as *Live* only while it plays.

## Four connected use cases on one operational state

| Workspace | Use case |
|---|---|
| **Factory Twin** | The approved 3D plant — 12 zones, 55 assets incl. 7 conveyors — as the spatial interface: four-colour status beacons, stopped-conveyor markings, bottleneck, health / energy / inspection pins, animated product flow, trucks and forklifts with routes, event focus ring, KPI chips, search, line strip, shift timeline, live lists, inspector with Events / Health / Recommendations and a camera window. |
| **Production Monitoring** | Every configured stage (raw-material preparation → warehouse transfer): input, output, good, rejected, WIP at its counting points (or *not measured*), machine and conveyor states, signals, simulated camera feeds, active and historical events, losses, shift summary PDF. |
| **OEE & Loss Intelligence** | Factory / line / equipment levels; theoretical capacity → planned → actual → good waterfall; downtime, speed, quality, energy and logistics losses valued once at the constraint; editable financial assumptions; drill-down to contributing events and the 3D asset; what-if improvement estimates; baseline comparison. |
| **AI Defect Monitoring** | Inspection workflow (capture → simulated inference → classify & localise → associate → rule → store → counts & OEE → event), illustrative frames with defect boxes and simulated confidence, quality events, scrap / rework cost, root-cause hypotheses. |
| **Vehicle Monitoring** | Trucks through entry gate → check-in / weighbridge → holding → queue → dock → dispatch staging → exit; gate-to-dock, queue, loading and turnaround; forklifts by zone (simulated, zone level) with tasks, pickups / drop-offs and dwell; vehicle events; sensing that is *not available* listed as such. |
| **Events & Reports** | One event engine for all use cases: unified timeline, filters, lifecycle (acknowledge, assign, investigate, note, resolve), full report with evidence, impact, cost estimate, diagnosis (facts / suspected causes / uncertainty), provenance — and **PDF export of the same record**. |
| **Factory Copilot** | Rule-based answers from the shared state, split into observed facts, inferences and estimates, with links to assets, events and reports; event-specific investigation. Also available as a drawer on every workspace. |
| Command Center · Machine Health · Energy Intelligence · Scenario Simulator · Assets & Data | Situation overview and next actions; condition monitoring; energy vs model; demonstration scenarios A–E with Reset Demo; equipment registry, signals, data feeds, camera sources and event rules. |

### Demonstration scenarios (Scenario Simulator)

| | Scenario | What works end to end |
|---|---|---|
| A | Conveyor stoppage | State change in 3D → event with state transition, counters and twin snapshot → consequences (starvation / blockage) linked → impact (buffers absorbing or kiln held up) → report + PDF → copilot explanation. |
| B | OEE loss | Reduced rate or downtime → OEE recalculates → loss at the constraint explained and valued → contributing machine and event discoverable → improvement scenarios. |
| C | Defect deterioration | Inspection records change → rejects, quality rate and OEE reconcile → quality events with frames → report. |
| D | Truck delay | Truck arrives, docks, documentation hold added → dock event with visit timeline → turnaround updates → report. |
| E | Reset | Rebuilds the seeded baseline (Mon 12 Oct 10:30, 7 days of history) in the background; no orphaned events, counters at baseline. |

## Run

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulation, events, OEE, reports/PDF, copilot and UI-derivation tests (vitest)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

## Factory Twin controls

Drag to orbit · right-drag to pan · scroll to zoom · click a machine, conveyor or vehicle to inspect.
Keys (Factory Twin): `/` or `Ctrl+K` search · `1`–`0` camera views · `M` flow · `L` labels · `R` full factory · `F` fit.
`H` presentation mode (a "Demo · simulated data" mark stays visible) · `Esc` back.

## Documentation

- `docs/ARCHITECTURE.md` — module map, the single operational state, simulation, OEE, events / evidence / reports.
- `docs/INTEGRATION.md` — signals, data sources, cameras (RTSP needs a gateway), vision, copilot, what needs a backend.
- `docs/PRESENTER.md` — a short presenter script for a live customer meeting.
