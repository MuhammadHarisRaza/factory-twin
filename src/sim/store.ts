/**
 * Live simulation store: owns the single SimState every workspace reads, and the demo
 * clock. React components subscribe to `version` (bumped once per simulated minute) and
 * derive figures through src/sim/metrics.ts. The 3D scene reads the continuous clock
 * (`simClock.t`, fractional minutes) every frame for smooth vehicle motion.
 *
 * Event lifecycle actions (acknowledge, assign, investigate, note, resolve) and evidence
 * attachments go through this store so every view re-renders from the same record.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { EventRules, Evidence, ScenarioActivation } from '../model/types';
import { DEFAULT_EVENT_RULES } from '../model/plant';
import { DEFAULT_SEED, activateScenario, advance, clearScenario, createSim, type SimState } from './engine';
import {
  acknowledgeEvent,
  addEventNote,
  assignEvent,
  attachEvidenceImage,
  investigateEvent,
  markEvidenceUnavailable,
  recordReport,
  resolveEvent,
  type LifecycleResult,
} from './events';
import { DEFAULT_START } from './time';
import { clearImages } from '../twin/bridge';

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
   * Built in background slices after start-up and advanced in lockstep; null until ready.
   */
  baseline: SimState | null;
  /** Incremented by Reset Demo (UI keys that must remount). */
  resets: number;
  /** True while Reset Demo rebuilds the seeded baseline in the background. */
  resetting: boolean;
  version: number;
  running: boolean;
  speed: number;
  seed: number;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: number) => void;
  /** Rebuild the seeded baseline (drops all scenarios, events and user actions) without freezing the UI. */
  reset: () => void;
  /** Synchronous reset (tests, scripts). */
  resetNow: () => void;
  activate: (def: Omit<ScenarioActivation, 'id' | 'start'>) => ScenarioActivation;
  clear: (id: string) => void;
  clearAll: () => void;
  /** Jump forward by whole minutes (used by "skip ahead" and tests). */
  skip: (minutes: number) => void;
  /** The baseline now (finishes a background build synchronously if needed). */
  ensureBaseline: () => SimState;
  // ── Event lifecycle (one record, every view) ──
  acknowledge: (eventId: string) => LifecycleResult;
  assign: (eventId: string, owner: string) => LifecycleResult;
  investigate: (eventId: string) => LifecycleResult;
  note: (eventId: string, text: string) => LifecycleResult;
  resolve: (eventId: string, reason: string, action?: string) => LifecycleResult;
  reportExported: (eventId: string) => void;
  attachImage: (evidenceId: string, image: NonNullable<Evidence['image']>, provenance?: Evidence['provenance']) => void;
  evidenceUnavailable: (evidenceId: string, reason: string) => void;
  /** Change a detection threshold; applies from the next simulated minute. */
  setRule: <K extends keyof EventRules>(key: K, value: EventRules[K]) => void;
  resetRules: () => void;
};

// ── Background builds ─────────────────────────────────────────────────────────

const SLICE_MIN = 720;
type Job = { sim: SimState; target: () => number; done: (s: SimState) => void; cancelled: boolean };
let baselineJob: Job | null = null;
let resetJob: Job | null = null;

/** Advances a fresh simulation towards its target in slices of SLICE_MIN minutes between frames. */
function runJob(job: Job) {
  const step = () => {
    if (job.cancelled) return;
    const target = job.target();
    advance(job.sim, Math.min(job.sim.minute + SLICE_MIN, target));
    if (job.sim.minute >= target) job.done(job.sim);
    else setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

export const useSim = create<SimStore>((set, get) => {
  const initial = createSim(DEFAULT_SEED, DEFAULT_START);
  simClock.t = initial.minute;
  const bump = () => set({ version: get().sim.version });
  const lifecycle = (fn: (s: SimState) => LifecycleResult) => {
    const r = fn(get().sim);
    bump();
    return r;
  };
  return {
    sim: initial,
    baseline: null,
    resets: 0,
    resetting: false,
    version: initial.version,
    running: true,
    speed: 60,
    seed: DEFAULT_SEED,
    play: () => set({ running: true }),
    pause: () => set({ running: false }),
    setSpeed: (speed) => set({ speed }),
    reset: () => {
      if (resetJob) resetJob.cancelled = true;
      if (baselineJob) baselineJob.cancelled = true;
      baselineJob = null;
      set({ resetting: true });
      const fresh = createSim(get().seed, 0);
      fresh.liveFrom = DEFAULT_START;
      const job: Job = {
        sim: fresh,
        target: () => DEFAULT_START,
        cancelled: false,
        done: (sim) => {
          resetJob = null;
          clearImages();
          simClock.t = sim.minute;
          set({ sim, baseline: null, resetting: false, resets: get().resets + 1, version: sim.version + 1000 * (get().resets + 1) });
          scheduleBaseline(0);
        },
      };
      resetJob = job;
      runJob(job);
    },
    resetNow: () => {
      if (resetJob) resetJob.cancelled = true;
      if (baselineJob) baselineJob.cancelled = true;
      resetJob = baselineJob = null;
      const sim = createSim(get().seed, DEFAULT_START);
      clearImages();
      simClock.t = sim.minute;
      set({ sim, baseline: null, resetting: false, resets: get().resets + 1, version: sim.version + 1000 * (get().resets + 1) });
      scheduleBaseline();
    },
    ensureBaseline: () => {
      const { baseline, sim, seed } = get();
      if (baseline) {
        if (baseline.minute < sim.minute) advance(baseline, sim.minute);
        return baseline;
      }
      if (baselineJob && !baselineJob.cancelled) {
        // Finish the remaining slices now (an activation needs the comparison immediately).
        const job = baselineJob;
        job.cancelled = true;
        baselineJob = null;
        advance(job.sim, sim.minute);
        set({ baseline: job.sim });
        return job.sim;
      }
      const b = createSim(seed, sim.minute, { events: false });
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
      // Condition-based maintenance is not a disturbance to undo: it is left to complete.
      for (const sc of sim.scenarios) if ((sc.end == null || sc.end > sim.minute) && sc.kind !== 'maintenance') clearScenario(sim, sc.id);
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
    acknowledge: (id) => lifecycle((s) => acknowledgeEvent(s, id)),
    assign: (id, owner) => lifecycle((s) => assignEvent(s, id, owner)),
    investigate: (id) => lifecycle((s) => investigateEvent(s, id)),
    note: (id, text) => lifecycle((s) => addEventNote(s, id, text)),
    resolve: (id, reason, action) => lifecycle((s) => resolveEvent(s, id, reason, action)),
    reportExported: (id) => {
      recordReport(get().sim, id, new Date().toISOString());
      bump();
    },
    attachImage: (evidenceId, image, provenance) => {
      attachEvidenceImage(get().sim, evidenceId, image, provenance);
      bump();
    },
    evidenceUnavailable: (evidenceId, reason) => {
      markEvidenceUnavailable(get().sim, evidenceId, reason);
      bump();
    },
    setRule: (key, value) => {
      const { sim } = get();
      sim.rules = { ...sim.rules, [key]: value };
      sim.version++;
      bump();
    },
    resetRules: () => {
      const { sim } = get();
      sim.rules = { ...DEFAULT_EVENT_RULES };
      sim.version++;
      bump();
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
  const { running, speed, sim, resetting } = useSim.getState();
  if (!running || resetting) return;
  simClock.t += (dt * speed) / 60;
  const target = Math.floor(simClock.t);
  if (target > sim.minute) {
    advance(sim, target);
    const { baseline } = useSim.getState();
    if (baseline) advance(baseline, target);
    useSim.setState({ version: sim.version });
  }
}

/** Builds the baseline in background slices (no long task) shortly after start-up / reset. */
function scheduleBaseline(delay = 1500) {
  if (typeof window === 'undefined') return;
  setTimeout(() => {
    if (useSim.getState().baseline || baselineJob) return;
    const job: Job = {
      sim: createSim(useSim.getState().seed, 0, { events: false }),
      target: () => useSim.getState().sim.minute,
      cancelled: false,
      done: (b) => {
        if (baselineJob !== job) return;
        baselineJob = null;
        useSim.setState({ baseline: b });
      },
    };
    baselineJob = job;
    runJob(job);
  }, delay);
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
