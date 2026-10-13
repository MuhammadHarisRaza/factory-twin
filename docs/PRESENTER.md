# Presenter script (≈ 12 minutes)

Before the meeting: **Scenarios → Guided demos → E · Reset demo** (Mon 12 Oct 10:30, no scenarios). Keep the
clock at 60× (one plant minute per second). Say once, pointing at the **Simulated** chip in the header:
*everything you see is a deterministic simulation of a representative plant; nothing is connected to a real
machine, camera or model, and the product says so wherever it matters. The videos are public reference footage
of the same kind of process, not this plant.*

1. **Overview (1.5 min)** — read the summary sentence, then the five KPIs (each says its scope, target and why
   it matters). The 3D factory is live: pick a stage in the flow strip and the model highlights it; click the kiln
   in the model → selection card → *Open details*.

2. **Factory Twin (1 min)** — the kiln's panel (70 % of the screen): status, the client's kiln camera recording
   across its top (it starts by itself, muted, with no player controls — click the picture to pause; the ⓘ says it
   is a recording, not a live feed), then the kiln KPIs, what matters, the last 4 h, signals and events; the
   temperature profile is *not modelled* and says so. Technical details show signal ids and the data source.

3. **A · Conveyor stops (2.5 min)** — *Scenarios → Guided demos → A → CV-PACK, 30 min → Set up → Show me: Factory
   Twin.* The packing belt turns red, packing starves. *Event report:* state transition, per-minute counter, a
   camera view **rendered from the twin** (labelled), the linked consequence. Impact: no line output lost yet — the
   accumulation buffer absorbs it. *Download PDF* — the same record. *Ask Copilot* → facts / simulated / inferred
   / hypotheses / actions.

4. **B · OEE loss (2 min)** — *B → H-KILN at 60 % → Set up.* *Production → OEE & losses:* A × P × Q with the
   numbers, the interpretation sentence, the ten integrity checks and the count reconciliation (fired → sorted →
   good → packed → palletised; every difference is a buffer change). Top losses are valued once, with the
   assumptions on screen (Analysis → Assumptions to edit them).

5. **C · Defect deterioration (2 min)** — *C → Glazing × 6.* *Quality & Defects:* the rising category, the defect
   event and its evidence image (simulated, with **simulated** confidence), the modeled origin stage marked as a
   hypothesis, before/after rates, the recommended action, inspection reference footage.

6. **D · Truck delay (1.5 min)** — *D → Set up*, skip ahead. *Fleet & Movement:* the truck on the site layout
   (simulated positions), the dock line, the delay against its limit, the vehicle detail and the dock event.

7. **Close (1.5 min)** — *Events & Reports → Reports:* a shift production report for the current shift, preview
   and PDF. *Copilot:* "Which equipment should be investigated first?". Then **E · Reset** — back to the same
   starting point, every time.

Questions to expect: *Is this live?* — No: a deterministic simulation using the same data model a read-only
integration would fill (`docs/INTEGRATION.md`); real camera streams can be configured per camera (Factory Twin →
equipment → Technical details → Cameras) and are labelled Live only when they play. *Is the AI real?* — The
detection rules, classifications and copilot are transparent rules over the shared state; a vision model or an LLM
can replace them behind the same interfaces. *Are these videos from this plant?* — No: public reference footage
from equipment makers, tile manufacturers and stock libraries, labelled on every player.
