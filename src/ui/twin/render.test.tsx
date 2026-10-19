/**
 * Smoke test: the twin overlays render (server-side, no WebGL) for every kind of context — the
 * whole factory, a monitored machine, the kiln, a conveyor, a stale feed, a highlighted stage,
 * other equipment, zones and vehicles — with the expected landmarks and honesty labels.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The stores register browser listeners at import; a minimal window is enough for server rendering.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useTwin } from '../../store';
import { useSim } from '../../sim/store';
import { activateScenario, advance } from '../../sim/engine';
import { formatClock } from '../../sim/time';
import { NOT_MODELLED } from '../equipment/kpis';
import { TwinOverlays } from './TwinOverlays';
import { TwinSearch } from './Search';
import { useTwinUi } from './uiStore';

// Keep the demo clock still while rendering.
useSim.getState().pause();

/**
 * Server rendering reads zustand's initial state (useSyncExternalStore server snapshot),
 * so the test mirrors each store's current state into it before rendering.
 */
const render = () => {
  Object.assign(useTwin.getInitialState(), useTwin.getState());
  Object.assign(useTwinUi.getInitialState(), useTwinUi.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  return renderToStaticMarkup(<TwinOverlays />);
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('twin overlays render', () => {
  it('renders the default layout with the Overview status chips and no energy or retired links', () => {
    useTwin.getState().reset();
    const html = render();
    for (const text of ['Good output', 'Line OEE', 'First-pass quality', 'Issues requiring attention', 'Warehouse', '+15 min', 'Events', 'Machines', 'Vehicles', 'Site plan', 'Alert markers'])
      expect(html).toContain(text);
    expect(html).not.toMatch(/energy/i);
    expect(html).not.toMatch(/Machine Health|Assets &amp; Data|Production Monitoring/);
    // Whole-factory crumbs only appear once something is in context.
    expect(html).not.toContain('Whole factory');
    expect(renderToStaticMarkup(<TwinSearch />)).toContain('Search the factory twin');
  });

  it('renders the equipment panel of a condition-monitored machine', () => {
    const sim = useSim.getState().sim;
    activateScenario(sim, { kind: 'degradation', equipmentId: 'E-PRS2', end: null, label: 'fault' });
    advance(sim, sim.minute + 30);
    useTwin.getState().select('E-PRS2');
    const html = render();
    for (const text of [
      'Hydraulic press 2',
      'Pressing &amp; forming',
      'Simulated',
      'Key figures',
      'Press output rate',
      'Cycle time',
      'Good tiles pressed',
      'Press-origin rejects',
      'What matters',
      'PLC signals',
      'Events',
      'Open in Production',
      'Technical details',
      'Whole factory',
      'Focus',
      'Ask Copilot',
    ])
      expect(html, text).toContain(text);
    // Condition: a facet and the component's signals — no 0–100 score on the main view.
    expect(html).toContain('not a probability of failure');
    expect(html).toContain('Vibration · hydraulic power unit');
    expect(html).toContain('mm/s RMS');
    expect(html).not.toMatch(/\/100|Current condition/);
    expect(html).not.toMatch(/>Live</);
  });

  it('labels parameters the model does not have as not modelled (kiln)', () => {
    useTwin.getState().select('H-KILN');
    const html = render();
    expect(html).toContain('Firing temperature profile (single value)');
    expect(html).toContain('Not modelled');
    expect(html).toContain('five simulated zone temperatures');
    expect(html).toContain('Firing rate');
    expect(html).toContain('Zones within band');
    // The kiln's KPI reason is the same parameter: listed once, not as a tile.
    expect(html).not.toContain(esc(NOT_MODELLED.kilnProfile));
  });

  it('renders a conveyor with its metrics and the camera view', () => {
    const sim = useSim.getState().sim;
    activateScenario(sim, { kind: 'conveyor-stop', equipmentId: 'CV-SORT', end: null, label: 'stop' });
    advance(sim, sim.minute + 5);
    useTwin.getState().select('CV-SORT');
    useTwinUi.getState().setCamera('CAM-I1');
    const html = render();
    for (const text of ['Sorting line roller conveyor', 'Availability', 'Utilisation', 'Stops', 'Tiles moved', 'Camera', 'Sorting line', 'Conveyor stoppage', 'Simulated'])
      expect(html, text).toContain(text);
    expect(html).toContain('Quality &amp; Defects');
    useTwinUi.getState().setCamera(null);
  });

  it('shows a stale data feed instead of a state', () => {
    const sim = useSim.getState().sim;
    activateScenario(sim, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'feed' });
    advance(sim, sim.minute + 10);
    useTwin.getState().select('H-KILN');
    let html = render();
    expect(html).toContain('Stale');
    expect(html).toContain('Unknown');
    // One mark for a stale feed (the KPI cards' wording): the figures are not confirmed, the rate is the last value.
    const since = formatClock(sim.feeds['H-KILN'].since);
    expect(html).toContain(`Not confirmed · kiln data stale since ${since}`);
    expect(html).toContain(`Last value · ${since}`);
    // The kiln's stage panel carries the same mark.
    useTwin.getState().select(null);
    useTwin.getState().selectStage('KILN', { frame: false });
    html = render();
    expect(html).toContain(`Not confirmed · kiln data stale since ${since}`);
    expect(html).toContain('Not confirmed');
    useTwin.getState().selectStage(null);
  });

  it('renders the highlighted stage panel and clears it with the selection', () => {
    useTwin.getState().select(null);
    useTwin.getState().selectStage('KILN', { frame: false });
    let html = render();
    for (const text of ['Kiln firing &amp; cooling', 'Production stage 7', 'Open in Production', 'Frame stage', 'Clear the stage highlight', 'Stage · Kiln firing &amp; cooling']) expect(html, text).toContain(text);
    // The header's close clears the highlight: no second "Clear highlight" action in the bar.
    expect(html).not.toContain('>Clear highlight<');
    // Equipment is more specific than the stage: selecting it opens its workspace, the stage stays highlighted.
    useTwin.getState().select('CV-KIN');
    html = render();
    expect(html).toContain('Kiln infeed roller transfer');
    expect(html).toContain('Stage · Kiln firing &amp; cooling');
    useTwin.getState().reset();
    expect(useTwin.getState().stage).toBeNull();
  });

  it('renders other equipment, zones and vehicles', () => {
    for (const id of ['K-DOCK', 'I-VIS', 'I-QC', 'D-SILO', 'A-PARK', 'E-COL', 'D-BELT', 'B-RCV', 'A-GATE', 'A-HOLD', 'K-RACK', 'K-FLT', 'C-BM1', 'D-TWR', 'G-INK', 'J-PAL', 'A-COMP']) {
      useTwin.getState().select(id);
      expect(() => render(), id).not.toThrow();
    }
    useTwin.getState().select('A-PARK');
    expect(render()).toContain('No operating data is simulated for this asset');
    useTwin.getState().select(null);
    useTwin.getState().selectZone('H');
    expect(render()).toContain('Kiln firing');
    const lg = useSim.getState().sim.logistics;
    const truck = lg.active.find((id) => lg.vehicles[id].class === 'external');
    const forklift = lg.active.find((id) => lg.vehicles[id].class === 'internal')!;
    if (truck) {
      useTwin.getState().selectVehicle(truck, true);
      const html = render();
      expect(html).toContain('Visit');
      expect(html).toContain('On site');
      expect(html).toContain('Open in Fleet &amp; Movement');
    }
    useTwin.getState().selectVehicle(forklift, true);
    const html = render();
    expect(html).toContain(lg.vehicles[forklift].label);
    expect(html).toContain('Location');
    expect(html).toContain('zone level');
    expect(html).toContain('Follow');
    expect(html).not.toMatch(/dwell/i);
    useTwin.getState().reset();
  });
});
