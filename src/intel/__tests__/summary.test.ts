import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { TARGET_STATUS_LABEL, bottleneck, lineMetrics, resolvePeriod, targetStatus } from '../../sim/metrics';
import { attentionEvents, goodOutputKpi, overviewKpis, targetAttainmentKpi } from '../kpis';
import { constraintClaim, constraintPhrase, executiveSummary } from '../summary';

const START = 2 * 1440 + 4 * 60 + 20;
const int = (n: number) => Math.round(n).toLocaleString('en-GB');

describe('executive summary', () => {
  it('reads as normal in a normal state, with the design constraint worded as modeled', () => {
    const s = createSim(81, START);
    // Preconditions of a normal state (the seeded run): nothing open, kiln not held up.
    expect(attentionEvents(s)).toHaveLength(0);
    expect(bottleneck(s).cause).toBe('constraint');
    const x = executiveSummary(s);
    const lm = lineMetrics(s, resolvePeriod('shift', s.minute));
    const st = targetStatus(lm.attainment);
    expect(['ahead', 'on-track']).toContain(st);
    expect(x.state).toBe('normal');
    expect(x.sentences).toHaveLength(2);
    // Production vs plan: the shared target status words and the gap in m².
    expect(x.text).toContain(`Production is ${TARGET_STATUS_LABEL[st].toLowerCase()}`);
    expect(x.text).toContain(`${int(lm.outputM2)} m² of good output against ${int(lm.targetM2)} m² planned`);
    expect(x.text).toContain(`${int(Math.abs(lm.targetM2 - lm.outputM2))} m² ${lm.outputM2 >= lm.targetM2 ? 'ahead' : 'short'}`);
    // Only the configured constraint is behind the claim → "modeled design constraint", never "currently constraining".
    expect(x.constraint.kind).toBe('design');
    expect(x.constraint.constraining).toBe(false);
    expect(x.text).toContain('Kiln firing & cooling is the modeled design constraint');
    expect(x.text).not.toMatch(/currently constraining/);
    expect(x.text).toContain('no open issues require attention');
    // Agrees with the KPI cards.
    const k = overviewKpis(s, resolvePeriod('shift', s.minute));
    expect(x.production.outputM2).toBeCloseTo(k[0].value!, 9);
    expect(x.issues.count).toBe(k[4].value);
  });

  it('names the kiln as currently constraining output while it is stopped, with the evidence', () => {
    const s = createSim(82, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, START + 25);
    const c = constraintClaim(s);
    expect(c.kind).toBe('kiln-stopped');
    expect(c.constraining).toBe(true);
    expect(c.stage).toBe('KILN');
    expect(c.label).toBe('Constraint');
    const x = executiveSummary(s);
    expect(x.state).toBe('attention');
    expect(x.text).toContain('Kiln firing & cooling is currently constraining output');
    // The evidence is named: the stop and since when.
    expect(x.text).toMatch(/the kiln has been (stopped|in fault) since \d\d:\d\d/);
    expect(x.text).not.toContain('modeled design constraint');
    // Issues: counted once per root cause, the kiln stop leads (critical).
    const list = attentionEvents(s);
    expect(x.issues.count).toBe(list.length);
    expect(x.issues.top?.asset.equipmentId).toBe('H-KILN');
    expect(x.issues.top?.severity).toBe('critical');
    expect(x.text).toContain(`${list.length === 1 ? '1 open issue requires' : `${list.length} open issues require`} attention`);
    expect(x.text).toContain(`${list[0].title} (critical)`);
  });

  it('names the traced stage when the kiln was held up, and a kiln stop now outranks that trace', () => {
    const s = createSim(90, START);
    // Precondition: in this run the kiln was blocked in the window, traced downstream to sorting.
    expect(bottleneck(s).cause).toBe('blocking');
    const c = constraintClaim(s);
    expect(c.kind).toBe('blocking');
    expect(c.constraining).toBe(true);
    expect(c.stage).toBe('SORT');
    expect(executiveSummary(s).text).toMatch(/Sorting & inspection is currently constraining output — the kiln was blocked \d+ % of the last 2 h, traced downstream to sorting & inspection/);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, s.minute + 10);
    const k = constraintClaim(s);
    expect(k.kind).toBe('kiln-stopped');
    expect(k.stage).toBe('KILN');
  });

  it('traces a press stop upstream from the starved kiln and says so', () => {
    const s = createSim(84, START);
    for (const id of ['E-PRS1', 'E-PRS2', 'E-PRS3']) activateScenario(s, { kind: 'machine-stop', equipmentId: id, end: null, label: `${id} stop` });
    advance(s, START + 150);
    const c = constraintClaim(s);
    expect(c.kind).toBe('starving');
    expect(c.constraining).toBe(true);
    expect(c.stage).toBe('PRESS');
    const x = executiveSummary(s);
    expect(x.text).toContain('Pressing & forming is currently constraining output');
    expect(x.text).toMatch(/the kiln was starved \d+ % of the last 2 h, traced upstream to pressing/);
  });

  it('states output vs plan as not confirmed while the sorting feed is stale — never "ahead of target" (Decision 1)', () => {
    const s = createSim(87, START);
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'I-SORT', end: null, label: 'Sorter feed loss' });
    advance(s, START + 30);
    const p = resolvePeriod('shift', s.minute);
    const lm = lineMetrics(s, p);
    const good = goodOutputKpi(s, p);
    const att = targetAttainmentKpi(s, p);
    expect(good.provenance).toBe('stale');
    expect(att.provenance).toBe('stale');
    const x = executiveSummary(s);
    const reason = good.status!.label.replace(/^Not confirmed · /, '');
    expect(reason).toMatch(/^sorting data stale since \d\d:\d\d$/);
    expect(x.sentences[0]).toBe(`Output vs plan not confirmed — ${reason} (simulated running total ${int(lm.outputM2)} m² of ${int(lm.targetM2)} m² planned to date).`);
    expect(x.text).not.toMatch(/Production is|ahead of target|on track|behind target/i);
    expect(x.production).toMatchObject({ confirmed: false, notConfirmed: reason });
    // The running total is the KPI card's figure.
    expect(int(x.production.outputM2)).toBe(good.display);
    expect(x.state).toBe('attention');
    // The constraint sentence still follows the claim.
    expect(x.text).toContain(constraintPhrase(constraintClaim(s)));
  });

  it('a stale kiln feed leaves the kiln state unknown even after a traced starvation; a slow kiln outranks a traced blockage', () => {
    const s = createSim(84, START);
    for (const id of ['E-PRS1', 'E-PRS2', 'E-PRS3']) activateScenario(s, { kind: 'machine-stop', equipmentId: id, end: null, label: `${id} stop` });
    advance(s, START + 150);
    expect(constraintClaim(s).kind).toBe('starving');
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
    advance(s, s.minute + 5);
    const c = constraintClaim(s);
    expect(c).toMatchObject({ kind: 'kiln-unknown', constraining: false, stage: 'KILN', label: 'Design constraint' });
    expect(executiveSummary(s).text).toContain('Kiln firing & cooling is the modeled design constraint; its data feed is stale, so its current state is unknown');

    const b = createSim(90, START);
    expect(constraintClaim(b).kind).toBe('blocking');
    activateScenario(b, { kind: 'reduced-rate', equipmentId: 'H-KILN', factor: 0.6, end: null, label: 'Kiln slow' });
    advance(b, b.minute + 5);
    expect(constraintClaim(b)).toMatchObject({ kind: 'kiln-slow', constraining: true, stage: 'KILN' });
  });

  it('reports a quality deterioration through the open issues, without inventing a constraint', () => {
    const s = createSim(83, START);
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze ×5' });
    advance(s, START + 90);
    const list = attentionEvents(s);
    expect(list.some((e) => e.category === 'quality')).toBe(true);
    const x = executiveSummary(s);
    expect(x.state).toBe('attention');
    expect(x.issues.count).toBe(list.length);
    expect(x.issues.count).toBeGreaterThan(0);
    expect(x.text).toContain(`${list.length} open issue${list.length === 1 ? ' requires' : 's require'} attention`);
    expect(x.text).toContain(list[0].title);
    // The constraint sentence follows the trace evidence — "currently constraining" only with a traced claim.
    const c = constraintClaim(s);
    if (c.constraining) expect(x.text).toContain(`${c.name} is currently constraining output — ${c.evidence}`);
    else expect(x.text).toContain('modeled design constraint');
  });
});
