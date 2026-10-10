import { describe, expect, it } from 'vitest';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { PROCESS_MACHINES, STAGE_BY_ID } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import type { TruckRuntime } from '../../sim/logistics';
import { healthAssessments } from '../../intel/insights';
import { LINE_STAGES, LEVEL_RANK, STATE_RANK, batchLocation, currentStep, lineStatus, searchTwin, shiftTimeline, visitSteps, worstHealth } from './derive';

describe('twin derivations', () => {
  const s = createSim(11, 3 * 1440 + 9 * 60);

  it('covers every process machine once in the line strip, with one bottleneck', () => {
    const ls = lineStatus(s);
    expect(ls.stages.map((x) => x.def.key)).toEqual(['RAW', 'PREP', 'SPRAY', 'PRESS', 'DRY', 'GLAZE', 'DECOR', 'KILN', 'SORT', 'PACK', 'WH']);
    const ids = ls.stages.flatMap((x) => x.machines.map((m) => m.id)).sort();
    expect(ids).toEqual([...PROCESS_MACHINES].sort());
    expect(ls.stages.filter((x) => x.bottleneck)).toHaveLength(1);
    for (const st of ls.stages) {
      if (!st.machines.length) {
        expect(st.worst).toBeNull();
        continue;
      }
      // The worst state is the highest-ranked state of the stage, and the focus machine has it.
      expect(Math.max(...st.machines.map((m) => STATE_RANK[m.state]))).toBe(STATE_RANK[st.worst!]);
      expect(st.machines.find((m) => m.id === st.focusId)!.state).toBe(st.worst);
    }
    expect(LINE_STAGES.find((x) => x.key === 'PACK')!.stages).toEqual(['PACK', 'PAL']);
  });

  it('marks a stopped machine as the stage worst state', () => {
    const t = createSim(11, 3 * 1440 + 9 * 60);
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'test' });
    advance(t, t.minute + 2);
    const press = lineStatus(t).stages.find((x) => x.def.key === 'PRESS')!;
    expect(press.worst).toBe('down');
    expect(press.focusId).toBe('E-PRS2');
  });

  it('visit steps never show future times and progress in order', () => {
    const t = createSim(5, 2 * 1440 + 300);
    activateScenario(t, { kind: 'truck-arrival', end: null, label: 'arrival' });
    const id = Object.values(t.logistics.vehicles).find((v) => v.visit?.scenarioId)!.id;
    for (let k = 0; k < 12; k++) {
      advance(t, t.minute + 10);
      const v = t.logistics.vehicles[id] as TruckRuntime;
      const steps = visitSteps(t, v);
      const cur = currentStep(steps);
      steps.forEach((st, i) => {
        if (st.time != null) expect(st.time).toBeLessThanOrEqual(t.minute);
        if (i < cur) expect(st.time).not.toBeNull();
      });
      const times = steps.map((st) => st.time).filter((x): x is number => x != null);
      for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });

  it('timeline markers stay inside the current shift and point at real assets', () => {
    const tl = shiftTimeline(s);
    expect(tl.to - tl.from).toBe(480);
    expect(tl.now).toBeGreaterThanOrEqual(tl.from);
    for (const m of tl.markers) {
      expect(m.t).toBeGreaterThanOrEqual(tl.from);
      expect(m.t).toBeLessThanOrEqual(tl.now);
      if (m.end != null) expect(m.end).toBeGreaterThanOrEqual(m.t);
      if (m.equipmentId) expect(EQUIPMENT_BY_ID[m.equipmentId]).toBeDefined();
    }
    // Stop alerts are folded into their downtime marker.
    const starts = new Set(tl.markers.filter((m) => m.kind === 'downtime').map((m) => `${m.equipmentId}@${m.t}`));
    for (const m of tl.markers.filter((x) => x.kind === 'alert' && x.title.endsWith(' stopped'))) expect(starts.has(`${m.equipmentId}@${m.t}`)).toBe(false);
  });

  it('search finds assets, zones, vehicles and batches', () => {
    expect(searchTwin(s, 'press 2')[0].target).toEqual({ kind: 'equipment', id: 'E-PRS2' });
    expect(searchTwin(s, 'E-PRS3')[0].target.id).toBe('E-PRS3');
    expect(searchTwin(s, 'zone h')[0].target).toEqual({ kind: 'zone', id: 'H' });
    expect(searchTwin(s, 'h')[0].target).toEqual({ kind: 'zone', id: 'H' });
    expect(searchTwin(s, 'kiln').some((r) => r.target.id === 'H-KILN')).toBe(true);
    const fl = searchTwin(s, 'forklift');
    expect(fl.length).toBeGreaterThan(0);
    expect(fl[0].kind).toBe('vehicle');
    expect(fl.some((r) => r.target.id === 'K-FLT')).toBe(true);
    const batch = s.batches[s.batches.length - 1];
    const r = searchTwin(s, batch.id)[0];
    expect(r.kind).toBe('batch');
    expect(EQUIPMENT_BY_ID[r.target.id]).toBeDefined();
    expect(searchTwin(s, '   ')).toEqual([]);
    expect(searchTwin(s, 'no such thing qq')).toEqual([]);
  });

  it('locates batches along the line', () => {
    for (const b of s.batches) {
      const loc = batchLocation(s, b);
      expect(EQUIPMENT_BY_ID[loc.equipmentId]).toBeDefined();
      if (b.end == null) expect(STAGE_BY_ID.PRESS.machines).toContain(loc.equipmentId);
    }
  });

  it('picks the asset in the worst condition', () => {
    const t = createSim(11, 3 * 1440 + 9 * 60);
    activateScenario(t, { kind: 'degradation', equipmentId: 'F-DRY', end: null, label: 'fault' });
    advance(t, t.minute + 60);
    const list = healthAssessments(t);
    const worst = worstHealth(list)!;
    for (const a of list) {
      expect(LEVEL_RANK[worst.level]).toBeGreaterThanOrEqual(LEVEL_RANK[a.level]);
      if (a.level === worst.level) expect(worst.score).toBeLessThanOrEqual(a.score);
    }
    expect(worstHealth([])).toBeNull();
  });
});
