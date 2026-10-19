/**
 * Equipment-state distribution now (brief §8 A): how many process machines — or conveyors — are in each
 * operational state at this plant minute, from the simulated state signals (src/sim/metrics operationalState:
 * a stale feed is 'unknown', never the last state). The counts are of assets, not of time; the stage-by-stage
 * view over the shift is Production › Plan & flow.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_IDS, PROCESS_MACHINES } from '../../model/plant';
import type { OperationalState } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { operationalState } from '../../sim/metrics';

export type StateScope = 'machines' | 'conveyors';

/** Display order. The states the brief names are always shown (a zero is a real count of assets); 'idle' and 'disconnected' only when present. */
const ORDER: OperationalState[] = ['running', 'reduced', 'starved', 'blocked', 'idle', 'stopped', 'fault', 'planned', 'changeover', 'unknown', 'disconnected'];
export const ALWAYS_SHOWN: ReadonlySet<OperationalState> = new Set(['running', 'reduced', 'starved', 'blocked', 'stopped', 'fault', 'planned', 'changeover', 'unknown']);

export const STATE_SCOPE_LABEL: Record<StateScope, string> = { machines: 'Machines', conveyors: 'Conveyors' };

export type StateBucket = { state: OperationalState; count: number; assets: { id: string; name: string }[] };

export type StateMix = { scope: StateScope; total: number; buckets: StateBucket[]; at: number };

export const scopeAssets = (scope: StateScope): string[] => (scope === 'machines' ? PROCESS_MACHINES : CONVEYOR_IDS);

/** Assets of the scope per operational state now, in display order. */
export function stateMix(s: SimState, scope: StateScope = 'machines'): StateMix {
  const ids = scopeAssets(scope).filter((id) => s.machines[id]);
  const by = new Map<OperationalState, StateBucket['assets']>();
  for (const id of ids) {
    const st = operationalState(s, id);
    const list = by.get(st) ?? [];
    list.push({ id, name: EQUIPMENT_BY_ID[id]?.name ?? id });
    by.set(st, list);
  }
  const buckets = ORDER.filter((st) => ALWAYS_SHOWN.has(st) || by.has(st)).map((state) => ({ state, count: by.get(state)?.length ?? 0, assets: by.get(state) ?? [] }));
  return { scope, total: ids.length, buckets, at: s.minute };
}
