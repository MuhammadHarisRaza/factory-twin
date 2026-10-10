/**
 * Scenario actions shared by the Scenario Simulator workspace and the quick drawer:
 * activation (with where it was triggered from), "Show me" navigation, the demonstration
 * runs (set-up, clear, and the truck-delay watcher that adds the dock hold when the injected
 * truck docks), Reset Demo with its after-reset checks, and the parameter choices, which are
 * kept in one store so both surfaces stay in step.
 *
 * The watcher and the reset check subscribe to the simulation store at module load; this module
 * is loaded with the app shell (the Scenarios drawer imports it), so they work on every workspace.
 */
import { create } from 'zustand';
import { openEquipment, openEvent, openStage, openVehicle, useApp } from '../../app/store';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { initialValues, isClearable, sameTarget, scenarioTrucks, type ParamValue, type ScenarioDef, type ShowTarget, type Values } from './catalogue';
import { DEMO_BY_ID, demoInitialValues, holdDef, resetSnapshot, watchDecision, type DemoId, type DemoRun, type ResetSnapshot } from './demos';

// ── Parameter choices ─────────────────────────────────────────────────────────

type ParamStore = {
  values: Record<string, Values>;
  set: (entryId: string, key: string, value: ParamValue) => void;
  reset: () => void;
};

const allInitial = () => ({ ...initialValues(), ...demoInitialValues() });

export const useScenarioParams = create<ParamStore>((set) => ({
  values: allInitial(),
  set: (entryId, key, value) => set((s) => ({ values: { ...s.values, [entryId]: { ...s.values[entryId], [key]: value } } })),
  reset: () => set({ values: allInitial() }),
}));

// ── Where a scenario was triggered ────────────────────────────────────────────

export type Origin = 'simulator' | 'drawer' | 'guide' | 'demo';
export const ORIGIN_LABEL: Record<Origin, string> = {
  simulator: 'Scenario Simulator',
  drawer: 'Scenarios drawer',
  guide: 'Presenter guide',
  demo: 'Demonstration card',
};

/** Keyed by reset epoch + id: scenario ids restart after Reset Demo. */
const origins = new Map<string, Origin>();
const originKey = (resets: number, id: string) => `${resets}:${id}`;

export const originOf = (resets: number, id: string): Origin | null => origins.get(originKey(resets, id)) ?? null;

/**
 * Activates a scenario at the current plant time. A running instance with the same kind
 * and target is cleared first, so a changed parameter replaces it instead of stacking.
 * Returns null while Reset Demo is rebuilding the plant (the activation would be discarded).
 */
export function runScenario(def: ScenarioDef, origin: Origin) {
  const st = useSim.getState();
  if (st.resetting) return null;
  for (const sc of st.sim.scenarios) if ((sc.end == null || sc.end > st.sim.minute) && sameTarget(sc, def)) st.clear(sc.id);
  const sc = st.activate(def);
  origins.set(originKey(st.resets, sc.id), origin);
  return sc;
}

// ── Navigation ────────────────────────────────────────────────────────────────

export function showTarget(t: ShowTarget) {
  switch (t.type) {
    case 'equipment':
      return openEquipment(t.id);
    case 'vehicle':
      return useSim.getState().sim.logistics.active.includes(t.id) ? openVehicle(t.id) : useApp.getState().go('fleet');
    case 'stage':
      return openStage(t.id);
    case 'event':
      return openEvent(t.id);
    case 'copilot':
      return useApp.getState().openCopilot(t.question, { eventId: t.eventId });
    default:
      return useApp.getState().go(t.id);
  }
}

/** Factory Twin overview with selections cleared. */
export function openOverview() {
  useApp.getState().go('twin');
  requestAnimationFrame(() => useTwin.getState().reset());
}

// ── Demonstration runs ────────────────────────────────────────────────────────

type DemoStore = {
  runs: Partial<Record<DemoId, DemoRun>>;
  put: (run: DemoRun) => void;
  update: (id: DemoId, fn: (run: DemoRun) => DemoRun) => void;
  clearAll: () => void;
};

export const useDemoRuns = create<DemoStore>((set) => ({
  runs: {},
  put: (run) => set((s) => ({ runs: { ...s.runs, [run.demo]: run } })),
  update: (id, fn) => set((s) => (s.runs[id] ? { runs: { ...s.runs, [id]: fn(s.runs[id]!) } } : s)),
  clearAll: () => set({ runs: {} }),
}));

/** The run of a demonstration in the current reset epoch, or null. */
export const currentRun = (runs: Partial<Record<DemoId, DemoRun>>, id: DemoId, epoch: number) => {
  const r = runs[id];
  return r && r.epoch === epoch ? r : null;
};

/**
 * One-click set-up of a demonstration card: activates its scenario inputs at the current plant
 * time (replacing a running instance on the same target). The truck delay also starts a watcher
 * that adds the dock hold once the injected truck has docked.
 */
export function setupDemo(id: DemoId, v: Values) {
  const def = DEMO_BY_ID[id];
  const st = useSim.getState();
  if (st.resetting) return null;
  const prev = currentRun(useDemoRuns.getState().runs, id, st.resets);
  if (prev?.watch?.state === 'waiting') useDemoRuns.getState().update(id, (r) => ({ ...r, watch: { ...r.watch!, state: 'cancelled', at: st.sim.minute, note: 'Replaced by a new set-up' } }));
  const ids: string[] = [];
  for (const d of def.build(v, st.sim.minute)) {
    const sc = runScenario(d, 'demo');
    if (sc) ids.push(sc.id);
  }
  const run: DemoRun = { demo: id, epoch: st.resets, at: useSim.getState().sim.minute, scenarioIds: ids };
  if (id === 'D' && ids[0]) {
    const truck = scenarioTrucks(useSim.getState().sim, ids[0])[0];
    if (truck)
      run.watch = { truckId: truck.id, truckLabel: truck.label, hold: Number(v.hold) || 75, state: 'waiting', dockId: null, holdScenarioId: null, at: null, note: null };
  }
  useDemoRuns.getState().put(run);
  return run;
}

/** Ends what a demonstration still has in effect: its active scenarios and a pending truck-delay watch. */
export function clearDemo(id: DemoId) {
  const st = useSim.getState();
  const run = currentRun(useDemoRuns.getState().runs, id, st.resets);
  if (!run) return;
  for (const sid of run.scenarioIds) {
    const sc = st.sim.scenarios.find((x) => x.id === sid);
    if (sc && isClearable(st.sim, sc)) st.clear(sc.id);
  }
  if (run.watch?.state === 'waiting')
    useDemoRuns.getState().update(id, (r) => ({ ...r, watch: { ...r.watch!, state: 'cancelled', at: useSim.getState().sim.minute, note: 'Cancelled before the truck docked' } }));
}

/** Truck-delay watcher: on every simulated minute, add the dock hold as soon as the injected truck is at its dock. */
let applying = false;
function watchTruckDelay() {
  if (applying) return;
  const st = useSim.getState();
  if (st.resetting) return;
  const run = currentRun(useDemoRuns.getState().runs, 'D', st.resets);
  const w = run?.watch;
  if (!run || !w || w.state !== 'waiting') return;
  const dec = watchDecision(st.sim, w);
  if (dec.action === 'wait') return;
  if (dec.action === 'missed') {
    useDemoRuns.getState().update('D', (r) => ({ ...r, watch: { ...r.watch!, state: 'missed', at: st.sim.minute, note: dec.reason } }));
    return;
  }
  // Mark first: activating bumps the store version, which re-enters this subscriber.
  applying = true;
  try {
    useDemoRuns.getState().update('D', (r) => ({ ...r, watch: { ...r.watch!, state: 'applied', dockId: dec.dockId, at: st.sim.minute } }));
    const sc = runScenario(holdDef(w, dec.dockId), 'demo');
    useDemoRuns.getState().update('D', (r) => ({
      ...r,
      scenarioIds: sc ? [...r.scenarioIds, sc.id] : r.scenarioIds,
      watch: { ...r.watch!, holdScenarioId: sc?.id ?? null, at: sc?.start ?? st.sim.minute, note: sc ? null : 'The hold could not be added' },
    }));
  } finally {
    applying = false;
  }
}

// ── Reset Demo ────────────────────────────────────────────────────────────────

type ResetCheckStore = {
  /** 'resetting' from the click until the rebuilt plant is in place. */
  phase: 'idle' | 'resetting' | 'done';
  snapshot: ResetSnapshot | null;
  dismiss: () => void;
};

export const useResetCheck = create<ResetCheckStore>((set) => ({
  phase: 'idle',
  snapshot: null,
  dismiss: () => set({ phase: 'idle', snapshot: null }),
}));

/**
 * Restores the seeded baseline (Mon 12 Oct 10:30, 7 days of history), removes every scenario and
 * clears selections. The rebuild runs in background slices (`useSim().resetting` while it does);
 * the after-reset checks are taken the moment the new plant is in place.
 */
export function resetDemo() {
  useResetCheck.setState({ phase: 'resetting', snapshot: null });
  useSim.getState().reset();
  useTwin.getState().reset();
  useScenarioParams.getState().reset();
  useDemoRuns.getState().clearAll();
}

if (typeof window !== 'undefined')
  useSim.subscribe((st, prev) => {
    if (st.resets !== prev.resets) {
      // A completed reset (from here or any other workspace): checks refer to this moment.
      useDemoRuns.getState().clearAll();
      useResetCheck.setState({ phase: 'done', snapshot: resetSnapshot(st.sim, st.resets) });
      return;
    }
    if (st.resetting && !prev.resetting && useResetCheck.getState().phase !== 'resetting') useResetCheck.setState({ phase: 'resetting', snapshot: null });
    if (st.version !== prev.version) watchTruckDelay();
  });
