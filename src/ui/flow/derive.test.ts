import { describe, expect, it } from 'vitest';
import { M2_PER_TILE, MONITORED_STAGES } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { lineMetrics, resolvePeriod, stageIO } from '../../sim/metrics';
import { factoryOeeKpi, goodOutputKpi } from '../../intel/kpis';
import { constraintClaim } from '../../intel/summary';
import { formatClock } from '../../sim/time';
import { assetStage, eventStage, flowStages, stageAlerts } from './derive';

const START = 2 * 1440 + 4 * 60 + 20;

describe('production flow strip', () => {
  const s = createSim(81, START);
  const p = resolvePeriod('shift', s.minute);

  it('lists the monitored stages in line order with output from their counting points', () => {
    const f = flowStages(s, p);
    expect(f.map((x) => x.id)).toEqual(MONITORED_STAGES.map((m) => m.id));
    expect(f.map((x) => x.id)).toEqual(['PREP', 'SPRAY', 'PRESS', 'DRY', 'GLAZE', 'KILN', 'SORT', 'PACK', 'WH']);
    for (const st of f) {
      if (st.id === 'WH') {
        expect(st.unit).toBe('pallets');
        expect(st.output).toBe(stageIO(s, 'WH', p).output);
      } else if (st.id === 'SORT') {
        expect(st.unit).toBe('m²');
        expect(st.output).toBeCloseTo(lineMetrics(s, p).outputM2, 9);
      } else {
        expect(st.unit).toBe('m²');
        expect(st.output).toBeCloseTo(stageIO(s, st.id, p).output! * M2_PER_TILE, 9);
      }
    }
    expect(f.find((x) => x.id === 'PREP')!.tileEquivalent).toBe(true);
    expect(f.find((x) => x.id === 'KILN')!.tileEquivalent).toBe(false);
  });

  it('compares with a plan only at the line output stage (no invented stage targets)', () => {
    const f = flowStages(s, p);
    const lm = lineMetrics(s, p);
    for (const st of f) {
      if (st.id === 'SORT') {
        expect(st.plan).not.toBeNull();
        expect(st.plan!.planM2).toBeCloseTo(lm.targetM2, 9);
        expect(st.plan!.gapM2).toBeCloseTo(lm.outputM2 - lm.targetM2, 9);
      } else expect(st.plan).toBeNull();
    }
  });

  it('marks the design constraint at the kiln in a normal state', () => {
    const f = flowStages(s, p);
    const marked = f.filter((x) => x.constraint);
    expect(marked.map((x) => x.id)).toEqual(['KILN']);
    expect(marked[0].constraint!.label).toBe('Design constraint');
    expect(f.find((x) => x.id === 'WH')!.status).toBeNull();
    for (const st of f) if (st.id !== 'WH') expect(st.status).not.toBeNull();
  });

  it('shows a stop as the worst state of its stage, its event under that stage, and the constraint trace', () => {
    const t = createSim(84, START);
    for (const id of ['E-PRS1', 'E-PRS2', 'E-PRS3']) activateScenario(t, { kind: 'machine-stop', equipmentId: id, end: null, label: `${id} stop` });
    advance(t, START + 150);
    const f = flowStages(t, resolvePeriod('shift', t.minute));
    const press = f.find((x) => x.id === 'PRESS')!;
    expect(['stopped', 'fault']).toContain(press.status);
    expect(press.alerts.count).toBeGreaterThan(0);
    expect(press.constraint?.constraining).toBe(true);
    expect(press.constraint?.label).toBe('Constraint');
    expect(f.filter((x) => x.constraint).map((x) => x.id)).toEqual([constraintClaim(t).stage]);
    // Downstream of the stop the line runs out of material: those stages read starved / idle, not running.
    expect(f.find((x) => x.id === 'KILN')!.status).not.toBe('running');
    // Every unresolved event is filed under at most one stage, and the counts add up.
    const by = stageAlerts(t);
    const filed = [...by.values()].flat();
    expect(new Set(filed.map((e) => e.id)).size).toBe(filed.length);
    expect(f.reduce((a, x) => a + x.alerts.count, 0)).toBe(filed.length);
    for (const e of filed) expect(e.status).not.toBe('resolved');
  });

  it('counts a stopped conveyor once, for the stage it feeds', () => {
    const t = createSim(85, START);
    activateScenario(t, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: null, label: 'Packing belt stop' });
    advance(t, START + 5);
    const f = flowStages(t, resolvePeriod('shift', t.minute));
    const pack = f.find((x) => x.id === 'PACK')!;
    expect(['stopped', 'fault']).toContain(pack.status);
    expect(pack.statusAssetId).toBe('CV-PACK');
    expect(f.find((x) => x.id === 'SORT')!.statusAssetId).not.toBe('CV-PACK');
    const ev = t.events.find((e) => e.asset.equipmentId === 'CV-PACK' && e.status !== 'resolved')!;
    expect(ev).toBeDefined();
    expect(pack.alerts.ids).toContain(ev.id);
  });

  it('keeps the running kiln count on a stale kiln feed, marked "Not confirmed · kiln data stale since hh:mm" like the KPIs (Decision 1)', () => {
    const t = createSim(86, START);
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
    const since = t.minute;
    advance(t, START + 30);
    const p = resolvePeriod('shift', t.minute);
    const kiln = flowStages(t, p).find((x) => x.id === 'KILN')!;
    // The same number as the simulation's accounting (stage view, reports), not a frozen total.
    expect(kiln.output).toBeCloseTo(stageIO(t, 'KILN', p).output! * M2_PER_TILE, 9);
    expect(kiln.status).toBe('unknown');
    expect(kiln.stale).toMatchObject({ since, frozen: true, assetIds: ['H-KILN'], reason: `kiln data stale since ${formatClock(since)}` });
    // The KPI's mark, word for word (constraint-downtime / OEE carry the kiln feed's status).
    const oee = factoryOeeKpi(t, p);
    expect(oee.provenance).toBe('stale');
    expect(kiln.stale!.label).toBe(oee.status!.label);
    expect(kiln.stale!.short).toBe(kiln.stale!.label);
    expect(kiln.stale!.note).toMatch(/running count, which the feed has not confirmed/);
    // Only the stage whose counting point is stale is marked; the others still count.
    for (const st of flowStages(t, p)) if (st.id !== 'KILN') expect(st.stale, st.id).toBeNull();
    // Advancing further keeps counting, as every other surface does.
    const before = kiln.output!;
    advance(t, START + 45);
    expect(flowStages(t, resolvePeriod('shift', t.minute)).find((x) => x.id === 'KILN')!.output!).toBeGreaterThan(before);
  });

  it('marks a partly stale stage and a stale sorter with the running figures and the KPI wording', () => {
    const t = createSim(87, START);
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'E-PRS2', end: null, label: 'Press 2 feed loss' });
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'I-SORT', end: null, label: 'Sorter feed loss' });
    advance(t, START + 20);
    const p = resolvePeriod('shift', t.minute);
    const f = flowStages(t, p);
    const press = f.find((x) => x.id === 'PRESS')!;
    expect(press.stale).toMatchObject({ frozen: false, assetIds: ['E-PRS2'] });
    expect(press.stale!.label).toMatch(/^Not confirmed · E-PRS2 data stale since \d\d:\d\d$/);
    expect(press.output).toBeCloseTo(stageIO(t, 'PRESS', p).output! * M2_PER_TILE, 9);
    const sort = f.find((x) => x.id === 'SORT')!;
    const good = goodOutputKpi(t, p);
    expect(good.provenance).toBe('stale');
    // SORT shows the Good output KPI's value and its mark; the plan comparison stays (shown as not confirmed).
    expect(sort.output).toBeCloseTo(lineMetrics(t, p).outputM2, 9);
    expect(Math.round(sort.output!).toLocaleString('en-GB')).toBe(good.display);
    expect(sort.stale?.label).toBe(good.status!.label);
    expect(sort.plan).not.toBeNull();
    expect(sort.plan!.gapM2).toBeCloseTo(lineMetrics(t, p).outputM2 - lineMetrics(t, p).targetM2, 9);
  });

  it('files events and assets under one monitored stage', () => {
    expect(assetStage('D-BELT')).toBe('PRESS');
    expect(assetStage('E-COL')).toBe('DRY');
    expect(assetStage('CV-GLZ')).toBe('GLAZE');
    expect(assetStage('CV-PAL')).toBe('PACK');
    expect(assetStage('G-INK')).toBe('GLAZE');
    expect(assetStage('J-PAL')).toBe('PACK');
    expect(assetStage('I-VIS')).toBe('SORT');
    expect(assetStage('K-DOCK')).toBe('WH');
    expect(assetStage('A-HOLD')).toBeNull();
    const base = { id: 'x', status: 'active' } as const;
    // A quality event is filed where it was detected (sorting), not under the hypothesised origin stage.
    expect(eventStage({ ...base, asset: { equipmentId: 'I-VIS', stationId: 'ST-VIS', stage: 'GLAZE', zone: 'I' } } as never)).toBe('SORT');
    expect(eventStage({ ...base, asset: { vehicleId: 'T-1', geofenceId: 'GF-HOLD', zone: 'A' } } as never)).toBeNull();
    expect(eventStage({ ...base, asset: { vehicleId: 'T-1', dockId: 'DOCK-1', zone: 'K' } } as never)).toBe('WH');
  });
});
