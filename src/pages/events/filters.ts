/**
 * Events workspace filters — pure functions over the shared event records (s.events).
 * Facet counts use every filter except the facet's own, so an option shows how many events
 * selecting it would list. The stage filter uses the same rule as the Production stage views
 * (eventInMonitoredStage), so a stage lists the same events everywhere. The time windows named like
 * the header periods (shift, previous shift, today, 24 h, 7 d) are those periods (resolvePeriod), and
 * the period overlap and "root events, warning and above" rules are the reports' own (report/ops/select.ts),
 * so a report's "open these events" lists exactly the report's events.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID, GEOFENCES, INSPECTION_STATIONS, MONITORED_STAGES, MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity, EventCategory, EventStatus, MonitoredStageId, OpEvent, RecordSource } from '../../model/types';
import { inStageOf, isSignificant, overlapsPeriod, type ReportEventQuery } from '../../report/ops/select';
import { EVENT_CATEGORY_LABEL, EVENT_TYPE_LABEL } from '../../sim/events';
import { resolvePeriod } from '../../sim/metrics';
import { formatClock } from '../../sim/time';

export type WindowKey = '4h' | 'shift' | 'prev-shift' | 'today' | '24h' | '7d' | 'all';
export type StatusFilter = EventStatus | 'all' | 'open';
export type ConditionFilter = 'all' | 'active' | 'cleared';
export type SourceFilter = RecordSource | 'all';
export type StageFilter = MonitoredStageId | 'all';

export type EventFilters = {
  category: EventCategory | 'all';
  /** A group of categories (set by a report's "open these events"; null = no group restriction). */
  categories: EventCategory[] | null;
  /** Only root events of warning severity and above — the significant events of the reports. */
  significantOnly: boolean;
  status: StatusFilter;
  severity: AlertSeverity | 'all';
  condition: ConditionFilter;
  /** Production stage (same membership rule as the Production stage views). */
  stage: StageFilter;
  /** Simulated by the engine, or caused by a demo scenario. */
  source: SourceFilter;
  window: WindowKey;
  /** Only events detected during this demo session (exclude the pre-rolled history). */
  sessionOnly: boolean;
  /** Free text: event id, title, rule id, asset / vehicle / station / zone ids and names. */
  query: string;
};

export const DEFAULT_FILTERS: EventFilters = {
  category: 'all',
  categories: null,
  significantOnly: false,
  status: 'all',
  severity: 'all',
  condition: 'all',
  stage: 'all',
  source: 'all',
  window: '24h',
  sessionOnly: false,
  query: '',
};

/** 'Show all events' (open report outside the filters): every recorded event, so the report's row is listed. */
export const ALL_EVENTS_FILTERS: EventFilters = { ...DEFAULT_FILTERS, window: 'all' };

export const WINDOW_OPTIONS: { value: WindowKey; label: string }[] = [
  { value: '4h', label: 'Last 4 h' },
  { value: 'shift', label: 'Shift' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: 'all', label: 'All' },
];

/** Windows offered only while selected (a report of the previous shift or of today opens them). */
const EXTRA_WINDOWS: Partial<Record<WindowKey, string>> = { 'prev-shift': 'Prev. shift', today: 'Today' };

/** The window options to show: the standard ones, plus the selected one if it is not among them. */
export function windowOptions(current: WindowKey): { value: WindowKey; label: string }[] {
  const extra = EXTRA_WINDOWS[current];
  if (!extra) return WINDOW_OPTIONS;
  const at = WINDOW_OPTIONS.findIndex((o) => o.value === 'shift') + 1;
  return [...WINDOW_OPTIONS.slice(0, at), { value: current, label: extra }, ...WINDOW_OPTIONS.slice(at)];
}

/** Categories offered as filters (energy is not a product module; no rule raises energy events). */
export const CATEGORY_ORDER: EventCategory[] = ['production', 'quality', 'logistics', 'equipment', 'data'];
export const STAGE_ORDER: MonitoredStageId[] = [...MONITORED_STAGES].sort((a, b) => a.step - b.step).map((s) => s.id);
export const SOURCE_LABEL: Record<RecordSource, string> = { simulation: 'Simulated', scenario: 'Scenario-caused' };

export const inStage = (ev: OpEvent, stage: StageFilter) => stage === 'all' || inStageOf(ev, stage);
export const STATUS_ORDER: EventStatus[] = ['active', 'acknowledged', 'investigating', 'resolved'];
export const SEVERITY_ORDER: AlertSeverity[] = ['critical', 'serious', 'warning', 'info'];

/**
 * Time window as plant minutes [from, to) — to = now, except for the previous shift (its end). The
 * windows named like the header periods are those periods (resolvePeriod), so "Shift", "24 h" and
 * "7 d" here cover exactly what Production, the reports and the header selector call by that name.
 */
export function windowRange(key: WindowKey, now: number): { from: number; to: number; label: string } {
  switch (key) {
    case '4h':
      return { from: now - 240, to: now, label: 'last 4 h' };
    case 'shift':
      return { from: resolvePeriod('shift', now).from, to: now, label: 'this shift' };
    case 'prev-shift': {
      const p = resolvePeriod('prev-shift', now);
      return { from: p.from, to: p.to, label: `previous shift (${p.label})` };
    }
    case 'today': {
      const from = resolvePeriod('today', now).from;
      return { from, to: now, label: `today (since ${formatClock(from)})` };
    }
    case '24h':
      return { from: resolvePeriod('24h', now).from, to: now, label: 'last 24 h' };
    case '7d':
      return { from: resolvePeriod('7d', now).from, to: now, label: 'last 7 days' };
    default:
      return { from: Number.NEGATIVE_INFINITY, to: now, label: 'all recorded' };
  }
}

/** Whether the event's condition overlaps the window (an active event always reaches now) — the reports' rule. */
export const inWindow = (ev: OpEvent, w: { from: number; to: number }, now: number) => overlapsPeriod(ev, w, now);

export const matchesStatus = (ev: OpEvent, f: StatusFilter) => f === 'all' || (f === 'open' ? ev.status !== 'resolved' : ev.status === f);

/** Lower-case text an event is searched by. */
export function searchText(ev: OpEvent, vehicleLabel?: (id: string) => string | undefined): string {
  const a = ev.asset;
  const parts: (string | undefined)[] = [ev.id, ev.title, ev.trigger.ruleId, EVENT_TYPE_LABEL[ev.type], EVENT_CATEGORY_LABEL[ev.category], a.equipmentId, a.stationId, a.vehicleId, a.dockId, a.geofenceId, a.zone ? `zone ${a.zone}` : undefined];
  if (a.equipmentId) parts.push(EQUIPMENT_BY_ID[a.equipmentId]?.name, CONVEYOR_BY_ID[a.equipmentId]?.name);
  if (a.stationId) parts.push(INSPECTION_STATIONS.find((s) => s.id === a.stationId)?.name);
  if (a.vehicleId) parts.push(vehicleLabel?.(a.vehicleId));
  if (a.geofenceId) parts.push(GEOFENCES.find((g) => g.id === a.geofenceId)?.name);
  if (a.stage) parts.push(a.stage, MONITORED_STAGE_BY_ID[a.stage as MonitoredStageId]?.name);
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/** All whitespace-separated terms must occur (in any order). */
export function matchesQuery(text: string, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((t) => text.includes(t));
}

type Ctx = { now: number; vehicleLabel?: (id: string) => string | undefined };

type Facet = 'category' | 'status' | 'severity' | 'condition' | 'stage' | 'source';

function passes(ev: OpEvent, f: EventFilters, ctx: Ctx, skip?: Facet) {
  if (f.sessionOnly && ev.historical) return false;
  if (f.significantOnly && !isSignificant(ev)) return false;
  if (f.categories && !f.categories.includes(ev.category)) return false;
  if (!inWindow(ev, windowRange(f.window, ctx.now), ctx.now)) return false;
  if (skip !== 'category' && f.category !== 'all' && ev.category !== f.category) return false;
  if (skip !== 'status' && !matchesStatus(ev, f.status)) return false;
  if (skip !== 'severity' && f.severity !== 'all' && ev.severity !== f.severity) return false;
  if (skip !== 'condition' && f.condition !== 'all' && (f.condition === 'active') !== (ev.end == null)) return false;
  if (skip !== 'stage' && !inStage(ev, f.stage)) return false;
  if (skip !== 'source' && f.source !== 'all' && ev.source !== f.source) return false;
  if (f.query.trim() && !matchesQuery(searchText(ev, ctx.vehicleLabel), f.query)) return false;
  return true;
}

/** Newest first (by start, then id). */
export const newestFirst = (a: OpEvent, b: OpEvent) => b.start - a.start || b.id.localeCompare(a.id);

export function filterEvents(events: OpEvent[], f: EventFilters, ctx: Ctx): OpEvent[] {
  return events.filter((e) => passes(e, f, ctx)).sort(newestFirst);
}

export type Facets = {
  category: Record<EventCategory | 'all', number>;
  status: Record<StatusFilter, number>;
  severity: Record<AlertSeverity | 'all', number>;
  condition: Record<ConditionFilter, number>;
  stage: Record<StageFilter, number>;
  source: Record<SourceFilter, number>;
};

export function facetCounts(events: OpEvent[], f: EventFilters, ctx: Ctx): Facets {
  const out: Facets = {
    category: { all: 0, production: 0, quality: 0, logistics: 0, equipment: 0, energy: 0, data: 0 },
    status: { all: 0, open: 0, active: 0, acknowledged: 0, investigating: 0, resolved: 0 },
    severity: { all: 0, critical: 0, serious: 0, warning: 0, info: 0 },
    condition: { all: 0, active: 0, cleared: 0 },
    stage: Object.fromEntries([['all', 0], ...STAGE_ORDER.map((id) => [id, 0])]) as Record<StageFilter, number>,
    source: { all: 0, simulation: 0, scenario: 0 },
  };
  for (const e of events) {
    if (passes(e, f, ctx, 'category')) {
      out.category.all++;
      out.category[e.category]++;
    }
    if (passes(e, f, ctx, 'status')) {
      out.status.all++;
      out.status[e.status]++;
      if (e.status !== 'resolved') out.status.open++;
    }
    if (passes(e, f, ctx, 'severity')) {
      out.severity.all++;
      out.severity[e.severity]++;
    }
    if (passes(e, f, ctx, 'condition')) {
      out.condition.all++;
      out.condition[e.end == null ? 'active' : 'cleared']++;
    }
    if (passes(e, f, ctx, 'stage')) {
      out.stage.all++;
      for (const id of STAGE_ORDER) if (inStage(e, id)) out.stage[id]++;
    }
    if (passes(e, f, ctx, 'source')) {
      out.source.all++;
      out.source[e.source]++;
    }
  }
  return out;
}

export const isDefault = (f: EventFilters) => (Object.keys(DEFAULT_FILTERS) as (keyof EventFilters)[]).every((k) => f[k] === DEFAULT_FILTERS[k]);

/**
 * The filters that list exactly a report's significant events: its period as the window, root events
 * of warning and above, its categories and stage; every other filter cleared.
 */
export function reportFilters(q: ReportEventQuery): EventFilters {
  const single = q.categories?.length === 1 ? q.categories[0] : null;
  return {
    ...DEFAULT_FILTERS,
    window: q.period,
    significantOnly: true,
    category: single ?? 'all',
    categories: single ? null : q.categories && q.categories.length ? [...q.categories] : null,
    stage: q.stage ?? 'all',
  };
}

// ── Pagination ────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 40;

/** Page `page` (0-based, clamped) of `total` rows. */
export function pageBounds(total: number, page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  const from = p * size;
  return { page: p, pages, from, to: Math.min(total, from + size) };
}

/** Page index holding row `index` (−1 → 0). */
export const pageOf = (index: number, size = PAGE_SIZE) => Math.max(0, Math.floor(index / size));
