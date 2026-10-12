/**
 * "Show in 3D" from a Production stage opens the Factory Twin on the stage itself: an equipment or
 * vehicle selected earlier is released first (the twin shows the most specific item), so the address
 * is #/twin and the twin shows the stage panel — not an old, unrelated asset.
 */
import { describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => {
  // The sim store starts its clock when a window exists: keep it idle.
  vi.useFakeTimers();
  const entries: { hash: string; state: unknown }[] = [{ hash: '#/production/KILN', state: null }];
  let index = 0;
  const g = globalThis as Record<string, unknown>;
  g.window = { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  g.location = {
    get hash() {
      return entries[index].hash;
    },
  };
  g.history = {
    get state() {
      return entries[index].state;
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _t: string, url?: string) {
      entries.splice(index + 1);
      entries.push({ hash: url ?? entries[index].hash, state });
      index++;
    },
    replaceState(state: unknown, _t: string, url?: string) {
      entries[index] = { hash: url ?? entries[index].hash, state };
    },
  };
  // Frames run at once: the camera flight after the twin became visible.
  g.requestAnimationFrame = (fn: (t: number) => void) => {
    fn(0);
    return 0;
  };
  return {
    get hash() {
      return entries[index].hash;
    },
  };
});

import { useApp } from '../../../app/store';
import { useSim } from '../../../sim/store';
import { useTwin } from '../../../store';
import { showStageIn3D } from './StageView';

useSim.getState().pause();

describe('Show in 3D from a stage', () => {
  it('releases an earlier equipment selection: #/twin with the stage, not the old asset', () => {
    useApp.setState({ workspace: 'production', productionStage: 'KILN' });
    useTwin.getState().select('A-HOLD');
    expect(useTwin.getState().selected).toBe('A-HOLD');
    showStageIn3D('KILN');
    expect(useApp.getState().workspace).toBe('twin');
    expect(browser.hash).toBe('#/twin');
    expect(useTwin.getState()).toMatchObject({ selected: null, vehicle: null, stage: 'KILN' });
  });

  it('releases a followed vehicle too', () => {
    useApp.setState({ workspace: 'production', productionStage: 'PRESS' });
    useApp.getState().go('production');
    const v = Object.keys(useSim.getState().sim.logistics.vehicles)[0];
    useTwin.getState().selectVehicle(v, true);
    showStageIn3D('PRESS');
    expect(browser.hash).toBe('#/twin');
    expect(useTwin.getState()).toMatchObject({ selected: null, vehicle: null, follow: false, stage: 'PRESS' });
  });
});
