/**
 * Live simulation store: owns the single SimState every workspace reads, and the demo
 * clock. React components subscribe to `version` (bumped once per simulated minute) and
 * derive figures through src/sim/metrics.ts. The 3D scene reads the continuous clock
 * (`simClock.t`, fractional minutes) every frame for smooth vehicle motion.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { ScenarioActivation } from '../model/types';
import { DEFAULT_SEED, activateScenario, advance, clearScenario, createSim, type SimState } from './engine';
import { DEFAULT_START } from './time';

/** Demo speeds: simulated seconds per real second. */
export const SPEEDS = [
  { value: 1, label: '1×', hint: 'Real time' },
  { value: 10, label: '10×', hint: '10 s per second' },
  { value: 60, label: '60×', hint: '1 min per second' },
  { value: 300, label: '300×', hint: '5 min per second' },
];

/** Continuous simulation time in fractional plant minutes (read in render loops). */
export const simClock = { t: DEFAULT_START };

type SimStore = {
  sim: SimState;
  /**
   * The same seed simulated without any scenario — exactly "what would have happened".
   * Built in the background after start-up and advanced in lockstep; null until ready.
   */
  baseline: SimState | null;
  /** Incremented by Reset Demo (UI keys that must remount). */
  resets: number;
  version: number;
  running: boolean;
  speed: number;
  seed: number;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: number) => void;
  /** Rebuild the baseline from the seed (drops all scenarios). */
  reset: () => void;
  activate: (def: Omit<ScenarioActivation, 'id' | 'start'>) => ScenarioActivation;
  clear: (id: string) => void;
  clearAll: () => void;
  /** Jump forward by whole minutes (used by "skip ahead" and tests). */
  skip: (minutes: number) => void;
  /** Build the baseline now if it is not ready yet. */
  ensureBaseline: () => SimState;
};

export const useSim = create<SimStore>((set, get) => {
  const initial = createSim(DEFAULT_SEED, DEFAULT_START);
  simClock.t = initial.minute;
  return {
    sim: initial,
    baseline: null,
    resets: 0,
    version: initial.version,
    running: true,
    speed: 60,
    seed: DEFAULT_SEED,
    play: () => set({ running: true }),
    pause: () => set({ running: false }),
    setSpeed: (speed) => set({ speed }),
    reset: () => {
      const sim = createSim(get().seed, DEFAULT_START);
      simClock.t = sim.minute;
      set({ sim, baseline: null, resets: get().resets + 1, version: sim.version + 1000 * (get().resets + 1) });
      scheduleBaseline();
    },
    ensureBaseline: () => {
      const { baseline, sim, seed } = get();
      if (baseline && baseline.minute === sim.minute) return baseline;
      if (baseline) {
        advance(baseline, sim.minute);
        return baseline;
      }
      const b = createSim(seed, sim.minute);
      set({ baseline: b });
      return b;
    },
    activate: (def) => {
      const { sim } = get();
      get().ensureBaseline();
      const sc = activateScenario(sim, def);
      set({ version: sim.version });
      return sc;
    },
    clear: (id) => {
      const { sim } = get();
      clearScenario(sim, id);
      set({ version: sim.version });
    },
    clearAll: () => {
      const { sim } = get();
      for (const sc of sim.scenarios) if (sc.end == null || sc.end > sim.minute) clearScenario(sim, sc.id);
      set({ version: sim.version });
    },
    skip: (minutes) => {
      const { sim } = get();
      advance(sim, sim.minute + minutes);
      const { baseline } = get();
      if (baseline) advance(baseline, sim.minute);
      simClock.t = sim.minute;
      set({ version: sim.version });
    },
  };
});

// ── Clock ─────────────────────────────────────────────────────────────────────

let last = performance.now();
function tick() {
  const now = performance.now();
  // Cap a single step so a backgrounded tab doesn't fast-forward hours on return.
  const dt = Math.min(0.5, (now - last) / 1000);
  last = now;
  const { running, speed, sim } = useSim.getState();
  if (!running) return;
  simClock.t += (dt * speed) / 60;
  const target = Math.floor(simClock.t);
  if (target > sim.minute) {
    advance(sim, target);
    const { baseline } = useSim.getState();
    if (baseline) advance(baseline, target);
    useSim.setState({ version: sim.version });
  }
}

/** Builds the baseline shortly after start-up (≈1 s of work) without blocking the first paint. */
function scheduleBaseline() {
  if (typeof window === 'undefined') return;
  setTimeout(() => {
    if (!useSim.getState().baseline) useSim.getState().ensureBaseline();
  }, 2500);
}
scheduleBaseline();
if (typeof window !== 'undefined') {
  setInterval(tick, 50);
  // Dev-only handle for console debugging and automated checks.
  if (import.meta.env.DEV) Object.assign(window, { sim: useSim, simClock });
}

/** Re-render on every simulated minute and memoise `fn` on it. */
export function useSimValue<T>(fn: (s: SimState) => T, deps: unknown[] = []): T {
  const version = useSim((s) => s.version);
  const sim = useSim((s) => s.sim);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => fn(sim), [sim, version, ...deps]);
}

/** Current plant minute (integer). */
export const useSimMinute = () => useSimValue((s) => s.minute);
