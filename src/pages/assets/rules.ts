/**
 * Event-rule thresholds as the Assets & Data editor shows them: which EventRules fields each
 * detection rule uses, their display unit / scale and the accepted range (pure, testable).
 */
import { DEFAULT_EVENT_RULES } from '../../model/plant';
import type { EventRules } from '../../model/types';
import { EVENT_RULE_DEFS } from '../../sim/events';

export type RuleKey = keyof EventRules;

export type RuleParam = {
  key: RuleKey;
  label: string;
  /** Display unit. */
  unit: string;
  /** Displayed value = stored value × scale (fractions shown as %). */
  scale: number;
  decimals: number;
  /** Accepted range in display units. */
  min: number;
  max: number;
  step: number;
};

const p = (key: RuleKey, label: string, unit: string, min: number, max: number, opts: Partial<Pick<RuleParam, 'scale' | 'decimals' | 'step'>> = {}): RuleParam => ({
  key,
  label,
  unit,
  min,
  max,
  scale: opts.scale ?? 1,
  decimals: opts.decimals ?? 0,
  step: opts.step ?? 1,
});

export const RULE_PARAMS: Record<RuleKey, RuleParam> = {
  belowRateFactor: p('belowRateFactor', 'Rate below', '% of ideal', 50, 98, { scale: 100 }),
  belowRateMinutes: p('belowRateMinutes', 'for at least', 'min', 3, 60),
  starvedMinutes: p('starvedMinutes', 'Held for', 'min', 3, 60),
  starvedMinutesConstraint: p('starvedMinutesConstraint', 'At the kiln (constraint)', 'min', 3, 60),
  counterInactiveMinutes: p('counterInactiveMinutes', 'No counter change for', 'min', 1, 30),
  ioImbalanceMax: p('ioImbalanceMax', 'Unaccounted above', '%', 0.5, 10, { scale: 100, decimals: 1, step: 0.1 }),
  rejectRateMax: p('rejectRateMax', 'Reject rate above', '%', 1, 20, { scale: 100, decimals: 1, step: 0.5 }),
  defectCount30Max: p('defectCount30Max', 'More than', 'tiles / 30 min', 1, 200),
  defectRepeatRecords: p('defectRepeatRecords', 'Consecutive records', 'records', 2, 20),
  deteriorationRatio: p('deteriorationRatio', 'Rate at least', '× the 24 h before', 1.2, 6, { decimals: 1, step: 0.1 }),
  truckWaitMax: p('truckWaitMax', 'Waiting longer than', 'min', 5, 240),
  dockStayMax: p('dockStayMax', 'Docked longer than', 'min', 15, 300),
  yardQueueMax: p('yardQueueMax', 'Trucks waiting ≥', 'trucks', 1, 20),
  turnaroundMax: p('turnaroundMax', 'On site longer than', 'min', 30, 480),
  energyDeviationMax: p('energyDeviationMax', 'Deviation above', '%', 2, 50, { scale: 100 }),
};

/** Additional fields a rule uses besides its named threshold (see src/sim/events.ts). */
const EXTRA: Record<string, RuleKey[]> = {
  'R-RATE': ['belowRateMinutes'],
  'R-STARVE': ['starvedMinutesConstraint'],
  'R-BLOCK': ['starvedMinutesConstraint'],
};

/** Threshold fields of a detection rule, in display order. */
export function ruleParams(ruleId: string): RuleParam[] {
  const def = EVENT_RULE_DEFS.find((d) => d.id === ruleId);
  if (!def) return [];
  const keys = [...(def.threshold ? [def.threshold] : []), ...(EXTRA[ruleId] ?? [])];
  return [...new Set(keys)].map((k) => RULE_PARAMS[k]);
}

/** Rules other than `ruleId` that use the same field (edits apply to both). */
export const sharedWith = (ruleId: string, key: RuleKey) =>
  EVENT_RULE_DEFS.filter((d) => d.id !== ruleId && ruleParams(d.id).some((x) => x.key === key)).map((d) => d.id);

const trim = (s: string) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

/** Stored value → text in display units. */
export function formatParam(param: RuleParam, value: number) {
  return trim((value * param.scale).toFixed(param.decimals));
}

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

/** Text in display units → stored value, validated against the range and rounded to the display precision. */
export function parseParam(param: RuleParam, text: string): ParseResult {
  const raw = text.trim().replace(',', '.').replace(/\s*%$/, '');
  if (!raw) return { ok: false, error: 'Enter a value' };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: 'Not a number' };
  const f = 10 ** param.decimals;
  const shown = Math.round(n * f) / f;
  if (shown < param.min || shown > param.max) return { ok: false, error: `Between ${trim(String(param.min))} and ${trim(String(param.max))} ${param.unit}` };
  return { ok: true, value: Number((shown / param.scale).toFixed(param.decimals + Math.round(Math.log10(param.scale)))) };
}

export const isModified = (rules: EventRules, key: RuleKey) => Math.abs(rules[key] - DEFAULT_EVENT_RULES[key]) > 1e-9;
export const modifiedCount = (rules: EventRules) => (Object.keys(RULE_PARAMS) as RuleKey[]).filter((k) => isModified(rules, k)).length;
