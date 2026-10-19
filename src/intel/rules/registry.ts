/**
 * The registered rule definitions. src/intel/rules/index.ts registers every family array once (one line per
 * family); the engine and the thresholds read them from here, so no module needs to import index.ts (no cycle).
 */
import { registerRuleParams } from './thresholds';
import type { RuleDef } from './types';

/** Every registered rule, in registration order. */
export const RULES: RuleDef[] = [];
export const RULE_BY_ID: Record<string, RuleDef> = {};

/** Registers rules (and their parameter defaults). A duplicate id is a programming error. */
export function registerRules(defs: RuleDef[]): RuleDef[] {
  for (const d of defs) {
    if (Object.hasOwn(RULE_BY_ID, d.id)) throw new Error(`Rule ${d.id} is registered twice`);
    const keys = d.params.map((p) => p.key);
    if (new Set(keys).size !== keys.length) throw new Error(`Rule ${d.id} declares a parameter twice`);
    RULE_BY_ID[d.id] = d;
    RULES.push(d);
  }
  registerRuleParams(defs);
  return defs;
}
