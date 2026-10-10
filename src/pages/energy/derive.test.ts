import { describe, expect, it } from 'vitest';
import { insights } from '../../intel/insights';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { energyIn, resolvePeriod } from '../../sim/metrics';
import {
  anomalyLabel,
  devLevel,
  findAnomalies,
  fmtMoney,
  fmtSigned,
  hourlyEnergy,
  kilnIdle,
  largestDeviation,
  parseAmount,
  parseCurrency,
  recentWindow,
  secTrend,
} from './derive';

const START = 2 * 1440 + 240 + 20;
const energyInsights = (s: ReturnType<typeof createSim>) => insights(s, { tariffs: DEFAULT_TARIFFS }).filter((i) => i.kind === 'energy');

describe('energy page derivations', () => {
  it('flags nothing without an anomaly and everything stays near the model', () => {
    const s = createSim(41, START);
    const p = resolvePeriod('shift', s.minute);
    expect(findAnomalies(s, p, DEFAULT_TARIFFS, energyInsights(s))).toEqual([]);
    const e = energyIn(s, p, DEFAULT_TARIFFS);
    const top = largestDeviation(e.rows);
    expect(top).not.toBeNull();
    expect(Math.abs(top!.deviation!)).toBeLessThan(0.08);
  });

  it('detects a simulated anomaly in the last hour and projects its cost', () => {
    const s = createSim(42, START);
    activateScenario(s, { kind: 'energy-anomaly', equipmentId: 'H-KILN', factor: 1.2, end: null, label: anomalyLabel('H-KILN', 1.2) });
    advance(s, s.minute + 20);
    const p = resolvePeriod('shift', s.minute);
    const rows = findAnomalies(s, p, DEFAULT_TARIFFS, energyInsights(s));
    expect(rows.map((r) => r.id)).toEqual(['H-KILN']);
    const k = rows[0];
    expect(k.active).toBe(true);
    expect(k.gas).toBe(true);
    expect(k.recentDev!).toBeGreaterThan(0.08);
    expect(k.level).not.toBe('ok');
    expect(k.excessKwh).toBeGreaterThan(0);
    expect(k.excessCostPerH).toBeGreaterThan(0);
    expect(k.projectedMonth!).toBeCloseTo(k.excessCostPerH * 720, 6);
    expect(k.recommendation).toMatch(/combustion/i);
    expect(k.recommendationSource).toBe("early");
    advance(s, s.minute + 90);
    const later = findAnomalies(s, resolvePeriod("shift", s.minute), DEFAULT_TARIFFS, energyInsights(s));
    expect(later[0].recommendationSource).toBe("insight");
    expect(later[0].recommendation).toMatch(/combustion/i);
  });

  it('pro-rates the in-progress hour and keeps complete hours as measured', () => {
    const s = createSim(43, START);
    const p = resolvePeriod('shift', s.minute);
    const h = hourlyEnergy(s, p);
    expect(h.length).toBeGreaterThan(1);
    const last = h[h.length - 1];
    expect(last.minutes).toBe(s.minute - last.start);
    expect(last.actualRate).toBeCloseTo((last.actual * 60) / last.minutes, 6);
    for (const x of h.slice(0, -1)) {
      expect(x.minutes).toBe(60);
      expect(x.actualRate).toBeCloseTo(x.actual, 6);
    }
    const one = hourlyEnergy(s, p, 'H-KILN');
    expect(one[0].actual).toBeLessThan(h[0].actual);
    const sec = secTrend(s, p);
    expect(sec.length).toBe(h.length);
    expect(sec.some((x) => x.sec != null && x.sec > 0)).toBe(true);
  });

  it('reports kiln idle burn consistently with its idle minutes', () => {
    const s = createSim(44, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'G-LINE', end: null, label: 'Glaze stop' });
    advance(s, s.minute + 120);
    const p = resolvePeriod('24h', s.minute);
    const k = kilnIdle(s, p, DEFAULT_TARIFFS);
    expect(k.kwh).toBeCloseTo(((k.starvedMin + k.blockedMin) / 60) * 3400, 6);
    expect(k.cost).toBeCloseTo(k.kwh * DEFAULT_TARIFFS.gas, 6);
    if (k.kwh > 0) expect(k.shareOfKilnGas!).toBeGreaterThan(0);
  });

  it('windows, levels, formats and parses', () => {
    expect(recentWindow(600 + 45)).toMatchObject({ from: 600, to: 645 });
    expect(recentWindow(600 + 10)).toMatchObject({ from: 600, to: 610 });
    expect(recentWindow(600 + 9)).toMatchObject({ from: 540, to: 609 });
    expect(devLevel(0.05)).toBe('ok');
    expect(devLevel(0.1)).toBe('warning');
    expect(devLevel(-0.2)).toBe('critical');
    expect(fmtSigned(0.1234)).toBe('+12.3 %');
    expect(fmtSigned(-0.03)).toBe('−3.0 %');
    expect(fmtMoney(1234.4, 'USD')).toBe('USD 1,234');
    expect(fmtMoney(-0.001, 'EUR')).toBe('EUR 0.00');
    expect(parseAmount('0,12', 10)).toBe(0.12);
    expect(parseAmount('.5', 10)).toBe(0.5);
    expect(parseAmount('-1', 10)).toBeNull();
    expect(parseAmount('abc', 10)).toBeNull();
    expect(parseAmount('12', 10)).toBeNull();
    expect(parseCurrency(' pkr ')).toBe('PKR');
    expect(parseCurrency('US')).toBeNull();
    expect(anomalyLabel('H-KILN', 1.2)).toBe('Kiln combustion-air drift +20 %');
  });
});
