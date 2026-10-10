import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { resolvePeriod } from '../../sim/metrics';
import { completedVisits, dockBoard, dockUtilisation, eventLog, externalRows, hourlyGate, internalRows, visitTimeline } from './derive';
import type { TruckRuntime } from '../../sim/logistics';

describe('fleet page derivations', () => {
  const s = createSim(7, 2 * 1440 + 300);
  const p = resolvePeriod('24h', s.minute);

  it('builds consistent rows', () => {
    const ext = externalRows(s, p);
    expect(ext.length).toBeGreaterThan(3);
    for (const r of ext) {
      if (r.d.gateToDock != null) expect(r.v.visit!.dockStart!).toBeLessThanOrEqual(s.minute);
      if (r.d.dockTime != null) expect(r.d.dockTime).toBeGreaterThanOrEqual(0);
    }
    expect(internalRows(s)).toHaveLength(6);
    expect(dockBoard(s)).toHaveLength(6);
    const log = eventLog(s, p);
    for (let i = 1; i < log.length; i++) expect(log[i - 1].time).toBeGreaterThanOrEqual(log[i].time);
    const g = hourlyGate(s, p);
    expect(g.values.length).toBe(g.hours.length);
    for (const u of dockUtilisation(s, p)) expect(u.share).toBeLessThanOrEqual(1);
    for (const { v } of completedVisits(s, p)) {
      const tl = visitTimeline(s, v);
      expect(tl.every((x) => x.time != null)).toBe(true);
    }
  });

  it('timeline only shows events that happened', () => {
    activateScenario(s, { kind: 'truck-arrival', end: null, label: 't' });
    advance(s, s.minute + 3);
    const v = Object.values(s.logistics.vehicles).find((x) => x.visit?.scenarioId) as TruckRuntime;
    for (const st of visitTimeline(s, v)) if (st.time != null) expect(st.time).toBeLessThanOrEqual(s.minute);
    expect(visitTimeline(s, v).at(-1)!.time).toBeNull();
  });
});
