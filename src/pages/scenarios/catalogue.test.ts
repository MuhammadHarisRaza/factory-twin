import { describe, expect, it } from 'vitest';
import { activateScenario, advance, clearScenario, createSim } from '../../sim/engine';
import { impactVsBaseline } from '../../sim/metrics';
import { HEALTH_BY_ID } from '../../sim/health';
import { findingsFor, RULE_BY_ID } from '../../intel/rules';
import { definitionOf } from '../../model/catalog';
import { PROCESS_SIGNAL_BY_ID } from '../../model/catalog/process';
import {
  CATALOGUE,
  DEVIATION_RAMP_MIN,
  ENTRY_BY_ID,
  entryFor,
  entryMatches,
  isOneOff,
  scenarioFocus,
  faultOutcomes,
  impactWindow,
  initialValues,
  isClearable,
  judge,
  maintenanceDef,
  outcomeOf,
  paramOptions,
  paramSummary,
  resolveValues,
  sameTarget,
  scenarioEvents,
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
    const ranges: Record<string, [number, number]> = { bottleneck: [0.3, 0.7], quality: [2, 6], rate: [0.4, 0.8] };
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
    const v = resolveValues(ENTRY_BY_ID.dock, { dock: 'DOCK-99', count: 75 }, s);
    expect(v.dock).toBe('auto');
  });

  it('tracks status through the lifecycle', () => {
    const s = createSim(7, START);
    const stop = activateScenario(s, ENTRY_BY_ID.breakdown.build({ machine: 'H-KILN', duration: 15 }, s.minute));
    expect(scenarioStatus(s, stop).key).toBe('active');
    expect(paramSummary(stop)).toContain('H-KILN');
    advance(s, s.minute + 20);
    expect(scenarioStatus(s, stop).key).toBe('ended');
    expect(outcomeOf(s, stop)).toBe('Stopped 15 min');

    const truck = activateScenario(s, ENTRY_BY_ID.truck.build({}, s.minute));
    expect(scenarioStatus(s, truck).key).toBe('applied');
    advance(s, s.minute + 2);
    expect(outcomeOf(s, truck)).toMatch(/^1 truck/);

    const bn = activateScenario(s, ENTRY_BY_ID.bottleneck.build({ stage: 'GLAZE', factor: 0.45 }, s.minute));
    expect(sameTarget(bn, ENTRY_BY_ID.bottleneck.build({ stage: 'GLAZE', factor: 0.3 }, s.minute))).toBe(true);
    expect(sameTarget(bn, ENTRY_BY_ID.bottleneck.build({ stage: 'KILN', factor: 0.3 }, s.minute))).toBe(false);
    advance(s, s.minute + 3);
    clearScenario(s, bn.id);
    expect(scenarioStatus(s, bn).key).toBe('ended');
  });

  it('reports a developing fault removed by condition-based maintenance', () => {
    const s = createSim(7, START);
    const fault = activateScenario(s, ENTRY_BY_ID.fault.build({ asset: 'E-PRS2', progression: 'typical' }, s.minute));
    expect(ENTRY_BY_ID.fault.unavailable!({ asset: 'E-PRS2' }, s)).not.toBeNull();
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

  it('reports a developing fault that was left to fail, and no longer offers to clear it', () => {
    const s = createSim(7, START);
    const fault = activateScenario(s, ENTRY_BY_ID.fault.build({ asset: 'E-PRS2', progression: 'fast' }, s.minute));
    expect(isClearable(s, fault)).toBe(true);
    advance(s, s.minute + 90);
    const st = scenarioStatus(s, fault);
    expect(st.key).toBe('resolved');
    expect(st.note).toMatch(/breakdown/);
    // Finding #24: over, so nothing to clear; finding #16: a breakdown is not a removed fault.
    expect(isClearable(s, fault)).toBe(false);
    expect(faultOutcomes(s)).toEqual({ removed: 0, brokeDown: 1 });
  });

  it('links conveyor stoppages, data-feed loss and restricted-zone entries to their events', () => {
    const s = createSim(7, START);
    const belt = activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: s.minute + 20, label: 'Packing belt stop' });
    const feed = activateScenario(s, ENTRY_BY_ID.feed.build({ machine: 'E-PRS1', duration: 30 }, s.minute));
    const zone = activateScenario(s, ENTRY_BY_ID.zone.build({}, s.minute));
    expect(paramSummary(belt)).toContain('CV-PACK');
    expect(feed.end).toBe(s.minute + 30);
    advance(s, s.minute + 25);
    expect(outcomeOf(s, belt)).toBe('Stopped 20 min');
    expect(scenarioEvents(s, belt).some((e) => e.type === 'conveyor-stop')).toBe(true);
    expect(outcomeOf(s, feed)).toMatch(/^Data stale/);
    expect(scenarioEvents(s, feed).some((e) => e.type === 'counter-inactive')).toBe(true);
    advance(s, s.minute + 60);
    const entered = scenarioEvents(s, zone);
    expect(outcomeOf(s, zone)).toMatch(/^Entered/);
    expect(entered.length).toBeGreaterThan(0);
    expect(entered.every((e) => e.type === 'restricted-entry' && e.asset.vehicleId === 'FL-05')).toBe(true);
  });

  it('anchors the impact window on the hour of the first active scenario and measures the delta', () => {
    const s = createSim(7, START);
    const base = createSim(7, START);
    expect(impactWindow(s, 'scenario').fallback).toBe(true);
    const stop = activateScenario(s, ENTRY_BY_ID.breakdown.build({ machine: 'H-KILN', duration: 0 }, s.minute));
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

// ── Process deviations and data-quality faults (simulated) ────────────────────

const NEW_IDS = ['dev-kiln-z3', 'dev-spray-moisture', 'dev-dryer-z2', 'dev-press2-pressure', 'dq-frozen-prs2', 'dq-bad-kiln', 'dq-reset-jbox', 'dq-spike-dtwr', 'dq-gap-fdry', 'dq-cmd-prs1'];
/** Texts must not claim AI, a live / connected source, a cause, or tiles for powder. */
const DISHONEST = /\bAI\b|machine learning|\blive\b|connected|caused by|root cause|predict|forecast|tiles\/h|Ghani/i;

describe('process-deviation and data-quality catalogue entries', () => {
  it('are labelled simulated, name the detecting rules and build valid activations', () => {
    const s = createSim(7, START);
    for (const id of NEW_IDS) {
      const e = ENTRY_BY_ID[id];
      expect(e, id).toBeDefined();
      expect(e.title, id).toBeTruthy();
      expect(e.summary, id).toMatch(/^Simulated scenario: /);
      for (const text of [e.title!, e.summary, e.effect]) expect(text, id).not.toMatch(DISHONEST);
      expect(e.detectedBy!.length, id).toBeGreaterThan(0);
      for (const r of e.detectedBy!) expect(RULE_BY_ID[r], `${id} → ${r}`).toBeDefined();
      const def = e.build(resolveValues(e, undefined, s), s.minute);
      expect(def.label, id).toMatch(/\(simulated\)$/);
      // Each activation belongs to its own entry only.
      const sc = { ...def, id: 'SCN-X', start: s.minute };
      expect(entryFor(sc)?.id, id).toBe(id);
      expect(CATALOGUE.filter((x) => entryMatches(x, sc)).map((x) => x.id), id).toEqual([id]);
      if (def.kind === 'process-deviation') {
        const spec = PROCESS_SIGNAL_BY_ID[def.signalId!];
        expect(spec?.role, id).toBe('pv');
        const sp = spec.nominal ?? 0;
        const alarm = spec.alarmHigh != null ? spec.alarmHigh - sp : sp - spec.alarmLow!;
        // Every offered deviation lies beyond the alarm band.
        for (const o of paramOptions(e.params.find((p) => p.key === 'offset')!, s)) expect(Math.abs(Number(o.value)), id).toBeGreaterThan(alarm);
        expect(def.rampMin).toBe(DEVIATION_RAMP_MIN);
        expect(paramSummary(sc)).toContain(def.signalId!);
      } else {
        expect(def.kind, id).toBe('data-quality');
        expect(def.equipmentId, id).toBeTruthy();
        if (def.signalId) expect(definitionOf(def.signalId), `${id} · ${def.signalId}`).not.toBeNull();
        expect(paramSummary(sc)).toContain(def.equipmentId!);
      }
    }
    // The four process deviations, with the reject coupling stated honestly per stage.
    expect(ENTRY_BY_ID['dev-kiln-z3'].summary).toMatch(/alarm band/);
    expect(ENTRY_BY_ID['dev-kiln-z3'].detectedBy).toContain('QL-PROCESS-ASSOCIATION');
    expect(ENTRY_BY_ID['dev-kiln-z3'].summary).toMatch(/association to investigate, not a demonstrated cause/);
    expect(ENTRY_BY_ID['dev-press2-pressure'].detectedBy).toContain('QL-PROCESS-ASSOCIATION');
    for (const id of ['dev-spray-moisture', 'dev-dryer-z2']) {
      expect(ENTRY_BY_ID[id].summary, id).toMatch(/only the value moves: no reject effect is simulated/);
      expect(ENTRY_BY_ID[id].detectedBy, id).not.toContain('QL-PROCESS-ASSOCIATION');
    }
    expect(ENTRY_BY_ID['dq-cmd-prs1'].views).toEqual([{ type: 'workspace', id: 'events', tab: 'reliability' }]);
    expect(ENTRY_BY_ID['dq-frozen-prs2'].views).toEqual([{ type: 'workspace', id: 'events', tab: 'data' }]);
    expect(ENTRY_BY_ID['dev-kiln-z3'].views).toEqual([{ type: 'workspace', id: 'quality', tab: 'compare' }]);
  });

  it('replaces only the same signal / mode, and logs a counter reset as a one-off', () => {
    const s = createSim(7, START);
    const kiln = activateScenario(s, ENTRY_BY_ID['dev-kiln-z3'].build({ offset: 35, duration: 0 }, s.minute));
    expect(sameTarget(kiln, ENTRY_BY_ID['dev-kiln-z3'].build({ offset: 25, duration: 0 }, s.minute))).toBe(true);
    expect(sameTarget(kiln, ENTRY_BY_ID['dev-dryer-z2'].build({ offset: -20, duration: 0 }, s.minute))).toBe(false);
    const bad = activateScenario(s, ENTRY_BY_ID['dq-bad-kiln'].build({ duration: 30 }, s.minute));
    expect(bad.end).toBe(s.minute + 30);
    expect(sameTarget(bad, ENTRY_BY_ID['dq-spike-dtwr'].build({ duration: 0 }, s.minute))).toBe(false);
    const reset = activateScenario(s, ENTRY_BY_ID['dq-reset-jbox'].build({}, s.minute));
    expect(isOneOff(reset)).toBe(true);
    expect(isOneOff(bad)).toBe(false);
    advance(s, s.minute + 3);
    expect(scenarioStatus(s, reset).key).toBe('applied');
    expect(outcomeOf(s, reset)).toMatch(/^Counters restarted from 0 at \d\d:\d\d$/);
    expect(scenarioStatus(s, kiln).key).toBe('active');
    expect(scenarioFocus(s, kiln)).toEqual({ type: 'equipment', id: 'H-KILN' });
    expect(scenarioFocus(s, bad)).toEqual({ type: 'equipment', id: 'H-KILN' });
    // A gap on every F-DRY signal leaves the signal out of the activation.
    const all = ENTRY_BY_ID['dq-gap-fdry'].build({ signal: '', duration: 0 }, s.minute);
    expect(all.signalId).toBeUndefined();
    expect(ENTRY_BY_ID['dq-gap-fdry'].build({ signal: 'F-DRY.zone1_temp_pv', duration: 0 }, s.minute).signalId).toBe('F-DRY.zone1_temp_pv');
  });

  it('each entry, activated alone, is detected by one of the rules it names within 30 simulated minutes', () => {
    for (const id of NEW_IDS) {
      const e = ENTRY_BY_ID[id];
      const s = createSim(7, START);
      const sc = activateScenario(s, e.build(resolveValues(e, undefined, s), s.minute));
      const eqId = (scenarioFocus(s, sc) as { id: string }).id;
      const fired = new Set<string>();
      for (const m of [5, 10, 15, 20, 30]) {
        advance(s, START + m);
        for (const f of [...findingsFor(s, { kind: 'equipment', equipmentId: eqId }), ...findingsFor(s, { kind: 'stage', stageNo: 10 })])
          if (f.status === 'fired' && (f.scope.kind !== 'stage' || f.subject === eqId)) fired.add(f.ruleId);
      }
      expect([...fired].filter((r) => e.detectedBy!.includes(r)).length, `${id}: fired ${[...fired].join(', ')}`).toBeGreaterThan(0);
    }
  });
});
