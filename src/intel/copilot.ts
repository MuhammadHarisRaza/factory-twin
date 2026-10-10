/**
 * Factory Copilot — deterministic, rule-based question answering over the shared simulation state.
 * No language model is connected: a question is matched to an intent by keywords, and every answer is
 * assembled from the same metrics, events, evidence and report model the workspaces show.
 *
 * Each answer is split into sections so a reader can tell apart
 *   observed  — read directly from signals, counters and records,
 *   inferred  — explanations from correlated evidence, always with a confidence (confirmed / likely / possible),
 *   estimate  — production or financial estimates, always with the assumptions used,
 *   method    — how the figures were computed.
 * `text` repeats the sections as plain paragraphs for older consumers.
 *
 * An event context (ctx.eventId, or an event id typed in the question) turns the copilot into an
 * investigation of that one record: what happened, why, impact, what to do, evidence — read from
 * buildEventReport, the same model as the in-app report and the PDF.
 */
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment';
import {
  CONVEYOR_BY_ID,
  CONVEYOR_IDS,
  DEFECTS,
  DEFECT_ORDER,
  LINE,
  M2_PER_TILE,
  MONITORED_STAGE_BY_ID,
  OPS_BY_ID,
  PROCESS_MACHINES,
  REASON_BY_CODE,
  STAGE_BY_ID,
  TARGET,
} from '../model/plant';
import type { AlertSeverity, DefectCategory, DowntimeEvent, EventCause, MonitoredStageId, OpEvent, StageId } from '../model/types';
import type { SimState } from '../sim/engine';
import { DEFAULT_TARIFFS, type Tariffs } from '../sim/energy';
import { EVENT_STATUS_LABEL, activeEvents, eventById, openEvents } from '../sim/events';
import { DEFAULT_FINANCE, assumptionList, contributionPerM2, lostOutputValue, rejectCost, type Estimate, type FinanceAssumptions } from '../sim/finance';
import { HEALTH_BY_ID, LEVEL_RANK, assess, formatH, type HealthAssessment } from '../sim/health';
import { phaseLabel } from '../sim/logistics';
import {
  HELD_UP_SHARE,
  OPERATIONAL_STATE_LABEL,
  TARGET_STATUS_LABEL,
  bottleneck,
  capacityBreakdown,
  clippedDuration,
  conveyorMetrics,
  defectShift,
  downtimeIn,
  downtimePareto,
  energyIn,
  externalVehicles,
  fleetMetrics,
  kilnIdleBurn,
  lineMetrics,
  machineMetrics,
  operationalState,
  qualityIn,
  resolvePeriod,
  stageMetrics,
  targetStatus,
  visitDurations,
  type LineMetrics,
  type Period,
  type PeriodKey,
} from '../sim/metrics';
import type { Metric, OeeResult } from '../sim/oee';
import { formatClock, formatDateTime, formatDay, formatDuration, toIso } from '../sim/time';
import { DEFECT_ACTIONS, REASON_ACTIONS, healthAssessments, insights, nextActions, type InsightLink } from './insights';
import { buildEventReport, eventImpact, type EventReport } from './report';

// ── Public types ──────────────────────────────────────────────────────────────

export type CopilotIntent =
  | 'below-target'
  | 'bottleneck'
  | 'largest-downtime'
  | 'machine-downtime'
  | 'conveyor-stop'
  | 'kiln'
  | 'oee'
  | 'capacity-gap'
  | 'loss-cost'
  | 'defects'
  | 'defect-report'
  | 'turnaround'
  | 'investigate-first'
  | 'next-actions'
  | 'energy'
  | 'health'
  | 'logistics'
  | 'machine'
  | 'event-what'
  | 'event-why'
  | 'event-impact'
  | 'event-action'
  | 'event-evidence'
  | 'help';

/** A tagged part of an answer: what the data shows, what is inferred, what is estimated, how. */
export type CopilotSection = { kind: 'observed' | 'inferred' | 'estimate' | 'method'; text: string };

/** Context the question is asked in (event-specific investigation, assumptions for estimates). */
export type CopilotContext = { eventId?: string | null; finance?: FinanceAssumptions };

export type CopilotAnswer = {
  intent: CopilotIntent;
  /** Plain-language answer, one or more short paragraphs (the sections, in order). */
  text: string[];
  /** The same answer split into observed facts, inferences and estimates (preferred for display). */
  sections?: CopilotSection[];
  /** Facts the answer used (label → value). */
  facts: { label: string; value: string }[];
  links: InsightLink[];
  /** Period the figures refer to. */
  periodLabel: string;
  followUps: string[];
  /** Event the answer is about (event investigation, or the event a plant-wide answer points to first). */
  eventId?: string;
};

export type QuestionGroupId = 'monitoring' | 'oee' | 'quality' | 'vehicles' | 'supervisor';

/** Suggested questions grouped by the use case they demonstrate. */
export const QUESTION_GROUPS: { id: QuestionGroupId; label: string; questions: string[] }[] = [
  {
    id: 'monitoring',
    label: 'Production monitoring',
    questions: ["Why is today's production below target?", 'Which conveyor stopped most recently?', 'Which machine has the greatest downtime loss?'],
  },
  {
    id: 'oee',
    label: 'OEE, capacity & financial loss',
    questions: ['What is the current OEE and how is it calculated?', 'What prevents us from reaching theoretical output?', 'What is the estimated cost of the current production loss?'],
  },
  { id: 'quality', label: 'Defect monitoring', questions: ['Which defect category has increased?', 'Show the report and evidence for the latest defect.'] },
  { id: 'vehicles', label: 'Vehicle monitoring', questions: ['Which trucks exceeded their turnaround threshold?'] },
  { id: 'supervisor', label: 'Shift supervisor', questions: ['What should the supervisor investigate first?'] },
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
const int = (n: number) => Math.round(n).toLocaleString('en-GB');
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
/** A period label inside a sentence: "Today" → "today", "Shift A · 06:00–14:00" → "shift A · 06:00–14:00". */
const inPeriod = (label: string) => low1(label);
const nameOf = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;

/** Metric value, or why it is not available (never a misleading number). */
const metricPct = (m: Metric, d = 1) => (m.status === 'ok' ? pct(m.value, d) : m.status === 'invalid' ? `invalid (${m.issue ?? 'inconsistent inputs'})` : `unavailable${m.issue ? ` (${low1(m.issue)})` : ''}`);

const CONF: Record<EventCause['confidence'], string> = { confirmed: 'Confirmed', likely: 'Likely', possible: 'Possible' };
/** An inferred statement always carries its confidence and, where there is one, its basis. */
const inf = (confidence: EventCause['confidence'], text: string, basis?: string) => dot(`${CONF[confidence]}: ${text.replace(/\.$/, '')}${basis ? ` — ${basis.replace(/\.$/, '')}` : ''}`);
const fmtCause = (c: EventCause) => inf(c.confidence, `${c.text}${c.relatedEventId ? ` (see ${c.relatedEventId})` : ''}`, c.basis);

const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/** Monitored stage (Production Monitoring) for a process stage id (decoration → glazing, palletising → packing). */
export function monitoredStage(id: string | null | undefined): MonitoredStageId | null {
  if (!id) return null;
  const map: Record<string, MonitoredStageId> = { DECOR: 'GLAZE', PAL: 'PACK' };
  const m = (map[id] ?? id) as MonitoredStageId;
  return MONITORED_STAGE_BY_ID[m] ? m : null;
}
const stageLink = (id: string | null | undefined): InsightLink[] => {
  const m = monitoredStage(id);
  return m ? [{ kind: 'stage', id: m, label: `Monitor ${MONITORED_STAGE_BY_ID[m].name.toLowerCase()}` }] : [];
};
const equipmentLink = (id: string | null | undefined, label?: string): InsightLink[] => (id && EQUIPMENT_BY_ID[id] ? [{ kind: 'equipment', id, label: label ?? `Locate ${id}` }] : []);
const eventLink = (ev: { id: string }, label?: string): InsightLink => ({ kind: 'event', id: ev.id, label: label ?? `Report ${ev.id}` });
function assetLinks(ev: OpEvent): InsightLink[] {
  if (ev.asset.vehicleId) return [{ kind: 'vehicle', id: ev.asset.vehicleId, label: `Follow ${ev.asset.vehicleId}` }];
  return equipmentLink(ev.asset.equipmentId);
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
const tariffText = (t: Tariffs) =>
  `Assumptions: gas ${t.currency} ${t.gas}/kWh and electricity ${t.currency} ${t.electricity}/kWh — illustrative tariffs (editable in Energy Intelligence) applied to an illustrative energy model.`;

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

// ── Composition ───────────────────────────────────────────────────────────────

type Lines = (string | false | null | undefined)[];
type Parts = { observed?: Lines; inferred?: Lines; estimate?: Lines; method?: Lines };
type Extra = { facts?: CopilotAnswer['facts']; links?: InsightLink[]; followUps?: string[]; eventId?: string };

function compose(intent: CopilotIntent, periodLabel: string, parts: Parts, extra: Extra = {}): CopilotAnswer {
  const sections: CopilotSection[] = [];
  for (const kind of ['observed', 'inferred', 'estimate', 'method'] as const) for (const t of parts[kind] ?? []) if (t) sections.push({ kind, text: t });
  const seen = new Set<string>();
  const links = (extra.links ?? []).filter((l) => {
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
    followUps: extra.followUps ?? [],
    ...(extra.eventId ? { eventId: extra.eventId } : {}),
  };
}

type Ctx = { s: SimState; tariffs: Tariffs; finance: FinanceAssumptions; eventId: string | null };

// ── Question understanding ────────────────────────────────────────────────────

function classify(q: string): CopilotIntent {
  if (has(q, ['investigat', 'look at first', 'check first', 'most urgent', 'first priority']) || /\bfirst\b/.test(q)) return 'investigate-first';
  if (has(q, ['supervisor', 'what should', 'next step', 'next action', 'do next', 'recommend', 'priorit'])) return 'next-actions';
  if (has(q, ['turnaround', 'turn-around', 'on site too long', 'over the threshold', 'exceeded'])) return 'turnaround';
  if (has(q, ['conveyor', 'belt', 'roller transfer', 'transfer'])) return 'conveyor-stop';
  if (has(q, ['energy', ' gas', 'power', 'electric', 'kwh', 'wasting'])) return 'energy';
  if (has(q, ['cost', 'money', 'financial', 'worth', 'value of', 'revenue', '$', 'usd']) && has(q, ['loss', 'lost', 'losing', 'production', 'downtime', 'stop'])) return 'loss-cost';
  if (has(q, ['theoretical', 'design capacity', 'capacity gap', 'prevent', 'maximum output', 'full capacity', 'design rate'])) return 'capacity-gap';
  if (has(q, ['oee', 'calculated', 'calculat', 'availability', 'effectiveness']) || /\bperformance\b/.test(q)) return 'oee';
  if (has(q, ['bottleneck', 'constraint', 'limiting', 'slowest', 'holding back'])) return 'bottleneck';
  const defectWord = has(q, ['defect', 'reject', 'quality', 'scrap', 'crack', 'glaze', 'shade', 'chip', 'surface', 'planarity', 'caliber', 'inspection']);
  if (defectWord && has(q, ['report', 'evidence', 'image', 'frame', 'record', 'picture', 'photo', 'snapshot', 'show'])) return 'defect-report';
  if (defectWord) return 'defects';
  if (has(q, ['health', 'vibration', 'maintenance', 'failure', 'fail', 'predict', 'bearing', 'at risk'])) return 'health';
  if (has(q, ['which machine', 'what machine', 'which asset', 'which equipment', 'machine has', 'machine with']) && has(q, ['downtime', 'stop', 'loss', 'lost', 'down'])) return 'machine-downtime';
  if (has(q, ['kiln', 'firing'])) return 'kiln';
  if (has(q, ['truck', 'dock', 'yard', 'forklift', 'dispatch', 'logistic', 'vehicle'])) return 'logistics';
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
const FACTORY_WIDE = /\b(which|supervisor|factory|plant|today|shift|theoretical|oee|bottleneck|target|production|latest|most recent|recently|trucks|conveyors|machines|categor(y|ies))\b/;
/** Phrases that refer to the event in context. */
const REFERS = /\b(this|that|the) (event|stop|stoppage|fault|alarm|issue|incident|record|truck|delay)\b|\bit\b/;

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

/** Defect category named in the question, if any. */
function findDefect(q: string): DefectCategory | null {
  for (const d of DEFECT_ORDER) if (q.includes(d) || q.includes(DEFECTS[d].label.toLowerCase())) return d;
  if (q.includes('caliber') || q.includes('dimensional')) return 'dimension';
  if (q.includes('edge')) return 'chip';
  if (q.includes('colour') || q.includes('color')) return 'shade';
  return null;
}

function periodFor(q: string): PeriodKey {
  if (q.includes('today')) return 'today';
  if (q.includes('week') || q.includes('7 day')) return '7d';
  if (q.includes('24')) return '24h';
  if (q.includes('previous shift') || q.includes('last shift')) return 'prev-shift';
  return 'shift';
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function ask(s: SimState, question: string, tariffs: Tariffs = DEFAULT_TARIFFS, ctx: CopilotContext = {}): CopilotAnswer {
  const q = question.toLowerCase().trim();
  const c: Ctx = { s, tariffs, finance: ctx.finance ?? DEFAULT_FINANCE, eventId: ctx.eventId ?? null };
  const p = resolvePeriod(periodFor(q), s.minute);
  const base = classify(q);

  // Event investigation: an id in the question, or the event in context when the question is about it.
  const typed = eventIdIn(q);
  if (typed) return eventAnswer(c, typed, eventSub(q) ?? 'what');
  const machine = findMachine(q);
  const ctxEv = c.eventId ? eventById(s, c.eventId) : undefined;
  if (ctxEv) {
    const sub = eventSub(q);
    // A question naming another machine is about that machine, not the event in context.
    const namesOther = machine != null && machine !== ctxEv.asset.equipmentId;
    if (!FACTORY_WIDE.test(q) && !namesOther && (base === 'help' || sub != null || REFERS.test(q))) return eventAnswer(c, ctxEv.id, sub ?? 'what');
  }

  let intent = base;
  if (machine && (intent === 'help' || intent === 'health' || intent === 'below-target' || intent === 'oee' || (intent === 'conveyor-stop' && CONVEYOR_BY_ID[machine])))
    intent = intent === 'health' ? 'health' : 'machine';

  switch (intent) {
    case 'below-target':
      return belowTarget(c, p);
    case 'bottleneck':
      return bottleneckAnswer(c);
    case 'largest-downtime':
      return largestDowntime(c, p);
    case 'machine-downtime':
      return machineDowntime(c, p);
    case 'conveyor-stop':
      return conveyorAnswer(c, null, p);
    case 'kiln':
      return kilnAnswer(c, p);
    case 'oee':
      return oeeAnswer(c, p);
    case 'capacity-gap':
      return capacityAnswer(c, p);
    case 'loss-cost':
      return lossCost(c, p);
    case 'defects':
      return defectsAnswer(c, p, findDefect(q));
    case 'defect-report':
      return defectReport(c, findDefect(q));
    case 'turnaround':
      return turnaroundAnswer(c);
    case 'investigate-first':
      return investigateFirst(c);
    case 'next-actions':
      return nextActionsAnswer(c);
    case 'energy':
      return energyAnswer(c, p);
    case 'health':
      return healthAnswer(c, machine);
    case 'logistics':
      return logisticsAnswer(c, p);
    case 'machine':
      return CONVEYOR_BY_ID[machine!] ? conveyorAnswer(c, machine!, p) : machineAnswer(c, machine!, p);
    default:
      return helpAnswer(c);
  }
}

// ── Production monitoring ─────────────────────────────────────────────────────

function belowTarget(c: Ctx, p: Period): CopilotAnswer {
  const { s, finance } = c;
  const lm = lineMetrics(s, p);
  const status = targetStatus(lm.attainment);
  const facts = [
    { label: 'Output', value: m2(lm.output) },
    { label: 'Target', value: m2(lm.target) },
    { label: 'Availability', value: pct(lm.oee.availability.value) },
    { label: 'Performance', value: pct(lm.oee.performance.value) },
    { label: 'Quality', value: pct(lm.oee.quality.value) },
    { label: 'OEE', value: pct(lm.oee.oee.value) },
  ];
  const method = `Output = first-quality tiles accepted at sorting; plan = ${int(TARGET.goodPerHour)} good tiles per hour (${pct(TARGET.oeeTarget, 0)} OEE). Bands: ≥ 100 % ahead, ≥ 97 % on track, ≥ 90 % behind, below that well behind. Lost time is split at the kiln, the line constraint.`;
  if (status === 'none')
    return compose('below-target', p.label, { observed: [`No production time has elapsed yet in ${inPeriod(p.label)} — there is nothing to compare with the plan.`], method: [method] }, { facts, links: [{ kind: 'workspace', id: 'production', label: 'Open OEE & Loss' }], followUps: ['What is the current OEE and how is it calculated?'] });
  const pareto = downtimePareto(s, p).slice(0, 3);
  const bn = bottleneck(s);
  const losses = lossBreakdown(s, p);
  const gap = lm.target - lm.output;
  const behind = status === 'behind' || status === 'well-behind';
  // Root production events of the period that held the kiln up (active or already cleared).
  const holding = s.events
    .filter((e) => e.category === 'production' && !e.consequenceOf && e.acc.constraintMin > 0 && e.start < p.to && (e.end ?? s.minute) > p.from)
    .sort((a, b) => b.acc.constraintMin - a.acc.constraintMin)
    .slice(0, 3);
  const value = behind ? lostOutputValue(finance, gap) : null;
  return compose(
    'below-target',
    p.label,
    {
      observed: [
        behind
          ? `Output for ${inPeriod(p.label)} is ${m2(lm.output)} of first-quality tile against a plan of ${m2(lm.target)} — ${pct(lm.attainment, 0)} of target, ${m2(gap)} behind (${low1(TARGET_STATUS_LABEL[status])}).`
          : `Output for ${inPeriod(p.label)} is ${status === 'ahead' ? 'ahead of plan' : 'on track'}: ${m2(lm.output)} of ${m2(lm.target)} (${pct(lm.attainment, 0)})${gap > 0 ? ` — ${m2(gap)} short, within normal hour-to-hour variation` : ''}.`,
        `Line OEE ${oeeEquation(lm.oee)}, against the ${pct(TARGET.oeeTarget, 0)} the plan assumes.`,
        pareto.length
          ? `Largest unplanned stoppage reasons: ${pareto.map((r) => `${low1(r.label)} ${int(r.minutes)} min (${plural(r.events, 'stop')})`).join(', ')}.`
          : `No unplanned stoppage was recorded in ${inPeriod(p.label)}.`,
        lm.activeStops.length ? `Stopped now: ${lm.activeStops.map((d) => `${d.equipmentId} since ${clock(d.start)}`).join(', ')}.` : null,
      ],
      inferred: [
        losses[0].min > 0.5
          ? inf(
              'likely',
              `most of the shortfall comes from ${low1(losses[0].label)} (${pct(losses[0].share, 0)} of the kiln time lost in the period), then ${low1(losses[1].label)} (${pct(losses[1].share, 0)})`,
              'every minute the kiln (line constraint) loses is line output lost; split from its time accounting',
            )
          : null,
        inf(
          'likely',
          bn.shifted ? `the line is currently limited by ${bn.current.name.toLowerCase()}, not the kiln as designed` : `the kiln limits the line, as designed`,
          `stage state shares over the ${bn.period.label.toLowerCase()}`,
        ),
        ...holding.map((e) =>
          inf(
            'likely',
            `${e.id} (${e.title}${e.end == null ? ', still active' : `, cleared ${when(s, e.end)}`}) held the kiln up ${int(e.acc.constraintMin)} min`,
            'kiln hold-up minutes attributed to the event by the event engine',
          ),
        ),
      ],
      estimate: value
        ? [`Value of the ${m2(gap)} shortfall ≈ ${money(finance.currency, value.amount)} of contribution (${value.basis}).`, assumptionsText(finance, ['output'])]
        : [],
      method: [method],
    },
    {
      facts,
      links: [{ kind: 'workspace', id: 'production', label: 'Open OEE & Loss' }, ...stageLink(bn.current.stage), ...holding.map((e) => eventLink(e))],
      followUps: ['What prevents us from reaching theoretical output?', 'Which machine has the greatest downtime loss?', 'What is the estimated cost of the current production loss?'],
      eventId: holding[0]?.id,
    },
  );
}

function bottleneckAnswer(c: Ctx): CopilotAnswer {
  const { s } = c;
  const bn = bottleneck(s);
  const cur = bn.current;
  const k = bn.constraint;
  const win = bn.period.label.toLowerCase();
  const machines = STAGE_BY_ID[cur.stage].machines.join(', ');
  const at = bn.stages.indexOf(cur);
  const up = bn.stages.filter((r, i) => i < at && r.blockedShare > HELD_UP_SHARE).map((r) => r.name.toLowerCase());
  const down = bn.stages.filter((r, i) => i > at && r.starvedShare > HELD_UP_SHARE).map((r) => r.name.toLowerCase());
  const kilnName = STAGE_BY_ID[LINE.designConstraint].name.toLowerCase();
  return compose(
    'bottleneck',
    bn.period.label,
    {
      observed: [
        `Current bottleneck by the trace rule: ${cur.name} (${machines}) — over the ${win} working ${pct(cur.workingShare, 0)}, starved ${pct(cur.starvedShare, 0)}, blocked ${pct(cur.blockedShare, 0)}, down ${pct(cur.downShare, 0)}${cur.inputBufferLevel != null ? `; input buffer ${pct(cur.inputBufferLevel, 0)} full` : ''}.`,
        cur.stage === LINE.designConstraint
          ? null
          : `The kiln was starved ${pct(k.starvedShare, 0)}, blocked ${pct(k.blockedShare, 0)} and down ${pct(k.downShare, 0)} of its planned time.`,
        up.length ? `Blocked upstream: ${up.join(', ')}.` : null,
        down.length ? `Starved downstream: ${down.join(', ')}.` : null,
      ],
      inferred: [
        bn.cause === 'constraint'
          ? inf('likely', `${cur.name} is the bottleneck, as designed — the line output is set by the kiln's own rate and stops`, 'the kiln was neither starved nor blocked more than 5 % of the window')
          : bn.cause === 'starving'
            ? inf('likely', `${cur.name.toLowerCase()} is the current bottleneck: it is the first stage upstream of the kiln that was not itself waiting for material`, 'traced upstream from the starved kiln through the stage state shares')
            : inf('likely', `${cur.name.toLowerCase()} is the current bottleneck: it cannot take the kiln's output, so the kiln is blocked`, 'traced downstream from the blocked kiln through the stage state shares'),
        bn.shifted ? inf('likely', `every minute ${kilnName} waits on ${cur.name.toLowerCase()} is output lost for the whole line`, 'the kiln is the designed constraint') : null,
      ],
      method: [
        `Starting at the kiln, a starved constraint is traced upstream (blocked: downstream) past every stage that was itself held up more than ${pct(HELD_UP_SHARE, 0)} of the window; shares come from the per-minute state log of the ${win}.`,
      ],
    },
    {
      facts: bn.stages.map((r) => ({ label: r.name, value: `${pct(r.workingShare, 0)} working · ${pct(r.starvedShare, 0)} starved · ${pct(r.blockedShare, 0)} blocked · ${pct(r.downShare, 0)} down` })),
      links: [...stageLink(cur.stage), ...bnLinks(cur.stage), { kind: 'workspace', id: 'production', label: 'Open bottleneck analysis' }],
      followUps: ['How is the kiln affecting production?', 'What prevents us from reaching theoretical output?'],
    },
  );
}

function largestDowntime(c: Ctx, p: Period): CopilotAnswer {
  const { s } = c;
  const pareto = downtimePareto(s, p);
  if (!pareto.length)
    return compose('largest-downtime', p.label, { observed: [`No unplanned downtime has been recorded in ${inPeriod(p.label)}.`], method: ['Unplanned downtime from the downtime log (starved, blocked and planned stops excluded).'] }, { followUps: SUGGESTED_QUESTIONS.slice(0, 2) });
  const top = pareto[0];
  const events = s.downtime.filter((d) => d.reasonCode === top.key && d.start < p.to && (d.end ?? s.minute) > p.from);
  // Minutes inside the period only, so the machine's share never exceeds the reason's total.
  const byMachine = new Map<string, number>();
  for (const d of events) byMachine.set(d.equipmentId, (byMachine.get(d.equipmentId) ?? 0) + clippedDuration(d, p, s.minute));
  const worst = [...byMachine.entries()].sort((a, b) => b[1] - a[1])[0];
  return compose(
    'largest-downtime',
    p.label,
    {
      observed: [
        `The largest downtime loss in ${inPeriod(p.label)} is ${low1(top.label)}: ${int(top.minutes)} min over ${plural(top.events, 'event')} (${pct(top.share, 0)} of unplanned downtime).`,
        worst ? `Most of it was on ${worst[0]} (${nameOf(worst[0])}, ${int(worst[1])} min in the period).` : null,
      ],
      inferred: [REASON_ACTIONS[top.key] ? `Recommended standard response for this reason (rule-based): ${REASON_ACTIONS[top.key]}` : null],
      method: ['Downtime Pareto of the period: unplanned stops by reason, each clipped to the period (starved, blocked and planned stops excluded).'],
    },
    {
      facts: pareto.slice(0, 5).map((r) => ({ label: r.label, value: `${int(r.minutes)} min · ${r.events}×` })),
      links: [...(worst ? equipmentLink(worst[0]) : []), { kind: 'workspace', id: 'production', label: 'Open downtime Pareto' }],
      followUps: ['Which machine has the greatest downtime loss?', "Why is today's production below target?"],
    },
  );
}

type AssetLoss = { id: string; minutes: number; lostTiles: number; events: number; active: boolean; constraintMin: number; stopEvents: OpEvent[] };

/** Unplanned downtime per asset in the period (pro-rated like the Command Center), with the kiln time its stop events cost. */
function assetLosses(s: SimState, p: Period): AssetLoss[] {
  const by = new Map<string, AssetLoss>();
  for (const d of downtimeIn(s, p)) {
    if (d.category === 'Planned' || d.category === 'Starved' || d.category === 'Blocked' || REASON_BY_CODE[d.reasonCode]?.planned) continue;
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
  const method = 'Process machines ranked by output not made while stopped (m² at their ideal rate), then by minutes. Unplanned downtime from the downtime log, clipped to the period (stops that began earlier are pro-rated); kiln time = minutes the line constraint was held up with the asset’s stop events as the cause (event-engine attribution, whole events).';
  if (!machines.length)
    return compose(
      'machine-downtime',
      p.label,
      {
        observed: [`No process machine had unplanned downtime in ${inPeriod(p.label)}.`, conveyors.length ? `Conveyors: ${conveyors.map((r) => `${r.id} ${int(r.minutes)} min`).join(', ')}.` : null],
        method: [method],
      },
      { links: [{ kind: 'workspace', id: 'production', label: 'Open OEE & Loss' }], followUps: ['Which conveyor stopped most recently?', 'What prevents us from reaching theoretical output?'] },
    );
  const top = machines[0];
  const byLine = [...all].sort((a, b) => b.constraintMin - a.constraintMin)[0];
  const lineLoss = top.stopEvents
    .filter((e) => !e.consequenceOf)
    .map((e) => eventImpact(s, e, finance, tariffs).estimate)
    .reduce((a, e) => a + (e?.lines.filter((l) => /Lost good output/.test(l.label)).reduce((x, l) => x + l.amount, 0) ?? 0), 0);
  const latest = [...top.stopEvents].sort((a, b) => b.start - a.start)[0];
  return compose(
    'machine-downtime',
    p.label,
    {
      observed: [
        `${top.id} (${nameOf(top.id)}) has the greatest downtime loss in ${inPeriod(p.label)}: ${int(top.minutes)} min of unplanned downtime over ${plural(top.events, 'stop')}, ≈ ${m2(top.lostTiles)} not made at its ideal rate${top.active ? ' — it is still down' : ''}.`,
        machines.length > 1 ? `Next: ${machines.slice(1, 3).map((r) => `${r.id} ${int(r.minutes)} min (${m2(r.lostTiles)})`).join(', ')}.` : null,
        top.stopEvents.length ? `Its stop events (${top.stopEvents.map((e) => e.id).join(', ')}) held the kiln up ${int(top.constraintMin)} min.` : null,
        conveyors.length ? `Conveyor downtime in the period: ${conveyors.map((r) => `${r.id} ${int(r.minutes)} min${r.constraintMin ? ` (kiln held up ${int(r.constraintMin)} min)` : ''}`).join(', ')}.` : null,
      ],
      inferred: [
        top.id === 'H-KILN'
          ? inf('confirmed', 'the kiln is the line constraint: its downtime is line output lost one for one', 'line design')
          : top.constraintMin === 0
            ? inf('likely', `the buffers between ${top.id} and the kiln absorbed its stops — no line output was lost because of it`, 'the kiln was not held up while it was down')
            : inf('likely', `${top.id}'s stops reached the kiln and cost line output for ${int(top.constraintMin)} min`, 'event-engine attribution of kiln hold-up minutes'),
        byLine && byLine.constraintMin > 0 && byLine.id !== top.id
          ? inf('likely', `for line output, ${byLine.id} (${nameOf(byLine.id)}) mattered more: its stops held the kiln up ${int(byLine.constraintMin)} min`, 'event-engine attribution of kiln hold-up minutes')
          : null,
      ],
      estimate: lineLoss > 0.005 ? [`Line output lost through ${top.id}'s stop events ≈ ${money(finance.currency, lineLoss)} of contribution (from the event estimates).`, assumptionsText(finance, ['output'])] : [],
      method: [method],
    },
    {
      facts: machines.slice(0, 5).map((r) => ({ label: `${r.id} · ${nameOf(r.id)}`, value: `${int(r.minutes)} min · ${m2(r.lostTiles)} · kiln ${int(r.constraintMin)} min` })),
      links: [...equipmentLink(top.id), ...(latest ? [eventLink(latest)] : []), ...stageLink(OPS_BY_ID[top.id]?.stage), { kind: 'workspace', id: 'production', label: 'Open OEE & Loss' }],
      followUps: ['What caused the largest downtime loss?', 'What is the estimated cost of the current production loss?'],
      eventId: latest?.id,
    },
  );
}

const isConveyorStop = (d: DowntimeEvent) =>
  CONVEYOR_BY_ID[d.equipmentId] != null && d.category !== 'Planned' && d.category !== 'Starved' && d.category !== 'Blocked' && !REASON_BY_CODE[d.reasonCode]?.planned && !(d.end != null && d.end <= d.start);

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
  const method = 'Conveyor stops come from the run-state signal (rule R-CONV, simulated PLC). Starvation or blocking of the neighbouring stages is linked to a stop when it is the first held-up asset in that direction; line output counts as lost only while the kiln is held up.';
  if (!stops.length)
    return compose(
      'conveyor-stop',
      'Simulated history',
      { observed: [`No ${focus ? `${focus} ` : 'conveyor '}stop is recorded in the simulated history.`, nowLine], method: [method] },
      { links: [{ kind: 'workspace', id: 'monitoring', label: 'Open Production Monitoring' }], followUps: ['Which machine has the greatest downtime loss?'] },
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
  return compose(
    'conveyor-stop',
    focus && cm ? p.label : 'Simulated history',
    {
      observed: [
        `${d.equipmentId} (${conv.name}) ${focus ? 'last stopped' : 'stopped most recently'} on ${formatDay(d.start)} at ${clock(d.start)} — ${low1(reason.label)} (${d.reasonCode})${d.source === 'scenario' ? ', injected by a simulation scenario' : ''}. ${ongoing ? `It is still stopped: ${formatDuration(dur)} so far.` : `Running again since ${clock(d.end!)} after ${formatDuration(dur)}.`}`,
        into.length || outOf.length ? `While it is stopped, ${[into.length ? `${into.join(' and ')} receive${into.length > 1 ? '' : 's'} no tiles` : '', outOf.length ? `${outOf.join(' and ')} cannot discharge onto it` : ''].filter(Boolean).join('; ')}.` : null,
        ev
          ? ev.acc.constraintMin > 0
            ? `Event ${ev.id}: the kiln (line constraint) was held up ${int(ev.acc.constraintMin)} min because of it.`
            : `Event ${ev.id}: no kiln time lost${ongoing ? ' so far' : ''} — ${conv.bufferId ? `buffer ${conv.bufferId}` : 'the buffers'} covered the stop.`
          : null,
        cm ? `In ${inPeriod(p.label)}: ${plural(cm.stops, 'stop')}, ${int(cm.downMin)} min down, running ${pct(cm.availability, 0)} of planned time, utilisation ${pct(cm.utilisation, 0)} of its ${int(conv.capacityPerHour)} tiles/h capacity.` : null,
        nowLine,
        `${plural(last24.length, 'conveyor stop')} in the last 24 h${last24.length > 1 ? `; before this one: ${last24.slice(1, 4).map((x) => `${x.equipmentId} at ${clock(x.start)} (${formatDuration((x.end ?? s.minute) - x.start)})`).join(', ')}` : ''}.`,
      ],
      inferred: [
        ...(ev ? ev.causes.slice(0, 2).map(fmtCause) : []),
        ...consequences.slice(0, 3).map((x) => inf('likely', `${x.id} (${x.title}) is a consequence of this stop`, 'the stopped conveyor is the first held-up asset in that direction (inferred from states and buffers)')),
      ],
      estimate: est && est.total > 0.005 ? [`${ev!.id} cost ≈ ${money(est.currency, est.total)}${ongoing ? ' so far' : ''}: ${estimateLines(est).join('; ')}.`, assumptionsText(finance, ['output'])] : [],
      method: [method],
    },
    {
      facts: stops.slice(0, 5).map((x) => ({ label: `${x.equipmentId} · ${formatDay(x.start)} ${clock(x.start)}`, value: `${formatDuration((x.end ?? s.minute) - x.start)}${x.end == null ? ' (ongoing)' : ''} · ${REASON_BY_CODE[x.reasonCode]?.label ?? x.reasonCode}` })),
      links: [...(ev ? [eventLink(ev)] : []), ...equipmentLink(d.equipmentId), ...stageLink(conv.blocksInputOf[0] ?? conv.to), { kind: 'workspace', id: 'monitoring', label: 'Open Production Monitoring' }],
      followUps: ev ? [`Why did ${ev.id} happen?`, `What is the impact of ${ev.id}?`] : ['Which machine has the greatest downtime loss?'],
      eventId: ev?.id,
    },
  );
}

function kilnAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s, tariffs } = c;
  const k = machineMetrics(s, 'H-KILN', p);
  const st = stageMetrics(s, p).find((x) => x.stage === 'KILN')!;
  const bn = bottleneck(s);
  const idle = kilnIdleBurn(s, p);
  const state = s.machines['H-KILN'];
  const where =
    bn.current.stage === 'KILN'
      ? 'It is currently the bottleneck.'
      : `The current bottleneck is ${bn.current.name.toLowerCase()}, ${bn.cause === 'blocking' ? 'which cannot take its output, so the kiln is blocked' : 'which is starving it'}.`;
  return compose(
    'kiln',
    p.label,
    {
      observed: [
        `The kiln is ${stateWord(state.state)} (since ${clock(state.since)}). In ${inPeriod(p.label)} it ran at availability ${metricPct(k.oee.availability)} and performance ${metricPct(k.oee.performance)} and fired ${m2(k.totals.count)}.`,
        `It was starved ${int(k.totals.starved)} min, blocked ${int(k.totals.blocked)} min and down ${int(k.totals.down)} min — time the line cannot recover because the kiln is the designed constraint.`,
        `Input buffer ${pct(st.inputBufferLevel, 0)} full.`,
      ],
      inferred: [inf('likely', where, `stage state shares over the ${bn.period.label.toLowerCase()}`)],
      estimate: [
        `While waiting for tiles the kiln still burnt ≈ ${int(idle)} kWh of gas — ≈ ${money(tariffs.currency, idle * tariffs.gas)}.`,
        tariffText(tariffs),
      ],
      method: ['Kiln time accounting from its state and counter (simulated PLC); idle burn from the illustrative energy model for the starved and blocked minutes.'],
    },
    {
      facts: [
        { label: 'Kiln availability', value: metricPct(k.oee.availability) },
        { label: 'Kiln performance', value: metricPct(k.oee.performance) },
        { label: 'Starved', value: `${int(k.totals.starved)} min` },
        { label: 'Blocked', value: `${int(k.totals.blocked)} min` },
        { label: 'Input buffer', value: pct(st.inputBufferLevel, 0) },
      ],
      links: [...equipmentLink('H-KILN', 'Locate the kiln'), ...stageLink('KILN'), { kind: 'workspace', id: 'energy', label: 'Kiln energy' }],
      followUps: ['Which machine is the main bottleneck?', 'What prevents us from reaching theoretical output?'],
    },
  );
}

// ── OEE, capacity and loss ────────────────────────────────────────────────────

function oeeAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s } = c;
  const lm = lineMetrics(s, p);
  const o = lm.oee;
  const k = lm.constraint.totals;
  const ideal = lm.constraint.idealRatePerHour;
  const factors = [
    { name: 'availability', m: o.availability, why: 'stops and waiting at the kiln (down, starved or blocked)' },
    { name: 'performance', m: o.performance, why: 'the kiln running below its design rate' },
    { name: 'quality', m: o.quality, why: 'tiles rejected at sorting' },
  ].filter((f) => f.m.status === 'ok');
  const weakest = [...factors].sort((a, b) => a.m.value! - b.m.value!)[0];
  return compose(
    'oee',
    p.label,
    {
      observed: [
        `Line OEE for ${inPeriod(p.label)}: ${oeeEquation(o)}. Target ${pct(TARGET.oeeTarget, 0)}${o.oee.status === 'ok' ? ` — ${((TARGET.oeeTarget - o.oee.value!) * 100).toFixed(1)} pts ${o.oee.value! < TARGET.oeeTarget ? 'below' : 'above'}` : ''}.`,
        `Availability ${metricPct(o.availability)} = kiln operating time ÷ planned production time = ${int(k.operating)} ÷ ${int(k.planned)} min (${int(k.plannedStop)} min of planned stops excluded; down ${int(k.down)}, starved ${int(k.starved)}, blocked ${int(k.blocked)} min).`,
        `Performance ${metricPct(o.performance)} = ideal cycle ${(3600 / ideal).toFixed(2)} s × ${int(k.count)} tiles fired ÷ ${int(k.operating)} min operating (design rate ${int(ideal)} tiles/h).`,
        `Quality ${metricPct(o.quality)} = first-pass good ÷ inspected at sorting = ${int(lm.good)} ÷ ${int(lm.inspected)}.`,
      ],
      inferred: [weakest && weakest.m.value! < 0.99 ? inf('likely', `${weakest.name} is the largest OEE loss (${pct(1 - weakest.m.value!)} lost) — ${weakest.why}`, 'lowest of the three factors this period') : null],
      method: [
        'Simplified demo OEE: availability and performance are measured at the line constraint (H-KILN) — the line runs at the kiln’s pace — and quality is first-pass yield at sorting, so the factors come from two counting points. Planned stops are excluded from planned time; values are never clamped (an inconsistent input shows as invalid).',
      ],
    },
    {
      facts: [
        { label: 'Planned time', value: `${int(k.planned)} min` },
        { label: 'Operating time', value: `${int(k.operating)} min` },
        { label: 'Total count (kiln)', value: int(k.count) },
        { label: 'Ideal rate', value: `${int(ideal)} tiles/h` },
        { label: 'Good / inspected', value: `${int(lm.good)} / ${int(lm.inspected)}` },
        { label: 'OEE', value: pct(o.oee.value) },
      ],
      links: [{ kind: 'workspace', id: 'production', label: 'Open OEE & Loss' }, ...stageLink('KILN')],
      followUps: ['What prevents us from reaching theoretical output?', "Why is today's production below target?"],
    },
  );
}

function capacityAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s, finance } = c;
  const cap = capacityBreakdown(s, p);
  const ranked = [...cap.losses].sort((a, b) => b.m2 - a.m2);
  const total = cap.losses.reduce((a, l) => a + l.m2, 0) || 1;
  const lm = lineMetrics(s, p);
  const k = lm.constraint.totals;
  const bn = bottleneck(s);
  const kilnTop = downtimePareto(s, p, { equipmentId: 'H-KILN' })[0];
  const q = qualityIn(s, p);
  const topDefect = DEFECT_ORDER.map((d) => ({ d, n: q.byDefect[d] })).sort((a, b) => b.n - a.n)[0];
  const below = activeEvents(s).find((e) => e.type === 'below-rate' && e.asset.equipmentId === 'H-KILN');
  const explain = (key: string) => {
    if (key === 'availability') {
      const parts = [
        { what: 'kiln starvation (upstream not supplying)', min: k.starved },
        { what: 'kiln blocking (downstream not taking tiles)', min: k.blocked },
        { what: `kiln stops${kilnTop ? ` (largest: ${low1(kilnTop.label)})` : ''}`, min: k.down },
      ].sort((a, b) => b.min - a.min);
      return inf('likely', `the availability loss is mostly ${parts[0].what}: ${int(parts[0].min)} min${bn.shifted ? `; the current bottleneck is ${bn.current.name.toLowerCase()}` : ''}`, 'kiln time accounting of the period');
    }
    if (key === 'speed') return inf(below ? 'confirmed' : 'possible', below ? `the kiln is running below its design rate (${below.id})` : 'short stops or a reduced speed setpoint at the kiln', below ? 'below-rate event on the kiln' : 'speed loss without a below-rate event — not distinguishable from the rate signal alone');
    if (key === 'quality') return inf('likely', `rejects at sorting, largest category ${DEFECTS[topDefect.d].label.toLowerCase()} (${int(topDefect.n)} tiles)`, 'inspection counters of the period');
    return inf('confirmed', 'planned stops (maintenance windows, changeovers) — lost by plan, recoverable only by re-planning', 'production calendar');
  };
  const planGapM2 = Math.max(0, cap.planGapM2);
  const value = planGapM2 > 0.5 ? lostOutputValue(finance, planGapM2 / M2_PER_TILE) : null;
  return compose(
    'capacity-gap',
    p.label,
    {
      observed: [
        `Theoretical output for ${inPeriod(p.label)}: ${area(cap.theoreticalM2)} (kiln design rate × ${int(cap.calendarMin)} min). Plan ${area(cap.plannedM2)}, fired ${area(cap.actualM2)}, first-quality ${area(cap.goodM2)} — ${pct(cap.theoreticalM2 > 0 ? cap.goodM2 / cap.theoreticalM2 : null, 0)} of theoretical.`,
        `What separates good output from theoretical, largest first (${area(cap.capacityGapM2)} in total):`,
        ...ranked.map((l, i) => `${i + 1}. ${l.label}: ${area(l.m2)} (${pct(l.m2 / total, 0)}) — ${low1(l.basis)}.`),
      ],
      inferred: ranked.filter((l) => l.m2 > 0.5).slice(0, 2).map((l) => explain(l.key)),
      estimate: [
        value
          ? `Only the gap to plan is valued: ${area(planGapM2)} ≈ ${money(finance.currency, value.amount)} of contribution (${value.basis}). The gap to theoretical is not a money figure — lost theoretical capacity is not lost revenue.`
          : `Good output is at or above plan, so no financial loss is estimated; the gap to theoretical is not a money figure — lost theoretical capacity is not lost revenue.`,
        value ? assumptionsText(finance, ['output']) : null,
      ],
      method: [`${cap.assumptions.join(' ')} The plan already allows for an ${pct(TARGET.oeeTarget, 0)} OEE, so theoretical output is a ceiling, not a target.`],
    },
    {
      facts: [
        { label: 'Theoretical', value: area(cap.theoreticalM2) },
        { label: 'Plan', value: area(cap.plannedM2) },
        { label: 'Fired (actual)', value: area(cap.actualM2) },
        { label: 'First quality (good)', value: area(cap.goodM2) },
        ...ranked.map((l) => ({ label: l.label, value: area(l.m2) })),
      ],
      links: [{ kind: 'workspace', id: 'production', label: 'Open OEE & Loss' }, ...stageLink(bn.current.stage)],
      followUps: ['What is the current OEE and how is it calculated?', 'What is the estimated cost of the current production loss?'],
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
    'Money figures are estimates from the editable assumptions (OEE & Loss Intelligence): only good output the line could have sold is valued, at contribution margin × sold-out share; rejects at sunk cost or rework; truck waiting at detention cost. Production losses are valued only while the kiln (line constraint) was held up, so each lost tile is counted once.';
  const observed: Lines = [
    `Good output for ${inPeriod(p.label)}: ${m2(lm.output)} against a plan of ${m2(lm.target)}${gap > 0.5 ? ` — ${m2(gap)} behind` : ' — at or above plan'}.`,
    roots.length
      ? `${plural(roots.length, 'active root event')}, ${costed.length} with a money estimate${uncosted.length ? `; not valued: ${uncosted.slice(0, 4).map((e) => `${e.id} (${noValueReason(e)})`).join(', ')}` : ''}.`
      : 'No event is active right now.',
    consequences.length
      ? `${plural(consequences.length, 'consequence event')} (${consequences.map((e) => `${e.id} → ${e.consequenceOf}`).join(', ')}) — valued under their root event, never added again.`
      : null,
  ];
  if (!shiftValue && !costed.length)
    return compose(
      'loss-cost',
      p.label,
      { observed, estimate: ['No production loss to value right now: good output is at or above plan and no active event carries a money estimate.'], method: [method] },
      { links: [{ kind: 'workspace', id: 'production', label: 'Open OEE & Loss' }], followUps: ['What prevents us from reaching theoretical output?'] },
    );
  return compose(
    'loss-cost',
    p.label,
    {
      observed,
      inferred: costed
        .filter((x) => x.e.category === 'production' && x.e.acc.constraintMin > 0)
        .slice(0, 3)
        .map((x) => inf('likely', `${x.e.id} (${x.e.title}) explains ${int(x.e.acc.constraintMin)} min of kiln hold-up`, 'kiln hold-up minutes attributed to the event by the event engine')),
      estimate: [
        shiftValue
          ? `Shift line loss against plan so far ≈ ${money(finance.currency, shiftValue.amount)} (${shiftValue.basis}).`
          : 'Good output is at or above plan: no line loss against plan to value.',
        ...costed.slice(0, 5).map((x) => `${x.e.id} · ${x.e.title}: ≈ ${money(x.est.currency, x.est.total)} — ${estimateLines(x.est).join('; ')}.`),
        costed.length
          ? 'These event estimates are not added to the shift figure: the line loss of production events is already part of the shift gap, and several quality rules can describe the same rejects.'
          : null,
        assumptionsText(finance, [...kinds]),
      ],
      method: [method],
    },
    {
      facts: [
        { label: 'Gap to plan', value: m2(gap) },
        { label: 'Value of the gap', value: shiftValue ? money(finance.currency, shiftValue.amount) : '—' },
        { label: 'Contribution per m²', value: money(finance.currency, contributionPerM2(finance)) },
        ...costed.slice(0, 4).map((x) => ({ label: x.e.id, value: money(x.est.currency, x.est.total) })),
      ],
      links: [...costed.slice(0, 3).map((x) => eventLink(x.e)), { kind: 'workspace', id: 'production', label: 'Edit assumptions in OEE & Loss' }],
      followUps: costed.length ? [`What is the impact of ${costed[0].e.id}?`, 'What prevents us from reaching theoretical output?'] : ['What prevents us from reaching theoretical output?'],
      eventId: costed[0]?.e.id,
    },
  );
}

// ── Defect monitoring ─────────────────────────────────────────────────────────

function defectsAnswer(c: Ctx, p: Period, focus: DefectCategory | null): CopilotAnswer {
  const { s, finance } = c;
  const shift = defectShift(s, 120, 1440);
  const from = Math.floor((s.minute - 120) / 60) * 60;
  const row = (focus ? shift.find((d) => d.defect === focus) : undefined) ?? shift[0];
  const ratio = row.ratio != null ? `${row.ratio.toFixed(1)}×` : '—';
  const rising = row.ratio != null && row.ratio > 1.3 && (row.rateRecent ?? 0) > 0.001;
  const others = shift.filter((d) => d !== row && d.ratio != null && d.ratio > 1.3 && (d.rateRecent ?? 0) > 0.001);
  const q2 = qualityIn(s, p);
  const recent = qualityIn(s, { from, to: s.minute, label: '' });
  const qOpen = s.events.filter((e) => e.category === 'quality' && e.status !== 'resolved').sort((a, b) => b.lastUpdate - a.lastUpdate);
  // Latest quality event of the category that overlaps the compared windows (older ones say nothing about the change).
  const evRow = s.events
    .filter((e) => e.category === 'quality' && e.refs.defect === row.defect && (e.end == null || e.end >= from - 1440))
    .sort((a, b) => b.start - a.start)[0];
  const origin = DEFECTS[row.defect].origin;
  const excess = rising && row.rateRef != null ? Math.max(0, ((row.rateRecent ?? 0) - row.rateRef) * recent.inspected) : 0;
  const cost = excess > 0.5 ? rejectCost(finance, excess) : null;
  return compose(
    'defects',
    `Since ${clock(from)} vs the 24 h before`,
    {
      observed: [
        rising
          ? `${row.label} has increased ${focus ? '' : 'the most'}: ${pct(row.rateRecent, 2)} of inspected tiles since ${clock(from)} versus ${pct(row.rateRef, 2)} in the 24 h before (${ratio}).`.replace('  ', ' ')
          : focus
            ? `${row.label}: ${pct(row.rateRecent, 2)} of inspected tiles since ${clock(from)} versus ${pct(row.rateRef, 2)} in the 24 h before (${ratio}) — not a significant increase.`
            : `No defect category has increased significantly since ${clock(from)}; the largest relative change is ${row.label.toLowerCase()} at ${ratio} its 24 h rate.`,
        others.length ? `Also up: ${others.slice(0, 3).map((d) => `${d.label.toLowerCase()} ${d.ratio!.toFixed(1)}×`).join(', ')}.` : null,
        `In ${inPeriod(p.label)} gauge and vision inspected ${int(q2.inspected)} tiles and rejected ${int(q2.rejected)} (${pct(q2.inspected ? q2.rejected / q2.inspected : null, 2)}).`,
        qOpen.length ? `Open quality events: ${qOpen.slice(0, 3).map((e) => `${e.id} ${e.title}`).join('; ')}.` : 'No quality event is open.',
      ],
      inferred: [
        ...(rising && evRow ? evRow.causes.slice(0, 2).map(fmtCause) : []),
        rising && !evRow ? inf('possible', `${row.label.toLowerCase()} usually originates at ${STAGE_BY_ID[origin].name.toLowerCase()} — ${low1(DEFECT_ACTIONS[row.defect])}`, 'process knowledge of the defect category; a hypothesis to check') : null,
      ],
      estimate: cost
        ? [
            `Excess ${row.label.toLowerCase()} rejects since ${clock(from)} ≈ ${int(excess)} tiles (${m2(excess)}) → scrap and rework ≈ ${money(finance.currency, cost.reduce((a, l) => a + l.amount, 0))} (${cost.map((l) => `${low1(l.label)} ${money(finance.currency, l.amount)}`).join(', ')}).`,
            recent.inspected > 0 ? `Effect on the quality factor of OEE in that window ≈ −${((excess / recent.inspected) * 100).toFixed(2)} pts.` : null,
            assumptionsText(finance, ['reject']),
          ]
        : [],
      method: [
        `Rate per category = rejects of the category ÷ tiles inspected (gauge + vision). Recent window since ${clock(from)} vs the 24 h before; rule Q-DET raises an event at ≥ ${s.rules.deteriorationRatio}×. Inspection records and classifications are simulated — no vision model is running.`,
      ],
    },
    {
      facts: shift.slice(0, 4).map((d) => ({ label: d.label, value: d.ratio != null ? `${d.ratio.toFixed(1)}× · ${pct(d.rateRecent, 2)}` : '—' })),
      links: [...(evRow ? [eventLink(evRow)] : []), ...equipmentLink('I-VIS', 'Locate inspection tunnel'), ...equipmentLink(STAGE_BY_ID[origin].machines[0], `Origin: ${STAGE_BY_ID[origin].name}`), ...stageLink('SORT'), { kind: 'workspace', id: 'quality', label: 'Open Defect Monitoring' }],
      followUps: ['Show the report and evidence for the latest defect.', 'What is the estimated cost of the current production loss?'],
      eventId: evRow?.id,
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
      'defect-report',
      'Simulated history',
      {
        observed: [
          `No quality event has been raised for ${label} in the demo history, so there is no defect report yet.`,
          rec
            ? `Latest reject record: ${rec.id} at ${clock(rec.time)} — ${rec.defect ? DEFECTS[rec.defect].label.toLowerCase() : 'reject'}${rec.severity ? ` (${rec.severity})` : ''}, simulated confidence ${pct(rec.confidence, 0)}${rec.measurement ? `, ${rec.measurement}` : ''}.`
            : 'No reject record is available.',
        ],
        method: ['Quality events are raised by the reject-rate, count, repeat, deterioration and critical-defect rules on simulated inspection records — no vision model.'],
      },
      { links: [{ kind: 'workspace', id: 'quality', label: 'Open Defect Monitoring' }], followUps: ['Which defect category has increased?'] },
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
  return compose(
    'defect-report',
    `${clock(pick.start)} → ${pick.end == null ? 'now' : clock(pick.end)}`,
    {
      observed: [
        `${rep.summary.id} · ${rep.summary.title} — ${rep.summary.severity.toLowerCase()}, ${rep.summary.status.toLowerCase()}, condition ${rep.summary.condition.toLowerCase()}; detected ${formatDateTime(pick.start)} by rule ${rep.detection.rule} (${rep.detection.ruleLabel}).`,
        rep.summary.text,
        recs.length
          ? `Inspection evidence: ${recs.map((r) => `${r.id} ${r.defect ? DEFECTS[r.defect].label.toLowerCase() : 'reject'}${r.severity ? ` (${r.severity})` : ''} at ${clock(r.time)}, simulated confidence ${pct(r.confidence, 0)}${r.measurement ? `, ${r.measurement}` : ''}`).join('; ')}.`
          : 'No individual inspection record falls in the event window.',
        counts.length ? `Counts in the window: ${counts.map((m) => `${low1(m.label)} ${m.value}${m.unit && m.unit !== '%' ? ` ${m.unit}` : ''}`).join(', ')}.` : null,
        ...cams.map((x) => `${x.title}: ${x.status === 'available' ? `captured — ${x.originLabel.toLowerCase()}` : x.status === 'pending' ? 'being captured' : `unavailable — ${x.unavailableReason ?? 'no view'}`}.`),
        rep.provenance.unavailable.length ? `Not available: ${rep.provenance.unavailable.map((u) => `${u.title} (${low1(u.reason)})`).join('; ')}.` : null,
      ],
      inferred: rep.diagnosis.causes.slice(0, 3).map(fmtCause),
      estimate: est && est.total > 0.005 ? [`Estimated impact ≈ ${money(est.currency, est.total)}: ${estimateLines(est).join('; ')}.`, `Assumptions: ${est.assumptions.join(' ')}`] : [],
      method: [`Same report model as Events & Reports and the PDF export, built from the event record ${pick.id}. Inspection frames are illustrative — simulated classification, no vision model; confidence values are simulated.`],
    },
    {
      facts: [
        { label: 'Event', value: pick.id },
        { label: 'Category', value: pick.refs.defect ? DEFECTS[pick.refs.defect].label : 'All categories' },
        { label: 'Status', value: EVENT_STATUS_LABEL[pick.status] },
        { label: 'Records', value: recs.map((r) => r.id).join(', ') || '—' },
      ],
      links: [eventLink(pick, `Open report ${pick.id}`), ...equipmentLink(station, 'Locate inspection station'), ...stageLink('SORT'), { kind: 'workspace', id: 'quality', label: 'Open Defect Monitoring' }],
      followUps: [`Why did ${pick.id} happen?`, `What is the impact of ${pick.id}?`],
      eventId: pick.id,
    },
  );
}

// ── Vehicle monitoring ────────────────────────────────────────────────────────

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
  const evs =s.events.filter((e) => e.type === 'turnaround-exceeded' && (e.end == null || e.end >= from)).sort((a, b) => b.start - a.start);
  const evOf = (vid: string) => evs.find((e) => e.asset.vehicleId === vid);
  const describe = (x: { v: (typeof onSite)[number]['v']; min: number; onSite: boolean }) => {
    const e = evOf(x.v.id);
    return `${x.v.label} ${int(x.min)} min${x.onSite ? ` (${phaseLabel[x.v.phase ?? 'waiting'].toLowerCase()})` : ` (left ${clock(x.v.visit!.gateOut!)})`}${e ? ` · ${e.id}` : ''}`;
  };
  const why = [...over, ...done].slice(0, 3).map((x) => {
    const d = visitDurations(x.v, now);
    const parts = [
      { what: 'waiting for a dock', min: d.waiting ?? 0 },
      { what: 'at the dock (loading / unloading)', min: d.dockTime ?? 0 },
    ];
    parts.push({ what: 'at the gate, weighbridge and on the yard roads', min: Math.max(0, x.min - parts[0].min - parts[1].min) });
    const top = parts.sort((a, b) => b.min - a.min)[0];
    return inf('likely', `${x.v.label} spent most of its ${int(x.min)} min ${top.what} (${int(top.min)} min)`, 'gate, check-in and dock timestamps of the visit (simulated)');
  });
  const waitEvents = s.events.filter((e) => e.type === 'truck-waiting' && [...over, ...done].some((x) => x.v.id === e.asset.vehicleId));
  const waitCost = waitEvents.reduce((a, e) => a + (eventImpact(s, e, finance, tariffs).estimate?.total ?? 0), 0);
  const ids = [...over, ...done].map((x) => x.v.id);
  return compose(
    'turnaround',
    'Now and the last 24 h',
    {
      observed: [
        `Threshold: ${max} min on site from gate-in to gate-out (rule L-TURN).`,
        over.length
          ? `On site now above the threshold (${over.length}): ${over.map(describe).join(', ')}.`
          : onSite.length
            ? `No truck on site is above the threshold now; longest on site: ${describe(onSite[0])}.`
            : 'No truck is on site now.',
        done.length
          ? `Completed visits above the threshold in the last 24 h (${done.length}): ${done.slice(0, 5).map(describe).join(', ')}.`
          : `No completed visit in the last 24 h exceeded the threshold${longest ? `; longest: ${describe(longest)}` : ''}.`,
        evs.length ? `Turnaround events: ${evs.slice(0, 4).map((e) => `${e.id} (${e.asset.vehicleId}, ${EVENT_STATUS_LABEL[e.status].toLowerCase()})`).join(', ')}.` : null,
      ],
      inferred: why,
      estimate: waitCost > 0.005 ? [`Detention for waiting beyond the ${s.rules.truckWaitMax}-min threshold on these trucks ≈ ${money(finance.currency, waitCost)} (their truck-waiting events).`, assumptionsText(finance, ['wait'])] : [],
      method: ['Turnaround = gate-out − gate-in from the simulated gate events; for trucks still on site, the time since gate-in. Vehicle positions and gate events are simulated at zone level — no GPS or ANPR is connected.'],
    },
    {
      facts: [...over, ...done].slice(0, 6).map((x) => ({ label: x.v.label, value: `${int(x.min)} min · ${x.onSite ? phaseLabel[x.v.phase ?? 'waiting'] : 'departed'}` })),
      links: [
        ...over.slice(0, 2).map((x): InsightLink => ({ kind: 'vehicle', id: x.v.id, label: `Follow ${x.v.label}` })),
        ...evs.filter((e) => ids.includes(e.asset.vehicleId ?? '')).slice(0, 2).map((e) => eventLink(e)),
        { kind: 'workspace', id: 'fleet', label: 'Open Vehicle Monitoring' },
      ],
      followUps: evs[0] ? [`Why did ${evs[0].id} happen?`, 'What should the supervisor investigate first?'] : ['What should the supervisor investigate first?'],
      eventId: evs[0]?.id,
    },
  );
}

function logisticsAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s } = c;
  const fm = fleetMetrics(s, p);
  const docked = Object.values(s.logistics.docks).filter((d) => d.vehicleId).length;
  const open = s.events.filter((e) => e.category === 'logistics' && e.end == null);
  return compose(
    'logistics',
    p.label,
    {
      observed: [
        `${plural(fm.onSite, 'external vehicle')} on site: ${fm.waiting} waiting for a dock, ${fm.atDock} loading or unloading; ${docked} of ${Object.keys(s.logistics.docks).length} docks occupied.`,
        `In ${inPeriod(p.label)}: ${plural(fm.completedVisits, 'visit')} completed, average turnaround ${fm.avgTurnaround != null ? `${int(fm.avgTurnaround)} min` : '—'}, gate-to-dock ${fm.avgGateToDock != null ? `${int(fm.avgGateToDock)} min` : '—'}, dock utilisation ${pct(fm.dockUtilisation, 0)}.`,
        open.length ? `Active vehicle events: ${open.slice(0, 4).map((e) => `${e.id} ${e.title}`).join('; ')}.` : 'No vehicle event is active.',
      ],
      method: ['Vehicle positions and gate events are simulated at zone level; no GPS, ANPR or indoor positioning is connected.'],
    },
    {
      facts: [
        { label: 'On site', value: String(fm.onSite) },
        { label: 'Waiting', value: String(fm.waiting) },
        { label: 'Warehouse stock', value: `${fm.stockPallets} pallets` },
      ],
      links: [...open.slice(0, 2).map((e) => eventLink(e)), { kind: 'workspace', id: 'fleet', label: 'Open Vehicle Monitoring' }],
      followUps: ['Which trucks exceeded their turnaround threshold?', 'What should the supervisor investigate first?'],
    },
  );
}

// ── Supervisor ────────────────────────────────────────────────────────────────

function investigateFirst(c: Ctx): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const open = openEvents(s);
  const method =
    'Open = not yet resolved (active, acknowledged or investigating). Ranked by severity, then minutes the event held up the kiln (line constraint), then the most recent update; consequence events are folded under their root event so the same loss is not investigated twice.';
  if (!open.length)
    return compose('investigate-first', 'Open events', { observed: ['No event is open — every event in the demo state is resolved.'], method: [method] }, { links: [{ kind: 'workspace', id: 'events', label: 'Open Events & Reports' }], followUps: ["Why is today's production below target?"] });
  const ids = new Set(open.map((e) => e.id));
  const roots = open.filter((e) => !e.consequenceOf || !ids.has(e.consequenceOf));
  const ranked = [...roots].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.acc.constraintMin - a.acc.constraintMin || b.lastUpdate - a.lastUpdate);
  const consOf = (e: OpEvent) => open.filter((o) => o.consequenceOf === e.id);
  const top = ranked[0];
  const est = eventImpact(s, top, finance, tariffs).estimate;
  const activeN = open.filter((e) => e.end == null).length;
  const handled = open.filter((e) => e.status !== 'active').length;
  const reasons = [
    `${top.severity} severity`,
    top.end == null ? `condition still active (${formatDuration(s.minute - top.start)})` : `condition cleared at ${when(s, top.end)} but not yet resolved`,
    top.acc.constraintMin > 0 ? `it has held the kiln up ${int(top.acc.constraintMin)} min — line output lost` : null,
    consOf(top).length ? `${plural(consOf(top).length, 'consequence event')} depend on it` : null,
  ].filter(Boolean);
  return compose(
    'investigate-first',
    'Open events',
    {
      observed: [
        `${plural(open.length, 'open event')}: ${activeN} with the condition still active, ${handled} acknowledged or under investigation.`,
        ...ranked.slice(0, 5).map(
          (e, i) =>
            `${i + 1}. ${e.id} · ${cap1(e.severity)} · ${e.title} — ${e.end == null ? `active ${formatDuration(s.minute - e.start)}` : `cleared ${when(s, e.end)}`}${e.acc.constraintMin > 0 ? `, kiln held up ${int(e.acc.constraintMin)} min` : ''}${consOf(e).length ? `, +${plural(consOf(e).length, 'consequence')}` : ''} · ${EVENT_STATUS_LABEL[e.status].toLowerCase()} · updated ${when(s, e.lastUpdate)}.`,
        ),
      ],
      inferred: [`Recommended first: ${top.id} (${top.title}) — ${reasons.join('; ')}.`, ...top.causes.slice(0, 1).map((x) => fmtCause({ ...x, text: `suspected cause — ${low1(x.text)}` }))],
      estimate: est && est.total > 0.005 ? [`${top.id} has cost ≈ ${money(est.currency, est.total)} so far: ${estimateLines(est).join('; ')}.`, `Assumptions: ${est.assumptions.join(' ')}`] : [],
      method: [method],
    },
    {
      facts: ranked.slice(0, 5).map((e) => ({ label: `${e.id} · ${e.title}`, value: `${cap1(e.severity)} · ${EVENT_STATUS_LABEL[e.status]}` })),
      links: [...ranked.slice(0, 3).map((e) => eventLink(e)), ...assetLinks(top)],
      followUps: [`What happened in ${top.id}?`, `What should we do about ${top.id}?`, 'What is the estimated cost of the current production loss?'],
      eventId: top.id,
    },
  );
}

function nextActionsAnswer(c: Ctx): CopilotAnswer {
  const { s, tariffs } = c;
  const acts = nextActions(s, { tariffs });
  if (!acts.length)
    return compose('next-actions', 'Now', { observed: ['Nothing needs intervention right now: no stoppage, health warning, quality or energy exception is active.'], method: ['Rule-based insights over the current state.'] }, { followUps: SUGGESTED_QUESTIONS.slice(0, 3) });
  return compose(
    'next-actions',
    'Now',
    {
      observed: acts.slice(0, 4).map((a) => `${a.title}: ${a.summary}`),
      inferred: acts.map((a, i) => `Recommended ${i + 1}: ${a.title} — ${a.recommendation}`),
      method: ['Recommendations are rule-based insights over the current state, in priority order (severity, then impact).'],
    },
    {
      facts: acts.slice(0, 4).map((a) => ({ label: a.title, value: a.impact ?? a.severity })),
      links: acts.flatMap((a) => a.links.slice(0, 1)).slice(0, 4),
      followUps: ['What should the supervisor investigate first?', "Why is today's production below target?"],
    },
  );
}

// ── Equipment, energy ─────────────────────────────────────────────────────────

const healthText = (h: HealthAssessment) => (h.level === 'offline' ? 'not running, not assessed' : `${h.score}/100 · ${h.level}`);

function healthAnswer(c: Ctx, machine: string | null): CopilotAnswer {
  const { s } = c;
  const list = machine && HEALTH_BY_ID[machine] ? [assess(s, machine)] : healthAssessments(s);
  // Most severe level first, lowest score first within a level; offline (not assessed) last.
  const ranked = [...list].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.score - b.score);
  const worst = ranked.find((h) => h.level !== 'offline') ?? ranked[0];
  const atRisk = ranked.filter((h) => h.level === 'warning' || h.level === 'alarm' || h.level === 'watch');
  const offline = ranked.filter((h) => h.level === 'offline');
  const ev = s.events.find((e) => e.dedupeKey === `cond:${worst.id}` && e.end == null);
  return compose(
    'health',
    'Last 3 h of signals',
    {
      observed: [
        worst.level === 'offline'
          ? `${worst.id} (${nameOf(worst.id)}) is not running, so it is not assessed.`
          : atRisk.length
            ? `${plural(atRisk.length, 'asset')} ${atRisk.length > 1 ? 'show' : 'shows'} an abnormal pattern. Most at risk: ${worst.id} (${nameOf(worst.id)}), health ${worst.score}/100, level ${worst.level}.`
            : `All monitored assets that are running are within normal limits. Lowest health score: ${worst.id} at ${worst.score}/100.`,
        ...worst.findings,
        offline.length && worst.level !== 'offline' ? `Not running, not assessed: ${offline.map((h) => h.id).join(', ')}.` : null,
      ],
      inferred: [
        worst.etaTripH != null ? inf('possible', `${worst.id} reaches its trip limit in ≈ ${formatH(worst.etaTripH)} if the trend continues`, 'linear extrapolation of the 3-h vibration trend') : null,
        worst.recommendation ? `Recommended: ${worst.recommendation}` : null,
      ],
      method: ['Detection is rule-based on simulated signals (observed vs expected-at-load vibration, 3-h trend, load-corrected temperature); no trained model or physical sensor is connected.'],
    },
    {
      facts: ranked.slice(0, 4).map((h) => ({ label: h.id, value: healthText(h) })),
      links: [...(ev ? [eventLink(ev)] : []), ...equipmentLink(worst.id), { kind: 'workspace', id: 'health', label: 'Open Machine Health' }],
      followUps: ['What should the supervisor investigate first?', 'Which machine has the greatest downtime loss?'],
      eventId: ev?.id,
    },
  );
}

function machineAnswer(c: Ctx, id: string, p: Period): CopilotAnswer {
  const { s, tariffs } = c;
  const item = EQUIPMENT_BY_ID[id];
  const ops = OPS_BY_ID[id];
  if (!ops || ops.category !== 'process' || !PROCESS_MACHINES.includes(id))
    return compose(
      'machine',
      p.label,
      { observed: [`${item.name} (${id}) — ${item.description}`, 'It has no production counter in this demo; see Assets & Data for its signals.'] },
      { links: equipmentLink(id), followUps: SUGGESTED_QUESTIONS.slice(0, 2) },
    );
  const mm = machineMetrics(s, id, p);
  const m = s.machines[id];
  const active = m.activeDowntimeId ? s.downtime.find((d) => d.id === m.activeDowntimeId) : null;
  const h = HEALTH_BY_ID[id] ? assess(s, id) : null;
  const rec = insights(s, { tariffs }).find((i) => i.equipmentId === id && i.recommendation);
  const openEv = s.events.filter((e) => e.asset.equipmentId === id && e.status !== 'resolved').sort((a, b) => b.lastUpdate - a.lastUpdate);
  return compose(
    'machine',
    p.label,
    {
      observed: [
        `${item.name} (${id}) is ${low1(OPERATIONAL_STATE_LABEL[operationalState(s, id)])} since ${clock(m.since)}${active ? ` — ${low1(REASON_BY_CODE[active.reasonCode].label)}, ${formatDuration(s.minute - active.start)} so far` : ''}.`,
        `In ${inPeriod(p.label)}: output ${m2(mm.totals.count)}, OEE ${oeeEquation(mm.oee)}, ${int(mm.totals.down)} min unplanned downtime.`,
        h ? `Condition: ${healthText(h)}.` : null,
        openEv.length ? `Open events: ${openEv.slice(0, 3).map((e) => `${e.id} ${e.title}`).join('; ')}.` : null,
      ],
      inferred: [rec ? `Recommended: ${rec.recommendation}` : null],
      method: ['Machine OEE uses the machine’s own time accounting and the rejects attributed to its stage (simulated PLC state and counter).'],
    },
    {
      facts: [
        { label: 'State', value: OPERATIONAL_STATE_LABEL[operationalState(s, id)] },
        { label: 'OEE', value: pct(mm.oee.oee.value) },
        { label: 'Downtime', value: `${int(mm.totals.down)} min` },
      ],
      links: [...equipmentLink(id), ...openEv.slice(0, 2).map((e) => eventLink(e)), ...stageLink(ops.stage)],
      followUps: openEv[0] ? [`What happened in ${openEv[0].id}?`, 'What should the supervisor investigate first?'] : ['What should the supervisor investigate first?'],
      eventId: openEv[0]?.id,
    },
  );
}

function energyAnswer(c: Ctx, p: Period): CopilotAnswer {
  const { s, tariffs } = c;
  const e = energyIn(s, p, tariffs);
  const worst = [...e.rows].filter((r) => r.deviation != null && r.expected > 50).sort((a, b) => (b.deviation ?? 0) - (a.deviation ?? 0))[0];
  const idle = kilnIdleBurn(s, p);
  const dev = worst && (worst.deviation ?? 0) > 0.05;
  return compose(
    'energy',
    p.label,
    {
      observed: [
        `${p.label}: ${int(e.total)} kWh (${int(e.thermal)} kWh gas, ${int(e.elec)} kWh electricity); ${e.sec != null ? `${e.sec.toFixed(2)} kWh per good m²` : 'no good output yet'}.`,
        dev ? `${worst.label} is ${pct(worst.deviation, 0)} above the energy model for the same production.` : 'All consumers are within 5 % of the energy model.',
        `The kiln burnt ≈ ${int(idle)} kWh while starved or blocked.`,
      ],
      estimate: [
        `Energy cost ≈ ${money(tariffs.currency, e.cost)}${dev ? `, of which ≈ ${money(tariffs.currency, worst.cost - worst.expectedCost)} is ${worst.label}'s excess over the model` : ''}; kiln idle burn ≈ ${money(tariffs.currency, idle * tariffs.gas)}.`,
        tariffText(tariffs),
      ],
      method: ['Energy values come from an illustrative energy model of the simulated plant (expected consumption for the actual load); deviations compare actual with that model.'],
    },
    {
      facts: [
        { label: 'Total energy', value: `${int(e.total)} kWh` },
        { label: 'vs model', value: pct(e.deviation) },
        { label: 'Cost', value: money(tariffs.currency, e.cost) },
        { label: 'Excess cost', value: money(tariffs.currency, e.excessCost) },
      ],
      links: [...(worst ? equipmentLink(worst.id) : []), { kind: 'workspace', id: 'energy', label: 'Open Energy Intelligence' }],
      followUps: ['How is the kiln affecting production?', 'What should the supervisor investigate first?'],
    },
  );
}

function helpAnswer(c: Ctx): CopilotAnswer {
  void c;
  return compose(
    'help',
    '—',
    {
      method: [
        'I answer from the current simulated plant state: output against target, conveyor stops, downtime by machine, OEE and how it is calculated, the gap to theoretical output, the estimated cost of losses, defects and their reports, truck turnaround, what to investigate first — or one event (type its id, e.g. "What happened in EV-00012?").',
        'This copilot is rule-based: it matches the question to a topic and builds the answer from the same figures, events and reports the workspaces show. No language model is connected.',
      ],
    },
    { followUps: SUGGESTED_QUESTIONS.slice(0, 4) },
  );
}

// ── Event investigation ───────────────────────────────────────────────────────

function eventAnswer(c: Ctx, id: string, sub: EventSub): CopilotAnswer {
  const { s, finance, tariffs } = c;
  const rep = buildEventReport(s, id, { finance, tariffs, generatedAt: toIso(s.minute) });
  if (!rep)
    return compose(
      'help',
      '—',
      { observed: [`Event ${id} is not in the current demo state — Reset Demo replays the plant and removes earlier events.`], method: ['Event investigation reads the event record and its report model.'] },
      { followUps: ['What should the supervisor investigate first?', ...SUGGESTED_QUESTIONS.slice(0, 2)] },
    );
  const ev = rep.event;
  const head = `${ev.id} · ${ev.title}`;
  const period = `${when(s, ev.start)} → ${ev.end == null ? 'now' : when(s, ev.end)}`;
  const condition = ev.end == null ? `active since ${when(s, ev.start)} (${rep.summary.duration})` : `cleared at ${when(s, ev.end)} after ${rep.summary.duration}`;
  const est = rep.impact.estimate;
  const valued = est && est.lines.some((l) => l.amount > 0.005) ? est : null;
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
    links: [eventLink(ev, `Open report ${ev.id}`), ...assetLinks(ev), ...stageLink(ev.asset.stage)],
    followUps: eventQuestionsFor(ev.id).filter((_, i) => i !== ['what', 'why', 'impact', 'action', 'evidence'].indexOf(sub)).slice(0, 3),
    eventId: ev.id,
  };
  const reportMethod = `Built from the event record ${ev.id} and its report model — the same record as Events & Reports and the PDF export.`;
  const observedValues = rep.detection.observed.map((o) => `${low1(o.label)} ${o.value}${o.unit ? ` ${o.unit}` : ''}`).join(', ');
  const threshold = rep.detection.threshold ? `${rep.detection.threshold.value}${rep.detection.threshold.unit ? ` ${rep.detection.threshold.unit}` : ''}` : null;

  switch (sub) {
    case 'why':
      return compose(
        'event-why',
        period,
        {
          observed: [`${head} — what the data shows:`, ...rep.diagnosis.facts.slice(0, 6)],
          inferred: [
            ...(rep.diagnosis.causes.length ? rep.diagnosis.causes.map(fmtCause) : [inf('possible', 'no cause has been inferred for this event yet', 'no correlated stop, scenario or process event was found')]),
            ...rep.context.related.filter((r) => r.relation !== 'Related').map((r) => inf('likely', `${r.id} (${r.title}) — ${low1(r.relation.replace(' (inferred)', ''))}`, 'linked by the event engine from states and buffer levels')),
          ],
          method: [
            'Facts are read from signals and records; causes are hypotheses with a confidence — confirmed = directly observed or a scenario input, likely / possible = inferred from correlated evidence.',
            ...rep.diagnosis.uncertainty,
          ],
        },
        extra,
      );
    case 'impact':
      return compose(
        'event-impact',
        period,
        {
          observed: [`${head} — impact (${ev.end == null ? 'so far' : 'final'}):`, ...rep.impact.rows.map((r) => `${r.label}: ${r.value} — ${low1(r.basis)}.`), ...rep.impact.notes],
          estimate: valued
            ? [`Estimated ≈ ${money(valued.currency, valued.total)}${ev.end == null ? ' so far' : ''}: ${estimateLines(valued).join('; ')}.`, `Assumptions: ${valued.assumptions.join(' ')}`, ...valued.missing.map((m) => `Not estimated: ${m}`)]
            : [`No money estimate for this event — ${est?.missing.length ? low1(joinSentences(est.missing)) : 'its impact is not valued in money'}.`],
          method: [reportMethod, ...(est?.limitations ?? [])],
        },
        extra,
      );
    case 'action': {
      const next =
        ev.status === 'resolved'
          ? `Resolved${ev.resolution ? ` by ${ev.resolution.by === 'user' ? (ev.owner ?? 'a user') : 'the system'} at ${when(s, ev.resolution.t)}: ${ev.resolution.reason.replace(/\.$/, '')}` : ''}.`
          : ev.end == null
            ? ev.status === 'active'
              ? 'Next step: acknowledge it or start an investigation in Events & Reports; it can be resolved once the condition clears.'
              : 'Next step: keep the investigation going — resolve it after recovery with a reason and the action taken.'
            : 'The condition has cleared — resolve it in Events & Reports with a reason and the action taken.';
      const perMin = ev.category === 'production' && ev.end == null && !ev.consequenceOf && ev.acc.constraintMin > 0 ? lostOutputValue(finance, ev.acc.kilnTypicalRate * 0.975) : null;
      return compose(
        'event-action',
        period,
        {
          observed: [`${head} is ${rep.summary.status.toLowerCase()}${ev.owner ? `, owner ${ev.owner}` : ', no owner yet'}; condition ${condition}.`, next],
          inferred: ev.recommendations.map((r, i) => `Recommended ${i + 1}: ${r}`),
          estimate: perMin
            ? [`Every further minute the kiln stays held up ≈ ${money(finance.currency, perMin.amount)} of contribution (${int(ev.acc.kilnTypicalRate * 60)} tiles/h typical kiln rate × 97.5 % first-pass yield).`, assumptionsText(finance, ['output'])]
            : [],
          method: ['Recommendations are the standard first responses for this alarm, defect or vehicle rule (rule-based), stored on the event record and shown in its report.'],
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
      return compose(
        'event-evidence',
        period,
        {
          observed: [
            `${head} — ${plural(available.length, 'evidence item')} available${pending.length ? `, ${pending.length} being captured` : ''}, ${missing.length} unavailable.`,
            ...available.map((x) => `Available: ${x.title} — ${low1(x.originLabel)}, captured ${when(s, x.capturedAt)}.`),
            ...pending.map((x) => `Being captured: ${x.title}.`),
            ...missing.map((u) => `Unavailable: ${u.title} — ${low1(u.reason)}.`),
            rep.provenance.sources.length ? `Signals used: ${rep.provenance.sources.join(', ')}.` : null,
          ],
          method: [
            'Evidence is frozen when the event is detected and stored under the event id. Camera views are rendered from the digital twin (simulated feed, not a camera image); inspection frames are illustrative (simulated classification — no vision model). Missing evidence is listed with its reason instead of being invented.',
          ],
        },
        extra,
      );
    }
    default:
      return compose(
        'event-what',
        period,
        {
          observed: [
            `${head} — ${rep.summary.type.toLowerCase()} (${rep.summary.category.toLowerCase()}), ${rep.summary.severity.toLowerCase()}, ${rep.summary.status.toLowerCase()}; condition ${condition}.`,
            rep.summary.text,
            `Asset: ${low1(rep.asset.kind)} ${rep.asset.id}${rep.asset.name !== rep.asset.id ? ` (${rep.asset.name})` : ''}${rep.asset.stage ? ` · ${rep.asset.stage}` : ''}.`,
            `Detected by ${low1(rep.detection.kind)} — rule ${rep.detection.rule} (${rep.detection.ruleLabel}): ${low1(rep.detection.description)}${observedValues ? `; observed ${observedValues}` : ''}${threshold ? `; threshold ${threshold}` : ''}.`,
            ...rep.diagnosis.facts.filter((f) => f !== rep.summary.text && !rep.summary.text.includes(f)).slice(0, 2),
          ],
          inferred: [...rep.diagnosis.causes.slice(0, 1).map(fmtCause), ...ev.recommendations.slice(0, 1).map((r) => `Recommended first: ${r}`)],
          estimate: valued ? [`Estimated impact ≈ ${money(valued.currency, valued.total)}${ev.end == null ? ' so far' : ''}: ${estimateLines(valued).join('; ')}.`, `Assumptions: ${valued.assumptions.join(' ')}`] : [],
          method: [reportMethod],
        },
        extra,
      );
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function stateWord(state: string) {
  return (
    { running: 'running', reduced: 'running at reduced rate', starved: 'starved of input', blocked: 'blocked by downstream', down: 'down', planned: 'on a planned stop' } as Record<string, string>
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
    case 'energy':
      return 'no excess energy cost yet';
    default:
      return 'data gap — no money impact';
  }
}

function bnLinks(stage: StageId): InsightLink[] {
  return STAGE_BY_ID[stage].machines.slice(0, 2).flatMap((id) => equipmentLink(id));
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

/** Line metrics for a period (exported for the context panel so it shows the same figures). */
export const lineNow = (s: SimState): LineMetrics => lineMetrics(s, resolvePeriod('shift', s.minute));

/** The event report the copilot reads for an event (exported for the context panel). */
export const copilotEventReport = (s: SimState, id: string, finance: FinanceAssumptions, tariffs: Tariffs): EventReport | null =>
  buildEventReport(s, id, { finance, tariffs, generatedAt: toIso(s.minute) });
