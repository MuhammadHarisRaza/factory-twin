/**
 * OEE integrity checks (master prompt §10): on a baseline simulation every applicable check passes
 * for every period and the counts reconcile; a deliberately inconsistent input is flagged by the
 * check it violates — and only the figures are reported, nothing is adjusted.
 */
import { describe, expect, it } from 'vitest';
import { activateScenario, advance, clearScenario, createSim } from '../../sim/engine';
import { DEFAULT_FINANCE } from '../../sim/finance';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import type { Metric } from '../../sim/oee';
import { evaluateIntegrity, integrityInputs, reconciliationView, type IntegrityCheck, type IntegrityInputs } from './integrity';

const F = DEFAULT_FINANCE;
const KEYS: PeriodKey[] = ['shift', 'prev-shift', 'today', '24h', '7d'];
const byKey = (checks: IntegrityCheck[]) => Object.fromEntries(checks.map((c) => [c.key, c]));
const clone = (x: IntegrityInputs): IntegrityInputs => structuredClone(x);
const ok = (value: number): Metric => ({ value, status: 'ok' });

describe('integrity checks on the simulation', () => {
  const s = createSim();

  it('evaluates the ten checks of §10 and the constraint-data check in order, each with evidence', () => {
    const checks = evaluateIntegrity(integrityInputs(s, resolvePeriod('shift', s.minute), F));
    expect(checks.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(checks.map((c) => c.key)).toEqual(['availability', 'performance', 'quality', 'scope', 'ideal', 'planned', 'double', 'totals', 'losses', 'finance', 'fresh']);
    for (const c of checks) expect(c.evidence.length, c.key).toBeGreaterThan(20);
  });

  it('all applicable checks pass on a baseline run, for every period', () => {
    for (const key of KEYS) {
      const checks = evaluateIntegrity(integrityInputs(s, resolvePeriod(key, s.minute), F));
      for (const c of checks) expect(c.status, `${key} #${c.n} ${c.key}: ${c.evidence}`).not.toBe('attention');
      expect(checks.filter((c) => c.status === 'pass').length, key).toBe(11);
    }
  });

  it('still pass with a conveyor stop and a kiln breakdown (scenario records reconcile too)', () => {
    const t = createSim(62, 2 * 1440 + 240);
    activateScenario(t, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t.minute + 40, label: 'Kiln infeed stop' });
    advance(t, t.minute + 50);
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'H-KILN', end: t.minute + 30, label: 'Kiln stop' });
    advance(t, t.minute + 45);
    for (const key of ['shift', '24h'] as const) {
      const x = integrityInputs(t, resolvePeriod(key, t.minute), F);
      expect(x.kiln.down, 'kiln stopped').toBeGreaterThan(20);
      expect(x.kiln.starved, 'kiln starved').toBeGreaterThan(10);
      for (const c of evaluateIntegrity(x)) expect(c.status, `${key} #${c.n}: ${c.evidence}`).toBe('pass');
    }
  });

  it('flags a kiln feed loss from the simulation: stale now, then a restored gap in the period', () => {
    const t = createSim(62, 2 * 1440 + 240);
    const sc = activateScenario(t, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
    const since = t.minute;
    advance(t, t.minute + 30);
    const p = resolvePeriod('shift', t.minute);
    const x = integrityInputs(t, p, F);
    expect(x.constraintFeed.staleSince).toBe(since);
    const fresh = byKey(evaluateIntegrity(x)).fresh;
    expect(fresh.status).toBe('attention');
    expect(fresh.evidence).toContain('has not updated since');
    // The ten OEE consistency checks are unaffected: nothing is adjusted, the freshness check carries the gap.
    for (const c of evaluateIntegrity(x)) if (c.key !== 'fresh') expect(c.status, `#${c.n} ${c.key}`).not.toBe('attention');
    clearScenario(t, sc.id);
    advance(t, t.minute + 10);
    const y = integrityInputs(t, resolvePeriod('shift', t.minute), F);
    expect(y.constraintFeed.staleSince).toBeNull();
    expect(y.constraintFeed.gaps).toEqual([{ from: since, to: since + 30 }]);
    expect(byKey(evaluateIntegrity(y)).fresh.status).toBe('attention');
    // A period that ends before the gap is fresh.
    const before = { from: p.from, to: since, label: 'before' };
    expect(byKey(evaluateIntegrity(integrityInputs(t, before, F))).fresh.status).toBe('pass');
  });

  it('shows the raw performance value: the displayed value is the unclamped ratio', () => {
    const x = integrityInputs(s, resolvePeriod('shift', s.minute), F);
    const raw = ((60 / x.kilnIdealPerHour!) * x.kiln.count) / x.kiln.operating;
    expect(x.oee.performance.value).toBeCloseTo(raw, 12);
    expect(byKey(evaluateIntegrity(x)).performance.evidence).toContain(`${(raw * 100).toFixed(2)} %`);
  });

  it('count reconciliation closes: every difference is a buffer change, residuals ≈ 0', () => {
    for (const key of KEYS) {
      const x = integrityInputs(s, resolvePeriod(key, s.minute), F);
      const v = reconciliationView(x.chain);
      expect(v.reconciles, key).toBe(true);
      expect(v.steps.map((st) => st.key)).toEqual(['fired', 'sorted', 'inspected', 'good', 'packed', 'palletised']);
      // Sorting passes only accepted tiles downstream: packing counts good output (plus the accumulation buffer change).
      expect(x.chain.good - x.chain.packed - (x.chain.wip.accumulation ?? 0)).toBeCloseTo(0, 6);
      expect(x.chain.fired - x.chain.sorted - (x.chain.wip.kilnOutfeed ?? 0)).toBeCloseTo(0, 6);
    }
  });
});

describe('integrity checks flag inconsistent inputs', () => {
  const s = createSim(11, 7 * 1440 + 270);
  const base = integrityInputs(s, resolvePeriod('shift', s.minute), F);
  const status = (x: IntegrityInputs) => Object.fromEntries(evaluateIntegrity(x).map((c) => [c.key, c.status]));

  it('the untouched input passes', () => {
    expect(Object.values(status(base)).every((v) => v === 'pass')).toBe(true);
  });

  it('1 · availability above 100 %', () => {
    const x = clone(base);
    x.kiln.operating = x.kiln.planned * 1.08;
    x.oee.availability = { value: null, status: 'invalid', issue: 'Operating time exceeds planned time' };
    expect(status(x).availability).toBe('attention');
    expect(byKey(evaluateIntegrity(x)).availability.evidence).toMatch(/exceeds planned/);
  });

  it('2 · performance above the ideal rate is reported, not capped', () => {
    const x = clone(base);
    x.kiln.count = ((x.kilnIdealPerHour! / 60) * x.kiln.operating) * 1.1;
    x.oee.performance = { value: null, status: 'invalid', issue: 'Count implies 110 % of ideal rate' };
    const c = byKey(evaluateIntegrity(x)).performance;
    expect(c.status).toBe('attention');
    expect(c.evidence).toMatch(/110\.0 %/);
    expect(c.evidence).toMatch(/instead of being capped/);
    // A silently capped value (shown 100 % while the raw ratio is 110 %) is flagged as well.
    const y = clone(x);
    y.oee.performance = ok(1);
    expect(status(y).performance).toBe('attention');
  });

  it('3 · good + rejected ≠ inspected (incompatible counts)', () => {
    const x = clone(base);
    x.quality.accepted += 40;
    expect(status(x).quality).toBe('attention');
  });

  it('4 · components over different time windows', () => {
    const x = clone(base);
    x.periodMin += 30;
    expect(status(x).scope).toBe('attention');
  });

  it('5 · a missing ideal cycle time is not replaced', () => {
    const x = clone(base);
    x.idealRates['E-PRS2'] = null;
    const c = byKey(evaluateIntegrity(x)).ideal;
    expect(c.status).toBe('attention');
    expect(c.evidence).toContain('E-PRS2');
  });

  it('6 · plan not following the planned-downtime policy', () => {
    const x = clone(base);
    x.planTiles *= 1.05;
    expect(status(x).planned).toBe('attention');
  });

  it('7 · a reject counted in two defect categories, or packing counting rejects', () => {
    const x = clone(base);
    x.quality.byDefectSum += 12;
    expect(status(x).double).toBe('attention');
    const y = clone(base);
    y.chain.residuals.goodVsPacked = 25;
    expect(status(y).double).toBe('attention');
  });

  it('8 · hour buckets or stop records that do not add up to the period', () => {
    const x = clone(base);
    x.hourly.good += 50;
    expect(status(x).totals).toBe('attention');
    const y = clone(base);
    y.records.unplannedMin += 12;
    expect(status(y).totals).toBe('attention');
  });

  it('9 · losses that do not close to good output', () => {
    const x = clone(base);
    x.capacity.steps = x.capacity.steps.map((st) => (st.key === 'speed' ? { ...st, m2: st.m2 + 20 } : st));
    expect(status(x).losses).toBe('attention');
  });

  it('10 · financial assumptions that make an estimate meaningless', () => {
    const x = clone(base);
    x.finance = { ...x.finance, variableCostPerM2: x.finance.sellingPricePerM2 + 1 };
    expect(status(x).finance).toBe('attention');
  });

  it('not applicable before any production time', () => {
    const t = createSim(11, 7 * 1440 + 360);
    const p = { from: t.minute, to: t.minute, label: 'empty' };
    const checks = byKey(evaluateIntegrity(integrityInputs(t, p, F)));
    expect(checks.availability.status).toBe('na');
    expect(checks.performance.status).toBe('na');
    expect(checks.quality.status).toBe('na');
    expect(checks.scope.status).toBe('na');
  });

  it('11 · a stale constraint feed (now, or earlier in the period) needs attention', () => {
    const x = clone(base);
    x.constraintFeed = { ...x.constraintFeed, staleSince: x.constraintFeed.now - 30 };
    const c = byKey(evaluateIntegrity(x)).fresh;
    expect(c.status).toBe('attention');
    expect(c.title).toBe('Constraint data fresh for the whole period');
    expect(c.evidence).toMatch(/H-KILN data feed has not updated since \d\d:\d\d/);
    const y = clone(base);
    y.constraintFeed = { ...y.constraintFeed, gaps: [{ from: y.constraintFeed.now - 50, to: y.constraintFeed.now - 20 }] };
    expect(byKey(evaluateIntegrity(y)).fresh).toMatchObject({ status: 'attention' });
    expect(byKey(evaluateIntegrity(y)).fresh.evidence).toMatch(/was stale \d\d:\d\d–\d\d:\d\d in this period \(30\.0 min\)/);
  });

  it('an unexplained difference in the count chain is reported', () => {
    const x = clone(base);
    x.chain.residuals.packedVsPalletised = 7.5;
    const v = reconciliationView(x.chain);
    expect(v.reconciles).toBe(false);
    expect(v.worst).toBeCloseTo(7.5, 9);
  });
});
