# Integration boundary — from simulation to plant data

This release runs entirely in the browser on simulated data. **No PLC, SCADA, MES, ERP, WMS, telematics,
camera or vision system is connected**, and the product never writes to or controls equipment.

## Where real data plugs in

The simulation engine is the only data source today (`DATA_SOURCES` in `src/model/plant.ts`, status
`simulated`). All other sources are declared with status `disconnected` and the protocol they are expected
to use. The UI already distinguishes `simulated`, `configured`, `disconnected` and `connected`.

Every value the UI shows is derived from **signals** with stable ids (`SIGNALS` in `src/model/plant.ts`), e.g.

| Signal | Meaning | Feeds |
|---|---|---|
| `E-PRS2.state` | machine state enum (running, reduced, starved, blocked, down, planned) | availability, downtime |
| `E-PRS2.count_total` | units produced | performance, quality, output |
| `E-PRS2.rate` | instantaneous rate | performance |
| `E-PRS2.alarm` | alarm / stop reason code | downtime reasons |
| `I-VIS.count_inspected`, `I-VIS.count_rejected` | inspection counters | quality |
| `A-GATE.gate_event`, `K-DOCK.dock_occupancy` | gate and dock events | turnaround, dock utilisation |

A future adapter replaces the simulation for a subset of signals and produces the same records the engine
produces today (`DowntimeEvent`, `HourBucket` minute accounting, `QualityInspection`, `GateEvent`,
`DockEvent`, `Vehicle` legs) with `source` set to the real source. The metrics layer (`src/sim/metrics.ts`) and
the UI do not change.

Suggested adapters:

| Source | Protocol | Provides |
|---|---|---|
| Industrial gateway → line PLCs | OPC UA subscriptions (read-only) | state, counters, alarms per process machine |
| Kiln / dryer SCADA historian | OPC UA HDA or historian REST | firing curve, burner states, temperatures |
| Utilities IoT gateway | MQTT Sparkplug B | air, power, gas, water |
| MES | REST / ISA-95 B2MML | orders, batches, shift targets |
| ERP | REST / OData | dispatch orders, expected arrivals |
| WMS | REST | pallet locations, put-away and picking tasks |
| Gate system / telematics | REST webhooks | gate in/out, vehicle zone positions |
| Vision system | vendor SDK / REST | defect classifications per inspected tile |

## What needs a backend

The browser-only build is enough for a deterministic demonstration. These require a backend service:

- **Live connectivity** — OPC UA / MQTT clients cannot run in a browser; a gateway service normalises signals to
  the ids above and streams them (WebSocket/SSE) to the UI.
- **Persistence and history** beyond the in-memory 7-day pre-roll (time-series store for minute buckets and
  events).
- **Multiple users** sharing state, scenario logs and acknowledgements; authentication and roles.
- **Audit** of configuration changes (signal mappings, ideal cycle times, targets).

Safety principle: the integration is read-only. Scenario controls only ever change the simulation.
