# Presenter script (≈ 12 minutes)

Before the meeting: **Scenario Simulator → E · Reset demo** (Mon 12 Oct 10:30, no scenarios). Keep the clock at
60× (one plant minute per second). Say once, pointing at the **Demo · simulated data** chip: *everything you see
is a deterministic simulation of a representative plant; nothing is connected to a real machine, camera or
model, and the product says so wherever it matters.*

1. **The twin (1 min)** — *Factory Twin.* Raw materials → milling, spray drying, pressing, drying, glazing, the
   kiln, sorting, packing, warehouse and dispatch. Point at the KPI chips and the line strip (stages and the
   conveyors between them). Click the kiln: state, shift A × P × Q, health, events, recommendations, camera.

2. **A · Conveyor stops (2.5 min)** — *Scenario Simulator → A → CV-PACK, 30 min → Set up → 3D twin.* The packing
   belt turns red with a "Stopped" tag, tiles stop, packing goes amber (starved). *Event report:* the event's
   state transition, per-minute counter, a camera view **rendered from the twin** (labelled), and the linked
   consequence ("packing starved — likely because CV-PACK stopped"). Impact: no line output lost yet — the
   accumulation buffer is absorbing it. *Download PDF* — the same record. *Ask the copilot:* "What happened and
   what should we do?" → observed / inferred / recommended, with links.

3. **B · OEE loss (2 min)** — *B → H-KILN at 60 % → Set up.* *OEE & Loss Intelligence:* factory OEE (= line OEE at
   the constraint) drops; the capacity waterfall shows speed loss at the kiln; the loss is valued once, with the
   assumptions on screen (edit the price to show it recalculates). *H-KILN drill-down* → its below-rate event →
   report. *Improvement scenarios*: what +2 pts of kiln performance is worth per shift (an estimate, not a promise).

4. **C · Defect deterioration (2 min)** — *C → Glazing × 6.* *AI Defect Monitoring:* the inspection workflow strip,
   frames with defect boxes and **simulated** confidence, rejects and quality rate reconciling with OEE, the quality
   events and their report with frames; suspected causes are hypotheses (confidence shown).

5. **D · Truck delay (1.5 min)** — *D → Set up.* A truck arrives, docks, and a documentation hold is added; skip
   ahead. *Vehicle Monitoring:* the truck in the pipeline, its visit timeline, the dock event and its report;
   turnaround updates when it leaves. Positions are simulated at zone level; proximity / GPS are listed as not
   available.

6. **Production Monitoring (1 min)** — any stage: input / output / WIP at configured counting points, equipment
   and conveyor states, signals, the stage's simulated camera feed, its events and the shift PDF.

7. **Close (1 min)** — *Command Center:* use cases, open events, next actions. *Factory Copilot:* "What should the
   supervisor investigate first?". Then **E · Reset** — back to the same starting point, every time.

Questions to expect: *Is this live?* — No: a deterministic simulation using the same data model a read-only
integration would fill (Assets & Data, `docs/INTEGRATION.md`); real camera streams can be configured and are
labelled Live only when they play. *Is the AI real?* — The detection rules, classifications and copilot are
transparent rules over the shared state; a vision model or an LLM can replace them behind the same interfaces.
