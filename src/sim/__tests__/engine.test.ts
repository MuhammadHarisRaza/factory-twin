import { describe, expect, it } from 'vitest';
import { REASON_BY_CODE } from '../../model/plant';
import { activateScenario, advance, clearScenario, createSim } from '../engine';
import { bottleneck, clippedDuration, lineMetrics, machineMetrics, qualityIn, resolvePeriod, sumBuckets } from '../metrics';

/** Two days of history keeps the tests fast. */
/** Mid-shift and on an hour boundary (reporting periods start on whole hours). */
const START = 2 * 1440 + 240;

describe('determinism and reset', () => {
  it('produces identical state for the same seed', () => {
    const a = createSim(7, START);
    const b = createSim(7, START);
    const p = resolvePeriod('24h', a.minute);
    expect(lineMetrics(a, p).output).toBe(lineMetrics(b, p).output);
    expect(a.downtime.length).toBe(b.downtime.length);
    expect(a.logistics.gateEvents.map((g) => g.time)).toEqual(b.logistics.gateEvents.map((g) => g.time));
  });

  it('differs for a different seed', () => {
    const a = createSim(7, START);
    const b = createSim(8, START);
    expect(a.downtime.map((d) => d.start)).not.toEqual(b.downtime.map((d) => d.start));
  });

  it('recreating from the seed returns to the baseline after a scenario', () => {
    const base = createSim(11, START);
    const baseOut = lineMetrics(base, resolvePeriod('shift', base.minute)).output;
    const s = createSim(11, START - 120);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, START);
    expect(lineMetrics(s, resolvePeriod('shift', s.minute)).output).toBeLessThan(baseOut);
    const again = createSim(11, START);
    expect(lineMetrics(again, resolvePeriod('shift', again.minute)).output).toBe(baseOut);
  });
});

describe('scenarios', () => {
  it('machine stoppage creates a downtime event and lowers availability', () => {
    const s = createSim(3, START);
    const p = { from: s.minute, to: s.minute + 120, label: 'test' };
    const sc = activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press 2 stop' });
    advance(s, s.minute + 60);
    const ev = s.downtime.find((d) => d.scenarioId === sc.id)!;
    expect(ev).toBeDefined();
    expect(ev.equipmentId).toBe('E-PRS2');
    expect(ev.source).toBe('scenario');
    expect(ev.end).toBeNull();
    expect(s.machines['E-PRS2'].state).toBe('down');
    clearScenario(s, sc.id);
    expect(ev.end).toBe(s.minute);
    advance(s, p.to);
    const m = machineMetrics(s, 'E-PRS2', p);
    expect(m.oee.availability.value!).toBeLessThan(0.55);
    expect(m.oee.availability.value!).toBeGreaterThan(0.3);
  });

  it('reduced rate lowers performance', () => {
    const s = createSim(4, START);
    const p = { from: s.minute, to: s.minute + 120, label: 'test' };
    activateScenario(s, { kind: 'reduced-rate', equipmentId: 'H-KILN', factor: 0.6, end: null, label: 'Kiln slow' });
    advance(s, p.to);
    const m = machineMetrics(s, 'H-KILN', p);
    expect(m.oee.performance.value!).toBeLessThan(0.62);
  });

  it('an upstream bottleneck starves the kiln only after the buffers drain', () => {
    const base = createSim(5, START);
    const s = createSim(5, START);
    activateScenario(s, { kind: 'bottleneck', stage: 'DRY', factor: 0.4, end: null, label: 'Dryer capacity loss' });
    advance(base, START + 360);
    advance(s, START + 360);
    // Extra kiln starvation caused by the scenario, compared with the baseline run.
    const extra = (from: number, to: number) => {
      const w = { from: START + from, to: START + to, label: '' };
      return sumBuckets(s, 'H-KILN', w).starved - sumBuckets(base, 'H-KILN', w).starved;
    };
    // The dryer buffer absorbs the loss for the first two hours…
    expect(extra(0, 120)).toBeLessThan(2);
    // …then the kiln is starved downstream.
    expect(extra(180, 360)).toBeGreaterThan(60);
    expect(s.buffers['BUF-DRY']).toBeLessThan(50);
    expect(bottleneck(s, 60).current.stage).toBe('DRY');
  });

  it('quality deterioration raises rejects and lowers the quality rate', () => {
    const base = createSim(6, START + 120);
    const s = createSim(6, START);
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 4, end: null, label: 'Glaze defects' });
    advance(s, START + 120);
    const p = { from: START, to: START + 120, label: '' };
    const qa = qualityIn(base, p);
    const qb = qualityIn(s, p);
    expect(qb.rejected).toBeGreaterThan(qa.rejected * 1.8);
    expect(qb.byDefect.glaze).toBeGreaterThan(qa.byDefect.glaze * 3);
    expect(lineMetrics(s, p).oee.quality.value!).toBeLessThan(lineMetrics(base, p).oee.quality.value!);
  });
});

describe('event consistency', () => {
  it('unplanned downtime minutes in the counters match the downtime events', () => {
    const s = createSim(9, START);
    const p = { from: 1440, to: 2 * 1440, label: "" };
    for (const id of ['E-PRS1', 'G-INK', 'H-KILN', 'J-BOX']) {
      const counted = sumBuckets(s, id, p).down;
      const events = s.downtime
        .filter((d) => d.equipmentId === id && !REASON_BY_CODE[d.reasonCode].planned && d.category !== 'Starved' && d.category !== 'Blocked')
        .reduce((a, d) => a + clippedDuration(d, p, s.minute), 0);
      expect(counted).toBeCloseTo(events, 6);
    }
  });

  it('line OEE is valid for every built-in period', () => {
    const s = createSim(10, START);
    for (const key of ['shift', 'prev-shift', 'today', '24h'] as const) {
      const lm = lineMetrics(s, resolvePeriod(key, s.minute));
      expect(lm.oee.issues).toEqual([]);
      expect(lm.oee.oee.status).toBe('ok');
    }
  });

  it('every record carries a timestamp and a source', () => {
    const s = createSim(12, START);
    const records = [...s.downtime, ...s.inspections, ...s.logistics.gateEvents, ...s.logistics.dockEvents, ...s.alerts];
    expect(records.length).toBeGreaterThan(100);
    for (const r of records) expect(['simulation', 'scenario']).toContain(r.source);
    expect(s.downtime.every((d) => Number.isFinite(d.start))).toBe(true);
    expect(s.inspections.every((r) => Number.isFinite(r.time))).toBe(true);
  });
});
