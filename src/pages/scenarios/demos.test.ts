import { describe, expect, it } from 'vitest';
import { CONVEYOR_IDS } from '../../model/plant';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { resolveValues, scenarioTrucks, type Values } from './catalogue';
import {
  DEMOS,
  DEMO_BY_ID,
  DEMO_CONVEYORS,
  conveyorStage,
  countersCheck,
  demoEvents,
  demoInitialValues,
  demoKey,
  demoView,
  holdDef,
  primaryEvent,
  resetChecks,
  resetSnapshot,
  watchDecision,
  type DemoId,
  type DemoRun,
  type HoldWatch,
  type DemoView,
} from './demos';

const START = 2 * 1440 + 4 * 60 + 37;

/** Activates a demonstration's scenario inputs the way the card does (without the UI store). */
function setUp(s: SimState, id: DemoId, v?: Values): DemoRun {
  const def = DEMO_BY_ID[id];
  const vals = resolveValues(def, v ?? demoInitialValues()[demoKey(id)], s);
  const ids = def.build(vals, s.minute).map((d) => activateScenario(s, d).id);
  return { demo: id, epoch: 0, at: s.minute, scenarioIds: ids };
}

describe('end-to-end demonstrations', () => {
  it('offers valid initial parameters and the required conveyors', () => {
    const s = createSim(7, START);
    expect(DEMOS.map((d) => d.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    expect(DEMO_CONVEYORS[0]).toBe('CV-PACK');
    expect([...DEMO_CONVEYORS].sort()).toEqual([...CONVEYOR_IDS].sort());
    for (const d of DEMOS) {
      const v = resolveValues(d, demoInitialValues()[demoKey(d.id)], s);
      const defs = d.build(v, s.minute);
      expect(defs.length).toBeGreaterThan(0);
      for (const x of defs) expect(x.label.length).toBeGreaterThan(5);
    }
    expect(conveyorStage('CV-PACK')).toBe('PACK');
    expect(conveyorStage('CV-PAL')).toBe('PACK');
    expect(conveyorStage('CV-GLZ')).toBe('GLAZE');
    expect(conveyorStage('E-COL')).toBe('DRY');
    expect(conveyorStage('D-BELT')).toBe('PRESS');
  });

  it('A · conveyor stoppage: one stop event with report, copilot and stage steps', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'A');
    const v = resolveValues(DEMO_BY_ID.A, undefined, s);
    expect(demoView(s, DEMO_BY_ID.A, v, run).skip).toBe(1);
    advance(s, s.minute + 15);
    const view = demoView(s, DEMO_BY_ID.A, v, run);
    expect(view.active).toBe(true);
    expect(view.primary?.type).toBe('conveyor-stop');
    expect(view.primary?.asset.equipmentId).toBe('CV-PACK');
    const event = view.steps.find((x) => x.key === 'event')!;
    expect(event.target).toEqual({ type: 'event', id: view.primary!.id });
    const copilot = view.steps.find((x) => x.key === 'copilot')!;
    expect(copilot.target).toMatchObject({ type: 'copilot', eventId: view.primary!.id });
    expect(view.steps.find((x) => x.key === 'stage')!.target).toEqual({ type: 'stage', id: 'PACK' });
    // Consequences (packing starved) are linked to the stop, not counted as the demonstration's event.
    for (const e of view.events) if (e.consequenceOf) expect(e.consequenceOf).toBe(view.primary!.id);
    expect(view.skip).toBeNull();
  });

  it('B · OEE loss: reduced rate raises the below-rate event; downtime the stop event', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'B', { mode: 'rate', machine: 'H-KILN', factor: 0.6, duration: 30 });
    advance(s, s.minute + 14);
    const view = demoView(s, DEMO_BY_ID.B, { mode: 'rate', machine: 'H-KILN', factor: 0.6, duration: 30 }, run);
    expect(view.primary?.type).toBe('below-rate');
    expect(view.steps[0].target).toEqual({ type: 'workspace', id: 'production', tab: 'oee' });

    const t = createSim(7, START);
    const stop = setUp(t, 'B', { mode: 'stop', machine: 'E-PRS2', factor: 0.6, duration: 15 });
    advance(t, t.minute + 3);
    expect(demoView(t, DEMO_BY_ID.B, { mode: 'stop', machine: 'E-PRS2', factor: 0.6, duration: 15 }, stop).primary?.type).toBe('machine-stop');
  });

  it('C · defect deterioration: a quality event within about 30 simulated minutes at ×6', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'C');
    let view = demoView(s, DEMO_BY_ID.C, resolveValues(DEMO_BY_ID.C, undefined, s), run);
    for (let i = 0; i < 60 && !view.primary; i++) {
      advance(s, s.minute + 1);
      view = demoView(s, DEMO_BY_ID.C, resolveValues(DEMO_BY_ID.C, undefined, s), run);
    }
    expect(view.primary?.category).toBe('quality');
    expect(view.primary?.refs.scenarioId).toBe(run.scenarioIds[0]);
    expect(view.steps.find((x) => x.key === 'event')!.target).toEqual({ type: 'event', id: view.primary!.id });
  });

  it('D · truck delay: the hold is added when the truck docks and the dock event follows', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'D');
    const truck = scenarioTrucks(s, run.scenarioIds[0])[0];
    expect(truck).toBeTruthy();
    const w: HoldWatch = { truckId: truck.id, truckLabel: truck.label, hold: 75, state: 'waiting', dockId: null, holdScenarioId: null, at: null, note: null };
    run.watch = w;
    expect(watchDecision(s, w).action).toBe('wait');
    for (let i = 0; i < 240 && w.state === 'waiting'; i++) {
      advance(s, s.minute + 1);
      const d = watchDecision(s, w);
      if (d.action === 'apply') {
        const hold = activateScenario(s, holdDef(w, d.dockId));
        expect(hold.label).toContain(truck.label);
        run.scenarioIds.push(hold.id);
        Object.assign(w, { state: 'applied', dockId: d.dockId, holdScenarioId: hold.id, at: hold.start });
      } else expect(d.action).toBe('wait');
    }
    expect(w.state).toBe('applied');
    const v = resolveValues(DEMO_BY_ID.D, undefined, s);
    const waiting = demoView(s, DEMO_BY_ID.D, v, run);
    expect(waiting.status).toContain('held +75 min');
    expect(waiting.skip).toBeGreaterThan(0);
    advance(s, s.minute + waiting.skip!);
    const view = demoView(s, DEMO_BY_ID.D, v, run);
    expect(view.primary?.type).toBe('dock-overstay');
    expect(view.primary?.asset.vehicleId).toBe(truck.id);
    expect(view.steps.find((x) => x.key === 'truck')!.target).toEqual({ type: 'vehicle', id: truck.id });
  });

  it('picks the preferred event type and links events through the scenario id', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'A');
    advance(s, s.minute + 20);
    const evs = demoEvents(s, run.scenarioIds);
    expect(evs.length).toBeGreaterThan(0);
    for (let i = 1; i < evs.length; i++) expect(evs[i - 1].start).toBeLessThanOrEqual(evs[i].start);
    expect(primaryEvent(evs, ['conveyor-stop'])?.type).toBe('conveyor-stop');
    expect(demoEvents(s, [])).toEqual([]);
  });

  it('checks a reset: nothing injected, no session events, counters on the baseline', () => {
    const s = createSim(7, START);
    const base = createSim(7, START, { events: false });
    const snap = resetSnapshot(s, 1);
    const checks = resetChecks(snap, s, base);
    expect(checks.map((c) => c.ok)).toEqual([true, true, true]);
    expect(countersCheck(s, null).ok).toBeNull();
    advance(s, s.minute + 5);
    expect(countersCheck(s, base).ok).toBeNull(); // different minute
    advance(base, s.minute);
    expect(countersCheck(s, base).ok).toBe(true);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'stop' });
    advance(s, s.minute + 5);
    advance(base, s.minute);
    const after = resetChecks(snap, s, base);
    expect(after[0].ok).toBe(true); // refers to the moment of the reset
    expect(after[0].detail).toMatch(/activated since/);
    expect(after[2].ok).toBeNull(); // a scenario makes the plant differ on purpose
  });
});

// ── Finding-based demonstrations E–H ──────────────────────────────────────────

/** Follows a demo the way the presenter does: Skip until its findings are there. Returns the view and the minutes simulated. */
function follow(s: SimState, id: DemoId, run: DemoRun, maxSkips = 20) {
  const v = resolveValues(DEMO_BY_ID[id], undefined, s);
  let view: DemoView = demoView(s, DEMO_BY_ID[id], v, run);
  let skips = 0;
  const seen = new Set<string>();
  const note = () => view.rows.forEach((r) => (r.state === 'detected' || r.state === 'cleared') && seen.add(r.key));
  note();
  while (!view.complete && skips < maxSkips) {
    expect(view.skip, `${id}: ${view.eventLine}`).not.toBeNull();
    advance(s, s.minute + view.skip!);
    skips++;
    view = demoView(s, DEMO_BY_ID[id], v, run);
    note();
  }
  return { view, skips, seen, minutes: s.minute - run.at };
}
const row = (view: DemoView, key: string) => view.rows.find((r) => r.key === key)!;

/** Honest wording: no AI, no live / connected source, no prediction, no causal claim (an association is "not a cause"). */
const claims = (text: string) => text.replace(/\bnot an? (demonstrated )?cause\b/gi, '');
const DISHONEST = /\bAI\b|machine learning|\blive\b|connected|predict|forecast|will fail|caused by|root cause|\bcauses?\b|Ghani|tiles\/h/i;

describe('finding-based demonstrations (E–H)', () => {
  it('E · powder shortage: spray dryer down → silos fall → presses short → Potential press starvation, with aligned times', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'E');
    const first = demoView(s, DEMO_BY_ID.E, resolveValues(DEMO_BY_ID.E, undefined, s), run);
    expect(first.complete).toBe(false);
    expect(first.skip).toBe(60);
    const { view, skips, seen, minutes } = follow(s, 'E', run);
    // Watchable: a handful of skips, although the silos take many simulated hours to drain.
    expect(view.complete).toBe(true);
    expect(skips).toBeLessThanOrEqual(10);
    expect(minutes).toBeLessThan(36 * 60);
    const f = view.finding!;
    expect(f).toMatchObject({ ruleId: 'F-POWDER-STARVATION', status: 'fired', title: 'Potential press starvation', classification: 'rule-based' });
    expect(f.firstSeen!).toBeGreaterThanOrEqual(run.at);
    // The silo trend and the t/h balance were reported on the way (they may have settled once the silos ran low).
    expect(seen.has('trend')).toBe(true);
    expect(seen.has('balance')).toBe(true);
    expect(row(view, 'starve').state).toBe('detected');
    expect(view.detail).toMatch(/^1 · .+ from \S+.* · 2 · Powder silo level from \S+.* · 3 · E-PRS\d state from \S+/);
    expect(view.eventLine).toMatch(/^F-POWDER-STARVATION · Detected · Potential press starvation · since /);
    expect(view.skip).toBeNull();
    expect(view.steps.map((x) => x.target)).toEqual([
      { type: 'equipment', id: 'D-TWR' },
      { type: 'equipment', id: 'D-SILO' },
      { type: 'workspace', id: 'production', tab: 'material' },
    ]);
  });

  it('F · downstream constraint: sorting slows, the kiln outfeed fills, the kiln is limited → F-DOWNSTREAM-CONSTRAINT', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'F');
    const { view, minutes } = follow(s, 'F', run);
    expect(view.complete).toBe(true);
    expect(minutes).toBeLessThanOrEqual(60);
    expect(view.finding).toMatchObject({ ruleId: 'F-DOWNSTREAM-CONSTRAINT', title: 'Possible downstream constraint at sorting', severity: 'serious' });
    expect(view.finding!.explanation).toMatch(/no polishing \/ rectification stage/);
    expect(row(view, 'block').state).toBe('detected');
    expect(DEMO_BY_ID.F.summary).toMatch(/stage 8 “cooling buffer” = the kiln outfeed/);
    expect(DEMO_BY_ID.F.summary).toMatch(/no polishing \/ rectification stage/);
    expect(view.steps.map((x) => x.target)).toContainEqual({ type: 'workspace', id: 'production', tab: 'material' });
  });

  it('G · process deviation → batch → rejects: the association names the batch and stays "to investigate"', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'G');
    const { view, minutes } = follow(s, 'G', run);
    expect(view.complete).toBe(true);
    expect(minutes).toBeLessThanOrEqual(60);
    const f = view.finding!;
    expect(f).toMatchObject({ ruleId: 'QL-PROCESS-ASSOCIATION', classification: 'statistical' });
    expect(f.explanation).toMatch(/^Association to investigate — not a demonstrated cause/);
    expect(row(view, 'limit').state).toBe('detected');
    expect(view.detail).toMatch(/^Batch B-\d{6}-\d+: reject rate [\d.]+ % for tiles made during the deviation vs [\d.]+ % outside it — an association to investigate, not a cause\.$/);
    expect(view.steps.map((x) => x.target)).toEqual([
      { type: 'equipment', id: 'H-KILN' },
      { type: 'workspace', id: 'quality', tab: 'compare' },
    ]);
  });

  it('H · data quality: DQ findings for the frozen counter and the bad sensor; dependent rules not evaluated', () => {
    const s = createSim(7, START);
    const run = setUp(s, 'H');
    expect(run.scenarioIds).toHaveLength(2);
    const { view, minutes } = follow(s, 'H', run);
    expect(view.complete).toBe(true);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(['DQ-FROZEN', 'DQ-STALE']).toContain(row(view, 'frozen').finding!.ruleId);
    expect(row(view, 'bad').finding!.ruleId).toBe('DQ-BAD-QUALITY');
    for (const k of ['counter', 'output', 'zone1']) {
      expect(row(view, k).state, k).toBe('not-evaluated');
      expect(row(view, k).finding!.status, k).toBe('insufficient-data');
    }
    expect(view.status).toMatch(/\+1 more$/);
    expect(view.steps.map((x) => x.target)).toContainEqual({ type: 'workspace', id: 'events', tab: 'data' });
  });

  it('their texts make no causal, AI or live claims and label the inputs simulated', () => {
    const s = createSim(7, START);
    for (const id of ['E', 'F', 'G', 'H'] as DemoId[]) {
      const d = DEMO_BY_ID[id];
      const v = resolveValues(d, undefined, s);
      const run: DemoRun = { demo: id, epoch: 0, at: s.minute, scenarioIds: [] };
      const view = demoView(s, d, v, run);
      const texts = [d.title, d.summary, view.eventLine, ...d.findings!.map((f) => f.label), ...view.steps.map((x) => x.label), ...d.build(v, s.minute).map((x) => x.label)];
      for (const text of texts) expect(claims(text), `${id}: ${text}`).not.toMatch(DISHONEST);
      for (const x of d.build(v, s.minute)) expect(x.label, id).toMatch(/\(simulated\)$/);
      // Not set up: nothing is evaluated and nothing claimed.
      expect(demoView(s, d, v, null).rows).toEqual([]);
      expect(demoView(s, d, v, null).eventLine).toMatch(/^Set up to create the scenario/);
    }
  });
});
