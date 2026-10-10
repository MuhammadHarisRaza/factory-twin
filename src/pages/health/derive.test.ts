import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { HEALTH_ASSETS, HEALTH_BY_ID, assess } from '../../sim/health';
import {
  alarmHistory,
  alertLevel,
  assetRows,
  byConcern,
  expectedTemperature,
  expectedVibration,
  faultGate,
  fleetSummary,
  maintenanceGate,
  maintenanceHistory,
  niceAxisMax,
  signalSeries,
} from './derive';

describe('machine health derivations', () => {
  it('ranks assets worst first and summarises the fleet', () => {
    const s = createSim();
    const rows = assetRows(s);
    expect(rows).toHaveLength(HEALTH_ASSETS.length);
    for (let i = 1; i < rows.length; i++) expect(byConcern(rows[i - 1], rows[i])).toBeLessThanOrEqual(0);
    const f = fleetSummary(rows);
    expect(f.monitored).toBe(HEALTH_ASSETS.length);
    expect(f.alarm + f.warning + f.watch + f.notRunning).toBeLessThanOrEqual(f.monitored);
    if (f.lowest) expect(f.lowest.h.level).not.toBe('offline');
    for (const r of f.pmSoon) expect(r.h.pmDueH).toBeLessThan(100);
  });

  it('mirrors the expected-signal model of the simulation', () => {
    const s = createSim();
    for (const a of HEALTH_ASSETS) {
      const h = assess(s, a.id);
      expect(expectedVibration(a, h.reading.load, h.reading.running)).toBeCloseTo(h.expectedVibration, 9);
      // The temperature finding fires at +4 °C over the load-corrected expectation.
      const hot = h.findings.some((f) => f.startsWith('Temperature'));
      expect(h.reading.temperature >= expectedTemperature(a, h.reading.load) + 4).toBe(hot);
    }
    // Healthy, running asset: the temperature stays near the load-corrected expectation.
    const series = signalSeries(s, 'H-KILN');
    const n = series.t.length;
    expect(n).toBeGreaterThan(140);
    expect(series.t[0] % 60).toBe(0);
    expect(series.t[n - 1]).toBeLessThanOrEqual(s.minute - 1);
    const dev = series.temperature.map((v, i) => Math.abs(v - series.temperatureExpected[i]));
    expect(Math.max(...dev)).toBeLessThan(HEALTH_BY_ID['H-KILN'].temp.alarm - HEALTH_BY_ID['H-KILN'].temp.full);
  });

  it('detects a simulated fault and gates the actions', () => {
    const s = createSim();
    const before = assetRows(s).find((r) => r.id === 'E-PRS2')!;
    expect(faultGate(before, null, s.minute).enabled).toBe(before.h.level === 'normal' || before.h.level === 'offline');
    expect(faultGate(before, s.minute, s.minute).enabled).toBe(false);

    activateScenario(s, { kind: 'degradation', equipmentId: 'E-PRS2', end: null, label: 'Developing fault · E-PRS2' });
    advance(s, s.minute + 40);
    const sick = assetRows(s).find((r) => r.id === 'E-PRS2')!;
    expect(['watch', 'warning', 'alarm', 'offline']).toContain(sick.h.level);
    if (sick.h.level !== 'offline') {
      expect(maintenanceGate(sick).enabled).toBe(true);
      expect(faultGate(sick, null, s.minute).enabled).toBe(false);
    }
    const hist = alarmHistory(s, 'E-PRS2', 'failures');
    for (let i = 1; i < hist.length; i++) expect(hist[i - 1].time).toBeGreaterThanOrEqual(hist[i].time);
    for (const r of hist) if (r.kind === 'stop') expect(['Mechanical', 'Electrical & control']).toContain(r.ev.category);
    expect(hist.some((r) => r.kind === 'alert')).toBe(true);

    activateScenario(s, { kind: 'maintenance', equipmentId: 'E-PRS2', count: 45, end: null, label: 'Condition-based maintenance · E-PRS2' });
    const during = assetRows(s).find((r) => r.id === 'E-PRS2')!;
    expect(during.maintenanceUntil).toBe(s.minute + 45);
    expect(maintenanceGate(during).enabled).toBe(false);
    expect(faultGate(during, null, s.minute).enabled).toBe(false);
    expect(maintenanceHistory(s, 'E-PRS2')[0].type).toBe('Condition-based');
    advance(s, s.minute + 46);
    expect(assetRows(s).find((r) => r.id === 'E-PRS2')!.maintenanceUntil).toBeNull();
    const all = alarmHistory(s, 'E-PRS2', 'all');
    expect(all.some((r) => r.kind === 'stop' && r.ev.reasonCode === 'PLN_MAINT')).toBe(true);
    expect(all.every((r) => r.kind !== 'stop' || (r.ev.category !== 'Starved' && r.ev.category !== 'Blocked'))).toBe(true);
  });

  it('picks round axis bounds', () => {
    expect(niceAxisMax(11.2)).toBe(12);
    expect(niceAxisMax(7.1)).toBe(8);
    expect(niceAxisMax(95, 20)).toBe(100);
    expect(niceAxisMax(304)).toBe(320);
    for (const [max, min] of [[0.3, 0], [62, 20], [4.5, 0], [1234, 0]]) {
      const top = niceAxisMax(max, min);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(top - min).toBeLessThanOrEqual((max - min) * 2.01);
    }
  });

  it('reads the level from condition-monitoring alert titles', () => {
    expect(alertLevel('Condition monitoring: C-BM2 alarm')).toBe('alarm');
    expect(alertLevel('Condition monitoring: E-PRS1 warning')).toBe('warning');
    expect(alertLevel('Condition monitoring: F-DRY watch')).toBe('watch');
  });
});
