import { beforeAll, describe, expect, it } from 'vitest';
import { MONITORED_STAGES, MONITORED_STAGE_BY_ID, SCENARIO_KIND_LABELS, STAGES } from '../../../model/plant';
import type { OpEvent } from '../../../model/types';
import { LOG_MIN, activateScenario, advance, clearScenario, createSim, type SimState } from '../../../sim/engine';
import { resolvePeriod, stageIO } from '../../../sim/metrics';
import {
  QUICK_FACTOR,
  STATE_RANK,
  SUB_STAGES,
  assetView,
  bufferHistory,
  countCell,
  eventInStage,
  feedOf,
  inferredCause,
  lossTotals,
  monitoredStageOf,
  overview,
  quickDef,
  quickKindsFor,
  rateHistory,
  runningScenario,
  shiftSummary,
  stageEvents,
  stageLosses,
  stageScenarios,
  stageSentence,
  stageTrend,
  trendSignals,
} from './derive';

const ev = (asset: OpEvent['asset']) => ({ asset }) as OpEvent;

describe('monitoring registry helpers', () => {
  it('folds process stages into monitored stages', () => {
    expect(SUB_STAGES.GLAZE).toEqual(['GLAZE', 'DECOR']);
    expect(SUB_STAGES.PACK).toEqual(['PACK', 'PAL']);
    expect(SUB_STAGES.WH).toEqual([]);
    expect(monitoredStageOf('DECOR')).toBe('GLAZE');
    expect(monitoredStageOf('PAL')).toBe('PACK');
    for (const st of STAGES) expect(monitoredStageOf(st.id)).not.toBeNull();
  });

  it('assigns events to stages by asset, conveyor listing or origin stage', () => {
    const sort = MONITORED_STAGE_BY_ID.SORT;
    const press = MONITORED_STAGE_BY_ID.PRESS;
    const kiln = MONITORED_STAGE_BY_ID.KILN;
    const glaze = MONITORED_STAGE_BY_ID.GLAZE;
    const wh = MONITORED_STAGE_BY_ID.WH;
    // A crack detected at the vision tunnel: detection stage and origin stage.
    const crack = ev({ equipmentId: 'I-VIS', stationId: 'ST-VIS', stage: 'PRESS', zone: 'I' });
    expect(eventInStage(sort, crack)).toBe(true);
    expect(eventInStage(press, crack)).toBe(true);
    expect(eventInStage(kiln, crack)).toBe(false);
    // Conveyor events belong only to the stages that list the conveyor (CV-GLZ carries stage KILN as its destination).
    const glzStop = ev({ equipmentId: 'CV-GLZ', stage: 'KILN', zone: 'G' });
    expect(eventInStage(glaze, glzStop)).toBe(true);
    expect(eventInStage(kiln, glzStop)).toBe(false);
    // Decoration belongs to glazing & decoration.
    expect(eventInStage(glaze, ev({ equipmentId: 'G-INK', stage: 'DECOR', zone: 'G' }))).toBe(true);
    // Dock / truck events belong to warehouse transfer.
    expect(eventInStage(wh, ev({ vehicleId: 'T-1', dockId: 'DOCK-2', zone: 'K' }))).toBe(true);
    expect(eventInStage(wh, ev({ vehicleId: 'T-1', geofenceId: 'GF-HOLD', zone: 'A' }))).toBe(false);
  });

  it('offers stage-relevant quick scenarios with complete definitions', () => {
    expect(quickKindsFor('H-KILN')).toEqual(['machine-stop', 'reduced-rate', 'signal-loss']);
    expect(quickKindsFor('CV-KIN')).toEqual(['conveyor-stop', 'signal-loss']);
    expect(quickKindsFor('K-RACK')).toEqual([]);
    const stop = quickDef('machine-stop', 'E-PRS2', 30, 1000);
    expect(stop).toMatchObject({ kind: 'machine-stop', equipmentId: 'E-PRS2', end: 1030 });
    expect(stop.label).toContain(SCENARIO_KIND_LABELS['machine-stop']);
    expect(quickDef('signal-loss', 'E-PRS2', 0, 1000).end).toBeNull();
    expect(quickDef('reduced-rate', 'H-KILN', 15, 1000)).toMatchObject({ factor: QUICK_FACTOR, end: 1015 });
    expect(quickDef('conveyor-stop', 'CV-KIN', 15, 1000).factor).toBeUndefined();
  });
});

describe('monitoring derivations on the simulation', () => {
  let s: SimState;
  beforeAll(() => {
    s = createSim();
  });

  it('lists every monitored stage in flow order, equipment worst first, one bottleneck', () => {
    const p = resolvePeriod('shift', s.minute);
    const o = overview(s, p);
    expect(o.rows.map((r) => r.ms.id)).toEqual(MONITORED_STAGES.map((m) => m.id));
    for (const r of o.rows) {
      const ranks = r.equipment.filter((a) => a.state != null).map((a) => STATE_RANK[a.state!]);
      for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]);
      expect(r.active.every((e) => e.end == null)).toBe(true);
    }
    expect(o.rows.filter((r) => r.isBottleneck).length).toBe(o.bn.stage ? 1 : 0);
    expect(o.rows.find((r) => r.ms.id === 'KILN')!.isConstraint).toBe(true);
    expect(o.lineGood).toBe(stageIO(s, 'SORT', p).good);
  });

  it('never shows a number for a quantity without a counting point', () => {
    const p = resolvePeriod('shift', s.minute);
    const prep = MONITORED_STAGE_BY_ID.PREP;
    const cell = countCell(prep, 'input', stageIO(s, 'PREP', p))!;
    expect(cell.measured).toBe(false);
    expect(cell.value).toBeNull();
    expect(cell.note).toBeTruthy();
    expect(countCell(prep, 'good', stageIO(s, 'PREP', p))).toBeNull();
    const sort = countCell(MONITORED_STAGE_BY_ID.SORT, 'rejected', stageIO(s, 'SORT', p))!;
    expect(sort.measured).toBe(true);
    expect(sort.value).not.toBeNull();
  });

  it('labels healthy feeds Simulated (never Live) and exposes warehouse readings', () => {
    for (const ms of MONITORED_STAGES)
      for (const id of [...ms.equipment, ...ms.conveyors]) {
        const a = assetView(s, id);
        expect(a.feed.label).not.toMatch(/live/i);
        if (s.feeds[id]?.status !== 'stale') expect(a.feed.label).toBe('Simulated');
      }
    expect(assetView(s, 'K-RACK').state).toBeNull();
    expect(assetView(s, 'K-RACK').reading).toMatch(/pallets in stock/);
  });

  it('sums the hourly trend to the period total of the stage', () => {
    for (const key of ['shift', '24h', '7d'] as const) {
      const p = resolvePeriod(key, s.minute);
      for (const id of ['PRESS', 'KILN', 'WH'] as const) {
        const ms = MONITORED_STAGE_BY_ID[id];
        const t = stageTrend(s, ms, p);
        expect(t.granularity).toBe(key === '7d' ? 'shift' : 'hour');
        const total = t.buckets.reduce((a, b) => a + b.output, 0);
        expect(total).toBeCloseTo(stageIO(s, id, p).output ?? 0, 6);
      }
    }
  });

  it('keeps asset losses apart from losses that reached the constraint', () => {
    const p = resolvePeriod('24h', s.minute);
    const rows = stageLosses(s, MONITORED_STAGE_BY_ID.PRESS, p);
    expect(rows.map((r) => r.id).sort()).toEqual(['D-BELT', 'E-COL', 'E-PRS1', 'E-PRS2', 'E-PRS3']);
    for (const r of rows) {
      if (r.kind === 'conveyor') expect(r.lostTiles).toBeNull();
      else expect(r.lostTiles).toBeGreaterThanOrEqual(0);
      for (const id of r.eventIds) expect(s.events.find((e) => e.id === id)!.consequenceOf).toBeUndefined();
    }
    const t = lossTotals(rows);
    expect(t.downMin).toBe(rows.reduce((a, r) => a + r.downMin, 0));
    expect(t.constraintMin).toBe(rows.reduce((a, r) => a + r.constraintMin, 0));
    expect(stageLosses(s, MONITORED_STAGE_BY_ID.KILN, p).find((r) => r.id === 'H-KILN')!.isConstraint).toBe(true);
    expect(stageLosses(s, MONITORED_STAGE_BY_ID.WH, p)).toEqual([]);
  });

  it('summarises the current shift from the stage events', () => {
    for (const ms of MONITORED_STAGES) {
      const sum = shiftSummary(s, ms);
      expect(sum.period.to).toBe(s.minute);
      expect(sum.events.length).toBeGreaterThanOrEqual(sum.raised.length);
      expect(Object.values(sum.bySeverity).reduce((a, b) => a + b, 0)).toBe(sum.raised.length);
      expect(sum.raised.every((e) => e.start >= sum.period.from)).toBe(true);
    }
  });

  it('attaches an inferred cause only when the event engine linked a root event', () => {
    const root = s.events[0];
    expect(root).toBeDefined();
    const linked = { ...root, id: 'EV-TEST', type: 'starvation', end: null, consequenceOf: root.id, causes: [{ text: 'x', confidence: 'likely', basis: 'y', relatedEventId: root.id }] } as OpEvent;
    const c = inferredCause(s, [linked]);
    expect(c?.root.id).toBe(root.id);
    expect(c?.held).toBe('starved');
    expect(c?.confidence).toBe('likely');
    expect(inferredCause(s, [{ ...linked, consequenceOf: undefined }])).toBeNull();
    expect(inferredCause(s, [{ ...linked, end: s.minute - 1 }])).toBeNull();
  });

  it('configures signal trends per equipment type', () => {
    const kiln = trendSignals('H-KILN').map((x) => `${x.signal.name}:${x.source}`);
    expect(kiln).toEqual(expect.arrayContaining(['rate:minute-log', 'vibration:condition', 'temperature:condition', 'motor_current:condition']));
    expect(trendSignals('CV-KIN').map((x) => x.signal.name)).toEqual(['tile_count']);
    expect(trendSignals('E-COL').some((x) => x.source === 'buffer-log' && x.bufferId === 'BUF-COL')).toBe(true);
    expect(trendSignals('K-RACK')).toEqual([]);
    const b = bufferHistory(s, 'BUF-KIN');
    expect(b.t.length).toBe(Math.min(LOG_MIN, s.minute));
    for (const v of b.v) if (v != null) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('monitoring under scenarios', () => {
  it('shows a lost data feed as stale and unknown, with a gap in the trend', () => {
    const s = createSim();
    const sc = activateScenario(s, quickDef('signal-loss', 'E-PRS1', 0, s.minute));
    const since = s.minute;
    advance(s, s.minute + 6);
    const f = feedOf(s, 'E-PRS1');
    expect(f.status).toBe('stale');
    expect(f.label).toMatch(/^Stale since \d\d:\d\d$/);
    const a = assetView(s, 'E-PRS1');
    expect(a.state).toBe('unknown');
    expect(a.since).toBe(since);
    const h = rateHistory(s, 'E-PRS1');
    h.t.forEach((t, i) => t >= since && expect(h.v[i]).toBeNull());
    const row = overview(s, resolvePeriod('shift', s.minute)).rows.find((r) => r.ms.id === 'PRESS')!;
    expect(row.stale.map((x) => x.id)).toContain('E-PRS1');
    expect(stageSentence(row, 'shift')).toContain('E-PRS1 stale since');
    expect(stageScenarios(s, MONITORED_STAGE_BY_ID.PRESS).map((x) => x.id)).toContain(sc.id);
    expect(runningScenario(s, 'signal-loss', 'E-PRS1')?.id).toBe(sc.id);
    clearScenario(s, sc.id);
    advance(s, s.minute + 1);
    expect(runningScenario(s, 'signal-loss', 'E-PRS1')).toBeNull();
    expect(feedOf(s, 'E-PRS1').status).toBe('simulated');
  });

  it('puts a conveyor stop on the stages that list the conveyor', () => {
    const s = createSim();
    activateScenario(s, quickDef('conveyor-stop', 'CV-KIN', 0, s.minute));
    advance(s, s.minute + 20);
    const kiln = MONITORED_STAGE_BY_ID.KILN;
    expect(assetView(s, 'CV-KIN').state).toBe('stopped');
    const evs = stageEvents(s, kiln).filter((e) => e.asset.equipmentId === 'CV-KIN' && e.end == null);
    expect(evs.length).toBeGreaterThan(0);
    expect(stageEvents(s, MONITORED_STAGE_BY_ID.GLAZE).some((e) => e.asset.equipmentId === 'CV-KIN')).toBe(false);
    // A cause is shown only through an engine link.
    const row = overview(s, resolvePeriod('shift', s.minute)).rows;
    for (const r of row) {
      const linked = r.active.some((e) => (e.type === 'starvation' || e.type === 'blockage') && e.consequenceOf);
      expect(r.cause != null).toBe(linked);
    }
  });
});
