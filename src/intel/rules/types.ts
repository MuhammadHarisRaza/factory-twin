/**
 * The rule engine's contract (brief §7): rule definitions, their evaluation, and the findings every surface
 * (equipment panel, stage panel, Overview, Production, Quality, Events) shows. Pure types plus labels — no
 * SimState access, no React.
 *
 * ── Authoring a RuleDef (conventions for every family file, src/intel/rules/defs/<family>.ts) ──────────────
 *
 * 1. Registration. Each family file exports one array (`export const FLOW_RULES: RuleDef[] = [...]`), already
 *    imported and registered in src/intel/rules/index.ts. Ids are `<prefix>-<NAME>` and unique: P- production,
 *    F- flow (the build plan's F-POWDER-STARVATION …), PC- process, RL- reliability, QL- quality, DQ- data. Never reuse an id of the event engine
 *    (src/sim/events.ts EVENT_RULE_DEFS: R-*, Q-*, L-*) — those name its rules, not these.
 * 2. Classification. A threshold / limit / duration rule is 'rule-based'. 'statistical' only when the rule
 *    tests significance (a two-proportion z-test, a regression slope with a t-test). Nothing is AI, nothing
 *    predicts a failure: no probabilities, no "will fail"; a linear extrapolation says so.
 * 3. Applicability and signals are static. `appliesTo(scope, ctx)` and `requiredSignals(scope, ctx)` decide from
 *    the configuration (src/model/plant.ts, the signal catalogue) — `ctx` is null when asked statically
 *    (rulesFor). A rule applies to an equipment item when the item has the signals in the catalogue, whatever
 *    their status: a required signal that is not modelled / unavailable / stale / bad then gives an honest
 *    'insufficient-data' finding instead of silence. requiredSignals lists every signal the verdict reads.
 * 4. Validation is the engine's job. Before `evaluate` runs, the engine checks each required signal (in the
 *    catalogue; status 'simulated' or 'connected'; a current sample of quality good / uncertain; fresh by
 *    src/calc `freshness` against the catalogue's expectedUpdateIntervalS). Otherwise the finding is
 *    'insufficient-data' and names each signal and why ("Not evaluated — requires …"). Never guess.
 * 5. Read through the context. Signal values, history and states come from ctx.read / ctx.series / ctx.samples /
 *    ctx.states (the TelemetrySource adapter boundary); records (stops, inspections, quality windows, events)
 *    from the ctx helpers. Calculations use src/calc (Calc results: a non-'ok' status is not a zero). Missing is
 *    never zero, stale is never current, an absent alarm is not proof of no fault.
 * 6. Wording. `explanation` states the evidence with figures, units and the time window (clock times,
 *    src/sim/time formatClock); `next` is one specific check ("Check the die / powder feed of E-PRS2; compare
 *    press 2 with presses 1 and 3"), not "investigate". An association is "to investigate", never a cause.
 *    Simulated data is labelled simulated (the engine adds the provenance).
 * 7. Thresholds. Every threshold is a RuleParam read with ctx.param(ruleId, key, equipmentId) — overridable
 *    globally ('RULE.param') or per equipment ('RULE.param@EQUIPMENT') in src/intel/rules/thresholds.ts. A
 *    threshold the event engine also has (EventRules, src/pages/events/rules.ts RULE_PARAMS) sets `mirrors`, so
 *    it defaults to — and follows — the configured event rule instead of contradicting it.
 * 8. Episodes. A fired evaluation sets `firstSeen` to the start of the current episode as the history shows it
 *    (the first minute of the deviation / stop / trend in the window); the engine sets lastSeen = now. A recently
 *    resolved episode may be returned as status 'clear' with `resolvedAt`.
 * 9. Insufficient history. `evaluate` itself returns status 'insufficient-data' only when the history it needs
 *    is too short or has gaps (e.g. too few running minutes for a trend), naming the signals in missingSignals.
 * 10. Several findings per scope (one per defect, buffer, signal…) are returned as an array with a distinct
 *    `subject` each; the engine builds the stable dedupe key ruleId + scope + subject.
 * 11. `chartRef` names the chart the UI can scroll to (CHART below).
 */
import type { Window } from '../../calc/types';
import type { ProductionStageNo } from '../../model/catalog/types';
import type { AlertSeverity, EventRules } from '../../model/types';
import type { RuleContext } from './context';

export type RuleFamily = 'production' | 'flow' | 'process' | 'reliability' | 'quality' | 'data';

export const RULE_FAMILIES: RuleFamily[] = ['production', 'flow', 'process', 'reliability', 'quality', 'data'];

export const FAMILY_LABEL: Record<RuleFamily, string> = {
  production: 'Production',
  flow: 'Material flow',
  process: 'Process control',
  reliability: 'Reliability',
  quality: 'Quality',
  data: 'Data quality',
};

/** How a rule decides: a threshold rule, or a significance test. Never AI. */
export type RuleClassification = 'rule-based' | 'statistical';

export const CLASSIFICATION_LABEL: Record<RuleClassification, string> = { 'rule-based': 'Rule-based', statistical: 'Statistical' };

/** What a rule is evaluated for. */
export type RuleScope = { kind: 'equipment'; equipmentId: string } | { kind: 'stage'; stageNo: ProductionStageNo } | { kind: 'plant' };

/**
 * A configurable threshold of a rule. `default`, `min`, `max` and `step` are stored values (what ctx.param returns);
 * `unit` is the unit as shown, after `scale` (e.g. a stored fraction 0.85 with scale 100 is shown as 85 %).
 */
export type RuleParam = {
  key: string;
  label: string;
  unit: string;
  default: number;
  min?: number;
  max?: number;
  step?: number;
  /** Shown value = stored value × scale (default 1). Additive to the planned contract, for the rules editor. */
  scale?: number;
  /** Decimals of the shown value (default 0). */
  decimals?: number;
  /** What the threshold does, for the rules editor. */
  hint: string;
  /**
   * The event-engine threshold (EventRules field) this parameter mirrors: without an override it follows the
   * configured event rule (sim.rules), mapped through `map` when the units differ. `default` must equal the
   * mapped DEFAULT_EVENT_RULES value.
   */
  mirrors?: { rule: keyof EventRules; map?: (eventValue: number) => number };
};

/** A figure behind a finding, with its unit and the window it covers. */
export type Measurement = {
  signalId?: string;
  label: string;
  /** null = no value (never a zero standing in for a missing value). */
  value: number | string | null;
  unit: string | null;
  window?: Window;
  /** Plant minute of a point value. */
  at?: number;
};

/** Something the UI can link to as evidence. */
export type Evidence = {
  kind: 'signal' | 'event' | 'chart' | 'metric' | 'rule';
  label: string;
  /** Signal id, OpEvent id, chart id (CHART), metric name or rule id. */
  ref?: string;
  window?: Window;
};

export type FindingStatus = 'fired' | 'clear' | 'insufficient-data';

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = { fired: 'Detected', clear: 'Clear', 'insufficient-data': 'Not evaluated — insufficient data' };

export type Severity = AlertSeverity;

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

export type Confidence = 'high' | 'medium' | 'low';

/** A required (or optional) signal that could not be used, and why. */
export type MissingSignal = { signalId: string; name: string; reason: string; optional?: boolean };
/** A signal whose last value is too old to be current. `since` = plant minute of the last value (null = never). */
export type StaleSignal = { signalId: string; name: string; since: number | null; optional?: boolean };

export type Provenance = {
  /** 'simulated' for the demo source; 'connected' only for a verified real integration. */
  source: 'simulated' | 'connected';
  /** Signals the finding was evaluated from. */
  signals: string[];
  /** A simulated scenario that acts on the scope's equipment in the finding's window. */
  scenarioId?: string;
  note: string;
};

export type RuleFinding = {
  ruleId: string;
  family: RuleFamily;
  classification: RuleClassification;
  scope: RuleScope;
  /** Stable dedupe key: ruleId + scope + subject. */
  key: string;
  status: FindingStatus;
  severity: Severity;
  title: string;
  /** Evidence-backed: figures with units and the time window. */
  explanation: string;
  measurements: Measurement[];
  window: Window | null;
  evidence: Evidence[];
  confidence: Confidence;
  confidenceNote: string;
  /** The recommended next check (specific), null when there is nothing to check. */
  next: string | null;
  missingSignals: MissingSignal[];
  staleSignals: StaleSignal[];
  provenance: Provenance;
  /** Start of the current episode (fired) as the history shows it. */
  firstSeen: number | null;
  /** = the evaluation minute for a fired finding. */
  lastSeen: number | null;
  /** End of a recently resolved episode (status 'clear'). */
  resolvedAt?: number | null;
  /** Chart the UI can scroll to (CHART). */
  chartRef?: string;
  /** What the finding is about within its scope (defect, buffer, signal), when a rule returns several. */
  subject?: string;
};

/** A rule's own result, before the engine adds validation, provenance, keys and timestamps. */
export type RuleEvaluation = {
  status: FindingStatus;
  /** Default: 'warning' when fired, 'info' otherwise. */
  severity?: Severity;
  title: string;
  explanation: string;
  measurements?: Measurement[];
  window?: Window | null;
  evidence?: Evidence[];
  /** Default: 'high' (fired / clear), 'low' (insufficient-data). */
  confidence?: Confidence;
  confidenceNote?: string;
  next?: string | null;
  /** Distinguishes several findings of one rule in one scope (part of the dedupe key). */
  subject?: string;
  firstSeen?: number | null;
  resolvedAt?: number | null;
  chartRef?: string;
  /** Rule-level insufficiency (history too short, gaps): the signals and why. */
  missingSignals?: MissingSignal[];
  staleSignals?: StaleSignal[];
  /** Signals actually used, for the provenance (default: required + optional signals). */
  signals?: string[];
  /**
   * How this finding was decided, when it differs from the rule's own classification (additive): e.g. a limit rule
   * (RL-LONG-STOP, 'rule-based') whose verdict came from an empirical percentile baseline is 'statistical'.
   */
  classification?: RuleClassification;
};

export type RuleDef = {
  id: string;
  family: RuleFamily;
  classification: RuleClassification;
  title: string;
  /** What the rule checks, in one or two sentences (rules editor, Assets & Data). */
  description: string;
  /** Static applicability (ctx is null when asked without a simulation state). */
  appliesTo(scope: RuleScope, ctx: RuleContext | null): boolean;
  /** Every signal the verdict reads; validated by the engine before evaluate runs. */
  requiredSignals(scope: RuleScope, ctx: RuleContext | null): string[];
  /** Signals that add context when usable; a problem with one lowers the confidence, never blocks the rule. */
  optionalSignals?(scope: RuleScope, ctx: RuleContext | null): string[];
  params: RuleParam[];
  evaluate(ctx: RuleContext, scope: RuleScope): RuleEvaluation | RuleEvaluation[];
};

/** Chart ids the UI can scroll to. */
export const CHART = {
  cycle: 'chart:cycle',
  rate: 'chart:rate',
  states: 'chart:states',
  quality: 'chart:quality',
  process: (signalId: string) => `chart:process:${signalId}`,
  buffer: (signalId: string) => `chart:buffer:${signalId}`,
} as const;

/** Stable text of a scope, part of every finding key ('eq:E-PRS2', 'stage:3', 'plant'). */
export const scopeKey = (scope: RuleScope): string =>
  scope.kind === 'equipment' ? `eq:${scope.equipmentId}` : scope.kind === 'stage' ? `stage:${scope.stageNo}` : 'plant';

/** Dedupe key of a finding: ruleId + scope + subject. */
export const findingKey = (ruleId: string, scope: RuleScope, subject?: string): string => `${ruleId}|${scopeKey(scope)}${subject ? `|${subject}` : ''}`;
