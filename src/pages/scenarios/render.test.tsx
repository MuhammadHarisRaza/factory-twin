/**
 * Smoke test: the Scenario Simulator, the Scenarios drawer, the Command Center, Machine Health and
 * Energy Intelligence render (server-side) at start-up and while the demonstrations run, with
 * their landmarks and honesty labels.
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
import { CommandCenterPage } from '../CommandCenterPage';
import { EnergyPage } from '../EnergyPage';
import { MachineHealthPage } from '../MachineHealthPage';
import { ScenarioSimulatorPage } from '../ScenarioSimulatorPage';
import { setupDemo, useDemoRuns, useScenarioParams } from './actions';
import { demoKey } from './demos';

useSim.getState().pause();

const sync = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useDemoRuns.getInitialState(), useDemoRuns.getState());
  Object.assign(useScenarioParams.getInitialState(), useScenarioParams.getState());
};
const render = (el: ReactElement) => {
  sync();
  return renderToStaticMarkup(el);
};

describe('scenario simulator and command center render', () => {
  it('renders at start-up', () => {
    const sim = render(<ScenarioSimulatorPage />);
    for (const text of ['Demonstrations · the four use cases end to end', 'Conveyor stoppage', 'OEE loss', 'Defect deterioration', 'Truck delay', 'Reset demo…', 'Scenario catalogue', 'Presenter guide', 'Scenario log', 'Data feed loss (PLC link)', 'Restricted-zone entry'])
      expect(sim, text).toContain(text);
    expect(sim).not.toMatch(/>Live</);
    const cc = render(<CommandCenterPage />);
    for (const text of ['Production monitoring', 'OEE &amp; loss', 'AI defect monitoring', 'Vehicle monitoring', 'Active events', 'Next actions', 'Equipment requiring attention', 'Quality exceptions', 'Event timeline', 'estimate · assumptions shown'])
      expect(cc, text).toContain(text);
    expect(cc).not.toMatch(/>Live</);
  });

  it('renders while every demonstration runs', () => {
    const v = useScenarioParams.getState().values;
    for (const id of ['A', 'B', 'C', 'D'] as const) expect(setupDemo(id, v[demoKey(id)])).not.toBeNull();
    const s = useSim.getState().sim;
    advance(s, s.minute + 30);
    useSim.setState({ version: s.version });
    const sim = render(<ScenarioSimulatorPage />);
    expect(sim).toContain('Event report');
    expect(sim).toMatch(/EV-\d{5}/);
    expect(sim).toContain('Clear all');
    useApp.setState({ scenariosOpen: true });
    const drawer = render(<ScenarioDrawer />);
    expect(drawer).toContain('Running now');
    expect(drawer).toContain('Demonstrations · four use cases');
    const cc = render(<CommandCenterPage />);
    expect(cc).toContain('CV-PACK');
    expect(cc).toContain('Acknowledge');
    expect(render(<MachineHealthPage />)).toContain('Condition events');
    expect(render(<EnergyPage />)).toContain('Energy anomalies');
  });
});
