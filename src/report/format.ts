/**
 * Formatting shared by the in-app event report (src/ui/report) and the PDF export, so both show
 * exactly the same figures and wording for the same report model.
 */
import type { EventCause, EventHistoryEntry, EventValue, Evidence } from '../model/types';
import { formatClock, formatDateTime } from '../sim/time';

/** Money with its currency code; whole units from 1 000 up. */
export function fmtMoney(currency: string, v: number) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const d = abs >= 1000 ? 0 : 2;
  return `${currency} ${v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/** Observed value with its unit ("12.4 mm/s", "Running"). */
export function fmtValue(x: EventValue | null | undefined) {
  if (!x) return '—';
  const v = typeof x.value === 'number' ? x.value.toLocaleString('en-GB', { maximumFractionDigits: Math.abs(x.value) < 10 ? 2 : 1 }) : x.value;
  return x.unit ? `${v} ${x.unit}` : String(v);
}

/** Wall-clock timestamp of the viewer's machine ("11 Oct 2026, 14:02:11 GMT+5"). */
export function wallClock(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
}

export const CONFIDENCE_LABEL: Record<EventCause['confidence'], string> = {
  confirmed: 'Confirmed',
  likely: 'Likely',
  possible: 'Possible',
};
export const CONFIDENCE_HINT: Record<EventCause['confidence'], string> = {
  confirmed: 'Directly observed in signals / records, or a scenario input',
  likely: 'Inference from strongly correlated evidence',
  possible: 'Hypothesis — correlation in time only',
};

export const HISTORY_LABEL: Record<EventHistoryEntry['action'], string> = {
  detected: 'Detected',
  updated: 'Updated',
  escalated: 'Escalated',
  cleared: 'Condition cleared',
  reopened: 'Reopened',
  acknowledged: 'Acknowledged',
  owner: 'Owner set',
  investigating: 'Investigation',
  note: 'Note',
  resolved: 'Resolved',
  report: 'Report exported',
};

/** Label of an evidence kind. */
export const EVIDENCE_KIND_LABEL: Record<Evidence['kind'], string> = {
  'state-transition': 'State transitions',
  'signal-series': 'Signal series',
  'counter-series': 'Counter series',
  'camera-snapshot': 'Camera snapshot',
  'video-ref': 'Video segment',
  'inspection-image': 'Inspection frame',
  'vehicle-timeline': 'Vehicle timeline',
  metrics: 'Measurements',
  'related-events': 'Related events',
};

/** Honesty labels used wherever the corresponding synthetic surface appears. */
export const LABELS = {
  noCameraFrame: 'No camera frame (no stream was playing)',
  illustrativeFrame: 'Illustrative frame · simulated classification — no vision model',
  simulatedConfidence: 'simulated confidence',
  estimate: 'estimate · assumptions shown',
  position: 'simulated position (zone level)',
  copilot: 'rule-based on the current demo state — no language model',
} as const;

/**
 * Where the financial assumptions are edited in the app (FinancePanel). The same place as named by
 * the assumption list of src/sim/finance.ts (assumptionList) — a test keeps the two in step.
 */
export const ASSUMPTIONS_LOCATION = 'Production → Analysis → Assumptions & what-ifs';

/** Plant time of a minute with the day ("Mon 12 Oct 10:42"). */
export const plantTime = (m: number | null | undefined) => (m == null ? '—' : formatDateTime(m));
export const plantClock = (m: number | null | undefined) => (m == null ? '—' : formatClock(m));

/** Axis number format for series of a given magnitude. */
export function axisFormat(max: number) {
  const a = Math.abs(max);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: 0 });
}
