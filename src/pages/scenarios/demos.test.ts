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
    expect(DEMOS.map((d) => d.id)).toEqual(['A', 'B', 'C', 'D']);
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
