# Integration boundary — from simulation to plant data

This release runs entirely in the browser on simulated data. **No PLC, SCADA, MES, ERP, WMS, telematics,
camera, vision system or language model is connected**, and the product never writes to or controls
equipment. Every surface says what is simulated; "Live" appears only for a camera stream a user configured
that is actually playing.

## Where real data plugs in

The simulation engine is the only data source today (`DATA_SOURCES` in `src/model/plant.ts`, status
`simulated`). All other sources are declared with status `disconnected` and the protocol they are expected
to use. Feed freshness is modelled per asset (`s.feeds`): `simulated`, `live`, `stale`, `disconnected`,
`unavailable`; the *Data feed loss* scenario shows what a stale PLC link looks like (counter inactivity event,
asset state *Unknown — data stale*, signals frozen at their last value).

Every value the UI shows is derived from **signals** with stable ids (`SIGNALS` in `src/model/plant.ts`), e.g.

| Signal | Meaning | Feeds |
|---|---|---|
| `E-PRS2.state` | machine state enum (running, reduced, starved, blocked, down, planned) | availability, downtime, events |
| `E-PRS2.count_total` | units produced | performance, quality, output, counter-inactivity rule |
| `E-PRS2.rate` | instantaneous rate | performance, below-rate rule |
| `E-PRS2.alarm` | alarm / stop reason code | downtime reasons, fault vs stop |
| `CV-PACK.run_state`, `CV-PACK.speed`, `CV-PACK.tile_count` | conveyor run state, belt speed, photo-eye count | conveyor stoppage, stage input |
| `I-VIS.count_inspected`, `I-VIS.count_rejected` | inspection counters | quality, defect rules |
| `C-BM2.vibration`, `.temperature`, `.motor_current` | condition monitoring | machine health, condition events |
| `A-GATE.gate_event`, `K-DOCK.dock_occupancy` | gate and dock events | turnaround, dock rules |

A future adapter replaces the simulation for a subset of signals and produces the same records the engine
produces today (`DowntimeEvent`, minute log, `HourBucket` accounting, `QualityInspection`, `GateEvent`,
`DockEvent`, `Vehicle` legs) with `source` set to the real source. The event engine (`src/sim/events.ts`), the
metrics layer, the reports and the UI do not change. Counting points per stage are configured in
`MONITORED_STAGES`; quantities without a counting point are shown as *not measured*.

| Source | Protocol | Provides |
|---|---|---|
| Industrial gateway → line PLCs | OPC UA subscriptions (read-only) | state, counters, alarms per machine and conveyor |
| Kiln / dryer SCADA historian | OPC UA HDA or historian REST | firing curve, burner states, temperatures |
| Utilities IoT gateway | MQTT Sparkplug B | air, power, gas, water |
| MES | REST / ISA-95 B2MML | orders, batches, shift targets |
| ERP | REST / OData | dispatch orders, expected arrivals, prices / margins for loss estimates |
| WMS | REST | pallet locations, put-away and picking tasks |
| Gate system / telematics / indoor positioning | REST webhooks, UWB / RTLS | gate in/out, vehicle positions (precise), proximity |
| Vision system | vendor SDK / REST | per-tile classification, box, confidence, model version, images |

## Cameras

Each camera position (`CAMERAS` in `src/model/plant.ts`) has a **simulated feed rendered from the digital twin**,
burnt-in labelled *SIMULATED VIEW*. A real stream can be configured per camera in *Assets & Data → Camera
sources*; it is used only if the browser can play it:

- Browsers cannot open **RTSP / ONVIF** streams. Use a gateway that restreams to **WebRTC (WHEP), HLS or MJPEG**
  (e.g. MediaMTX, go2rtc, the VMS vendor's web gateway) on an HTTPS origin the app can reach.
- Event snapshots from a real stream need the gateway to allow **CORS**; otherwise the browser blocks reading the
  frame and the evidence says so.
- Video segments linked to events need an **NVR / VMS** integration (segment URLs by camera and time); not part
  of this release — reports show *Video segment: not available*.

## Vision inference

Inspection records carry a class, a defect box and a confidence produced by a **deterministic simulation**
(labelled *SIM-CV v0 (simulated)*). A real integration supplies the same `QualityInspection` fields plus the
model id / version and the image references; the rules, events, reports and OEE quality figures use them as is.

## Copilot

The copilot is deterministic diagnostic logic over the shared state (`src/intel/copilot.ts`). An LLM can be
added behind the same `ask(state, question, context)` interface, grounded in the structured answer data
(facts, events, report model) and constrained not to invent readings or claim connections.

## What needs a backend

The browser-only build is enough for a deterministic demonstration. These require a backend service:

- **Live connectivity** — OPC UA / MQTT clients cannot run in a browser; a gateway service normalises signals to
  the ids above and streams them (WebSocket/SSE) to the UI.
- **Persistence** of events, evidence (images, signal snapshots), acknowledgements and resolution history beyond
  the in-memory session; file storage for images and PDFs.
- **Multiple users** sharing state, scenario logs and event ownership; authentication and roles.
- **Audit** of configuration changes (signal mappings, counting points, ideal cycle times, targets, rule
  thresholds, financial assumptions).

Safety principle: the integration is read-only. Scenario controls only ever change the simulation.
