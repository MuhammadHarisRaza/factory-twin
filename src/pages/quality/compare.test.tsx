/**
 * Quality › Compare: denominators (inspected tiles, never records), small samples, the z-test against the
 * rest of the window, batch attribution by the press-to-sorting lag, partitions that add up, gaps instead
 * of 0 %, the scatter pairing only batches with matched data, and the tab's honest wording.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});
vi.mock('../../video/ContextVideo', () => ({ ContextVideo: () => '[video]' }));
vi.mock('../../ui/report/Lifecycle', () => ({ Lifecycle: () => '[lifecycle]' }));

import { useApp } from '../../app/store';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { qualityIn } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { QualityPage } from '../QualityPage';
import {
  ASSOCIATION_NOTE,
  COMPARE_MIN_TILES,
  RECIPE_NOTE,
  SCATTER_MIN_BATCHES,
  associationModel,
  batchAtSorting,
  compareView,
  compareWindow,
  emptyCounts,
  groupStats,
  rangeAvailability,
  rangeCovering,
  versusRest,
  type Counts,
} from './compare';
import { CompareTab } from './CompareTab';
import { openCompare, useCompareFocus } from './compareFocus';

const counts = (inspected: number, rejected: number): Counts => ({ ...emptyCounts(), inspected, rejected });

describe('group statistics and the test against the rest', () => {
  it('uses tiles inspected as the denominator and the rest = total − group', () => {
    const g = counts(1000, 50);
    const vs = versusRest(g, counts(3000, 80));
    expect(vs.restInspected).toBe(2000);
    expect(vs.restRate).toBeCloseTo(30 / 2000, 12);
    expect(vs.test?.status).toBe('ok');
    expect(vs.verdict).toBe('higher');
    expect(vs.text).toMatch(/5\.00 % vs 1\.50 % for the rest \(2,000 tiles\), z = \d/);
    const st = groupStats(g);
    expect(st.rate.value).toBeCloseTo(0.05, 12);
    expect(st.fpy.value).toBeCloseTo(0.95, 12);
  });

  it('a lower group is significant · lower; a similar one not significant', () => {
    expect(versusRest(counts(1000, 5), counts(3000, 95)).verdict).toBe('lower');
    expect(versusRest(counts(1000, 20), counts(3000, 61)).verdict).toBe('not-significant');
  });

  it('small samples give "too few samples", nothing inspected gives unavailable — never 0 %', () => {
    expect(versusRest(counts(COMPARE_MIN_TILES - 1, 10), counts(5000, 100)).verdict).toBe('too-few');
    const none = versusRest(counts(0, 0), counts(5000, 100));
    expect(none.verdict).toBe('unavailable');
    const st = groupStats(counts(0, 0));
    expect(st.rate.status).toBe('unavailable');
    expect(st.rate.value).toBeNull();
    expect(st.fpy.value).toBeNull();
    expect(versusRest(counts(500, 10), counts(500, 10)).verdict).toBe('no-rest');
  });
});

describe('windows', () => {
  it('ends with the current hour and is clipped to the history', () => {
    expect(compareWindow(600, '8h')).toEqual({ window: { from: 120, to: 600 }, clipped: false });
    expect(compareWindow(300, '24h').clipped).toBe(true);
    expect(rangeAvailability(300)).toMatchObject({ '24h': expect.stringMatching(/Only 5 h/), '7d': expect.any(String) });
    expect(rangeAvailability(3 * 1440)['7d']).toBeUndefined();
  });
});

describe('on a simulated plant', () => {
  const s = createSim(7, 2 * 1440 + 360);

  it('partitions the window: batches, shifts and the hourly trend add up to the total', () => {
    const v = compareView(s, '24h');
    const total = v.total.counts;
    expect(total.inspected).toBeGreaterThan(1000);
    expect(total.inspected).toBeCloseTo(qualityIn(s, { from: v.window.from, to: v.window.to, label: '' }).inspected, 6);
    const sum = (xs: { counts: Counts }[], k: 'inspected' | 'rejected') => xs.reduce((a, x) => a + x.counts[k], 0);
    for (const k of ['inspected', 'rejected'] as const) {
      expect(sum(v.batches, k)).toBeCloseTo(total[k], 6);
      expect(sum(v.shifts, k)).toBeCloseTo(total[k], 6);
      expect(sum(v.products, k)).toBeCloseTo(total[k], 6);
      expect(v.trend.reduce((a, b) => a + b[k], 0)).toBeCloseTo(total[k], 6);
    }
    for (const b of v.trend) if (b.inspected === 0) expect(b.rate).toBeNull();
    for (const b of v.batches) if (b.status === 'not-at-sorting') expect(b.counts.inspected).toBe(0);
    expect(v.defects.every((d) => /stage \d+/.test(d.originText))).toBe(true);
  });

  it('attributes tiles to the batch the inspection records carry (pressed 3 h earlier)', () => {
    const recs = s.inspections.filter((r) => r.stationId !== 'ST-QC').slice(-200);
    expect(recs.length).toBeGreaterThan(20);
    for (const r of recs) expect(batchAtSorting(s.batches, r.time)?.id).toBe(r.batchId);
  });

  it('finds the shortest range that covers a linked batch', () => {
    const v = compareView(s, '8h');
    expect(rangeCovering(s, v.batches[0].key)).toBe('8h');
    expect(rangeCovering(s, s.batches[0].id)).not.toBe('8h');
    expect(rangeCovering(s, 'B-UNKNOWN')).toBe('none');
  });

  it('a young plant has too few matched batches for the scatter', () => {
    const young = createSim(9, 300);
    const a = associationModel(young, compareView(young, '8h'), { findings: [] });
    expect(a.enough).toBe(false);
    expect(a.points.length).toBeLessThan(SCATTER_MIN_BATCHES);
    expect(a.unmatched.length).toBeGreaterThan(0);
  });
});

describe('process association', () => {
  const s = createSim(41, 6 * 1440 + 240);
  beforeAll(() => {
    activateScenario(s, { kind: 'process-deviation', signalId: 'H-KILN.zone3_temp_pv', offset: 35, end: null, label: 'Kiln zone 3 over-firing' });
    advance(s, s.minute + 60);
  });

  it('shows the rule finding and pairs only batches with matched data', () => {
    const v = compareView(s, '7d');
    const a = associationModel(s, v);
    const fired = a.findings.filter((f) => f.status === 'fired');
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0].explanation).toMatch(/Association to investigate — not a demonstrated cause/);
    expect(a.pv.id).toBe('H-KILN.zone3_temp_pv');
    const ids = new Set(v.batches.map((b) => b.key));
    for (const p of a.points) {
      expect(ids.has(p.batchId)).toBe(true);
      const b = v.batches.find((x) => x.key === p.batchId)!;
      expect(b.counts.inspected).toBeGreaterThanOrEqual(COMPARE_MIN_TILES);
      expect(b.status).not.toBe('not-at-sorting');
      expect(Number.isFinite(p.x) && p.x >= 0).toBe(true);
      expect(p.y).toBeCloseTo(b.rate.value!, 12);
    }
    expect(a.points.length + a.unmatched.length).toBe(v.batches.length);
    expect(a.enough).toBe(a.points.length >= SCATTER_MIN_BATCHES);
    expect(a.enough).toBe(true);
    // A chosen process value is honoured.
    expect(associationModel(s, v, { pvId: 'D-TWR.outlet_temp_pv', findings: a.findings }).pv.id).toBe('D-TWR.outlet_temp_pv');
  });
});

describe('Compare tab render', () => {
  const sync = () => {
    useApp.setState({ workspace: 'quality', period: '24h', tabs: { quality: 'compare' }, qualityEventId: null });
    Object.assign(useApp.getInitialState(), useApp.getState());
    Object.assign(useSim.getInitialState(), useSim.getState());
  };
  const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

  it('renders the tab inside the Quality page with honest wording', () => {
    useSim.getState().pause();
    sync();
    const html = renderToStaticMarkup(<QualityPage />);
    const tab = html.slice(html.indexOf('class="qd-tab qc"'));
    expect(tab.length).toBeGreaterThan(1000);
    for (const t of ['Reject rate and first-pass yield by group', 'Comparison window', 'Reject rate per hour', 'Defect categories', 'Process association', ASSOCIATION_NOTE, 'Simulated'])
      expect(tab).toContain(t);
    const visible = text(tab);
    expect(visible).not.toMatch(/\bAI\b|Ghani|tiles\/h|caused by|root cause|\bproves?\b/i);
    expect(visible).not.toMatch(/\bconnected\b/i);
    expect(html).toContain('Compare');
  });

  it('product view says the recipe is not modelled; shift view lists the shifts', () => {
    const p = renderToStaticMarkup(<CompareTab onBatchRecords={() => {}} initialGroup="product" />);
    expect(p).toContain(RECIPE_NOTE);
    const sh = renderToStaticMarkup(<CompareTab onBatchRecords={() => {}} initialGroup="shift" />);
    expect(sh).toMatch(/Shift [ABC] · /);
  });

  it('openCompare focuses a batch and switches to the tab', () => {
    useApp.setState({ workspace: 'quality', tabs: {} });
    const id = useSim.getState().sim.batches[0].id;
    openCompare(id);
    expect(useCompareFocus.getState().batchId).toBe(id);
    expect(useApp.getState().tabs.quality).toBe('compare');
    useCompareFocus.getState().setBatch(null);
  });
});
