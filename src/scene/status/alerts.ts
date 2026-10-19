/**
 * Alert filter of the 3D model (useTwin.alertFilter): which floating alert markers are drawn.
 * 'all' every marker · 'serious' serious and critical only · 'off' none. Equipment status colours
 * (beacons), the line-constraint outline and the selection are never filtered.
 *
 * A marker's severity is that of the asset's most severe active event record (src/sim/events.ts),
 * so the model filters exactly like the event lists; without an event the state decides
 * (a fault or stop is serious, running below rate or accumulating is a warning, a planned stop is
 * information, a stale data feed is a warning — the severity of its counter-inactivity event).
 */
import type { AlertSeverity, OperationalState } from '../../model/types';
import type { SimState } from '../../sim/engine';
import type { AlertFilter } from '../../store';
import { perVersion } from './model';

const RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

export const alertShown = (filter: AlertFilter, severity: AlertSeverity) =>
  filter === 'all' ? true : filter === 'serious' ? RANK[severity] >= RANK.serious : false;

export const maxSeverity = (a: AlertSeverity | null | undefined, b: AlertSeverity | null | undefined): AlertSeverity | null =>
  a == null ? (b ?? null) : b == null ? a : RANK[a] >= RANK[b] ? a : b;

/** Most severe active (condition still present) event per equipment id, by event category group. */
export type AssetSeverity = { stop: AlertSeverity | null; condition: AlertSeverity | null; data: AlertSeverity | null; any: AlertSeverity | null };

const STOP_TYPES = new Set(['machine-fault', 'machine-stop', 'conveyor-stop', 'below-rate']);

function activeSeverities(s: SimState): Record<string, AssetSeverity> {
  const out: Record<string, AssetSeverity> = {};
  for (const e of s.events) {
    const id = e.asset.equipmentId;
    if (!id || e.end != null || e.status === 'resolved') continue;
    const r = (out[id] ??= { stop: null, condition: null, data: null, any: null });
    if (STOP_TYPES.has(e.type)) r.stop = maxSeverity(r.stop, e.severity);
    else if (e.type === 'condition-abnormal') r.condition = maxSeverity(r.condition, e.severity);
    else if (e.category === 'data') r.data = maxSeverity(r.data, e.severity);
    r.any = maxSeverity(r.any, e.severity);
  }
  return out;
}

/** `activeSeverities`, once per simulated minute. */
export const sharedSeverities = perVersion(activeSeverities);

/** Severity of an operational-state marker when no event record carries one. */
export function stateSeverity(op: OperationalState): AlertSeverity {
  if (op === 'fault' || op === 'stopped') return 'serious';
  if (op === 'planned' || op === 'changeover') return 'info';
  return 'warning';
}

/** Severity of a stop / state marker on an asset: its active stop event, else its state. */
export const stopMarkerSeverity = (sev: AssetSeverity | undefined, op: OperationalState): AlertSeverity =>
  op === 'planned' || op === 'changeover' ? 'info' : (sev?.stop ?? stateSeverity(op));

/** Condition pin: its condition event, else the assessment level (alarm critical · warning serious · watch warning). */
export const conditionSeverity = (sev: AssetSeverity | undefined, level: 'watch' | 'warning' | 'alarm'): AlertSeverity =>
  maxSeverity(sev?.condition, level === 'alarm' ? 'critical' : level === 'warning' ? 'serious' : 'warning')!;

/** Data-stale pin: its data event, else a warning. */
export const staleSeverity = (sev: AssetSeverity | undefined): AlertSeverity => sev?.data ?? 'warning';
