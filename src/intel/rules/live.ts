/**
 * Findings for the live views (the Overview's insight feed, the equipment and stage cards): the rule engine evaluates
 * every applicable rule over its windows, the most expensive derivation of a simulated minute. A live view re-evaluates
 * at most every LIVE_FINDINGS_MIN simulated minutes — at once when something material changes (src/sim/live.ts) or a
 * threshold is edited — and says when it was evaluated. findingsFor itself is always current.
 */
import type { SimState } from '../../sim/engine';
import { liveValue, type Live } from '../../sim/live';
import { findingsFor, plantFindings, type PlantFindings } from './engine';
import { RULES } from './registry';
import { useRuleThresholds } from './thresholds';
import { scopeKey, type RuleFinding, type RuleScope } from './types';

/** Longest a live view's findings may be (simulated minutes) before they are evaluated again. */
export const LIVE_FINDINGS_MIN = 5;

export type LiveFindings<T> = Live<T>;

const fresh = (at: number, now: number) => now - at < LIVE_FINDINGS_MIN;
const rulesKey = () => `${useRuleThresholds.getState().version}|${RULES.length}`;

/** Findings of a scope for a live view (see the module note); `at` is the evaluation minute. */
export const liveFindingsFor = (s: SimState, scope: RuleScope): LiveFindings<RuleFinding[]> =>
  liveValue(s, `findings:${scopeKey(scope)}`, rulesKey(), fresh, () => findingsFor(s, scope));

/** Plant-wide findings for a live view (see the module note); `at` is the evaluation minute. */
export const livePlantFindings = (s: SimState, top: number): LiveFindings<PlantFindings> =>
  liveValue(s, `plant:${top}`, rulesKey(), fresh, () => plantFindings(s, { top }));
