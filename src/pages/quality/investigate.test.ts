import { describe, expect, it } from 'vitest';
import { DEFECT_ACTIONS } from '../../model/actions';
import { DEFECTS } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { qualityWindow } from '../../sim/events';
import { qualityIn, resolvePeriod, risingDefects } from '../../sim/metrics';
import { inspectionEventLinks, qualityEventsIn } from './derive';
import {
  defaultSelection,
  defectList,
  eventEvidence,
  inPeriod,
  inspectionTopic,
  qualitySummary,
  rateTrend,
  recordEvidence,
  resolveSelection,
  risingDefect,
  summaryText,
} from './investigate';

describe('investigation derivations (shared simulation state)', () => {
  const s = createSim(7, 2 * 1440 + 360);
  activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze deterioration (investigate test)' });
  advance(s, s.minute + 150);
  const p = resolvePeriod('24h', s.minute);
  const links = inspectionEventLinks(s);

  it('calls a category rising only by the shared deterioration rule (last 120 min vs the 24 h before)', () => {
    const r = risingDefect(s, p)!;
    expect(r).not.toBeNull();
    const shared = risingDefects(s, p);
    // The summary's rising category is the shared rule's top one, ranked by excess rejects.
    expect(r.defect).toBe(shared.rising[0].defect);
    for (let i = 1; i < shared.rows.length; i++) expect(shared.rows[i - 1].excessTiles).toBeGreaterThanOrEqual(shared.rows[i].excessTiles);
    // The scenario degrades glazing: the rising category is one that originates there.
    expect(DEFECTS[r.defect].origin).toBe('GLAZE');
    // The rule's thresholds: ≥ deteriorationRatio × reference, ≥ 600 tiles inspected, rate ≥ 0.4 %.
    expect(shared.threshold.ratio).toBe(s.rules.deteriorationRatio);
    expect(r.ratio!).toBeGreaterThanOrEqual(s.rules.deteriorationRatio);
    expect(r.recentRate).toBeGreaterThanOrEqual(shared.threshold.minRate);
    expect(shared.recentInspected).toBeGreaterThanOrEqual(shared.threshold.minInspected);
    expect(r.excessTiles).toBeGreaterThan(0);
    // The rule's window: exactly the last 120 min (the Q-DET minute window at t = now − 1).
    expect(r.window).toEqual({ from: p.to - 120, to: p.to });
    for (const row of shared.rows) expect(row.recentRate!).toBeCloseTo(qualityWindow(s, s.minute - 1, 120, row.defect).rate!, 12);
    // Every period that ends now gives the same answer; a past period ending on the hour reads the hourly counters.
    expect(risingDefect(s, resolvePeriod('shift', s.minute))?.defect).toBe(r.defect);
    const past = risingDefects(s, resolvePeriod('prev-shift', s.minute));
    expect(past.window.to - past.window.from).toBe(120);
    // Nothing inspected (an empty period): nothing is called rising, and the summary says it cannot tell.
    expect(risingDefect(s, { from: s.minute, to: s.minute, label: 'empty' })).toBeNull();
    expect(risingDefects(s, { from: s.minute, to: s.minute, label: 'empty' }).sufficient).toBe(false);
    expect(summaryText({ ...qualitySummary(s, p), rising: null, riseJudged: false }, p.label)).toContain('Too few tiles were inspected in the last 2 h');
  });

  it('summarises rate vs limit, the rising and most frequent defect and the open events from the data', () => {
    const m = qualitySummary(s, p);
    const q = qualityIn(s, p);
    expect(m.inspected).toBe(q.inspected);
    expect(m.rate).toBeCloseTo(q.rejected / q.inspected, 12);
    expect(m.limit).toBe(s.rules.rejectRateMax);
    expect(m.open).toBe(qualityEventsIn(s, p).open.length);
    expect(m.scenario?.label).toBe('Glaze deterioration (investigate test)');
    const text = summaryText(m, p.label);
    expect(text).toMatch(/^Reject rate \d+\.\d\d % in the last 24 hours — (within|above) the 5 % alert limit\./);
    expect(text).toContain(`${DEFECTS[m.rising!.defect].label} is rising`);
    expect(text).toMatch(/quality events? (is|are) open/);
    expect(summaryText({ ...m, rate: null, rising: null, top: null, open: 0, active: 0 }, 'Shift B · 14:00–22:00')).toBe(
      'No tiles have been inspected in Shift B · 14:00–22:00 yet. No quality event is open.',
    );
    expect(inPeriod('Today (since 06:00)')).toBe('today (since 06:00)');
  });

  it('trends the reject rate per hour with the focus category on the same basis', () => {
    const focus = risingDefect(s, p)!.defect;
    const t = rateTrend(s, p, focus);
    expect(t.bucketMin).toBe(60);
    expect(t.points.length).toBeGreaterThanOrEqual(24);
    for (const x of t.points) {
      if (x.inspected <= 0) expect(x.rate).toBeNull();
      else {
        expect(x.rate).toBeCloseTo(x.rejected / x.inspected, 12);
        expect(x.focusRate!).toBeLessThanOrEqual(x.rate! + 1e-12);
      }
    }
    expect(rateTrend(s, resolvePeriod('7d', s.minute), null).bucketMin).toBe(240);
  });

  it('lists quality events and only the reject records no event references, newest first', () => {
    const l = defectList(s, p, { defect: null, recordLimit: 5 }, links);
    const ev = qualityEventsIn(s, p);
    expect(l.events.map((e) => e.id)).toEqual([...ev.open, ...ev.resolved].map((e) => e.id));
    expect(l.records.length).toBeLessThanOrEqual(5);
    expect(l.recordTotal).toBeGreaterThan(l.records.length);
    for (const r of l.records) {
      expect(r.result).toBe('reject');
      expect(r.defect).not.toBeNull();
      expect(links.has(r.id)).toBe(false);
      expect(r.time >= p.from && r.time < p.to).toBe(true);
    }
    for (let i = 1; i < l.records.length; i++) expect(l.records[i - 1].time).toBeGreaterThanOrEqual(l.records[i].time);
    const glaze = defectList(s, p, { defect: 'glaze', recordLimit: 50 }, links);
    expect(glaze.events.every((e) => e.refs.defect === 'glaze')).toBe(true);
    expect(glaze.records.every((r) => r.defect === 'glaze')).toBe(true);
  });

  it('defaults to the newest open quality event, and resolves events, records and unknown ids', () => {
    const id = defaultSelection(s, p, links)!;
    const open = qualityEventsIn(s, p).open;
    expect(open.length).toBeGreaterThan(0);
    expect(id).toBe([...open].sort((a, b) => b.start - a.start || b.id.localeCompare(a.id))[0].id);
    expect(resolveSelection(s, id).kind).toBe('event');
    const rec = s.inspections[s.inspections.length - 1];
    expect(resolveSelection(s, rec.id)).toMatchObject({ kind: 'record', rec });
    expect(resolveSelection(s, 'EV-99999')).toMatchObject({ kind: 'missing', other: null });
    const production = s.events.find((e) => e.category !== 'quality')!;
    expect(resolveSelection(s, production.id)).toMatchObject({ kind: 'missing', other: production });
    // Nothing in an empty period.
    expect(defaultSelection(s, { from: s.minute, to: s.minute, label: 'empty' }, links, { open: [], resolved: [] })).toBeNull();
  });

  it('gathers an event’s evidence: its records, rates before / during / after, causes and actions', () => {
    const ev = qualityEventsIn(s, p).open.find((e) => e.refs.defect === 'glaze' && (e.refs.inspectionIds?.length ?? 0) > 1)!;
    expect(ev).toBeDefined();
    const m = eventEvidence(s, ev, links);
    expect(m.kind).toBe('event');
    expect(m.records.length).toBeGreaterThan(1);
    for (let i = 1; i < m.records.length; i++) expect(m.records[i - 1].time).toBeLessThanOrEqual(m.records[i].time);
    expect(m.records.map((r) => r.id)).toContain(m.primaryId);
    expect(m.noImage).toBeNull();
    expect(m.origin).toBe('GLAZE');
    expect(m.stats.before.value).toBe(ev.acc.referenceRejectRate);
    expect(m.stats.during.value).toBeCloseTo(ev.acc.rejects / ev.acc.inspected, 12);
    expect(m.stats.after.unavailable).toBe('Condition still active');
    expect(m.stats.excess).toBeGreaterThan(0);
    expect(m.actions[0]).toBe(DEFECT_ACTIONS.glaze);
    expect(new Set(m.actions).size).toBe(m.actions.length);
    // Hypotheses keep their confidence: only the recorded scenario input is confirmed.
    expect(m.causes.some((c) => c.confidence === 'possible')).toBe(true);
    expect(m.causes.filter((c) => c.confidence === 'confirmed').every((c) => /scenario/i.test(c.text))).toBe(true);
    expect(m.scenario?.label).toBe('Glaze deterioration (investigate test)');
    expect(m.related.every((e) => e.id !== ev.id && e.category === 'quality')).toBe(true);
    expect(m.batches[m.primaryId!]?.id).toBe(m.records.find((r) => r.id === m.primaryId)!.batchId);
  });

  it('gathers a record’s evidence: own image only for tunnel / gauge records, hypotheses for its origin', () => {
    const vis = [...s.inspections].reverse().find((r) => r.stationId === 'ST-VIS' && r.result === 'reject' && r.defect === 'glaze')!;
    const m = recordEvidence(s, vis, links);
    expect(m.records).toEqual([vis]);
    expect(m.rec).toBe(vis);
    expect(m.causes.find((c) => c.confidence === 'possible')?.basis).toMatch(/hypothesis/);
    expect(m.causes.some((c) => c.confidence === 'confirmed' && /scenario/i.test(c.text))).toBe(true);
    expect(m.actions).toContain(DEFECT_ACTIONS.glaze);
    const lab = s.inspections.find((r) => r.stationId === 'ST-QC')!;
    const l = recordEvidence(s, lab, links);
    expect(l.records).toEqual([]);
    expect(l.noImage).toMatch(/not imaged/);
    expect(l.stats.during.unavailable).toMatch(/lab sample/i);
  });

  it('maps each defect and station to its inspection reference footage', () => {
    expect(inspectionTopic('ST-VIS', 'crack')).toBe('crack-chip-inspection');
    expect(inspectionTopic('ST-VIS', 'chip')).toBe('crack-chip-inspection');
    expect(inspectionTopic('ST-VIS', 'surface')).toBe('surface-inspection');
    expect(inspectionTopic('ST-VIS', 'glaze')).toBe('glaze-defect-inspection');
    expect(inspectionTopic('ST-GAUGE', 'planarity')).toBe('dimensional-inspection');
    expect(inspectionTopic('ST-GAUGE', null)).toBe('dimensional-inspection');
    expect(inspectionTopic('ST-VIS', null)).toBe('surface-inspection');
    expect(inspectionTopic('ST-QC', null)).toBeNull();
  });
});
