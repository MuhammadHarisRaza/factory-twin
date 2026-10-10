import { describe, expect, it } from 'vitest';
import { FLOW_PATHS } from '../../../data/layout';
import type { Vehicle, VehicleLeg } from '../../../model/types';
import { activateScenario, advance, createSim } from '../../../sim/engine';
import { poseAt } from '../../../sim/logistics';
import { DEFAULT_START } from '../../../sim/time';
import {
  bottleneckInfo,
  createBelt,
  energyFlags,
  groupFlow,
  healthFlags,
  machineFlow,
  perVersion,
  plannedRoute,
  pointAt,
  polyline,
  qualityStatus,
  routeFlow,
  routeProgress,
  seedBelt,
  splitRoute,
  stageFlow,
  stepBelt,
} from '../model';

const START = 2 * 1440 + 300;

describe('polyline', () => {
  it('measures arc length and interpolates position and heading', () => {
    const pl = polyline([
      [0, 1, 0],
      [10, 1, 0],
      [10, 1, 5],
    ]);
    expect(pl.length).toBeCloseTo(15);
    const p = pointAt(pl, 12, { x: 0, y: 0, z: 0, yaw: 0 });
    expect(p.x).toBeCloseTo(10);
    expect(p.z).toBeCloseTo(2);
    expect(p.yaw).toBeCloseTo(-Math.PI / 2);
    expect(pointAt(pl, 99, p).z).toBeCloseTo(5);
    expect(pointAt(pl, -3, p).x).toBeCloseTo(0);
  });
});

describe('splitRoute', () => {
  it('splits at listed vertices, sharing the boundary vertex', () => {
    const pts: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    const r = splitRoute(pts, [{ at: [1, 0], value: 'b' }, { at: [3, 0], value: 'ignored' }], 'a');
    expect(r).toEqual([
      { from: 0, to: 1, value: 'a' },
      { from: 1, to: 3, value: 'b' },
    ]);
  });

  it('covers every flow route without gaps', () => {
    for (const path of FLOW_PATHS) {
      const r = splitRoute(path.pts, [{ at: path.pts[1], value: 1 }], 0);
      expect(r[0].from).toBe(0);
      expect(r[r.length - 1].to).toBe(path.pts.length - 1);
      for (let i = 1; i < r.length; i++) expect(r[i].from).toBe(r[i - 1].to);
    }
  });
});

describe('belt', () => {
  const drive = { length: 10, targetSpeed: 1, emitPerSec: 1, minGap: 0.7 };

  it('emits items at the feeding rate and moves them along', () => {
    const b = createBelt(20);
    for (let i = 0; i < 600; i++) stepBelt(b, 1 / 60, drive);
    // 10 s at 1 item/s on a 10 m belt moving ≈ 1 m/s.
    expect(b.n).toBeGreaterThanOrEqual(8);
    expect(b.n).toBeLessThanOrEqual(11);
    for (let i = 1; i < b.n; i++) expect(b.pos[i - 1] - b.pos[i]).toBeGreaterThanOrEqual(0.69);
    for (let i = 0; i < b.n; i++) expect(b.pos[i]).toBeLessThanOrEqual(10);
  });

  it('stands still (and emits nothing) when the feeding machine stops', () => {
    const b = createBelt(20);
    seedBelt(b, 10, 1.2);
    const before = Array.from(b.pos.slice(0, b.n));
    for (let i = 0; i < 300; i++) stepBelt(b, 1 / 60, { ...drive, targetSpeed: 0, emitPerSec: 0 });
    expect(b.speed).toBe(0);
    expect(Array.from(b.pos.slice(0, b.n))).toEqual(before);
  });

  it('spaces items further apart at a reduced rate', () => {
    const full = createBelt(40);
    const half = createBelt(40);
    for (let i = 0; i < 1200; i++) {
      stepBelt(full, 1 / 60, { ...drive, length: 30 });
      stepBelt(half, 1 / 60, { ...drive, length: 30, emitPerSec: 0.5 });
    }
    expect(half.n).toBeLessThan(full.n * 0.7);
  });
});

describe('throughput', () => {
  it('follows machine state: a stopped kiln stops its section', () => {
    const s = createSim(11, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, s.minute + 2);
    expect(machineFlow(s, 'H-KILN')).toEqual({ rate: 0, moving: false });
    expect(stageFlow(s, 'KILN')).toBe(0);
    expect(routeFlow(s, ['KILN'])).toBe(0);
    expect(routeFlow(s, null)).toBe(1);
  });

  it('a bottleneck scenario slows its stage', () => {
    const s = createSim(11, START);
    const before = stageFlow(s, 'PRESS');
    activateScenario(s, { kind: 'bottleneck', stage: 'PRESS', factor: 0.4, end: null, label: 'Press bottleneck' });
    advance(s, s.minute + 30);
    expect(stageFlow(s, 'PRESS')).toBeLessThan(Math.min(0.5, before));
    const g = groupFlow(s, ['E-PRS1', 'E-PRS2', 'E-PRS3']);
    expect(g.rate).toBeCloseTo(stageFlow(s, 'PRESS'), 6);
  });
});

describe('flags', () => {
  it('derive health, energy, quality and bottleneck from the shared state', () => {
    const s = createSim(undefined, DEFAULT_START);
    // Baseline: ball mill 2 bearing wear is visible as a health watch.
    expect(healthFlags(s).some((h) => h.id === 'C-BM2')).toBe(true);
    expect(energyFlags(s)).toEqual([]);
    expect(bottleneckInfo(s)).not.toBeNull();

    activateScenario(s, { kind: 'energy-anomaly', equipmentId: 'A-COMP', factor: 1.3, end: null, label: 'Compressor leak' });
    activateScenario(s, { kind: 'quality-deterioration', stage: 'KILN', factor: 4, end: null, label: 'Kiln quality' });
    advance(s, s.minute + 90);
    const e = energyFlags(s);
    expect(e.map((x) => x.id)).toContain('A-COMP');
    expect(e.find((x) => x.id === 'A-COMP')!.deviation).toBeGreaterThan(0.08);
    const q = qualityStatus(s);
    expect(q.exception).toBe(true);
    expect(q.scenario).toBe(true);
    // Kiln-origin defects are chips (vision tunnel) and planarity (gauge).
    expect(q.stations['ST-GAUGE'].flagged).toBe(true);
    expect(q.stations['ST-VIS'].flagged).toBe(true);
  });

  it('memoises per simulation version', () => {
    let calls = 0;
    const f = perVersion(() => ++calls);
    const s = createSim(5, START);
    expect(f(s)).toBe(1);
    expect(f(s)).toBe(1);
    advance(s, s.minute + 1);
    expect(f(s)).toBe(2);
  });
});

describe('planned route', () => {
  const leg = (start: number, end: number, path: [number, number][], moving: boolean, zone = 'GF-SITE', activity = 'x'): VehicleLeg => ({
    start,
    end,
    path,
    moving,
    zone,
    activity,
  });
  const v: Vehicle = {
    id: 'T',
    class: 'external',
    type: 'outbound-truck',
    label: 'T',
    operator: 'x',
    spawned: 0,
    legs: [
      leg(0, 10, [
        [0, 0],
        [100, 0],
      ], true),
      leg(10, 11, [[100, 0]], false, 'GF-GATE', 'Gate check-in'),
      leg(11, 21, [
        [100, 0],
        [100, 50],
      ], true),
      leg(21, Infinity, [[100, 50]], false, 'GF-HOLD', 'Waiting for dock'),
    ],
  };

  it('runs through gate stops to the next working stop', () => {
    const r = plannedRoute(v, 5)!;
    expect(r.dest.leg.activity).toBe('Waiting for dock');
    expect(r.length).toBeCloseTo(150);
    expect(r.pts).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
    ]);
  });

  it('progress matches the interpolated pose', () => {
    const r = plannedRoute(v, 0)!;
    expect(routeProgress(r, 5)).toBeCloseTo(50);
    expect(routeProgress(r, 10.5)).toBeCloseTo(100);
    expect(routeProgress(r, 16)).toBeCloseTo(125);
  });

  it('is empty once the vehicle waits at its destination', () => {
    expect(plannedRoute(v, 30)).toBeNull();
  });

  it('agrees with poseAt for simulated vehicles', () => {
    const s = createSim(23, START);
    let checked = 0;
    for (const id of s.logistics.active) {
      const veh = s.logistics.vehicles[id];
      const t = s.minute + 0.37;
      const r = plannedRoute(veh, t);
      const pose = poseAt(veh, t);
      if (!r || !pose) continue;
      // The vehicle's position lies on the route at the reported progress.
      const d = routeProgress(r, t);
      const pl = polyline(r.pts.map(([x, z]) => [x, 0, z]));
      const p = pointAt(pl, d, { x: 0, y: 0, z: 0, yaw: 0 });
      expect(Math.hypot(p.x - pose.x, p.z - pose.z)).toBeLessThan(0.05);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});
