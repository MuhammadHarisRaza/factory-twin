import { describe, expect, it } from 'vitest';
import type { OpEvent } from '../../../model/types';
import { activateScenario, advance, createSim, type SimState } from '../../../sim/engine';
import { operationalState } from '../../../sim/metrics';
import {
  HOLD_END_GAP,
  bottleneckTitle,
  conveyorMark,
  conveyorRuns,
  conveyorTagAnchor,
  createBelt,
  outletHeld,
  outlineLoop,
  polylineMid,
  qualityEventsByStation,
  seedBelt,
  staleFeeds,
  stepBelt,
  type BottleneckInfo,
} from '../model';

const START = 2 * 1440 + 300;

describe('belt accumulation', () => {
  const drive = { length: 10, targetSpeed: 1, emitPerSec: 1, minGap: 0.7 };

  it('queues items at a held outlet instead of letting them leave, minGap apart', () => {
    const b = createBelt(30);
    for (let i = 0; i < 1800; i++) stepBelt(b, 1 / 60, { ...drive, hold: true });
    // The queue is packed from the outlet backwards and fills the belt.
    expect(b.pos[0]).toBeCloseTo(10 - HOLD_END_GAP, 5);
    expect(b.n).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < b.n; i++) expect(b.pos[i - 1] - b.pos[i]).toBeGreaterThanOrEqual(0.7 - 1e-5);
    for (let i = 0; i < b.n; i++) expect(b.pos[i]).toBeLessThanOrEqual(10 - HOLD_END_GAP + 1e-5);
  });

  it('items already at the end when the outlet is held stay on the belt', () => {
    const b = createBelt(30);
    seedBelt(b, 10, 1.5);
    const before = b.n;
    const last = b.pos[0];
    for (let i = 0; i < 600; i++) stepBelt(b, 1 / 60, { ...drive, hold: true });
    expect(b.n).toBeGreaterThanOrEqual(before);
    expect(b.pos[0]).toBeCloseTo(last, 5);
  });

  it('releases the queue once the outlet takes items again', () => {
    const b = createBelt(30);
    for (let i = 0; i < 1200; i++) stepBelt(b, 1 / 60, { ...drive, hold: true });
    const held = b.n;
    for (let i = 0; i < 1200; i++) stepBelt(b, 1 / 60, { ...drive, emitPerSec: 0 });
    expect(held).toBeGreaterThan(5);
    expect(b.n).toBe(0);
  });

  it('a stopped belt keeps its items where they are, held or not', () => {
    const b = createBelt(30);
    seedBelt(b, 10, 1.2);
    const before = Array.from(b.pos.slice(0, b.n));
    for (let i = 0; i < 300; i++) stepBelt(b, 1 / 60, { ...drive, targetSpeed: 0, emitPerSec: 0, hold: true });
    expect(Array.from(b.pos.slice(0, b.n))).toEqual(before);
  });
});

describe('conveyor state marks', () => {
  it('maps operational states to marks', () => {
    expect(conveyorMark('stopped')).toBe('stopped');
    expect(conveyorMark('fault')).toBe('stopped');
    expect(conveyorMark('blocked')).toBe('blocked');
    expect(conveyorMark('planned')).toBe('planned');
    for (const op of ['running', 'idle', 'unknown', 'reduced', 'starved'] as const) expect(conveyorMark(op)).toBeNull();
  });

  it('a stopped conveyor is marked stopped and the conveyor feeding it accumulates', () => {
    const s = createSim(11, START);
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: null, label: 'Kiln infeed stop' });
    advance(s, s.minute + 2);
    const kin = conveyorRuns(s).find((r) => r.id === 'CV-KIN');
    expect(kin).toMatchObject({ mark: 'stopped', scenario: true });
    expect(kin!.reason).toBe('Simulated conveyor stop (scenario)');
    expect(kin!.since).toBeLessThanOrEqual(s.minute);
    // Decoration cannot discharge onto the stopped transfer: its belt holds.
    expect(outletHeld(s, ['CV-KIN'])).toBe(true);
    advance(s, s.minute + 40);
    const glz = conveyorRuns(s).find((r) => r.id === 'CV-GLZ');
    expect(operationalState(s, 'CV-GLZ')).toBe('blocked');
    expect(glz?.mark).toBe('blocked');
    expect(glz?.reason).toBeNull();
  });

  it('marks only conveyors that are not simply running or idle', () => {
    const s = createSim(11, START);
    for (const r of conveyorRuns(s)) expect(['stopped', 'fault', 'blocked', 'planned']).toContain(operationalState(s, r.id));
  });

  it('outletHeld follows the receivers: down, planned or blocked hold, starved does not', () => {
    const s = createSim(11, START);
    s.machines['F-DRY'].state = 'starved';
    expect(outletHeld(s, ['F-DRY'])).toBe(false);
    s.machines['F-DRY'].state = 'blocked';
    expect(outletHeld(s, ['F-DRY'])).toBe(true);
    expect(outletHeld(s, undefined)).toBe(false);
    expect(outletHeld(s, ['NOPE'])).toBe(false);
  });
});

describe('conveyor geometry helpers', () => {
  it('outlineLoop is a closed loop at `half` from a straight run, ends extended', () => {
    const loop = outlineLoop(
      [
        [0, 1, 0],
        [10, 1, 0],
      ],
      0.5,
      0.1,
      0.2,
    );
    expect(loop[0]).toEqual(loop[loop.length - 1]);
    expect(loop).toHaveLength(5);
    const xs = loop.map((p) => p[0]);
    const zs = loop.map((p) => p[2]);
    expect(Math.min(...xs)).toBeCloseTo(-0.2);
    expect(Math.max(...xs)).toBeCloseTo(10.2);
    expect(Math.min(...zs)).toBeCloseTo(-0.5);
    expect(Math.max(...zs)).toBeCloseTo(0.5);
    for (const p of loop) expect(p[1]).toBeCloseTo(1.1);
  });

  it('outlineLoop keeps its offset around a bend (mitred corners)', () => {
    const loop = outlineLoop(
      [
        [0, 0, 0],
        [10, 0, 0],
        [10, 0, 10],
      ],
      1,
      0,
      0,
    );
    // Both corner vertices of the bend lie on its diagonal, sqrt(2) x half from the centre-line vertex.
    const d = loop.map((p) => Math.hypot(p[0] - 10, p[2]));
    expect(d.filter((x) => Math.abs(x - Math.SQRT2) < 1e-6).length).toBeGreaterThanOrEqual(2);
  });

  it('polylineMid / conveyorTagAnchor sit at half the arc length, above the belt', () => {
    const pts: [number, number, number][] = [
      [0, 1, 0],
      [10, 1, 0],
      [10, 1, 10],
    ];
    expect(polylineMid(pts)).toEqual([10, 1, 0]);
    expect(conveyorTagAnchor(pts)[1]).toBeCloseTo(2.3);
  });
});

describe('data feeds and quality events', () => {
  it('a lost PLC link makes the asset stale (unknown state) with the time it went stale', () => {
    const s = createSim(11, START);
    expect(staleFeeds(s)).toEqual([]);
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'PLC link lost' });
    advance(s, s.minute + 3);
    const f = staleFeeds(s).find((x) => x.id === 'E-PRS2');
    expect(f).toBeDefined();
    expect(f!.since).toBeLessThanOrEqual(s.minute);
    expect(operationalState(s, 'E-PRS2')).toBe('unknown');
  });

  const ev = (over: Partial<OpEvent>): OpEvent =>
    ({
      id: 'EV-1',
      category: 'quality',
      type: 'defect-rate',
      severity: 'warning',
      status: 'active',
      title: 'Reject rate above threshold',
      end: null,
      asset: {},
      ...over,
    }) as OpEvent;

  it('counts active quality events per inspection station, red when one is critical', () => {
    const s = {
      events: [
        ev({ id: 'EV-1', asset: { stationId: 'ST-VIS', equipmentId: 'I-VIS' } }),
        ev({ id: 'EV-2', severity: 'critical', asset: { equipmentId: 'I-GAUGE' } }),
        ev({ id: 'EV-3', asset: { stationId: 'ST-VIS' }, end: 100 }),
        ev({ id: 'EV-4', asset: { stationId: 'ST-VIS' }, status: 'resolved' }),
        ev({ id: 'EV-5', category: 'production', asset: { equipmentId: 'I-VIS' } }),
        ev({ id: 'EV-6', asset: { stage: 'GLAZE' } }),
      ],
    } as unknown as SimState;
    const q = qualityEventsByStation(s);
    expect(q['ST-VIS']).toMatchObject({ count: 1, level: 'amber' });
    expect(q['ST-GAUGE']).toMatchObject({ count: 1, level: 'red' });
    expect(q['ST-QC']).toBeUndefined();
    // The line total also includes events without a station.
    expect(q.line).toMatchObject({ count: 3, level: 'red' });
    expect(q.line.events.map((e) => e.id)).toEqual(['EV-1', 'EV-2', 'EV-6']);
  });
});

describe('bottleneck label (finding #3)', () => {
  const info: BottleneckInfo = {
    stage: 'KILN',
    name: 'Firing',
    machines: ['H-KILN'],
    shifted: false,
    activeShare: 1,
    workingShare: 0.2,
    downShare: 0.8,
    periodLabel: 'Last 120 min',
  };

  it('a stopped stage reads as down, never as working 100 %', () => {
    const t = bottleneckTitle(info, 'Single-layer roller kiln');
    expect(t).toContain('producing 20 %');
    expect(t).toContain('down 80 %');
    expect(t).toContain('waiting on neighbouring stages 0 %');
    expect(t).toContain('last 120 min');
    expect(t).not.toContain('100 %');
  });

  it('omits the downtime part when the stage was not down and flags a shifted constraint', () => {
    const t = bottleneckTitle(
      { ...info, stage: 'SORT', name: 'Sorting & inspection', activeShare: 0.9, workingShare: 0.9, downShare: 0, shifted: true },
      'Diverters',
    );
    expect(t).toContain('producing 90 %');
    expect(t).not.toContain('down ');
    expect(t).toContain('waiting on neighbouring stages 10 %');
    expect(t).toContain('shifted from the kiln');
  });
});
