/**
 * Review2 finding #30: the inspection-record table re-rendered all 500 rows every simulated minute
 * because its inputs (records, scenario links, event links) were rebuilt on every version change.
 * These tests pin the identity rules the memoised table relies on, and its rendered content.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QualityInspection, ScenarioActivation } from '../../model/types';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { acknowledgeEvent } from '../../sim/events';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { inspectionEventLinks } from './derive';
import { keepUnchanged, periodRecords, sameList, sameMap, scenarioAffected, type HistoryInputs } from './history';
import { HistoryTable } from './HistoryTable';

const inputs = (s: SimState, key: PeriodKey): HistoryInputs => {
  const records = periodRecords(s, resolvePeriod(key, s.minute));
  return { records, affected: scenarioAffected(s, records), links: inspectionEventLinks(s) };
};
const ids = (r: QualityInspection[]) => r.map((x) => x.id);

describe('inspection-record table inputs', () => {
  const s = createSim(7, 7 * 1440 + 4 * 60 + 30);
  activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze deterioration (history test)' });
  advance(s, s.minute + 60);

  it('lists the period records newest first, as the page did before', () => {
    const p = resolvePeriod('24h', s.minute);
    const before = s.inspections.filter((r) => r.time >= p.from && r.time < p.to).reverse();
    expect(ids(periodRecords(s, p))).toEqual(ids(before));
    expect(before.length).toBeGreaterThan(0);
  });

  it('keeps the previous inputs when a version bump changed nothing in the table', () => {
    const prev = inputs(s, '24h');
    const again = inputs(s, '24h');
    expect(again.records).not.toBe(prev.records);
    expect(keepUnchanged(prev, again)).toBe(prev);

    // A lifecycle action bumps the version (the page recomputes) but changes no record or link.
    const ev = s.events.find((e) => e.category === 'quality' && e.status === 'active');
    expect(ev).toBeTruthy();
    expect(acknowledgeEvent(s, ev!.id).ok).toBe(true);
    expect(keepUnchanged(prev, inputs(s, '24h'))).toBe(prev);
  });

  it('re-renders only on minutes that add a record or change a link, over a simulated hour', () => {
    let prev = inputs(s, '24h');
    let kept = 0;
    let changed = 0;
    for (let i = 0; i < 60; i++) {
      advance(s, s.minute + 1);
      const next = inputs(s, '24h');
      const merged = keepUnchanged(prev, next);
      const sameRecords = sameList(ids(prev.records), ids(next.records));
      // Records: identity kept exactly while the period's record list is the same.
      expect(merged.records === prev.records).toBe(sameRecords);
      if (!sameRecords) expect(merged.records).toBe(next.records);
      // Maps: identity kept while their content is the same.
      expect(merged.affected === prev.affected).toBe(sameMap(prev.affected, next.affected));
      expect(merged.links === prev.links).toBe(sameMap(prev.links, next.links, sameList));
      if (merged === prev) kept++;
      else changed++;
      prev = merged;
    }
    // Even at five-fold the reject rate, most simulated minutes add no record and must not render.
    expect(kept).toBeGreaterThan(0);
    expect(changed).toBeGreaterThan(0);
  });

  it('builds new inputs when the period start moves past records', () => {
    const t = createSim(3, 2 * 1440 + 59);
    const prev = inputs(t, 'shift');
    // Into the next shift: the old shift's records leave the period.
    advance(t, t.minute + 8 * 60);
    const next = keepUnchanged(prev, inputs(t, 'shift'));
    expect(next.records).not.toBe(prev.records);
    expect(next.records.every((r) => r.time >= resolvePeriod('shift', t.minute).from)).toBe(true);
  });
});

describe('inspection-record table', () => {
  const rec = (over: Partial<QualityInspection>): QualityInspection => ({
    id: 'INS-1',
    time: 7 * 1440 + 300,
    stationId: 'ST-VIS',
    batchId: 'B-1',
    result: 'reject',
    defect: 'glaze',
    severity: 'major',
    measurement: 'Glaze run 4 mm',
    tiles: 6,
    confidence: 0.912,
    box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    source: 'scenario',
    ...over,
  });
  const sc = { id: 'SCN-1', kind: 'quality-deterioration', label: 'Glaze deterioration (table test)', start: 0, end: null } as unknown as ScenarioActivation;

  it('is memoised and renders the same cells as before', () => {
    expect((HistoryTable as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
    const rows = [
      rec({}),
      rec({ id: 'INS-2', stationId: 'ST-GAUGE', defect: 'planarity', confidence: null, source: 'simulation' }),
      rec({ id: 'INS-3', stationId: 'ST-QC', result: 'pass', defect: null, severity: null, confidence: null, box: null, measurement: null, source: 'simulation' }),
    ];
    const html = renderToStaticMarkup(
      <HistoryTable
        rows={rows}
        selected="INS-2"
        links={new Map([['INS-1', ['EV-00007', 'EV-00003']]])}
        affected={new Map([['INS-1', sc]])}
        onSelect={() => {}}
        onShowEvent={() => {}}
        empty="No inspection records in this period"
      />,
    );
    for (const text of ['INS-1', 'INS-2', 'INS-3', 'Sim. conf.', '91.2 %', '>gauge<', 'Scenario-affected', 'Raised by scenario: Glaze deterioration (table test)', 'EV-00007', '+1', 'Part of EV-00007, EV-00003', 'Reject', 'Pass', 'Major', 'Scenario', 'Simulated'])
      expect(html, text).toContain(text);
    expect(html).toMatch(/<tr[^>]*class="clickable sel"/);
    expect(html.match(/<tbody>.*<\/tbody>/s)![0].match(/<tr/g)).toHaveLength(3);

    const empty = renderToStaticMarkup(<HistoryTable rows={[]} selected={null} links={new Map()} affected={new Map()} onSelect={() => {}} onShowEvent={() => {}} empty="No records match the filters" />);
    expect(empty).toContain('No records match the filters');
  });
});
