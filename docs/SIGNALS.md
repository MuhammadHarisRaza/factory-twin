# Signal catalogue — what each machine could provide, and what this demo has

The catalogue (`src/model/catalog/`) lists, for every piece of equipment of the representative ceramic tile
plant, the signals a PLC, controller or connected system **could** provide (brief §4–§5), how likely each one
is to exist on a real machine, and what this demo actually has for it. It is documentation and a contract for
the UI and the rules. It is **not** a connection: no PLC, SCADA, historian, MES, QMS, WMS, telematics or
vision system is connected in this release, and no catalogue entry has the status *Connected*.

## Files

| File | Content |
|---|---|
| `types.ts` | Contract: `SignalDefinition`, `ProductionStageDef`, `AvailabilityClass`, `AvailabilityStatus`, `SignalCategory`, `SignalDataType`, `SourceSystem` and their labels |
| `process.ts` | Contract: the simulated process / setpoint / derived / command signals (`PROCESS_SIGNALS`) and the simulated conversion constants |
| `stages.ts` | The 12-stage registry: `STAGES_12`, `STAGE_BY_NO`, `stageOfEquipment`, `stageOfBuffer`, `SUPPORT_EQUIPMENT`, `STAGE9_EQUIPMENT_ID` |
| `signals.ts` | Builds `CATALOG` from the plant registry, `PROCESS_SIGNALS` and the documented entries |
| `stages/s01.ts` … `s12.ts` | Documented (not simulated) entries per stage; `stages/doc.ts` is their builder |
| `condition.ts` | Condition-monitoring limits (a mirror of `src/sim/health.ts` `HEALTH_ASSETS`, kept in step by a test) |
| `index.ts` | Public entry: `CATALOG`, `CATALOG_BY_ID`, `definitionOf`, `isSimulated`, `catalogFor`, `catalogForStage`, `orderSignals`, `CATEGORY_ORDER`, `coverage()` and re-exports |

Import from `src/model/catalog` (the index). `src/model/plant.ts` never imports the catalogue (the catalogue
imports the plant), and the catalogue never imports the simulation (`src/sim/*`).

## How the catalogue is built

`CATALOG` is built once, at import time, from three sources:

1. **The plant registry** (`SIGNALS` in `src/model/plant.ts`). Every id is kept (`<equipmentId>.<name>`) and
   gets a full definition: an equipment-specific description, category, data type, source system, class,
   status, update interval, engineering range and, for vibration / temperature, the condition limits. A
   registry signal the catalogue does not know yet is still included, with a generic description.
2. **The simulated process signals** (`PROCESS_SIGNALS` in `process.ts`): process values (PV) with their
   setpoints (SP), derived values (speeds, strokes, cycle time, mass flows, carton / pallet counters) and run
   commands. A PV carries `setpointSignalId`.
3. **Documented entries** of each stage (`stages/sNN.ts`): signals a real line would have but this demo does
   not simulate — batch / recipe / die / print-job / firing-curve ids, burner and fan states, level switches,
   jam sensors, residual moisture, coating weight, vision confidence, WMS inventory, barcode / RFID scans and
   so on. They have no value and no update interval, and `statusNote` says why.

If two sources define the same id, the process spec wins over the registry entry, and both win over a
documented entry. Because the catalogue reads `SIGNALS` when it loads, it follows registry changes (for example
if a placeholder signal is removed or a buffer gains a level signal).

## Availability class — how likely a real controller exposes it

| Class | Label | Meaning |
|---|---|---|
| `core` | Core candidate | Commonly useful and commonly exposed by the machine controller — still to be confirmed on the actual machine. |
| `conditional` | Conditional | Only when the controller programme, sensor, drive or connected system supports it (condition sensors, analysers, drive data, meters). |
| `external` | External integration | Normally from another system: MES, historian, SCADA, QMS / lab, WMS, barcode / RFID, CMMS, telematics or vision. |

The class is never a statement of connectivity.

## Availability status — what this demo has

| Status | Label | Meaning |
|---|---|---|
| `simulated` | Simulated | The demo simulation produces a value. Always labelled simulated, never "live". |
| `not-modelled` | Not modelled | The quantity is plausible for the stage, but the simulation has no model for it. No value is shown. |
| `unavailable` | Unavailable | Needs an instrument, calibration or integration that is not configured (e.g. an MES, a QMS, energy metering, a silo calibration). No value is shown. |
| `reference` | Reference | Static reference data (reserved). |
| `connected` | Connected | Reserved for a real, verified integration. **Never produced in this release.** |

Rules that follow from it:

- A missing value is `null` with a reason, never `0`. A *not-modelled* or *unavailable* entry is shown as such,
  not as a reading.
- The early process placeholders of the registry (`H-KILN.temp_firing`, `H-KILN.temp_preheat`,
  `D-TWR.temp_inlet`, `D-TWR.powder_moisture`, `F-DRY.temp_deck`, `A-COMP.header_pressure`,
  `A-WTR.tank_level`) have no physical model: they are *not modelled*, and their note names the simulated
  replacement where one exists (e.g. `H-KILN.zone3_temp_pv`, `D-TWR.inlet_temp_pv`, `F-DRY.zone1_temp_pv`).
- Energy signals (`energy_kwh`, `active_power`, `gas_flow`, and the documented fuel flows / drive power) are
  *unavailable*: energy metering is not part of this demo's data.
- Inspection counts of the optical tunnel are simulated records with source system *vision* — no computer
  vision runs. Vehicle zones are simulated positions reduced to a geofence, never GPS, RTLS or telematics.

## Other fields

- **Category** groups signals: state, command, production, process, setpoint, drive, material, condition,
  quality, alarm, recipe / batch, logistics, communication, energy. `catalogFor(id)` returns an equipment
  item's signals in that order, simulated entries first within a category, and every setpoint right after its
  process value.
- **Expected update interval**: 60 s for simulated scanned signals (one value per plant minute); `null` for
  event signals (alarm codes, gate events, vehicle zones, QC sample results) and for everything not simulated.
  Freshness (`src/calc/freshness.ts`) uses it: late at 2×, stale at 5× the interval; `null` = event-driven.
- **Counters** are `integer` with `counter: { rolloverAt: null, resetOn }`. The simulation does not roll over
  or reset its counters in normal running; real counters' rollover (2¹⁶ / 2³²) and reset behaviour are
  confirmed at integration, and the calculation library (`counterDelta`) handles resets and rollovers. A
  counter the demo does not produce (an energy meter, a documented counter) only says "confirmed at
  integration".
- **Buffers without equipment of their own** (`BUF-GLZ`, `BUF-KIN`, `BUF-KOUT`, `BUF-PACK`) have no level
  signal. Their occupancy is documented as *not modelled* on the conveyor that holds them:
  `CV-GLZ.transfer_buffer_level`, `CV-KIN.infeed_buffer_level`, `CV-SORT.outfeed_buffer_level` and
  `CV-PAL.transfer_buffer_level` (a test checks that every buffer is covered).
- **Limits**: process values carry warning / alarm bands around the nominal setpoint (from `process.ts`).
  Vibration and temperature carry the limits of the simulated condition model: warning at 80 % of the
  vibration alarm limit and 5 °C below the temperature alarm limit, alarm at the alarm limit, the trip limit in
  `metadata.tripLimit`. Motor current carries the rated current (`metadata.ratedCurrentA`), no invented limits.
- **`sourceTag`** is always `null`. The demo never invents PLC addresses or tags.

## Units and simulated conversions

The simulation counts slip and powder in **tile-equivalents**. The catalogue therefore gives the stage-1 and
stage-2 counters and rates the units `tile-eq` and `tile-eq/h` (the registry entry keeps its original unit in
`metadata.registryUnit`), and never `tiles` or `tiles/h`. Mass flows are separate, labelled simulated
conversions:

| Constant | Value | Used for |
|---|---|---|
| `KG_PER_M2` | 21 kg/m² | Dry pressed-body mass of a 60×60 cm porcelain tile (~9.5 mm) |
| `KG_PER_TILE` | `M2_PER_TILE` (0.36 m²) × 21 = 7.56 kg | Tile-equivalent → mass: `C-BMn.slip_flow`, `D-TWR.powder_flow` in t/h |
| `PRESS_CAVITIES` | 2 | Tiles per press stroke (`E-PRSn.strokes_per_min`, cycle time) |
| `TILES_PER_CARTON` | 6 | Carton counter `J-BOX.carton_count` |
| `TILES_PER_PALLET` | 240 (plant.ts) | Pallets from palletised tiles |

These are assumptions of the simulation, always disclosed with the figure — not plant data.

**Level is not mass.** `D-SILO.level` is a level in % of the silo buffer. The silo mass `D-SILO.powder_mass`
is *unavailable*: it needs a level-to-mass calibration (`LevelCalibration`, `massFromLevel` in
`src/calc/buffer.ts`) or load cells, and none is configured. Individual silo levels are not modelled (the
simulation holds one aggregate powder buffer).

## The twelve stages

| No | Stage | Equipment · buffers | Shown under | Present |
|---|---|---|---|---|
| 1 | Raw-material preparation & milling | B-RCV, B-BAYS, B-LOAD, B-FEED, B-SILO, C-CRS, C-BM1–3, C-SLIP · BUF-SLIP | PREP | yes |
| 2 | Spray drying & powder storage | D-HAG, D-TWR, D-CYC, D-SILO, D-BELT · BUF-SILO | SPRAY | yes |
| 3 | Pressing | E-PRS1–3, E-COL · BUF-COL | PRESS | yes |
| 4 | Drying | F-DRY, F-BUF · BUF-DRY | DRY | yes |
| 5 | Glazing & engobe | G-PREP, G-LINE, CV-GLZ · BUF-GLZ | GLAZE | yes |
| 6 | Digital printing | G-INK | GLAZE | yes |
| 7 | Kiln firing | H-KILN, CV-KIN · BUF-KIN | KILN | yes |
| 8 | Cooling buffer & roller conveyors | CV-SORT · BUF-KOUT | KILN | partial |
| 9 | Polishing & rectification | — (pseudo id `S09`) | — | no |
| 10 | Sorting, grading & inspection | I-GAUGE, I-VIS, I-SORT, I-QC, I-BUF · BUF-SORT | SORT | yes |
| 11 | Packing & palletising | J-CNT, J-BOX, J-PAL, J-WRAP, CV-PACK, CV-PAL · BUF-PACK | PACK | yes |
| 12 | Warehouse & internal movement | K-RACK, K-FLT, K-STG, K-DOCK, A-GATE, A-HOLD | WH | yes |
| — | Site utilities / support (no stage) | A-PARK, A-ADMIN, A-DUST, A-COMP, A-SUB, A-WTR, A-GAS, A-STK, L-WS, L-SP | — | — |

Every 3D asset is in exactly one stage or in the support list (a test checks it). `coverage()` counts the
catalogue per stage, per equipment item and in total by class × status; `catalogForStage(no)` lists a stage
equipment by equipment.

**Stage 8 — partial.** The 3D model has no dedicated cooling-buffer machine. The kiln outfeed storage
(`BUF-KOUT`) and the sorting-line roller conveyor (`CV-SORT`) play that role; the stage is shown under the Kiln
monitored stage. `BUF-KOUT` has no equipment of its own and therefore no level signal; its occupancy is
documented as `CV-SORT.outfeed_buffer_level` (*not modelled* — the simulation holds the buffer internally). If
the registry gains a level signal for the buffer, that simulated signal replaces the documented entry
automatically. The brief's downstream-constraint example "polishing slowdown → cooling buffer fills" is
expressed with the next stage that exists after the cooling buffer: **a sorting-line slowdown → kiln outfeed
(stage 8) fills → kiln limited by its outfeed**.

**Stage 9 — not present.** This representative glazed-tile line has no polishing or squaring machines in its
3D model. The stage's catalogue is defined anyway (machine state, alarm code, line speed, throughput, tile
counter, spindle speed and current, head feed pressure, water flow, tool-change counter, actual size,
squareness) under the pseudo equipment id `S09`, every entry *unavailable* with the note "No polishing /
rectification equipment in this representative line — map to a machine to enable".

## Mapping a real tag at integration

The catalogue is the checklist for an integration project; the adapter boundary is `TelemetrySource` in
`src/model/telemetry.ts` (see also `docs/INTEGRATION.md`).

1. **Confirm the signal on the machine.** Start with *Core candidate* entries; *Conditional* ones need the
   sensor, drive data or controller programme; *External integration* entries need the other system (MES,
   QMS, WMS, vision, telematics).
2. **Record the real address in the deployment's configuration**, not in this demo's source: the tag or node
   id becomes `sourceTag`, the system `sourceSystem`. Keep the signal id — rules, charts and reports key on it.
3. **Check the semantics against the definition**: unit, data type, enum values, engineering range,
   warning / alarm limits, the setpoint pair of a PV, the update interval, and for counters the rollover value
   and what resets them (shift, changeover, power cycle).
4. **Implement the adapter** for those ids (`read`, `series`, `states` of `TelemetrySource`), with real
   timestamps and quality (good / uncertain / bad / stale / missing) — never zero for a missing value.
5. **Only after verification** set the entry's status to `connected`. Until then the value stays *simulated*,
   *not modelled* or *unavailable*, and is labelled as such.
6. **Calibrations and conversions** are configuration too: a silo mass needs a level-to-mass calibration or
   load cells; a mass flow needs a belt weigher or a flow and density measurement — the simulated conversions
   above are not replaced by a real signal just by connecting a tile counter.
7. **Stage 9** is enabled by adding the machine to the plant model and mapping the `S09` entries to its
   equipment id.

## Adding or changing an entry

- Registry signals: change `SIGNALS` in `src/model/plant.ts`; describe a new signal name in `fromRegistry`
  (`signals.ts`) — otherwise it gets a generic description.
- Simulated process signals: `PROCESS_SIGNALS` in `process.ts` (the contract with `src/sim/process.ts`).
- Documented signals: add a `doc(equipmentId, key, { … })` entry to the stage file. Ids are
  `<equipmentId>.<snake_name>` and must not collide with a registry or process id.
- `src/model/catalog/__tests__/catalog.test.ts` checks, among others: every registry and process id exactly
  once, unique ids, no *connected* status, `sourceTag` always null, at least eight entries per stage, a
  setpoint for every controlled PV, ordered limits inside the engineering range, the silo mass unavailable,
  no `tiles/h` in stages 1–2, stage 9 all unavailable, only existing equipment ids (except `S09`), condition
  limits equal to the health model, every signal id mentioned in a description or note exists, and no real
  plant name anywhere.
