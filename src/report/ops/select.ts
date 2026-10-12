/**
 * Which events an operational report lists — ONE definition shared by the report builders
 * (common.ts significantEvents) and the Events tab filters (src/pages/events/filters.ts), so the
 * "open these events" action of a report preview lists exactly the events the report lists.
 */
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity, EventCategory, MonitoredStageId, OpEvent } from '../../model/types';
import { eventInMonitoredStage } from '../../sim/events';
import type { PeriodKey } from '../../sim/metrics';

export const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/** Significant: a root event (not the consequence of another event) of warning severity or above. */
export const isSignificant = (e: Pick<OpEvent, 'consequenceOf' | 'severity'>, minSeverity: AlertSeverity = 'warning') => !e.consequenceOf && SEV_RANK[e.severity] >= SEV_RANK[minSeverity];

/** Label of the significance rule (reports and the Events tab filter). */
export const SIGNIFICANT_LABEL = 'Root events, warning and above';

/**
 * Whether an event's condition overlaps a period [from, to): it started before the period ended (or
 * by now, for a period running to date) and was not cleared before the period began. An active event
 * reaches now.
 */
export const overlapsPeriod = (e: Pick<OpEvent, 'start' | 'end'>, p: { from: number; to: number }, now: number) => (p.to >= now ? e.start <= now : e.start < p.to) && (e.end ?? now) >= p.from;

/**
 * How a report selected its significant events: the period (resolved with resolvePeriod, like the
 * header selector), the categories (null = any) and the stage (null = whole line). The Events tab
 * reproduces the list from it (src/pages/events/state.ts openReportEvents).
 */
export type ReportEventQuery = { period: PeriodKey; categories: EventCategory[] | null; stage: MonitoredStageId | null };

/** Whether an event is in a stage — the rule of the Production stage views (eventInMonitoredStage). */
export const inStageOf = (e: OpEvent, stage: MonitoredStageId) => {
  const st = MONITORED_STAGE_BY_ID[stage];
  return !!st && eventInMonitoredStage(st, e);
};

/** Category and stage part of a report query (the period and significance are checked separately). */
export const inQueryScope = (e: OpEvent, q: Pick<ReportEventQuery, 'categories' | 'stage'>) => (!q.categories || q.categories.includes(e.category)) && (!q.stage || inStageOf(e, q.stage));
