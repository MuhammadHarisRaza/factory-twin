/**
 * Stage shift summary — the cost total of the stage's root events never values the same rejects
 * twice: overlapping quality rules (reject rate, defect count, defect rate over the same rejected
 * tiles) are listed per event but not added; production / logistics / energy estimates are added.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eventImpact } from '../../intel/report';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { resolvePeriod } from '../../sim/metrics';
import { fmtMoney } from '../format';
import type { PdfBlock } from '../model';
import { QUALITY_NOT_ADDED, isAddedToStageTotal, stageEvents, stageShiftModel } from '../stageShift';
import { pdfText } from '../text';

let s: SimState;

beforeAll(() => {
  // Review scenario: seed 56, glazing quality deterioration ×5 for 150 min, then the SORT summary.
  s = createSim(56, 2 * 1440 + 370);
  s.liveFrom = s.minute;
  const t0 = s.minute;
  activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: t0 + 150, label: 'Glaze deterioration ×5' });
  advance(s, t0 + 150);
});

const lossesOf = (stage: 'SORT' | 'GLAZE' | 'KILN') => {
  const m = stageShiftModel(s, stage, { generatedAt: '2026-10-11T08:00:00.000Z' })!;
  return m.sections.find((x) => x.title === 'Losses')!.blocks;
};
const measureRow = (blocks: PdfBlock[], label: string) => {
  const t = blocks.find((b) => b.kind === 'table' && b.head[0] === 'Measure');
  if (!t || t.kind !== 'table') throw new Error('no measure table');
  return t.rows.find((r) => r[0] === label)!;
};

describe('stage shift summary · estimated cost of root events', () => {
  it('adds only non-quality root events; overlapping quality events are listed, not added', () => {
    const p = resolvePeriod('shift', s.minute);
    const roots = stageEvents(s, 'SORT', p).filter((e) => !e.consequenceOf);
    const priced = roots.map((e) => ({ e, total: eventImpact(s, e).estimate?.total ?? 0 }));
    const quality = priced.filter((x) => x.e.category === 'quality' && x.total > 0);
    // Precondition of the failure scenario: several quality rules priced the same glazing rejects.
    expect(quality.length).toBeGreaterThanOrEqual(2);

    const added = priced.filter((x) => x.e.category !== 'quality').reduce((a, x) => a + x.total, 0);
    const naive = priced.reduce((a, x) => a + x.total, 0);
    expect(naive).toBeGreaterThan(added);

    const blocks = lossesOf('SORT');
    const row = measureRow(blocks, 'Estimated cost of root events');
    expect(row[1]).toBe(pdfText(fmtMoney('USD', added)));
    expect(row[1]).not.toBe(pdfText(fmtMoney('USD', naive)));
    // The basis says which events were added and why the quality events were not.
    expect(row[2]).toMatch(/^\d+ production \/ logistics \/ energy root events?; quality events are listed per event, not added/);
    const qRow = measureRow(blocks, 'Quality events (not added)');
    expect(qRow[1]).toMatch(new RegExp(`^${quality.length} events? `));
    expect(qRow[2]).toContain(QUALITY_NOT_ADDED);

    // The per-event table still lists every priced quality event, marked as not added.
    const byEvent = blocks.find((b) => b.kind === 'table' && b.head[0] === 'Event');
    if (!byEvent || byEvent.kind !== 'table') throw new Error('no cost-by-event table');
    expect(byEvent.head).toEqual(['Event', 'Title', 'Estimate', 'In the total']);
    for (const q of quality) {
      const r = byEvent.rows.find((x) => x[0] === q.e.id)!;
      expect(r).toBeDefined();
      expect(r[2]).toBe(pdfText(fmtMoney('USD', q.total)));
      expect(r[3]).toBe('Not added (quality rule)');
    }
    for (const r of byEvent.rows) {
      const ev = roots.find((e) => e.id === r[0])!;
      expect(r[3]).toBe(isAddedToStageTotal(ev) ? 'Added' : 'Not added (quality rule)');
    }
    expect(blocks.some((b) => b.kind === 'text' && b.text.includes(QUALITY_NOT_ADDED))).toBe(true);
  });

  it('keeps adding production root events (a kiln-feed conveyor stop) to the total', () => {
    const t = createSim(51, 2 * 1440 + 240);
    t.liveFrom = t.minute;
    const t0 = t.minute;
    activateScenario(t, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 40, label: 'Kiln infeed belt stop' });
    advance(t, t0 + 60);
    const roots = stageEvents(t, 'KILN', resolvePeriod('shift', t.minute)).filter((e) => !e.consequenceOf);
    const expected = roots.filter((e) => e.category !== 'quality').reduce((a, e) => a + (eventImpact(t, e).estimate?.total ?? 0), 0);
    expect(expected).toBeGreaterThan(0);
    const m = stageShiftModel(t, 'KILN')!;
    const row = measureRow(m.sections.find((x) => x.title === 'Losses')!.blocks, 'Estimated cost of root events');
    expect(row[1]).toBe(pdfText(fmtMoney('USD', expected)));
    expect(row[2]).toContain('never twice');
  });

  it('never adds a quality or consequence event', () => {
    const p = resolvePeriod('shift', s.minute);
    for (const e of stageEvents(s, 'SORT', p)) {
      if (e.category === 'quality' || e.consequenceOf) expect(isAddedToStageTotal(e)).toBe(false);
      else expect(isAddedToStageTotal(e)).toBe(true);
    }
  });
});
