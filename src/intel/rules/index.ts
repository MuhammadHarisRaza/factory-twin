/**
 * The rule engine (brief §7): rule definitions per family, threshold overrides, signal validation and the
 * findings every surface shows. Rules are 'Rule-based' (thresholds) or 'Statistical' (significance tests) — none
 * is AI and none predicts a failure. On this demo every finding is evaluated on simulated data and says so.
 *
 * Registration: each family file exports one array; it is registered here with one line. Authoring conventions:
 * src/intel/rules/types.ts.
 */
import { DATA_RULES } from './defs/data';
import { FLOW_RULES } from './defs/flow';
import { PROCESS_RULES } from './defs/process';
import { PRODUCTION_RULES } from './defs/production';
import { QUALITY_RULES } from './defs/quality';
import { RELIABILITY_RULES } from './defs/reliability';
import { registerRules } from './registry';

registerRules(PRODUCTION_RULES);
registerRules(FLOW_RULES);
registerRules(PROCESS_RULES);
registerRules(RELIABILITY_RULES);
registerRules(QUALITY_RULES);
registerRules(DATA_RULES);

export { DATA_RULES, FLOW_RULES, PROCESS_RULES, PRODUCTION_RULES, QUALITY_RULES, RELIABILITY_RULES };
export { RULES, RULE_BY_ID } from './registry';
export { LIVE_FINDINGS_MIN, liveFindingsFor, livePlantFindings, type LiveFindings } from './live';

export * from './types';
export {
  ALL_EQUIPMENT,
  checkSignals,
  compareFindings,
  dedupeFindings,
  evaluate,
  expandScope,
  findingsFor,
  plantFindings,
  rulesFor,
  summarize,
  type FindingsOptions,
  type FindingsSummary,
  type PlantFindings,
  type SignalCheck,
} from './engine';
export { buildContext, rangeWindow, type ContextOptions, type QualityCounts, type RuleContext, type RuleStop, type SeriesRange } from './context';
export {
  RULE_PARAM_BY_KEY,
  RULE_PARAM_DEFAULTS,
  THRESHOLDS_STORAGE_KEY,
  paramKey,
  paramOf,
  parseParamKey,
  resolveParam,
  useRuleThresholds,
  validParamValue,
  type ParamSource,
  type RuleThresholdsStore,
} from './thresholds';
