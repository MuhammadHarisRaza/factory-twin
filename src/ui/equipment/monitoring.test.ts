/**
 * Condition-monitoring derivations of the equipment workspace (ported from the retired Machine
 * Health page): the expected-signal model, alarm and maintenance history, condition events, the
 * condition-based maintenance gate and the chart axis helper.
 */
import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { HEALTH_ASSETS, HEALTH_BY_ID, assess, expectedTemp, expectedVib } from '../../sim/health';
import { alarmHistory, alertLevel, conditionEvents, maintenanceGate, maintenanceHistory, maintenanceUntil, niceAxisMax, signalSeries } from './monitoring';

describe('condition monitoring', () => {
  it('charts the same expected-signal model the simulation uses', () => {
    const s = createSim();
    for (const a of HEALTH_ASSETS) {
      const h = assess(s, a.id);
      expect(expectedVib(a, h.reading.load, h.reading.running)).toBeCloseTo(h.expectedVibration, 9);
      // The temperature finding fires at +4 °C over the load-corrected expectation.
      const hot = h.findings.some((f) => f.startsWith('Temperature'));
      expect(h.reading.temperature >= expectedTemp(a, h.reading.load) + 4).toBe(hot);
    }
    const series = signalSeries(s, 'H-KILN');
    const n = series.t.length;
    expect(n).toBeGreaterThan(140);
    expect(series.t[0] % 60).toBe(0);
    expect(series.t[n - 1]).toBeLessThanOrEqual(s.minute - 1);
    const dev = series.temperature.map((v, i) => Math.abs(v - series.temperatureExpected[i]));
    expect(Math.max(...dev)).toBeLessThan(HEALTH_BY_ID['H-KILN'].temp.alarm - HEALTH_BY_ID['H-KILN'].temp.full);
  });

  it('detects a developing fault, gates maintenance and keeps the history in order', () => {
    const s = createSim();
    const before = assess(s, 'E-PRS2');
    expect(maintenanceGate(before, null).enabled).toBe(before.level !== 'normal' && before.level !== 'offline');

    const sc = activateScenario(s, { kind: 'degradation', equipmentId: 'E-PRS2', end: null, label: 'Developing fault · E-PRS2' });
    advance(s, s.minute + 40);
    const sick = assess(s, 'E-PRS2');
    expect(['watch', 'warning', 'alarm', 'offline']).toContain(sick.level);
    if (sick.level !== 'offline') expect(maintenanceGate(sick, null).enabled).toBe(true);

    const hist = alarmHistory(s, 'E-PRS2', 'failures');
    for (let i = 1; i < hist.length; i++) expect(hist[i - 1].time).toBeGreaterThanOrEqual(hist[i].time);
    for (const r of hist) if (r.kind === 'stop') expect(['Mechanical', 'Electrical & control']).toContain(r.ev.category);
    expect(hist.some((r) => r.kind === 'alert')).toBe(true);

    const evs = conditionEvents(s, 'E-PRS2');
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.type === 'condition-abnormal' && e.asset.equipmentId === 'E-PRS2')).toBe(true);
    expect(evs.some((e) => e.refs.scenarioId === sc.id)).toBe(true);

    activateScenario(s, { kind: 'maintenance', equipmentId: 'E-PRS2', count: 45, end: null, label: 'Condition-based maintenance · E-PRS2' });
    const until = maintenanceUntil(s, 'E-PRS2');
    expect(until).toBe(s.minute + 45);
    expect(maintenanceGate(assess(s, 'E-PRS2'), until)).toEqual({ enabled: false, reason: expect.stringMatching(/^Maintenance in progress until/) });
    expect(maintenanceHistory(s, 'E-PRS2')[0].type).toBe('Condition-based');
    advance(s, s.minute + 46);
    expect(maintenanceUntil(s, 'E-PRS2')).toBeNull();
    const all = alarmHistory(s, 'E-PRS2', 'all');
    expect(all.some((r) => r.kind === 'stop' && r.ev.reasonCode === 'PLN_MAINT')).toBe(true);
    expect(all.every((r) => r.kind !== 'stop' || (r.ev.category !== 'Starved' && r.ev.category !== 'Blocked'))).toBe(true);
  });

  it('picks round axis bounds and reads alert levels', () => {
    expect(niceAxisMax(11.2)).toBe(12);
    expect(niceAxisMax(7.1)).toBe(8);
    expect(niceAxisMax(95, 20)).toBe(100);
    expect(niceAxisMax(304)).toBe(320);
    expect(alertLevel('Condition monitoring: C-BM2 alarm')).toBe('alarm');
    expect(alertLevel('Condition monitoring: E-PRS1 warning')).toBe('warning');
    expect(alertLevel('Condition monitoring: F-DRY watch')).toBe('watch');
  });
});
