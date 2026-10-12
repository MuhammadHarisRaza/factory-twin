import { describe, expect, it } from 'vitest';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { attentionEvents, factoryOeeKpi, goodOutputKpi } from '../../intel/kpis';
import { M2_PER_TILE } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { resolvePeriod, stageIO } from '../../sim/metrics';
import { flowStages } from '../../ui/flow/derive';
import { ISSUES_MAX, impactLine, issueRow, issueRows, selectionCard } from './derive';

const START = 2 * 1440 + 4 * 60 + 20;

describe('overview issues', () => {
  it('answers what, where, when, impact and next step for a kiln stop', () => {
    const s = createSim(82, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, START + 25);
    const { rows, total } = issueRows(s);
    expect(total).toBe(attentionEvents(s).length);
    expect(rows.length).toBe(Math.min(total, ISSUES_MAX));
    const kiln = rows[0];
    expect(kiln.ev.asset.equipmentId).toBe('H-KILN');
    expect(kiln.where.stageId).toBe('KILN');
    expect(kiln.where.place).toBe('Kiln firing & cooling');
    expect(kiln.where.subjects.map((x) => x.name)).toContain(EQUIPMENT_BY_ID['H-KILN'].name);
    expect(kiln.when.active).toBe(true);
    expect(kiln.when.ago).toMatch(/min ago$/);
    expect(kiln.next).toBe(kiln.ev.recommendations[0]);
    expect(kiln.provenance).toBe('scenario');
    // The kiln is the constraint: the line loss is an estimate (first-pass yield applied) and labelled so.
    expect(kiln.impact.estimate).toBe(true);
    expect(kiln.impact.text).toMatch(/^≈ [\d.,]+ m² of line good output lost · kiln held up \d+ min$/);
  });

  it('labels quality impact as an estimate and files it where it was detected', () => {
    const s = createSim(83, START);
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze ×5' });
    advance(s, START + 90);
    const q = attentionEvents(s).find((e) => e.category === 'quality' && e.acc.referenceRejectRate != null && e.acc.inspected > 0)!;
    expect(q).toBeDefined();
    const r = issueRow(s, q);
    expect(r.where.stageId).toBe('SORT');
    expect(r.impact.estimate).toBe(true);
    expect(r.impact.text).toMatch(/excess rejects vs the 24 h reference rate/);
  });

  it('never claims a line loss for a stop the buffers absorbed', () => {
    const s = createSim(85, START);
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: null, label: 'Packing belt stop' });
    advance(s, START + 3);
    const ev = s.events.find((e) => e.asset.equipmentId === 'CV-PACK' && e.status !== 'resolved')!;
    expect(ev.acc.constraintMin).toBe(0);
    const imp = impactLine(s, ev);
    expect(imp.estimate).toBe(false);
    expect(imp.text).toMatch(/No line output lost/);
  });
});

describe('overview selection card', () => {
  const s = createSim(81, START);
  const p = resolvePeriod('shift', s.minute);

  it('is empty without a selection', () => {
    expect(selectionCard(s, { selected: null, vehicle: null, stage: null }, p)).toBeNull();
  });

  it('shows equipment with its operational state and at most two facts', () => {
    const c = selectionCard(s, { selected: 'H-KILN', vehicle: null, stage: null }, p)!;
    expect(c.kind).toBe('equipment');
    expect(c.title).toBe(EQUIPMENT_BY_ID['H-KILN'].name);
    expect(c.subtitle).toContain('Kiln firing & cooling');
    expect(c.status?.kind).toBe('op');
    expect(c.facts.length).toBeGreaterThan(0);
    expect(c.facts.length).toBeLessThanOrEqual(2);
    // An asset without a state signal says so instead of showing a state.
    const rack = selectionCard(s, { selected: 'K-RACK', vehicle: null, stage: null }, p)!;
    expect(rack.status).toBeNull();
    expect(rack.stageId).toBe('WH');
  });

  it('prefers the selected equipment over the highlighted stage, and shows the stage otherwise', () => {
    expect(selectionCard(s, { selected: 'E-PRS1', vehicle: null, stage: 'KILN' }, p)!.kind).toBe('equipment');
    const st = selectionCard(s, { selected: null, vehicle: null, stage: 'KILN' }, p)!;
    expect(st.kind).toBe('stage');
    expect(st.stageId).toBe('KILN');
    expect(st.subtitle).toContain('design constraint');
    const f = flowStages(s, p).find((x) => x.id === 'KILN')!;
    expect(st.facts[0].value).toContain(Math.round(f.output!).toLocaleString('en-GB'));
    expect(st.stale).toBeNull();
    // The line output stage keeps its "good output" label.
    expect(selectionCard(s, { selected: null, vehicle: null, stage: 'SORT' }, p)!.facts[0].label).toBe('Good output this shift');
  });

  // Decision 1: one figure per stage output — the running count — with the same not-confirmed mark everywhere.
  const card = (t: ReturnType<typeof createSim>, stage: 'KILN' | 'SORT', q: ReturnType<typeof resolvePeriod>) => {
    const f = flowStages(t, q).find((x) => x.id === stage)!;
    const st = selectionCard(t, { selected: null, vehicle: null, stage }, q)!;
    expect(f.stale).not.toBeNull();
    // The card shows the flow strip's figure and the strip's mark.
    expect(st.facts[0].value).toBe(`${Math.round(f.output!).toLocaleString('en-GB')} m² · not confirmed`);
    expect(st.stale).toMatchObject({ since: f.stale!.since, label: f.stale!.label, note: f.stale!.note });
    expect(st.facts[0].hint).toContain(f.stale!.note);
    return { f, st };
  };

  it('kiln feed loss: the stage card shows the flow strip KILN figure (running count) and both carry the kiln mark', () => {
    const t = createSim(86, START);
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
    advance(t, START + 30);
    const q = resolvePeriod('shift', t.minute);
    const { f, st } = card(t, 'KILN', q);
    expect(st.facts[0].label).toBe('Output this shift');
    expect(f.output).toBeCloseTo(stageIO(t, 'KILN', q).output! * M2_PER_TILE, 9);
    expect(st.stale!.label).toBe(factoryOeeKpi(t, q).status!.label);
    expect(st.stale!.label).toMatch(/^Not confirmed · kiln data stale since \d\d:\d\d$/);
    // The equipment card shows the raw signal side: state unknown, values frozen.
    const eq = selectionCard(t, { selected: 'H-KILN', vehicle: null, stage: null }, q)!;
    expect(eq.stale?.note).toMatch(/stale since \d\d:\d\d/);
    expect(eq.stale?.label).toBeUndefined();
    expect(eq.facts[0].value).toMatch(/values frozen/);
    // A fresh stage carries no stale marker.
    expect(selectionCard(t, { selected: null, vehicle: null, stage: 'PRESS' }, q)!.stale).toBeNull();
  });

  it('sorting feed loss: the stage card shows the flow strip SORT figure = the Good output KPI, with the KPI mark', () => {
    const t = createSim(87, START);
    activateScenario(t, { kind: 'signal-loss', equipmentId: 'I-SORT', end: null, label: 'Sorter feed loss' });
    advance(t, START + 30);
    const q = resolvePeriod('shift', t.minute);
    const { st } = card(t, 'SORT', q);
    const good = goodOutputKpi(t, q);
    expect(st.facts[0].label).toBe('Good output this shift');
    expect(st.facts[0].value).toBe(`${good.display} m² · not confirmed`);
    expect(st.stale!.label).toBe(good.status!.label);
  });

  it('shows a vehicle with its simulated activity', () => {
    const id = s.logistics.active[0];
    const c = selectionCard(s, { selected: null, vehicle: id, stage: null }, p)!;
    expect(c.kind).toBe('vehicle');
    expect(c.title).toBe(s.logistics.vehicles[id].label);
    expect(c.status?.kind).toBe('text');
    expect(c.facts.length).toBeLessThanOrEqual(2);
  });
});
