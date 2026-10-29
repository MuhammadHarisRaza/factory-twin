/**
 * Factory Copilot — deterministic, rule-based question answering over the shared simulation state.
 * No language model and no external service is connected: a question is matched to a topic by
 * keywords, and every answer is assembled from the same KPI view models (src/intel/kpis.ts), metrics,
 * events, evidence and report model the seven workspaces show — same functions, same period.
 *
 * Every answer is split into labelled sections so a reader can tell apart
 *   confirmed  — Confirmed facts: read directly from the simulated counters, states and records
 *                (and causes the event engine marks as confirmed),
 *   simulated  — Simulated events: which records the answer uses and where they come from — the
 *                demo simulation's own rules or a scenario the presenter started,
 *   inferred   — Inferred explanation: attributions and explanations from correlated evidence ("Likely: …"),
 *   hypotheses — Unverified hypotheses: possible causes to check, not established by the data ("Possible: …"),
 *   unknown    — what cannot be established from the available data,
 *   estimate   — money / quantity estimates, always with the assumptions used,
 *   actions    — Recommended actions: rule-based standard responses and where to look next,
 *   method     — how the figures were computed.
 * The five core sections (confirmed, simulated, inferred, hypotheses, actions) are always present —
 * a section with nothing to say says so instead of being left out. `text` repeats the sections as
 * plain paragraphs, in order.
 *
 * Context: an event (ctx.eventId, or an event id typed in the question) turns the copilot into an
 * investigation of that one record, read from buildEventReport — the same model as the in-app report
 * and the PDF. The reporting period (ctx.period) is the period of the workspace the question is
 * asked from, so plant-wide figures equal the KPI cards on screen; a period named in the question
 * ("today", "previous shift", …) takes precedence. ctx.equipmentId / ctx.stageId answer "this
 * machine" / "this stage".
 */
import type { WorkspaceId } from '../app/store';
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment';
import {
  CONVEYOR_BY_ID,
  CONVEYOR_IDS,
  DEFECTS,
  DEFECT_ORDER,
  DOCKS,
  GEOFENCES,
  INSPECTION_STATIONS,
  LINE,
  M2_PER_TILE,
  MONITORED_STAGE_BY_ID,
  OPS_BY_ID,
  PROCESS_MACHINES,
  REASON_BY_CODE,
  STAGE_BY_ID,
  TARGET,
} from '../model/plant';
import type { DefectCategory, DowntimeEvent, EventCause, FeedRuntime, MonitoredStageId, OpEvent, OperationalState, QualityInspection } from '../model/types';
import { minuteAt, scenariosActive, type SimState } from '../sim/engine';
import { DEFAULT_TARIFFS, type Tariffs } from '../sim/energy';
import { EVENT_STATUS_LABEL, activeEvents, eventById, eventInMonitoredStage } from '../sim/events';
import { DEFAULT_FINANCE, assumptionList, contributionPerM2, lostOutputValue, rejectCost, type Estimate, type FinanceAssumptions } from '../sim/finance';
import { HEALTH_BY_ID, LEVEL_RANK, assess, formatH, type HealthAssessment } from '../sim/health';
import { phaseLabel, type TruckRuntime } from '../sim/logistics';
import {
  HELD_UP_SHARE,
  OPERATIONAL_STATE_LABEL,
  TARGET_STATUS_LABEL,
  bottleneck,
  capacityBreakdown,
  clippedDuration,
  conveyorMetrics,
  downtimeIn,
  downtimePareto,
  externalVehicles,
  fleetMetrics,
  internalActivity,
  lineMetrics,
  machineMetrics,
  operationalState,
  qualityIn,
  resolvePeriod,
  risingDefects,
  stageIO,
  stageMetrics,
  targetStatus,
  visitDurations,
  type DefectRise,
  type Period,
  type PeriodKey,
} from '../sim/metrics';
import type { Metric, OeeResult } from '../sim/oee';
import { formatClock, formatDateTime, formatDay, formatDuration, toIso } from '../sim/time';
import { DEFECT_ACTIONS, REASON_ACTIONS, healthAssessments, insights, nextActions, type InsightLink } from './insights';
import {
  activeIssuesKpi,
  attentionEvents,
  avgDwellKpi,
  constraintDowntimeKpi,
  defectiveKpi,
  delayedTrucks,
  delayedVehiclesKpi,
  factoryOeeKpi,
  firstPassQualityKpi,
  goodOutputKpi,
  inspectedKpi,
  periodScope,
  rejectRateKpi,
  targetAttainmentKpi,
  topDefectKpi,
  type KpiModel,
} from './kpis';
import { buildEventReport, eventImpact, fpyBefore, type EventReport, type ImpactRow } from './report';
import { constraintClaim, constraintPhrase, type ConstraintClaim } from './summary';

// ── Public types ──────────────────────────────────────────────────────────────

export type CopilotIntent =
  | 'below-target'
  | 'bottleneck'
  | 'oee-losses'
  | 'oee'
  | 'capacity-gap'
  | 'loss-cost'
  | 'largest-downtime'
  | 'machine-downtime'
  | 'conveyor-stop'
  | 'kiln'
  | 'defects'
  | 'defect-report'
  | 'delayed-vehicles'
  | 'turnaround'
  | 'logistics'
  | 'investigate-first'
  | 'next-actions'
  | 'energy'
  | 'process-parameter'
  | 'health'
  | 'machine'
  | 'stage'
  | 'event-what'
  | 'event-why'
  | 'event-impact'
  | 'event-action'
  | 'event-evidence'
  | 'event-missing'
  /** One vehicle named in the question (or selected in the twin): where it is, what it does, its limits. */
  | 'vehicle'
  | 'help';

/** The labelled parts of an answer, in display order. */
export type SectionKind = 'confirmed' | 'simulated' | 'inferred' | 'hypotheses' | 'unknown' | 'estimate' | 'actions' | 'method';
export const SECTION_ORDER: SectionKind[] = ['confirmed', 'simulated', 'inferred', 'hypotheses', 'unknown', 'estimate', 'actions', 'method'];
/** Present in every answer (with an explicit "nothing here" line when empty). */
export const CORE_SECTIONS: SectionKind[] = ['confirmed', 'simulated', 'inferred', 'hypotheses', 'actions'];

export type CopilotSection = { kind: SectionKind; text: string };

/**
 * Where an answer link goes — always one of the seven workspaces: equipment → Factory Twin
 * (selected), vehicle → Factory Twin following it, fleet-vehicle → Fleet & Movement detail,
 * event → Events & Reports, defect → Quality & Defects evidence, stage → Production stage.
 */
export type CopilotLink = InsightLink | { kind: 'fleet-vehicle'; id: string; label: string } | { kind: 'defect'; id: string; label: string };

/** Context the question is asked in. */
export type CopilotContext = {
  /** Event under investigation ("this incident"). */
  eventId?: string | null;
  finance?: FinanceAssumptions;
  /** Reporting period of the workspace the question is asked from (default: the current shift, as the Overview). */
  period?: PeriodKey;
  /** Equipment selected in the Factory Twin ("this machine"). */
  equipmentId?: string | null;
  /** Stage open in Production ("this stage"). */
  stageId?: MonitoredStageId | null;
  /** Vehicle selected in the Factory Twin ("this vehicle / truck / forklift"). */
  vehicleId?: string | null;
};

export type CopilotAnswer = {
  intent: CopilotIntent;
  /** Plain-language answer, one paragraph per section line (the sections, in order). */
  text: string[];
  /** The same answer split into labelled sections (preferred for display). */
  sections: CopilotSection[];
  /** Figures the answer used (label → value), with the KPI cards' labels and formatting. */
  facts: { label: string; value: string }[];
  links: CopilotLink[];
  /** Period the figures refer to. */
  periodLabel: string;
  followUps: string[];
  /** Event the answer is about (event investigation, or the event a plant-wide answer points to first). */
  eventId?: string;
};

/** Titles of the workspaces (as in the navigation, src/app/store.ts WORKSPACES). */
export const WORKSPACE_TITLE: Record<WorkspaceId, string> = {
  overview: 'Overview',
  twin: 'Factory Twin',
  production: 'Production',
  quality: 'Quality & Defects',
  fleet: 'Fleet & Movement',
  events: 'Events & Reports',
  compliance: 'Compliance',
  copilot: 'Copilot',
};

export type QuestionGroupId = 'production' | 'quality' | 'fleet' | 'events';

/** The question about the event in context (with no event selected, the copilot says it cannot tell which). */
export const INCIDENT_QUESTION = 'What happened during this incident?';

/** Suggested questions, grouped by the workspace whose question they answer. */
export const QUESTION_GROUPS: { id: QuestionGroupId; label: string; workspaces: WorkspaceId[]; questions: string[] }[] = [
  {
    id: 'production',
    label: 'Production',
    workspaces: ['overview', 'production', 'twin'],
    questions: ['Why is production below target?', 'Which stage is currently constraining output?', 'What are the main OEE losses this shift?'],
  },
  { id: 'quality', label: 'Quality & Defects', workspaces: ['quality'], questions: ['Which defect category is increasing?'] },
  { id: 'fleet', label: 'Fleet & Movement', workspaces: ['fleet'], questions: ['Which vehicles are delayed?'] },
  { id: 'events', label: 'Incidents', workspaces: ['events'], questions: [INCIDENT_QUESTION, 'Which equipment should be investigated first?'] },
];

export const SUGGESTED_QUESTIONS = QUESTION_GROUPS.flatMap((g) => g.questions);

/** Questions about the event in context (asked with ctx.eventId). */
export const EVENT_QUESTIONS = ['What happened?', 'Why did it happen?', 'What is the impact?', 'What should we do?', 'What evidence is available?'];

/** Event-specific follow-ups that carry the id, so they work without a stored context. */
export const eventQuestionsFor = (id: string) => [
  `What happened in ${id}?`,
  `Why did ${id} happen?`,
  `What is the impact of ${id}?`,
  `What should we do about ${id}?`,
  `What evidence is available for ${id}?`,
];

// ── Formatting ────────────────────────────────────────────────────────────────

const pct = (f: number | null | undefined, d = 1) => (f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(d)} %`);
const int = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-GB'));
/** Tiles → "1,234 m²". */
const m2 = (tiles: number) => `${Math.round(tiles * M2_PER_TILE).toLocaleString('en-GB')} m²`;
/** Area already in m² → "1,234 m²". */
const area = (v: number) => `${Math.round(v).toLocaleString('en-GB')} m²`;
const money = (currency: string, v: number) => `${currency} ${Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-GB') : v.toFixed(2)}`;
const clock = formatClock;
/** Clock time, with the day when it is not the current plant day. */
const when = (s: SimState, t: number) => (Math.floor(t / 1440) === Math.floor(s.minute / 1440) ? clock(t) : formatDateTime(t));
/** Sentences joined into one, without doubled full stops. */
const joinSentences = (xs: string[]) => xs.map((x) => x.trim().replace(/\.$/, '')).join('; ');
const cap1 = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const low1 = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
const dot = (x: string) => (/[.!?]$/.test(x.trim()) ? x.trim() : `${x.trim()}.`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const has = (q: string, words: string[]) => words.some((w) => q.includes(w));
/** A period label inside a sentence: "Today (since 06:00)" → "today (since 06:00)". */
const inPeriod = (label: string) => (/^last /i.test(label) ? `the ${low1(label)}` : low1(label));
/**
 * The period as the KPI cards scope it: a shift that is still running reads "Shift A · 06:00–10:30 (to date)"
 * (periodScope), never its full-shift label, so to-date figures and a pro-rata plan are not read as the
 * whole shift's. Rolling windows ("Last 7 days", "Today (since 06:00)") and completed shifts keep their label.
 */
const periodText = (s: SimState, p: Period) => (p.to >= s.minute && /\d\d:\d\d–\d\d:\d\d$/.test(p.label) ? periodScope(s, p) : p.label);
const nameOf = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;

/** An operational state in a sentence ("is running", "is in fault"), in the words of OPERATIONAL_STATE_LABEL. */
const stateIs = (op: OperationalState) =>
  op === 'fault' ? 'in fault' : op === 'planned' ? 'in a planned stop' : op === 'changeover' ? 'in a product changeover' : op === 'unknown' ? 'in an unknown state' : low1(OPERATIONAL_STATE_LABEL[op]);
/** The asset's data feed when it is stale — its state is then unknown — else null. */
const staleFeed = (s: SimState, id: string): FeedRuntime | null => (s.feeds[id]?.status === 'stale' ? s.feeds[id] : null);
/** "state unknown — data feed stale since 10:50 (last value: running)". */
const staleState = (s: SimState, f: FeedRuntime) => `state unknown — data feed stale since ${when(s, f.since)}${f.lastState ? ` (last value: ${stateWord(f.lastState)})` : ''}`;

// Constraint wording: ONE source, the Overview's graded claim (constraintClaim / constraintPhrase in
// src/intel/summary.ts). "Currently constraining output" only when the claim says so; otherwise the
// kiln is the modeled design constraint, and nothing beyond that when its state is unknown.

/** The kiln was held up and the trace ended at another stage. */
const isTraced = (c: ConstraintClaim) => c.kind === 'starving' || c.kind === 'blocking';
/** The confirmed constraint sentence. */
const constraintFact = (c: ConstraintClaim) => dot(cap1(constraintPhrase(c)));
/** The inferred explanation that goes with the claim (null when nothing can be inferred). */
function constraintInference(c: ConstraintClaim): string | null {
  switch (c.kind) {
    case 'design':
      return likely('the kiln limits the line as designed — line output is set by its own rate and stops', `the kiln was neither starved nor blocked more than ${pct(HELD_UP_SHARE, 0)} of ${c.window}`);
    case 'starving':
      return likely(`${c.name.toLowerCase()} constrains output: it is the first stage upstream of the kiln that was not itself waiting for material`, 'traced upstream from the starved kiln through the stage state shares');
    case 'blocking':
      return likely(`${c.name.toLowerCase()} constrains output: it cannot take the kiln's output, so the kiln is blocked`, 'traced downstream from the blocked kiln through the stage state shares');
    case 'kiln-stopped':
      return likely('every minute the kiln is stopped is line output lost', "the kiln is the line's design constraint");
    case 'kiln-slow':
      return likely("line output is limited by the kiln's reduced rate", "the kiln is the line's design constraint");
    default:
      return null;
  }
}
/** What cannot be said about the constraint while the kiln feed is stale. */
function constraintUnknown(s: SimState, c: ConstraintClaim): string | null {
  if (c.kind !== 'kiln-unknown') return null;
  const f = staleFeed(s, 'H-KILN');
  return `Whether any stage is constraining output now cannot be established: the kiln data feed is stale${f ? ` since ${when(s, f.since)}` : ''}, so the kiln's current state is unknown — only the modeled design constraint is stated.`;
}

// Stale data feeds (one rule for every surface): a figure that rests on a feed which stopped updating keeps
// the simulation's running accounting — the same number as the KPI card — and carries the card's mark
// "Not confirmed · <asset> data stale since hh:mm". A sentence never states such a figure as a fact: it
// goes under "Cannot be established", starting "Not confirmed by the feed (…)". The mark is read from the
// KPI models' provenance (src/intel/kpis.ts: kiln → availability, performance and kiln minutes; sorting →
// output, attainment and quality), so the copilot and the cards name the same feed and the same time.

/** The stale-feed mark a KPI carries ("kiln data stale since 10:30"), or null when its feed confirmed it. */
const staleOf = (k: KpiModel): string | null => (k.provenance === 'stale' ? (k.status?.label.replace(/^Not confirmed · /, '') ?? 'data feed stale') : null);
/** The method line that goes with a not-confirmed figure. */
const STALE_METHOD = " A figure on a stale data feed keeps the simulation's running accounting (the KPI card's value) and is marked not confirmed, as on the card.";
/** A sentence on figures a stale feed has not confirmed (for the "Cannot be established" section). */
const notConfirmed = (mark: string, text: string) => `Not confirmed by the feed (${mark}): ${low1(text.trim())}`;
/** A value with its stale mark, for a facts row: "91.0 % (not confirmed — kiln data stale since 10:30)". */
const marked = (value: string, mark: string | null) => (mark ? `${value} (not confirmed — ${mark})` : value);
/** A basis that rests on a stale feed says so. */
const staleBasis = (basis: string, mark: string | null) => (mark ? `${basis} (includes simulated values the feed has not confirmed: ${mark})` : basis);

/** A KPI card's value as the card shows it ("5,432 m²", "77.2 %"), or why it is unavailable. */
const kv = (k: KpiModel) => (k.unavailable ? `unavailable — ${low1(k.unavailable.replace(/\.$/, ''))}` : `${k.display}${k.unit ? ` ${k.unit}` : ''}`);
/** The same for a facts row, with the card's stale mark. */
const kvFact = (k: KpiModel) => (k.unavailable ? 'Unavailable' : marked(`${k.display}${k.unit ? ` ${k.unit}` : ''}`, staleOf(k)));
/** The plan in the Good output card's words, split for a facts row: ["Plan to date", "1,782 m² · shift 3,168 m²"] or ["Plan", "1,782 m²"]. */
function planParts(target: string): [string, string] {
  const m = /^(Plan(?: to date)?) (.+)$/.exec(target);
  return m ? [m[1], m[2]] : ['Plan', target];
}

/** Metric value, or why it is not available (never a misleading number). */
const metricPct = (m: Metric, d = 1) => (m.status === 'ok' ? pct(m.value, d) : m.status === 'invalid' ? `invalid (${m.issue ?? 'inconsistent inputs'})` : `unavailable${m.issue ? ` (${low1(m.issue)})` : ''}`);

const CONF: Record<EventCause['confidence'], string> = { confirmed: 'Confirmed', likely: 'Likely', possible: 'Possible' };
/** A statement with its confidence and, where there is one, its basis: "Likely: … — basis." */
const inf = (confidence: EventCause['confidence'], text: string, basis?: string) => dot(`${CONF[confidence]}: ${text.replace(/\.$/, '')}${basis ? ` — ${basis.replace(/\.$/, '')}` : ''}`);
/** Inferred explanation (from correlated evidence). */
const likely = (text: string, basis?: string) => inf('likely', text, basis);
/** Unverified hypothesis (to check). */
const possible = (text: string, basis?: string) => inf('possible', text, basis);
const fmtCause = (c: EventCause) => inf(c.confidence, `${c.text}${c.relatedEventId ? ` (see ${c.relatedEventId})` : ''}`, c.basis);

/** Event causes routed by their confidence: confirmed → facts, likely → inferred, possible → hypotheses. */
function causeParts(causes: EventCause[], max = 3) {
  const out = { confirmed: [] as string[], inferred: [] as string[], hypotheses: [] as string[] };
  for (const c of causes.slice(0, max)) {
    const t = fmtCause(c);
    if (c.confidence === 'confirmed') out.confirmed.push(t);
    else if (c.confidence === 'likely') out.inferred.push(t);
    else out.hypotheses.push(t);
  }
  return out;
}

/** Basis of an inferred kiln attribution (the event engine links kiln starvation / blockage to its root event). */
const KILN_ATTRIBUTION = 'kiln hold-up minutes attributed to the event by the event engine (inferred from machine states and buffer levels)';
/**
 * Kiln minutes of an event are an observation only when the event is the kiln's own condition (its stop,
 * starvation, blockage or rate); for any other asset they are an attribution, i.e. an inference.
 */
const ownsKiln = (e: OpEvent) => e.asset.equipmentId === 'H-KILN';

/**
 * Minutes the kiln was down, starved or blocked in [from, to), read from its per-minute state log —
 * an observation, independent of any attribution. null when the log (last LOG_MIN minutes) does not cover the window.
 */
function kilnHeldMinutes(s: SimState, from: number, to: number): number | null {
  let n = 0;
  for (let m = from; m < to; m++) {
    const x = minuteAt(s, 'H-KILN', m);
    if (!x) return null;
    if (x.state === 'down' || x.state === 'starved' || x.state === 'blocked') n++;
  }
  return n;
}

/**
 * How a reject record was produced: tunnel (vision) records carry a simulated classification confidence;
 * gauge records are laser measurements checked against a tolerance — no classification, no confidence.
 */
const isGaugeRecord = (r: Pick<QualityInspection, 'stationId'>) => r.stationId === 'ST-GAUGE';
const recordBasis = (r: QualityInspection) =>
  isGaugeRecord(r)
    ? `, simulated gauge measurement${r.measurement ? `: ${r.measurement}` : ''}`
    : `${r.confidence != null ? `, simulated confidence ${pct(r.confidence, 0)}` : ''}${r.measurement ? `, ${r.measurement}` : ''}`;
/** Method note for the records an answer cites (vision classifications vs gauge measurements). */
function recordMethod(recs: Pick<QualityInspection, 'stationId'>[], fallbackStation?: string | null) {
  const gauge = recs.length ? recs.some(isGaugeRecord) : fallbackStation === 'ST-GAUGE';
  const vision = recs.length ? recs.some((r) => !isGaugeRecord(r)) : fallbackStation !== 'ST-GAUGE';
  return [
    vision ? 'Inspection frames are illustrative — simulated classification (SIM-CV v0, simulated), no vision model; confidence values are simulated.' : null,
    gauge ? 'Gauge records are simulated laser measurements checked against a tolerance — not classifications, so they carry no confidence.' : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Monitored stage (Production) for a process stage id (decoration → glazing, palletising → packing). */
export function monitoredStage(id: string | null | undefined): MonitoredStageId | null {
  if (!id) return null;
  const map: Record<string, MonitoredStageId> = { DECOR: 'GLAZE', PAL: 'PACK' };
  const m = (map[id] ?? id) as MonitoredStageId;
  return MONITORED_STAGE_BY_ID[m] ? m : null;
}

/** Equipment an event is about (an inspection station counts as its equipment). */
const equipmentOf = (e: OpEvent): string | null => e.asset.equipmentId ?? INSPECTION_STATIONS.find((st) => st.id === e.asset.stationId)?.equipmentId ?? null;
const vehicleLabel = (s: SimState, id: string) => s.logistics.vehicles[id]?.label ?? id;
/** Short description of what an event affects. */
function assetText(s: SimState, e: OpEvent) {
  if (e.asset.vehicleId) return `vehicle ${vehicleLabel(s, e.asset.vehicleId)}`;
  const eq = equipmentOf(e);
  if (eq) return `${eq} (${nameOf(eq)})`;
  if (e.asset.dockId) return DOCKS.find((d) => d.id === e.asset.dockId)?.name ?? e.asset.dockId;
  if (e.asset.zone) return `zone ${e.asset.zone}`;
  return 'the line';
}

// ── Links (the seven workspaces only) ─────────────────────────────────────────

const wsLink = (id: Exclude<WorkspaceId, 'twin' | 'copilot'>): CopilotLink => ({ kind: 'workspace', id, label: `Open ${WORKSPACE_TITLE[id]}` });
const stageLink = (id: string | null | undefined): CopilotLink[] => {
  const m = monitoredStage(id);
  return m ? [{ kind: 'stage', id: m, label: `Production · ${MONITORED_STAGE_BY_ID[m].name}` }] : [];
};
const equipmentLink = (id: string | null | undefined): CopilotLink[] => (id && EQUIPMENT_BY_ID[id] ? [{ kind: 'equipment', id, label: `Factory Twin · ${id}` }] : []);
const eventLink = (ev: { id: string }): CopilotLink => ({ kind: 'event', id: ev.id, label: `Events & Reports · ${ev.id}` });
const defectLink = (ev: { id: string }): CopilotLink => ({ kind: 'defect', id: ev.id, label: `Quality & Defects · ${ev.id}` });
const fleetLink = (s: SimState, id: string): CopilotLink => ({ kind: 'fleet-vehicle', id, label: `Fleet & Movement · ${vehicleLabel(s, id)}` });
/** The record links of an event: its report, its defect evidence (quality), the affected asset. */
function eventLinks(s: SimState, ev: OpEvent): CopilotLink[] {
  return [eventLink(ev), ...(ev.category === 'quality' ? [defectLink(ev)] : []), ...assetLinks(s, ev)];
}
function assetLinks(s: SimState, ev: OpEvent): CopilotLink[] {
  if (ev.asset.vehicleId) return [fleetLink(s, ev.asset.vehicleId)];
  return equipmentLink(equipmentOf(ev));
}

/** Which of the finance assumptions an estimate relies on, as one "Assumptions: …" paragraph. */
function assumptionsText(f: FinanceAssumptions, kinds: ('output' | 'reject' | 'wait')[]) {
  const all = assumptionList(f);
  const pick =
    all.length === 5
      ? [...(kinds.includes('output') ? [all[0], all[1]] : []), ...(kinds.includes('reject') ? [all[2]] : []), ...(kinds.includes('wait') ? [all[3]] : []), all[4]]
      : all;
  return `Assumptions: ${pick.join(' ')}`;
}

/** Money lines of an event estimate as sentences. */
const estimateLines = (e: Estimate) => e.lines.filter((l) => l.amount > 0.005).map((l) => `${l.label}: ${money(e.currency, l.amount)} (${l.basis})`);

/** Line OEE as an equation with values; '≈' when the rounded factors do not multiply to the rounded OEE. */
function oeeEquation(o: OeeResult) {
  const parts = [o.availability, o.performance, o.quality, o.oee];
  if (parts.some((m) => m.status !== 'ok' || m.value == null))
    return `${metricPct(o.oee)} (availability ${metricPct(o.availability)}, performance ${metricPct(o.performance)}, quality ${metricPct(o.quality)})`;
  const shown = (v: number) => Number((v * 100).toFixed(1)) / 100;
  const prod = shown(o.availability.value!) * shown(o.performance.value!) * shown(o.quality.value!);
  const eq = (prod * 100).toFixed(1) === (o.oee.value! * 100).toFixed(1) ? '=' : '≈';
  return `${pct(o.oee.value)} ${eq} availability ${pct(o.availability.value)} × performance ${pct(o.performance.value)} × quality ${pct(o.quality.value)}${eq === '≈' ? ' (factors rounded to one decimal)' : ''}`;
}

const isUnplanned = (d: DowntimeEvent) => d.category !== 'Planned' && d.category !== 'Starved' && d.category !== 'Blocked' && !REASON_BY_CODE[d.reasonCode]?.planned;

// ── Provenance of the records an answer uses ─────────────────────────────────

/** Where an event record comes from: a presenter scenario, or the simulation's own rules. */
function eventOrigin(s: SimState, e: OpEvent) {
  const cons = e.consequenceOf ? `, a consequence of ${e.consequenceOf}` : '';
  if (e.source === 'scenario') {
    const sc = e.refs.scenarioId ? s.scenarios.find((x) => x.id === e.refs.scenarioId) : undefined;
    return `scenario-caused — started by the scenario “${sc ? sc.label : 'presenter scenario'}”${sc ? ` at ${when(s, sc.start)}` : ''}${cons}`;
  }
  return e.historical
    ? `simulated — pre-rolled demo history, raised by the simulation's own rules${cons}`
    : `simulated — raised by the simulation's own event rules, not by a scenario${cons}`;
}

/** The "Simulated events" section: the data source, the records used and the scenarios in effect. */
function simulatedLines(s: SimState, records: (OpEvent | null | undefined)[], extra: string[]): string[] {
  const out = ['All figures and records here are generated by the demo simulation of a representative plant — none is measured plant data.'];
  // One line per origin: a single record with its title, several as a list of ids.
  const seen = new Set<string>();
  const groups = new Map<string, OpEvent[]>();
  for (const e of records) {
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    const o = eventOrigin(s, e);
    groups.set(o, [...(groups.get(o) ?? []), e]);
  }
  for (const [origin, evs] of [...groups.entries()].slice(0, 4))
    out.push(
      evs.length === 1
        ? `${evs[0].id} (${evs[0].title}) — ${origin}.`
        : `${evs.slice(0, 4).map((e) => e.id).join(', ')}${evs.length > 4 ? ` +${evs.length - 4} more` : ''} (${evs.length} events) — ${origin}.`,
    );
  out.push(...extra);
  const active = scenariosActive(s);
  out.push(
    active.length
      ? `Scenarios in effect now: ${active
          .slice(0, 3)
          .map((sc) => `${sc.label} (since ${when(s, sc.start)})`)
          .join('; ')}${active.length > 3 ? ` +${active.length - 3} more` : ''} — they change the simulated state these figures come from.`
      : 'No scenario is in effect now — the figures reflect the seeded demo simulation only.',
  );
  return out;
}

/** Unplanned stops of the period that a scenario injected (versus the simulation's own stops). */
function scenarioStops(s: SimState, p: Period): string | null {
  const ds = downtimeIn(s, p).filter((d) => d.source === 'scenario' && isUnplanned(d));
  if (!ds.length) return null;
  const min = ds.reduce((a, d) => a + clippedDuration(d, p, s.minute), 0);
  const ids = [...new Set(ds.map((d) => d.equipmentId))];
  return `${plural(ds.length, 'unplanned stop')} in ${inPeriod(periodText(s, p))} (${int(min)} min, on ${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ` +${ids.length - 4}` : ''}) ${ds.length === 1 ? 'was' : 'were'} injected by a scenario; every other stop comes from the simulation itself.`;
}

// ── Composition ───────────────────────────────────────────────────────────────

/**
 * Texts that come from shared models (assumption lists, rule texts) may still name a page of an earlier
 * release; answers always use the current workspace names.
 */
const RETIRED_NAMES: [RegExp, string][] = [
  [/OEE & Loss Intelligence/g, 'Production'],
  [/OEE & Loss\b/g, 'Production'],
  [/Energy Intelligence/g, 'the financial assumptions'],
  [/Command Center/g, 'Overview'],
  [/Production Monitoring/g, 'Production'],
  [/AI Defect Monitoring/g, 'Quality & Defects'],
  [/Vehicle Monitoring/g, 'Fleet & Movement'],
  [/Machine Health/g, 'Factory Twin'],
  [/Assets & Data/g, 'Factory Twin'],
  [/Scenario Simulator/g, 'Scenarios panel'],
];
const currentNames = (x: string) => RETIRED_NAMES.reduce((a, [re, to]) => a.replace(re, to), x);

type Lines = (string | false | null | undefined)[];
type Parts = Partial<Record<SectionKind, Lines>>;
type Extra = { facts?: CopilotAnswer['facts']; links?: CopilotLink[]; followUps?: string[]; eventId?: string; records?: (OpEvent | null | undefined)[] };

/** What an empty core section says (so every answer shows all five labels). */
export const EMPTY_SECTION_LINE: Partial<Record<SectionKind, string>> = {
  confirmed: 'No record in the data answers this question.',
  inferred: 'Nothing is inferred — the answer reports counted values and records only.',
  hypotheses: 'No unverified hypothesis is offered for this question.',
  actions: 'No action follows from the data for this question.',
};

function compose(c: Ctx, intent: CopilotIntent, periodLabel: string, parts: Parts, extra: Extra = {}): CopilotAnswer {
  const take = (xs?: Lines) => (xs ?? []).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map(currentNames);
  const lines = Object.fromEntries(SECTION_ORDER.map((k) => [k, k === 'simulated' ? simulatedLines(c.s, extra.records ?? [], take(parts.simulated)) : take(parts[k])])) as Record<SectionKind, string[]>;
  for (const k of CORE_SECTIONS) if (!lines[k].length) lines[k] = [EMPTY_SECTION_LINE[k]!];
  const sections: CopilotSection[] = SECTION_ORDER.flatMap((kind) => lines[kind].map((text) => ({ kind, text })));
  const seen = new Set<string>();
  const links = (extra.links ?? [])
    // Workspace links carry the workspace's current name; nothing links to a retired page or back to the copilot.
    .filter((l) => l.kind !== 'workspace' || (l.id in WORKSPACE_TITLE && l.id !== 'copilot'))
    .map((l) => (l.kind === 'workspace' ? { ...l, label: `Open ${WORKSPACE_TITLE[l.id]}` } : l))
    .filter((l) => {
      const k = `${l.kind}:${l.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return {
    intent,
    periodLabel,
    text: sections.map((x) => x.text),
    sections,
    facts: extra.facts ?? [],
    links: links.slice(0, 6),
    followUps: (extra.followUps ?? []).slice(0, 4),
    ...(extra.eventId ? { eventId: extra.eventId } : {}),
  };
}

type Ctx = {
  s: SimState;
  tariffs: Tariffs;
  finance: FinanceAssumptions;
  eventId: string | null;
  equipmentId: string | null;
  stageId: MonitoredStageId | null;
  vehicleId: string | null;
};

// ── Question understanding ────────────────────────────────────────────────────

const VEHICLE_WORDS = ['vehicle', 'truck', 'lorr', 'fleet', 'driver', 'dock', 'forklift', 'dispatch', 'deliver', 'yard', 'carrier'];
/** "this incident" with no event in context. */
const NAMES_INCIDENT = /\b(this|that|the current|the selected) (event|incident|alarm|issue|fault|stoppage|record)\b|\bincident\b/;

function classify(q: string): CopilotIntent {
  if (/\b(energy|kwh|gas|electricity|power consumption|fuel|co2|co₂|carbon|emissions?)\b/.test(q)) return 'energy';
  if (/\b(temperature|moisture|humidity|pressure|viscosity|density)\b/.test(q) && !has(q, ['vibration', 'bearing', 'health', 'condition', 'at risk'])) return 'process-parameter';
  if (NAMES_INCIDENT.test(q) && !/\bwhich\b/.test(q)) return 'event-missing';
  if (has(q, ['investigat', 'look at first', 'check first', 'most urgent', 'first priority']) || /\bfirst\b/.test(q)) return 'investigate-first';
  if (has(q, ['supervisor', 'what should', 'next step', 'next action', 'do next', 'recommend', 'priorit'])) return 'next-actions';
  if (has(q, ['delay', 'late', 'stuck', 'overdue', 'waiting', 'queue', 'held up']) && has(q, VEHICLE_WORDS)) return 'delayed-vehicles';
  if (has(q, ['turnaround', 'turn-around', 'on site too long', 'over the threshold', 'exceeded'])) return 'turnaround';
  if (has(q, ['conveyor', 'belt', 'roller transfer'])) return 'conveyor-stop';
  if (has(q, ['cost', 'money', 'financial', 'worth', 'value of', 'revenue', '$', 'usd']) && has(q, ['loss', 'lost', 'losing', 'production', 'downtime', 'stop'])) return 'loss-cost';
  if (has(q, ['theoretical', 'design capacity', 'capacity gap', 'prevent', 'maximum output', 'full capacity', 'design rate'])) return 'capacity-gap';
  if (has(q, ['oee']) && has(q, ['loss', 'losing', 'lost', 'main', 'biggest', 'largest', 'driver', 'why', 'breakdown', 'low'])) return 'oee-losses';
  if (has(q, ['oee', 'calculated', 'calculat', 'availability', 'effectiveness']) || /\bperformance\b/.test(q)) return 'oee';
  if (has(q, ['bottleneck', 'constrain', 'limiting', 'slowest', 'holding back', 'limits output', 'limits the line'])) return 'bottleneck';
  const defectWord = has(q, ['defect', 'reject', 'quality', 'scrap', 'crack', 'glaze', 'shade', 'chip', 'surface', 'planarity', 'caliber', 'inspection']);
  if (defectWord && has(q, ['report', 'evidence', 'image', 'frame', 'record', 'picture', 'photo', 'snapshot', 'show'])) return 'defect-report';
  if (defectWord) return 'defects';
  if (has(q, ['health', 'vibration', 'maintenance', 'failure', 'fail', 'predict', 'bearing', 'at risk'])) return 'health';
  if (has(q, ['which machine', 'what machine', 'which asset', 'which equipment', 'machine has', 'machine with']) && has(q, ['downtime', 'stop', 'loss', 'lost', 'down'])) return 'machine-downtime';
  if (has(q, ['kiln', 'firing'])) return 'kiln';
  if (has(q, VEHICLE_WORDS) || has(q, ['logistic'])) return 'logistics';
  if (has(q, ['downtime', 'stoppage', 'stopped', 'loss', 'losing', 'breakdown'])) return 'largest-downtime';
  if (has(q, ['below target', 'behind', 'target', 'short', 'output', 'production'])) return 'below-target';
  return 'help';
}

type EventSub = 'what' | 'why' | 'impact' | 'action' | 'evidence';

/** What an event question asks for, or null when it is not phrased as one. */
function eventSub(q: string): EventSub | null {
  if (has(q, ['evidence', 'proof', 'missing', 'camera', 'snapshot', 'image', 'frame', 'video', 'what do we know'])) return 'evidence';
  if (has(q, ['impact', 'cost', 'loss', 'lost', 'how much', 'affect', 'consequence', 'money'])) return 'impact';
  if (/what (should|can|do|must) (i|we|you)\b/.test(q) || has(q, ['what to do', 'recommend', 'action', 'next step', 'fix', 'resolve', 'respond', 'response'])) return 'action';
  if (/\bwhy\b/.test(q) || has(q, ['cause', 'reason', 'root'])) return 'why';
  if (has(q, ['what happened', 'happen', 'summar', 'explain', 'describe', 'tell me', 'overview', 'status', 'investigat', 'detail'])) return 'what';
  return null;
}

/** Questions about the whole plant, which stay plant-wide even while an event is in context. */
const FACTORY_WIDE =
  /\b(which|supervisor|factory|plant|today|shift|theoretical|oee|bottleneck|constrain\w*|target|production|latest|most recent|recently|trucks|vehicles|conveyors|machines|categor(y|ies))\b/;
/** Phrases that refer to the event in context. */
const REFERS = /\b(this|that|the) (event|stop|stoppage|fault|alarm|issue|incident|record|truck|delay)\b|\bit\b/;
/** Phrases that refer to the equipment in context. */
const REFERS_ASSET = /\b(this|that|the selected) (machine|equipment|asset|conveyor|press|mill|dryer|kiln|unit)\b/;
/** Phrases that refer to the stage in context. */
const REFERS_STAGE = /\b(this|that|the selected) stage\b/;

/** Normalised event id typed in the question ("ev-12" → "EV-00012"). */
function eventIdIn(q: string): string | null {
  const m = /\bev-(\d{1,6})\b/i.exec(q);
  return m ? `EV-${m[1].padStart(5, '0')}` : null;
}

/** Finds an equipment item mentioned by id or (part of) its name. */
function findMachine(q: string) {
  const byId = EQUIPMENT.find((e) => q.includes(e.id.toLowerCase()));
  if (byId) return byId.id;
  const aliases: [RegExp, string][] = [
    [/press(?:\s*#?\s*)1\b/, 'E-PRS1'],
    [/press(?:\s*#?\s*)2\b/, 'E-PRS2'],
    [/press(?:\s*#?\s*)3\b/, 'E-PRS3'],
    [/mill(?:\s*#?\s*)1\b/, 'C-BM1'],
    [/mill(?:\s*#?\s*)2\b/, 'C-BM2'],
    [/mill(?:\s*#?\s*)3\b/, 'C-BM3'],
    [/spray dryer|atomi[sz]er/, 'D-TWR'],
    [/roller dryer|\bdryer\b/, 'F-DRY'],
    [/inkjet|printer/, 'G-INK'],
    [/glaz(e|ing) line/, 'G-LINE'],
    [/palleti[sz]er|robot/, 'J-PAL'],
    [/sorter|sorting machine/, 'I-SORT'],
  ];
  for (const [re, id] of aliases) if (re.test(q)) return id;
  return null;
}

/** A vehicle named by its id or label in the question ("fl-02", "trk-1042"), if any. */
function findVehicle(s: SimState, q: string): string | null {
  for (const v of Object.values(s.logistics.vehicles)) {
    for (const name of [v.id, v.label]) {
      const n = name.toLowerCase();
      const i = q.indexOf(n);
      if (i >= 0 && !/[a-z0-9]/.test(q.charAt(i + n.length)) && (i === 0 || !/[a-z0-9]/.test(q.charAt(i - 1)))) return v.id;
    }
  }
  return null;
}

/** Phrases that refer to the vehicle in context. */
const REFERS_VEHICLE = /\b(this|that|the selected) (vehicle|truck|lorry|tipper|forklift|loader)\b/;

/** Monitored stage named in a "… stage" question, if any. */
function findStage(q: string): MonitoredStageId | null {
  if (!/\bstage\b/.test(q)) return null;
  const words: [MonitoredStageId, string[]][] = [
    ['PREP', ['preparation', 'milling', 'raw material']],
    ['SPRAY', ['spray', 'powder']],
    ['PRESS', ['press', 'forming']],
    ['DRY', ['drying', 'dryer']],
    ['GLAZE', ['glaz', 'decorat']],
    ['KILN', ['kiln', 'firing']],
    ['SORT', ['sorting', 'inspection']],
    ['PACK', ['pack', 'palleti']],
    ['WH', ['warehouse']],
  ];
  for (const [id, ws] of words) if (MONITORED_STAGE_BY_ID[id] && has(q, ws)) return id;
  return null;
}

/** Defect category named in the question, if any. */
function findDefect(q: string): DefectCategory | null {
  for (const d of DEFECT_ORDER) if (q.includes(d) || q.includes(DEFECTS[d].label.toLowerCase())) return d;
  if (q.includes('caliber') || q.includes('dimensional')) return 'dimension';
  if (q.includes('edge')) return 'chip';
  if (q.includes('colour') || q.includes('color')) return 'shade';
  return null;
}

/** Period named in the question, else the period of the workspace the question is asked from. */
function periodFor(q: string, fallback: PeriodKey): PeriodKey {
  if (q.includes('previous shift') || q.includes('last shift')) return 'prev-shift';
  if (q.includes('today')) return 'today';
  if (q.includes('week') || q.includes('7 day')) return '7d';
  if (/\b24\s?h|\b24 hours|last day\b/.test(q)) return '24h';
  if (/\bshift\b/.test(q)) return 'shift';
  return fallback;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function ask(s: SimState, question: string, tariffs: Tariffs = DEFAULT_TARIFFS, ctx: CopilotContext = {}): CopilotAnswer {
  const q = question.toLowerCase().trim();
  const c: Ctx = {
    s,
    tariffs,
    finance: ctx.finance ?? DEFAULT_FINANCE,
    eventId: ctx.eventId ?? null,
    equipmentId: ctx.equipmentId && EQUIPMENT_BY_ID[ctx.equipmentId] ? ctx.equipmentId : null,
    stageId: ctx.stageId && MONITORED_STAGE_BY_ID[ctx.stageId] ? ctx.stageId : null,
    vehicleId: ctx.vehicleId && s.logistics.vehicles[ctx.vehicleId] ? ctx.vehicleId : null,
  };
  const p = resolvePeriod(periodFor(q, ctx.period ?? 'shift'), s.minute);

  // Event investigation: an id in the question, or the event in context when the question is about it.
  const typed = eventIdIn(q);
  if (typed) return eventAnswer(c, typed, eventSub(q) ?? 'what');
  const base = classify(q);
  const machine = findMachine(q);
  const ctxEv = c.eventId ? eventById(s, c.eventId) : undefined;
  if (ctxEv) {
    const sub = eventSub(q);
    // A question naming another machine is about that machine, not the event in context.
    const namesOther = machine != null && machine !== ctxEv.asset.equipmentId;
    if (!FACTORY_WIDE.test(q) && !namesOther && (base === 'help' || base === 'event-missing' || sub != null || REFERS.test(q))) return eventAnswer(c, ctxEv.id, sub ?? 'what');
  }

  // One vehicle: named by its id, or "this vehicle / truck" while one is selected in the twin.
  const vehicle = findVehicle(s, q) ?? (c.vehicleId && (REFERS_VEHICLE.test(q) || (base === 'help' && /\b(it|this)\b/.test(q))) ? c.vehicleId : null);
  if (vehicle && !machine && (base === 'help' || base === 'logistics' || base === 'delayed-vehicles' || base === 'turnaround')) return vehicleAnswer(c, vehicle);

  // "This machine" / "this stage": the equipment selected in the twin, the stage open in Production.
  if (!machine && c.equipmentId && (REFERS_ASSET.test(q) || (base === 'help' && /\b(it|this)\b/.test(q))))
    return base === 'health' ? healthAnswer(c, c.equipmentId) : CONVEYOR_BY_ID[c.equipmentId] ? conveyorAnswer(c, c.equipmentId, p) : machineAnswer(c, c.equipmentId, p);
  const namedStage = findStage(q);
  if (!machine && (REFERS_STAGE.test(q) || (base === 'help' && (namedStage || (c.stageId && /\b(it|this)\b/.test(q)))))) {
    const st = namedStage ?? c.stageId;
    if (st) return stageAnswer(c, st, p);
  }

  let intent = base;
  if (machine && (intent === 'help' || intent === 'health' || intent === 'below-target' || intent === 'oee' || (intent === 'conveyor-stop' && CONVEYOR_BY_ID[machine])))
    intent = intent === 'health' ? 'health' : 'machine';

  switch (intent) {
    case 'below-target':
      return belowTarget(c, p);
    case 'bottleneck':
      return bottleneckAnswer(c);
    case 'oee-losses':
      return oeeLossesAnswer(c, p);
    case 'oee':
      return oeeAnswer(c, p);
    case 'capacity-gap':
      return capacityAnswer(c, p);
    case 'loss-cost':
      return lossCost(c, p);
    case 'largest-downtime':
      return largestDowntime(c, p);
    case 'machine-downtime':
      return machineDowntime(c, p);
    case 'conveyor-stop':
      return conveyorAnswer(c, null, p);
    case 'kiln':
      return kilnAnswer(c, p);
    case 'defects':
      return defectsAnswer(c, p, findDefect(q));
    case 'defect-report':
      return defectReport(c, findDefect(q));
    case 'delayed-vehicles':
      return delayedVehiclesAnswer(c, p);
    case 'turnaround':
      return turnaroundAnswer(c);
    case 'logistics':
      return logisticsAnswer(c, p);
    case 'investigate-first':
      return investigateFirst(c, has(q, ['equipment', 'machine', 'asset']));
    case 'next-actions':
      return nextActionsAnswer(c);
    case 'energy':
      return energyAnswer(c);
    case 'process-parameter':
      return processParameterAnswer(c, q, machine);
    case 'health':
      return healthAnswer(c, machine);
    case 'event-missing':
      return eventMissing(c);
    case 'machine':
      return CONVEYOR_BY_ID[machine!] ? conveyorAnswer(c, machine!, p) : machineAnswer(c, machine!, p);
    default:
      return helpAnswer(c);
  }
}

// ── Production ────────────────────────────────────────────────────────────────

function belowTarget(c: Ctx, p: Period): CopilotAnswer {
  const { s, finance } = c;
  const lm = lineMetrics(s, p);
  const good = goodOutputKpi(s, p, lm);
  const att = targetAttainmentKpi(s, p, lm);
  const oee = factoryOeeKpi(s, p, lm);
  const down = constraintDowntimeKpi(s, p, lm);
  const status = targetStatus(lm.attainment);
  // The KPI cards' time scope ("Shift A · 06:00–10:30 (to date)") and plan wording ("Plan to date 1,782 m² ·
  // shift 3,168 m²"), so a pro-rata plan is never read as the whole shift's plan.
  const scope = periodText(s, p);
  const where = inPeriod(scope);
  const planText = good.target ?? `Plan ${area(lm.targetM2)}`;
  const [planLabel, planValue] = planParts(planText);
  const toDate = p.to >= s.minute;
  // Figures on a stale feed: output and attainment (sorting), OEE (kiln or sorting), kiln minutes (kiln).
  const outStale = staleOf(good) ?? staleOf(att);
  const oeeStale = staleOf(oee);
  const kilnStale = staleOf(down);
  const facts = [
    { label: 'Good output', value: kvFact(good) },
    { label: planLabel, value: planValue },
    { label: 'Target attainment', value: kvFact(att) },
    // Labelled "OEE" here (the value is the Line OEE card's).
    { label: 'OEE', value: kvFact(oee) },
    { label: 'Downtime affecting output', value: kvFact(down) },
  ];
  const method = `Same figures as the Good output, Target attainment, Line OEE and Downtime affecting output cards for ${where}. Good output = first-quality tiles accepted at sorting; plan = ${int(TARGET.goodPerHour)} good tiles per planned hour (${pct(TARGET.oeeTarget, 0)} OEE)${toDate ? ', pro rata for the planned time elapsed so far' : ''}. Bands: ≥ 100 % ahead, ≥ 97 % on track, ≥ 90 % behind, below that well behind. Lost time is split at the kiln, the line constraint.${outStale || oeeStale || kilnStale ? STALE_METHOD : ''}`;
  if (status === 'none')
    return compose(
      c,
      'below-target',
      scope,
      {
        confirmed: [`No planned production time has elapsed in ${where} yet — there is no plan to compare with.`],
        unknown: ['Whether production is below target cannot be established until planned production time has elapsed.'],
        actions: ['Ask again once the period has run, or choose a longer period in the header (Production, Quality and Fleet).'],
        method: [method],
      },
      { facts, links: [wsLink('production')], followUps: ['Which stage is currently constraining output?'] },
    );
  const pareto = downtimePareto(s, p).slice(0, 3);
  const claim = constraintClaim(s);
  const losses = lossBreakdown(s, p);
  const gapM2 = lm.targetM2 - lm.outputM2;
  const behind = status === 'behind' || status === 'well-behind';
  // Root production events of the period that held the kiln up (active or already cleared).
  const holding = s.events
    .filter((e) => e.category === 'production' && !e.consequenceOf && e.acc.constraintMin > 0 && e.start < p.to && (e.end ?? s.minute) > p.from)
    .sort((a, b) => b.acc.constraintMin - a.acc.constraintMin)
    .slice(0, 3);
  const value = behind ? lostOutputValue(finance, lm.target - lm.output) : null;
  const t = lm.constraint.totals;
  const topReason = pareto[0];
  // An asset whose feed is stale is in an unknown state: it is never reported as "stopped now".
  const stoppedNow = lm.activeStops.filter((d) => !staleFeed(s, d.equipmentId));
  const outputLine = behind
    ? `Production is below target in ${where}: good output ${kv(good)} against ${low1(planText)} — target attainment ${kv(att)} (${low1(TARGET_STATUS_LABEL[status])}), ${area(gapM2)} short.`
    : `Production is not below target in ${where}: good output ${kv(good)} against ${low1(planText)} — target attainment ${kv(att)} (${low1(TARGET_STATUS_LABEL[status])})${gapM2 > 0.5 ? `; the ${area(gapM2)} gap is within normal hour-to-hour variation` : ''}.`;
  const oeeLine = `Line OEE ${kv(oee)}${oee.unavailable ? '' : ` (${oeeEquation(lm.oee)})`}, against the ${pct(TARGET.oeeTarget, 0)} the plan assumes.`;
  const downLine = `Downtime affecting output: ${kv(down)} at the kiln (line constraint) — ${int(t.down)} min stopped, ${int(t.starved + t.blocked)} min starved or blocked.`;
  const kilnOwn = holding
    .filter(ownsKiln)
    .map((e) => `${e.id} (${e.title}${e.end == null ? ', still active' : `, cleared ${when(s, e.end)}`}) has held the kiln up ${int(e.acc.constraintMin)} min in total since ${when(s, e.start)} — the kiln's own stop.`);
  return compose(
    c,
    'below-target',
    scope,
    {
      confirmed: [
        outStale
          ? `${planText} (${int(TARGET.goodPerHour)} good tiles per planned production hour, from the production calendar).`
          : outputLine,
        oeeStale ? null : oeeLine,
        kilnStale ? null : downLine,
        pareto.length
          ? `Largest unplanned stoppage reasons: ${pareto.map((r) => `${low1(r.label)} ${int(r.minutes)} min (${plural(r.events, 'stop')})`).join(', ')}.`
          : `No unplanned stoppage was recorded in ${where}.`,
        stoppedNow.length ? `Stopped now: ${stoppedNow.map((d) => `${d.equipmentId} since ${when(s, d.start)}`).join(', ')}.` : null,
        ...(kilnStale ? [] : kilnOwn),
      ],
      simulated: [scenarioStops(s, p)],
      inferred: [
        losses[0].min > 0.5
          ? likely(
              `${behind ? 'most of the shortfall' : 'most of the kiln time lost'} comes from ${low1(losses[0].label)} (${pct(losses[0].share, 0)} of the kiln time lost in the period), then ${low1(losses[1].label)} (${pct(losses[1].share, 0)})`,
              staleBasis('every minute the kiln (line constraint) loses is line output lost; split from its time accounting', kilnStale),
            )
          : null,
        isTraced(claim) ? likely(`the line is currently limited by ${claim.name.toLowerCase()}, not the kiln as designed`, claim.evidence) : constraintInference(claim),
        ...holding
          .filter((e) => !ownsKiln(e))
          .map((e) => likely(`${e.id} (${e.title}${e.end == null ? ', still active' : `, cleared ${when(s, e.end)}`}) held the kiln up ${int(e.acc.constraintMin)} min`, staleBasis(KILN_ATTRIBUTION, kilnStale))),
      ],
      unknown: [
        outStale
          ? notConfirmed(
              outStale,
              `output vs plan — simulated running total ${kv(good)} of ${area(lm.targetM2)} planned${toDate ? ' to date' : ''}, target attainment ${kv(att)}; whether production is below target cannot be confirmed until the feed updates.`,
            )
          : null,
        oeeStale ? notConfirmed(oeeStale, oeeLine) : null,
        kilnStale ? notConfirmed(kilnStale, downLine) : null,
        ...(kilnStale ? kilnOwn.map((x) => notConfirmed(kilnStale, x)) : []),
        pareto.length ? 'Why each stop happened beyond its reason code cannot be established from the data — the simulation records reason codes and machine states, not failure analyses.' : null,
        constraintUnknown(s, claim),
      ],
      estimate:
        value && value.amount > 0.005
          ? [
              `Value of the ${area(gapM2)} shortfall${outStale ? ' in the simulated running total (not confirmed by the feed)' : ''} ≈ ${money(finance.currency, value.amount)} of contribution (${value.basis}).`,
              assumptionsText(finance, ['output']),
            ]
          : [],
      actions: [
        outStale ? 'Open I-SORT in the Factory Twin to check its data feed before acting on output against plan.' : null,
        kilnStale ? 'Open H-KILN in the Factory Twin to check its data feed before acting on the kiln figures.' : null,
        holding[0] ? `Review ${holding[0].id} (${holding[0].title}) in Events & Reports first — it accounts for the most kiln hold-up in the period.` : null,
        topReason && REASON_ACTIONS[topReason.key] ? `Standard first response for ${low1(topReason.label)} (rule-based): ${REASON_ACTIONS[topReason.key]}` : null,
        isTraced(claim) ? `Open ${claim.name} in Production — it is the stage the kiln is waiting on.` : null,
        !behind && !holding.length && !outStale ? 'No recovery action is indicated — output is on or ahead of plan.' : null,
      ],
      method: [method],
    },
    {
      facts,
      links: [wsLink('production'), ...(outStale ? equipmentLink('I-SORT') : []), ...(kilnStale ? equipmentLink('H-KILN') : []), ...stageLink(claim.processStage), ...holding.map((e) => eventLink(e))],
      followUps: ['Which stage is currently constraining output?', 'What are the main OEE losses this shift?', 'Which equipment should be investigated first?'],
      eventId: holding[0]?.id,
      records: holding,
    },
  );
}

function bottleneckAnswer(c: Ctx): CopilotAnswer {
  const { s } = c;
  const bn = bottleneck(s);
  // The confirmed sentence is the Overview's graded claim; the trace shares are its supporting evidence.
  const claim = constraintClaim(s);
  const traced = isTraced(claim);
  const stale = claim.kind === 'kiln-unknown';
  const k = bn.constraint;
  const win = bn.period.label.toLowerCase();
  // The stage the claim names: where the trace ended, or the kiln itself.
  const cur = bn.stages.find((r) => r.stage === claim.processStage) ?? bn.current;
  const machines = STAGE_BY_ID[cur.stage].machines;
  const at = bn.stages.indexOf(cur);
  const up = traced ? bn.stages.filter((r, i) => i < at && (r.blockedShare ?? 0) > HELD_UP_SHARE).map((r) => r.name.toLowerCase()) : [];
  const down = traced ? bn.stages.filter((r, i) => i > at && (r.starvedShare ?? 0) > HELD_UP_SHARE).map((r) => r.name.toLowerCase()) : [];
  const kilnName = STAGE_BY_ID[LINE.designConstraint].name.toLowerCase();
  // Active events on the named stage's machines (the records that may explain it).
  const onStage = activeEvents(s)
    .filter((e) => !e.consequenceOf && machines.includes(e.asset.equipmentId ?? ''))
    .sort((a, b) => b.start - a.start)
    .slice(0, 3);
  const open = c.stageId ? MONITORED_STAGE_BY_ID[c.stageId] : null;
  const openLine = !open
    ? null
    : open.id !== claim.stage
      ? `${open.name}, the stage open in Production, is not the constraint right now.`
      : claim.constraining
        ? `${open.name}, the stage open in Production, is the stage currently constraining output.`
        : `${open.name}, the stage open in Production, is the modeled design constraint; no evidence shows it constraining output now.`;
  const shares = (r: typeof cur) => `working ${pct(r.workingShare, 0)}, starved ${pct(r.starvedShare, 0)}, blocked ${pct(r.blockedShare, 0)}, down ${pct(r.downShare, 0)}`;
  return compose(
    c,
    'bottleneck',
    bn.period.label,
    {
      confirmed: [
        constraintFact(claim),
        stale
          ? null
          : `Bottleneck trace over the ${win} (supporting evidence): ${cur.name} (${machines.join(', ')}) ${shares(cur)}${cur.inputBufferLevel != null ? `; input buffer ${pct(cur.inputBufferLevel, 0)} full` : ''}.`,
        stale || cur.stage === LINE.designConstraint ? null : `The kiln was starved ${pct(k.starvedShare, 0)}, blocked ${pct(k.blockedShare, 0)} and down ${pct(k.downShare, 0)} of its planned time.`,
        up.length ? `Blocked upstream: ${up.join(', ')}.` : null,
        down.length ? `Starved downstream: ${down.join(', ')}.` : null,
        onStage.length ? `Active events on ${cur.name.toLowerCase()}: ${onStage.map((e) => `${e.id} ${e.title}`).join('; ')}.` : null,
        openLine,
      ],
      inferred: [
        constraintInference(claim),
        traced ? likely(`every minute ${kilnName} waits on ${claim.name.toLowerCase()} is output lost for the whole line`, 'the kiln is the designed constraint') : null,
      ],
      hypotheses: [
        traced && !onStage.length && (cur.downShare ?? 0) < HELD_UP_SHARE
          ? possible(`${claim.name.toLowerCase()} is running below its ideal rate or stopping briefly`, 'no stop or event explains it; the stage state shares alone cannot tell a slow machine from short stops')
          : null,
      ],
      unknown: [
        constraintUnknown(s, claim),
        stale ? `The kiln's state shares over the ${win} include minutes the stale feed has not confirmed, so the trace is not stated as evidence.` : null,
      ],
      actions: [
        stale ? 'Open H-KILN in the Factory Twin to check its data feed before acting on the kiln state.' : null,
        `Open ${claim.name} in Production to see its machines, buffers and stops.`,
        ...onStage.slice(0, 2).map((e) => `Review ${e.id} (${e.title}) in Events & Reports.`),
      ],
      method: [
        `The constraint statement is the one the Overview makes: "currently constraining output" only with evidence — the kiln stopped or below its design rate now, or the kiln starved / blocked in the ${win} and traced to another stage; otherwise the kiln is the modeled design constraint. Starting at the kiln, a starved constraint is traced upstream (blocked: downstream) past every stage that was itself held up more than ${pct(HELD_UP_SHARE, 0)} of the window; shares come from the per-minute state log of the ${win} — the same trace as the Production workspace.`,
      ],
    },
    {
      facts: bn.stages.map((r) => ({
        label: r.name,
        value: `${pct(r.workingShare, 0)} working · ${pct(r.starvedShare, 0)} starved · ${pct(r.blockedShare, 0)} blocked · ${pct(r.downShare, 0)} down${stale && r.stage === LINE.designConstraint ? ' · not confirmed (feed stale)' : ''}`,
      })),
      links: [...stageLink(claim.processStage), ...machines.slice(0, 2).flatMap((id) => equipmentLink(id)), ...onStage.slice(0, 2).map((e) => eventLink(e)), wsLink('production')],
      followUps: ['What are the main OEE losses this shift?', 'Why is production below target?'],
      eventId: onStage[0]?.id,
      records: onStage,
    },
  );
}

function oeeLossesAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s } = c;
  const lm = lineMetrics(s, p);
  const oee = factoryOeeKpi(s, p, lm);
  const down = constraintDowntimeKpi(s, p, lm);
  const rej = rejectRateKpi(s, p);
  const top = topDefectKpi(s, p);
  const scope = periodText(s, p);
  const where = inPeriod(scope);
  // Stale feeds, from the KPI models: the kiln (availability, performance, kiln minutes — the Downtime card)
  // and sorting (quality — the Good output card); the Line OEE card names whichever applies.
  const oeeStale = staleOf(oee);
  const kilnStale = staleOf(down);
  const sortStale = staleOf(goodOutputKpi(s, p, lm));
  const o = lm.oee;
  const losses = lossBreakdown(s, p).filter((l) => l.min > 0.5);
  const pareto = downtimePareto(s, p).slice(0, 3);
  const claim = constraintClaim(s);
  const q = qualityIn(s, p);
  const topDefect = DEFECT_ORDER.map((d) => ({ d, n: q.byDefect[d] ?? 0 })).sort((a, b) => b.n - a.n)[0];
  const factors = [
    { name: 'availability', m: o.availability, why: 'stops and waiting at the kiln (down, starved or blocked)' },
    { name: 'performance', m: o.performance, why: 'the kiln running below its design rate' },
    { name: 'quality', m: o.quality, why: 'tiles rejected at sorting' },
  ].filter((f) => f.m.status === 'ok');
  const weakest = [...factors].sort((a, b) => a.m.value! - b.m.value!)[0];
  const below = activeEvents(s).find((e) => e.type === 'below-rate' && e.asset.equipmentId === 'H-KILN');
  const holding = s.events
    .filter((e) => e.category === 'production' && !e.consequenceOf && e.acc.constraintMin > 0 && e.start < p.to && (e.end ?? s.minute) > p.from)
    .sort((a, b) => b.acc.constraintMin - a.acc.constraintMin)
    .slice(0, 3);
  const speed = losses.find((l) => l.label.startsWith('Speed'));
  if (oee.unavailable)
    return compose(
      c,
      'oee-losses',
      scope,
      {
        confirmed: [`Line OEE for ${where} is unavailable: ${low1(oee.unavailable)}`],
        unknown: ['The OEE losses of this period cannot be established until the kiln has planned production time.'],
        method: [oee.definition],
      },
      { facts: [{ label: 'Line OEE', value: 'Unavailable' }], links: [wsLink('production')] },
    );
  const oeeLine = `Line OEE for ${where}: ${oeeEquation(o)} — target ${pct(TARGET.oeeTarget, 0)}${o.oee.value != null ? `, ${(Math.abs(TARGET.oeeTarget - o.oee.value) * 100).toFixed(1)} pts ${o.oee.value < TARGET.oeeTarget ? 'below' : 'above'}` : ''}.`;
  // Loss minutes are the kiln's time accounting: all of them rest on the kiln feed.
  const lossLines = [
    losses.length ? 'Losses at the kiln (line constraint), in minutes of kiln time, largest first:' : 'No loss of kiln time was recorded in the period.',
    ...losses.map((l, i) => `${i + 1}. ${l.label}: ${int(l.min)} min (${pct(l.share, 0)}).`),
  ];
  const downLine = `Downtime affecting output: ${kv(down)}${down.target ? ` (${down.target})` : ''}.`;
  const qualityLine = `Quality loss: reject rate ${kv(rej)}${rej.unavailable ? '' : ` (${int(q.rejected)} of ${int(q.inspected)} inspected tiles)`}; most frequent defect ${top.unavailable ? 'none recorded' : `${top.display} (${top.target})`}.`;
  const kilnOwn = holding.filter(ownsKiln).map((e) => `${e.id} (${e.title}) has held the kiln up ${int(e.acc.constraintMin)} min in total since ${when(s, e.start)} — the kiln's own stop.`);
  return compose(
    c,
    'oee-losses',
    scope,
    {
      confirmed: [
        oeeStale ? null : oeeLine,
        ...(kilnStale ? [] : lossLines),
        kilnStale ? null : downLine,
        pareto.length ? `Largest unplanned stop reasons: ${pareto.map((r) => `${low1(r.label)} ${int(r.minutes)} min (${plural(r.events, 'stop')})`).join(', ')}.` : null,
        sortStale ? null : qualityLine,
        below ? `The kiln has an active below-rate event: ${below.id}.` : null,
        ...(kilnStale ? [] : kilnOwn),
      ],
      simulated: [scenarioStops(s, p)],
      inferred: [
        weakest && weakest.m.value! < 0.99
          ? likely(`${weakest.name} is the largest OEE loss (${pct(1 - weakest.m.value!)} lost) — ${weakest.why}`, staleBasis('lowest of the three factors this period', oeeStale))
          : null,
        losses[0] && /starvation/i.test(losses[0].label)
          ? likely(`the kiln lost most time waiting for tiles${claim.kind === 'starving' ? `; ${claim.name.toLowerCase()} is currently constraining output` : ''}`, staleBasis('kiln time accounting and the bottleneck trace', kilnStale))
          : null,
        ...holding.filter((e) => !ownsKiln(e)).map((e) => likely(`${e.id} (${e.title}) held the kiln up ${int(e.acc.constraintMin)} min`, staleBasis(KILN_ATTRIBUTION, kilnStale))),
      ],
      hypotheses: [
        speed && speed.min > 0.5 && !below
          ? possible('the speed loss comes from short stops or a reduced speed setpoint at the kiln', 'speed loss without a below-rate event — not distinguishable from the rate signal alone')
          : null,
        topDefect && topDefect.n > 0 && weakest?.name === 'quality'
          ? possible(`${DEFECTS[topDefect.d].label.toLowerCase()} rejects originate at ${STAGE_BY_ID[DEFECTS[topDefect.d].origin].name.toLowerCase()}`, 'modelled origin of the defect category — a hypothesis to check')
          : null,
      ],
      unknown: [
        oeeStale ? notConfirmed(oeeStale, oeeLine) : null,
        ...(kilnStale ? [notConfirmed(kilnStale, lossLines[0]), ...lossLines.slice(1), notConfirmed(kilnStale, downLine), ...kilnOwn.map((x) => notConfirmed(kilnStale, x))] : []),
        sortStale ? notConfirmed(sortStale, qualityLine) : null,
        speed && speed.min > 0.5 ? 'Micro-stops and reduced speed are not separated in the data — the performance loss is one figure.' : null,
      ],
      actions: [
        kilnStale ? 'Open H-KILN in the Factory Twin to check its data feed before acting on the kiln figures.' : null,
        sortStale ? 'Open I-SORT in the Factory Twin to check its data feed before acting on the quality figures.' : null,
        pareto[0] && REASON_ACTIONS[pareto[0].key] ? `Standard first response for ${low1(pareto[0].label)} (rule-based): ${REASON_ACTIONS[pareto[0].key]}` : null,
        weakest?.name === 'quality' && topDefect?.n ? `Standard check for ${DEFECTS[topDefect.d].label.toLowerCase()} (rule-based): ${DEFECT_ACTIONS[topDefect.d]}` : null,
        holding[0] ? `Review ${holding[0].id} in Events & Reports — it held the kiln up longest.` : null,
        'Open Production for the OEE breakdown, the downtime Pareto and the stage view.',
      ],
      method: [
        `${oee.definition} Loss minutes at the kiln: downtime, starvation and blocking from its time accounting; speed loss = operating time − tiles fired × ideal cycle; quality loss = kiln time spent on tiles later rejected (rejects ÷ inspected).${oeeStale || kilnStale || sortStale ? STALE_METHOD : ''}`,
      ],
    },
    {
      facts: [
        { label: 'Line OEE', value: kvFact(oee) },
        { label: 'Availability', value: marked(metricPct(o.availability), kilnStale) },
        { label: 'Performance', value: marked(metricPct(o.performance), kilnStale) },
        { label: 'Quality', value: marked(metricPct(o.quality), sortStale) },
        { label: 'Downtime affecting output', value: kvFact(down) },
        { label: 'Reject rate', value: kvFact(rej) },
      ],
      links: [wsLink('production'), ...(kilnStale ? equipmentLink('H-KILN') : []), ...(sortStale ? equipmentLink('I-SORT') : []), ...stageLink(claim.processStage), ...holding.slice(0, 2).map((e) => eventLink(e))],
      followUps: ['Why is production below target?', 'Which stage is currently constraining output?', 'What is the current OEE and how is it calculated?'],
      eventId: holding[0]?.id,
      records: [...holding, below],
    },
  );
}

function largestDowntime(c: Ctx, p: Period): CopilotAnswer {
  const { s } = c;
  const pareto = downtimePareto(s, p);
  const method = 'Downtime Pareto of the period: unplanned stops by reason, each clipped to the period (starved, blocked and planned stops excluded).';
  if (!pareto.length)
    return compose(c, 'largest-downtime', periodText(c.s, p), { confirmed: [`No unplanned downtime has been recorded in ${inPeriod(periodText(c.s, p))}.`], method: [method] }, { followUps: SUGGESTED_QUESTIONS.slice(0, 2) });
  const top = pareto[0];
  const events = s.downtime.filter((d) => d.reasonCode === top.key && d.start < p.to && (d.end ?? s.minute) > p.from);
  // Minutes inside the period only, so the machine's share never exceeds the reason's total.
  const byMachine = new Map<string, number>();
  for (const d of events) byMachine.set(d.equipmentId, (byMachine.get(d.equipmentId) ?? 0) + clippedDuration(d, p, s.minute));
  const worst = [...byMachine.entries()].sort((a, b) => b[1] - a[1])[0];
  const stopEvents = events.map((d) => stopEventFor(s, d)).filter((e): e is OpEvent => !!e);
  return compose(
    c,
    'largest-downtime',
    periodText(c.s, p),
    {
      confirmed: [
        `The largest downtime loss in ${inPeriod(periodText(c.s, p))} is ${low1(top.label)}: ${int(top.minutes)} min over ${plural(top.events, 'event')} (${pct(top.share, 0)} of unplanned downtime).`,
        worst ? `Most of it was on ${worst[0]} (${nameOf(worst[0])}, ${int(worst[1])} min in the period).` : null,
      ],
      simulated: [scenarioStops(s, p)],
      unknown: ['Why the stops happened beyond their reason code cannot be established from the data — the simulation records reason codes, not failure analyses.'],
      actions: [REASON_ACTIONS[top.key] ? `Standard first response for this reason (rule-based): ${REASON_ACTIONS[top.key]}` : null, 'Open Production for the downtime Pareto of the period.'],
      method: [method],
    },
    {
      facts: pareto.slice(0, 5).map((r) => ({ label: r.label, value: `${int(r.minutes)} min · ${r.events}×` })),
      links: [...(worst ? equipmentLink(worst[0]) : []), ...stopEvents.slice(0, 2).map((e) => eventLink(e)), wsLink('production')],
      followUps: ['Which machine has the greatest downtime loss?', 'Why is production below target?'],
      records: stopEvents,
    },
  );
}

type AssetLoss = { id: string; minutes: number; lostTiles: number; events: number; active: boolean; constraintMin: number; stopEvents: OpEvent[] };

/** Unplanned downtime per asset in the period (pro-rated to the period), with the kiln time its stop events cost. */
function assetLosses(s: SimState, p: Period): AssetLoss[] {
  const by = new Map<string, AssetLoss>();
  for (const d of downtimeIn(s, p)) {
    if (!isUnplanned(d)) continue;
    const inP = clippedDuration(d, p, s.minute);
    if (inP <= 0) continue;
    const total = (d.end ?? s.minute) - d.start;
    const r = by.get(d.equipmentId) ?? { id: d.equipmentId, minutes: 0, lostTiles: 0, events: 0, active: false, constraintMin: 0, stopEvents: [] };
    r.minutes += inP;
    r.lostTiles += total > 0 ? d.lostTiles * (inP / total) : 0;
    r.events++;
    r.active ||= d.end == null;
    by.set(d.equipmentId, r);
  }
  for (const r of by.values()) {
    r.stopEvents = s.events.filter((e) => e.dedupeKey === `stop:${r.id}` && e.start < p.to && (e.end ?? s.minute) > p.from);
    r.constraintMin = r.stopEvents.reduce((a, e) => a + e.acc.constraintMin, 0);
  }
  return [...by.values()];
}

function machineDowntime(c: Ctx, p: Period): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const all = assetLosses(s, p);
  const machines = all.filter((r) => PROCESS_MACHINES.includes(r.id)).sort((a, b) => b.lostTiles - a.lostTiles || b.minutes - a.minutes);
  const conveyors = all.filter((r) => CONVEYOR_BY_ID[r.id]).sort((a, b) => b.minutes - a.minutes);
  const method =
    'Process machines ranked by output not made while stopped (m² at their ideal rate), then by minutes. Unplanned downtime from the downtime log, clipped to the period (stops that began earlier are pro-rated); kiln time = minutes the line constraint was held up with the asset’s stop events as the cause (event-engine attribution, whole events).';
  if (!machines.length)
    return compose(
      c,
      'machine-downtime',
      periodText(c.s, p),
      {
        confirmed: [`No process machine had unplanned downtime in ${inPeriod(periodText(c.s, p))}.`, conveyors.length ? `Conveyors: ${conveyors.map((r) => `${r.id} ${int(r.minutes)} min`).join(', ')}.` : null],
        method: [method],
      },
      { links: [wsLink('production')], followUps: ['Which conveyor stopped most recently?', 'What are the main OEE losses this shift?'] },
    );
  const top = machines[0];
  const byLine = [...all].sort((a, b) => b.constraintMin - a.constraintMin)[0];
  const lineLoss = top.stopEvents
    .filter((e) => !e.consequenceOf)
    .map((e) => eventImpact(s, e, finance, tariffs).estimate)
    .reduce((a, e) => a + (e?.lines.filter((l) => /Lost good output/.test(l.label)).reduce((x, l) => x + l.amount, 0) ?? 0), 0);
  const latest = [...top.stopEvents].sort((a, b) => b.start - a.start)[0];
  const stopIds = top.stopEvents.map((e) => e.id).join(', ');
  // Kiln minutes of another asset's stops are an attribution (inferred), so they never appear under Confirmed facts.
  const conveyorsHolding = conveyors.filter((r) => r.constraintMin > 0 && r.id !== byLine?.id);
  return compose(
    c,
    'machine-downtime',
    periodText(c.s, p),
    {
      confirmed: [
        `${top.id} (${nameOf(top.id)}) has the greatest downtime loss in ${inPeriod(periodText(c.s, p))}: ${int(top.minutes)} min of unplanned downtime over ${plural(top.events, 'stop')}, ≈ ${m2(top.lostTiles)} not made at its ideal rate${top.active ? ' — it is still down' : ''}.`,
        machines.length > 1 ? `Next: ${machines.slice(1, 3).map((r) => `${r.id} ${int(r.minutes)} min (${m2(r.lostTiles)})`).join(', ')}.` : null,
        top.id === 'H-KILN' && top.stopEvents.length ? `Its stop events (${stopIds}) held the kiln up ${int(top.constraintMin)} min.` : null,
        top.id === 'H-KILN' ? inf('confirmed', 'the kiln is the line constraint: its downtime is line output lost one for one', 'line design') : null,
        conveyors.length ? `Conveyor downtime in the period: ${conveyors.map((r) => `${r.id} ${int(r.minutes)} min`).join(', ')}.` : null,
      ],
      simulated: [scenarioStops(s, p)],
      inferred: [
        top.id === 'H-KILN'
          ? null
          : top.constraintMin === 0
            ? likely(`the buffers between ${top.id} and the kiln absorbed its stops — no line output was lost because of it`, `no kiln hold-up minutes are attributed to its stop events${stopIds ? ` (${stopIds})` : ''} by the event engine`)
            : likely(`${top.id}'s stops${stopIds ? ` (${stopIds})` : ''} reached the kiln and held it up ${int(top.constraintMin)} min — line output lost`, KILN_ATTRIBUTION),
        byLine && byLine.constraintMin > 0 && byLine.id !== top.id ? likely(`for line output, ${byLine.id} (${nameOf(byLine.id)}) mattered more: its stops held the kiln up ${int(byLine.constraintMin)} min`, KILN_ATTRIBUTION) : null,
        conveyorsHolding.length ? likely(`conveyor stops that held the kiln up: ${conveyorsHolding.map((r) => `${r.id} ${int(r.constraintMin)} min`).join(', ')}`, KILN_ATTRIBUTION) : null,
      ],
      estimate: lineLoss > 0.005 ? [`Line output lost through ${top.id}'s stop events ≈ ${money(finance.currency, lineLoss)} of contribution (from the event estimates).`, assumptionsText(finance, ['output'])] : [],
      actions: [
        latest ? `Review ${latest.id} (${latest.title}) in Events & Reports.` : null,
        `Locate ${top.id} in the Factory Twin to see its state, stops and condition.`,
      ],
      method: [method],
    },
    {
      facts: machines.slice(0, 5).map((r) => ({
        label: `${r.id} · ${nameOf(r.id)}`,
        value: `${int(r.minutes)} min · ${m2(r.lostTiles)} · kiln ${int(r.constraintMin)} min${r.id === 'H-KILN' ? '' : ' (attributed)'}`,
      })),
      links: [...equipmentLink(top.id), ...(latest ? [eventLink(latest)] : []), ...stageLink(OPS_BY_ID[top.id]?.stage), wsLink('production')],
      followUps: ['Which equipment should be investigated first?', 'What is the estimated cost of the current production loss?'],
      eventId: latest?.id,
      records: top.stopEvents,
    },
  );
}

const isConveyorStop = (d: DowntimeEvent) => CONVEYOR_BY_ID[d.equipmentId] != null && isUnplanned(d) && !(d.end != null && d.end <= d.start);

/** The stop event that carries a downtime record (reopened events carry the newest record). */
const stopEventFor = (s: SimState, d: DowntimeEvent) =>
  s.events.find((e) => e.refs.downtimeId === d.id) ?? s.events.find((e) => e.dedupeKey === `stop:${d.equipmentId}` && e.start <= d.start && (e.end ?? s.minute) >= d.start);

function conveyorAnswer(c: Ctx, focus: string | null, p: Period): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const stops = s.downtime.filter((d) => isConveyorStop(d) && (!focus || d.equipmentId === focus)).sort((a, b) => b.start - a.start);
  const now = CONVEYOR_IDS.map((id) => ({ id, st: operationalState(s, id) }));
  const stoppedNow = now.filter((x) => x.st === 'stopped' || x.st === 'fault' || x.st === 'unknown');
  const idle = now.filter((x) => x.st === 'idle').length;
  const nowLine = focus
    ? `${focus} now: ${OPERATIONAL_STATE_LABEL[operationalState(s, focus)].toLowerCase()}.`
    : stoppedNow.length
      ? `Stopped or unknown now: ${stoppedNow.map((x) => `${x.id} (${OPERATIONAL_STATE_LABEL[x.st].toLowerCase()})`).join(', ')}.`
      : `All ${CONVEYOR_IDS.length} conveyors are running now${idle ? ` (${idle} idle — no material on the belt)` : ''}.`;
  const method =
    'Conveyor stops come from the run-state signal (rule R-CONV, simulated PLC). Starvation or blocking of the neighbouring stages is linked to a stop when it is the first held-up asset in that direction; line output counts as lost only while the kiln is held up.';
  if (!stops.length)
    return compose(
      c,
      'conveyor-stop',
      'Simulated history',
      { confirmed: [`No ${focus ? `${focus} ` : 'conveyor '}stop is recorded in the simulated history.`, nowLine], method: [method] },
      { links: [...equipmentLink(focus), wsLink('production')], followUps: ['Which machine has the greatest downtime loss?'] },
    );
  const d = stops[0];
  const conv = CONVEYOR_BY_ID[d.equipmentId];
  const reason = REASON_BY_CODE[d.reasonCode];
  const ongoing = d.end == null;
  const dur = (d.end ?? s.minute) - d.start;
  const ev = stopEventFor(s, d);
  const into = conv.blocksInputOf.map((x) => STAGE_BY_ID[x].name.toLowerCase());
  const outOf = conv.blocksOutputOf.map((x) => STAGE_BY_ID[x].name.toLowerCase());
  const consequences = ev ? ev.related.map((id) => eventById(s, id)).filter((x): x is OpEvent => !!x && x.consequenceOf === ev.id) : [];
  const est = ev && !ev.consequenceOf ? eventImpact(s, ev, finance, tariffs).estimate : null;
  const day = s.minute - 1440;
  const last24 = stops.filter((x) => x.start >= day);
  const cm = focus ? conveyorMetrics(s, focus, p) : null;
  // Confirmed: the kiln's own state while the conveyor was stopped (state log). Inferred: how much of that the
  // event engine attributes to this stop — an attribution, so it carries a confidence.
  const kilnHeld = kilnHeldMinutes(s, d.start, d.end ?? s.minute);
  const soFar = ongoing ? ' so far' : '';
  const buffers = conv.bufferId ? `buffer ${conv.bufferId}` : 'the buffers';
  const cp = ev ? causeParts(ev.causes, 2) : { confirmed: [], inferred: [], hypotheses: [] };
  return compose(
    c,
    'conveyor-stop',
    focus && cm ? periodText(c.s, p) : 'Simulated history',
    {
      confirmed: [
        `${d.equipmentId} (${conv.name}) ${focus ? 'last stopped' : 'stopped most recently'} on ${formatDay(d.start)} at ${clock(d.start)} — ${low1(reason.label)} (${d.reasonCode}). ${ongoing ? `It is still stopped: ${formatDuration(dur)} so far.` : `Running again since ${clock(d.end!)} after ${formatDuration(dur)}.`}`,
        into.length || outOf.length
          ? `While it is stopped, ${[into.length ? `${into.join(' and ')} receive${into.length > 1 ? '' : 's'} no tiles` : '', outOf.length ? `${outOf.join(' and ')} cannot discharge onto it` : ''].filter(Boolean).join('; ')}.`
          : null,
        kilnHeld != null
          ? kilnHeld > 0
            ? `While ${d.equipmentId} ${ongoing ? 'has been' : 'was'} stopped, the kiln (line constraint) was down, starved or blocked for ${int(kilnHeld)} min${soFar} (kiln state log).`
            : `While ${d.equipmentId} ${ongoing ? 'has been' : 'was'} stopped, the kiln (line constraint) was never down, starved or blocked${soFar} (kiln state log).`
          : null,
        cm ? `In ${inPeriod(periodText(c.s, p))}: ${plural(cm.stops, 'stop')}, ${int(cm.downMin)} min down, running ${pct(cm.availability, 0)} of planned time, utilisation ${pct(cm.utilisation, 0)} of its ${int(conv.capacityPerHour)} tiles/h capacity.` : null,
        nowLine,
        `${plural(last24.length, 'conveyor stop')} in the last 24 h${last24.length > 1 ? `; before this one: ${last24.slice(1, 4).map((x) => `${x.equipmentId} at ${when(s, x.start)} (${formatDuration((x.end ?? s.minute) - x.start)})`).join(', ')}` : ''}.`,
        ...cp.confirmed,
      ],
      simulated: [d.source === 'scenario' ? `The stop record of ${d.equipmentId} at ${when(s, d.start)} was injected by a scenario.` : `The stop record of ${d.equipmentId} at ${when(s, d.start)} comes from the simulation itself, not from a scenario.`],
      inferred: [
        ...cp.inferred,
        ev
          ? ev.acc.constraintMin > 0
            ? likely(`${ev.id} held the kiln (line constraint) up ${int(ev.acc.constraintMin)} min${soFar}`, 'the kiln starvation / blockage is linked to this stop by the event engine (inferred from states and buffers)')
            : likely(`no kiln time is attributed to ${ev.id}${soFar}${kilnHeld ? '' : ` — ${buffers} covered the stop`}`, 'no kiln starvation or blockage was linked to this stop (inferred from states and buffers)')
          : null,
        ...consequences.slice(0, 3).map((x) => likely(`${x.id} (${x.title}) is a consequence of this stop`, 'the stopped conveyor is the first held-up asset in that direction (inferred from states and buffers)')),
      ],
      hypotheses: cp.hypotheses,
      estimate: est && est.total > 0.005 ? [`${ev!.id} cost ≈ ${money(est.currency, est.total)}${ongoing ? ' so far' : ''}: ${estimateLines(est).join('; ')}.`, assumptionsText(finance, ['output'])] : [],
      actions: [
        REASON_ACTIONS[d.reasonCode] ? `Standard first response for ${low1(reason.label)} (rule-based): ${REASON_ACTIONS[d.reasonCode]}` : null,
        ...(ev ? ev.recommendations.slice(0, 1) : []),
        ev ? `Open ${ev.id} in Events & Reports for its evidence and status.` : null,
      ],
      method: [method],
    },
    {
      facts: stops.slice(0, 5).map((x) => ({ label: `${x.equipmentId} · ${formatDay(x.start)} ${clock(x.start)}`, value: `${formatDuration((x.end ?? s.minute) - x.start)}${x.end == null ? ' (ongoing)' : ''} · ${REASON_BY_CODE[x.reasonCode]?.label ?? x.reasonCode}` })),
      links: [...(ev ? [eventLink(ev)] : []), ...equipmentLink(d.equipmentId), ...stageLink(conv.blocksInputOf[0] ?? conv.to), wsLink('production')],
      followUps: ev ? [`Why did ${ev.id} happen?`, `What is the impact of ${ev.id}?`] : ['Which machine has the greatest downtime loss?'],
      eventId: ev?.id,
      records: [ev, ...consequences],
    },
  );
}

function kilnAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s } = c;
  const k = machineMetrics(s, 'H-KILN', p);
  const st = stageMetrics(s, p).find((x) => x.stage === 'KILN')!;
  const claim = constraintClaim(s);
  const m = s.machines['H-KILN'];
  // The state the product shows (signal logic): a stale feed makes it unknown, never "running".
  const op = operationalState(s, 'H-KILN');
  const feed = staleFeed(s, 'H-KILN');
  const active = !feed && m.activeDowntimeId ? s.downtime.find((d) => d.id === m.activeDowntimeId) : null;
  const open = s.events.filter((e) => e.asset.equipmentId === 'H-KILN' && e.status !== 'resolved').sort((a, b) => b.lastUpdate - a.lastUpdate);
  const figures = `in ${inPeriod(periodText(c.s, p))} it ran at availability ${metricPct(k.oee.availability)} and performance ${metricPct(k.oee.performance)} and fired ${m2(k.totals.count)}`;
  const time = `it was starved ${int(k.totals.starved)} min, blocked ${int(k.totals.blocked)} min and down ${int(k.totals.down)} min`;
  const unconfirmed = feed ? ' (not confirmed — feed stale)' : '';
  return compose(
    c,
    'kiln',
    periodText(c.s, p),
    {
      confirmed: [
        feed
          ? `The kiln: ${staleState(s, feed)}.`
          : `The kiln is ${stateIs(op)} (since ${when(s, m.since)})${active ? ` — ${low1(REASON_BY_CODE[active.reasonCode]?.label ?? active.reasonCode)}, ${formatDuration(s.minute - active.start)} so far` : ''}. ${cap1(figures)}.`,
        feed ? null : `${cap1(time)} — time the line cannot recover because the kiln is the designed constraint.`,
        constraintFact(claim),
        `Input buffer ${pct(st.inputBufferLevel, 0)} full.`,
        open.length ? `Open kiln events: ${open.slice(0, 3).map((e) => `${e.id} ${e.title}`).join('; ')}.` : null,
      ],
      inferred: [isTraced(claim) || claim.kind !== 'design' ? constraintInference(claim) : likely('the kiln limits the line as designed — its own stops and rate set the line output', `no other stage held it up in ${claim.window}`)],
      unknown: [
        feed
          ? `Not confirmed by the feed: the kiln's simulated accounting says ${figures}, and ${time} — figures that include the time since ${when(s, feed.since)} the stale feed has not confirmed.`
          : null,
        constraintUnknown(s, claim),
        'Kiln firing temperatures are not modelled in this demo, so whether the firing curve is in tolerance cannot be established.',
      ],
      actions: [
        open[0] ? `Review ${open[0].id} in Events & Reports.` : null,
        feed ? 'Open H-KILN in the Factory Twin to check its data feed before acting on the kiln state.' : null,
        isTraced(claim) ? `Open ${claim.name} in Production — the kiln is waiting on it.` : feed ? null : 'Keep the kiln fed: its own stops and rate set the line output.',
      ],
      method: [
        `Kiln state from signal logic (a stale data feed makes it unknown; the last value received is shown as such); time accounting from its state and counter (simulated PLC).`,
      ],
    },
    {
      facts: [
        { label: 'Kiln state', value: OPERATIONAL_STATE_LABEL[op] },
        { label: 'Kiln availability', value: `${metricPct(k.oee.availability)}${unconfirmed}` },
        { label: 'Kiln performance', value: `${metricPct(k.oee.performance)}${unconfirmed}` },
        { label: 'Starved', value: `${int(k.totals.starved)} min${unconfirmed}` },
        { label: 'Blocked', value: `${int(k.totals.blocked)} min${unconfirmed}` },
        { label: 'Input buffer', value: pct(st.inputBufferLevel, 0) },
      ],
      links: [...equipmentLink('H-KILN'), ...stageLink(claim.processStage), ...open.slice(0, 1).map((e) => eventLink(e))],
      followUps: ['Which stage is currently constraining output?', 'What are the main OEE losses this shift?'],
      eventId: open[0]?.id,
      records: open.slice(0, 3),
    },
  );
}

function stageAnswer(c: Ctx, id: MonitoredStageId, p: Period): CopilotAnswer {
  const { s } = c;
  const ms = MONITORED_STAGE_BY_ID[id];
  const io = stageIO(s, id, p);
  const claim = constraintClaim(s);
  const isConstraint = claim.stage === id;
  const evs = s.events.filter((e) => e.status !== 'resolved' && !e.consequenceOf && eventInMonitoredStage(ms, e)).sort((a, b) => Number(b.end == null) - Number(a.end == null) || b.start - a.start);
  const unit = io.unit === 'pallets' ? 'pallets' : 'tiles';
  const rate = io.ratePerHour != null && ms.output.measured ? `${int(io.ratePerHour)} ${unit}/h` : null;
  // Only quantities with a counting point are reported; the others are "not measured", never inferred.
  const input = ms.input.measured && io.input != null ? `${int(io.input)} ${unit}` : null;
  const output = ms.output.measured && io.output != null ? `${int(io.output)} ${unit}` : null;
  return compose(
    c,
    'stage',
    periodText(c.s, p),
    {
      confirmed: [
        `${ms.name} in ${inPeriod(periodText(c.s, p))}: input ${input ?? 'not measured'}, output ${output ?? 'not measured'}${rate ? ` (${rate}${io.expectedPerHour != null ? ` against an expected ${int(io.expectedPerHour)} ${unit}/h at its ideal rate` : ''})` : ''}.`,
        io.unit === 'tiles' ? `Its machines were down ${int(io.downMin)} min, starved ${int(io.starvedMin)} min and blocked ${int(io.blockedMin)} min on average.` : null,
        io.wip != null ? `Work in progress at its input: ${int(io.wip)}${io.wipCapacity ? ` of ${int(io.wipCapacity)}` : ''} ${unit}.` : null,
        io.good != null && io.rejected != null ? `Accepted ${int(io.good)}, rejected ${int(io.rejected)} at inspection.` : null,
        isConstraint ? constraintFact(claim) : `${ms.name} is not constraining output: ${constraintPhrase(claim)}.`,
        evs.length ? `Open events in this stage: ${evs.slice(0, 3).map((e) => `${e.id} ${e.title}`).join('; ')}.` : 'No open event in this stage.',
      ],
      inferred: [isConstraint && claim.constraining ? likely(`${ms.name.toLowerCase()} sets the line pace right now`, claim.evidence) : isConstraint ? constraintInference(claim) : null],
      unknown: [
        constraintUnknown(s, claim),
        !ms.input.measured ? `${ms.input.label} is not measured at this stage${ms.input.note ? ` (${low1(ms.input.note)})` : ''}, so its input cannot be established.` : null,
        !ms.output.measured ? `${ms.output.label} is not measured at this stage, so its output cannot be established.` : null,
      ],
      actions: [evs[0] ? `Review ${evs[0].id} (${evs[0].title}) in Events & Reports.` : null, `Open ${ms.name} in Production for its machines, buffers and counts.`],
      method: ['Counts at the stage’s configured counting points (simulated PLC counters), the same as the Production stage view.'],
    },
    {
      facts: [
        { label: 'Input', value: input ?? 'Not measured' },
        { label: 'Output', value: output ?? 'Not measured' },
        ...(rate ? [{ label: 'Rate', value: rate }] : []),
      ],
      links: [...stageLink(id), ...evs.slice(0, 2).map((e) => eventLink(e)), wsLink('production')],
      followUps: ['Which stage is currently constraining output?', 'Why is production below target?'],
      eventId: evs[0]?.id,
      records: evs.slice(0, 3),
    },
  );
}

// ── OEE, capacity and loss ────────────────────────────────────────────────────

function oeeAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s } = c;
  const lm = lineMetrics(s, p);
  const card = factoryOeeKpi(s, p, lm);
  const scope = periodText(s, p);
  // Stale feeds, from the KPI models (see oeeLossesAnswer).
  const oeeStale = staleOf(card);
  const kilnStale = staleOf(constraintDowntimeKpi(s, p, lm));
  const sortStale = staleOf(goodOutputKpi(s, p, lm));
  const o = lm.oee;
  const k = lm.constraint.totals;
  const ideal = lm.constraint.idealRatePerHour;
  const factors = [
    { name: 'availability', m: o.availability, why: 'stops and waiting at the kiln (down, starved or blocked)' },
    { name: 'performance', m: o.performance, why: 'the kiln running below its design rate' },
    { name: 'quality', m: o.quality, why: 'tiles rejected at sorting' },
  ].filter((f) => f.m.status === 'ok');
  const weakest = [...factors].sort((a, b) => a.m.value! - b.m.value!)[0];
  const lines: { text: string; mark: string | null }[] = [
    {
      text: `Line OEE for ${inPeriod(scope)}: ${oeeEquation(o)}. Target ${pct(TARGET.oeeTarget, 0)}${o.oee.status === 'ok' ? ` — ${(Math.abs(TARGET.oeeTarget - o.oee.value!) * 100).toFixed(1)} pts ${o.oee.value! < TARGET.oeeTarget ? 'below' : 'above'}` : ''}.`,
      mark: oeeStale,
    },
    {
      text: `Availability ${metricPct(o.availability)} = kiln operating time ÷ planned production time = ${int(k.operating)} ÷ ${int(k.planned)} min (${int(k.plannedStop)} min of planned stops excluded; down ${int(k.down)}, starved ${int(k.starved)}, blocked ${int(k.blocked)} min).`,
      mark: kilnStale,
    },
    { text: `Performance ${metricPct(o.performance)} = ideal cycle ${(3600 / ideal).toFixed(2)} s × ${int(k.count)} tiles fired ÷ ${int(k.operating)} min operating (design rate ${int(ideal)} tiles/h).`, mark: kilnStale },
    { text: `Quality ${metricPct(o.quality)} = first-pass good ÷ inspected at sorting = ${int(lm.good)} ÷ ${int(lm.inspected)}.`, mark: sortStale },
  ];
  return compose(
    c,
    'oee',
    scope,
    {
      confirmed: lines.map((l) => (l.mark ? null : l.text)),
      inferred: [weakest && weakest.m.value! < 0.99 ? likely(`${weakest.name} is the largest OEE loss (${pct(1 - weakest.m.value!)} lost) — ${weakest.why}`, staleBasis('lowest of the three factors this period', oeeStale)) : null],
      unknown: lines.map((l) => (l.mark ? notConfirmed(l.mark, l.text) : null)),
      actions: [
        kilnStale ? 'Open H-KILN in the Factory Twin to check its data feed before acting on availability or performance.' : null,
        sortStale ? 'Open I-SORT in the Factory Twin to check its data feed before acting on the quality factor.' : null,
        'Ask “What are the main OEE losses this shift?” for the losses behind these factors, or open Production for the OEE breakdown.',
      ],
      method: [
        `${card.definition} Simplified demo OEE: the factors come from two counting points (kiln and sorting). Planned stops are excluded from planned time; values are never clamped (an inconsistent input shows as invalid).${oeeStale || kilnStale || sortStale ? STALE_METHOD : ''}`,
      ],
    },
    {
      facts: [
        { label: 'Line OEE', value: kvFact(card) },
        { label: 'Planned time', value: `${int(k.planned)} min` },
        { label: 'Operating time', value: marked(`${int(k.operating)} min`, kilnStale) },
        { label: 'Total count (kiln)', value: marked(int(k.count), kilnStale) },
        { label: 'Ideal rate', value: `${int(ideal)} tiles/h` },
        { label: 'Good / inspected', value: marked(`${int(lm.good)} / ${int(lm.inspected)}`, sortStale) },
      ],
      links: [wsLink('production'), ...stageLink('KILN')],
      followUps: ['What are the main OEE losses this shift?', 'Why is production below target?'],
    },
  );
}

function capacityAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s, finance } = c;
  const cap = capacityBreakdown(s, p);
  // Only real losses are ranked; tiles between the kiln and sorting are work in transit, reported apart.
  const lossSteps = cap.losses.filter((l) => l.kind !== 'transit');
  const transit = cap.losses.find((l) => l.kind === 'transit');
  const ranked = [...lossSteps].sort((a, b) => b.m2 - a.m2);
  const total = lossSteps.reduce((a, l) => a + l.m2, 0) || 1;
  const lm = lineMetrics(s, p);
  const k = lm.constraint.totals;
  const claim = constraintClaim(s);
  const kilnTop = downtimePareto(s, p, { equipmentId: 'H-KILN' })[0];
  const q = qualityIn(s, p);
  const topDefect = DEFECT_ORDER.map((d) => ({ d, n: q.byDefect[d] ?? 0 })).sort((a, b) => b.n - a.n)[0];
  const below = activeEvents(s).find((e) => e.type === 'below-rate' && e.asset.equipmentId === 'H-KILN');
  const inferred: string[] = [];
  const hypotheses: string[] = [];
  const confirmed: string[] = [];
  for (const l of ranked.filter((x) => x.m2 > 0.5).slice(0, 2)) {
    if (l.key === 'availability') {
      const parts = [
        { what: 'kiln starvation (upstream not supplying)', min: k.starved },
        { what: 'kiln blocking (downstream not taking tiles)', min: k.blocked },
        { what: `kiln stops${kilnTop ? ` (largest: ${low1(kilnTop.label)})` : ''}`, min: k.down },
      ].sort((a, b) => b.min - a.min);
      inferred.push(likely(`the availability loss is mostly ${parts[0].what}: ${int(parts[0].min)} min${isTraced(claim) ? `; ${claim.name.toLowerCase()} is currently constraining output` : ''}`, 'kiln time accounting of the period'));
    } else if (l.key === 'speed') {
      if (below) confirmed.push(inf('confirmed', `the kiln is running below its design rate (${below.id})`, 'below-rate event on the kiln'));
      else hypotheses.push(possible('the speed loss comes from short stops or a reduced speed setpoint at the kiln', 'speed loss without a below-rate event — not distinguishable from the rate signal alone'));
    } else if (l.key === 'quality') {
      inferred.push(likely(`the quality loss is rejects at sorting, largest category ${DEFECTS[topDefect.d].label.toLowerCase()} (${int(topDefect.n)} tiles)`, 'inspection counters of the period'));
    } else confirmed.push(inf('confirmed', 'planned stops (maintenance windows, changeovers) are lost by plan, recoverable only by re-planning', 'production calendar'));
  }
  const planGapM2 = Math.max(0, cap.planGapM2);
  const value = planGapM2 > 0.5 ? lostOutputValue(finance, planGapM2 / M2_PER_TILE) : null;
  // Fired tiles and the losses rest on the kiln feed, good output on the sorting feed (KPI provenance).
  const kilnStale = staleOf(constraintDowntimeKpi(s, p, lm));
  const sortStale = staleOf(goodOutputKpi(s, p, lm));
  const stale = [kilnStale, sortStale].filter((x): x is string => !!x).join('; ') || null;
  const breakdown = [
    `Fired ${area(cap.actualM2)}, first-quality ${area(cap.goodM2)} — ${pct(cap.theoreticalM2 > 0 ? cap.goodM2 / cap.theoreticalM2 : null, 0)} of theoretical.`,
    `What separates good output from theoretical, largest first (${area(cap.capacityGapM2)} in total):`,
    ...ranked.map((l, i) => `${i + 1}. ${l.label}: ${area(l.m2)} (${pct(l.m2 / total, 0)}) — ${low1(l.basis)}.`),
    ...(transit && Math.abs(transit.m2) >= 0.5 ? [`Not a loss: ${low1(transit.label)} ${area(Math.abs(transit.m2))} — ${low1(transit.basis)}.`] : []),
  ];
  return compose(
    c,
    'capacity-gap',
    periodText(c.s, p),
    {
      confirmed: [
        `Theoretical output for ${inPeriod(periodText(c.s, p))}: ${area(cap.theoreticalM2)} (kiln design rate × ${int(cap.calendarMin)} min). Plan ${area(cap.plannedM2)}.`,
        ...(stale ? [] : breakdown),
        ...confirmed,
      ],
      inferred: stale ? inferred.map((x) => x.replace(/\.$/, ` (includes simulated values the feed has not confirmed: ${stale}).`)) : inferred,
      hypotheses,
      unknown: stale ? [notConfirmed(stale, breakdown[0]), ...breakdown.slice(1)] : [],
      estimate: [
        value
          ? `Only the gap to plan is valued: ${area(planGapM2)}${sortStale ? ' (simulated running total, not confirmed by the feed)' : ''} ≈ ${money(finance.currency, value.amount)} of contribution (${value.basis}). The gap to theoretical is not a money figure — lost theoretical capacity is not lost revenue.`
          : 'Good output is at or above plan, so no financial loss is estimated; the gap to theoretical is not a money figure — lost theoretical capacity is not lost revenue.',
        value ? assumptionsText(finance, ['output']) : null,
      ],
      actions: ['Open Production for the capacity waterfall and the losses at the constraint.'],
      method: [`${cap.assumptions.join(' ')} The plan already allows for an ${pct(TARGET.oeeTarget, 0)} OEE, so theoretical output is a ceiling, not a target.`],
    },
    {
      facts: [
        { label: 'Theoretical', value: area(cap.theoreticalM2) },
        { label: 'Plan', value: area(cap.plannedM2) },
        { label: 'Fired (actual)', value: marked(area(cap.actualM2), kilnStale) },
        { label: 'First quality (good)', value: marked(area(cap.goodM2), sortStale) },
        ...ranked.map((l) => ({ label: l.label, value: marked(area(l.m2), stale) })),
      ],
      links: [wsLink('production'), ...stageLink(claim.processStage)],
      followUps: ['What are the main OEE losses this shift?', 'What is the estimated cost of the current production loss?'],
      records: [below],
    },
  );
}

function lossCost(c: Ctx, p: Period): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const lm = lineMetrics(s, p);
  const gap = Math.max(0, lm.target - lm.output);
  const shiftValue = gap > 0.5 ? lostOutputValue(finance, gap) : null;
  const active = activeEvents(s);
  const roots = active.filter((e) => !e.consequenceOf);
  const consequences = active.filter((e) => e.consequenceOf);
  const costed = roots
    .map((e) => ({ e, est: eventImpact(s, e, finance, tariffs).estimate }))
    .filter((x): x is { e: OpEvent; est: Estimate } => !!x.est && x.est.total > 0.005)
    .sort((a, b) => b.est.total - a.est.total);
  const kinds = new Set<'output' | 'reject' | 'wait'>(['output']);
  for (const x of costed) {
    if (x.e.category === 'quality') kinds.add('reject');
    if (x.e.category === 'logistics') kinds.add('wait');
  }
  const uncosted = roots.filter((e) => !costed.some((x) => x.e === e));
  const method =
    'Money figures are estimates from the editable financial assumptions (Production workspace): only good output the line could have sold is valued, at contribution margin × sold-out share; rejects at sunk cost or rework; truck waiting at detention cost. Production losses are valued only while the kiln (line constraint) was held up, so each lost tile is counted once.';
  // Good output rests on the sorting feed: while it is stale the figure is the Good output card's, not confirmed.
  const good = goodOutputKpi(s, p, lm);
  const sortStale = staleOf(good);
  const outputLine = `Good output for ${inPeriod(periodText(s, p))}: ${m2(lm.output)} against ${low1(good.target ?? `Plan ${m2(lm.target)}`)}${gap > 0.5 ? ` — ${m2(gap)} behind` : ' — at or above plan'}.`;
  const confirmed: Lines = [
    sortStale ? null : outputLine,
    roots.length
      ? `${plural(roots.length, 'active root event')}, ${costed.length} with a money estimate${uncosted.length ? `; not valued: ${uncosted.slice(0, 4).map((e) => `${e.id} (${noValueReason(e)})`).join(', ')}` : ''}.`
      : 'No event is active right now.',
    consequences.length ? `${plural(consequences.length, 'consequence event')} (${consequences.map((e) => `${e.id} → ${e.consequenceOf}`).join(', ')}) — valued under their root event, never added again.` : null,
  ];
  const unknown = [
    ...(sortStale ? [notConfirmed(sortStale, outputLine)] : []),
    'Savings cannot be established from the data — the figures are estimates of loss under stated assumptions, not verified business results.',
  ];
  if (!shiftValue && !costed.length)
    return compose(
      c,
      'loss-cost',
      periodText(c.s, p),
      {
        confirmed,
        estimate: [
          sortStale
            ? 'No production loss is valued: the simulated running total is at or above plan (not confirmed by the feed) and no active event carries a money estimate.'
            : 'No production loss to value right now: good output is at or above plan and no active event carries a money estimate.',
        ],
        unknown,
        method: [method],
      },
      { links: [wsLink('production')], followUps: ['What are the main OEE losses this shift?'] },
    );
  return compose(
    c,
    'loss-cost',
    periodText(c.s, p),
    {
      confirmed,
      inferred: costed
        .filter((x) => x.e.category === 'production' && x.e.acc.constraintMin > 0 && !ownsKiln(x.e))
        .slice(0, 3)
        .map((x) => likely(`${x.e.id} (${x.e.title}) explains ${int(x.e.acc.constraintMin)} min of kiln hold-up`, KILN_ATTRIBUTION)),
      unknown,
      estimate: [
        shiftValue
          ? `Line loss against plan so far${sortStale ? ' (from the simulated running total, not confirmed by the feed)' : ''} ≈ ${money(finance.currency, shiftValue.amount)} (${shiftValue.basis}).`
          : 'Good output is at or above plan: no line loss against plan to value.',
        ...costed.slice(0, 5).map((x) => `${x.e.id} · ${x.e.title}: ≈ ${money(x.est.currency, x.est.total)} — ${estimateLines(x.est).join('; ')}.`),
        costed.length ? 'These event estimates are not added to the period figure: the line loss of production events is already part of the gap to plan, and several quality rules can describe the same rejects.' : null,
        assumptionsText(finance, [...kinds]),
      ],
      actions: [costed[0] ? `Start with ${costed[0].e.id} — it carries the largest estimate.` : null, 'Review or edit the financial assumptions in Production.'],
      method: [method],
    },
    {
      facts: [
        { label: 'Gap to plan', value: marked(m2(gap), sortStale) },
        { label: 'Value of the gap', value: shiftValue ? money(finance.currency, shiftValue.amount) : '—' },
        { label: 'Contribution per m²', value: money(finance.currency, contributionPerM2(finance)) },
        ...costed.slice(0, 4).map((x) => ({ label: x.e.id, value: money(x.est.currency, x.est.total) })),
      ],
      links: [...costed.slice(0, 3).map((x) => eventLink(x.e)), wsLink('production')],
      followUps: costed.length ? [`What is the impact of ${costed[0].e.id}?`, 'What are the main OEE losses this shift?'] : ['What are the main OEE losses this shift?'],
      eventId: costed[0]?.e.id,
      records: [...costed.map((x) => x.e), ...consequences],
    },
  );
}

// ── Quality ───────────────────────────────────────────────────────────────────

function defectsAnswer(c: Ctx, p: Period, focus: DefectCategory | null): CopilotAnswer {
  const { s, finance } = c;
  // The one rising-defect rule (risingDefects, src/sim/metrics.ts) for the same period as the
  // Quality & Defects summary: both name the same category, or both say none is rising.
  const rise = risingDefects(s, p);
  const { from, to } = rise.window;
  const win = to >= s.minute ? `since ${when(s, from)}` : `from ${when(s, from)} to ${when(s, to)}`;
  const top = rise.rising[0] ?? null;
  const row: DefectRise = (focus ? rise.rows.find((d) => d.defect === focus) : top) ?? rise.rows[0];
  const rising = row.rising;
  const others = rise.rising.filter((d) => d !== row);
  const ratio = (d: DefectRise) => (d.ratio != null ? `${d.ratio.toFixed(1)}×` : '—');
  const T = rise.threshold;
  const rule = `≥ ${T.ratio}× its 24 h rate, with ≥ ${int(T.minInspected)} tiles inspected and a rate of at least ${pct(T.minRate)}`;
  const insp = inspectedKpi(s, p);
  const defective = defectiveKpi(s, p);
  const fpq = firstPassQualityKpi(s, p);
  const topKpi = topDefectKpi(s, p);
  // The period figures are the Quality cards'; while the sorting feed is stale they are not confirmed.
  const qStale = staleOf(insp) ?? staleOf(fpq);
  const periodLine = `In ${inPeriod(periodText(c.s, p))}: ${kv(insp)} inspected, ${kv(defective)} defective${defective.target ? ` (${defective.target})` : ''}, first-pass quality ${kv(fpq)}; most frequent defect ${topKpi.unavailable ? 'none recorded' : `${topKpi.display} (${topKpi.target})`}.`;
  const qOpen = s.events.filter((e) => e.category === 'quality' && e.status !== 'resolved').sort((a, b) => b.lastUpdate - a.lastUpdate);
  // Latest quality event of the category that overlaps the compared windows (older ones say nothing about the change).
  const evRow = s.events
    .filter((e) => e.category === 'quality' && e.refs.defect === row.defect && e.start < to && (e.end == null || e.end >= rise.reference.from))
    .sort((a, b) => b.start - a.start)[0];
  const origin = DEFECTS[row.defect].origin;
  const excess = rising ? Math.max(0, row.excessTiles) : 0;
  const cost = excess > 0.5 ? rejectCost(finance, excess) : null;
  const recs = s.inspections.filter((r) => r.result === 'reject' && r.time >= from && r.time < to && r.defect === row.defect);
  const fromScenario = recs.filter((r) => r.source === 'scenario').length;
  const cp = rising && evRow ? causeParts(evRow.causes, 2) : { confirmed: [], inferred: [], hypotheses: [] };
  const largest = rise.rows[0];
  const headline = !rise.sufficient
    ? `Too few tiles were inspected ${win} to tell whether a defect category is rising: ${int(rise.recentInspected)} inspected${rise.referenceInspected > 0 ? '' : ' and none in the 24 h before'} (the rule needs ${int(T.minInspected)}).`
    : rising
      ? `${row.label} is increasing${focus ? '' : ' the most'}: ${pct(row.recentRate, 2)} of inspected tiles ${win} versus ${pct(row.referenceRate, 2)} in the 24 h before (${ratio(row)}).`
      : focus
        ? `${row.label}: ${pct(row.recentRate, 2)} of inspected tiles ${win} versus ${pct(row.referenceRate, 2)} in the 24 h before (${ratio(row)}) — not rising by the rule (${rule}).`
        : `No defect category is rising ${win} against the 24 h before (rule: ${rule})${largest.excessTiles > 0.5 ? `; the largest increase is ${largest.label.toLowerCase()} at ${ratio(largest)} its 24 h rate` : '; every category is at or below its 24 h rate'}.`;
  return compose(
    c,
    'defects',
    `${cap1(win)} vs the 24 h before · ${periodText(c.s, p)}`,
    {
      confirmed: [
        headline,
        others.length ? `Also rising: ${others.slice(0, 3).map((d) => `${d.label.toLowerCase()} ${ratio(d)}`).join(', ')}.` : null,
        qStale ? null : periodLine,
        qOpen.length ? `Open quality events: ${qOpen.slice(0, 3).map((e) => `${e.id} ${e.title}`).join('; ')}.` : 'No quality event is open.',
        ...cp.confirmed,
      ],
      simulated: [
        'Inspection records are simulated — vision classifications (SIM-CV v0, simulated) and gauge measurements; no vision model or camera is running.',
        recs.length && (rising || focus) ? `${fromScenario} of the ${plural(recs.length, `${row.label.toLowerCase()} reject record`)} ${win} ${fromScenario === 1 ? 'was' : 'were'} produced under a quality scenario.` : null,
      ],
      inferred: cp.inferred,
      hypotheses: [
        ...cp.hypotheses,
        rising && !evRow
          ? possible(`${row.label.toLowerCase()} originates at ${STAGE_BY_ID[origin].name.toLowerCase()}`, 'modelled origin of the defect category — process knowledge, not a finding from the data')
          : null,
      ],
      unknown: [
        qStale ? notConfirmed(qStale, periodLine) : null,
        rising ? 'Why the rate rose cannot be established from inspection records alone — they show what was rejected, not the process condition that caused it.' : null,
        rise.sufficient ? null : `Whether a defect category is rising cannot be established until at least ${int(T.minInspected)} tiles are inspected in 2 h with a 24 h reference before them.`,
      ],
      estimate: cost
        ? [
            `Excess ${row.label.toLowerCase()} rejects ${win} ≈ ${int(excess)} tiles (${m2(excess)}) → scrap and rework ≈ ${money(finance.currency, cost.reduce((a, l) => a + l.amount, 0))} (${cost.map((l) => `${low1(l.label)} ${money(finance.currency, l.amount)}`).join(', ')}).`,
            rise.recentInspected > 0 ? `Effect on the quality factor of OEE in that window ≈ −${((excess / rise.recentInspected) * 100).toFixed(2)} pts.` : null,
            assumptionsText(finance, ['reject']),
          ]
        : [],
      actions: [
        rising ? `Standard check for ${row.label.toLowerCase()} (rule-based): ${DEFECT_ACTIONS[row.defect]}` : null,
        evRow ? `Review ${evRow.id} with its inspection evidence in Quality & Defects.` : rising ? 'Open Quality & Defects to inspect the latest reject records of this category.' : null,
        !rising && !focus ? 'No corrective action is indicated — no category is rising; Quality & Defects shows the trend by category.' : null,
      ],
      method: [
        `One rising-defect rule, shared with the Quality & Defects summary and the insights: rate per category = rejects of the category ÷ tiles inspected (gauge + vision) over the last 120 min of the period, against the 24 h before (hourly counters) — the comparison of the deterioration rule Q-DET, which calls a category rising at ${rule}; categories ranked by rejects above their 24 h rate. Period figures are the Quality & Defects cards for ${inPeriod(periodText(c.s, p))}.`,
      ],
    },
    {
      facts: [
        { label: 'Tiles inspected', value: kvFact(insp) },
        { label: 'Defective tiles', value: kvFact(defective) },
        { label: 'First-pass quality', value: kvFact(fpq) },
        { label: 'Most frequent defect', value: topKpi.unavailable ? 'None recorded' : topKpi.display },
        ...rise.rows.slice(0, 3).map((d) => ({ label: `${d.label} trend`, value: d.ratio != null ? `${d.ratio.toFixed(1)}× · ${pct(d.recentRate, 2)}${d.rising ? ' · rising' : ''}` : '—' })),
      ],
      links: [...(evRow ? [defectLink(evRow), eventLink(evRow)] : []), ...equipmentLink('I-VIS'), ...equipmentLink(STAGE_BY_ID[origin].machines[0]), wsLink('quality')],
      followUps: ['Show the report and evidence for the latest defect.', 'Which equipment should be investigated first?'],
      eventId: evRow?.id,
      records: [evRow, ...qOpen.slice(0, 2)],
    },
  );
}

function defectReport(c: Ctx, focus: DefectCategory | null): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const ctxEv = c.eventId ? eventById(s, c.eventId) : undefined;
  const pick =
    (ctxEv && ctxEv.category === 'quality' && (!focus || ctxEv.refs.defect === focus) ? ctxEv : undefined) ??
    s.events.filter((e) => e.category === 'quality' && (!focus || e.refs.defect === focus)).sort((a, b) => b.start - a.start || b.lastUpdate - a.lastUpdate)[0];
  const label = focus ? DEFECTS[focus].label.toLowerCase() : 'any defect';
  if (!pick) {
    const rec = [...s.inspections].reverse().find((r) => r.result === 'reject' && (!focus || r.defect === focus));
    return compose(
      c,
      'defect-report',
      'Simulated history',
      {
        confirmed: [
          `No quality event has been raised for ${label} in the demo history, so there is no defect report yet.`,
          rec ? `Latest reject record: ${rec.id} at ${when(s, rec.time)} — ${rec.defect ? DEFECTS[rec.defect].label.toLowerCase() : 'reject'}${rec.severity ? ` (${rec.severity})` : ''}${recordBasis(rec)}.` : 'No reject record is available.',
        ],
        simulated: ['Inspection records are simulated — vision classifications (SIM-CV v0, simulated) and gauge measurements.'],
        actions: ['Open Quality & Defects to browse the inspection records.'],
        method: [`Quality events are raised by the reject-rate, count, repeat, deterioration and critical-defect rules on simulated inspection records — no vision model.${rec ? ` ${recordMethod([rec])}` : ''}`],
      },
      { links: [wsLink('quality')], followUps: ['Which defect category is increasing?'] },
    );
  }
  const rep = buildEventReport(s, pick.id, { finance, tariffs, generatedAt: toIso(s.minute) })!;
  const recs = rep.visualEvidence
    .filter((x) => x.kind === 'inspection-image' && x.status === 'available' && x.inspectionId)
    .map((x) => s.inspections.find((r) => r.id === x.inspectionId))
    .filter((r): r is NonNullable<typeof r> => !!r);
  const counts = rep.supportingEvidence.find((x) => x.kind === 'metrics')?.metrics ?? [];
  const cams = rep.visualEvidence.filter((x) => x.kind === 'camera-snapshot');
  const est = rep.impact.estimate;
  const station = pick.asset.stationId === 'ST-GAUGE' ? 'I-GAUGE' : 'I-VIS';
  const cp = causeParts(rep.diagnosis.causes, 3);
  return compose(
    c,
    'defect-report',
    `${when(s, pick.start)} → ${pick.end == null ? 'now' : when(s, pick.end)}`,
    {
      confirmed: [
        `${rep.summary.id} · ${rep.summary.title} — ${rep.summary.severity.toLowerCase()}, ${rep.summary.status.toLowerCase()}, condition ${rep.summary.condition.toLowerCase()}; detected ${formatDateTime(pick.start)} by rule ${rep.detection.rule} (${rep.detection.ruleLabel}).`,
        rep.summary.text,
        recs.length
          ? `Inspection evidence: ${recs.map((r) => `${r.id} ${r.defect ? DEFECTS[r.defect].label.toLowerCase() : 'reject'}${r.severity ? ` (${r.severity})` : ''} at ${when(s, r.time)}${recordBasis(r)}`).join('; ')}.`
          : 'No individual inspection record falls in the event window.',
        counts.length ? `Counts in the window: ${counts.map((m) => `${low1(m.label)} ${m.value}${m.unit && m.unit !== '%' ? ` ${m.unit}` : ''}`).join(', ')}.` : null,
        ...cams.map((x) => `${x.title}: ${x.status === 'available' ? `captured — ${x.originLabel.toLowerCase()}` : x.status === 'pending' ? 'being captured' : `unavailable — ${x.unavailableReason ?? 'no view'}`}.`),
        ...cp.confirmed,
      ],
      simulated: [
        pick.asset.stationId === 'ST-GAUGE'
          ? 'Gauge records are simulated laser measurements — not camera evidence.'
          : 'Inspection frames are illustrative and the classification is simulated (SIM-CV v0, simulated) — not camera evidence.',
      ],
      inferred: cp.inferred,
      hypotheses: cp.hypotheses,
      unknown: [
        rep.provenance.unavailable.length ? `Not available: ${rep.provenance.unavailable.map((u) => `${u.title} (${low1(u.reason)})`).join('; ')}.` : null,
        ...rep.diagnosis.uncertainty.slice(0, 2),
      ],
      estimate: est && est.total > 0.005 ? [`Estimated impact ≈ ${money(est.currency, est.total)}: ${estimateLines(est).join('; ')}.`, `Assumptions: ${est.assumptions.join(' ')}`] : [],
      actions: [...pick.recommendations.slice(0, 2), `Open ${pick.id} in Quality & Defects for the frames, or in Events & Reports for the full report and PDF.`],
      method: [`Same report model as Events & Reports and the PDF export, built from the event record ${pick.id}. ${recordMethod(recs, pick.asset.stationId)}`],
    },
    {
      facts: [
        { label: 'Event', value: pick.id },
        { label: 'Category', value: pick.refs.defect ? DEFECTS[pick.refs.defect].label : 'All categories' },
        { label: 'Status', value: EVENT_STATUS_LABEL[pick.status] },
        { label: 'Records', value: recs.map((r) => r.id).join(', ') || '—' },
      ],
      links: [defectLink(pick), eventLink(pick), ...equipmentLink(station), wsLink('quality')],
      followUps: [`Why did ${pick.id} happen?`, `What is the impact of ${pick.id}?`],
      eventId: pick.id,
      records: [pick],
    },
  );
}

// ── Fleet & Movement ──────────────────────────────────────────────────────────

function delayedVehiclesAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const now = s.minute;
  const kpi = delayedVehiclesKpi(s);
  const delayed = delayedTrucks(s);
  const dwell = avgDwellKpi(s, p);
  const ext = externalVehicles(s).filter((v) => v.visit!.gateIn <= now && v.visit!.gateOut == null);
  const queue = ext
    .filter((v) => v.phase === 'waiting')
    .map((v) => ({ v, min: visitDurations(v, now).waiting ?? 0 }))
    .sort((a, b) => b.min - a.min);
  const delayedIds = new Set(delayed.map((d) => d.id));
  const queueOnly = queue.filter((x) => !delayedIds.has(x.v.id));
  const docksBusy = DOCKS.filter((d) => s.logistics.docks[d.id]?.vehicleId).length;
  const vehicleEvents = s.events
    .filter((e) => e.category === 'logistics' && e.status !== 'resolved' && e.asset.vehicleId && (delayedIds.has(e.asset.vehicleId) || queue.some((x) => x.v.id === e.asset.vehicleId)))
    .sort((a, b) => b.start - a.start);
  const congestion = s.events.filter((e) => e.type === 'yard-congestion' && e.end == null);
  const evOf = (vid: string) => vehicleEvents.find((e) => e.asset.vehicleId === vid);
  const truckOf = (id: string) => s.logistics.vehicles[id] as TruckRuntime | undefined;
  const injected = [...delayed.map((d) => truckOf(d.id)), ...queue.map((x) => x.v)].filter((v): v is TruckRuntime => !!v?.visit?.scenarioId);
  const waitCost = vehicleEvents.filter((e) => e.type === 'truck-waiting').reduce((a, e) => a + (eventImpact(s, e, finance, tariffs).estimate?.total ?? 0), 0);
  const worst = delayed[0];
  const worstEv = worst ? evOf(worst.id) : undefined;
  return compose(
    c,
    'delayed-vehicles',
    'Now',
    {
      confirmed: [
        `Waiting or delayed now: ${kv(kpi)}${kpi.target ? ` (${kpi.target})` : ''} — ${low1(kpi.status?.label ?? '')}.`,
        delayed.length ? `Past a limit (${delayed.length}), most over first:` : 'No truck has exceeded the waiting, dock or turnaround limit.',
        ...delayed.map((d, i) => {
          const e = evOf(d.id);
          return `${i + 1}. ${d.label} — ${low1(d.reason)} ${int(d.minutes)} min (limit ${d.limit} min, ${int(d.minutes - d.limit)} min over)${e ? ` · ${e.id}` : ''}.`;
        }),
        queueOnly.length ? `In the dock queue, not yet past a limit: ${queueOnly.slice(0, 5).map((x) => `${x.v.label} waiting ${int(x.min)} min`).join(', ')}.` : null,
        `Docks occupied: ${docksBusy} of ${DOCKS.length}.`,
        `Average truck dwell in ${inPeriod(periodText(c.s, p))}: ${kv(dwell)}${dwell.target ? ` (${dwell.target})` : ''}.`,
        congestion.length ? `Active yard-congestion event: ${congestion.map((e) => e.id).join(', ')}.` : null,
      ],
      simulated: [
        'Vehicle positions, gate and dock events are simulated at zone level — no GPS, ANPR or tracking system is connected.',
        ...[...new Set(injected.map((v) => v.visit!.scenarioId!))].map((id) => {
          const sc = s.scenarios.find((x) => x.id === id);
          const vs = [...new Set(injected.filter((v) => v.visit!.scenarioId === id).map((v) => v.label))];
          return `${vs.length === 1 ? vs[0] : `${vs.length} of these trucks (${vs.slice(0, 3).join(', ')}${vs.length > 3 ? ', …' : ''})`} ${vs.length === 1 ? 'was' : 'were'} added or held by the scenario “${sc?.label ?? 'presenter scenario'}”${sc ? ` (${when(s, sc.start)})` : ''}; the other trucks come from the simulation's own arrival schedule.`;
        }),
      ],
      inferred: [
        ...delayed.slice(0, 3).map((d) => {
          const v = truckOf(d.id);
          if (!v?.visit) return null;
          const dd = visitDurations(v, now);
          const onSite = now - v.visit.gateIn;
          const parts = [
            { what: 'waiting for a dock', min: dd.waiting ?? 0 },
            { what: 'at the dock (loading / unloading)', min: dd.dockTime ?? 0 },
          ];
          parts.push({ what: 'at the gate, weighbridge and on the yard roads', min: Math.max(0, onSite - parts[0].min - parts[1].min) });
          const top = [...parts].sort((a, b) => b.min - a.min)[0];
          return likely(`${d.label} has spent most of its ${int(onSite)} min on site ${top.what} (${int(top.min)} min)`, 'gate, check-in and dock timestamps of the visit (simulated)');
        }),
        queue.length && docksBusy === DOCKS.length ? likely(`trucks queue because all ${DOCKS.length} docks are occupied`, 'dock occupancy now') : null,
      ],
      hypotheses: [
        delayed.some((d) => d.reason === 'At the dock' && !truckOf(d.id)?.visit?.scenarioId)
          ? possible('loading is slow or the dispatch documents are not ready for the truck held at its dock', 'the data records dock time, not the reason for it')
          : null,
      ],
      unknown: [
        delayed.length || queue.length ? 'Why a truck is held beyond its queue or dock time (documents, loading crew, driver) cannot be established — only gate, check-in and dock timestamps are recorded.' : null,
        'Forklifts and the loader have no delay rule, so whether internal vehicles are delayed cannot be established.',
      ],
      estimate:
        waitCost > 0.005 ? [`Detention for waiting beyond the ${s.rules.truckWaitMax}-min threshold on these trucks ≈ ${money(finance.currency, waitCost)} (their truck-waiting events).`, assumptionsText(finance, ['wait'])] : [],
      actions: [
        worst ? `Check ${worst.label} first in Fleet & Movement — it is the furthest past its limit (${low1(worst.reason)}).` : null,
        worstEv ? `Acknowledge or investigate ${worstEv.id} in Events & Reports.` : null,
        queue.length && docksBusy === DOCKS.length ? 'Free the dock held longest so the queue can move.' : null,
        !delayed.length && !queue.length ? 'No action needed: no truck is waiting or past a limit.' : null,
      ],
      method: [`${kpi.definition} Same figures as the Fleet & Movement cards.`],
    },
    {
      facts: [
        { label: 'Waiting or delayed', value: kvFact(kpi) },
        { label: 'Past a limit', value: String(delayed.length) },
        { label: 'In the dock queue', value: String(queue.length) },
        { label: 'Average truck dwell', value: kvFact(dwell) },
        ...delayed.slice(0, 4).map((d) => ({ label: d.label, value: `${d.reason} · ${int(d.minutes)} min (limit ${d.limit})` })),
      ],
      links: [...delayed.slice(0, 3).map((d) => fleetLink(s, d.id)), ...vehicleEvents.slice(0, 2).map((e) => eventLink(e)), wsLink('fleet')],
      followUps: ['Which trucks exceeded their turnaround threshold?', 'Which equipment should be investigated first?'],
      eventId: worstEv?.id,
      records: [...vehicleEvents, ...congestion],
    },
  );
}

function turnaroundAnswer(c: Ctx): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const max = s.rules.turnaroundMax;
  const now = s.minute;
  const onSite = externalVehicles(s)
    .filter((v) => v.visit!.gateIn <= now)
    .map((v) => ({ v, min: now - v.visit!.gateIn, onSite: true }))
    .sort((a, b) => b.min - a.min);
  const over = onSite.filter((x) => x.min >= max);
  const from = now - 1440;
  const done = s.logistics.departed
    .filter((v) => v.visit!.gateOut != null && v.visit!.gateOut >= from && v.visit!.gateOut - v.visit!.gateIn >= max)
    .map((v) => ({ v, min: v.visit!.gateOut! - v.visit!.gateIn, onSite: false }))
    .sort((a, b) => b.v.visit!.gateOut! - a.v.visit!.gateOut!);
  const longest = s.logistics.departed
    .filter((v) => v.visit?.gateOut != null && v.visit.gateOut >= from)
    .map((v) => ({ v, min: v.visit!.gateOut! - v.visit!.gateIn, onSite: false }))
    .sort((a, b) => b.min - a.min)[0];
  const evs = s.events.filter((e) => e.type === 'turnaround-exceeded' && (e.end == null || e.end >= from)).sort((a, b) => b.start - a.start);
  const evOf = (vid: string) => evs.find((e) => e.asset.vehicleId === vid);
  const describe = (x: { v: (typeof onSite)[number]['v']; min: number; onSite: boolean }) => {
    const e = evOf(x.v.id);
    return `${x.v.label} ${int(x.min)} min${x.onSite ? ` (${phaseLabel[x.v.phase ?? 'waiting'].toLowerCase()})` : ` (left ${when(s, x.v.visit!.gateOut!)})`}${e ? ` · ${e.id}` : ''}`;
  };
  const why = [...over, ...done].slice(0, 3).map((x) => {
    const d = visitDurations(x.v, now);
    const parts = [
      { what: 'waiting for a dock', min: d.waiting ?? 0 },
      { what: 'at the dock (loading / unloading)', min: d.dockTime ?? 0 },
    ];
    parts.push({ what: 'at the gate, weighbridge and on the yard roads', min: Math.max(0, x.min - parts[0].min - parts[1].min) });
    const top = parts.sort((a, b) => b.min - a.min)[0];
    return likely(`${x.v.label} spent most of its ${int(x.min)} min ${top.what} (${int(top.min)} min)`, 'gate, check-in and dock timestamps of the visit (simulated)');
  });
  const waitEvents = s.events.filter((e) => e.type === 'truck-waiting' && [...over, ...done].some((x) => x.v.id === e.asset.vehicleId));
  const waitCost = waitEvents.reduce((a, e) => a + (eventImpact(s, e, finance, tariffs).estimate?.total ?? 0), 0);
  const ids = [...over, ...done].map((x) => x.v.id);
  return compose(
    c,
    'turnaround',
    'Now and the last 24 h',
    {
      confirmed: [
        `Threshold: ${max} min on site from gate-in to gate-out (rule L-TURN).`,
        over.length ? `On site now above the threshold (${over.length}): ${over.map(describe).join(', ')}.` : onSite.length ? `No truck on site is above the threshold now; longest on site: ${describe(onSite[0])}.` : 'No truck is on site now.',
        done.length
          ? `Completed visits above the threshold in the last 24 h (${done.length}): ${done.slice(0, 5).map(describe).join(', ')}.`
          : `No completed visit in the last 24 h exceeded the threshold${longest ? `; longest: ${describe(longest)}` : ''}.`,
        evs.length ? `Turnaround events: ${evs.slice(0, 4).map((e) => `${e.id} (${e.asset.vehicleId}, ${EVENT_STATUS_LABEL[e.status].toLowerCase()})`).join(', ')}.` : null,
      ],
      simulated: ['Vehicle positions and gate events are simulated at zone level — no GPS or ANPR is connected.'],
      inferred: why,
      unknown: [over.length || done.length ? 'Why the time was spent (documents, loading crew, driver) cannot be established — only the visit timestamps are recorded.' : null],
      estimate: waitCost > 0.005 ? [`Detention for waiting beyond the ${s.rules.truckWaitMax}-min threshold on these trucks ≈ ${money(finance.currency, waitCost)} (their truck-waiting events).`, assumptionsText(finance, ['wait'])] : [],
      actions: [over[0] ? `Check ${over[0].v.label} in Fleet & Movement — it is on site longest.` : null, evs[0] ? `Review ${evs[0].id} in Events & Reports.` : null],
      method: ['Turnaround = gate-out − gate-in from the simulated gate events; for trucks still on site, the time since gate-in.'],
    },
    {
      facts: [...over, ...done].slice(0, 6).map((x) => ({ label: x.v.label, value: `${int(x.min)} min · ${x.onSite ? phaseLabel[x.v.phase ?? 'waiting'] : 'departed'}` })),
      links: [...over.slice(0, 2).map((x) => fleetLink(s, x.v.id)), ...evs.filter((e) => ids.includes(e.asset.vehicleId ?? '')).slice(0, 2).map((e) => eventLink(e)), wsLink('fleet')],
      followUps: evs[0] ? [`Why did ${evs[0].id} happen?`, 'Which vehicles are delayed?'] : ['Which vehicles are delayed?'],
      eventId: evs[0]?.id,
      records: evs.slice(0, 4),
    },
  );
}

function logisticsAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s } = c;
  const fm = fleetMetrics(s, p);
  const docked = Object.values(s.logistics.docks).filter((d) => d.vehicleId).length;
  const open = s.events.filter((e) => e.category === 'logistics' && e.end == null);
  return compose(
    c,
    'logistics',
    periodText(c.s, p),
    {
      confirmed: [
        `${plural(fm.onSite, 'external vehicle')} on site: ${fm.waiting} waiting for a dock, ${fm.atDock} loading or unloading; ${docked} of ${Object.keys(s.logistics.docks).length} docks occupied.`,
        `In ${inPeriod(periodText(c.s, p))}: ${plural(fm.completedVisits, 'visit')} completed, average turnaround ${fm.avgTurnaround != null ? `${int(fm.avgTurnaround)} min` : '—'}, gate-to-dock ${fm.avgGateToDock != null ? `${int(fm.avgGateToDock)} min` : '—'}, dock utilisation ${pct(fm.dockUtilisation, 0)}.`,
        open.length ? `Active vehicle events: ${open.slice(0, 4).map((e) => `${e.id} ${e.title}`).join('; ')}.` : 'No vehicle event is active.',
      ],
      simulated: ['Vehicle positions and gate events are simulated at zone level; no GPS, ANPR or indoor positioning is connected.'],
      actions: ['Ask “Which vehicles are delayed?” for trucks past a limit, or open Fleet & Movement.'],
      method: ['Fleet metrics of the period from the simulated gate and dock events.'],
    },
    {
      facts: [
        { label: 'On site', value: String(fm.onSite) },
        { label: 'Waiting', value: String(fm.waiting) },
        { label: 'Warehouse stock', value: `${fm.stockPallets} pallets` },
      ],
      links: [...open.slice(0, 2).map((e) => eventLink(e)), wsLink('fleet')],
      followUps: ['Which vehicles are delayed?', 'Which trucks exceeded their turnaround threshold?'],
      records: open.slice(0, 4),
    },
  );
}

/**
 * One vehicle: where it is (the geofence of its current simulated route leg, at zone level), whether it
 * moves or stands and for how long, its task or visit phase, its visit times against the waiting, dock
 * and turnaround limits (trucks) or its idle share of the last hour (internal vehicles), and its open
 * events. Read from the same route legs and visit records as Fleet & Movement and the twin's panel.
 */
function vehicleAnswer(c: Ctx, id: string): CopilotAnswer {
  const { s } = c;
  const now = s.minute;
  const v = s.logistics.vehicles[id];
  const legs = v.legs.filter((l) => l.start <= now);
  const leg = legs[legs.length - 1] ?? null;
  const zone = leg ? (GEOFENCES.find((g) => g.id === leg.zone)?.name ?? leg.zone) : null;
  const truck = v.class === 'external' ? (v as TruckRuntime) : null;
  const vis = truck?.visit ?? null;
  const gone = (v.despawned != null && v.despawned <= now) || !s.logistics.active.includes(v.id);
  const open = s.events.filter((e) => e.asset.vehicleId === id && e.status !== 'resolved').sort((a, b) => b.start - a.start);
  const kind = truck ? (vis?.direction === 'inbound' ? 'inbound tipper' : 'outbound truck') : v.type === 'forklift' ? 'forklift' : 'wheel loader';
  const confirmed: Lines = [];
  const actions: Lines = [];
  const facts: CopilotAnswer['facts'] = [];
  if (gone) {
    const out = vis?.gateOut;
    confirmed.push(`${v.label} (${kind}) is no longer on site${out != null ? `: it left through the main gate at ${when(s, out)}` : ''}${vis && out != null ? ` after a turnaround of ${int(out - vis.gateIn)} min (limit ${s.rules.turnaroundMax} min)` : ''}.`);
    actions.push('Nothing to do on site; its record stays in Fleet & Movement.');
  } else if (vis && vis.gateIn > now) {
    confirmed.push(`${v.label} (${kind}) has not passed the gate yet: gate-in is due at ${when(s, vis.gateIn)}.`);
  } else {
    const moving = leg != null && leg.moving && leg.end > now;
    let since = leg?.start ?? now;
    for (let i = legs.length - 2; i >= 0 && !legs[i].moving && !moving; i--) since = legs[i].start;
    confirmed.push(
      `${v.label} (${kind}) is ${moving ? 'moving' : `stationary for ${int(now - since)} min`}${zone ? ` in ${zone}` : ''}${leg ? ` — ${low1(leg.activity)}` : ''} (simulated route, zone level).`,
    );
    facts.push({ label: 'Location', value: zone ?? '—' }, { label: 'Movement', value: moving ? 'Moving' : `Stationary ${int(now - since)} min` });
    if (truck && vis) {
      const d = visitDurations(truck, now);
      const onSite = now - vis.gateIn;
      confirmed.push(
        `Visit: ${phaseLabel[truck.phase ?? 'approaching'].toLowerCase()}; on site ${int(onSite)} min of the ${s.rules.turnaroundMax} min turnaround limit${d.waiting != null ? `; waited ${int(d.waiting)} min for a dock (limit ${s.rules.truckWaitMax} min)` : ''}${d.dockTime != null ? `; ${int(d.dockTime)} min at the dock (limit ${s.rules.dockStayMax} min)` : ''}.`,
      );
      facts.push({ label: 'Visit phase', value: phaseLabel[truck.phase ?? 'approaching'] }, { label: 'On site', value: `${int(onSite)} min · limit ${s.rules.turnaroundMax} min` });
      const over = [
        d.waiting != null && truck.phase === 'waiting' && d.waiting > s.rules.truckWaitMax ? `waiting ${int(d.waiting - s.rules.truckWaitMax)} min past its limit` : null,
        d.dockTime != null && vis.dockEnd == null && d.dockTime > s.rules.dockStayMax ? `at the dock ${int(d.dockTime - s.rules.dockStayMax)} min past its limit` : null,
        onSite > s.rules.turnaroundMax ? `on site ${int(onSite - s.rules.turnaroundMax)} min past the turnaround limit` : null,
      ].filter((x): x is string => !!x);
      if (over.length) actions.push(`${v.label} is ${over.join(', ')}: ${truck.phase === 'waiting' ? 'release the dock closest to completion first, or re-sequence the queue' : 'check the loading / paperwork status with the dock supervisor'}.`);
      else actions.push(`No visit limit is exceeded — no action needed for ${v.label}.`);
    } else {
      const act = internalActivity(v, now);
      if (act.idleLastHour != null) {
        confirmed.push(`Idle or waiting ${int(act.idleLastHour)} min of the last 60 min (utilisation ${pct(1 - act.idleLastHour / 60, 0)}).`);
        facts.push({ label: 'Idle · last hour', value: `${int(act.idleLastHour)} min` });
      }
      actions.push(act.idleLastHour != null && act.idleLastHour >= 40 ? `${v.label} has spare handling capacity — it can take work from a busier vehicle.` : `No action needed for ${v.label}.`);
    }
  }
  if (open.length) {
    confirmed.push(`Open event${open.length === 1 ? '' : 's'}: ${open.slice(0, 3).map((e) => `${e.id} ${e.title}`).join('; ')}.`);
    actions.unshift(`Ask “What should we do about ${open[0].id}?” for the event's recommended response.`);
  } else confirmed.push('No open event on this vehicle.');
  return compose(
    c,
    'vehicle',
    'Now',
    {
      confirmed,
      simulated: ['Vehicle positions, route legs and gate / dock events are simulated at zone level — no GPS, telematics or indoor positioning is connected.'],
      actions,
      method: ['Current simulated route leg (position at zone level, activity), the visit record against the configured waiting, dock and turnaround limits (trucks), and the activity log of the last hour (internal vehicles).'],
    },
    {
      facts,
      links: [fleetLink(s, id), ...open.slice(0, 2).map((e) => eventLink(e))],
      followUps: ['Which vehicles are delayed?', ...(open[0] ? [`What should we do about ${open[0].id}?`] : [])],
      records: open.slice(0, 4),
    },
  );
}

// ── Incidents ─────────────────────────────────────────────────────────────────

function investigateFirst(c: Ctx, equipmentFocus: boolean): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const list = attentionEvents(s);
  const kpi = activeIssuesKpi(s);
  const method =
    'Issues requiring attention, ranked exactly as on the Overview: unresolved events of warning severity or above, counted once per root cause (knock-on events are part of their root), most severe first, then still active, then newest.';
  if (!list.length) {
    const watch = healthAssessments(s)
      .filter((h) => h.level === 'watch' || h.level === 'warning' || h.level === 'alarm')
      .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.score - b.score);
    return compose(
      c,
      'investigate-first',
      'Now',
      {
        confirmed: [`Issues requiring attention: ${kv(kpi)} — ${low1(kpi.why)}`, `By the event rules, no ${equipmentFocus ? 'equipment' : 'issue'} needs investigating right now.`],
        hypotheses: watch.slice(0, 2).map((h) => possible(`${h.id} (${nameOf(h.id)}) shows an abnormal condition pattern (${h.level}, health ${h.score}/100) that has not raised an event`, 'rule-based condition monitoring on simulated signals')),
        actions: [watch[0] ? `Keep an eye on ${watch[0].id} in the Factory Twin (condition).` : 'Nothing to investigate — check again after the next change.'],
        method: [method],
      },
      { facts: [{ label: 'Issues requiring attention', value: kvFact(kpi) }], links: [wsLink('overview'), ...equipmentLink(watch[0]?.id)], followUps: ['Why is production below target?'] },
    );
  }
  const top = list[0];
  const target = equipmentFocus ? (list.find((e) => equipmentOf(e) != null) ?? top) : top;
  const est = eventImpact(s, target, finance, tariffs).estimate;
  const consOf = (e: OpEvent) => s.events.filter((o) => o.consequenceOf === e.id && o.status !== 'resolved');
  const eq = equipmentOf(target);
  const cp = causeParts(target.causes, 2);
  return compose(
    c,
    'investigate-first',
    'Now',
    {
      confirmed: [
        `Issues requiring attention: ${kv(kpi)} (${low1(kpi.status?.label ?? '')}) — ${low1(kpi.why)}`,
        'Ranked as on the Overview — severity, then still active, then newest:',
        ...list.slice(0, 5).map(
          (e, i) =>
            `${i + 1}. ${e.id} · ${cap1(e.severity)} · ${e.title} — ${assetText(s, e)} · ${e.end == null ? `active ${formatDuration(s.minute - e.start)}` : `cleared ${when(s, e.end)}, not yet resolved`}${consOf(e).length ? `, +${plural(consOf(e).length, 'knock-on event')}` : ''} · ${e.status === 'active' ? 'not yet acknowledged' : EVENT_STATUS_LABEL[e.status].toLowerCase()}.`,
        ),
        equipmentFocus && target !== top ? `The top issue concerns ${assetText(s, top)}; the first equipment in the ranking is ${eq} (${target.id}).` : null,
        equipmentFocus && !eq ? 'None of the issues requiring attention concerns a piece of equipment.' : null,
        ownsKiln(target) && target.acc.constraintMin > 0 ? `${target.id} has held the kiln up ${int(target.acc.constraintMin)} min — line output lost.` : null,
        ...cp.confirmed,
      ],
      inferred: [
        !ownsKiln(target) && target.acc.constraintMin > 0 ? likely(`${target.id} has cost ${int(target.acc.constraintMin)} min of kiln time — line output lost`, KILN_ATTRIBUTION) : null,
        ...cp.inferred,
      ],
      hypotheses: cp.hypotheses.map((x) => x.replace(/^Possible: /, 'Possible: suspected cause — ')),
      estimate: est && est.total > 0.005 ? [`${target.id} has cost ≈ ${money(est.currency, est.total)} so far: ${estimateLines(est).join('; ')}.`, `Assumptions: ${est.assumptions.join(' ')}`] : [],
      actions: [
        `Investigate ${target.id} (${target.title}${eq ? ` on ${eq}` : ''}) first: open it in Events & Reports, acknowledge it and start the investigation.`,
        ...target.recommendations.slice(0, 1).map((r) => `Standard first response (rule-based): ${r}`),
        list.find((e) => e !== target) ? `Then ${list.find((e) => e !== target)!.id} (${list.find((e) => e !== target)!.title}).` : null,
      ],
      method: [method],
    },
    {
      facts: [{ label: 'Issues requiring attention', value: kvFact(kpi) }, ...list.slice(0, 5).map((e) => ({ label: `${e.id} · ${e.title}`, value: `${cap1(e.severity)} · ${EVENT_STATUS_LABEL[e.status]}` }))],
      links: [eventLink(target), ...assetLinks(s, target), ...list.filter((e) => e !== target).slice(0, 2).map((e) => eventLink(e))],
      followUps: [`What happened in ${target.id}?`, `What should we do about ${target.id}?`, 'Why is production below target?'],
      eventId: target.id,
      records: list.slice(0, 5),
    },
  );
}

function nextActionsAnswer(c: Ctx): CopilotAnswer {
  const { s, tariffs } = c;
  const acts = nextActions(s, { tariffs }).filter((a) => a.kind !== 'energy');
  if (!acts.length)
    return compose(
      c,
      'next-actions',
      'Now',
      { confirmed: ['Nothing needs intervention right now: no stoppage, condition warning, quality or vehicle exception is active.'], method: ['Rule-based insights over the current state.'] },
      { followUps: SUGGESTED_QUESTIONS.slice(0, 3) },
    );
  return compose(
    c,
    'next-actions',
    'Now',
    {
      confirmed: acts.slice(0, 4).map((a) => `${a.title}: ${a.summary}`),
      actions: acts.map((a, i) => `${i + 1}. ${a.title} — ${a.recommendation}`),
      method: ['Recommendations are rule-based insights over the current state, in priority order (severity, then impact).'],
    },
    {
      facts: acts.slice(0, 4).map((a) => ({ label: a.title, value: a.impact ?? a.severity })),
      links: acts.flatMap((a) => a.links.slice(0, 1)).slice(0, 4),
      followUps: ['Which equipment should be investigated first?', 'Why is production below target?'],
    },
  );
}

/** "What happened during this incident?" with no event chosen: which incidents there are to choose from. */
function eventMissing(c: Ctx, id?: string): CopilotAnswer {
  const { s } = c;
  const list = attentionEvents(s);
  const onAsset = c.equipmentId ? list.filter((e) => equipmentOf(e) === c.equipmentId) : [];
  const candidates = [...onAsset, ...list.filter((e) => !onAsset.includes(e))].slice(0, 5);
  return compose(
    c,
    'event-missing',
    '—',
    {
      confirmed: [
        id ? `There is no event ${id} in the current demo state.` : 'No incident is selected, so “this incident” cannot be identified.',
        candidates.length
          ? `Open issues you can investigate${onAsset.length ? ` (${c.equipmentId} first)` : ''}, ranked as on the Overview:`
          : 'No issue requires attention right now — every warning-or-above event is resolved.',
        ...candidates.map((e, i) => `${i + 1}. ${e.id} · ${cap1(e.severity)} · ${e.title} — ${assetText(s, e)}.`),
      ],
      unknown: [
        id
          ? `What happened in ${id} cannot be established — Reset Demo replays the plant and restarts event ids, so earlier ids no longer exist.`
          : 'What happened during “this incident” cannot be established until an incident is chosen.',
      ],
      actions: [candidates.length ? 'Pick an incident (Investigate an incident on the Copilot page, or the follow-ups below), or open one in Events & Reports and ask from there.' : 'Open Events & Reports to browse resolved events.'],
      method: ['Event investigation reads one event record and its report model; it needs to know which event.'],
    },
    {
      links: [...candidates.slice(0, 3).map((e) => eventLink(e)), wsLink('events')],
      followUps: candidates.slice(0, 3).map((e) => `What happened in ${e.id}?`),
      records: candidates,
    },
  );
}

// ── Equipment, energy, process parameters ─────────────────────────────────────

const healthText = (h: HealthAssessment) => (h.level === 'offline' ? 'not running, not assessed' : `${h.score}/100 · ${h.level}`);

function healthAnswer(c: Ctx, machine: string | null): CopilotAnswer {
  const { s } = c;
  const list = machine && HEALTH_BY_ID[machine] ? [assess(s, machine)] : healthAssessments(s);
  // Most severe level first, lowest score first within a level; offline (not assessed) last.
  const ranked = [...list].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.score - b.score);
  if (!ranked.length)
    return compose(
      c,
      'health',
      'Last 3 h of signals',
      {
        confirmed: [`${machine ? `${machine} (${nameOf(machine)})` : 'This asset'} has no condition monitoring in this demo.`],
        unknown: ['Its condition cannot be established — only six process assets carry simulated condition signals.'],
        method: ['Condition monitoring is rule-based on simulated vibration and bearing-temperature signals of six assets.'],
      },
      { links: equipmentLink(machine) },
    );
  const worst = ranked.find((h) => h.level !== 'offline') ?? ranked[0];
  const atRisk = ranked.filter((h) => h.level === 'warning' || h.level === 'alarm' || h.level === 'watch');
  const offline = ranked.filter((h) => h.level === 'offline');
  const ev = s.events.find((e) => e.dedupeKey === `cond:${worst.id}` && e.end == null);
  return compose(
    c,
    'health',
    'Last 3 h of signals',
    {
      confirmed: [
        worst.level === 'offline'
          ? `${worst.id} (${nameOf(worst.id)}) is not running, so it is not assessed.`
          : atRisk.length
            ? `${plural(atRisk.length, 'asset')} ${atRisk.length > 1 ? 'show' : 'shows'} an abnormal pattern. Most at risk: ${worst.id} (${nameOf(worst.id)}), health ${worst.score}/100, level ${worst.level}.`
            : `All monitored assets that are running are within normal limits. Lowest health score: ${worst.id} at ${worst.score}/100.`,
        ...worst.findings,
        offline.length && worst.level !== 'offline' ? `Not running, not assessed: ${offline.map((h) => h.id).join(', ')}.` : null,
      ],
      simulated: ['Condition signals (vibration, bearing temperature) are simulated — no physical sensor is connected.'],
      hypotheses: [worst.etaTripH != null ? possible(`${worst.id} reaches its trip limit in ≈ ${formatH(worst.etaTripH)} if the trend continues`, 'linear extrapolation of the 3-h vibration trend — not a prediction model') : null],
      actions: [worst.recommendation ? `Recommended (rule-based): ${worst.recommendation}` : null, ev ? `Review ${ev.id} in Events & Reports.` : null],
      method: ['Detection is rule-based on simulated signals (observed vs expected-at-load vibration, 3-h trend, load-corrected temperature); no trained model or physical sensor is connected.'],
    },
    {
      facts: ranked.slice(0, 4).map((h) => ({ label: h.id, value: healthText(h) })),
      links: [...(ev ? [eventLink(ev)] : []), ...equipmentLink(worst.id)],
      followUps: ['Which equipment should be investigated first?', 'Which machine has the greatest downtime loss?'],
      eventId: ev?.id,
      records: [ev],
    },
  );
}

function machineAnswer(c: Ctx, id: string, p: Period): CopilotAnswer {
  const { s, tariffs } = c;
  const item = EQUIPMENT_BY_ID[id];
  const ops = OPS_BY_ID[id];
  const openEv = s.events.filter((e) => equipmentOf(e) === id && e.status !== 'resolved').sort((a, b) => b.lastUpdate - a.lastUpdate);
  if (!ops || ops.category !== 'process' || !PROCESS_MACHINES.includes(id))
    return compose(
      c,
      'machine',
      periodText(c.s, p),
      {
        confirmed: [`${item.name} (${id}) — ${item.description}`, openEv.length ? `Open events: ${openEv.slice(0, 3).map((e) => `${e.id} ${e.title}`).join('; ')}.` : 'No open event concerns it.'],
        unknown: ['It has no production counter in this demo, so its output and OEE cannot be established.'],
        actions: [`Locate ${id} in the Factory Twin for its details.`],
      },
      { links: [...equipmentLink(id), ...openEv.slice(0, 2).map((e) => eventLink(e))], followUps: SUGGESTED_QUESTIONS.slice(0, 2), eventId: openEv[0]?.id, records: openEv.slice(0, 3) },
    );
  const mm = machineMetrics(s, id, p);
  const m = s.machines[id];
  // The state the product shows (signal logic): a stale feed makes it unknown.
  const op = operationalState(s, id);
  const feed = staleFeed(s, id);
  const active = !feed && m.activeDowntimeId ? s.downtime.find((d) => d.id === m.activeDowntimeId) : null;
  const h = HEALTH_BY_ID[id] ? assess(s, id) : null;
  const figures = `output ${m2(mm.totals.count)}, OEE ${oeeEquation(mm.oee)}, ${int(mm.totals.down)} min unplanned downtime`;
  const rec = insights(s, { tariffs }).find((i) => i.equipmentId === id && i.recommendation);
  return compose(
    c,
    'machine',
    periodText(c.s, p),
    {
      confirmed: [
        feed
          ? `${item.name} (${id}): ${staleState(s, feed)}.`
          : `${item.name} (${id}) is ${stateIs(op)} since ${when(s, m.since)}${active ? ` — ${low1(REASON_BY_CODE[active.reasonCode].label)}, ${formatDuration(s.minute - active.start)} so far` : ''}.`,
        feed ? null : `In ${inPeriod(periodText(c.s, p))}: ${figures}.`,
        h && !feed ? `Condition: ${healthText(h)}.` : null,
        openEv.length ? `Open events: ${openEv.slice(0, 3).map((e) => `${e.id} ${e.title}`).join('; ')}.` : 'No open event concerns it.',
      ],
      simulated: [active ? (active.source === 'scenario' ? `Its current stop was injected by a scenario.` : 'Its current stop comes from the simulation itself, not from a scenario.') : null],
      unknown: [
        feed ? `Not confirmed by the feed: in ${inPeriod(periodText(c.s, p))} its simulated accounting shows ${figures} — figures that include the time since ${when(s, feed.since)} the stale feed has not confirmed.` : null,
        feed && h ? `Its condition cannot be confirmed while the feed is stale (the simulated assessment reads ${healthText(h)}).` : null,
        HEALTH_BY_ID[id] ? null : 'It has no condition monitoring in this demo, so its mechanical condition cannot be established.',
        'Process parameters such as temperatures and pressures are not modelled, so they cannot be reported.',
      ],
      actions: [rec ? `Recommended (rule-based): ${rec.recommendation}` : null, openEv[0] ? `Review ${openEv[0].id} in Events & Reports.` : null],
      method: ['Machine OEE uses the machine’s own time accounting and the rejects attributed to its stage (simulated PLC state and counter).'],
    },
    {
      facts: [
        { label: 'State', value: OPERATIONAL_STATE_LABEL[op] },
        { label: 'OEE', value: `${pct(mm.oee.oee.value)}${feed ? ' (not confirmed — feed stale)' : ''}` },
        { label: 'Downtime', value: `${int(mm.totals.down)} min${feed ? ' (not confirmed — feed stale)' : ''}` },
      ],
      links: [...equipmentLink(id), ...openEv.slice(0, 2).map((e) => eventLink(e)), ...stageLink(ops.stage)],
      followUps: openEv[0] ? [`What happened in ${openEv[0].id}?`, 'Which equipment should be investigated first?'] : ['Which equipment should be investigated first?'],
      eventId: openEv[0]?.id,
      records: openEv.slice(0, 3),
    },
  );
}

/** Energy is not a product module: say so, without figures. */
function energyAnswer(c: Ctx): CopilotAnswer {
  return compose(
    c,
    'energy',
    '—',
    {
      confirmed: ['Energy is not monitored in this product: there is no energy metering and no energy KPI, so consumption, cost and anomalies are not reported.'],
      simulated: ['Where an event loss estimate includes an energy line (a kiln burning fuel without output), it comes from an illustrative model with assumed tariffs and is shown as part of that estimate — not as a measurement.'],
      unknown: ['How much energy the plant, the kiln or any machine uses cannot be established from the data in this product.'],
      actions: ['Ask about output, OEE losses, defects, vehicle delays or an incident instead.'],
      method: ['Energy metering is not part of this product’s data model.'],
    },
    { followUps: SUGGESTED_QUESTIONS.slice(0, 3) },
  );
}

/** Temperatures, moisture, pressure… that the simulation does not model: never invent a reading. */
function processParameterAnswer(c: Ctx, q: string, machine: string | null): CopilotAnswer {
  const param = /\b(temperature|moisture|humidity|pressure|viscosity|density)\b/.exec(q)?.[1] ?? 'process parameter';
  const where = machine ? `${machine} (${nameOf(machine)})` : /kiln|firing/.test(q) ? 'the kiln' : 'the line';
  return compose(
    c,
    'process-parameter',
    '—',
    {
      confirmed: [`${cap1(param)} is not modelled for ${where} in this demo — the simulation has no physical model of it, so no reading is reported.`],
      simulated: ['Any process temperature or pressure value the twin displays is illustrative (no physical model) and is not used as evidence.'],
      unknown: [`The current ${param} of ${where} cannot be established from the data — any figure would be invented.`],
      actions: [`Ask how ${machine ? machine : 'a machine'} is doing instead: states, rates, stops and condition-monitoring levels are modelled.`],
      method: ['Modelled signals: machine states, counters and rates, buffer levels, inspection counts, gate and dock events, and condition-monitoring vibration / bearing temperature for six assets (rule-based, simulated).'],
    },
    { links: equipmentLink(machine), followUps: machine ? [`How is ${machine} doing?`] : SUGGESTED_QUESTIONS.slice(0, 2) },
  );
}

function helpAnswer(c: Ctx): CopilotAnswer {
  return compose(
    c,
    'help',
    '—',
    {
      confirmed: [
        'This copilot is rule-based: it matches a question to a topic and builds the answer from the same KPIs, events and reports the workspaces show. No language model or external service is connected.',
      ],
      unknown: ['The question did not match a topic the data can answer.'],
      actions: ['Try one of the suggested questions, or ask about one incident by its id (e.g. “What happened in EV-00012?”).'],
      method: [
        'Topics: output against target, the stage constraining output, OEE and its losses, downtime by machine and conveyor, the gap to theoretical output, the estimated cost of losses, defects and their evidence, delayed vehicles and truck turnaround, what to investigate first, one machine, one stage, or one event.',
      ],
    },
    { followUps: SUGGESTED_QUESTIONS.slice(0, 4) },
  );
}

// ── Event investigation ───────────────────────────────────────────────────────

function eventAnswer(c: Ctx, id: string, sub: EventSub): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const rep = buildEventReport(s, id, { finance, tariffs, generatedAt: toIso(s.minute) });
  if (!rep) return eventMissing(c, id);
  const ev = rep.event;
  const head = `${ev.id} · ${ev.title}`;
  const period = `${when(s, ev.start)} → ${ev.end == null ? 'now' : when(s, ev.end)}`;
  const condition = ev.end == null ? `active since ${when(s, ev.start)} (${rep.summary.duration})` : `cleared at ${when(s, ev.end)} after ${rep.summary.duration}`;
  const est = rep.impact.estimate;
  const valued = est && est.lines.some((l) => l.amount > 0.005) ? est : null;
  const relatedEvents = [ev.consequenceOf ? eventById(s, ev.consequenceOf) : undefined, ...ev.related.map((r) => eventById(s, r))];
  const extra: Extra = {
    facts: [
      { label: 'Event', value: ev.id },
      { label: 'Type', value: rep.summary.type },
      { label: 'Severity', value: rep.summary.severity },
      { label: 'Status', value: rep.summary.status },
      { label: 'Condition', value: rep.summary.condition },
      { label: 'Duration', value: rep.summary.duration },
      { label: 'Asset', value: `${rep.asset.id}${rep.asset.name !== rep.asset.id ? ` · ${rep.asset.name}` : ''}` },
      { label: 'Rule', value: `${rep.detection.rule} · ${rep.detection.ruleLabel}` },
    ],
    links: [...eventLinks(s, ev), ...stageLink(ev.asset.stage)],
    followUps: eventQuestionsFor(ev.id)
      .filter((_, i) => i !== ['what', 'why', 'impact', 'action', 'evidence'].indexOf(sub))
      .slice(0, 3),
    eventId: ev.id,
    records: [ev, ...relatedEvents],
  };
  const reportMethod = `Built from the event record ${ev.id} and its report model — the same record as Events & Reports and the PDF export.`;
  const observedValues = rep.detection.observed.map((o) => `${low1(o.label)} ${o.value}${o.unit ? ` ${o.unit}` : ''}`).join(', ');
  const threshold = rep.detection.threshold ? `${rep.detection.threshold.value}${rep.detection.threshold.unit ? ` ${rep.detection.threshold.unit}` : ''}` : null;
  const cp = causeParts(rep.diagnosis.causes, 4);
  const nextStep =
    ev.status === 'resolved'
      ? `Resolved${ev.resolution ? ` by ${ev.resolution.by === 'user' ? (ev.owner ?? 'a user') : 'the system'} at ${when(s, ev.resolution.t)}: ${ev.resolution.reason.replace(/\.$/, '')}` : ''} — nothing left to do.`
      : ev.end == null
        ? ev.status === 'active'
          ? `Acknowledge ${ev.id} or start an investigation in Events & Reports; it can be resolved once the condition clears.`
          : `Keep the investigation of ${ev.id} going — resolve it after recovery with a reason and the action taken.`
        : `The condition has cleared — resolve ${ev.id} in Events & Reports with a reason and the action taken.`;

  switch (sub) {
    case 'why':
      return compose(
        c,
        'event-why',
        period,
        {
          confirmed: [`${head} — what the data shows:`, ...rep.diagnosis.facts.slice(0, 6), ...cp.confirmed],
          inferred: [
            ...cp.inferred,
            ...rep.context.related.filter((r) => r.relation !== 'Related').map((r) => likely(`${r.id} (${r.title}) — ${low1(r.relation.replace(' (inferred)', ''))}`, 'linked by the event engine from states and buffer levels')),
          ],
          hypotheses: cp.hypotheses.length ? cp.hypotheses : !cp.inferred.length && !cp.confirmed.length ? [possible('no cause has been inferred for this event yet', 'no correlated stop, scenario or process event was found')] : [],
          unknown: rep.diagnosis.uncertainty,
          actions: ev.recommendations.slice(0, 2).map((r) => `Recommended (rule-based): ${r}`),
          method: ['Facts are read from signals and records; causes carry a confidence — confirmed = directly observed or a scenario input, likely / possible = inferred from correlated evidence.'],
        },
        extra,
      );
    case 'impact': {
      // Kiln minutes (and the line output derived from them) of an event on another asset are attributed
      // to it by the event engine — an inference, so they go under Inferred with a confidence. Energy rows
      // come from an illustrative model, so they go with the estimate.
      const attributed = (r: ImpactRow) => ev.category === 'production' && !ownsKiln(ev) && (/\bheld up\b/i.test(r.label) || /^line good output lost/i.test(r.label));
      const energyRow = (r: ImpactRow) => /energy|co₂|co2/i.test(r.label);
      const row = (r: ImpactRow) => `${r.label}: ${r.value} — ${low1(r.basis)}`;
      return compose(
        c,
        'event-impact',
        period,
        {
          confirmed: [`${head} — impact (${ev.end == null ? 'so far' : 'final'}):`, ...rep.impact.rows.filter((r) => !attributed(r) && !energyRow(r)).map((r) => dot(row(r))), ...rep.impact.notes],
          inferred: rep.impact.rows
            .filter(attributed)
            .map((r) =>
              /attribut/i.test(r.basis)
                ? likely(`${r.label}: ${r.value}`, low1(r.basis))
                : likely(`${r.label}: ${r.value} (${low1(r.basis)})`, 'from the kiln minutes the event engine attributes to this event (inferred from states and buffers)'),
            ),
          unknown: [...(est?.missing ?? []).map((m) => `Not estimated: ${m}`)],
          estimate: [
            ...rep.impact.rows.filter(energyRow).map((r) => dot(`${row(r)} (illustrative model, not a measurement)`)),
            ...(valued
              ? [`Estimated ≈ ${money(valued.currency, valued.total)}${ev.end == null ? ' so far' : ''}: ${estimateLines(valued).join('; ')}.`, `Assumptions: ${valued.assumptions.join(' ')}`]
              : [`No money estimate for this event — ${est?.missing.length ? low1(joinSentences(est.missing)) : 'its impact is not valued in money'}.`]),
          ],
          actions: [nextStep],
          method: [reportMethod, ...(est?.limitations ?? [])],
        },
        extra,
      );
    }
    case 'action': {
      // Value of a further minute: the kiln's current shortfall against its typical rate (all of it for a stop or
      // full starvation, the actual gap for a below-rate event) × the first-pass yield the event report uses.
      const losing = ev.category === 'production' && ev.end == null && !ev.consequenceOf && ev.acc.constraintMin > 0;
      // The kiln's rate "now" is a live reading: while its feed is stale it is unknown, never read from the engine.
      const kilnFeed = losing ? staleFeed(s, 'H-KILN') : null;
      const kilnNow = losing && !kilnFeed ? minuteAt(s, 'H-KILN', s.minute - 1) : null;
      const typical = ev.acc.kilnTypicalRate;
      const shortfall = kilnNow ? Math.max(0, typical - kilnNow.rate) : 0;
      // Same test as the event engine: the kiln is held up (down / starved / blocked) or more than 5 % below its typical rate.
      // Planned kiln time is never valued as a loss.
      const plannedNow = kilnNow?.state === 'planned';
      const heldNow = kilnNow != null && !plannedNow && (kilnNow.state === 'down' || kilnNow.state === 'starved' || kilnNow.state === 'blocked' || shortfall > typical * 0.05);
      // The first-pass yield the event report uses for this event (24 h before it), so both value a kiln minute alike.
      const fpy = fpyBefore(s, ev.start);
      const perMin = heldNow && shortfall > 0 ? lostOutputValue(finance, shortfall * fpy) : null;
      return compose(
        c,
        'event-action',
        period,
        {
          confirmed: [
            `${head} is ${rep.summary.status.toLowerCase()}${ev.owner ? `, owner ${ev.owner}` : ', no owner yet'}; condition ${condition}.`,
            kilnNow && !heldNow
              ? plannedNow
                ? 'The kiln is on a planned stop right now — planned time is not valued as lost output.'
                : `The kiln is firing at ${int(kilnNow.rate * 60)} tiles/h right now against its typical ${int(typical * 60)} tiles/h — no further line output is being lost this minute.`
              : null,
            ...cp.confirmed,
          ],
          inferred: cp.inferred.slice(0, 1),
          hypotheses: cp.hypotheses.slice(0, 1),
          unknown: [
            kilnFeed
              ? notConfirmed(
                  `kiln data stale since ${when(s, kilnFeed.since)}`,
                  `the kiln's current rate is unknown${kilnFeed.lastRate != null ? ` (last value received: ${int(kilnFeed.lastRate)} tiles/h at ${when(s, kilnFeed.since)})` : ''}, so whether ${ev.id} is still costing line output this minute, and what a further minute is worth, cannot be established.`,
                )
              : null,
          ],
          estimate: perMin
            ? [
                `Every further minute at the current kiln rate ≈ ${money(finance.currency, perMin.amount)} of contribution ((${int(typical * 60)} tiles/h typical − ${int(kilnNow!.rate * 60)} tiles/h now) ÷ 60 × ${pct(fpy)} first-pass yield of the 24 h before the event, as in its report).`,
                assumptionsText(finance, ['output']),
              ]
            : [],
          actions: [
            nextStep,
            kilnFeed ? 'Open H-KILN in the Factory Twin to check its data feed before relying on the kiln figures.' : null,
            ...ev.recommendations.map((r, i) => `${i + 1}. ${r}`),
          ],
          method: [
            'Recommendations are the standard first responses for this alarm, defect or vehicle rule (rule-based), stored on the event record and shown in its report.',
            losing ? "The value of a further minute uses the kiln's rate in the last minute from its data feed; a stale feed leaves it unknown." : null,
          ],
        },
        extra,
      );
    }
    case 'evidence': {
      const all = [...rep.visualEvidence, ...rep.supportingEvidence];
      const available = all.filter((x) => x.status === 'available');
      const pending = all.filter((x) => x.status === 'pending');
      // provenance.unavailable also lists items still being captured; those are reported as pending.
      const missing = rep.provenance.unavailable.filter((u) => !pending.some((x) => x.title === u.title));
      const evRecs = all
        .filter((x) => x.kind === 'inspection-image' && x.inspectionId)
        .map((x) => s.inspections.find((r) => r.id === x.inspectionId))
        .filter((r): r is QualityInspection => !!r);
      return compose(
        c,
        'event-evidence',
        period,
        {
          confirmed: [
            `${head} — ${plural(available.length, 'evidence item')} available${pending.length ? `, ${pending.length} being captured` : ''}, ${missing.length} unavailable.`,
            ...available.map((x) => `Available: ${x.title} — ${low1(x.originLabel)}, captured ${when(s, x.capturedAt)}.`),
            ...pending.map((x) => `Being captured: ${x.title}.`),
            rep.provenance.sources.length ? `Signals used: ${rep.provenance.sources.join(', ')}.` : null,
          ],
          simulated: [
            available.some((x) => x.kind === 'camera-snapshot' && x.provenance.origin === 'live-camera')
              ? 'Camera frames marked “live camera” were grabbed from the configured stream; other camera views are rendered from the digital twin (not camera images).'
              : 'Camera views are rendered from the digital twin (simulated view, not a camera image).',
          ],
          unknown: missing.map((u) => `Unavailable: ${u.title} — ${low1(u.reason)}.`),
          actions: [`Open ${ev.id} in Events & Reports to see the evidence and export the report.`],
          method: [`Evidence is frozen when the event is detected and stored under the event id. ${recordMethod(evRecs, ev.asset.stationId)} Missing evidence is listed with its reason instead of being invented.`],
        },
        extra,
      );
    }
    default:
      return compose(
        c,
        'event-what',
        period,
        {
          confirmed: [
            `${head} — ${rep.summary.type.toLowerCase()} (${rep.summary.category.toLowerCase()}), ${rep.summary.severity.toLowerCase()}, ${rep.summary.status.toLowerCase()}; condition ${condition}.`,
            rep.summary.text,
            `Asset: ${low1(rep.asset.kind)} ${rep.asset.id}${rep.asset.name !== rep.asset.id ? ` (${rep.asset.name})` : ''}${rep.asset.stage ? ` · ${rep.asset.stage}` : ''}.`,
            `Detected by ${low1(rep.detection.kind)} — rule ${rep.detection.rule} (${rep.detection.ruleLabel}): ${low1(rep.detection.description)}${observedValues ? `; observed ${observedValues}` : ''}${threshold ? `; threshold ${threshold}` : ''}.`,
            ...rep.diagnosis.facts.filter((f) => f !== rep.summary.text && !rep.summary.text.includes(f)).slice(0, 2),
            ...cp.confirmed.slice(0, 1),
          ],
          inferred: cp.inferred.slice(0, 2),
          hypotheses: cp.hypotheses.slice(0, 2),
          unknown: rep.diagnosis.uncertainty.slice(0, 2),
          estimate: valued ? [`Estimated impact ≈ ${money(valued.currency, valued.total)}${ev.end == null ? ' so far' : ''}: ${estimateLines(valued).join('; ')}.`, `Assumptions: ${valued.assumptions.join(' ')}`] : [],
          actions: [...ev.recommendations.slice(0, 1).map((r) => `Recommended first (rule-based): ${r}`), nextStep],
          method: [reportMethod],
        },
        extra,
      );
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function stateWord(state: string) {
  return (
    ({ running: 'running', reduced: 'running at reduced rate', starved: 'starved of input', blocked: 'blocked by downstream', down: 'down', planned: 'on a planned stop' }) as Record<string, string>
  )[state] ?? state;
}

/** Why an active event carries no money estimate (said instead of a zero). */
function noValueReason(e: OpEvent): string {
  switch (e.category) {
    case 'production':
      return e.acc.constraintMin > 0 ? 'no line output valued yet' : 'kiln not held up so far — buffers absorbing it';
    case 'quality':
      return 'no excess rejects over the 24 h reference yet';
    case 'logistics':
      return e.type === 'truck-waiting' ? 'no waiting beyond the threshold yet' : 'not costed — service-level or safety event';
    case 'equipment':
      return 'developing condition — no loss until it fails';
    default:
      return 'not valued in money';
  }
}

/** Loss categories at the constraint for the period (minutes of kiln time), largest first. */
function lossBreakdown(s: SimState, p: Period) {
  const k = machineMetrics(s, 'H-KILN', p).totals;
  const q = qualityIn(s, p);
  const ideal = 60 / (OPS_BY_ID['H-KILN'].idealRatePerHour ?? 1);
  const perf = Math.max(0, k.operating - k.count * ideal);
  const qual = q.inspected > 0 ? (k.count * ideal * q.rejected) / q.inspected : 0;
  const rows = [
    { label: 'Kiln downtime', min: k.down },
    { label: 'Kiln starvation (upstream losses)', min: k.starved },
    { label: 'Kiln blocking (downstream losses)', min: k.blocked },
    { label: 'Speed / micro-stop losses', min: perf },
    { label: 'Quality rejects', min: qual },
  ];
  const total = rows.reduce((a, r) => a + r.min, 0) || 1;
  return rows.map((r) => ({ ...r, share: r.min / total })).sort((a, b) => b.min - a.min);
}

/** The event report the copilot reads for an event (exported for the context panel). */
export const copilotEventReport = (s: SimState, id: string, finance: FinanceAssumptions, tariffs: Tariffs): EventReport | null =>
  buildEventReport(s, id, { finance, tariffs, generatedAt: toIso(s.minute) });
