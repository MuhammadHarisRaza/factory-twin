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
burnt-in labelled *SIMULATED VIEW*. A real stream can be configured per camera in the Factory Twin (select the
equipment → *Technical details* → *Cameras* → *Configure a stream*); it is used only if the browser can play it:

- Browsers cannot open **RTSP / ONVIF** streams. Use a gateway that restreams to **HLS** (only where the browser
  plays it natively), **MJPEG / JPEG** or **MP4 / WebM** over http(s) (e.g. MediaMTX, go2rtc, the VMS vendor's web
  gateway) on an origin the app can reach (https when the app is served over https). **WebRTC / WHEP** needs the
  gateway's own player and is **not played by this release** — a WHEP endpoint configured here ends in a
  connection error.
- Event snapshots from a real stream need the gateway to allow **CORS** (`Access-Control-Allow-Origin` for this
  page). Without it the stream may still play, but the browser does not let the app read its frames: the event
  evidence then falls back to the labelled digital-twin render (provenance *Rendered from the digital twin
  (simulated camera view)*), and the evidence does not record that the stream was blocked. A manual snapshot
  from the feed reports the cross-origin block. Without CORS the app also cannot check an MJPEG / JPEG stream's pixels for new frames, so
  it is not shown as *Live* unless freshness can be confirmed another way.
- Video segments linked to events need an **NVR / VMS** integration (segment URLs by camera and time); not part
  of this release — reports show *Video segment: not available*.

## Reference videos and client recordings

The contextual videos (`src/video/registry.ts`) are not cameras of this demo. Public reference footage is played in the
provider's own embedded player (YouTube, privacy-enhanced domain) or streamed from the provider (Pexels), loaded only
once its player is on screen, where it starts by itself muted and looping (no sound unless the viewer starts it;
reduced motion, data saving or a browser that refuses autoplay get the poster with a play button instead), and
labelled as reference material. Three camera recordings provided by the client
(a tile-counting camera at a kiln roller line, a counting camera over the packaging line, a site-entrance camera with
vehicle detection) are served from `public/videos/` and lead the kiln, packaging and yard topics. They are labelled
*Recorded camera footage* with the camera and time shown in the recording, say that they are recordings, not live feeds
(on the workspace pages under the player; in the Factory Twin panel, which shows no badge on the picture, in the
source button's tooltip and label and in its source details) and that their boxes and counts come from the system
that recorded them, not from this demo's simulation. None of these videos is used as evidence of an event. A real
integration adds `sourceType: 'connected'` entries backed by an NVR / VMS (recorded segments by camera and time)
through a gateway; RTSP cannot be played by a browser directly.

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
  the in-memory session; file storage for images and PDFs. In this release snapshot images live only in browser
  memory (`src/twin/bridge.ts`, keyed by evidence id): the store is cleared on Reset Demo, capped at
  `MAX_IMAGE_CHARS` (≈ 48 MB, oldest dropped first), and `retainImagesFor(sim.evidence)` releases the images of
  evidence the engine has pruned from its eight-day history. A view whose image is gone says it was not kept.
- **Multiple users** sharing state, scenario logs and event ownership; authentication and roles.
- **Audit** of configuration changes (signal mappings, counting points, ideal cycle times, targets, rule
  thresholds, financial assumptions).

Safety principle: the integration is read-only. Scenario controls only ever change the simulation.
