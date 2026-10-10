/**
 * Smoke test: the twin overlays render (server-side, no WebGL) for every selection
 * kind and inspector tab without throwing, and show the expected landmarks.
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
import { TwinOverlays } from './TwinOverlays';
import { TwinSearch } from './Search';
import { useTwinUi, type InspectorTab } from './uiStore';

// Keep the demo clock still while rendering.
useSim.getState().pause();

/**
 * Server rendering reads zustand's initial state (useSyncExternalStore server snapshot),
 * so the test mirrors each store's current state into it before rendering.
 */
const render = () => {
  Object.assign(useTwin.getInitialState(), useTwin.getState());
  Object.assign(useTwinUi.getInitialState(), useTwinUi.getState());
  return renderToStaticMarkup(<TwinOverlays />);
};

describe('twin overlays render', () => {
  it('renders the default layout', () => {
    useTwin.setState({ selected: null, vehicle: null, zone: null });
    const html = render();
    for (const text of ['OEE', 'Output vs target', 'Downtime', 'Defect rate', 'Energy', 'Trucks on site', 'Warehouse', '+15 min', 'Events', 'Machines', 'Vehicles', 'Site plan'])
      expect(html).toContain(text);
    expect(renderToStaticMarkup(<TwinSearch />)).toContain('Search the factory twin');
  });

  it('renders every inspector tab for a monitored machine', () => {
    const sim = useSim.getState().sim;
    activateScenario(sim, { kind: 'degradation', equipmentId: 'E-PRS2', end: null, label: 'fault' });
    advance(sim, sim.minute + 30);
    useTwin.getState().select('E-PRS2');
    for (const tab of ['overview', 'health', 'events', 'recs'] as InspectorTab[]) {
      useTwinUi.getState().setTab('E-PRS2', tab);
      const html = render();
      expect(html).toContain('Hydraulic press 2');
      if (tab === 'health') expect(html).toContain('no trained model or physical sensors');
      if (tab === 'recs') expect(html).toContain('AI recommendations · rule-based');
    }
  });

  it('renders a conveyor inspector with its metrics and the camera view', () => {
    const sim = useSim.getState().sim;
    activateScenario(sim, { kind: 'conveyor-stop', equipmentId: 'CV-SORT', end: null, label: 'stop' });
    advance(sim, sim.minute + 5);
    useTwin.getState().select('CV-SORT');
    useTwinUi.getState().setTab('CV-SORT', 'overview');
    useTwinUi.getState().setCamera('CAM-I1');
    const html = render();
    for (const text of ['Sorting line roller conveyor', 'Availability', 'Utilisation', 'Stops', 'Stopped', 'Camera', 'Sorting line', 'Simulated']) expect(html).toContain(text);
    useTwinUi.getState().setTab('CV-SORT', 'events');
    expect(render()).toContain('Conveyor stoppage');
    useTwinUi.getState().setCamera(null);
  });

  it('shows a stale data feed instead of a state', () => {
    const sim = useSim.getState().sim;
    activateScenario(sim, { kind: 'signal-loss', equipmentId: 'H-KILN', end: null, label: 'feed' });
    advance(sim, sim.minute + 10);
    useTwin.getState().select('H-KILN');
    useTwinUi.getState().setTab('H-KILN', 'overview');
    const html = render();
    expect(html).toContain('Stale since');
    expect(html).toContain('Unknown');
  });

  it('renders other equipment, zones and vehicles', () => {
    for (const id of ['K-DOCK', 'I-VIS', 'D-SILO', 'A-PARK', 'E-COL', 'D-BELT']) {
      useTwin.getState().select(id);
      for (const tab of ['overview', 'events', 'recs'] as InspectorTab[]) {
        useTwinUi.getState().setTab(id, tab);
        expect(() => render()).not.toThrow();
      }
    }
    useTwin.getState().select(null);
    useTwin.getState().selectZone('H');
    expect(render()).toContain('Kiln firing');
    const lg = useSim.getState().sim.logistics;
    const truck = lg.active.find((id) => lg.vehicles[id].class === 'external');
    const forklift = lg.active.find((id) => lg.vehicles[id].class === 'internal')!;
    if (truck) {
      useTwin.getState().selectVehicle(truck, true);
      expect(render()).toContain('Gate in');
    }
    useTwin.getState().selectVehicle(forklift, true);
    expect(render()).toContain(lg.vehicles[forklift].label);
    useTwin.getState().reset();
  });
});
