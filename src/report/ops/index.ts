/**
 * Report builder catalogue: the five report types of Events & Reports › Reports, the scopes each one
 * supports, and the single entry point that builds an operational report model from the state.
 * The incident investigation is the per-event report (src/intel/report.ts buildEventReport).
 */
import { MONITORED_STAGES } from '../../model/plant';
import type { SimState } from '../../sim/engine';
import { REPORT_TYPE_LABEL } from './common';
import { buildFleetReport } from './fleet';
import { OEE_SCOPES, buildOeeReport } from './oee';
import { QUALITY_SCOPES, buildQualityReport } from './quality';
import { buildShiftReport } from './shift';
import type { OpsReport, OpsReportOptions, OpsReportType, ReportScope, ReportType } from './types';

export * from './types';
export { REPORT_TYPE_LABEL } from './common';

export type ReportTypeDef = {
  id: ReportType;
  label: string;
  /** What the report answers. */
  question: string;
  /** What it contains, in a line. */
  contents: string;
  /** Scopes it supports (empty: the report has a fixed scope). */
  scopes: ReportScope[];
  /** Whether a period applies (the incident report covers its event's window). */
  period: boolean;
};

const ALL_STAGES: ReportScope[] = ['line', ...[...MONITORED_STAGES].sort((a, b) => a.step - b.step).map((s) => s.id)];

export const REPORT_TYPES: ReportTypeDef[] = [
  {
    id: 'shift',
    label: REPORT_TYPE_LABEL.shift,
    question: 'Did we make the plan, and what held output back?',
    contents: 'Output vs plan, flow by stage, count reconciliation, stops, significant events, actions.',
    scopes: ALL_STAGES,
    period: true,
  },
  {
    id: 'oee',
    label: REPORT_TYPE_LABEL.oee,
    question: 'Where did capacity go between theoretical and good output?',
    contents: 'Line OEE and its components, capacity losses, stop reasons, machine OEE, loss events.',
    scopes: OEE_SCOPES,
    period: true,
  },
  {
    id: 'quality',
    label: REPORT_TYPE_LABEL.quality,
    question: 'Which defects are we making, and are they rising?',
    contents: 'Inspection KPIs, defects by category and origin, reject-rate trend, stations, quality events with frames.',
    scopes: QUALITY_SCOPES,
    period: true,
  },
  {
    id: 'fleet',
    label: REPORT_TYPE_LABEL.fleet,
    question: 'What is delaying trucks and docks?',
    contents: 'Visit times, dock occupancy, trucks past a limit, delay events and detention estimate.',
    scopes: [],
    period: true,
  },
  {
    id: 'incident',
    label: REPORT_TYPE_LABEL.incident,
    question: 'What happened in one event, why, and what was done?',
    contents: 'The full event record: detection, evidence, impact, estimate, diagnosis, recommendations, lifecycle.',
    scopes: [],
    period: false,
  },
];

export const REPORT_TYPE_BY_ID = Object.fromEntries(REPORT_TYPES.map((t) => [t.id, t])) as Record<ReportType, ReportTypeDef>;

/** The scope a report type will use for a requested scope (falls back to the whole line). */
export function effectiveScope(type: ReportType, scope: ReportScope): ReportScope {
  const def = REPORT_TYPE_BY_ID[type];
  return def.scopes.includes(scope) ? scope : 'line';
}

/** Builds an operational report model (the preview and the PDF render this same object). */
export function buildOpsReport(s: SimState, type: OpsReportType, opts: OpsReportOptions): OpsReport {
  const o = { ...opts, scope: effectiveScope(type, opts.scope ?? 'line') };
  switch (type) {
    case 'shift':
      return buildShiftReport(s, o);
    case 'oee':
      return buildOeeReport(s, o);
    case 'quality':
      return buildQualityReport(s, o);
    case 'fleet':
      return buildFleetReport(s, o);
  }
}
