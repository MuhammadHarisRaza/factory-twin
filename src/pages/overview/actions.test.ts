import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { attentionEvents } from '../../intel/kpis';
import { useEventFocus } from '../../scene/events/focus';
import { activateScenario, advance, createSim } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { selectInModel } from '../../ui/flow/FlowStrip';
import { clearSelection, focusSelection, kpiNav, showEventInModel } from './actions';

useSim.getState().pause();
const START = 2 * 1440 + 4 * 60 + 20;

describe('overview actions', () => {
  it('"Show in model" selects and marks the event in the embedded model without leaving the page', () => {
    const s = createSim(82, START);
    activateScenario(s, { kind: 'machine-stop', equipmentId: 'H-KILN', end: null, label: 'Kiln stop' });
    advance(s, START + 10);
    useSim.setState({ sim: s, version: s.version + 1 });
    useApp.setState({ workspace: 'overview' });
    const ev = attentionEvents(s).find((e) => e.asset.equipmentId === 'H-KILN')!;
    showEventInModel(ev);
    expect(useApp.getState().workspace).toBe('overview');
    expect(useTwin.getState().selected).toBe('H-KILN');
    expect(useApp.getState().selectedEventId).toBe(ev.id);
    expect(useEventFocus.getState().focus?.eventId).toBe(ev.id);
    expect(useEventFocus.getState().focus?.target.equipmentId).toBe('H-KILN');
  });

  it('selecting a stage from the strip releases the single selection; Clear removes everything', () => {
    useTwin.getState().select('E-PRS1');
    selectInModel('KILN');
    expect(useTwin.getState().selected).toBeNull();
    expect(useTwin.getState().stage).toBe('KILN');
    expect(useTwin.getState().zone).toBe('H');
    const nonce = useTwin.getState().camera.nonce;
    focusSelection();
    expect(useTwin.getState().camera.nonce).toBeGreaterThanOrEqual(nonce);
    useTwin.getState().select('E-PRS1');
    clearSelection();
    expect(useTwin.getState()).toMatchObject({ selected: null, vehicle: null, stage: null });
  });

  it('KPI cards open their home: Production (line view) and its OEE tab, Quality', () => {
    useApp.setState({ workspace: 'overview', productionStage: 'KILN', tabs: { production: 'oee' } });
    kpiNav.production();
    expect(useApp.getState()).toMatchObject({ workspace: 'production', productionStage: null });
    expect(useApp.getState().tabs.production).toBeUndefined();
    useApp.setState({ workspace: 'overview' });
    kpiNav.oee();
    expect(useApp.getState().workspace).toBe('production');
    expect(useApp.getState().tabs.production).toBe('oee');
    useApp.setState({ workspace: 'overview' });
    kpiNav.quality();
    expect(useApp.getState().workspace).toBe('quality');
  });
});
