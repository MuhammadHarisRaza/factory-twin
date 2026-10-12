/**
 * Smoke test: the Overview renders (server-side) in a normal state, with open issues, and with an
 * equipment, stage or vehicle selected in the embedded model — with its landmarks, the five KPIs,
 * the flow strip, the issues list and its honesty labels.
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

import { useApp } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { attentionEvents } from '../../intel/kpis';
import { FACTORY, LINE } from '../../model/plant';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { resolvePeriod } from '../../sim/metrics';
import { flowStages } from '../../ui/flow/derive';
import { OverviewPage } from '../OverviewPage';

useSim.getState().pause();
const START = 2 * 1440 + 4 * 60 + 20;

/** SSR reads each store's initial state (server snapshot): copy the current state into it. */
const render = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useTwin.getInitialState(), useTwin.getState());
  return renderToStaticMarkup(<OverviewPage />);
};
const setSim = (sim: ReturnType<typeof createSim>) => useSim.setState({ sim, version: sim.version + 1 });
const noSelection = { selected: null, vehicle: null, stage: null, zone: null };

describe('Overview render', () => {
  it('renders the command view in a normal state', () => {
    setSim(createSim(81, START));
    useTwin.setState({ ...noSelection, ready: true });
    useApp.setState({ workspace: 'overview' });
    const html = render();
    for (const text of [
      'Overview',
      'Simulated',
      FACTORY.name,
      LINE.name,
      'Shift A · 06:00–14:00',
      'Plant time',
      // Summary
      'Production is',
      'modeled design constraint',
      'no open issues require attention',
      // KPIs
      'Good output',
      'Target attainment',
      'Line OEE',
      'First-pass quality',
      'Issues requiring attention',
      // Model controls
      'All zones',
      'Whole factory',
      'Serious &amp; critical',
      'Drag to orbit',
      // Flow strip
      'Production flow',
      'Preparation',
      'Spray drying',
      'Pressing',
      'Drying',
      'Glazing',
      'Kiln',
      'Sorting',
      'Packing',
      'Warehouse',
      'Design constraint',
      'vs plan',
      // Empty issues
      'No issues require attention',
      'All events',
    ])
      expect(html, text).toContain(text);
    expect(html).not.toMatch(/>Live</);
    expect(html).not.toMatch(/real-time|AI model detected/i);
    // Nothing selected: no focus control, no selection card.
    expect(html).not.toContain('>Focus<');
    expect(html).not.toContain('Open details');
    // Exactly the five KPI cards.
    expect(html.match(/class="kc /g)?.length).toBe(5);
  });

  it('lists the priority issues with impact, next step and actions while the kiln is stopped', () => {
    const s = createSim(82, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, START + 25);
    setSim(s);
    useTwin.setState({ ...noSelection, ready: true });
    const html = render();
    const list = attentionEvents(s);
    expect(list.length).toBeGreaterThan(0);
    for (const text of ['currently constraining output', 'Investigate', 'Show in model', 'Where', 'When', 'Impact', 'Next step', 'Scenario', 'Estimate', 'condition active', list[0].title, list[0].id])
      expect(html, text).toContain(text);
    // At most three items by default.
    expect(html.match(/class="ov-is sev-/g)?.length).toBe(Math.min(3, list.length));
    if (list.length > 3) expect(html).toContain(`Show ${Math.min(5, list.length) - 3} more`);
    expect(html).toContain('>Constraint<');
  });

  it('shows one selection card for the selected equipment, stage or vehicle', () => {
    setSim(createSim(81, START));
    useTwin.setState({ ...noSelection, selected: 'H-KILN', zone: 'H', ready: true });
    let html = render();
    expect(html).toContain(EQUIPMENT_BY_ID['H-KILN'].name);
    expect(html).toContain('Open details');
    expect(html).toContain('>Clear<');
    expect(html).toContain('Focus');
    expect(html.match(/class="ov-sel"/g)?.length).toBe(1);

    useTwin.setState({ ...noSelection, stage: 'KILN', ready: true });
    html = render();
    expect(html).toContain('Open in Production');
    expect(html).toMatch(/aria-pressed="true"[^>]*title="Kiln firing &amp; cooling/);

    const s = useSim.getState().sim;
    const v = s.logistics.active[0];
    useTwin.setState({ ...noSelection, vehicle: v, ready: true });
    html = render();
    expect(html).toContain(s.logistics.vehicles[v].label);
    expect(html).toContain('Open details');
  });

  it('puts the issues beside the model and the flow strip under both (model → issues → flow in one grid)', async () => {
    setSim(createSim(81, START));
    useTwin.setState({ ...noSelection, ready: true });
    const html = render();
    const work = html.slice(html.indexOf('class="ov-work"'));
    const at = (cls: string) => work.search(new RegExp(`class="[^"]*\\b${cls}\\b`));
    expect(at('ov-twin-box')).toBeGreaterThan(0);
    expect(at('ov-issues')).toBeGreaterThan(at('ov-twin-box'));
    expect(at('ov-flow')).toBeGreaterThan(at('ov-issues'));
    expect(html).not.toContain('ov-main');
    // Side by side from 1280 px (issues column, flow across both), stacked only below; a lower model on short screens.
    // Vitest does not load CSS (a ?raw import of a stylesheet is empty): read the stylesheet itself.
    const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as { readFileSync: (p: URL, enc: 'utf8') => string };
    const css = fs.readFileSync(new URL('./overview.css', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.ov-work \{ --ov-model-h: [^}]*grid-template-columns: minmax\(0, 1fr\) 340px; grid-template-areas: 'twin issues' 'flow flow';/);
    expect(css).toMatch(/@media \(max-width: 1279px\) \{ \.ov-work \{ grid-template-columns: minmax\(0, 1fr\); grid-template-areas: 'twin' 'issues' 'flow';/);
    expect(css).toMatch(/@media \(max-height: 820px\) \{ \.ov-work \{ --ov-model-h: clamp\(380px, 54vh, 660px\);/);
    expect(css).not.toMatch(/min-width: 1664px/);
    // The model hint names the embedded zoom gesture.
    expect(html).toContain('Drag to orbit · Ctrl/⌘ + scroll to zoom · click equipment');
  });

  it('marks a stale kiln feed in the flow strip and the stage card: the same running figure, the same mark (Decision 1)', () => {
    const s = createSim(86, START);
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'Kiln feed loss' });
    advance(s, START + 30);
    setSim(s);
    useTwin.setState({ ...noSelection, stage: 'KILN', ready: true });
    const html = render();
    const kiln = flowStages(s, resolvePeriod('shift', s.minute)).find((x) => x.id === 'KILN')!;
    const value = Math.round(kiln.output!).toLocaleString('en-GB');
    const mark = kiln.stale!.label;
    expect(mark).toMatch(/^Not confirmed · kiln data stale since \d\d:\d\d$/);
    expect(html).not.toMatch(/last value \d\d:\d\d/);
    // Flow strip cell: the running figure, the Stale badge and the mark.
    expect(html).toMatch(new RegExp(`class="flow-out num">${value}<small>m²</small></span><span class="flow-stale"[^>]*><span class="prov prov-stale[^"]*"[^>]*>(?:(?!</span>).)*</span><span class="flow-stale-t">${mark}</span>`));
    // Stage card: the same figure and the same mark beside its Stale badge.
    expect(html).toContain(`<dd>${value} m² · not confirmed</dd>`);
    expect(html).toMatch(new RegExp(`class="ov-sel-s">(?:(?!</div>).)*prov-stale(?:(?!</div>).)*<span class="ov-sel-stale"[^>]*>${mark}</span>`));
    expect(html).toContain('Unknown — data stale');
    // The Line OEE card says the figure is not confirmed with the same words (shared KPI with stale provenance).
    expect(html).toContain(mark);
  });

  it('sorting feed loss: summary says output vs plan is not confirmed; strip, card and KPI show one marked figure', () => {
    const s = createSim(87, START);
    activateScenario(s, { kind: 'signal-loss', equipmentId: 'I-SORT', end: null, label: 'Sorter feed loss' });
    advance(s, START + 30);
    setSim(s);
    useTwin.setState({ ...noSelection, stage: 'SORT', ready: true });
    const html = render();
    const sort = flowStages(s, resolvePeriod('shift', s.minute)).find((x) => x.id === 'SORT')!;
    const value = Math.round(sort.output!).toLocaleString('en-GB');
    expect(html).toMatch(/Output vs plan not confirmed — sorting data stale since \d\d:\d\d \(simulated running total [\d,]+ m² of [\d,]+ m² planned to date\)/);
    expect(html).not.toMatch(/Production is (ahead of|on track|behind)/);
    expect(html).toContain(`<span class="flow-stale-t">${sort.stale!.label}</span>`);
    expect(html).toContain(`<dd>${value} m² · not confirmed</dd>`);
    expect(html).toContain('vs plan · not confirmed');
  });

  it('shows the loading state of the model until the scene is ready', () => {
    useTwin.setState({ ...noSelection, ready: false });
    expect(render()).toContain('Building the factory model');
  });
});
