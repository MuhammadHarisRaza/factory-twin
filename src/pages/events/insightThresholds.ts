/**
 * Insight rule thresholds as the Detection rules tab edits them (Events & Reports › Detection rules ›
 * Insight rule thresholds): every RuleDef of the rule engine (src/intel/rules) with its parameters, the value
 * in force and where it comes from (default, configured here, or following an event-rule threshold), shown in
 * display units (stored value × scale) — pure, testable. Edits go through useRuleThresholds, whose version
 * invalidates the findings memo (findingsFor), so the findings re-evaluate with the new value.
 */
import {
  CLASSIFICATION_LABEL,
  FAMILY_LABEL,
  RULES,
  paramKey,
  parseParamKey,
  resolveParam,
  useRuleThresholds,
  type ParamSource,
  type RuleDef,
  type RuleFamily,
  type RuleParam,
} from '../../intel/rules';
import type { EventRules } from '../../model/types';
import { DEFAULT_EVENT_RULES } from '../../model/plant';
import { EVENT_RULE_DEFS } from '../../sim/events';
import { ruleParams, type ParseResult } from './rules';

// ── Display units ────────────────────────────────────────────────────────────

const scaleOf = (p: RuleParam) => p.scale ?? 1;
const decimalsOfStep = (step: number) => {
  const s = String(Number(step.toPrecision(12)));
  return s.includes('.') ? s.length - s.indexOf('.') - 1 : 0;
};
/** Decimals of the shown value: the parameter's own, or more when its step needs them. */
export const displayDecimals = (p: RuleParam) => Math.max(p.decimals ?? 0, p.step != null ? decimalsOfStep(p.step * scaleOf(p)) : 0);

const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/** Stored value → text in display units. */
export const formatInsight = (p: RuleParam, stored: number) => trim((stored * scaleOf(p)).toFixed(displayDecimals(p)));

/** min / max / step in display units (null where the parameter has none). */
export function displayRange(p: RuleParam): { min: number | null; max: number | null; step: number | null } {
  const k = scaleOf(p);
  const r = (v: number | undefined) => (v == null ? null : Number((v * k).toFixed(displayDecimals(p))));
  return { min: r(p.min), max: r(p.max), step: r(p.step) };
}

/** Text in display units → stored value, rounded to the display precision and checked against the range. */
export function parseInsight(p: RuleParam, text: string): ParseResult {
  const raw = text.trim().replace(',', '.').replace(/\s*%$/, '');
  if (!raw) return { ok: false, error: 'Enter a value' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: 'Not a number' };
  const d = displayDecimals(p);
  const shown = Number(n.toFixed(d));
  const { min, max } = displayRange(p);
  if ((min != null && shown < min) || (max != null && shown > max))
    return { ok: false, error: `Between ${min ?? '−∞'} and ${max ?? '∞'} ${p.unit}` };
  const k = scaleOf(p);
  return { ok: true, value: Number((shown / k).toFixed(d + Math.max(0, Math.ceil(Math.log10(k))) + 2)) };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export type InsightParamRow = {
  /** 'RULE.param'. */
  key: string;
  ruleId: string;
  param: RuleParam;
  /** The global value in force (stored units). */
  value: number;
  source: ParamSource;
  /** What the value would be without an override here (the default, or the mirrored event-rule value). */
  base: number;
  defaultValue: number;
  /** The event-rule threshold this parameter follows, and the event rules that use it. */
  mirror: { field: keyof EventRules; eventRules: string[]; changed: boolean } | null;
  /** Per-equipment overrides ('RULE.param@EQUIPMENT'). */
  overrides: { key: string; equipmentId: string; value: number }[];
};

export type InsightRuleRow = { def: RuleDef; familyLabel: string; classificationLabel: string; params: InsightParamRow[] };

export type InsightFilters = { family: RuleFamily | 'all'; query: string };
export const DEFAULT_INSIGHT_FILTERS: InsightFilters = { family: 'all', query: '' };

/** Event rules (src/sim/events.ts) that use an EventRules field. */
const eventRulesUsing = (field: keyof EventRules) => EVENT_RULE_DEFS.filter((d) => ruleParams(d.id).some((p) => p.key === field)).map((d) => d.id);

function paramRow(def: RuleDef, p: RuleParam, values: Record<string, number>, eventRules: EventRules): InsightParamRow {
  const key = paramKey(def.id, p.key);
  const inForce = resolveParam(values, def.id, p.key, null, eventRules);
  const rest = { ...values };
  delete rest[key];
  const base = resolveParam(rest, def.id, p.key, null, eventRules).value;
  const overrides = Object.entries(values)
    .map(([k, v]) => ({ k, v, parts: parseParamKey(k) }))
    .filter((x) => x.parts && x.parts.ruleId === def.id && x.parts.key === p.key && x.parts.equipmentId)
    .map((x) => ({ key: x.k, equipmentId: x.parts!.equipmentId!, value: x.v }))
    .sort((a, b) => a.equipmentId.localeCompare(b.equipmentId));
  const field = p.mirrors?.rule ?? null;
  return {
    key,
    ruleId: def.id,
    param: p,
    value: inForce.value,
    source: inForce.source,
    base,
    defaultValue: p.default,
    mirror: field ? { field, eventRules: eventRulesUsing(field), changed: Math.abs(eventRules[field] - DEFAULT_EVENT_RULES[field]) > 1e-9 } : null,
    overrides,
  };
}

/** Every rule of the engine (filtered by family and free text) with its parameters as the editor shows them. */
export function insightRuleRows(values: Record<string, number>, eventRules: EventRules, f: InsightFilters = DEFAULT_INSIGHT_FILTERS): InsightRuleRow[] {
  const terms = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  return RULES.filter((d) => f.family === 'all' || d.family === f.family)
    .filter((d) => {
      if (!terms.length) return true;
      const text = `${d.id} ${d.title} ${d.description} ${FAMILY_LABEL[d.family]} ${d.params.map((p) => `${p.key} ${p.label}`).join(' ')}`.toLowerCase();
      return terms.every((t) => text.includes(t));
    })
    .map((def) => ({
      def,
      familyLabel: FAMILY_LABEL[def.family],
      classificationLabel: CLASSIFICATION_LABEL[def.classification],
      params: def.params.map((p) => paramRow(def, p, values, eventRules)),
    }));
}

/** How the value in force is labelled: 'Default', 'Configured', or following an event rule. */
export function sourceLabel(row: InsightParamRow): string {
  if (row.source === 'global') return 'Configured';
  if (row.source === 'event-rule' && row.mirror) return `${row.mirror.changed ? 'Follows' : 'Default · follows'} ${row.mirror.eventRules.join(' / ') || row.mirror.field}`;
  return 'Default';
}

/** Number of global and per-equipment overrides in force. */
export const overrideCount = (values: Record<string, number>) => Object.keys(values).filter((k) => parseParamKey(k) != null).length;

/**
 * Applies a typed value (display units) to a rule parameter through the thresholds store. A value equal to what
 * the parameter would have without an override (its default, or the mirrored event-rule value) removes the
 * override, so the row reads 'Default' again; an out-of-range value is refused with the reason.
 */
export function commitInsightParam(key: string, text: string, eventRules: EventRules): ParseResult {
  const parts = parseParamKey(key);
  const def = parts ? RULES.find((d) => d.id === parts.ruleId) : undefined;
  const p = def?.params.find((x) => x.key === parts!.key);
  if (!def || !p || parts!.equipmentId) return { ok: false, error: 'Unknown parameter' };
  const r = parseInsight(p, text);
  if (!r.ok) return r;
  const store = useRuleThresholds.getState();
  const row = paramRow(def, p, store.values, eventRules);
  if (Math.abs(r.value - row.base) < 1e-9) {
    if (key in store.values) store.reset(key);
    return r;
  }
  if (Math.abs(r.value - row.value) < 1e-9 && row.source === 'global') return r;
  return store.set(key, r.value) ? r : { ok: false, error: 'Value refused by the thresholds store' };
}
