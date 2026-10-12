import { beforeAll, describe, expect, it } from 'vitest';
import { activeIssuesKpi, attentionEvents, goodOutputKpi, targetAttainmentKpi } from '../../intel/kpis';
import { activateScenario, advance, createSim, DEFAULT_SEED, type SimState } from '../../sim/engine';
import { resolvePeriod } from '../../sim/metrics';
import { copilotSummary, pickerEvents } from './derive';

let s: SimState;

beforeAll(() => {
  s = createSim(DEFAULT_SEED);
  activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS2', end: null, label: 'Press 2 stop' });
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-GLZ', end: null, label: 'Glaze conveyor stop' });
  advance(s, s.minute + 40);
}, 60_000);

describe('Copilot page header', () => {
  it('states the Overview KPIs of the current shift', () => {
    const p = resolvePeriod('shift', s.minute);
    const sum = copilotSummary(s);
    const good = goodOutputKpi(s, p);
    const att = targetAttainmentKpi(s, p);
    expect(sum.periodLabel).toBe(p.label);
    expect(sum.good).toBe(`${good.display} m²`);
    expect(sum.attainment).toBe(`${att.display} %`);
    expect(sum.issues).toBe(activeIssuesKpi(s).value);
    expect(sum.sentence).toContain(`good output ${good.display} m²`);
    expect(sum.sentence).toContain(`${attentionEvents(s).length} issue`);
  });
});

describe('Incident picker', () => {
  it('lists the issues requiring attention in the Overview order', () => {
    const list = pickerEvents(s);
    expect(list.map((e) => e.id)).toEqual(attentionEvents(s).map((e) => e.id));
    expect(list.length).toBeGreaterThan(0);
    for (let i = 1; i < list.length; i++) expect(['info', 'warning', 'serious', 'critical'].indexOf(list[i - 1].severity)).toBeGreaterThanOrEqual(['info', 'warning', 'serious', 'critical'].indexOf(list[i].severity));
    expect(list.every((e) => e.status !== 'resolved' && e.severity !== 'info' && !e.consequenceOf)).toBe(true);
  });
});
