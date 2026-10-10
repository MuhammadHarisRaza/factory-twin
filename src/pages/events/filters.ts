/**
 * Events workspace filters — pure functions over the shared event records (s.events).
 * Facet counts use every filter except the facet's own, so a chip shows how many events
 * selecting it would list.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID, GEOFENCES, INSPECTION_STATIONS, MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity, EventCategory, EventStatus, MonitoredStageId, OpEvent } from '../../model/types';
import { EVENT_CATEGORY_LABEL, EVENT_TYPE_LABEL } from '../../sim/events';
import { resolvePeriod } from '../../sim/metrics';

export type WindowKey = '4h' | 'shift' | '24h' | '7d' | 'all';
export type StatusFilter = EventStatus | 'all' | 'open';
export type ConditionFilter = 'all' | 'active' | 'cleared';

export type EventFilters = {
  category: EventCategory | 'all';
  status: StatusFilter;
  severity: AlertSeverity | 'all';
  condition: ConditionFilter;
  window: WindowKey;
  /** Only events detected during this demo session (exclude the pre-rolled history). */
  sessionOnly: boolean;
  /** Free text: event id, title, asset / vehicle / station / zone ids and names. */
  query: string;
};

export const DEFAULT_FILTERS: EventFilters = { category: 'all', status: 'all', severity: 'all', condition: 'all', window: '24h', sessionOnly: false, query: '' };

/** 'Show all events' (open report outside the filters): every recorded event, so the report's row is listed. */
export const ALL_EVENTS_FILTERS: EventFilters = { ...DEFAULT_FILTERS, window: 'all' };

export const WINDOW_OPTIONS: { value: WindowKey; label: string }[] = [
  { value: '4h', label: 'Last 4 h' },
  { value: 'shift', label: 'Shift' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: 'all', label: 'All' },
];

export const CATEGORY_ORDER: EventCategory[] = ['production', 'quality', 'logistics', 'equipment', 'energy', 'data'];
export const STATUS_ORDER: EventStatus[] = ['active', 'acknowledged', 'investigating', 'resolved'];
export const SEVERITY_ORDER: AlertSeverity[] = ['critical', 'serious', 'warning', 'info'];

/** Time window as plant minutes [from, to] (to = now). */
export function windowRange(key: WindowKey, now: number): { from: number; to: number; label: string } {
  switch (key) {
    case '4h':
      return { from: now - 240, to: now, label: 'last 4 h' };
    case 'shift': {
      const p = resolvePeriod('shift', now);
      return { from: p.from, to: now, label: 'this shift' };
    }
    case '24h':
      return { from: now - 1440, to: now, label: 'last 24 h' };
    case '7d':
      return { from: now - 7 * 1440, to: now, label: 'last 7 days' };
    default:
      return { from: Number.NEGATIVE_INFINITY, to: now, label: 'all recorded' };
  }
}

/** Whether the event's condition overlaps the window (an active event always reaches now). */
export const inWindow = (ev: OpEvent, w: { from: number; to: number }, now: number) => ev.start <= w.to && (ev.end ?? now) >= w.from;

export const matchesStatus = (ev: OpEvent, f: StatusFilter) => f === 'all' || (f === 'open' ? ev.status !== 'resolved' : ev.status === f);

/** Lower-case text an event is searched by. */
export function searchText(ev: OpEvent, vehicleLabel?: (id: string) => string | undefined): string {
  const a = ev.asset;
  const parts: (string | undefined)[] = [ev.id, ev.title, EVENT_TYPE_LABEL[ev.type], EVENT_CATEGORY_LABEL[ev.category], a.equipmentId, a.stationId, a.vehicleId, a.dockId, a.geofenceId, a.zone ? `zone ${a.zone}` : undefined];
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

function passes(ev: OpEvent, f: EventFilters, ctx: Ctx, skip?: 'category' | 'status' | 'severity' | 'condition') {
  if (f.sessionOnly && ev.historical) return false;
  if (!inWindow(ev, windowRange(f.window, ctx.now), ctx.now)) return false;
  if (skip !== 'category' && f.category !== 'all' && ev.category !== f.category) return false;
  if (skip !== 'status' && !matchesStatus(ev, f.status)) return false;
  if (skip !== 'severity' && f.severity !== 'all' && ev.severity !== f.severity) return false;
  if (skip !== 'condition' && f.condition !== 'all' && (f.condition === 'active') !== (ev.end == null)) return false;
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
};

export function facetCounts(events: OpEvent[], f: EventFilters, ctx: Ctx): Facets {
  const out: Facets = {
    category: { all: 0, production: 0, quality: 0, logistics: 0, equipment: 0, energy: 0, data: 0 },
    status: { all: 0, open: 0, active: 0, acknowledged: 0, investigating: 0, resolved: 0 },
    severity: { all: 0, critical: 0, serious: 0, warning: 0, info: 0 },
    condition: { all: 0, active: 0, cleared: 0 },
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
  }
  return out;
}

export const isDefault = (f: EventFilters) => (Object.keys(DEFAULT_FILTERS) as (keyof EventFilters)[]).every((k) => f[k] === DEFAULT_FILTERS[k]);

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
