import { describe, expect, it } from 'vitest';
import { BASE_REJECT_RATE, DEFECTS, M2_PER_TILE } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { eventById } from '../../sim/events';
import { DEFAULT_FINANCE, rejectCost } from '../../sim/finance';
import { qualityIn, resolvePeriod } from '../../sim/metrics';
import {
  GAUGE_CLASSES,
  SIM_MODEL,
  VISION_CLASSES,
  contextStates,
  correlationEvidence,
  eventRecordIds,
  eventsOfRecord,
  inspectionEventLinks,
  inspectionMethod,
  isVisionRecord,
  periodQualityImpact,
  qualityEventsIn,
  qualityOeeLoss,
  rejectImpact,
  repeatRun,
  ruleChecks,
} from './derive';
import { stillScaleBar, stillView, tileGeometry } from './tileGeometry';
import { frameForRecord } from './frames';

describe('inspection method and classes', () => {
  it('names the simulated vision source and keeps gauge results out of the vision classes', () => {
    expect(inspectionMethod('ST-VIS').source).toBe(SIM_MODEL);
    expect(SIM_MODEL).toMatch(/simulated/);
    expect(inspectionMethod('ST-GAUGE').kind).toBe('gauge');
    expect(inspectionMethod('ST-GAUGE').classKind).toMatch(/non-vision/);
    expect(inspectionMethod('ST-QC').kind).toBe('lab');
    expect(VISION_CLASSES).toEqual(['crack', 'chip', 'surface', 'glaze', 'shade']);
    expect(GAUGE_CLASSES).toEqual(['planarity', 'dimension']);
    expect(isVisionRecord({ stationId: 'ST-VIS' })).toBe(true);
    expect(isVisionRecord({ stationId: 'ST-GAUGE' })).toBe(false);
  });
});

describe('impact helpers', () => {
  it('rejectImpact sums the finance rejectCost lines and never goes negative', () => {
    const r = rejectImpact(DEFAULT_FINANCE, 100);
    const lines = rejectCost(DEFAULT_FINANCE, 100);
    expect(r.lines).toEqual(lines);
    expect(r.total).toBeCloseTo(lines[0].amount + lines[1].amount, 9);
    // 36 m²: 75 % scrapped at 3.9 + 25 % reworked at 1.2.
    expect(r.total).toBeCloseTo(100 * M2_PER_TILE * (0.75 * 3.9 + 0.25 * 1.2), 9);
    expect(rejectImpact(DEFAULT_FINANCE, -5).total).toBe(0);
  });

  it('qualityOeeLoss is A × P × (1 − Q), null when a component is unavailable', () => {
    const ok = (value: number) => ({ value, status: 'ok' as const });
    const r = { availability: ok(0.9), performance: ok(0.95), quality: ok(0.97), oee: ok(0.9 * 0.95 * 0.97), issues: [] };
    expect(qualityOeeLoss(r)).toBeCloseTo(0.9 * 0.95 * 0.03, 12);
    expect(qualityOeeLoss({ ...r, quality: { value: null, status: 'unavailable' } })).toBeNull();
  });
});

describe('record ↔ event links, rules and context (shared state)', () => {
  const s = createSim(7, 2 * 1440 + 360);
  activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze deterioration (test)' });
  advance(s, s.minute + 120);
  const links = inspectionEventLinks(s);
  const quality = s.events.filter((e) => e.category === 'quality');

  it('links every record an event references, through refs or inspection-image evidence', () => {
    expect(quality.length).toBeGreaterThan(0);
    for (const ev of quality) {
      for (const id of ev.refs.inspectionIds ?? []) expect(links.get(id)).toContain(ev.id);
      for (const id of eventRecordIds(s, ev)) expect(links.get(id)).toContain(ev.id);
    }
    for (const x of s.evidence) if (x.kind === 'inspection-image' && x.inspectionId) expect(links.get(x.inspectionId)).toContain(x.eventId);
    // Newest first and only quality events.
    const [recId] = [...links.keys()];
    const evs = eventsOfRecord(s, links, recId);
    expect(evs.every((e) => e.category === 'quality')).toBe(true);
    for (let i = 1; i < evs.length; i++) expect(evs[i - 1].start).toBeGreaterThanOrEqual(evs[i].start);
  });

  it('lists open events regardless of period, resolved ones only when they overlap it', () => {
    const p = resolvePeriod('shift', s.minute);
    const { open, resolved } = qualityEventsIn(s, p);
    expect(open.every((e) => e.status !== 'resolved')).toBe(true);
    expect(open.length).toBe(quality.filter((e) => e.status !== 'resolved').length);
    for (const e of resolved) {
      expect(e.status).toBe('resolved');
      expect((e.end ?? s.minute) >= p.from && e.start < p.to).toBe(true);
    }
  });

  it('evaluates the quality rules at a record with the thresholds in force', () => {
    const rec = [...s.inspections].reverse().find((r) => r.result === 'reject' && r.stationId === 'ST-VIS' && r.time > s.minute - 60)!;
    expect(rec).toBeDefined();
    const checks = ruleChecks(s, { time: rec.time, rec });
    expect(checks.map((c) => c.id)).toEqual(['Q-RATE', 'Q-COUNT', 'Q-REPEAT', 'Q-DET', 'Q-CRIT']);
    const count = checks.find((c) => c.id === 'Q-COUNT')!;
    expect(count.threshold).toContain(String(s.rules.defectCount30Max));
    const before = s.rules;
    s.rules = { ...before, defectCount30Max: 1 };
    const tight = ruleChecks(s, { time: rec.time, rec }).find((c) => c.id === 'Q-COUNT')!;
    expect(tight.threshold).toBe('> 1 tiles');
    s.rules = before;
    expect(repeatRun(s, rec)).toBeGreaterThanOrEqual(1);
    // A sampled pass frame (no record) only feeds the reject-rate rule.
    expect(ruleChecks(s, { time: s.minute - 1, rec: null }).map((c) => c.id)).toEqual(['Q-RATE']);
  });

  it('reads machine states at the record minute from the 4-hour log (null outside it)', () => {
    const rec = [...s.inspections].reverse().find((r) => r.result === 'reject' && r.defect === 'glaze')!;
    const states = contextStates(s, rec);
    expect(states.map((x) => x.id)).toEqual([...['G-LINE'], 'I-SORT']);
    expect(states.every((x) => x.state != null)).toBe(true);
    expect(contextStates(s, { time: s.minute - 600, defect: 'glaze' }).every((x) => x.state == null)).toBe(true);
  });

  it('collects correlation evidence for a scenario-driven event without asserting a cause', () => {
    const ev = quality.find((e) => e.refs.scenarioId && e.refs.defect && DEFECTS[e.refs.defect].origin === 'GLAZE')!;
    expect(ev).toBeDefined();
    const c = correlationEvidence(s, eventById(s, ev.id)!);
    expect(c.scenario?.label).toBe('Glaze deterioration (test)');
    expect(c.origin).toBe('GLAZE');
    expect(c.machines.map((m) => m.id)).toEqual(['G-LINE']);
    expect(c.machines[0].logged).toBeGreaterThan(0);
    expect(c.minuteResolution).toBe(true);
    const shares = c.mix.reduce((a, r) => a + r.share, 0);
    expect(shares).toBeGreaterThan(0.99);
    expect(c.mix.some((r) => r.d === ev.refs.defect)).toBe(true);
    expect(c.concurrent.every((e) => e.category !== 'quality')).toBe(true);
    // Hypotheses keep their confidence: the scenario input is the only confirmed one.
    expect(ev.causes.filter((x) => x.confidence === 'confirmed').every((x) => /scenario/i.test(x.text))).toBe(true);
  });

  it('values the period rejects with the finance assumptions and reports the OEE effect', () => {
    const p = resolvePeriod('24h', s.minute);
    const m = periodQualityImpact(s, p, DEFAULT_FINANCE, null);
    const q = qualityIn(s, p);
    expect(m.inspected).toBe(q.inspected);
    expect(m.rejected).toBe(q.rejected);
    expect(m.total).toBeCloseTo(rejectImpact(DEFAULT_FINANCE, q.rejected).total, 9);
    expect(m.excessVsBase).toBeCloseTo(Math.max(0, q.rejected - q.inspected * BASE_REJECT_RATE), 9);
    expect(m.baselineRejected).toBeNull();
    expect(m.quality.status).toBe('ok');
    expect(m.oeeLossToQuality).not.toBeNull();
    expect(m.oeeLossToQuality!).toBeGreaterThan(0);
    // With the scenario-free twin in step, the extra rejects of the scenario are positive.
    const base = createSim(7, s.minute, { events: false });
    const withBase = periodQualityImpact(s, p, DEFAULT_FINANCE, base);
    expect(withBase.baselineRejected).not.toBeNull();
    expect(withBase.extraVsBaseline!).toBeGreaterThan(0);
  });
});

describe('frame stills', () => {
  const s = createSim(3, 1440 + 300);
  it('crops a square view around the detection box inside the full tile view', () => {
    const rec = s.inspections.find((r) => r.result === 'reject' && r.stationId === 'ST-VIS' && r.box)!;
    const frame = frameForRecord(rec, 'FT-6060-BEI-M')!;
    const g = tileGeometry(frame);
    const full = stillView(g, false);
    const crop = stillView(g, true);
    expect(crop.side).toBeLessThanOrEqual(full.side);
    expect(crop.box).not.toBeNull();
    const b = crop.box!;
    expect(b.x0).toBeGreaterThanOrEqual(crop.x - 1e-6);
    expect(b.y0).toBeGreaterThanOrEqual(crop.y - 1e-6);
    expect(b.x1).toBeLessThanOrEqual(crop.x + crop.side + 1e-6);
    expect(b.y1).toBeLessThanOrEqual(crop.y + crop.side + 1e-6);
    expect(stillScaleBar(crop.side).len).toBeLessThanOrEqual(crop.side * 0.3 + 1e-9);
    // Lab samples have no frame.
    const lab = s.inspections.find((r) => r.stationId === 'ST-QC');
    if (lab) expect(frameForRecord(lab, 'FT-6060-BEI-M')).toBeNull();
  });
});
