import { describe, expect, it } from 'vitest';
import { M2_PER_TILE } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { lineMetrics, qualityIn, resolvePeriod } from '../../sim/metrics';
import { attentionEvents, factoryOeeKpi, fleetKpis, goodOutputKpi, overviewKpis, periodScope, productionKpis, qualityKpis } from '../kpis';
import { DEFAULT_START } from '../../sim/time';

const START = 2 * 1440 + 4 * 60 + 20;

describe('headline KPIs (single source of truth)', () => {
  const s = createSim(81, START);
  const p = resolvePeriod('shift', s.minute);
  const lm = lineMetrics(s, p);

  it('Overview: five KPIs that match the metric layer', () => {
    const k = overviewKpis(s, p);
    expect(k.map((x) => x.id)).toEqual(['good-output', 'target-attainment', 'factory-oee', 'first-pass-quality', 'active-issues']);
    expect(k[0].value).toBeCloseTo(lm.output * M2_PER_TILE, 6);
    expect(k[1].value).toBeCloseTo(lm.attainment!, 9);
    const { availability: a, performance: pf, quality: q, oee } = lm.oee;
    expect(k[2].value).toBeCloseTo(oee.value!, 9);
    expect(oee.value!).toBeCloseTo(a.value! * pf.value! * q.value!, 9);
    const qi = qualityIn(s, p);
    expect(k[3].value).toBeCloseTo(qi.accepted / qi.inspected, 9);
    for (const x of k) {
      expect(x.label.length).toBeGreaterThan(3);
      expect(x.scope.length).toBeGreaterThan(3);
      expect(x.definition.length).toBeGreaterThan(10);
      if (x.unavailable) expect(x.value).toBeNull();
    }
  });

  it('Production, Quality and Fleet sets are complete and never more than five', () => {
    for (const set of [productionKpis(s, p), qualityKpis(s, p), fleetKpis(s, p)]) {
      expect(set.length).toBeGreaterThan(0);
      expect(set.length).toBeLessThanOrEqual(5);
      for (const x of set) expect(x.unavailable ? x.value === null : x.display !== '').toBe(true);
    }
    expect(productionKpis(s, p)[0].value).toBe(overviewKpis(s, p)[0].value);
  });

  it('attention list counts a stoppage once, not its knock-on events', () => {
    const t = createSim(82, START);
    activateScenario(t, { kind: 'machine-stop', equipmentId: 'H-KILN', end: START + 40, label: 'Kiln stop' });
    advance(t, START + 30);
    const list = attentionEvents(t);
    expect(list.every((e) => !e.consequenceOf && e.status !== 'resolved' && e.severity !== 'info')).toBe(true);
    expect(list.some((e) => e.asset.equipmentId === 'H-KILN')).toBe(true);
  });
});

describe('KPI scope, attention and stale data (review fixes)', () => {
  it('a condition detected in the pre-rolled history that is still active needs attention', () => {
    const s = createSim(20261012, DEFAULT_START);
    const preroll = s.events.filter((e) => e.historical && e.end == null && e.status !== 'resolved' && e.severity !== 'info' && !e.consequenceOf);
    const list = attentionEvents(s);
    for (const e of preroll) expect(list).toContain(e);
    expect(list.every((e) => !(e.historical && e.end != null))).toBe(true);
  });

  it('a period that ends now is labelled to date, and the plan names both to-date and whole-shift figures', () => {
    const s = createSim(83, START);
    const p = resolvePeriod('shift', s.minute);
    expect(periodScope(s, p)).toContain('(to date)');
    const k = goodOutputKpi(s, p);
    expect(k.scope).toContain('(to date)');
    expect(k.target).toMatch(/^Plan to date [\d,]+ m² · shift [\d,]+ m²$/);
    const prev = resolvePeriod('prev-shift', s.minute);
    expect(periodScope(s, prev)).toBe(prev.label);
  });

  it('line OEE is marked not confirmed while the kiln data feed is stale', () => {
    const s = createSim(84, START);
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed lost' });
    advance(s, START + 20);
    const k = factoryOeeKpi(s, resolvePeriod('shift', s.minute));
    expect(k.provenance).toBe('stale');
    expect(k.status?.label).toMatch(/kiln data stale since/);
  });

  it('output and quality KPIs are marked not confirmed while the sorting data feed is stale', () => {
    const s = createSim(85, START);
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'I-SORT', end: null, label: 'Sorting feed lost' });
    advance(s, START + 20);
    const p = resolvePeriod('shift', s.minute);
    for (const k of overviewKpis(s, p).filter((x) => ['good-output', 'target-attainment', 'first-pass-quality'].includes(x.id))) {
      expect(k.provenance, k.id).toBe('stale');
      expect(k.status?.label, k.id).toMatch(/sorting data stale since/);
    }
    // Q of line OEE is counted at sorting, so OEE is not confirmed either.
    expect(overviewKpis(s, p).find((x) => x.id === 'factory-oee')!.status?.label).toMatch(/sorting data stale since/);
  });

  it('every KPI of a running period says (to date) in its scope, with units that agree in number', () => {
    const s = createSim(86, START);
    const p = resolvePeriod('shift', s.minute);
    for (const k of [...overviewKpis(s, p), ...productionKpis(s, p), ...qualityKpis(s, p), ...fleetKpis(s, p)]) {
      if (/^Now ·|^Last full hour/.test(k.scope)) continue;
      expect(k.scope, k.id).toContain('(to date)');
    }
    const fleet = fleetKpis(s, p);
    const onSite = fleet.find((k) => k.id === 'active-vehicles')!;
    expect(onSite.unit).toMatch(/^vehicles?$/);
    expect(onSite.target).not.toMatch(/1 trucks/);
  });
});

