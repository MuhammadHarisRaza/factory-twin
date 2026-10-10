/**
 * End-to-end consistency of the demo workflows at engine level: every view in the UI is
 * computed from these same functions, so if they reconcile here they reconcile on screen.
 */
import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../engine';
import { assess } from '../health';
import { ask, SUGGESTED_QUESTIONS } from '../../intel/copilot';
import { insights } from '../../intel/insights';
import {
  bottleneck,
  energyIn,
  impactVsBaseline,
  internalActivity,
  internalVehicles,
  lineMetrics,
  qualityIn,
  resolvePeriod,
  sumBuckets,
} from '../metrics';

/** Mid-shift, on an hour boundary. */
const START = 2 * 1440 + 240;
const win = (from: number, to: number) => ({ from, to, label: 'test' });

describe('Scenario B · machine breakdown', () => {
  it('stops the machine and every dependent figure responds consistently', () => {
    const base = createSim(31, START);
    const s = createSim(31, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln breakdown' });
    advance(base, START + 60);
    advance(s, START + 60);

    // 3D / inspector state
    expect(s.machines['H-KILN'].state).toBe('down');
    // Downtime event
    const ev = s.downtime.find((d) => d.equipmentId === 'H-KILN' && d.source === 'scenario')!;
    expect(ev.end).toBeNull();
    expect(ev.lostTiles).toBeCloseTo((1250 / 60) * 60, 0);
    // Output & OEE vs the no-scenario baseline over the same hour
    const p = win(START, START + 60);
    const impact = impactVsBaseline(s, base, p);
    expect(impact.deltaOutputM2).toBeLessThan(-200);
    expect(impact.deltaOeePts!).toBeLessThan(-40);
    expect(sumBuckets(s, 'H-KILN', p).down).toBe(60);
    // OEE equals A × P × Q exactly
    const lm = lineMetrics(s, resolvePeriod('shift', s.minute));
    expect(lm.oee.oee.value!).toBeCloseTo(lm.oee.availability.value! * lm.oee.performance.value! * lm.oee.quality.value!, 12);
    // Command center & copilot
    const top = insights(s)[0];
    expect(top.kind).toBe('stoppage');
    expect(top.equipmentId).toBe('H-KILN');
    expect(top.recommendation).toBeTruthy();
    const a = ask(s, 'What should the shift supervisor do next?');
    expect(a.intent).toBe('next-actions');
    expect(a.text.join(' ')).toContain('H-KILN');
  });
});

describe('Scenario A · production bottleneck', () => {
  it('reduces throughput downstream only after the buffer drains, and is identified', () => {
    const base = createSim(32, START);
    const s = createSim(32, START);
    activateScenario(s, { kind: 'bottleneck', stage: 'DRY', factor: 0.45, end: null, label: 'Dryer capacity' });
    advance(base, START + 360);
    advance(s, START + 360);
    const early = impactVsBaseline(s, base, win(START, START + 60));
    const late = impactVsBaseline(s, base, win(START + 240, START + 360));
    // Buffered at first, then a real loss of line output.
    expect(Math.abs(early.deltaOutputM2)).toBeLessThan(25);
    expect(late.deltaOutputM2).toBeLessThan(-300);
    expect(bottleneck(s, 60).current.stage).toBe('DRY');
    expect(insights(s).some((i) => i.kind === 'bottleneck' && i.title.includes('Drying'))).toBe(true);
    expect(ask(s, 'Which machine is the main bottleneck?').text[0]).toContain('Drying');
  });
});

describe('Scenario C · quality deterioration', () => {
  it('rejected counts, quality rate and OEE reconcile', () => {
    const s = createSim(33, START);
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 4, end: null, label: 'Glaze defects' });
    advance(s, START + 180);
    const p = win(START, START + 180);
    const q = qualityIn(s, p);
    const lm = lineMetrics(s, p);
    expect(q.accepted + q.rejected).toBeCloseTo(q.inspected, 6);
    expect(lm.rejected).toBeCloseTo(q.rejected, 6);
    expect(lm.oee.quality.value!).toBeCloseTo(q.accepted / q.inspected, 12);
    expect(lm.oee.oee.value!).toBeCloseTo(lm.oee.availability.value! * lm.oee.performance.value! * lm.oee.quality.value!, 12);
    // Records and buckets agree: illustrative records represent the rejected tiles (6 tiles each, remainder carried).
    const recTiles = s.inspections.filter((r) => r.result === 'reject' && r.time >= p.from && r.time < p.to && r.stationId !== 'ST-QC').reduce((a, r) => a + r.tiles, 0);
    expect(Math.abs(recTiles - q.rejected)).toBeLessThan(6 * 7 + 1);
    const qi = insights(s).find((i) => i.kind === 'quality');
    expect(qi).toBeTruthy();
    expect(['Surface blemish', 'Glaze inconsistency'].some((l) => qi!.title.toLowerCase().includes(l.toLowerCase()))).toBe(true);
  });
});

describe('Scenario D · energy anomaly', () => {
  it('raises the affected consumer above its model and costs it', () => {
    const s = createSim(34, START);
    activateScenario(s, { kind: 'energy-anomaly', equipmentId: 'H-KILN', factor: 1.2, end: null, label: 'Kiln combustion drift' });
    advance(s, START + 120);
    const e = energyIn(s, win(START, START + 120));
    const kiln = e.rows.find((r) => r.id === 'H-KILN')!;
    expect(kiln.deviation!).toBeGreaterThan(0.16);
    expect(kiln.deviation!).toBeLessThan(0.24);
    const others = e.rows.filter((r) => r.id !== 'H-KILN' && r.deviation != null);
    for (const r of others) expect(Math.abs(r.deviation!)).toBeLessThan(0.04);
    expect(e.excessCost).toBeCloseTo(e.cost - e.expectedCost, 9);
    expect(s.alerts.some((a) => a.title.startsWith('Energy anomaly: H-KILN'))).toBe(true);
    expect(insights(s).some((i) => i.kind === 'energy' && i.equipmentId === 'H-KILN')).toBe(true);
  });
});

describe('Scenario E · developing machine fault', () => {
  it('is detected from signals before it fails, and fails if ignored', () => {
    const s = createSim(35, START);
    expect(assess(s, 'E-PRS2').level).toBe('normal');
    activateScenario(s, { kind: 'degradation', equipmentId: 'E-PRS2', end: null, label: 'Pump wear' });
    const levels: string[] = [];
    let tripAt: number | null = null;
    for (let i = 0; i < 24 && tripAt == null; i++) {
      advance(s, s.minute + 10);
      levels.push(assess(s, 'E-PRS2').level);
      if (s.downtime.some((d) => d.equipmentId === 'E-PRS2' && d.reasonCode === 'MECH_HYD' && d.start >= START)) tripAt = s.minute;
    }
    expect(levels.indexOf('warning')).toBeGreaterThanOrEqual(0);
    expect(tripAt).not.toBeNull();
    // Warned before it failed.
    expect(levels.indexOf('warning')).toBeLessThan(levels.length - 1);
  });

  it('condition-based maintenance before failure prevents the breakdown', () => {
    const s = createSim(36, START);
    activateScenario(s, { kind: 'degradation', equipmentId: 'E-PRS2', end: null, label: 'Pump wear' });
    advance(s, s.minute + 40);
    expect(['watch', 'warning', 'alarm']).toContain(assess(s, 'E-PRS2').level);
    activateScenario(s, { kind: 'maintenance', equipmentId: 'E-PRS2', count: 40, end: null, label: 'Fix pump' });
    advance(s, s.minute + 240);
    expect(s.downtime.some((d) => d.equipmentId === 'E-PRS2' && d.reasonCode === 'MECH_HYD' && d.start >= START)).toBe(false);
    expect(s.downtime.some((d) => d.equipmentId === 'E-PRS2' && d.reasonCode === 'PLN_MAINT')).toBe(true);
    expect(assess(s, 'E-PRS2').level).toBe('normal');
  });
});

describe('Vehicle monitoring', () => {
  it('vehicles move and dwell times grow while they stay in a zone', () => {
    const s = createSim(37, START);
    const lg = s.logistics;
    const fl = lg.vehicles['FL-05'];
    const a = internalActivity(fl, s.minute);
    advance(s, s.minute + 5);
    const b = internalActivity(lg.vehicles['FL-05'], s.minute);
    // Either still in the same zone (dwell grew by 5 min) or it changed zone (dwell restarted).
    if (a.zone === b.zone) expect(b.dwell!).toBeGreaterThanOrEqual(a.dwell! + 5 - 1e-9);
    else expect(b.dwell!).toBeLessThanOrEqual(5);
    activateScenario(s, { kind: 'yard-congestion', count: 10, end: null, label: 'Congestion' });
    advance(s, s.minute + 30);
    const waiting = lg.active.map((id) => lg.vehicles[id]).filter((v) => v.phase === 'waiting');
    expect(waiting.length).toBeGreaterThanOrEqual(3);
  });

  it('dwell time never shrinks while a vehicle stays in the same zone (8 h, every minute)', () => {
    const s = createSim(41, START);
    const ids = internalVehicles(s).map((v) => v.id);
    const last: Record<string, { zone: string | null; dwell: number | null }> = {};
    for (let i = 0; i < 480; i++) {
      advance(s, s.minute + 1);
      for (const id of ids) {
        const a = internalActivity(s.logistics.vehicles[id], s.minute);
        const prev = last[id];
        if (prev && prev.zone === a.zone && prev.dwell != null && a.dwell != null && a.dwell < prev.dwell)
          // Only a fresh entry into the same zone (left and came back within the minute) may restart it.
          expect(a.dwell).toBeLessThanOrEqual(1);
        last[id] = { zone: a.zone, dwell: a.dwell };
      }
    }
  });
});

describe('Baseline twin', () => {
  it('createSim(seed, m) is identical to the live run without scenarios', () => {
    const live = createSim(38, START);
    advance(live, START + 90);
    const twin = createSim(38, START + 90);
    const p = win(START, START + 90);
    expect(lineMetrics(twin, p).output).toBe(lineMetrics(live, p).output);
    expect(energyIn(twin, p).total).toBe(energyIn(live, p).total);
    expect(impactVsBaseline(live, twin, p).deltaOutputM2).toBe(0);
  });
});

describe('Copilot', () => {
  it('answers every suggested question from the state', () => {
    const s = createSim(39, START);
    for (const q of SUGGESTED_QUESTIONS) {
      const a = ask(s, q);
      expect(a.intent).not.toBe('help');
      expect(a.text.join(' ').length).toBeGreaterThan(40);
    }
    expect(ask(s, 'How is press 2 doing?').intent).toBe('machine');
    expect(ask(s, 'hello').intent).toBe('help');
  });

  it('numbers in the answer match the metrics', () => {
    const s = createSim(40, START);
    const lm = lineMetrics(s, resolvePeriod('today', s.minute));
    const a = ask(s, "Why is today's production below target?");
    expect(a.facts.find((f) => f.label === 'OEE')!.value).toBe(`${(lm.oee.oee.value! * 100).toFixed(1)} %`);
  });
});
