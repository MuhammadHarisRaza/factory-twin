# wAI Manufacturing Intelligence

Manufacturing operations product built around an interactive 3D digital twin of a representative ceramic tile
plant (reference context: Ghani Ceramics — the layout, equipment and figures are illustrative and do not
reproduce any real plant).

**This is a simulation-backed demonstration.** Every operational value, event and vehicle movement comes from
a deterministic in-browser simulation. No PLC, SCADA, camera, GPS or other system is connected.

## Workspaces

| Workspace | What it does |
|---|---|
| **Factory Twin** | Interactive 3D plant: zones, equipment, live (simulated) machine status, trucks and forklifts, material flow, camera views, layers, minimap, presentation mode. |
| **Production & OEE** | Output vs target, line OEE (A × P × Q), loss waterfall, downtime Pareto and events, machine/stage table, bottleneck, shifts, trends. |
| **Quality Intelligence** | Inspection stations, inspected/accepted/rejected, defect categories and trends, simulated inspection records and batches. |
| **Fleet & Logistics** | Live site map, trucks on site, waiting/dock times, dock board, gate and dock events, forklifts, geofences, turnaround. |
| **Assets & Data** | Equipment registry, signals and metric mappings, data-source status, event history, simulation configuration. |

The header on every workspace shows the **Demo · simulated data** indicator, the simulated plant clock
(pause, speed 1×–300×) and the **Scenarios** drawer: machine stoppage, reduced rate, production bottleneck,
quality deterioration, truck arrival, yard congestion, prolonged dock stay, and reset to baseline.

## Run

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # OEE, simulation, scenario and vehicle tests (vitest)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

## Factory Twin controls

Drag to orbit · right-drag to pan · scroll to zoom · click a machine or vehicle to inspect.
Keys (Factory Twin): `1`–`0` camera views · `M` flow · `L` labels · `R` full factory · `F` fit.
Everywhere: `H` presentation mode · `Esc` back.

## Documentation

- `docs/ARCHITECTURE.md` — starting point, module map, data model, simulation and OEE definitions.
- `docs/INTEGRATION.md` — signal ids, data sources and the boundary for future PLC/SCADA integration.
