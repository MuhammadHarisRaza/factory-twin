/**
 * Reliability derivations (./reliability.ts): stop classes that never overlap (changeover and planned kept out of
 * the failures), the Pareto with cumulative share, recurrence, the longest stops, MTBF / MTTR 'unavailable' with no
 * failure, and the view model on the seeded simulation.
 */
import { describe, expect, it } from 'vitest';
import type { DowntimeEvent, OpEvent } from '../../model/types';
import { createSim } from '../../sim/engine';
import {
  classTotals,
  downtimePareto,
  longestStoppages,
  mtbfRows,
  operatingTime,
  recurringFaults,
  reliabilityHeadline,
  reliabilityModel,
  reliabilityStops,
  stopClassOf,
} from './reliability';

const W = { from: 1000, to: 1480 };
const NOW = 1480;

let n = 0;
const stop = (equipmentId: string, reasonCode: string, category: DowntimeEvent['category'], start: number, end: number | null): DowntimeEvent => ({
  id: `DT-${++n}`,
  equipmentId,
  reasonCode,
  category,
  start,
  end,
  lostTiles: 0,
  constraintImpactMin: 0,
  source: 'simulation',
});

const DOWNTIME: DowntimeEvent[] = [
  stop('E-PRS1', 'MECH_HYD', 'Mechanical', 1010, 1030), // 20
  stop('E-PRS1', 'MECH_HYD', 'Mechanical', 1100, 1110), // 10
  stop('E-PRS1', 'MECH_HYD', 'Mechanical', 1200, 1205), // 5
  stop('E-PRS2', 'ELEC_SENSOR', 'Electrical & control', 1300, 1340), // 40
  stop('E-PRS2', 'MECH_HYD', 'Mechanical', 950, 1020), // 20 inside the window (started before)
  stop('E-PRS1', 'CHG_PRODUCT', 'Changeover', 1400, 1430), // 30 changeover
  stop('E-PRS2', 'PLN_CLEAN', 'Planned', 1440, 1460), // 20 planned
  stop('E-PRS1', 'STARVED', 'Starved', 1050, 1090), // not an own stop
  stop('E-PRS2', 'BLOCKED', 'Blocked', 1150, 1170), // not an own stop
  stop('E-PRS1', 'ELEC_SENSOR', 'Electrical & control', 1470, null), // open: 10 to now
  stop('E-PRS1', 'MECH_DIE', 'Mechanical', 500, 600), // outside the window
];

const EVENTS = [{ id: 'EV-0001', refs: { downtimeId: 'DT-4' } }] as unknown as OpEvent[];

describe('stop classes', () => {
  it('puts each record in at most one class; starved / blocked are not stops', () => {
    expect(stopClassOf({ reasonCode: 'MECH_HYD', category: 'Mechanical' })).toBe('unplanned');
    expect(stopClassOf({ reasonCode: 'CHG_PRODUCT', category: 'Changeover' })).toBe('changeover');
    expect(stopClassOf({ reasonCode: 'PLN_MAINT', category: 'Planned' })).toBe('planned');
    expect(stopClassOf({ reasonCode: 'STARVED', category: 'Starved' })).toBeNull();
    expect(stopClassOf({ reasonCode: 'BLOCKED', category: 'Blocked' })).toBeNull();
  });

  it('keeps own stops overlapping the window, links the event and counts no minute twice', () => {
    const stops = reliabilityStops(DOWNTIME, EVENTS, W, NOW);
    expect(stops.map((x) => x.reasonCode)).not.toContain('STARVED');
    expect(stops.map((x) => x.reasonCode)).not.toContain('MECH_DIE');
    expect(stops).toHaveLength(8);
    expect(stops.find((x) => x.id === 'DT-4')?.eventId).toBe('EV-0001');
    // Changeovers and planned stops are never failures.
    expect(stops.filter((x) => x.cls !== 'unplanned').every((x) => x.planned)).toBe(true);
    const t = classTotals(stops, W);
    expect(t.unplanned).toMatchObject({ minutes: 20 + 10 + 5 + 40 + 20 + 10, stops: 6, open: 1 });
    expect(t.changeover).toMatchObject({ minutes: 30, stops: 1 });
    expect(t.planned).toMatchObject({ minutes: 20, stops: 1 });
    // The class totals add up to the minutes of every own stop, clipped — nothing in two classes.
    expect(t.unplanned.stops + t.changeover.stops + t.planned.stops).toBe(stops.length);
  });
});

describe('Pareto', () => {
  const stops = reliabilityStops(DOWNTIME, EVENTS, W, NOW);
  it('ranks reasons with share and cumulative share of the class', () => {
    const p = downtimePareto(stops, W, 'unplanned', 'reason');
    expect(p.map((r) => r.key)).toEqual(['MECH_HYD', 'ELEC_SENSOR']);
    expect(p[0].minutes).toBe(55);
    expect(p[1].minutes).toBe(50);
    expect(p[0].share).toBeCloseTo(55 / 105);
    expect(p.at(-1)!.cumulative).toBeCloseTo(1);
    // The changeover is its own category, not in the unplanned Pareto.
    expect(p.map((r) => r.key)).not.toContain('CHG_PRODUCT');
    expect(downtimePareto(stops, W, 'changeover', 'reason').map((r) => r.key)).toEqual(['CHG_PRODUCT']);
  });

  it('groups by equipment', () => {
    const p = downtimePareto(stops, W, 'unplanned', 'equipment');
    expect(p.map((r) => r.key)).toEqual(['E-PRS2', 'E-PRS1']);
    expect(p.reduce((a, r) => a + r.minutes, 0)).toBe(105);
  });
});

describe('recurrence, longest stops, MTBF / MTTR', () => {
  const stops = reliabilityStops(DOWNTIME, EVENTS, W, NOW);
  it('finds a fault code repeated on one asset (stops starting in the window only)', () => {
    const r = recurringFaults(stops, W);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ equipmentId: 'E-PRS1', reasonCode: 'MECH_HYD', count: 3 });
    expect(r[0].meanMin).toBeCloseTo(35 / 3);
  });

  it('lists the longest stops of a class, the open one marked ongoing', () => {
    const l = longestStoppages(stops, W, 'unplanned', 3);
    expect(l.map((x) => x.minutes)).toEqual([40, 20, 20]);
    const all = longestStoppages(stops, W, 'unplanned', 10);
    expect(all.find((x) => x.id === 'DT-10')).toMatchObject({ ongoing: true, minutes: 10 });
  });

  it('gives MTBF / MTTR, and unavailable (never zero or infinite) without failures', () => {
    const op = { operatingMin: 400, ownStopMin: 80, unknownMin: 0, coveredMin: 480 };
    const rows = mtbfRows(stops, W, { 'E-PRS1': op, 'E-PRS2': op, 'C-BM1': op }, ['E-PRS1', 'E-PRS2', 'C-BM1']);
    const p1 = rows.find((r) => r.equipmentId === 'E-PRS1')!;
    expect(p1.failures).toBe(4); // 3 × MECH_HYD + the open sensor fault; the changeover is not a failure
    expect(p1.mtbfH.status).toBe('ok');
    expect(p1.mtbfH.value).toBeCloseTo(400 / 60 / 4);
    const p2 = rows.find((r) => r.equipmentId === 'E-PRS2')!;
    expect(p2.failures).toBe(1); // the planned cleaning and the stop started before the window are not counted
    const bm = rows.find((r) => r.equipmentId === 'C-BM1')!;
    expect(bm.failures).toBe(0);
    expect(bm.mtbfH.status).not.toBe('ok');
    expect(bm.mtbfH.value).not.toBe(0);
    expect(bm.mttrMin.status).not.toBe('ok');
  });

  it('counts operating time from the state timeline; unknown minutes are not operating', () => {
    const t = operatingTime(
      [
        { from: 1000, to: 1200, state: 'running' },
        { from: 1200, to: 1300, state: 'fault' },
        { from: 1300, to: 1480, state: 'unknown' },
      ] as never,
      W,
    );
    expect(t).toMatchObject({ operatingMin: 200, ownStopMin: 100, unknownMin: 180 });
    expect(operatingTime([], W).operatingMin).toBeNull();
  });
});

describe('view model on the simulation', () => {
  it('derives every section and states its counting rule', () => {
    const s = createSim();
    const m = reliabilityModel(s, '24h');
    expect(m.window.to).toBe(s.minute);
    expect(m.lanes.machines.length).toBeGreaterThan(0);
    expect(m.mtbf.length).toBeGreaterThan(0);
    for (const r of m.mtbf) if (r.failures === 0) expect(r.mtbfH.status).not.toBe('ok');
    expect(m.reliabilityFindings.shown.every((f) => f.family === 'reliability')).toBe(true);
    expect(m.dataFindings.shown.every((f) => f.family === 'data')).toBe(true);
    expect(reliabilityHeadline(s, '24h')).toMatch(/unplanned downtime/);
  }, 60_000);
});
