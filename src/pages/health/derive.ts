/**
 * Machine Health page derivations. Pure functions over the shared SimState that use only
 * what the product can observe: the condition-monitoring signals, the rule-based
 * assessment, downtime records, alerts and maintenance records. The hidden degradation
 * severity / episodes are never read here.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { REASON_BY_CODE } from '../../model/plant';
import type { Alert, DowntimeEvent, MachineState } from '../../model/types';
import type { SimState } from '../../sim/engine';
import {
  HEALTH_ASSETS,
  HEALTH_BY_ID,
  assess,
  sensorHistory,
  type HealthAsset,
  type HealthAssessment,
  type HealthLevel,
  type MaintenanceRecord,
} from '../../sim/health';
import { formatClock } from '../../sim/time';

/** Concern order: alarm → warning → watch → normal → offline (not assessed). */
export const LEVEL_ORDER: Record<HealthLevel, number> = { alarm: 4, warning: 3, watch: 2, normal: 1, offline: 0 };
export const isAbnormal = (l: HealthLevel) => l === 'watch' || l === 'warning' || l === 'alarm';
/** "Maintenance due soon" threshold (run hours to the next PM). */
export const PM_SOON_H = 100;
/** Condition-based maintenance stop scheduled from this page (minutes). */
export const CBM_DURATION_MIN = 45;
/** Prefix of the alerts raised by the condition-monitoring rules (src/sim/health.ts). */
export const CM_ALERT_PREFIX = 'Condition monitoring';

export type AssetRow = {
  id: string;
  asset: HealthAsset;
  name: string;
  h: HealthAssessment;
  state: MachineState;
  /** End minute of a condition-based maintenance stop in progress, if any. */
  maintenanceUntil: number | null;
};

/** Worst first: level, then lowest score, then soonest predicted trip, then id. */
export function byConcern(a: AssetRow, b: AssetRow) {
  return (
    LEVEL_ORDER[b.h.level] - LEVEL_ORDER[a.h.level] ||
    a.h.score - b.h.score ||
    (a.h.etaTripH ?? Number.MAX_VALUE) - (b.h.etaTripH ?? Number.MAX_VALUE) ||
    a.id.localeCompare(b.id)
  );
}

export function assetRows(s: SimState): AssetRow[] {
  return HEALTH_ASSETS.map(
    (a): AssetRow => ({
      id: a.id,
      asset: a,
      name: EQUIPMENT_BY_ID[a.id]?.name ?? a.id,
      h: assess(s, a.id),
      state: s.machines[a.id]?.state ?? 'planned',
      maintenanceUntil: s.health.fixAt[a.id]?.at ?? null,
    }),
  ).sort(byConcern);
}

export type FleetSummary = {
  monitored: number;
  notRunning: number;
  alarm: number;
  warning: number;
  watch: number;
  /** Lowest score among assessed (running) assets. */
  lowest: AssetRow | null;
  nextTrip: AssetRow | null;
  pmSoon: AssetRow[];
  nextPm: AssetRow | null;
  inMaintenance: AssetRow[];
};

export function fleetSummary(rows: AssetRow[]): FleetSummary {
  const count = (l: HealthLevel) => rows.filter((r) => r.h.level === l).length;
  const assessed = rows.filter((r) => r.h.level !== 'offline');
  const lowest = [...assessed].sort((a, b) => a.h.score - b.h.score || byConcern(a, b))[0] ?? null;
  const trips = rows.filter((r) => r.h.etaTripH != null).sort((a, b) => a.h.etaTripH! - b.h.etaTripH!);
  const pm = [...rows].sort((a, b) => a.h.pmDueH - b.h.pmDueH);
  return {
    monitored: rows.length,
    notRunning: count('offline'),
    alarm: count('alarm'),
    warning: count('warning'),
    watch: count('watch'),
    lowest,
    nextTrip: trips[0] ?? null,
    pmSoon: pm.filter((r) => r.h.pmDueH < PM_SOON_H),
    nextPm: pm[0] ?? null,
    inMaintenance: rows.filter((r) => r.maintenanceUntil != null),
  };
}

// ── Signals ───────────────────────────────────────────────────────────────────

/**
 * Healthy-baseline expectation for the current load. Mirrors expectedVib / expectedTemp in
 * src/sim/health.ts (not exported there); derive.test.ts checks they stay identical.
 */
export const expectedVibration = (a: HealthAsset, load: number, running: boolean) => (running ? a.vib.full * (0.8 + 0.25 * load) : 0.25);
export const expectedTemperature = (a: HealthAsset, load: number) => 28 + (a.temp.full - 28) * (0.45 + 0.55 * load);

export type SignalSeries = {
  t: number[];
  vibration: number[];
  vibrationExpected: number[];
  temperature: number[];
  temperatureExpected: number[];
  current: number[];
};

/** About the last `hours` hours of 10-min samples, starting on a whole hour so axis ticks land on clock hours. */
export function signalSeries(s: SimState, id: string, hours = 24, step = 10): SignalSeries {
  const a = HEALTH_BY_ID[id];
  const end = Math.max(0, s.minute - 1);
  const start = Math.max(0, Math.floor((end - hours * 60) / 60) * 60);
  const hist = sensorHistory(s, id, end - start, step);
  return {
    t: hist.map((r) => r.t),
    vibration: hist.map((r) => r.vibration),
    vibrationExpected: hist.map((r) => expectedVibration(a, r.load, r.running)),
    temperature: hist.map((r) => r.temperature),
    temperatureExpected: hist.map((r) => expectedTemperature(a, r.load)),
    current: hist.map((r) => r.current),
  };
}

/**
 * Upper bound for a 4-interval y axis starting at `min` so every tick is a round number
 * (the kit LineChart places five ticks evenly between yMin and yMax).
 */
export function niceAxisMax(max: number, min = 0) {
  const raw = Math.max(1e-6, (max - min) / 4);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10].map((m) => m * mag).find((x) => x >= raw - 1e-9) ?? 10 * mag;
  return min + step * 4;
}

// ── Alarm & maintenance history ──────────────────────────────────────────────

export type HistoryScope = 'failures' | 'all';
export type HistoryRow =
  | { kind: 'stop'; key: string; time: number; ev: DowntimeEvent; planned: boolean }
  | { kind: 'alert'; key: string; time: number; alert: Alert; level: HealthLevel };

const FAILURE_CATEGORIES = new Set<string>(['Mechanical', 'Electrical & control']);

/** Level named at the end of a condition-monitoring alert title ("Condition monitoring: C-BM2 warning"). */
export function alertLevel(title: string): HealthLevel {
  const w = title.trim().split(/\s+/).at(-1);
  return w === 'alarm' || w === 'warning' || w === 'watch' ? w : 'watch';
}

/**
 * The asset's own stops (never starved / blocked, which are caused by neighbours) and its
 * condition-monitoring alerts, newest first. 'failures' keeps mechanical / electrical
 * stops only; 'all' adds process stops, changeovers and planned stops.
 */
export function alarmHistory(s: SimState, id: string, scope: HistoryScope): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const ev of s.downtime) {
    if (ev.equipmentId !== id || ev.category === 'Starved' || ev.category === 'Blocked') continue;
    if (scope === 'failures' && !FAILURE_CATEGORIES.has(ev.category)) continue;
    rows.push({ kind: 'stop', key: ev.id, time: ev.start, ev, planned: REASON_BY_CODE[ev.reasonCode]?.planned ?? false });
  }
  for (const al of s.alerts) {
    if (al.equipmentId !== id || !al.title.startsWith(CM_ALERT_PREFIX)) continue;
    rows.push({ kind: 'alert', key: al.id, time: al.time, alert: al, level: alertLevel(al.title) });
  }
  return rows.sort((a, b) => b.time - a.time || (a.kind === b.kind ? 0 : a.kind === 'alert' ? -1 : 1));
}

export function maintenanceHistory(s: SimState, id: string): MaintenanceRecord[] {
  return s.health.maintenance.filter((m) => m.equipmentId === id).sort((a, b) => b.start - a.start);
}

/** Most recent maintenance of any type that has started (the reference for "runtime since PM"). */
export const lastMaintenance = (records: MaintenanceRecord[], now: number) => records.find((m) => m.start <= now) ?? null;

// ── Actions ───────────────────────────────────────────────────────────────────

export type Gate = { enabled: boolean; reason: string | null };

export function maintenanceGate(r: AssetRow): Gate {
  if (r.maintenanceUntil != null) return { enabled: false, reason: `Maintenance in progress until ${formatClock(r.maintenanceUntil)}` };
  if (r.h.level === 'offline') return { enabled: false, reason: 'Maintenance not indicated: not running, so no recent signals confirm a fault' };
  if (r.h.level === 'normal') return { enabled: false, reason: 'Maintenance not indicated: signals are within limits for the current load' };
  return { enabled: true, reason: null };
}

/**
 * `requestedAt`: minute a developing fault was started from this page; it blocks a second
 * one for an hour while the 60-min detection window catches up.
 */
export function faultGate(r: AssetRow, requestedAt: number | null, now: number): Gate {
  if (r.maintenanceUntil != null) return { enabled: false, reason: `Maintenance in progress until ${formatClock(r.maintenanceUntil)}` };
  if (isAbnormal(r.h.level)) return { enabled: false, reason: 'Fault simulation unavailable: the asset already shows an abnormal condition' };
  if (requestedAt != null && now >= requestedAt && now - requestedAt < 60)
    return { enabled: false, reason: `Fault simulation started at ${formatClock(requestedAt)} — waiting for it to show in the signals` };
  return { enabled: true, reason: null };
}

// ── Formatting ────────────────────────────────────────────────────────────────

export const signed = (v: number | null, digits = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`);
