/**
 * Factory Copilot page — pure derivations for the "Situation now" context panel and the
 * "Investigate an event" picker. Everything is read from the one simulation state with the same
 * metric functions the workspaces and the copilot use, so the panel and the answers agree.
 */
import { CONVEYOR_BY_ID } from '../../model/plant';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import type { AlertSeverity, EventCategory, OperationalState, OpEvent, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { TRACKED_ASSETS } from '../../sim/engine';
import { EVENT_CATEGORY_LABEL, activeEvents } from '../../sim/events';
import { bottleneck, fleetMetrics, lineMetrics, operationalState, resolvePeriod, targetStatus, type TargetStatus } from '../../sim/metrics';
import type { Metric } from '../../sim/oee';
import { shiftAt } from '../../sim/time';

export const SEVERITY_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/** Event categories in display order. */
export const CATEGORY_ORDER: EventCategory[] = ['production', 'quality', 'logistics', 'equipment', 'energy', 'data'];

/** States that mean an asset is not producing for a reason of its own (or its data cannot be trusted). */
const STOPPED_STATES: OperationalState[] = ['fault', 'stopped', 'unknown', 'disconnected'];

export type CategoryRow = { category: EventCategory; label: string; active: number; worst: AlertSeverity | null };

export type Situation = {
  minute: number;
  shiftLabel: string;
  shiftElapsed: number;
  outputM2: number;
  targetM2: number;
  attainment: number | null;
  status: TargetStatus;
  oee: Metric;
  bottleneck: { stage: StageId; name: string; shifted: boolean; cause: 'constraint' | 'starving' | 'blocking'; windowLabel: string };
  /** Machines and conveyors stopped, in fault or with stale data, longest first. */
  stopped: { id: string; name: string; state: OperationalState; since: number }[];
  trucksOnSite: number;
  trucksWaiting: number;
  categories: CategoryRow[];
};

/** Active events (condition still present), most urgent first: severity, kiln hold-up, most recent start. */
export function rankActive(events: OpEvent[]): OpEvent[] {
  return [...events].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.acc.constraintMin - a.acc.constraintMin || b.start - a.start || (a.id < b.id ? -1 : 1),
  );
}

/** Active events of one category (or all), ranked for the picker. */
export function pickerEvents(s: SimState, category: EventCategory | null): OpEvent[] {
  return rankActive(activeEvents(s).filter((e) => !category || e.category === category));
}

/** Active-event count and highest severity per category (every category listed, zero included). */
export function categoryRows(events: OpEvent[]): CategoryRow[] {
  return CATEGORY_ORDER.map((category) => {
    const xs = events.filter((e) => e.category === category);
    const worst = xs.reduce<AlertSeverity | null>((w, e) => (w == null || SEVERITY_RANK[e.severity] > SEVERITY_RANK[w] ? e.severity : w), null);
    return { category, label: EVENT_CATEGORY_LABEL[category], active: xs.length, worst };
  });
}

const nameOf = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;

export function situationNow(s: SimState): Situation {
  const p = resolvePeriod('shift', s.minute);
  const lm = lineMetrics(s, p);
  const bn = bottleneck(s);
  const fm = fleetMetrics(s, p);
  const sh = shiftAt(s.minute);
  const stopped = TRACKED_ASSETS.map((id) => ({ id, name: nameOf(id), state: operationalState(s, id), since: s.machines[id]?.since ?? s.minute }))
    .filter((x) => STOPPED_STATES.includes(x.state))
    .sort((a, b) => a.since - b.since);
  return {
    minute: s.minute,
    shiftLabel: sh.label,
    shiftElapsed: s.minute - sh.start,
    outputM2: lm.outputM2,
    targetM2: lm.targetM2,
    attainment: lm.attainment,
    status: targetStatus(lm.attainment),
    oee: lm.oee.oee,
    bottleneck: { stage: bn.current.stage, name: bn.current.name, shifted: bn.shifted, cause: bn.cause, windowLabel: bn.period.label },
    stopped,
    trucksOnSite: fm.onSite,
    trucksWaiting: fm.waiting,
    categories: categoryRows(activeEvents(s)),
  };
}
