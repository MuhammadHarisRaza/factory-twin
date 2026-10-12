import { describe, expect, it } from 'vitest';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_IDS, MONITORED_STAGE_BY_ID, PROCESS_MACHINES, STAGE_BY_ID } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { eventById } from '../../sim/events';
import type { TruckRuntime } from '../../sim/logistics';
import { healthAssessments } from '../../intel/insights';
import { constraintClaim } from '../../intel/summary';
import {
  LINE_CONVEYORS_BETWEEN,
  LINE_CONVEYORS_WITHIN,
  LINE_STAGES,
  LEVEL_RANK,
  OP_RANK,
  assetEvents,
  assetStatus,
  batchLocation,
  currentStep,
  liveEvents,
  lineStatus,
  monitoredStageOf,
  searchTwin,
  selectionCamera,
  shiftTimeline,
  sortEvents,
  visitSteps,
  worstHealth,
} from './derive';

describe('twin derivations', () => {
  const s = createSim(11, 3 * 1440 + 9 * 60);

  it('covers every process machine once in the line strip, with one constraint marker', () => {
    const ls = lineStatus(s);
    expect(ls.stages.map((x) => x.def.key)).toEqual(['RAW', 'PREP', 'SPRAY', 'PRESS', 'DRY', 'GLAZE', 'DECOR', 'KILN', 'SORT', 'PACK', 'WH']);
    const ids = ls.stages.flatMap((x) => x.machines.map((m) => m.id)).sort();
    expect(ids).toEqual([...PROCESS_MACHINES].sort());
    // One chip carries the constraint marker: the process stage the constraint claim names.
    const marked = ls.stages.filter((x) => x.constraint);
    expect(marked).toHaveLength(1);
    expect(marked[0].def.stages).toContain(ls.constraint.processStage);
    expect(marked[0].constraint!.active).toBe(constraintClaim(s).constraining);
    for (const st of ls.stages) {
      const assets = [...st.machines, ...st.conveyors];
      if (!assets.length) {
        expect(st.worst).toBeNull();
        continue;
      }
      // The worst state is the highest-ranked operational state of the chip, and the focus asset has it.
      expect(Math.max(...assets.map((m) => OP_RANK[m.op]))).toBe(OP_RANK[st.worst!]);
      expect(assets.find((m) => m.id === st.focusId)!.op).toBe(st.worst);
    }
    expect(LINE_STAGES.find((x) => x.key === 'PACK')!.stages).toEqual(['PACK', 'PAL']);
  });

  it('links consecutive chips with every modelled conveyor', () => {
    const ls = lineStatus(s);
    expect(ls.connectors).toHaveLength(LINE_STAGES.length - 1);
    for (const cn of ls.connectors) {
      expect(LINE_STAGES.findIndex((x) => x.key === cn.to)).toBe(LINE_STAGES.findIndex((x) => x.key === cn.from) + 1);
      expect(cn.conveyors.map((c) => c.id)).toEqual(LINE_CONVEYORS_BETWEEN[cn.key] ?? []);
    }
    const shown = new Set([...ls.connectors.flatMap((c) => c.conveyors.map((x) => x.id)), ...Object.values(LINE_CONVEYORS_WITHIN).flat()]);
    expect([...shown].sort()).toEqual([...CONVEYOR_IDS].sort());
  });

  it('shows a stopped conveyor as stopped (not as a fault) on its connector', () => {
    const t = createSim(11, 3 * 1440 + 9 * 60);
    activateScenario(t, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: null, label: 'test' });
    advance(t, t.minute + 3);
    const cn = lineStatus(t).connectors.find((c) => c.key === 'DECOR>KILN')!;
    expect(cn.conveyors[0].id).toBe('CV-KIN');
    expect(cn.conveyors[0].op).toBe('stopped');
    expect(cn.conveyors[0].reason).not.toBeNull();
  });

  it('reads unknown with the frozen last rate while a feed is stale', () => {
    const t = createSim(11, 3 * 1440 + 9 * 60);
    advance(t, t.minute + 5);
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'E-PRS1', end: null, label: 'test' });
    advance(t, t.minute + 20);
    const st = assetStatus(t, 'E-PRS1');
    expect(st.op).toBe('unknown');
    expect(st.staleSince).not.toBeNull();
    expect(st.reason).toBeNull();
    expect(st.rate).toBe(t.feeds['E-PRS1'].lastRate);
    // The chip of a stage with a stale machine never reads plain "running".
    const press = lineStatus(t).stages.find((x) => x.def.key === 'PRESS')!;
    expect(OP_RANK[press.worst!]).toBeGreaterThanOrEqual(OP_RANK.unknown);
  });

  it('marks a stopped machine as the stage worst state', () => {
    const t = createSim(11, 3 * 1440 + 9 * 60);
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'test' });
    advance(t, t.minute + 2);
    const press = lineStatus(t).stages.find((x) => x.def.key === 'PRESS')!;
    expect(['stopped', 'fault']).toContain(press.worst);
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
    // Every non-scenario marker is an operational event record (the one its click opens).
    for (const m of tl.markers) {
      if (m.lane === 'scenario') continue;
      const ev = eventById(s, m.eventId!)!;
      expect(ev).toBeDefined();
      expect(m.status).toBe(ev.status);
      expect(m.open).toBe(ev.end == null);
    }
  });

  it('puts events of each category on its lane', () => {
    const t = createSim(11, 3 * 1440 + 9 * 60);
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'stop' });
    activateScenario(t, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 4, end: null, label: 'quality' });
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'feed' });
    advance(t, t.minute + 45);
    const tl = shiftTimeline(t);
    const lanes = new Set(tl.markers.map((m) => m.lane));
    expect(lanes.has('production')).toBe(true);
    expect(lanes.has('scenario')).toBe(true);
    for (const m of tl.markers.filter((x) => x.eventId)) {
      const cat = eventById(t, m.eventId!)!.category;
      const lane = cat === 'quality' ? 'quality' : cat === 'logistics' ? 'logistics' : cat === 'data' ? 'data' : 'production';
      expect(m.lane).toBe(lane);
    }
  });

  it('orders events: active first (most severe), then open, then resolved', () => {
    const ev = (id: string, o: Partial<OpEvent>) => ({ id, severity: 'warning', status: 'active', start: 0, end: null, lastUpdate: 0, ...o }) as OpEvent;
    const list = [
      ev('R', { status: 'resolved', end: 50, lastUpdate: 50 }),
      ev('O', { status: 'acknowledged', end: 40, lastUpdate: 40 }),
      ev('W', { start: 30 }),
      ev('C', { severity: 'critical', start: 10 }),
      ev('W2', { start: 35 }),
    ];
    expect(sortEvents(list).map((e) => e.id)).toEqual(['C', 'W2', 'W', 'O', 'R']);
  });

  it('lists the live and asset events of the one event engine', () => {
    const t = createSim(11, 3 * 1440 + 9 * 60);
    activateScenario(t, { kind: 'conveyor-stop', equipmentId: 'E-COL', end: null, label: 'stop' });
    advance(t, t.minute + 20);
    const live = liveEvents(t);
    expect(live.length).toBeGreaterThan(0);
    // Active conditions lead the list.
    const firstCleared = live.findIndex((e) => e.end != null);
    if (firstCleared >= 0) expect(live.slice(firstCleared).every((e) => e.end != null)).toBe(true);
    const mine = assetEvents(t, 'E-COL');
    expect(mine.some((e) => e.type === 'conveyor-stop' && e.end == null)).toBe(true);
    for (const e of mine) expect(eventById(t, e.id)).toBe(e);
  });

  it('maps assets to their monitored stage and camera', () => {
    expect(monitoredStageOf('E-PRS2')).toBe('PRESS');
    expect(monitoredStageOf('D-BELT')).toBe('PRESS');
    expect(monitoredStageOf('E-COL')).toBe('DRY');
    expect(monitoredStageOf('CV-GLZ')).toBe('GLAZE');
    expect(monitoredStageOf('CV-PAL')).toBe('PACK');
    expect(monitoredStageOf('I-VIS')).toBe('SORT');
    expect(monitoredStageOf('A-COMP')).toBeNull();
    for (const id of [...PROCESS_MACHINES, ...CONVEYOR_IDS]) {
      const st = monitoredStageOf(id);
      if (st) expect(MONITORED_STAGE_BY_ID[st]).toBeDefined();
      expect(selectionCamera(s, { equipmentId: id })).not.toBeNull();
    }
    expect(selectionCamera(s, { equipmentId: 'A-COMP' })).toBeNull();
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
