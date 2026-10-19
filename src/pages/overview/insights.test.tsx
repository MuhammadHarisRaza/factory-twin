/**
 * Overview wave 3: operational insights (rule findings), equipment state now, data freshness & coverage, the
 * measured-condition impact line, mass-flow selection cards — derive functions and server-rendered markup —
 * plus the honesty test over the Overview page and the app Shell header.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1920,
    innerHeight: 1080,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
});

import { Header } from '../../app/Shell';
import { useApp } from '../../app/store';
import { plantFindings } from '../../intel/rules';
import { coverage } from '../../model/catalog';
import { CONVEYOR_IDS, PROCESS_MACHINES } from '../../model/plant';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { operationalState, resolvePeriod } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { OverviewPage } from '../OverviewPage';
import { dataCoverage, freshnessCounts } from './coverage';
import { conditionLine, impactLine, selectionCard } from './derive';
import { INSIGHTS_TOP, firstSentence, insightFeed } from './findings';
import { ALWAYS_SHOWN, stateMix } from './states';

useSim.getState().pause();
const START = 2 * 1440 + 4 * 60 + 20;
const noSelection = { selected: null, vehicle: null, stage: null, zone: null };

const render = (node: React.ReactElement) => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useTwin.getInitialState(), useTwin.getState());
  return renderToStaticMarkup(node);
};
const setSim = (sim: SimState) => useSim.setState({ sim, version: sim.version + 1 });

/** Degrading press + kiln feed loss: findings of several families, a stale feed, an equipment event. */
function disturbed(): SimState {
  const s = createSim(35, START);
  activateScenario(s, { kind: 'degradation', equipmentId: 'E-PRS2', end: null, label: 'Pump wear' });
  activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
  advance(s, START + 60);
  return s;
}

describe('overview insights feed', () => {
  it('lists the top fired plant findings with severity, basis, one line, where, since and a link', () => {
    const s = disturbed();
    const f = insightFeed(s);
    const p = plantFindings(s, { top: INSIGHTS_TOP });
    expect(f.rows.length).toBe(Math.min(INSIGHTS_TOP, f.firedTotal));
    expect(f.rows.map((r) => r.key)).toEqual(p.top.map((x) => x.key));
    expect(f.firedTotal).toBe(p.summary.byStatus.fired);
    expect(f.bySeverity.reduce((a, x) => a + x.count, 0)).toBe(f.firedTotal);
    expect(f.byFamily.reduce((a, x) => a + x.count, 0)).toBe(f.firedTotal);
    for (const r of f.rows) {
      expect(['Rule-based', 'Statistical']).toContain(r.classification);
      expect(r.line.length).toBeGreaterThan(0);
      expect(r.line.length).toBeLessThanOrEqual(240);
      expect(r.where.length).toBeGreaterThan(0);
      if (r.since) expect(r.since).toMatch(/^since (\w{3}, \d+ \w{3} )?\d\d:\d\d$/);
    }
    const kiln = f.rows.find((r) => r.ruleId === 'DQ-SOURCE')!;
    expect(kiln).toBeDefined();
    expect(kiln.where).toBe('H-KILN · Single-layer roller kiln · Stage 7 Kiln firing');
    expect(kiln.target).toEqual({ kind: 'equipment', equipmentId: 'H-KILN', label: 'Open in twin' });
  });

  it('filters by family and falls back to all for a family without findings', () => {
    const s = disturbed();
    const all = insightFeed(s);
    const fam = all.byFamily[0].family;
    const one = insightFeed(s, fam);
    expect(one.filter).toBe(fam);
    expect(one.rows.every((r) => r.family === fam)).toBe(true);
    expect(one.fired).toBe(all.byFamily[0].count);
    const missing = (['production', 'flow', 'quality', 'reliability', 'data'] as const).find((x) => !all.byFamily.some((b) => b.family === x));
    if (missing) expect(insightFeed(s, missing).filter).toBe('all');
  });

  it('keeps ids and decimals whole when cutting the first sentence', () => {
    expect(firstSentence('F-BUF.level fell to 3.5 % in 60 min. Next sentence.')).toBe('F-BUF.level fell to 3.5 % in 60 min.');
    expect(firstSentence('one sentence only')).toBe('one sentence only');
    expect(firstSentence(`${'word '.repeat(80)}end.`, 50).length).toBeLessThanOrEqual(50);
  });
});

describe('overview equipment state now', () => {
  it('counts every machine once per state, the brief states always shown', () => {
    const s = createSim(35, START);
    const m = stateMix(s);
    expect(m.total).toBe(PROCESS_MACHINES.filter((id) => s.machines[id]).length);
    expect(m.buckets.reduce((a, b) => a + b.count, 0)).toBe(m.total);
    for (const st of ALWAYS_SHOWN) expect(m.buckets.some((b) => b.state === st)).toBe(true);
    const c = stateMix(s, 'conveyors');
    expect(c.total).toBe(CONVEYOR_IDS.filter((id) => s.machines[id]).length);
    expect(c.buckets.reduce((a, b) => a + b.count, 0)).toBe(c.total);
  });

  it('puts a stopped machine under stopped/fault and a stale feed under unknown', () => {
    const s = createSim(82, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS1', end: null, label: 'Press stop' });
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
    advance(s, START + 20);
    const m = stateMix(s);
    const of = (id: string) => m.buckets.find((b) => b.assets.some((a) => a.id === id))!.state;
    expect(of('H-KILN')).toBe('unknown');
    expect(of('E-PRS1')).toBe(operationalState(s, 'E-PRS1'));
    expect(['stopped', 'fault']).toContain(of('E-PRS1'));
  });
});

describe('overview data freshness & coverage', () => {
  it('reports the catalogue coverage, never a connection, and the stale feeds', () => {
    const s = createSim(35, START);
    const d = dataCoverage(s);
    const c = coverage().total;
    expect(d.catalogue.total).toBe(c.total);
    for (const st of ['simulated', 'not-modelled', 'unavailable'] as const) expect(d.catalogue.rows.find((r) => r.status === st)?.count).toBe(c.byStatus[st]);
    expect(d.connected).toBe(0);
    expect(d.headline).toBe('No plant system connected — demo simulation');
    expect(d.sources.connected).toEqual([]);
    expect(d.staleFeeds).toEqual([]);
    const f = d.freshness;
    expect(f.current + f.late + f.stale + f.bad + f.noValue + f.eventDriven).toBe(f.checked);
    expect(f.checked).toBe(c.byStatus.simulated);

    const t = disturbed();
    const d2 = dataCoverage(t);
    expect(d2.staleFeeds.map((x) => x.id)).toEqual(['H-KILN']);
    expect(d2.staleFeeds[0].clock).toMatch(/^\d\d:\d\d$/);
    expect(freshnessCounts(t).stale).toBeGreaterThan(0);
  });
});

describe('overview measured condition and mass flows', () => {
  it('states the measured condition of a degrading machine — no health score, no time to trip', () => {
    const s = disturbed();
    const line = conditionLine(s, 'E-PRS2')!;
    expect(line.text).toMatch(/^Vibration \d+\.\d mm\/s RMS, above (alarm|warning) \d+\.\d( for .+| \(this minute\))$/);
    expect(line.estimate).toBe(false);
    for (const ev of s.events.filter((e) => e.category === 'equipment')) {
      const t = impactLine(s, ev).text;
      expect(t).not.toMatch(/health|\/100|trip|projected/i);
    }
  });

  it('shows slip / powder rates in t/h with the disclosure, never tiles/h', () => {
    const s = createSim(35, START);
    const p = resolvePeriod('shift', s.minute);
    for (const id of ['D-TWR', 'C-BM1', 'D-BELT']) {
      const card = selectionCard(s, { ...noSelection, selected: id } as never, p)!;
      const rate = card.facts[0];
      expect(rate.value, id).toMatch(/^\d+\.\d t\/h/);
      expect(JSON.stringify(card), id).not.toContain('tiles/h');
      expect(card.note, id).toMatch(/simulated conversion: tile-equivalent rate × [\d.]+ kg per tile/);
    }
  });
});

describe('overview render (wave 3 blocks)', () => {
  it('renders the insights, the state strip and the data card with their links', () => {
    setSim(disturbed());
    useTwin.setState({ ...noSelection, ready: true });
    useApp.setState({ workspace: 'overview' });
    const html = render(<OverviewPage />);
    for (const text of [
      'Operational insights',
      'Rule-based',
      'Open in twin',
      'Detection rules',
      'Single-layer roller kiln: data source interrupted',
      'Equipment state now',
      'Plan &amp; flow',
      'Unknown',
      'Data freshness &amp; coverage',
      'No plant system connected — demo simulation',
      'Data &amp; connectivity',
      'Feeds stale now:',
      'H-KILN since',
    ])
      expect(html, text).toContain(text);
    expect(html.match(/class="ov-in sev-/g)?.length).toBe(Math.min(INSIGHTS_TOP, insightFeed(useSim.getState().sim).firedTotal));
    // Order: work grid (model, issues, flow + states) before the intel row (insights, data).
    expect(html.indexOf('ov-states')).toBeGreaterThan(html.indexOf('class="ov-work"'));
    expect(html.indexOf('ov-insights')).toBeGreaterThan(html.indexOf('ov-states'));
    expect(html.indexOf('ov-data')).toBeGreaterThan(html.indexOf('ov-insights'));
  });
});

describe('Overview honesty', () => {
  const states: [string, () => SimState, string | null][] = [
    ['normal', () => createSim(81, START), null],
    ['disturbed', disturbed, 'D-TWR'],
    [
      'powder end stopped',
      () => {
        const s = createSim(84, START);
        activateScenario(s, { kind: 'machine-stop', equipmentId: 'D-TWR', end: null, label: 'Spray dryer stop' });
        activateScenario(s, { kind: 'reduced-rate', equipmentId: 'C-BM1', factor: 0.5, end: null, label: 'Mill slow' });
        advance(s, START + 90);
        return s;
      },
      'C-BM1',
    ],
  ];
  for (const [name, make, selected] of states)
    it(`${name}: no plant name, no connection claim, no AI, no tiles/h for powder / slip / silo`, () => {
      setSim(make());
      useTwin.setState({ ...noSelection, selected, ready: true });
      useApp.setState({ workspace: 'overview' });
      const html = render(<OverviewPage />) + render(<Header title="Overview" period />);
      // Anywhere in the markup, attributes (titles, aria labels) included.
      expect(html).not.toMatch(/Ghani/i);
      expect(html).not.toMatch(/\bAI\b|artificial intelligence|machine learning/);
      expect(html).not.toMatch(/>Live</);
      // "connected" only ever in a negation (not connected / no … connected / nothing is connected).
      for (const m of html.matchAll(/\bconnected\b/gi)) {
        const before = html.slice(Math.max(0, m.index! - 80), m.index!);
        expect(before, before).toMatch(/\b(not|no|nothing)\b/i);
      }
      // A tiles/h figure never sits in a text fragment about the powder / slip / silo end.
      const fragments = html.split(/<[^>]+>/).concat([...html.matchAll(/(?:title|aria-label)="([^"]*)"/g)].map((x) => x[1]));
      for (const f of fragments)
        if (/tiles\/h/.test(f)) expect(f, f).not.toMatch(/\b(D-TWR|C-BM\d|D-BELT|BUF-SILO|BUF-SLIP)\b|powder|slip|silo|spray/i);
    });
});
