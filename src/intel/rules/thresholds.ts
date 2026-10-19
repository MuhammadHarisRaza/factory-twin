/**
 * Rule thresholds (brief §5 / §7): the default of every RuleParam, the overrides a user set — globally
 * ('RULE.param') or for one equipment item ('RULE.param@EQUIPMENT') — and the value in force. A parameter that
 * mirrors an event-engine threshold (RuleParam.mirrors → EventRules, edited in Events & Reports › Detection
 * rules) follows the configured event rule unless it is overridden here, so the two never contradict each other.
 *
 * Overrides are remembered in this browser (localStorage 'wai.ruleThresholds'); without storage (tests, private
 * windows) they live in memory only.
 */
import { create } from 'zustand';
import type { EventRules } from '../../model/types';
import type { RuleDef, RuleParam } from './types';

export const THRESHOLDS_STORAGE_KEY = 'wai.ruleThresholds';

/** Default of every registered rule parameter: 'RULE.param' → value (filled by registerRuleParams). */
export const RULE_PARAM_DEFAULTS: Record<string, number> = {};
/** Every registered rule parameter: 'RULE.param' → its definition and rule. */
export const RULE_PARAM_BY_KEY: Record<string, RuleParam & { ruleId: string }> = {};

/** 'RULE.param', or 'RULE.param@EQUIPMENT' for a per-equipment override. */
export const paramKey = (ruleId: string, key: string, equipmentId?: string | null) => `${ruleId}.${key}${equipmentId ? `@${equipmentId}` : ''}`;

/** The parts of a parameter key (null when it is not one). Rule ids contain no dot; parameter keys no '@'. */
export function parseParamKey(k: string): { ruleId: string; key: string; equipmentId: string | null } | null {
  const m = /^([^.@]+)\.([^.@]+)(?:@(.+))?$/.exec(k);
  return m ? { ruleId: m[1], key: m[2], equipmentId: m[3] ?? null } : null;
}

/** Adds the parameters of the given rules to the defaults (called when the rules are registered). */
export function registerRuleParams(defs: RuleDef[]) {
  for (const d of defs)
    for (const p of d.params) {
      const k = paramKey(d.id, p.key);
      RULE_PARAM_DEFAULTS[k] = p.default;
      RULE_PARAM_BY_KEY[k] = { ...p, ruleId: d.id };
    }
}

export type ParamSource = 'equipment' | 'global' | 'event-rule' | 'default';

/**
 * The value in force and where it comes from: the per-equipment override, else the global override, else the
 * mirrored event-rule threshold (when `eventRules` is given), else the default. Unknown parameters throw: a
 * rule reading a threshold it does not declare is a programming error, never a silent zero.
 */
export function resolveParam(
  values: Record<string, number>,
  ruleId: string,
  key: string,
  equipmentId?: string | null,
  eventRules?: EventRules | null,
): { value: number; source: ParamSource } {
  const base = paramKey(ruleId, key);
  if (equipmentId) {
    const v = values[paramKey(ruleId, key, equipmentId)];
    if (Number.isFinite(v)) return { value: v, source: 'equipment' };
  }
  if (Number.isFinite(values[base])) return { value: values[base], source: 'global' };
  const def = RULE_PARAM_BY_KEY[base];
  if (!def) throw new Error(`Unknown rule parameter ${base}`);
  if (def.mirrors && eventRules) {
    const raw = eventRules[def.mirrors.rule];
    if (Number.isFinite(raw)) return { value: def.mirrors.map ? def.mirrors.map(raw) : raw, source: 'event-rule' };
  }
  return { value: def.default, source: 'default' };
}

/** The value in force of a rule parameter (see resolveParam). */
export const paramOf = (values: Record<string, number>, ruleId: string, key: string, equipmentId?: string | null, eventRules?: EventRules | null): number =>
  resolveParam(values, ruleId, key, equipmentId, eventRules).value;

/** Whether a value is acceptable for a parameter key (registered, finite, inside its range). */
export function validParamValue(k: string, v: number): boolean {
  const parts = parseParamKey(k);
  const def = parts ? RULE_PARAM_BY_KEY[paramKey(parts.ruleId, parts.key)] : undefined;
  if (!def || !Number.isFinite(v)) return false;
  return (def.min == null || v >= def.min) && (def.max == null || v <= def.max);
}

const load = (): Record<string, number> => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(THRESHOLDS_STORAGE_KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    // Parameters are validated when read (resolveParam); here only the shape is checked (rules may register later).
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, number] => parseParamKey(e[0]) != null && Number.isFinite(e[1])));
  } catch {
    return {};
  }
};

const save = (values: Record<string, number>) => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(THRESHOLDS_STORAGE_KEY, JSON.stringify(values));
  } catch {
    /* storage unavailable: keep in memory only */
  }
};

export type RuleThresholdsStore = {
  /** Overrides only: 'RULE.param' and 'RULE.param@EQUIPMENT' → value (defaults are not stored). */
  values: Record<string, number>;
  /** Incremented on every change (memoisation key of the findings). */
  version: number;
  /** Sets an override; false (and no change) for an unknown parameter or a value outside its range. */
  set(key: string, v: number): boolean;
  /** Removes one override (exactly that key), or every override without a key. */
  reset(key?: string): void;
};

export const useRuleThresholds = create<RuleThresholdsStore>((set, get) => ({
  values: load(),
  version: 0,
  set: (key, v) => {
    if (!validParamValue(key, v)) return false;
    const values = { ...get().values, [key]: v };
    set({ values, version: get().version + 1 });
    save(values);
    return true;
  },
  reset: (key) => {
    const cur = get().values;
    if (key != null && !(key in cur)) return;
    const values = key == null ? {} : Object.fromEntries(Object.entries(cur).filter(([k]) => k !== key));
    set({ values, version: get().version + 1 });
    save(values);
  },
}));
