import { describe, expect, it } from 'vitest';
import { activateScenario, advance, clearScenario, createSim } from '../../sim/engine';
import { impactVsBaseline } from '../../sim/metrics';
import { HEALTH_BY_ID } from '../../sim/health';
import {
  CATALOGUE,
  ENTRY_BY_ID,
  impactWindow,
  initialValues,
  judge,
  maintenanceDef,
  outcomeOf,
  paramOptions,
  paramSummary,
  resolveValues,
  sameTarget,
  scenarioStatus,
  signed,
} from './catalogue';

const START = 2 * 1440 + 4 * 60 + 37; // a mid-hour minute

describe('scenario catalogue', () => {
  it('builds a valid definition for every entry from its initial values', () => {
    const s = createSim(7, START);
    const init = initialValues();
    for (const e of CATALOGUE) {
      const v = resolveValues(e, init[e.id], s);
      for (const p of e.params) expect(paramOptions(p, s).some((o) => String(o.value) === String(v[p.key]))).toBe(true);
      const def = e.build(v, s.minute);
      expect(def.kind).toBe(e.kind);
      expect(def.label.length).toBeGreaterThan(3);
      expect(def.end === null || def.end > s.minute).toBe(true);
      if (def.factor != null) expect(def.factor).toBeGreaterThan(0);
      expect(e.focus(v, null, s)).not.toBeNull();
    }
  });

  it('keeps factors inside the engine ranges', () => {
    const s = createSim(7, START);
    const ranges: Record<string, [number, number]> = { A: [0.3, 0.7], C: [2, 6], D: [1.1, 1.4], F: [0.4, 0.8] };
    for (const [id, [lo, hi]] of Object.entries(ranges)) {
      const p = ENTRY_BY_ID[id].params.find((x) => x.key === 'factor')!;
      for (const o of paramOptions(p, s)) {
        expect(Number(o.value)).toBeGreaterThanOrEqual(lo);
        expect(Number(o.value)).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('falls back to a valid option when a dynamic option disappears', () => {
    const s = createSim(7, START);
    const v = resolveValues(ENTRY_BY_ID.I, { dock: 'DOCK-99', count: 75 }, s);
    expect(v.dock).toBe('auto');
  });

  it('tracks status through the lifecycle', () => {
    const s = createSim(7, START);
    const stop = activateScenario(s, ENTRY_BY_ID.B.build({ machine: 'H-KILN', duration: 15 }, s.minute));
    expect(scenarioStatus(s, stop).key).toBe('active');
    expect(paramSummary(stop)).toContain('H-KILN');
    advance(s, s.minute + 20);
    expect(scenarioStatus(s, stop).key).toBe('ended');
    expect(outcomeOf(s, stop)).toBe('Stopped 15 min');

    const truck = activateScenario(s, ENTRY_BY_ID.G.build({}, s.minute));
    expect(scenarioStatus(s, truck).key).toBe('applied');
    advance(s, s.minute + 2);
    expect(outcomeOf(s, truck)).toMatch(/^1 truck/);

    const bn = activateScenario(s, ENTRY_BY_ID.A.build({ stage: 'GLAZE', factor: 0.45 }, s.minute));
    expect(sameTarget(bn, ENTRY_BY_ID.A.build({ stage: 'GLAZE', factor: 0.3 }, s.minute))).toBe(true);
    expect(sameTarget(bn, ENTRY_BY_ID.A.build({ stage: 'KILN', factor: 0.3 }, s.minute))).toBe(false);
    advance(s, s.minute + 3);
    clearScenario(s, bn.id);
    expect(scenarioStatus(s, bn).key).toBe('ended');
  });

  it('reports a developing fault removed by condition-based maintenance', () => {
    const s = createSim(7, START);
    const fault = activateScenario(s, ENTRY_BY_ID.E.build({ asset: 'E-PRS2', progression: 'typical' }, s.minute));
    expect(ENTRY_BY_ID.E.unavailable!({ asset: 'E-PRS2' }, s)).not.toBeNull();
    advance(s, s.minute + 20);
    const cbm = activateScenario(s, maintenanceDef('E-PRS2', 45));
    expect(scenarioStatus(s, cbm).key).toBe('active');
    advance(s, s.minute + 46);
    expect(scenarioStatus(s, cbm).key).toBe('completed');
    const st = scenarioStatus(s, fault);
    expect(st.key).toBe('resolved');
    expect(st.note).toMatch(/maintenance/);
    // Never broke down: no unplanned event tied to the fault.
    expect(s.downtime.some((d) => d.scenarioId === fault.id && d.reasonCode === HEALTH_BY_ID['E-PRS2'].failureReason)).toBe(false);
  });

  it('reports a developing fault that was left to fail', () => {
    const s = createSim(7, START);
    const fault = activateScenario(s, ENTRY_BY_ID.E.build({ asset: 'E-PRS2', progression: 'fast' }, s.minute));
    advance(s, s.minute + 90);
    const st = scenarioStatus(s, fault);
    expect(st.key).toBe('resolved');
    expect(st.note).toMatch(/breakdown/);
  });

  it('anchors the impact window on the hour of the first active scenario and measures the delta', () => {
    const s = createSim(7, START);
    const base = createSim(7, START);
    expect(impactWindow(s, 'scenario').fallback).toBe(true);
    const stop = activateScenario(s, ENTRY_BY_ID.B.build({ machine: 'H-KILN', duration: 0 }, s.minute));
    advance(s, s.minute + 40);
    advance(base, s.minute);
    const w = impactWindow(s, 'scenario');
    expect(w.fallback).toBe(false);
    expect(w.period.from % 60).toBe(0);
    expect(w.period.from).toBeLessThanOrEqual(START);
    expect(w.period.from).toBeGreaterThan(START - 60);
    const im = impactVsBaseline(s, base, w.period);
    expect(im.deltaOutputM2).toBeLessThan(0);
    expect(im.deltaDowntimeMin).toBeGreaterThanOrEqual(29);
    expect(im.oee).not.toBeNull();
    // Once the (only) scenario ends, the window falls back to the current shift.
    clearScenario(s, stop.id);
    expect(impactWindow(s, 'scenario').fallback).toBe(true);
  });

  it('formats and judges deltas', () => {
    const f = (n: number) => n.toFixed(0);
    expect(signed(12.4, f)).toBe('+12');
    expect(signed(-12.4, f)).toBe('−12');
    expect(signed(0.3, f)).toBe('0');
    expect(signed(null, f)).toBe('—');
    expect(judge(-5, 1, true)).toBe('worse');
    expect(judge(5, 1, false)).toBe('worse');
    expect(judge(0.2, 1, true)).toBe('same');
    expect(judge(null, 1, true)).toBeNull();
  });
});
