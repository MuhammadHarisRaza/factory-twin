/**
 * Condition monitoring of one asset (moved here from the retired Machine Health page). Pure
 * functions over the shared SimState that use only what the product can observe: the simulated
 * condition-monitoring signals, the rule-based assessment (src/sim/health.ts), downtime records,
 * alerts and maintenance records. The hidden degradation severity / episodes are never read.
 */
import { CircleCheck, Eye, PowerOff, Siren, TriangleAlert, type LucideIcon } from 'lucide-react';
import { REASON_BY_CODE } from '../../model/plant';
import type { Alert, DowntimeEvent, OpEvent } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { HEALTH_BY_ID, expectedTemp, expectedVib, sensorHistory, type HealthAssessment, type HealthLevel, type MaintenanceRecord } from '../../sim/health';
import { formatClock } from '../../sim/time';
import { OP_COLOR_HEX, toneToColor, type Tone } from '../kit/Status';

/**
 * Condition level in the product-wide four-colour scheme (green normal · amber watch / warning ·
 * red alarm · grey not running), always with an icon and a label.
 */
export const LEVEL_META: Record<HealthLevel, { label: string; tone: Tone; icon: LucideIcon; hint: string }> = {
  normal: { label: 'Normal', tone: 'good', icon: CircleCheck, hint: 'Signals within the expected band for the current load' },
  watch: { label: 'Watch', tone: 'warning', icon: Eye, hint: 'Vibration ≥ 1.25× expected for the load, or rising faster than 0.3 mm/s per hour' },
  warning: {
    label: 'Warning',
    tone: 'warning',
    icon: TriangleAlert,
    hint: 'Vibration ≥ 1.6× expected or ≥ 80 % of the alarm limit, or temperature within 5 °C of its alarm limit',
  },
  alarm: { label: 'Alarm', tone: 'critical', icon: Siren, hint: 'Vibration or temperature at or above its alarm limit' },
  offline: { label: 'Not running', tone: 'neutral', icon: PowerOff, hint: 'Not running in the last 60 min — condition not assessed' },
};

export const levelColor = (l: HealthLevel) => OP_COLOR_HEX[toneToColor(LEVEL_META[l].tone)];

/** Concern order: alarm → warning → watch → normal → offline (not assessed). */
export const LEVEL_ORDER: Record<HealthLevel, number> = { alarm: 4, warning: 3, watch: 2, normal: 1, offline: 0 };
export const isAbnormal = (l: HealthLevel) => l === 'watch' || l === 'warning' || l === 'alarm';
/** "Maintenance due soon" threshold (run hours to the next PM). */
export const PM_SOON_H = 100;
/** Condition-based maintenance stop scheduled from the equipment workspace (minutes). */
export const CBM_DURATION_MIN = 45;
/** Prefix of the alerts raised by the condition-monitoring rules (src/sim/health.ts). */
export const CM_ALERT_PREFIX = 'Condition monitoring';

/** What the health score means — shown next to every score. */
export const SCORE_MEANING =
  'Rule-based score from 0 to 100: 100 = vibration at the value expected for the current load; points are deducted for vibration above that expectation, for temperature within 10 °C of its alarm limit and for reaching an alarm limit. It is not a probability of failure.';

export const HONEST_CONDITION = 'Rule-based detection on simulated condition-monitoring signals — no trained model or physical sensors.';

// ── Signals ───────────────────────────────────────────────────────────────────

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
    vibrationExpected: hist.map((r) => expectedVib(a, r.load, r.running)),
    temperature: hist.map((r) => r.temperature),
    temperatureExpected: hist.map((r) => expectedTemp(a, r.load)),
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
 * condition-monitoring alerts, newest first. 'failures' keeps mechanical / electrical stops
 * only; 'all' adds process stops, changeovers and planned stops.
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

/** The asset's condition-abnormal events (the same records as Events & Reports): open ones first, then newest. */
export function conditionEvents(s: SimState, id: string): OpEvent[] {
  return s.events
    .filter((e) => e.type === 'condition-abnormal' && e.asset.equipmentId === id)
    .sort((a, b) => Number(b.status !== 'resolved') - Number(a.status !== 'resolved') || b.start - a.start);
}

export function maintenanceHistory(s: SimState, id: string): MaintenanceRecord[] {
  return s.health.maintenance.filter((m) => m.equipmentId === id).sort((a, b) => b.start - a.start);
}

/** Most recent maintenance of any type that has started (the reference for "runtime since PM"). */
export const lastMaintenance = (records: MaintenanceRecord[], now: number) => records.find((m) => m.start <= now) ?? null;

// ── Condition-based maintenance (scenario input) ─────────────────────────────

export type Gate = { enabled: boolean; reason: string | null };

/** End minute of a condition-based maintenance stop in progress on the asset, if any. */
export const maintenanceUntil = (s: SimState, id: string) => s.health.fixAt[id]?.at ?? null;

/**
 * Whether condition-based maintenance can be scheduled: only when the assessment shows an abnormal
 * condition and no maintenance is already running.
 */
export function maintenanceGate(h: HealthAssessment, until: number | null): Gate {
  if (until != null) return { enabled: false, reason: `Maintenance in progress until ${formatClock(until)}` };
  if (h.level === 'offline') return { enabled: false, reason: 'Not indicated: the asset is not running, so no recent signals confirm a fault' };
  if (h.level === 'normal') return { enabled: false, reason: 'Not indicated: signals are within limits for the current load' };
  return { enabled: true, reason: null };
}

/** ETA to the vibration alarm / trip limit from the 3-h trend; "reached" once past the alarm limit; null without a rising trend. */
export function etaText(h: HealthAssessment, formatH: (h: number) => string) {
  if (h.etaAlarmH == null && h.etaTripH == null) return null;
  return `alarm ${h.etaAlarmH != null ? `in ≈ ${formatH(h.etaAlarmH)}` : 'reached'} · trip ${h.etaTripH != null ? `in ≈ ${formatH(h.etaTripH)}` : '—'}`;
}
