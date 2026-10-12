# wAI Manufacturing Digital Twin

**AI-Powered Operational Intelligence** — a demonstration of an industrial operations digital twin, built around an
interactive 3D model of a representative ceramic tile plant (reference context: Ghani Ceramics — the layout,
equipment and figures are illustrative and do not reproduce any real plant).

**This is a simulation-backed demonstration.** Every operational value, event, inspection frame, camera view,
sensor signal and vehicle movement comes from a deterministic in-browser simulation, and the product labels it
SIMULATED. No PLC, SCADA, camera, sensor, GPS, meter, vision model or language model is connected; camera views
are rendered from the twin and labelled as such, classifications and confidences are simulated, and the copilot
and detection rules are deterministic. Public **reference videos** illustrate each process step; they are labelled
as reference footage and are never presented as this plant, a live feed or evidence of an event. Three **camera
recordings provided by the client** (kiln, packaging line, site entrance) appear first for those topics, labelled as
recordings — not live feeds, and their on-screen boxes and counts are not linked to the simulation. A real camera
stream can be configured per camera; it is shown as *Live* only while it plays.

## Seven workspaces on one operational state

The product answers five questions — *what is happening, where, why, what is the impact, what next* — and links
Factory → Stage → Equipment → State → Event → Impact → Action → Evidence.

| Workspace | Purpose |
|---|---|
| **Overview** | The command view: a data-driven summary sentence, five KPIs (good output, target attainment, line OEE, first-pass quality, issues requiring attention), the live 3D factory as the centrepiece (zone select, alert filter, whole factory, focus, selection card), the production flow strip synchronised with the model, and the 3–5 issues requiring attention with impact and next step. |
| **Factory Twin** | The approved 3D plant — 12 zones, 55 assets incl. 7 conveyors. Selecting equipment highlights it and opens its workspace: status, contextual reference video, 3–5 stage-specific KPIs (parameters the model lacks are labelled *not modelled*), condition, recent events, impact, next steps and collapsed technical details (signals, data source, cameras and stream configuration). Stage highlight, alert filter, search, line strip, timeline, presentation mode. |
| **Production** | *Plan & flow*: target vs actual, stage flow with the constraint and its evidence, output trend, the top three losses quantified, key events; stage views (`#/production/<stage>`). *OEE & losses*: A × P × Q with plain-language definitions, the ten integrity checks, the count reconciliation (fired → sorted → good → packed → palletised), top OEE losses. *Analysis*: equipment OEE drill-down, capacity waterfall, Pareto, shift comparison, financial assumptions. |
| **Quality & Defects** | Evidence-led investigation: defect events and records, the inspection image (simulated, with simulated confidence only for simulated inference records), category, severity, station and stage, batch, before/after rates, recommended action, hypotheses marked as such, inspection reference footage. |
| **Fleet & Movement** | The site layout with simulated positions, gate, holding, queue and docks; four KPIs; vehicle detail (location kind, movement, trip, dock, dwell as time at the current stop); delay review that separates active delays from incomplete records; logs and analytics in secondary tabs. |
| **Events & Reports** | One event engine for every use case: filters, event detail (what happened → asset & stage → evidence → KPIs → impact → investigation → links → history), lifecycle; report builder for shift production, OEE & losses, quality & defects, vehicle movement & delays and incident investigations, each with an in-app preview and the **same model exported as PDF**; detection rules. |
| **Copilot** | Rule-based answers from the shared state, with the same numbers as the KPI cards, split into confirmed facts, simulated events, inferred explanation, unverified hypotheses and recommended actions; says when something cannot be established. Also a drawer on every workspace. |

Energy, assets/data and the earlier dashboards are no longer separate modules: equipment information lives in the
Factory Twin, data provenance in detail views. Old addresses (`#/monitoring/KILN`, `#/energy`, …) redirect.

### Demonstration scenarios (Scenarios drawer → Guided demos)

| | Scenario | What works end to end |
|---|---|---|
| A | Conveyor stoppage | State change in 3D → event with state transition, counters and twin snapshot → consequences linked → impact (buffers absorbing or kiln held up) → report + PDF → copilot explanation. |
| B | OEE loss | Reduced rate or downtime → OEE recalculates → loss at the constraint explained and valued (assumptions shown) → contributing machine and event. |
| C | Defect deterioration | Inspection records change → rejects, quality rate and OEE reconcile → quality events with frames → report. |
| D | Truck delay | Truck arrives, docks, documentation hold added → dock event with visit timeline → turnaround updates → report. |
| E | Reset | Rebuilds the seeded baseline (Mon 12 Oct 10:30, 7 days of history) in the background. |

## Run

Requires Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # simulation, events, KPIs, OEE, reports/PDF, copilot, video and UI tests (vitest)
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

## Factory Twin controls

Drag to orbit · right-drag to pan · scroll to zoom · click a machine, conveyor or vehicle to open its workspace.
Keys (Factory Twin): `/` or `Ctrl+K` search · `1`–`0` camera views · `A` alert filter · `M` flow · `L` labels ·
`R` whole factory · `F` fit · `H` presentation mode (a "Demo · simulated data" mark stays visible) · `Esc` back.

## Documentation

- `docs/ARCHITECTURE.md` — module map, the single operational state, routing, KPIs, simulation, OEE, events / evidence / reports, videos.
- `docs/INTEGRATION.md` — signals, data sources, cameras (RTSP needs a gateway), reference videos, vision, copilot, what needs a backend.
- `docs/PRESENTER.md` — a short presenter script for a live customer meeting.
