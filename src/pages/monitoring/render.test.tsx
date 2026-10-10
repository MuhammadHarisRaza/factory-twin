/**
 * Smoke test: Production Monitoring renders (server-side) for the overview and every stage detail,
 * also while scenarios are active, and shows its landmarks and honesty labels.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { MONITORED_STAGES } from '../../model/plant';
import type { MonitoredStageId } from '../../model/types';
import { activateScenario, advance } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { MonitoringPage } from '../MonitoringPage';
import { quickDef } from './derive';

useSim.getState().pause();

const render = (stage: MonitoredStageId | null) => {
  useApp.setState({ workspace: 'monitoring', monitoringStage: stage });
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  return renderToStaticMarkup(<MonitoringPage />);
};

describe('production monitoring render', () => {
  it('renders the overview with every stage and the notice', () => {
    const html = render(null);
    expect(html).toContain('Simulated production data · counting points configurable per plant');
    for (const ms of MONITORED_STAGES) expect(html).toContain(ms.name.replace(/&/g, '&amp;'));
    for (const text of ['Stages in flow order', 'Current bottleneck', 'Not measured', 'Active events']) expect(html).toContain(text);
    expect(html).not.toMatch(/>Live</);
  });

  it('renders every stage detail', () => {
    for (const ms of MONITORED_STAGES) {
      const html = render(ms.id);
      for (const text of ['All stages', 'Focus in 3D', 'Stage overview', 'Equipment', 'Production trend', 'Camera views', 'Active events', 'Event history', 'Shift summary', 'Download shift report (PDF)', 'Production losses', 'Simulate'])
        expect(html, `${ms.id}: ${text}`).toContain(text);
      expect(html).not.toMatch(/>Live</);
    }
  });

  it('renders while a feed is lost and a conveyor is stopped', () => {
    const s = useSim.getState().sim;
    activateScenario(s, quickDef('signal-loss', 'E-PRS2', 30, s.minute));
    activateScenario(s, quickDef('conveyor-stop', 'CV-KIN', 0, s.minute));
    advance(s, s.minute + 15);
    useSim.setState({ version: s.version });
    expect(render(null)).toContain('Feed stale · E-PRS2');
    const press = render('PRESS');
    expect(press).toMatch(/Stale since \d\d:\d\d/);
    expect(press).toContain('Unknown — data stale');
    const kiln = render('KILN');
    expect(kiln).toContain('CV-KIN');
    expect(kiln).toContain('Conveyor stoppage');
  });
});
