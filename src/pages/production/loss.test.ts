import { describe, expect, it } from 'vitest';
import { CONVEYOR_IDS, DEFECT_ORDER, M2_PER_TILE, PROCESS_MACHINES, STAGES } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { DEFAULT_FINANCE, lostOutputValue } from '../../sim/finance';
import { bottleneck, capacityBreakdown, impactVsBaseline, lineMetrics, qualityIn, resolvePeriod, type Period } from '../../sim/metrics';
import { SHIFT_MIN } from '../../sim/time';
import { withIncludeFlow, type EventFilter } from './derive';
import { assetEvents, conveyorRows, consequenceEvents, machineRows } from './equipment';
import { lineFlow, lineSummary, stageRatePerMin } from './line';
import {
  DEFAULT_WHAT_IF,
  baselineComparison,
  capacitySteps,
  constraintAttribution,
  equipmentContribution,
  lossLedger,
  whatIfs,
  withPeriod,
} from './loss';

/** Mid-shift with two days of history (fast). */
const START = 2 * 1440 + 240;
const win = (from: number, to: number): Period => ({ from, to, label: 'test' });
const F = DEFAULT_FINANCE;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('loss ledger', () => {
  const s = createSim(61, START);
  const p = resolvePeriod('24h', s.minute);
  const L = lossLedger(s, p, F);

  it('takes its totals from the core capacity breakdown and splits them without gaps', () => {
    const cap = capacityBreakdown(s, p);
    expect(L.theoreticalM2).toBeCloseTo(cap.theoreticalM2, 9);
    expect(L.plannedM2).toBeCloseTo(cap.plannedM2, 9);
    expect(L.actualM2).toBeCloseTo(cap.actualM2, 9);
    expect(L.goodM2).toBeCloseTo(cap.goodM2, 9);
    const capLoss = (k: string) => cap.losses.find((l) => l.key === k)!.m2;
    expect(L.downM2 + L.constraintM2).toBeCloseTo(capLoss('availability'), 6);
    expect(L.speedM2).toBeCloseTo(capLoss('speed'), 6);
    expect(L.plannedStopM2).toBeCloseTo(capLoss('planned'), 6);
    expect(L.qualityM2).toBeCloseTo(capLoss('quality'), 6);
    expect(L.transitM2).toBeCloseTo(capLoss('transit'), 6);
    // Theoretical − every step = good output: the waterfall closes.
    expect(L.theoreticalM2 - L.plannedStopM2 - L.downM2 - L.constraintM2 - L.speedM2 - L.qualityM2 - L.transitM2).toBeCloseTo(L.goodM2, 6);
    expect(L.capacityGapM2).toBeCloseTo(L.theoreticalM2 - L.goodM2, 9);
    expect(L.utilisation!).toBeCloseTo(L.goodM2 / L.theoreticalM2, 12);
  });

  it('values each lost unit once: kiln tiles × FPY at contribution, rejects at scrap / rework', () => {
    const lostKilnTiles = (L.downM2 + L.constraintM2 + L.speedM2) / M2_PER_TILE;
    const quality = L.rows.find((r) => r.key === 'quality')!;
    expect(L.outputMoney).toBeCloseTo(lostOutputValue(F, lostKilnTiles * L.fpyUsed).amount + quality.money!, 6);
    expect(L.outputLossM2).toBeCloseTo(L.downM2 + L.constraintM2 + L.speedM2 + L.qualityM2, 9);
    // Planned stops and WIP are not valued; costs carry no m².
    expect(L.rows.find((r) => r.key === 'planned')!.money).toBeNull();
    expect(L.rows.find((r) => r.key === 'transit')!.money).toBeNull();
    for (const r of L.rows.filter((x) => x.kind === 'cost')) expect(r.m2).toBeNull();
  });

  it('financial impact vs plan = shortfall at contribution + direct costs, never theoretical × price', () => {
    expect(L.impact.total).toBeCloseTo(sum(L.impact.lines.map((l) => l.amount)), 9);
    expect(L.impact.shortfallM2).toBeCloseTo(Math.max(0, L.planGapM2), 9);
    expect(L.impact.valuedShortfallM2).toBeCloseTo(Math.max(0, L.planGapM2 - L.lm.rejected * F.reworkShare * M2_PER_TILE), 9);
    expect(L.impact.lines[0].amount).toBeCloseTo(lostOutputValue(F, L.impact.valuedShortfallM2 / M2_PER_TILE).amount, 9);
    expect(L.impact.total).toBeLessThan(L.theoreticalM2 * F.sellingPricePerM2);
  });

  it('the waterfall steps close to good output and the gap bar equals theoretical − good', () => {
    const steps = capacitySteps(L);
    let level = 0;
    for (const st of steps) {
      if (st.kind === 'total') {
        if (st.key !== 'theoretical') expect(level).toBeCloseTo(st.value, 6);
        level = st.value;
      } else if (st.kind !== 'gap') level -= st.value;
    }
    const gap = steps.find((x) => x.kind === 'gap')!;
    expect(gap.value).toBeCloseTo(L.theoreticalM2 - L.goodM2, 9);
    expect(steps.every((x) => x.basis.length > 0)).toBe(true);
  });

  it('a press changeover what-if never recovers more kiln time than the kiln lost', () => {
    const w = whatIfs(s, L, { ...DEFAULT_WHAT_IF, changeoverCut: 1 }, F).find((x) => x.key === 'changeover')!;
    const k = L.lm.constraint.totals;
    const runRate = k.operating > 1 ? k.count / k.operating : 0;
    expect(w.gainTiles).toBeLessThanOrEqual((k.down + k.starved + k.blocked) * runRate * L.fpyUsed + 1e-6);
  });
});

describe('financial impact vs plan with rejects (review #28)', () => {
  const s = createSim(65, START);
  const t0 = s.minute;
  activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: t0 + 90, label: 'Kiln stop' });
  advance(s, t0 + 150);
  const p = win(Math.floor(t0 / 60) * 60, s.minute);
  const L = lossLedger(s, p, F);
  const reworkedTiles = L.lm.rejected * F.reworkShare;

  it('charges reworked rejects at rework cost only, not also as lost contribution', () => {
    expect(L.lm.rejected).toBeGreaterThan(0);
    // Behind plan by more than the reworked rejects: the whole reworked share sits inside the shortfall.
    expect(L.planGapM2).toBeGreaterThan(reworkedTiles * M2_PER_TILE);
    expect(L.impact.shortfallM2).toBeCloseTo(L.planGapM2, 9);
    expect(L.impact.valuedShortfallM2).toBeCloseTo(L.planGapM2 - reworkedTiles * M2_PER_TILE, 9);
    const shortfall = L.impact.lines[0];
    expect(shortfall.amount).toBeCloseTo(lostOutputValue(F, L.planGapM2 / M2_PER_TILE - reworkedTiles).amount, 9);
    expect(shortfall.basis).toMatch(/reworked rejects/);
    // With nothing reworked, the same shortfall is valued in full: the difference is exactly the
    // contribution of the reworked tiles, which the impact no longer charges on top of rework.
    const none = lossLedger(s, p, { ...F, reworkShare: 0 });
    expect(none.impact.valuedShortfallM2).toBeCloseTo(none.impact.shortfallM2, 9);
    expect(none.impact.lines[0].amount - shortfall.amount).toBeCloseTo(lostOutputValue(F, reworkedTiles).amount, 9);
    // Per reworked tile the impact changes by rework − scrap − contribution vs scrapping it.
    const area = reworkedTiles * M2_PER_TILE;
    const contribution = lostOutputValue(F, reworkedTiles).amount;
    expect(L.impact.total - none.impact.total).toBeCloseTo(area * (F.reworkCostPerM2 - F.scrapCostPerM2) - contribution, 6);
  });

  it('keeps the plan gap (attainment) unchanged', () => {
    const cap = capacityBreakdown(s, p);
    expect(L.planGapM2).toBeCloseTo(cap.planGapM2, 9);
    expect(L.impact.shortfallM2).toBeCloseTo(Math.max(0, cap.planGapM2), 9);
  });
});

describe('constraint attribution and equipment contribution', () => {
  const s = createSim(62, START);
  const t0 = s.minute;
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 60, label: 'Kiln infeed stop' });
  advance(s, t0 + 90);
  const p = win(Math.floor(t0 / 60) * 60, s.minute);
  const L = lossLedger(s, p, F);

  it('charges the kiln minutes held up to the root asset, capped at what the kiln lost', () => {
    const att = constraintAttribution(s, p);
    expect(att.heldMin).toBeGreaterThan(5);
    const cv = att.causes.find((c) => c.equipmentId === 'CV-KIN');
    expect(cv).toBeTruthy();
    expect(cv!.minutes).toBeGreaterThan(0);
    expect(cv!.eventIds.length).toBeGreaterThan(0);
    expect(att.attributedMin).toBeLessThanOrEqual(att.heldMin + 1e-9);
    expect(att.attributedMin + att.unattributedMin).toBeCloseTo(att.heldMin, 9);
    expect(att.causes.some((c) => c.equipmentId === 'H-KILN')).toBe(false);
  });

  it('contributions add up to the unplanned loss at the constraint (no double counting)', () => {
    const c = equipmentContribution(s, p, L);
    expect(sum(c.map((x) => x.m2))).toBeLessThanOrEqual(L.outputLossM2 + 1e-6);
    expect(sum(c.map((x) => x.m2))).toBeGreaterThan(L.outputLossM2 - 0.05 * 20);
    expect(c.find((x) => x.equipmentId === 'CV-KIN')!.constraint).toBeGreaterThan(0);
    for (let i = 1; i < c.length; i++) expect(c[i - 1].m2).toBeGreaterThanOrEqual(c[i].m2);
  });

  it('equipment rows cover every machine and conveyor, and link the consequence events', () => {
    const c = equipmentContribution(s, p, L);
    const mr = machineRows(s, p, c);
    const cr = conveyorRows(s, p, c);
    expect(mr.map((r) => r.id)).toEqual(PROCESS_MACHINES);
    expect(cr.map((r) => r.id)).toEqual(CONVEYOR_IDS);
    expect(sum([...mr, ...cr].map((r) => r.lineLossM2))).toBeLessThanOrEqual(L.outputLossM2 + 1e-6);
    const kin = cr.find((r) => r.id === 'CV-KIN')!;
    expect(kin.stops).toBeGreaterThanOrEqual(1);
    expect(kin.availability!).toBeLessThan(1);
    const own = assetEvents(s, 'CV-KIN', p);
    expect(own.some((e) => e.type === 'conveyor-stop')).toBe(true);
    const cons = consequenceEvents(s, own);
    expect(cons.every((e) => own.some((o) => o.id === e.consequenceOf))).toBe(true);
  });
});

describe('stage-level flow events in the equipment drill-down (review #7)', () => {
  const s = createSim(63, START);
  const t0 = s.minute;
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'E-COL', end: null, label: 'Collector stop' });
  advance(s, t0 + 60);
  const p = win(Math.floor(t0 / 60) * 60, s.minute);

  it('lists the press stage blockage for every press, not only the first', () => {
    const block = s.events.find((e) => e.type === 'blockage' && e.asset.stage === 'PRESS' && e.start >= t0);
    expect(block, 'press blockage raised').toBeDefined();
    const L = lossLedger(s, p, F);
    const rows = machineRows(s, p, equipmentContribution(s, p, L));
    for (const id of ['E-PRS1', 'E-PRS2', 'E-PRS3']) {
      expect(assetEvents(s, id, p).map((e) => e.id), id).toContain(block!.id);
      expect(rows.find((r) => r.id === id)!.events, id).toBeGreaterThanOrEqual(1);
    }
    // Not on machines of other stages, and an asset's own events are still listed once.
    expect(assetEvents(s, 'F-DRY', p).some((e) => e.id === block!.id)).toBe(false);
    const own = assetEvents(s, 'E-COL', p);
    expect(own.some((e) => e.type === 'conveyor-stop')).toBe(true);
    expect(new Set(own.map((e) => e.id)).size).toBe(own.length);
  });
});

describe('what-if estimates', () => {
  const s = createSim(63, START);
  const t0 = s.minute;
  activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: t0 + 45, label: 'Kiln stop' });
  advance(s, t0 + 120);
  const p = win(Math.floor(t0 / 60) * 60, s.minute);
  const L = lossLedger(s, p, F);

  it('eliminating the top kiln stop recovers its minutes at the running rate', () => {
    const w = whatIfs(s, L, DEFAULT_WHAT_IF, F);
    const top = w.find((x) => x.key === 'top-downtime')!;
    expect(top.available).toBe(true);
    expect(top.change).toContain('H-KILN');
    expect(top.gainTiles).toBeGreaterThan(0);
    expect(top.gainM2PerShift).toBeCloseTo(top.gainTiles * M2_PER_TILE * (SHIFT_MIN / L.calendarMin), 6);
    expect(top.moneyPerShift).toBeCloseTo(lostOutputValue(F, top.gainTiles).amount * (SHIFT_MIN / L.calendarMin), 6);
  });

  it('kiln performance gains scale with the points and halving a defect gains half its rejects', () => {
    const a = whatIfs(s, L, { kilnPts: 1, changeoverCut: 0.25 }, F).find((x) => x.key === 'kiln-speed')!;
    const b = whatIfs(s, L, { kilnPts: 2, changeoverCut: 0.25 }, F).find((x) => x.key === 'kiln-speed')!;
    if (a.available && b.gainTiles > 0) expect(b.gainTiles).toBeCloseTo(2 * a.gainTiles, 6);
    const q = qualityIn(s, p);
    const top = Math.max(...DEFECT_ORDER.map((d) => q.byDefect[d]));
    const d = whatIfs(s, L, DEFAULT_WHAT_IF, F).find((x) => x.key === 'defect')!;
    expect(d.gainTiles).toBeCloseTo(top / 2, 9);
  });

  it('compares with the no-scenario baseline and values the output difference', () => {
    const base = createSim(63, s.minute, { events: false });
    const cmp = baselineComparison(s, base, p, F);
    const im = impactVsBaseline(s, base, p);
    expect(cmp.impact.deltaOutputM2).toBeCloseTo(im.deltaOutputM2, 9);
    expect(im.deltaOutputM2).toBeLessThan(0);
    const out = cmp.rows.find((r) => r.key === 'output')!;
    expect(out.direction).toBe(-1);
    expect(out.value!).toBeLessThan(0);
    expect(cmp.net).toBeCloseTo(sum(cmp.rows.map((r) => r.value ?? 0)), 9);
    // Energy is not a product module: the comparison values good output only.
    expect(cmp.rows.map((r) => r.key)).not.toContain('energy');
    expect(cmp.net).toBeCloseTo(out.value!, 9);
  });
});

describe('line flow', () => {
  const s = createSim(64, START);
  const bn = bottleneck(s);
  const flow = lineFlow(s, bn);

  it('covers every stage in process order with shares that add up and buffers with cover times', () => {
    expect(flow.map((f) => f.stage)).toEqual(STAGES.map((x) => x.id));
    expect(flow.filter((f) => f.role === 'bottleneck')).toHaveLength(1);
    expect(flow.find((f) => f.role === 'bottleneck')!.stage).toBe(bn.current.stage);
    for (const f of flow) {
      const total = f.workingShare + f.downShare + f.starvedShare + f.blockedShare;
      if (total > 0) expect(total).toBeCloseTo(1, 6);
      if (f.input) {
        expect(f.input.coverMin).toBeCloseTo(f.input.tiles / stageRatePerMin(f.stage), 6);
        expect(f.input.effect.length).toBeGreaterThan(5);
      }
    }
    expect(flow[0].input).toBeNull();
  });

  it('summarises throughput and the WIP protecting the kiln', () => {
    const p = resolvePeriod('shift', s.minute);
    const lm = lineMetrics(s, p);
    const sm = lineSummary(s, lm, s.minute - p.from);
    expect(sm.goodPerHourM2!).toBeCloseTo(lm.outputM2 / ((s.minute - p.from) / 60), 6);
    expect(sm.kilnFeedMin).toBeCloseTo(s.buffers['BUF-KIN'] / (1250 / 60), 6);
    expect(sm.wipTiles).toBeGreaterThan(0);
  });
});

describe('filters and copilot wording', () => {
  it('switching starved / blocked off drops a hidden starved / blocked filter (review #30)', () => {
    const f: EventFilter = { category: 'Starved', equipmentId: 'E-PRS1', reason: 'STARVED', includeFlow: true };
    expect(withIncludeFlow(f, false)).toEqual({ category: 'all', equipmentId: 'E-PRS1', reason: null, includeFlow: false });
    const g: EventFilter = { category: 'Mechanical', equipmentId: 'all', reason: 'MECH_HYD', includeFlow: true };
    expect(withIncludeFlow(g, false)).toEqual({ ...g, includeFlow: false });
    expect(withIncludeFlow({ ...g, includeFlow: false }, true)).toEqual(g);
  });

  it('appends the reporting period so the copilot answers for the same window', () => {
    expect(withPeriod('Why is production below target?', 'shift')).toBe('Why is production below target?');
    expect(withPeriod('Why is production below target?', 'today')).toBe('Why is production below target today?');
    expect(withPeriod('What constraint is limiting good output?', '7d')).toBe('What constraint is limiting good output this week?');
    expect(withPeriod('Which OEE loss is largest?', '24h')).toContain('24');
    expect(withPeriod('Which OEE loss is largest?', 'prev-shift')).toContain('previous shift');
  });
});
