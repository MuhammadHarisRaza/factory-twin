/**
 * The rule engine (brief §7): validates the signals a rule requires, runs the applicable rules for a scope,
 * completes their findings (dedupe key, classification, provenance, first / last seen) and orders them. Pure over
 * a RuleContext; `findingsFor` memoises per simulation state, minute, scope and thresholds version, so repeated
 * renders in the same minute are free.
 *
 * This is not the event engine (src/sim/events.ts): findings are recomputed from the data each minute and carry
 * no lifecycle (acknowledge / resolve); operational events are linked as evidence where a rule finds them.
 */
import { freshness, type Window } from '../../calc';
import { STAGE_BY_NO, STAGES_12, SUPPORT_EQUIPMENT } from '../../model/catalog';
import { SCENARIO_KIND_LABELS } from '../../model/plant';
import type { TelemetrySource } from '../../model/telemetry';
import type { ScenarioActivation } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { buildContext, type RuleContext } from './context';
import { RULES } from './registry';
import { useRuleThresholds } from './thresholds';
import {
  CLASSIFICATION_LABEL,
  RULE_FAMILIES,
  SEVERITY_RANK,
  findingKey,
  scopeKey,
  type Confidence,
  type FindingStatus,
  type MissingSignal,
  type RuleDef,
  type RuleEvaluation,
  type RuleFamily,
  type RuleFinding,
  type RuleScope,
  type Severity,
  type StaleSignal,
} from './types';
import { clock, list } from './util';

// ── Signal validation ────────────────────────────────────────────────────────

export type SignalCheck = {
  missing: MissingSignal[];
  stale: StaleSignal[];
  /** Usable signals whose sample quality is 'uncertain' (evaluated, at lower confidence). */
  uncertain: string[];
  /** Reason text per problem signal, for the explanation. */
  reasons: Record<string, string>;
};

const intervalText = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`);

/**
 * Checks each signal: in the catalogue; status 'simulated' or 'connected'; a current sample of quality good or
 * uncertain with a timestamp; fresh by `freshness` against the catalogue's expected update interval (an
 * event-driven signal is not judged by age). A good sample without a value (a process value of a machine that is
 * not producing) is present — the rule decides what no value means.
 */
export function checkSignals(ctx: RuleContext, ids: string[], optional = false): SignalCheck {
  const out: SignalCheck = { missing: [], stale: [], uncertain: [], reasons: {} };
  const miss = (signalId: string, name: string, reason: string) => {
    out.missing.push({ signalId, name, reason, ...(optional ? { optional } : {}) });
    out.reasons[signalId] = reason;
  };
  for (const id of [...new Set(ids)]) {
    const r = ctx.read(id);
    const def = r.def;
    const name = def?.name ?? id;
    if (!def) {
      miss(id, name, 'not in the signal catalogue');
      continue;
    }
    if (def.availabilityStatus !== 'simulated' && def.availabilityStatus !== 'connected') {
      const what = def.availabilityStatus === 'not-modelled' ? 'not modelled in this simulation' : def.availabilityStatus === 'reference' ? 'reference data, not a signal' : 'unavailable';
      miss(id, name, def.statusNote ? `${what} — ${def.statusNote}` : what);
      continue;
    }
    if (r.status === 'not-modelled' || r.status === 'unavailable') {
      miss(id, name, r.note ?? (r.status === 'not-modelled' ? 'not modelled by the source' : 'unavailable from the source'));
      continue;
    }
    if (r.quality === 'missing') {
      miss(id, name, `no current value${r.note ? ` — ${r.note}` : ''}`);
      continue;
    }
    if (r.quality === 'bad') {
      miss(id, name, `bad quality flag${r.note ? ` — ${r.note}` : ''}`);
      continue;
    }
    const f = freshness(r.timestamp, ctx.now, def.expectedUpdateIntervalS);
    if (f.status === 'missing') {
      miss(id, name, 'no timestamp — no value received yet');
      continue;
    }
    if (r.quality === 'stale' || f.status === 'stale' || f.status === 'late') {
      out.stale.push({ signalId: id, name, since: r.timestamp, ...(optional ? { optional } : {}) });
      const expected = def.expectedUpdateIntervalS ? `, expected every ${intervalText(def.expectedUpdateIntervalS)}` : '';
      out.reasons[id] = `not current — last value ${r.timestamp != null ? clock(r.timestamp) : 'never'}${expected}${r.note ? ` (${r.note})` : ''}`;
      continue;
    }
    if (r.quality === 'uncertain') out.uncertain.push(id);
  }
  return out;
}

/** "E-PRS2.state (Machine state): bad quality flag — …; …". */
const describeProblems = (c: SignalCheck) => [...c.missing.map((m) => m.signalId), ...c.stale.map((m) => m.signalId)].map((id) => `${id} (${c.missing.find((m) => m.signalId === id)?.name ?? c.stale.find((m) => m.signalId === id)?.name}): ${c.reasons[id]}`);

/** The specific check that would let the rule run again. */
function restoreCheck(c: SignalCheck): string {
  const out: string[] = [];
  if (c.stale.length) {
    const eq = [...new Set(c.stale.map((x) => x.signalId.slice(0, x.signalId.indexOf('.'))))];
    out.push(`Check the data feed (PLC / gateway link) of ${list(eq)}: ${list(c.stale.map((x) => x.signalId))} ${c.stale.length === 1 ? 'is' : 'are'} not updating.`);
  }
  const bad = c.missing.filter((m) => m.reason.startsWith('bad quality'));
  if (bad.length) out.push(`Check the transmitter and the quality flag of ${list(bad.map((m) => m.signalId))} at the source.`);
  const none = c.missing.filter((m) => m.reason.startsWith('no current value') || m.reason.startsWith('no timestamp'));
  if (none.length) out.push(`Check why ${list(none.map((m) => m.signalId))} ${none.length === 1 ? 'delivers' : 'deliver'} no value (tag mapping, wiring, gateway).`);
  const config = c.missing.filter((m) => !bad.includes(m) && !none.includes(m));
  if (config.length) out.push(`Map ${list(config.map((m) => m.signalId))} to a real signal at integration — not available in this simulation.`);
  return out.join(' ');
}

// ── Completing findings ──────────────────────────────────────────────────────

const LOWER: Record<Confidence, Confidence> = { high: 'medium', medium: 'low', low: 'low' };

/** Equipment items a scope covers (for scenario provenance). */
function scopeEquipment(scope: RuleScope): string[] {
  if (scope.kind === 'equipment') return [scope.equipmentId];
  if (scope.kind === 'stage') return STAGE_BY_NO[scope.stageNo]?.equipment ?? [];
  return [];
}

function provenanceOf(ctx: RuleContext, scope: RuleScope, signals: string[], window: Window | null): RuleFinding['provenance'] {
  let scenario: ScenarioActivation | undefined;
  for (const id of scopeEquipment(scope)) {
    scenario = ctx.scenarios(id, window ?? null).sort((a, b) => b.start - a.start)[0];
    if (scenario) break;
  }
  const simulated = ctx.source.kind === 'simulated';
  const base = simulated
    ? 'Simulated data — evaluated on the demo simulation through the simulated telemetry source; not plant telemetry.'
    : 'Evaluated on data from the connected source.';
  const note = scenario ? `${base} A simulated scenario acts on this scope: ${scenario.label} (${SCENARIO_KIND_LABELS[scenario.kind]}, since ${clock(scenario.start)}).` : base;
  return { source: ctx.source.kind, signals: [...new Set(signals)], ...(scenario ? { scenarioId: scenario.id } : {}), note };
}

function insufficientFinding(def: RuleDef, ctx: RuleContext, scope: RuleScope, c: SignalCheck, signals: string[]): RuleFinding {
  return {
    ruleId: def.id,
    family: def.family,
    classification: def.classification,
    scope,
    key: findingKey(def.id, scope),
    status: 'insufficient-data',
    severity: 'info',
    title: `${def.title}: not evaluated`,
    explanation: `Not evaluated — requires ${describeProblems(c).join('; ')}.`,
    measurements: [],
    window: null,
    evidence: [...c.missing, ...c.stale].map((m) => ({ kind: 'signal' as const, label: m.name, ref: m.signalId })),
    confidence: 'low',
    confidenceNote: 'Required signals are missing, not modelled, unavailable, not current or flagged bad — no verdict is given.',
    next: restoreCheck(c) || null,
    missingSignals: c.missing,
    staleSignals: c.stale,
    provenance: provenanceOf(ctx, scope, signals, null),
    firstSeen: null,
    lastSeen: null,
  };
}

function complete(def: RuleDef, ctx: RuleContext, scope: RuleScope, ev: RuleEvaluation, signals: string[], optionalCheck: SignalCheck, uncertain: string[]): RuleFinding {
  const fired = ev.status === 'fired';
  let confidence: Confidence = ev.confidence ?? (ev.status === 'insufficient-data' ? 'low' : 'high');
  // A finding may be decided differently from its rule's default (RuleEvaluation.classification).
  const classification = ev.classification ?? def.classification;
  const notes = [ev.confidenceNote ?? `${CLASSIFICATION_LABEL[classification]} check on signals that passed validation (in the catalogue, current, not flagged bad).`];
  if (uncertain.length) {
    confidence = LOWER[confidence];
    notes.push(`${list(uncertain)} ${uncertain.length === 1 ? 'has' : 'have'} uncertain quality.`);
  }
  const optionalProblems = describeProblems(optionalCheck);
  if (optionalProblems.length) {
    confidence = LOWER[confidence];
    notes.push(`Evaluated without optional context: ${optionalProblems.join('; ')}.`);
  }
  const window = ev.window ?? null;
  const missing = [...(ev.missingSignals ?? []), ...optionalCheck.missing];
  const stale = [...(ev.staleSignals ?? []), ...optionalCheck.stale];
  return {
    ruleId: def.id,
    family: def.family,
    classification,
    scope,
    key: findingKey(def.id, scope, ev.subject),
    status: ev.status,
    severity: ev.severity ?? (fired ? 'warning' : 'info'),
    title: ev.title,
    explanation: ev.explanation,
    measurements: ev.measurements ?? [],
    window,
    evidence: ev.evidence ?? [],
    confidence,
    confidenceNote: notes.join(' '),
    next: ev.next ?? null,
    missingSignals: missing,
    staleSignals: stale,
    provenance: provenanceOf(ctx, scope, ev.signals ?? signals, window),
    firstSeen: fired ? (ev.firstSeen ?? window?.from ?? ctx.now) : null,
    lastSeen: fired ? ctx.now : null,
    ...(ev.resolvedAt != null ? { resolvedAt: ev.resolvedAt } : {}),
    ...(ev.chartRef ? { chartRef: ev.chartRef } : {}),
    ...(ev.subject ? { subject: ev.subject } : {}),
  };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

const STATUS_RANK: Record<FindingStatus, number> = { fired: 0, 'insufficient-data': 1, clear: 2 };

/** Fired by severity, then the most recent episode first; then insufficient-data; then clear (latest resolution first). */
export function compareFindings(a: RuleFinding, b: RuleFinding): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    (a.status === 'fired' ? SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.firstSeen ?? -Infinity) - (a.firstSeen ?? -Infinity) : 0) ||
    (a.status === 'clear' ? (b.resolvedAt ?? -Infinity) - (a.resolvedAt ?? -Infinity) : 0) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** One finding per key: the fired one over insufficient-data over clear, then the higher severity. */
export function dedupeFindings(findings: RuleFinding[]): RuleFinding[] {
  const byKey = new Map<string, RuleFinding>();
  for (const f of findings) {
    const cur = byKey.get(f.key);
    if (!cur || STATUS_RANK[f.status] < STATUS_RANK[cur.status] || (f.status === cur.status && SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur.severity])) byKey.set(f.key, f);
  }
  return [...byKey.values()];
}

/**
 * Evaluates the rules that apply to one scope: required signals are validated first (→ 'insufficient-data'
 * naming each signal and why), then the rule runs; its findings are completed, deduplicated and ordered. A rule
 * that throws gives an 'insufficient-data' finding with the error rather than breaking the page.
 */
export function evaluate(defs: RuleDef[], ctx: RuleContext, scope: RuleScope): RuleFinding[] {
  const out: RuleFinding[] = [];
  for (const def of defs) {
    if (!def.appliesTo(scope, ctx)) continue;
    const required = def.requiredSignals(scope, ctx);
    const optional = def.optionalSignals?.(scope, ctx) ?? [];
    const signals = [...required, ...optional];
    const check = checkSignals(ctx, required);
    if (check.missing.length || check.stale.length) {
      out.push(insufficientFinding(def, ctx, scope, check, signals));
      continue;
    }
    const optionalCheck = checkSignals(ctx, optional, true);
    let result: RuleEvaluation | RuleEvaluation[];
    try {
      result = def.evaluate(ctx, scope);
    } catch (e) {
      result = {
        status: 'insufficient-data',
        title: `${def.title}: not evaluated`,
        explanation: `Not evaluated — the rule could not be computed (${e instanceof Error ? e.message : String(e)}).`,
        confidence: 'low',
        confidenceNote: 'Evaluation error — no verdict is given.',
        next: null,
      };
    }
    for (const ev of Array.isArray(result) ? result : [result]) out.push(complete(def, ctx, scope, ev, signals, optionalCheck, check.uncertain));
  }
  return dedupeFindings(out).sort(compareFindings);
}

// ── Scopes ───────────────────────────────────────────────────────────────────

/** Every equipment item of the twelve stages and the support assets, once, in stage order. */
export const ALL_EQUIPMENT: string[] = [...new Set([...STAGES_12.flatMap((s) => s.equipment), ...SUPPORT_EQUIPMENT])];

/**
 * The scopes a scope covers: an equipment item itself; a stage and each of its equipment items; the plant, each
 * stage and every equipment item. Equipment findings keep their equipment scope (and key) whichever view asks.
 */
export function expandScope(scope: RuleScope): RuleScope[] {
  if (scope.kind === 'equipment') return [scope];
  if (scope.kind === 'stage') return [scope, ...(STAGE_BY_NO[scope.stageNo]?.equipment ?? []).map((equipmentId) => ({ kind: 'equipment' as const, equipmentId }))];
  return [scope, ...STAGES_12.map((s) => ({ kind: 'stage' as const, stageNo: s.no })), ...ALL_EQUIPMENT.map((equipmentId) => ({ kind: 'equipment' as const, equipmentId }))];
}

export type FindingsOptions = {
  /** Telemetry adapter (default: the simulated source). Findings with a custom source are not memoised. */
  source?: TelemetrySource<SimState>;
  /** Threshold overrides (default: the thresholds store). Findings with explicit values are not memoised. */
  values?: Record<string, number>;
  /** Rules to evaluate (default: every registered rule). Not memoised either. */
  rules?: RuleDef[];
};

const MEMO_SIZE = 32;
const memo = new WeakMap<SimState, Map<string, RuleFinding[]>>();

function compute(s: SimState, scope: RuleScope, defs: RuleDef[], opts: { source?: TelemetrySource<SimState>; values: Record<string, number> }): RuleFinding[] {
  const ctx = buildContext(s, { source: opts.source, values: opts.values });
  const all = expandScope(scope).flatMap((sc) => evaluate(defs, ctx, sc));
  return dedupeFindings(all).sort(compareFindings);
}

/**
 * Findings of a scope (an equipment item, a stage with its equipment, or the whole plant), ordered. Memoised per
 * simulation state, minute, state version, scope and thresholds version (small LRU): repeated renders in the same
 * minute return the same array — treat it as read-only.
 */
export function findingsFor(s: SimState, scope: RuleScope, opts: FindingsOptions = {}): RuleFinding[] {
  if (opts.source || opts.values || opts.rules) return compute(s, scope, opts.rules ?? RULES, { source: opts.source, values: opts.values ?? useRuleThresholds.getState().values });
  const thr = useRuleThresholds.getState();
  const key = `${scopeKey(scope)}|${s.minute}|${s.version}|${thr.version}|${RULES.length}`;
  let lru = memo.get(s);
  if (!lru) memo.set(s, (lru = new Map()));
  const hit = lru.get(key);
  if (hit) {
    lru.delete(key);
    lru.set(key, hit);
    return hit;
  }
  const findings = compute(s, scope, RULES, { values: thr.values });
  lru.set(key, findings);
  while (lru.size > MEMO_SIZE) lru.delete(lru.keys().next().value!);
  return findings;
}

export type FindingsSummary = {
  total: number;
  byStatus: Record<FindingStatus, number>;
  byFamily: Record<RuleFamily, Record<FindingStatus, number>>;
  /** Fired findings per severity. */
  bySeverity: Record<Severity, number>;
};

const zeroStatus = (): Record<FindingStatus, number> => ({ fired: 0, clear: 0, 'insufficient-data': 0 });

/** Counts of findings by status, by family × status and (fired only) by severity. */
export function summarize(findings: RuleFinding[]): FindingsSummary {
  const out: FindingsSummary = {
    total: findings.length,
    byStatus: zeroStatus(),
    byFamily: Object.fromEntries(RULE_FAMILIES.map((f) => [f, zeroStatus()])) as Record<RuleFamily, Record<FindingStatus, number>>,
    bySeverity: { info: 0, warning: 0, serious: 0, critical: 0 },
  };
  for (const f of findings) {
    out.byStatus[f.status]++;
    out.byFamily[f.family][f.status]++;
    if (f.status === 'fired') out.bySeverity[f.severity]++;
  }
  return out;
}

export type PlantFindings = {
  /** Every finding of the plant (plant rules, stage rules, equipment rules), deduplicated and ordered. */
  findings: RuleFinding[];
  /** The top fired findings (most severe, most recent first). */
  top: RuleFinding[];
  summary: FindingsSummary;
};

/** Plant-wide findings: plant-level rules plus the stage and equipment rules for everything that has their signals. */
export function plantFindings(s: SimState, opts: FindingsOptions & { top?: number } = {}): PlantFindings {
  const { top = 8, ...rest } = opts;
  const findings = findingsFor(s, { kind: 'plant' }, rest);
  return { findings, top: findings.filter((f) => f.status === 'fired').slice(0, top), summary: summarize(findings) };
}

/** Rules that apply to a scope or (for a stage / the plant) to any item it covers — static, from the configuration. */
export function rulesFor(scope: RuleScope, defs: RuleDef[] = RULES): RuleDef[] {
  const scopes = expandScope(scope);
  return defs.filter((d) => scopes.some((sc) => d.appliesTo(sc, null)));
}
