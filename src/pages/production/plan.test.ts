/**
 * Plan & flow and OEE & losses derivations: honest constraint wording (modeled vs observed, with
 * evidence), the stage flow, the quantified losses (capacity steps without the transit step; OEE
 * categories adding up to 100 − OEE), the important events and the OEE view's numbers.
 */
import { describe, expect, it } from 'vitest';
import { productionKpis } from '../../intel/kpis';
import { constraintClaim, constraintPhrase, executiveSummary } from '../../intel/summary';
import { M2_PER_TILE, MONITORED_STAGES, MONITORED_STAGE_BY_ID, TARGET } from '../../model/plant';
import { DEFAULT_SEED, activateScenario, advance, createSim } from '../../sim/engine';
import { flowStages } from '../../ui/flow/derive';
import { DEFAULT_FINANCE } from '../../sim/finance';
import { capacityBreakdown, lineMetrics, resolvePeriod } from '../../sim/metrics';
import { lossLedger } from './loss';
import { oeeLosses, productionLosses } from './lossItems';
import { OEE_DEFINITIONS, oeeView } from './oee';
import { constraintView, planData, planSummary, productionEvents, stageFlow } from './plan';
import { bottleneckView, stageRow, stageSentence } from './stage/derive';

const F = DEFAULT_FINANCE;

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const START = 2 * 1440 + 4 * 60 + 20;

describe('constraint statement', () => {
  it('states the kiln as the modeled design constraint in a normal state — never "confirmed by the data"', () => {
    const s = createSim();
    const claim = constraintClaim(s);
    const cv = constraintView(s);
    expect(claim.kind).toBe('design');
    expect(cv.design.stage).toBe('KILN');
    expect(cv.constraint).toEqual(claim);
    expect(cv.named.monitored).toBe('KILN');
    expect(cv.atDesign).toBe(true);
    expect(cv.constraining).toBe(false);
    expect(cv.headline).toBe('Design constraint · Kiln firing & cooling');
    expect(cv.statement).toBe(`${cap(constraintPhrase(claim))}.`);
    for (const text of [cv.headline, cv.statement, ...cv.evidence]) expect(text).not.toMatch(/confirm/i);
    expect(cv.evidence[0]).toMatch(/^Over the last 2 h the kiln was starved \d+ % and blocked \d+ %/);
  });

  it('names the stage the trace ended at when the kiln is starved, with the conveyor as the restriction', () => {
    const s = createSim(62, 2 * 1440 + 240);
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: null, label: 'Kiln infeed stop' });
    advance(s, s.minute + 60);
    const claim = constraintClaim(s);
    const cv = constraintView(s);
    expect(claim.kind).toBe('starving');
    expect(cv.cause).toBe('starving');
    expect(cv.constraining).toBe(true);
    expect(cv.named.monitored).toBe(claim.stage);
    expect(cv.named.monitored).not.toBe('KILN');
    expect(cv.headline).toBe(`Constraint · ${claim.name}`);
    expect(cv.statement).toBe(`${cap(constraintPhrase(claim))}.`);
    expect(cv.kilnStarvedShare).toBeGreaterThan(cv.threshold);
    expect(cv.root?.equipmentId).toBe('CV-KIN');
    expect(cv.restriction).toContain('CV-KIN');
    expect(cv.evidence.some((e) => e.startsWith('Kiln starved'))).toBe(true);
    expect(cv.evidence.some((e) => e.startsWith('Event records: CV-KIN'))).toBe(true);
    const flow = stageFlow(s, resolvePeriod('shift', s.minute));
    expect(flow.filter((r) => r.isClaim).map((r) => r.row.ms.id)).toEqual([claim.stage]);
    expect(flow.find((r) => r.isDesign)!.row.ms.id).toBe('KILN');
  });
});

/**
 * Decision 2 (one constraint statement): in the probe scenarios of the verification round, Production
 * (constraint callout, stage-flow rows, stage view, page summary), the Overview summary and the flow
 * strip name the same stage with the same claim words.
 */
describe('one constraint statement across Production, Overview and the flow strip', () => {
  const agree = (s: ReturnType<typeof createSim>) => {
    const claim = constraintClaim(s);
    const p = resolvePeriod('shift', s.minute);
    const d = planData(s, p, F);
    const phrase = constraintPhrase(claim);
    // Plan & flow callout and page summary.
    expect(d.cv.constraint).toEqual(claim);
    expect(d.cv.named.monitored).toBe(claim.stage);
    expect(d.cv.headline).toBe(`${claim.label} · ${claim.name}`);
    expect(d.cv.statement).toBe(`${cap(phrase)}.`);
    expect(d.summary).toContain(cap(phrase));
    // Stage-flow rows: only the named stage carries the claim; tags follow the claim's label.
    expect(d.flow.filter((r) => r.isClaim).map((r) => r.row.ms.id)).toEqual([claim.stage]);
    const named = d.flow.find((r) => r.isClaim)!.row;
    expect(named.constraint).toEqual(claim);
    expect(named.isBottleneck).toBe(true);
    expect(d.flow.filter((r) => r.row.constraint).length).toBe(1);
    // Stage view of the named stage (same row model) and its header sentence.
    const row = stageRow(s, MONITORED_STAGE_BY_ID[claim.stage], p, bottleneckView(s));
    expect(row.constraint).toEqual(claim);
    expect(stageSentence(row, 'shift')).toContain(`${cap(phrase)}.`);
    // Overview summary and flow strip.
    expect(executiveSummary(s).text).toContain(phrase);
    const strip = flowStages(s, p);
    expect(strip.filter((x) => x.constraint).map((x) => x.id)).toEqual([claim.stage]);
    expect(strip.find((x) => x.constraint)!.constraint!.label).toBe(claim.label);
    // Never "confirmed" unless the claim is constraining; no "Observed constraint" wording of its own.
    const texts = [d.cv.headline, d.cv.statement, d.summary, ...d.cv.evidence];
    if (!claim.constraining) for (const x of texts) expect(x).not.toMatch(/confirmed by the data|· confirmed/i);
    for (const x of texts) expect(x).not.toMatch(/observed constraint/i);
    return { claim, d };
  };

  it('stale kiln feed: the kiln as the modeled design constraint, state unknown — never "confirmed by the data"', () => {
    const s = createSim(DEFAULT_SEED);
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
    advance(s, s.minute + 30);
    const { claim, d } = agree(s);
    expect(claim.kind).toBe('kiln-unknown');
    expect(claim.constraining).toBe(false);
    expect(d.cv.headline).toBe('Design constraint · Kiln firing & cooling');
    expect(d.cv.statement).toMatch(/its data feed is stale, so its current state is unknown/);
    expect(d.cv.evidence).toHaveLength(1);
    expect(d.cv.evidence[0]).toMatch(/^The kiln data feed has been stale since \d\d:\d\d/);
    const kiln = d.flow.find((r) => r.row.ms.id === 'KILN')!;
    expect(kiln.isClaim && kiln.isDesign).toBe(true);
  });

  it('a stale kiln feed outranks an earlier traced starvation: state unknown, not a traced stage', () => {
    const s = createSim(84, START);
    for (const id of ['E-PRS1', 'E-PRS2', 'E-PRS3']) activateScenario(s, { kind: 'machine-stop', equipmentId: id, end: null, label: `${id} stop` });
    advance(s, START + 150);
    expect(constraintClaim(s).kind).toBe('starving');
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
    advance(s, s.minute + 5);
    const { claim } = agree(s);
    expect(claim.kind).toBe('kiln-unknown');
    expect(claim.stage).toBe('KILN');
  });

  it('kiln stopped after a traced blockage: the stopped kiln is constraining, the trace is history', () => {
    const s = createSim(90, START);
    expect(constraintClaim(s).kind).toBe('blocking');
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, s.minute + 10);
    const { claim, d } = agree(s);
    expect(claim.kind).toBe('kiln-stopped');
    expect(claim.stage).toBe('KILN');
    expect(d.cv.headline).toBe('Constraint · Kiln firing & cooling');
    expect(d.summary).toMatch(/Kiln firing & cooling is currently constraining output — the kiln has been (stopped|in fault) since \d\d:\d\d/);
    expect(d.cv.evidence[0]).toMatch(/^Earlier in the last 2 h the kiln was blocked \d+ % of its planned time, traced downstream to sorting & inspection — history/);
  });

  it('upstream starvation, then a kiln stop: the kiln, not glazing, is named everywhere', () => {
    const s = createSim(62, 2 * 1440 + 240);
    const t0 = s.minute;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 60, label: 'Kiln infeed stop' });
    advance(s, t0 + 60);
    expect(constraintClaim(s).stage).toBe('GLAZE');
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, t0 + 70);
    const { claim, d } = agree(s);
    expect(claim.kind).toBe('kiln-stopped');
    expect(claim.stage).toBe('KILN');
    expect(d.flow.find((r) => r.row.ms.id === 'GLAZE')!.isClaim).toBe(false);
    expect(d.cv.evidence[0]).toMatch(/^Earlier in the last 2 h the kiln was starved \d+ % of its planned time, traced upstream to digital decoration — history: the kiln's own stop now outranks that trace\.$/);
    expect(d.summary).not.toMatch(/glazing/i);
  });

  it('a kiln running below its design rate outranks the trace too', () => {
    const s = createSim(90, START);
    expect(constraintClaim(s).kind).toBe('blocking');
    activateScenario(s, { kind: 'reduced-rate', equipmentId: 'H-KILN', factor: 0.6, end: null, label: 'Kiln slow' });
    advance(s, s.minute + 5);
    const { claim, d } = agree(s);
    expect(claim.kind).toBe('kiln-slow');
    expect(d.cv.headline).toBe('Constraint · Kiln firing & cooling');
    expect(d.cv.evidence[0]).toMatch(/^Earlier in the last 2 h the kiln was blocked .* — history: the kiln's own reduced rate now outranks that trace\.$/);
  });
});

describe('stage flow, losses and events', () => {
  const s = createSim(11, 7 * 1440 + 270);
  const p = resolvePeriod('shift', s.minute);

  it('lists every stage in flow order with its input buffer', () => {
    const flow = stageFlow(s, p);
    expect(flow.map((r) => r.row.ms.id)).toEqual(MONITORED_STAGES.map((m) => m.id));
    for (const r of flow) {
      if (r.row.ms.wipBufferId) expect(r.buffer?.id, r.row.ms.id).toBe(r.row.ms.wipBufferId);
      else expect(r.buffer).toBeNull();
    }
  });

  it('production losses are the capacity loss steps (no transit), largest first, valued with a basis', () => {
    const L = lossLedger(s, p, F);
    const items = productionLosses(s, p, F, L);
    const cap = capacityBreakdown(s, p);
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) expect(items[i - 1].m2).toBeGreaterThanOrEqual(items[i].m2);
    for (const it of items) {
      expect(['planned', 'availability', 'speed', 'quality']).toContain(it.key);
      const step = cap.losses.find((l) => l.key === it.key)!;
      expect(step.kind).toBe('loss');
      expect(it.m2).toBeCloseTo(step.m2, 6);
      expect(it.tiles * M2_PER_TILE).toBeCloseTo(it.m2, 6);
      expect(it.investigation.length).toBeGreaterThan(10);
      if (it.value != null) {
        expect(it.lines.length).toBeGreaterThan(0);
        expect(it.value).toBeCloseTo(it.lines.reduce((a, l) => a + l.amount, 0), 9);
      } else expect(it.valueNote).toMatch(/Not valued/);
      expect(it.event != null || (it.eventNote ?? '').length > 0).toBe(true);
    }
  });

  it('OEE loss categories add up to 100 − OEE in points', () => {
    const items = oeeLosses(s, p, F);
    const lm = lineMetrics(s, p);
    const pts = items.reduce((a, x) => a + (x.pts ?? 0), 0);
    expect(pts).toBeCloseTo(100 - lm.oee.oee.value! * 100, 6);
    for (let i = 1; i < items.length; i++) expect(items[i - 1].minutes!).toBeGreaterThanOrEqual(items[i].minutes!);
  });

  it('important events are root production / equipment events overlapping the period, at most five', () => {
    const ev = productionEvents(s, p);
    expect(ev.list.length).toBeLessThanOrEqual(5);
    expect(ev.total).toBeGreaterThanOrEqual(ev.list.length);
    for (const { ev: e } of ev.list) {
      expect(['production', 'equipment']).toContain(e.category);
      expect(e.consequenceOf).toBeUndefined();
      expect(e.start).toBeLessThan(p.to);
      expect(e.end ?? s.minute).toBeGreaterThanOrEqual(p.from);
    }
  });

  it('the page summary states attainment, the largest loss and the constraint from the same figures as the KPIs', () => {
    const lm = lineMetrics(s, p);
    const text = planSummary(lm, productionLosses(s, p, F), constraintView(s), productionKpis(s, p));
    const att = productionKpis(s, p)[1];
    expect(text).toContain(`${(lm.attainment! * 100).toFixed(1)} %`);
    expect(att.display).toBe((lm.attainment! * 100).toFixed(1));
    expect(text).toContain(cap(constraintPhrase(constraintClaim(s))));
    expect(text).toMatch(/largest loss against design capacity/);
  });

  it('states output vs plan and the losses as not confirmed while the sorting feed is stale (Decision 1)', () => {
    const t = createSim(87, START);
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'I-SORT', end: null, label: 'Sorter feed loss' });
    advance(t, START + 30);
    const q = resolvePeriod('shift', t.minute);
    const d = planData(t, q, F);
    const lm = lineMetrics(t, q);
    const good = d.kpis[0];
    expect(good.provenance).toBe('stale');
    expect(d.summary).toMatch(/^Output vs plan not confirmed — sorting data stale since \d\d:\d\d \(simulated running total [\d,]+ m² of [\d,]+ m² planned to date\)\./);
    expect(d.summary).toContain(`${Math.round(lm.outputM2).toLocaleString('en-GB')} m² of ${Math.round(lm.targetM2).toLocaleString('en-GB')} m²`);
    expect(d.summary).not.toMatch(/ahead of target|on track|behind target/i);
    expect(d.lossStale).toBe(good.status!.label.replace('Not confirmed · ', ''));
    expect(d.summary).toContain(`(not confirmed — ${d.lossStale})`);
  });
});

describe('OEE view', () => {
  it('shows A × P × Q with the §10 definitions and the numbers behind each', () => {
    const s = createSim(11, 7 * 1440 + 270);
    const p = resolvePeriod('shift', s.minute);
    const v = oeeView(s, p);
    const lm = lineMetrics(s, p);
    expect(v.components.map((c) => c.definition)).toEqual([OEE_DEFINITIONS.availability, OEE_DEFINITIONS.performance, OEE_DEFINITIONS.quality]);
    expect(v.oee.value).toBe(lm.oee.oee.value);
    expect(v.formula).toMatch(/^OEE = [\d.]+ % × [\d.]+ % × [\d.]+ % = [\d.]+ %$/);
    expect(v.gapPts).toBeCloseTo((lm.oee.oee.value! - TARGET.oeeTarget) * 100, 9);
    expect(v.interpretation[0]).toMatch(/^Line OEE is/);
    const pts = v.components.reduce((a, c) => a + (c.lossPts ?? 0), 0);
    expect(pts).toBeCloseTo(100 - lm.oee.oee.value! * 100, 6);
  });

  it('explains availability with simulated downtime and names the scenario when one caused it', () => {
    const s = createSim(65, 2 * 1440 + 240);
    const t0 = s.minute;
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: t0 + 90, label: 'Kiln stop' });
    advance(s, t0 + 120);
    const v = oeeView(s, resolvePeriod('shift', s.minute));
    const line = v.interpretation.find((t) => t.startsWith('Availability'));
    expect(line).toBeDefined();
    expect(line).toContain('simulated kiln');
    expect(line).toContain('presenter-started scenario');
    expect(v.downtimeMin).toBeGreaterThanOrEqual(89);
    expect(v.scenarioMin).toBeGreaterThanOrEqual(89);
  });
});
