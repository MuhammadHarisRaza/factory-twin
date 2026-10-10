# Presenter script (≈ 10 minutes)

Before the meeting: open the app, go to **Scenario Simulator → Reset Demo** (Mon 12 Oct 10:30, no
scenarios). Leave the clock at 60× (one plant minute per second). Everything shown is simulated — say so once
at the start and point at the **Demo · simulated data** chip.

1. **The factory (1 min)** — *Factory Twin.* "This is a digital twin of a representative ceramic tile plant —
   raw materials on the left, through pressing, drying, glazing, the kiln, sorting and packing to the warehouse
   and dispatch." Orbit once. Point at the KPI chips (OEE, output vs target, downtime, defects, energy) and the
   line strip at the bottom: every stage green, the kiln is the constraint as designed. Click the kiln: the
   inspector shows its status, shift KPIs, health and recommendations.

2. **A breakdown (2 min)** — *Scenario Simulator → B · Machine breakdown → H-KILN, 30 min → Activate*, then
   **Twin · H-KILN**. "The kiln has stopped." The beacon turns red, sorting and packing go amber (starved),
   the product flow stops at the kiln, the downtime chip rises. Open **Command Center**: the stoppage is the
   top critical insight with capacity lost so far and the first recommended action. Back in the simulator the
   impact band shows output, OEE and downtime against the no-scenario baseline.

3. **Ask the copilot (1 min)** — *Copilot → "What should the shift supervisor do next?"* and *"Why is
   production below target?"* "The answers are composed from the same live state — this demo uses rule-based
   reasoning, not a language model, and says so."

4. **A bottleneck (1.5 min)** — *Clear the breakdown; A · Production bottleneck → Glazing 45 % → Activate.*
   "Glazing loses capacity. Nothing happens to output at first — the kiln infeed buffer absorbs it — then the
   kiln starves." Skip +15 min on the timeline. *Production & OEE → Bottleneck*: the trace now points at
   glazing, with blocked stages upstream and starved stages downstream.

5. **Quality (1.5 min)** — *C · Quality deterioration → Glazing ×4.* *Quality Intelligence*: the vision station
   shows reject frames with defect boxes, classification and confidence ("illustrative frames, simulated
   classification"), the affected batch, and rejects/quality rate that reconcile with OEE on the Production page.

6. **Energy (1 min)** — *D · Energy anomaly → H-KILN +20 %.* *Energy Intelligence*: kiln gas 20 % above its
   model, excess cost per hour and per month at the tariffs shown (edit a tariff to show the cost update), and
   the gas the kiln burned while it was starved.

7. **Predict and prevent (1.5 min)** — *Machine Health*: C-BM2 already shows a mild bearing issue. *E ·
   Developing machine fault → E-PRS2.* Within minutes the hydraulic pump's vibration departs from its expected
   value; the page estimates time to alarm and trip and recommends an action. *Schedule condition-based
   maintenance*: a short planned stop now instead of a breakdown later — show the maintenance history entry and
   the fault cleared.

8. **Close (30 s)** — *Command Center*: alerts, insights, next actions and the event timeline in one place.
   "Physical factory, data, twin, intelligence, decision, outcome." *Reset Demo* returns to the start.

Questions to expect: *Is this live?* — No; it is a deterministic simulation with the same data model a real
integration would fill (see Assets & Data and `docs/INTEGRATION.md`). *Is the AI real?* — The insights,
copilot and detection are transparent rules over the state; a model could replace them behind the same
interfaces.
