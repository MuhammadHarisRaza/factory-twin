/**
 * Scenario actions shared by the Scenario Simulator workspace and the quick drawer:
 * activation (with where it was triggered from), "Show me" navigation, Reset Demo, and
 * the parameter choices, which are kept in one store so both surfaces stay in step.
 */
import { create } from 'zustand';
import { openEquipment, openVehicle, useApp } from '../../app/store';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { initialValues, sameTarget, type ParamValue, type ScenarioDef, type ShowTarget, type Values } from './catalogue';

// ── Parameter choices ─────────────────────────────────────────────────────────

type ParamStore = {
  values: Record<string, Values>;
  set: (entryId: string, key: string, value: ParamValue) => void;
  reset: () => void;
};

export const useScenarioParams = create<ParamStore>((set) => ({
  values: initialValues(),
  set: (entryId, key, value) => set((s) => ({ values: { ...s.values, [entryId]: { ...s.values[entryId], [key]: value } } })),
  reset: () => set({ values: initialValues() }),
}));

// ── Where a scenario was triggered ────────────────────────────────────────────

export type Origin = 'simulator' | 'drawer' | 'guide';
export const ORIGIN_LABEL: Record<Origin, string> = {
  simulator: 'Scenario Simulator',
  drawer: 'Scenarios drawer',
  guide: 'Presenter guide',
};

/** Keyed by reset epoch + id: scenario ids restart after Reset Demo. */
const origins = new Map<string, Origin>();
const originKey = (resets: number, id: string) => `${resets}:${id}`;

export const originOf = (resets: number, id: string): Origin | null => origins.get(originKey(resets, id)) ?? null;

/**
 * Activates a scenario at the current plant time. A running instance with the same kind
 * and target is cleared first, so a changed parameter replaces it instead of stacking.
 */
export function runScenario(def: ScenarioDef, origin: Origin) {
  const st = useSim.getState();
  for (const sc of st.sim.scenarios) if ((sc.end == null || sc.end > st.sim.minute) && sameTarget(sc, def)) st.clear(sc.id);
  const sc = st.activate(def);
  origins.set(originKey(st.resets, sc.id), origin);
  return sc;
}

// ── Navigation ────────────────────────────────────────────────────────────────

export function showTarget(t: ShowTarget) {
  if (t.type === 'equipment') openEquipment(t.id);
  else if (t.type === 'vehicle') openVehicle(t.id);
  else useApp.getState().go(t.id);
}

/** Factory Twin overview with selections cleared. */
export function openOverview() {
  useApp.getState().go('twin');
  requestAnimationFrame(() => useTwin.getState().reset());
}

// ── Reset Demo ────────────────────────────────────────────────────────────────

/** Restores the seeded baseline (Mon 12 Oct 10:30, 7 days of history), removes every scenario and clears selections. */
export function resetDemo() {
  useSim.getState().reset();
  useTwin.getState().reset();
  useScenarioParams.getState().reset();
}
