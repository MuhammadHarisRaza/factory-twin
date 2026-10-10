import { beforeAll, describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim, DEFAULT_SEED, type SimState } from '../../sim/engine';
import { activeEvents } from '../../sim/events';
import { lineMetrics, resolvePeriod } from '../../sim/metrics';
import { CATEGORY_ORDER, SEVERITY_RANK, categoryRows, pickerEvents, rankActive, situationNow } from './derive';

let s: SimState;

beforeAll(() => {
  s = createSim(DEFAULT_SEED);
  activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press 2 stop' });
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-GLZ', end: null, label: 'Glaze conveyor stop' });
  advance(s, s.minute + 40);
}, 60_000);

describe('Situation now', () => {
  it('shows the same line figures as the shift metrics', () => {
    const st = situationNow(s);
    const lm = lineMetrics(s, resolvePeriod('shift', s.minute));
    expect(st.outputM2).toBe(lm.outputM2);
    expect(st.targetM2).toBe(lm.targetM2);
    expect(st.oee).toEqual(lm.oee.oee);
    expect(st.shiftElapsed).toBeGreaterThan(0);
  });

  it('lists the stopped machine and conveyor', () => {
    const ids = situationNow(s).stopped.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['E-PRS2', 'CV-GLZ']));
    for (const x of situationNow(s).stopped) expect(['fault', 'stopped', 'unknown', 'disconnected']).toContain(x.state);
  });

  it('counts active events per category, every category listed', () => {
    const rows = situationNow(s).categories;
    expect(rows.map((r) => r.category)).toEqual(CATEGORY_ORDER);
    expect(rows.reduce((a, r) => a + r.active, 0)).toBe(activeEvents(s).length);
    for (const r of rows) {
      const xs = activeEvents(s).filter((e) => e.category === r.category);
      if (!xs.length) expect(r.worst).toBeNull();
      else expect(SEVERITY_RANK[r.worst!]).toBe(Math.max(...xs.map((e) => SEVERITY_RANK[e.severity])));
    }
  });
});

describe('Event picker', () => {
  it('ranks active events by severity, then kiln hold-up, then most recent', () => {
    const ranked = pickerEvents(s, null);
    expect(ranked.length).toBe(activeEvents(s).length);
    for (let i = 1; i < ranked.length; i++) {
      const a = ranked[i - 1];
      const b = ranked[i];
      const d = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      expect(d).toBeGreaterThanOrEqual(0);
      if (d === 0) expect(a.acc.constraintMin).toBeGreaterThanOrEqual(b.acc.constraintMin);
    }
  });

  it('filters by category', () => {
    const prod = pickerEvents(s, 'production');
    expect(prod.length).toBeGreaterThan(0);
    expect(prod.every((e) => e.category === 'production' && e.end == null)).toBe(true);
    expect(rankActive([])).toEqual([]);
    expect(categoryRows([]).every((r) => r.active === 0 && r.worst === null)).toBe(true);
  });
});
