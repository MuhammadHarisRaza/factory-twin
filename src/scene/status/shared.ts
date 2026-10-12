import { useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box3, MathUtils, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useSim } from '../../sim/store';
import { equipmentBounds } from '../../store';
import { machineFlow } from './model';
import { setPinOpacity } from './pins';

/**
 * Animation speed of a machine's moving parts from the shared simulation (finding #37), read in a
 * render loop: its output relative to the ideal rate while it runs, 0 while it is down, on a planned
 * stop, starved or blocked, and 0 for every machine while the simulation is paused (`paused`).
 * Advance a local phase by `dt × rate` instead of using the clock, so a stopped machine stands still.
 */
export function machineAnimationRate(id: string): { rate: number; paused: boolean } {
  const { sim, running } = useSim.getState();
  if (!running) return { rate: 0, paused: true };
  const f = machineFlow(sim, id);
  return { rate: f.moving ? f.rate : 0, paused: false };
}

/**
 * Number of the given equipment ids whose bounds <Selectable> has registered. Re-renders the
 * caller only when that number changes (once or twice after load), never per frame.
 */
export function useBoundsCount(ids: readonly string[]) {
  const count = () => ids.reduce((a, id) => a + (equipmentBounds.has(id) ? 1 : 0), 0);
  const [n, setN] = useState(count);
  useFrame(() => {
    if (n >= ids.length) return;
    const c = count();
    if (c !== n) setN(c);
  });
  return n;
}

/** Top-centre of an asset's bounds (where its pins and beacon sit). */
export function topCenter(id: string, lift = 0): Vector3 | null {
  const b = equipmentBounds.get(id);
  if (!b) return null;
  const c = b.getCenter(new Vector3());
  return new Vector3(c.x, b.max.y + lift, c.z);
}

/** Union of several assets' bounds (null when none is registered yet). */
export function unionBounds(ids: readonly string[]): Box3 | null {
  let out: Box3 | null = null;
  for (const id of ids) {
    const b = equipmentBounds.get(id);
    if (!b) continue;
    out = out ? out.union(b) : b.clone();
  }
  return out;
}

/**
 * Relevance of a world-space label for the current camera (same rule as the zone tags):
 * everything shows in overview shots; in close shots only labels near the point of interest.
 */
export function relevance(camera: Vector3, target: Vector3, x: number, z: number) {
  if (camera.y > 70) return 1;
  const reach = MathUtils.lerp(28, 120, MathUtils.clamp((camera.y - 8) / 62, 0, 1));
  const d = Math.hypot(x - target.x, z - target.z);
  return MathUtils.clamp(1 - (d - reach) / 18, 0, 1);
}

/**
 * Fades pin elements by relevance to the current camera in the render loop (no React state).
 * `items` pairs each element ref with its world x/z; `keep(i)` pins one at full opacity
 * (e.g. the selected asset); `extra(i, camera)` can further scale the opacity.
 */
export function useRelevanceFade(
  items: { el: RefObject<HTMLElement | null>; x: number; z: number }[],
  keep?: (i: number) => boolean,
  extra?: (i: number, camera: Vector3) => number,
) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const list = useRef(items);
  list.current = items;
  useFrame(({ camera }) => {
    if (!controls) return;
    list.current.forEach((it, i) => {
      const base = keep?.(i) ? 1 : relevance(camera.position, controls.target, it.x, it.z);
      setPinOpacity(it.el.current, base * (extra ? extra(i, camera.position) : 1));
    });
  });
}
