/**
 * Equipment-state distribution of the line (Plan & flow, brief §8 Production Overview — state distribution):
 * how many process machines are in each operational state now (changeover included), and the time in each
 * state over the period from the machines' state timelines (src/sim/telemetry.ts stateTimeline through
 * src/calc stateDurations). Time without a state record is counted as such — never as running. Pure.
 */
import { stateDurations } from '../../calc';
import { STAGES } from '../../model/plant';
import type { EquipmentStateSegment } from '../../model/telemetry';
import type { OperationalState } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { operationalState, type Period } from '../../sim/metrics';
import { stateTimeline } from '../../sim/telemetry';
import { assetName } from './stage/derive';

/** Display order of the states (productive first, then waits, stops, planned, unknown). */
export const STATE_ORDER: OperationalState[] = ['running', 'reduced', 'starved', 'blocked', 'idle', 'fault', 'stopped', 'changeover', 'planned', 'unknown', 'disconnected'];

/** The line's process machines in flow order. */
export const LINE_MACHINES: string[] = STAGES.flatMap((st) => st.machines);

export type StateCount = { state: OperationalState; count: number; ids: string[] };
export type StateTime = { state: OperationalState; minutes: number; share: number };

export type StateDistribution = {
  machines: number;
  /** Machines per state now (states with at least one machine, in STATE_ORDER). */
  now: StateCount[];
  window: { from: number; to: number };
  /** Machine-minutes per state over the window (shares of the machine-minutes with a record). */
  period: StateTime[];
  /** Machine-minutes in the window without a state record (outside the kept history). */
  unrecorded: number;
  lanes: { id: string; label: string; segments: EquipmentStateSegment[] }[];
};

export function stateDistribution(s: SimState, p: Period, ids: string[] = LINE_MACHINES): StateDistribution {
  const nowBy = new Map<OperationalState, string[]>();
  for (const id of ids) {
    const st = operationalState(s, id);
    nowBy.set(st, [...(nowBy.get(st) ?? []), id]);
  }
  const window = { from: p.from, to: Math.min(p.to, s.minute) };
  const span = Math.max(0, window.to - window.from);
  const totals = new Map<OperationalState, number>();
  const lanes = ids.map((id) => {
    const segments = span > 0 ? stateTimeline(s, id, window) : [];
    const d = stateDurations(segments, window);
    for (const [k, v] of Object.entries(d) as [OperationalState, number][]) totals.set(k, (totals.get(k) ?? 0) + v);
    return { id, label: `${id} · ${assetName(id)}`, segments };
  });
  const recorded = [...totals.values()].reduce((a, b) => a + b, 0);
  return {
    machines: ids.length,
    now: STATE_ORDER.filter((st) => nowBy.has(st)).map((state) => ({ state, count: nowBy.get(state)!.length, ids: nowBy.get(state)! })),
    window,
    period: STATE_ORDER.filter((st) => (totals.get(st) ?? 0) > 0).map((state) => ({ state, minutes: totals.get(state)!, share: recorded > 0 ? totals.get(state)! / recorded : 0 })),
    unrecorded: Math.max(0, span * ids.length - recorded),
    lanes,
  };
}
