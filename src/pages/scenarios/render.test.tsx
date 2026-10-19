/**
 * Smoke test: the Scenarios panel renders (server-side) every tab at start-up and while the guided
 * demos run, with its landmarks and honesty labels, and links only into the seven workspaces.
 */
import type { ReactElement } from 'react';
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
import { ScenarioDrawer } from '../../app/ScenarioDrawer';
import { advance } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { setupDemo, useDemoRuns, useScenarioParams } from './actions';
import { demoKey } from './demos';
import { SCENARIO_TABS, useScenarioDrawer, type ScenarioTab } from './drawerState';

useSim.getState().pause();

const sync = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useDemoRuns.getInitialState(), useDemoRuns.getState());
  Object.assign(useScenarioParams.getInitialState(), useScenarioParams.getState());
  Object.assign(useScenarioDrawer.getInitialState(), useScenarioDrawer.getState());
};
const render = (el: ReactElement) => {
  sync();
  return renderToStaticMarkup(el);
};
const renderTab = (tab: ScenarioTab) => {
  useScenarioDrawer.setState({ tab });
  useApp.setState({ scenariosOpen: true });
  return render(<ScenarioDrawer />);
};

/** Names of retired pages, which the panel must not link to or mention. */
const RETIRED = /Command Center|Machine Health|Energy Intelligence|Scenario Simulator|Vehicle Monitoring|AI Defect Monitoring|Production Monitoring|OEE &amp; Loss\b|Assets &amp; Data/;

describe('Scenarios panel', () => {
  it('is closed until opened', () => {
    useApp.setState({ scenariosOpen: false });
    expect(render(<ScenarioDrawer />)).toBe('');
  });

  it('renders every tab at start-up', () => {
    const html = Object.fromEntries(SCENARIO_TABS.map((t) => [t, renderTab(t)])) as Record<ScenarioTab, string>;
    for (const t of SCENARIO_TABS) {
      expect(html[t], t).toContain('role="dialog"');
      for (const label of ['Guided demos', 'Catalogue', 'Active &amp; log', 'Impact vs baseline', 'Presenter guide']) expect(html[t], `${t}: ${label}`).toContain(label);
      expect(html[t], t).toContain('simulated inputs');
      expect(html[t], t).not.toMatch(RETIRED);
      expect(html[t], t).not.toMatch(/>Live</);
      expect(html[t], t).not.toMatch(/Energy cost|kWh/);
    }
    for (const text of ['Conveyor stoppage', 'OEE loss', 'Defect deterioration', 'Truck delay', 'Powder shortage', 'Downstream constraint', 'Process deviation → batch → rejects', 'Data quality', 'Reset demo…', 'Not set up'])
      expect(html.demos, text).toContain(text);
    for (const text of ['Production bottleneck', 'Machine breakdown', 'Developing machine fault', 'Data feed loss (PLC link)', 'Quality deterioration', 'Yard congestion', 'Restricted-zone entry', 'Show me'])
      expect(html.catalogue, text).toContain(text);
    for (const text of ['Kiln zone 3 temperature high', 'Press 2 pressing pressure low', 'Frozen counter · E-PRS2', 'Command without running feedback · E-PRS1', 'Simulated scenario', 'Detected by', 'QL-PROCESS-ASSOCIATION', 'Events &amp; Reports › Data &amp; connectivity', 'Quality &amp; Defects › Compare'])
      expect(html.catalogue, text).toContain(text);
    expect(html.catalogue).not.toMatch(/(powder|slip|silo)[^.<]{0,60}tiles\/h|\bAI\b|Ghani/i);
    for (const text of ['No scenario in effect', 'Skip 15 min', 'Scenario log', 'No scenario yet']) expect(html.active, text).toContain(text);
    for (const text of ['Good output Δ', 'Line OEE Δ', 'Unplanned downtime Δ', 'Reject rate Δ', 'Since scenario start']) expect(html.impact, text).toContain(text);
    for (const text of ['Open Overview', 'Set up · Production', 'Set up · Quality &amp; Defects', 'Set up · Fleet &amp; Movement', 'Open Events &amp; Reports', 'Go to Reset (E)', 'Simulation speed'])
      expect(html.guide, text).toContain(text);
  });

  it('renders while every guided demo runs: events, Clear, the log with outcomes', () => {
    const v = useScenarioParams.getState().values;
    for (const id of ['A', 'B', 'C', 'D', 'F', 'G', 'H'] as const) expect(setupDemo(id, v[demoKey(id)])).not.toBeNull();
    const s = useSim.getState().sim;
    advance(s, s.minute + 30);
    useSim.setState({ version: s.version });
    const demos = renderTab('demos');
    expect(demos).toContain('Event report');
    expect(demos).toMatch(/EV-\d{5}/);
    expect(demos).toContain('Running');
    // Finding-based demos: the watched rules with their status in words (F, G, H detect within 30 min).
    expect(demos).toContain('F-DOWNSTREAM-CONSTRAINT');
    expect(demos).toContain('Detected');
    expect(demos).toContain('Not evaluated');
    expect(demos).toMatch(/Association to investigate/);
    expect(demos).not.toMatch(/(powder|slip|silo)[^.<]{0,60}tiles\/h|\bAI\b|Ghani/i);
    const active = renderTab('active');
    expect(active).toMatch(/\d scenarios? in effect/);
    expect(active).toContain('Clear all');
    expect(active).toContain('Outcome:');
    expect(active).toContain('Guided demo');
    expect(active).toMatch(/Stopped \d+ min/);
    const catalogue = renderTab('catalogue');
    expect(catalogue).toContain('Clear all');
    const guide = renderTab('guide');
    expect(guide).toContain('CV-PACK');
    expect(guide).toMatch(/Step \d, done/);
    for (const html of [demos, active, catalogue, guide]) expect(html).not.toMatch(RETIRED);
  });
});
