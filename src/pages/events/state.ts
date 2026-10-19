/**
 * View state of Events & Reports that outlives a tab switch: the event-list filters and page, the
 * Reliability and Data & connectivity choices, the insight-threshold editor filters, and the report
 * builder's choices (type, period, scope, incident event). Plain UI state — the records
 * themselves always come from the shared simulation store. A completed Reset Demo clears the
 * incident choice (event ids restart after a reset).
 *
 * The report builder starts from the header period whenever the user arrives from a workspace that
 * uses it (Production, Quality, Fleet), so a report covers the period the user was just looking at.
 */
import { create } from 'zustand';
import { PERIOD_WORKSPACES, useApp } from '../../app/store';
import { useSim } from '../../sim/store';
import { REPORT_PERIODS, type ReportEventQuery, type ReportPeriodKey, type ReportScope, type ReportType } from '../../report/ops/types';
import { DEFAULT_GAP_FILTERS, type ClassFilter, type GapFilters, type StageFilter } from './coverage';
import { DEFAULT_FILTERS, reportFilters, type EventFilters } from './filters';
import { DEFAULT_INSIGHT_FILTERS, type InsightFilters } from './insightThresholds';
import type { LaneGroup, ParetoBy, ReliabilityWindowKey, StopClass } from './reliability';

type EventsViewState = {
  filters: EventFilters;
  page: number;
  setFilters: (p: Partial<EventFilters>) => void;
  resetFilters: () => void;
  setPage: (page: number) => void;
};

export const useEventsView = create<EventsViewState>((set) => ({
  filters: DEFAULT_FILTERS,
  page: 0,
  setFilters: (p) => set((s) => ({ filters: { ...s.filters, ...p }, page: 0 })),
  resetFilters: () => set({ filters: DEFAULT_FILTERS, page: 0 }),
  setPage: (page) => set({ page }),
}));

/** Reliability tab choices: the window, the stop class of the Pareto / longest stops, the grouping and the timeline lanes. */
type ReliabilityViewState = {
  window: ReliabilityWindowKey;
  cls: StopClass;
  by: ParetoBy;
  lanes: LaneGroup;
  set: (p: Partial<Omit<ReliabilityViewState, 'set'>>) => void;
};

export const useReliabilityView = create<ReliabilityViewState>((set) => ({ window: '24h', cls: 'unplanned', by: 'reason', lanes: 'machines', set: (p) => set(p) }));

/** Data & connectivity tab choices: the coverage matrix class, the equipment table filters and the gap-signal filters. */
type DataViewState = {
  cls: ClassFilter;
  equipmentQuery: string;
  equipmentStage: StageFilter;
  gaps: GapFilters;
  set: (p: Partial<Omit<DataViewState, 'set' | 'setGaps'>>) => void;
  setGaps: (p: Partial<GapFilters>) => void;
};

export const useDataView = create<DataViewState>((set) => ({
  cls: 'all',
  equipmentQuery: '',
  equipmentStage: 'all',
  gaps: DEFAULT_GAP_FILTERS,
  set: (p) => set(p),
  setGaps: (p) => set((s) => ({ gaps: { ...s.gaps, ...p } })),
}));

/** Filters of the insight-rule thresholds editor (Detection rules tab). */
export const useInsightFilters = create<InsightFilters & { set: (p: Partial<InsightFilters>) => void }>((set) => ({ ...DEFAULT_INSIGHT_FILTERS, set: (p) => set(p) }));

type ReportBuilderState = {
  type: ReportType;
  period: ReportPeriodKey;
  scope: ReportScope;
  /** Event of the incident investigation (null = the selected event, else the most pressing one). */
  eventId: string | null;
  set: (p: Partial<Omit<ReportBuilderState, 'set'>>) => void;
};

/** The report period for the header period of Production / Quality / Fleet (every header period is a report period). */
export const reportPeriodFor = (p: string): ReportPeriodKey => ((REPORT_PERIODS as string[]).includes(p) ? (p as ReportPeriodKey) : 'shift');

export const useReportBuilder = create<ReportBuilderState>((set) => ({
  type: 'shift',
  period: reportPeriodFor(useApp.getState().period),
  scope: 'line',
  eventId: null,
  set: (p) => set(p),
}));

/** Opens the incident investigation of an event in the report builder. */
export function openIncidentReport(eventId: string) {
  useReportBuilder.getState().set({ type: 'incident', eventId });
  useApp.getState().setTab('events', 'reports');
}

/**
 * Opens the Events tab listing exactly a report's significant events: the report's period as the
 * time window, root events of warning and above, its categories and stage. `firstId` (the report's
 * first row) is selected unless the selected event is already in the list. One history step: Back
 * returns to the report.
 */
export function openReportEvents(q: ReportEventQuery, ids: string[]) {
  useEventsView.getState().setFilters(reportFilters(q));
  const app = useApp.getState();
  useApp.setState((st) => {
    const tabs = { ...st.tabs };
    delete tabs.events;
    return { tabs };
  });
  const keep = app.selectedEventId != null && ids.includes(app.selectedEventId);
  const id = keep ? app.selectedEventId : (ids[0] ?? null);
  if (app.workspace === 'events') app.selectEvent(id);
  else {
    useApp.setState({ selectedEventId: id });
    app.go('events');
  }
}

// Arriving in Events & Reports from a workspace with the header period selector: the report builder
// takes that period (the user may still pick another one in the builder).
useApp.subscribe((a, prev) => {
  if (a.workspace !== 'events' || prev.workspace === 'events' || !PERIOD_WORKSPACES.includes(prev.workspace)) return;
  const period = reportPeriodFor(a.period);
  if (useReportBuilder.getState().period !== period) useReportBuilder.getState().set({ period });
});

useSim.subscribe((s, prev) => {
  if (s.resets !== prev.resets && useReportBuilder.getState().eventId != null) useReportBuilder.getState().set({ eventId: null });
});
