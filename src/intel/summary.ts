/**
 * Executive summary of the Overview: one or two data-driven sentences on the current shift —
 * production against the shift plan, what is constraining the line, and the open issues.
 *
 * Every claim is read from the shared metric / KPI layer (goodOutputKpi / targetAttainmentKpi over
 * lineMetrics, bottleneck, operationalState, attentionEvents), so the sentence always agrees with the
 * KPI cards, the flow strip and the issues list. A figure resting on a stale data feed (the KPI carries
 * provenance 'stale') is never stated as fact: the sentence says it is not confirmed and why, with the
 * simulation's running figure in brackets. The constraint wording is deliberately graded:
 *  - "modeled design constraint" when only the configured line constraint (the kiln) is behind the
 *    claim — the kiln was not held up by another stage and is not stopped or slowed now;
 *  - "currently constraining output" only when the evidence supports it, and the evidence is
 *    named: the kiln itself is stopped or runs below its design rate now (its state now outranks the
 *    window's trace), or it was starved / blocked in the window and the trace from the kiln upstream /
 *    downstream ends at another stage;
 *  - nothing beyond the modeled design constraint while the kiln's data feed is stale (its state is
 *    unknown, and the trace after the freeze rests on values the feed has not confirmed).
 * Values are simulated; nothing here is a language model.
 */
import { LINE, MONITORED_STAGE_BY_ID, REASON_BY_CODE, STAGE_BY_ID } from '../model/plant';
import type { AlertSeverity, MonitoredStageId, OpEvent, StageId } from '../model/types';
import { findDowntime, type SimState } from '../sim/engine';
import { HELD_UP_SHARE, TARGET_STATUS_LABEL, bottleneck, lineMetrics, operationalState, resolvePeriod, targetStatus, type Period, type TargetStatus } from '../sim/metrics';
import { formatClock, formatDateTime } from '../sim/time';
import { attentionEvents, goodOutputKpi, targetAttainmentKpi, type KpiModel } from './kpis';

/** Process stage → the monitored stage that contains it (glazing + decoration, packing + palletising). */
export const toMonitoredStage = (st: StageId): MonitoredStageId => (st === 'DECOR' ? 'GLAZE' : st === 'PAL' ? 'PACK' : st);

const int = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const KILN_ID = 'H-KILN';

// ── Constraint ───────────────────────────────────────────────────────────────

export type ConstraintKind =
  /** Only the configured design constraint is behind the claim (kiln not held up, not stopped or slowed now). */
  | 'design'
  /** The kiln is in a planned stop now (the plan excludes planned stops). */
  | 'planned'
  /** The kiln itself is stopped / in fault now — line output is being lost at the constraint. */
  | 'kiln-stopped'
  /** The kiln is running below its design rate now. */
  | 'kiln-slow'
  /** The kiln data feed is stale: its state is unknown, so no constraint claim beyond the design. */
  | 'kiln-unknown'
  /** The kiln was starved in the window; traced upstream to the stage that was not itself starved. */
  | 'starving'
  /** The kiln was blocked in the window; traced downstream to the stage that was not itself blocked. */
  | 'blocking';

export type ConstraintClaim = {
  kind: ConstraintKind;
  /** True only when the evidence supports "currently constraining output". */
  constraining: boolean;
  /** Monitored stage named by the claim (the kiln for design / kiln claims). */
  stage: MonitoredStageId;
  /** Process stage the bottleneck trace ended at. */
  processStage: StageId;
  /** Display name of the monitored stage. */
  name: string;
  /** The evidence behind the claim, summary length (lower-case start, no full stop). */
  evidence: string;
  /** The evidence with its figures, for tooltips and detail (lower-case start, no full stop). */
  detail: string;
  /** Short label for markers: "Constraint" or "Design constraint". */
  label: string;
  /** Rolling window the trace uses, e.g. "the last 2 h". */
  window: string;
};

const windowWords = (min: number) => (min % 60 === 0 ? `the last ${min / 60} h` : `the last ${min} min`);
/** "Simulated breakdown (scenario)" → "simulated breakdown, scenario" (no nested brackets in a sentence). */
const reasonWords = (label: string) => label.toLowerCase().replace(/\s*\((.*)\)\s*$/, ', $1');

/**
 * What constrains the line now, with honest wording (see the file header). Reads bottleneck(s)
 * (traced from the kiln over the last 120 min) and the kiln's operational state now. `bn` lets a
 * caller that already traced the same window reuse it (it must be bottleneck(s, windowMin)).
 */
export function constraintClaim(s: SimState, windowMin = 120, bn: ReturnType<typeof bottleneck> = bottleneck(s, windowMin)): ConstraintClaim {
  const window = windowWords(windowMin);
  const c = bn.constraint;
  const kilnStage = LINE.designConstraint;
  const shares = `starved ${pct(c.starvedShare)}, blocked ${pct(c.blockedShare)}, down ${pct(c.downShare)} of ${window}`;
  const base = (kind: ConstraintKind, constraining: boolean, processStage: StageId, evidence: string, detail = evidence): ConstraintClaim => {
    const stage = toMonitoredStage(processStage);
    return { kind, constraining, stage, processStage, name: MONITORED_STAGE_BY_ID[stage].name, evidence, detail, label: constraining ? 'Constraint' : 'Design constraint', window };
  };

  const m = s.machines[KILN_ID];
  const op = m ? operationalState(s, KILN_ID) : 'unknown';

  // 1. The kiln itself stopped now: line output is being lost at the constraint right now, whatever
  //    the trace of the last window says (a stop now outranks an earlier starvation / blockage).
  if (m && (op === 'stopped' || op === 'fault')) {
    const d = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
    const reason = d ? REASON_BY_CODE[d.reasonCode]?.label : undefined;
    const evidence = `the kiln has been ${op === 'fault' ? 'in fault' : 'stopped'} since ${formatClock(d?.start ?? m.since)}${reason ? ` (${reasonWords(reason)})` : ''}`;
    return base('kiln-stopped', true, kilnStage, evidence, `${evidence}; kiln ${shares}`);
  }
  // 2. A planned kiln stop: the plan excludes it, so nothing is constraining output against plan now.
  if (op === 'planned') return base('planned', false, kilnStage, 'the kiln is in a planned stop, which the shift plan excludes', `the kiln is in a planned stop, which the shift plan excludes; kiln ${shares}`);
  // 3. The kiln runs below its design rate now: output is lost at the constraint now (outranks the trace too).
  if (m && op === 'reduced') {
    const evidence = `the kiln has been running at ${pct(m.rateFactor)} of its design rate since ${formatClock(m.since)}`;
    return base('kiln-slow', true, kilnStage, evidence, `${evidence}; kiln ${shares}`);
  }
  // 4. The kiln's data feed is stale: its state is unknown and the trace after the freeze is not
  //    confirmed — no claim beyond the configured design constraint.
  if (!m || op === 'unknown' || op === 'disconnected')
    return base('kiln-unknown', false, kilnStage, 'the kiln data feed is stale, so its current state is unknown', 'the kiln data feed is stale, so its current state is unknown — the claim rests on the configured design constraint only');

  // 5. The kiln was starved / blocked in the window: traced to the stage holding it up.
  if (bn.cause === 'starving' || bn.cause === 'blocking') {
    const cur = bn.current;
    const starving = bn.cause === 'starving';
    const held = starving ? c.starvedShare : c.blockedShare;
    const own = (cur.downShare ?? 0) > HELD_UP_SHARE ? `down ${pct(cur.downShare)} of that time` : `working ${pct(cur.workingShare)} of that time without being ${starving ? 'starved' : 'blocked'} itself`;
    const evidence = `the kiln was ${starving ? 'starved' : 'blocked'} ${pct(held)} of ${window}, traced ${starving ? 'upstream' : 'downstream'} to ${STAGE_BY_ID[cur.stage].name.toLowerCase()} (${own})`;
    return base(bn.cause, true, cur.stage, evidence, `${evidence}. Traced from the kiln (the line's design constraint): every stage in between was itself ${starving ? 'starved' : 'blocked'} more than ${pct(HELD_UP_SHARE)} of the window`);
  }

  // 6. The kiln was neither starved nor blocked in the window and runs: it limits the line as designed.
  if (op === 'starved' || op === 'blocked') {
    // Held up right now, but not yet for long enough in the window to trace the constraint elsewhere.
    const evidence = `the kiln has been ${op} since ${formatClock(m.since)}, not yet long enough to trace the constraint to another stage`;
    return base('design', false, kilnStage, evidence, `${evidence}; kiln ${shares} (a stage is traced once the kiln is held up more than ${pct(HELD_UP_SHARE)} of the window)`);
  }
  const recovered = (c.downShare ?? 0) > HELD_UP_SHARE ? `; it was down ${pct(c.downShare)} of ${window} and is running again` : '';
  return base(
    'design',
    false,
    kilnStage,
    `no other stage held it up in ${window}${recovered}`,
    `no other stage held the kiln up in ${window} (kiln ${shares}); the kiln is running, so only the configured design constraint is behind this`,
  );
}

/** The constraint part of the summary sentence (no full stop). */
export function constraintPhrase(c: ConstraintClaim): string {
  if (c.constraining) return `${c.name} is currently constraining output — ${c.evidence}`;
  if (c.kind === 'planned') return `${c.name} is the modeled design constraint and is in a planned stop (the shift plan excludes it)`;
  if (c.kind === 'kiln-unknown') return `${c.name} is the modeled design constraint; its data feed is stale, so its current state is unknown`;
  return `${c.name} is the modeled design constraint — ${c.evidence}`;
}

/** "The kiln data feed is stale since 10:30" — minute the kiln feed froze (null when it is fresh). */
export const kilnFeedStaleSince = (s: SimState): number | null => (s.feeds[KILN_ID]?.status === 'stale' ? s.feeds[KILN_ID].since : null);

// ── Not-confirmed figures (stale data feeds) ─────────────────────────────────

/**
 * Why a KPI's figure is not confirmed — "sorting data stale since 10:30" — or null when it is. Read
 * from the KPI model (provenance 'stale' and its "Not confirmed · …" status), so a sentence names the
 * same feed and minute as the card.
 */
export function notConfirmedReason(...ks: KpiModel[]): string | null {
  for (const k of ks) {
    if (k.provenance !== 'stale') continue;
    const label = k.status?.label ?? '';
    const m = /^Not confirmed · (.+)$/.exec(label);
    return m ? m[1] : 'its data feed is stale';
  }
  return null;
}

/**
 * The output-vs-plan sentence for a figure that is not confirmed (no full stop): "Output vs plan not
 * confirmed — sorting data stale since 10:30 (simulated running total 1,855 m² of 1,782 m² planned
 * to date)". The running total is the simulation's accounting — the same figure as the KPI cards.
 */
export function unconfirmedOutputPhrase(reason: string, outputM2: number, planM2: number, toDate: boolean): string {
  return `Output vs plan not confirmed — ${reason} (simulated running total ${int(outputM2)} m² of ${int(planM2)} m² planned${toDate ? ' to date' : ''})`;
}

/** "10:30" for a time today, "Sun 11 Oct 10:30" for an earlier day. */
export const clockLabel = (t: number, now: number) => (Math.floor(t / 1440) === Math.floor(now / 1440) ? formatClock(t) : formatDateTime(t));

// ── Summary ──────────────────────────────────────────────────────────────────

export type ExecutiveSummary = {
  /** The one or two sentences shown under the page title. */
  text: string;
  sentences: string[];
  /** 'normal' when on or ahead of plan, no constraint beyond the design and nothing open. */
  state: 'normal' | 'attention' | 'no-data';
  period: Period;
  production: {
    status: TargetStatus;
    outputM2: number;
    planM2: number;
    gapM2: number;
    attainment: number | null;
    /** False when the good-output / attainment KPI rests on a stale data feed (provenance 'stale'). */
    confirmed: boolean;
    /** Why it is not confirmed, e.g. "sorting data stale since 10:30" (null when confirmed). */
    notConfirmed: string | null;
  };
  constraint: ConstraintClaim;
  issues: { count: number; bySeverity: Record<AlertSeverity, number>; top: OpEvent | null };
};

const productionSentence = (status: TargetStatus, outputM2: number, planM2: number, gapM2: number, notConfirmed: string | null) => {
  if (status === 'none') return 'No planned production time has elapsed in this shift yet, so there is no plan to compare output with.';
  if (notConfirmed) return `${unconfirmedOutputPhrase(notConfirmed, outputM2, planM2, true)}.`;
  const gap = Math.abs(gapM2) < 0.5 ? 'exactly on plan' : gapM2 > 0 ? `${int(gapM2)} m² short` : `${int(-gapM2)} m² ahead`;
  return `Production is ${TARGET_STATUS_LABEL[status].toLowerCase()}: ${int(outputM2)} m² of good output against ${int(planM2)} m² planned so far this shift (${gap}).`;
};

const issuesPhrase = (list: OpEvent[]) => {
  if (!list.length) return 'no open issues require attention';
  const top = list[0];
  const n = list.length;
  return n === 1
    ? `1 open issue requires attention: ${top.title} (${top.severity})`
    : `${n} open issues require attention, the most severe: ${top.title} (${top.severity})`;
};

/** The Overview summary for the current shift (plant time now). */
export function executiveSummary(s: SimState): ExecutiveSummary {
  const period = resolvePeriod('shift', s.minute);
  const lm = lineMetrics(s, period);
  const status = targetStatus(lm.attainment);
  const gapM2 = lm.targetM2 - lm.outputM2;
  // The same KPI models as the cards: a stale sorting feed leaves output vs plan not confirmed.
  const notConfirmed = notConfirmedReason(goodOutputKpi(s, period, lm), targetAttainmentKpi(s, period, lm));
  const constraint = constraintClaim(s);
  const issues = attentionEvents(s);
  const bySeverity: Record<AlertSeverity, number> = { critical: 0, serious: 0, warning: 0, info: 0 };
  for (const e of issues) bySeverity[e.severity]++;

  const first = productionSentence(status, lm.outputM2, lm.targetM2, gapM2, notConfirmed);
  const second = `${constraintPhrase(constraint)}; ${issuesPhrase(issues)}.`;
  const sentences = [first, second.charAt(0).toUpperCase() + second.slice(1)];
  const normal = !notConfirmed && (status === 'ahead' || status === 'on-track') && !constraint.constraining && issues.length === 0;
  return {
    text: sentences.join(' '),
    sentences,
    state: status === 'none' ? 'no-data' : normal ? 'normal' : 'attention',
    period,
    production: { status, outputM2: lm.outputM2, planM2: lm.targetM2, gapM2, attainment: lm.attainment, confirmed: !notConfirmed, notConfirmed },
    constraint,
    issues: { count: issues.length, bySeverity, top: issues[0] ?? null },
  };
}
