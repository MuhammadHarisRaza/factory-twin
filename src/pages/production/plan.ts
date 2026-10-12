/**
 * Plan & flow — pure derivations for "Are we meeting the plan, and where are we losing output?":
 * the constraint statement (the ONE claim every surface makes — constraintClaim / constraintPhrase in
 * src/intel/summary.ts — with the 120-min bottleneck trace, buffers and event records as supporting
 * evidence only), the stage flow rows, the important production events and the page summary.
 * Every figure comes from src/sim/metrics.ts, the event engine and the stage registry.
 */
import { productionKpis, type KpiModel } from '../../intel/kpis';
import { clockLabel, constraintClaim, constraintPhrase, kilnFeedStaleSince, notConfirmedReason, unconfirmedOutputPhrase, type ConstraintClaim } from '../../intel/summary';
import { LINE, STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity, MonitoredStageId, OpEvent, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { lineGoodLostTiles } from '../../intel/report';
import { HELD_UP_SHARE, TARGET_STATUS_LABEL, bottleneck, targetStatus, type LineMetrics, type Period } from '../../sim/metrics';
import { lineFlow, type FlowBuffer } from './line';
import type { FinanceAssumptions } from '../../sim/finance';
import { constraintAttribution, lossLedger, type ConstraintCause } from './loss';
import { productionLosses, type LossItem } from './lossItems';
import { assetStage, bottleneckView, monitoredStageOf, overview, type StageRow } from './stage/derive';

const n0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const pctS = (f: number | null | undefined, d = 0) => (f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(d)} %`);
const minS = (v: number) => `${n0.format(Math.round(v))} min`;
const m2S = (v: number) => `${n0.format(Math.round(v))} m²`;

type Bottleneck = ReturnType<typeof bottleneck>;


// ── Constraint: the shared claim and its evidence ────────────────────────────

export type ConstraintView = {
  /** The configured (modeled) design constraint of the line. */
  design: { stage: StageId; name: string; monitored: MonitoredStageId | null };
  /** The shared constraint claim (constraintClaim) — what the Overview, flow strip, twin and Copilot say. */
  constraint: ConstraintClaim;
  /** The stage the claim names (the kiln for design / kiln claims, otherwise the stage the trace ended at). */
  named: { stage: StageId; name: string; monitored: MonitoredStageId; machines: string[] };
  /** "Currently constraining output" is supported by the evidence (claim.constraining). */
  constraining: boolean;
  /** The claim names the line's design constraint (the kiln). */
  atDesign: boolean;
  /** Cause found by the bottleneck trace of the window — supporting evidence, never the claim itself. */
  cause: Bottleneck['cause'];
  /** Trace window in words, e.g. "the last 2 h" (claim.window). */
  windowLabel: string;
  kilnStarvedShare: number;
  kilnBlockedShare: number;
  threshold: number;
  /** Short heading: the claim's label and the stage, e.g. "Constraint · Kiln firing & cooling". */
  headline: string;
  /** The claim as a sentence (constraintPhrase), the same words as the Overview summary. */
  statement: string;
  /** A restriction the event records place between the named stage and the kiln (asset), if any. */
  restriction: string | null;
  /** Supporting evidence (trace shares — as history when they disagree with the claim — buffers, event records). */
  evidence: string[];
  /** Largest recorded root cause of kiln hold-ups in the trace window (event records), if any. */
  root: (ConstraintCause & { stage: MonitoredStageId | null }) | null;
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The constraint statement of Production, driven by the shared claim (constraintClaim): it names the
 * same stage with the same words as every other surface — "currently constraining output" only when
 * the claim is constraining, the kiln as the modeled design constraint otherwise, nothing beyond the
 * design label while the kiln feed is stale, and the stopped / slowed kiln ahead of the window's trace.
 * The 120-min bottleneck trace (minute log), the buffers either side and the event records are kept
 * as supporting evidence; where the trace disagrees with the kiln's state now, it is worded as history.
 */
export function constraintView(s: SimState, bn: Bottleneck = bottleneck(s), claim: ConstraintClaim = constraintClaim(s, 120, bn)): ConstraintView {
  const designStage = LINE.designConstraint;
  const design = { stage: designStage, name: STAGE_BY_ID[designStage].name, monitored: monitoredStageOf(designStage) };
  const named = { stage: claim.processStage, name: STAGE_BY_ID[claim.processStage].name, monitored: claim.stage, machines: [...STAGE_BY_ID[claim.processStage].machines] };
  const cur = bn.current;
  const k = bn.constraint;
  const win = claim.window;
  const flow = lineFlow(s, bn);
  const buf = (stage: StageId) => flow.find((f) => f.stage === stage)?.input ?? null;
  const bufText = (b: FlowBuffer | null) => (b ? `${b.name} ${pctS(b.fill)} full${b.trend ? ` (${b.trend})` : ''}` : null);
  const att = constraintAttribution(s, bn.period);
  const rootCause = att.causes.find((c) => c.minutes >= 1) ?? null;
  const root = rootCause ? { ...rootCause, stage: assetStage(rootCause.equipmentId) } : null;
  const rootLine = root
    ? `Event records: ${root.equipmentId} · ${root.name} held the kiln up ${minS(root.minutes)} in ${win}${root.reasons[0] ? ` — ${lower(root.reasons[0].label)}` : ''}; the largest recorded cause.`
    : null;
  const kilnBuffers = () => {
    const kin = bufText(buf(designStage));
    const kout = bufText(flow.find((f) => f.input?.fedBy === designStage)?.input ?? null);
    return kin || kout ? `Buffers either side of the kiln now: ${[kin, kout].filter(Boolean).join('; ')}.` : null;
  };
  const traced = bn.cause === 'starving' || bn.cause === 'blocking';
  const starving = bn.cause === 'starving';
  const evidence: string[] = [];
  let restriction: string | null = null;
  const push = (x: string | null) => {
    if (x) evidence.push(x);
  };

  if (claim.kind === 'kiln-unknown') {
    // The kiln's state is unknown: the trace after the freeze rests on values the feed has not confirmed.
    const since = kilnFeedStaleSince(s);
    push(
      `The kiln data feed has been stale${since != null ? ` since ${clockLabel(since, s.minute)}` : ''}: its state now and the bottleneck trace after that minute are not confirmed, so nothing beyond the modeled design constraint is claimed.`,
    );
  } else if (claim.kind === 'starving' || claim.kind === 'blocking') {
    // The trace is the claim's evidence: the stage it ended at, the stages held up in between, the buffer.
    const ci = bn.stages.findIndex((st) => st.stage === designStage);
    const oi = bn.stages.findIndex((st) => st.stage === cur.stage);
    const between = bn.stages.slice(Math.min(ci, oi) + 1, Math.max(ci, oi));
    const restrictionBetween = starving ? cur.blockedShare > HELD_UP_SHARE : cur.starvedShare > HELD_UP_SHARE;
    const rootAsset = root && root.lastActive >= bn.period.from && !named.machines.includes(root.equipmentId) ? `${root.equipmentId} · ${root.name}` : null;
    if (restrictionBetween && rootAsset) restriction = `${rootAsset}, between ${lower(cur.name)} and the kiln`;
    push(starving ? `Kiln starved ${pctS(k.starvedShare)} of ${win} (trace threshold ${pctS(HELD_UP_SHARE)}).` : `Kiln blocked ${pctS(k.blockedShare)} of ${win} (trace threshold ${pctS(HELD_UP_SHARE)}).`);
    if (between.length) push(`${between.map((st) => `${st.name} ${starving ? `starved ${pctS(st.starvedShare)}` : `blocked ${pctS(st.blockedShare)}`}`).join(', ')} — held up between it and the kiln.`);
    push(`${cur.name} was ${starving ? `starved only ${pctS(cur.starvedShare)}` : `blocked only ${pctS(cur.blockedShare)}`}: working ${pctS(cur.workingShare)}, down ${pctS(cur.downShare)} of the window.`);
    if (restrictionBetween)
      push(
        `${cur.name} was itself ${starving ? `blocked ${pctS(cur.blockedShare)}` : `starved ${pctS(cur.starvedShare)}`} — the restriction sits between it and the kiln (a transfer or conveyor)${restriction ? `: ${rootAsset}` : ''}.`,
      );
    const kin = starving ? bufText(buf(designStage)) : bufText(flow.find((f) => f.input?.fedBy === designStage)?.input ?? null);
    if (kin) push(`${starving ? 'Buffer ahead of the kiln' : 'Buffer behind the kiln'} now: ${kin}.`);
    push(rootLine);
  } else {
    // The claim names the kiln (design constraint, planned stop, stopped or slowed now).
    if (traced) {
      // The trace disagrees with the kiln's own state now: it is history, the state now outranks it.
      const own = claim.kind === 'kiln-stopped' ? 'stop' : claim.kind === 'kiln-slow' ? 'reduced rate' : claim.kind === 'planned' ? 'planned stop' : 'state';
      push(
        `Earlier in ${win} the kiln was ${starving ? `starved ${pctS(k.starvedShare)}` : `blocked ${pctS(k.blockedShare)}`} of its planned time, traced ${starving ? 'upstream' : 'downstream'} to ${lower(cur.name)} — history: the kiln's own ${own} now outranks that trace.`,
      );
    } else {
      push(
        `Over ${win} the kiln was starved ${pctS(k.starvedShare)} and blocked ${pctS(k.blockedShare)} of its planned time (trace threshold ${pctS(HELD_UP_SHARE)}): working ${pctS(k.workingShare)}, down ${pctS(k.downShare)}.`,
      );
      const held = bn.stages.filter((st) => st.stage !== designStage && (st.starvedShare > HELD_UP_SHARE || st.blockedShare > HELD_UP_SHARE));
      if (held.length)
        push(
          `Held up elsewhere without reaching the kiln: ${held.map((st) => `${lower(st.name)} ${st.starvedShare >= st.blockedShare ? `starved ${pctS(st.starvedShare)}` : `blocked ${pctS(st.blockedShare)}`}`).join(', ')} — absorbed by the buffers.`,
        );
    }
    push(kilnBuffers());
    push(rootLine);
  }
  return {
    design,
    constraint: claim,
    named,
    constraining: claim.constraining,
    atDesign: claim.processStage === designStage,
    cause: bn.cause,
    windowLabel: win,
    kilnStarvedShare: k.starvedShare,
    kilnBlockedShare: k.blockedShare,
    threshold: HELD_UP_SHARE,
    headline: `${claim.label} · ${claim.name}`,
    statement: `${cap(constraintPhrase(claim))}.`,
    restriction,
    evidence,
    root,
  };
}

// ── Stage flow ───────────────────────────────────────────────────────────────

export type FlowRow = {
  row: StageRow;
  /** The stage's input (work-in-progress) buffer with its trend; null where there is none. */
  buffer: FlowBuffer | null;
  /** The modeled design constraint is in this stage. */
  isDesign: boolean;
  /** The constraint claim (constraintClaim) names this stage. */
  isClaim: boolean;
};

/** Every monitored stage in flow order with its counts for the period, state now and input buffer. */
export function stageFlow(s: SimState, p: Period, bn: Bottleneck = bottleneck(s), claim: ConstraintClaim = constraintClaim(s, 120, bn)): FlowRow[] {
  const o = overview(s, p, bottleneckView(s, claim));
  const flow = lineFlow(s, bn);
  const buffers = new Map<string, FlowBuffer>();
  for (const f of flow) if (f.input) buffers.set(f.input.id, f.input);
  return o.rows.map((row) => ({
    row,
    buffer: row.ms.wipBufferId ? (buffers.get(row.ms.wipBufferId) ?? null) : null,
    isDesign: row.isConstraint,
    isClaim: row.ms.id === claim.stage,
  }));
}

// ── Important production events ──────────────────────────────────────────────

const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

export type ProductionEvent = {
  ev: OpEvent;
  /** Kiln minutes this event held up (whole event, from the event engine's accounting). */
  kilnMin: number;
  /** Good line output lost in those minutes (tiles), as in the event report. */
  lostGoodTiles: number;
};

/**
 * Production and equipment events that overlap the period and matter: root events only (knock-on
 * starvation is part of its root), warning or above or with kiln hold-up. Active first, then the
 * largest line impact, then the most severe, then the newest.
 */
export function productionEvents(s: SimState, p: Period, limit = 5): { total: number; list: ProductionEvent[] } {
  const evs = s.events.filter(
    (e) =>
      (e.category === 'production' || e.category === 'equipment') &&
      !e.consequenceOf &&
      (e.severity !== 'info' || e.acc.constraintMin > 0) &&
      e.start < p.to &&
      (e.end ?? s.minute) >= p.from,
  );
  evs.sort(
    (a, b) =>
      Number(b.end == null) - Number(a.end == null) ||
      b.acc.constraintMin - a.acc.constraintMin ||
      SEV_RANK[b.severity] - SEV_RANK[a.severity] ||
      b.start - a.start,
  );
  return { total: evs.length, list: evs.slice(0, limit).map((ev) => ({ ev, kilnMin: ev.acc.constraintMin, lostGoodTiles: lineGoodLostTiles(s, ev) })) };
}

// ── Page summary ─────────────────────────────────────────────────────────────

/**
 * Why the capacity losses (kiln accounting, closed to good output at sorting) are not confirmed — the
 * stale reason of the kiln downtime KPI or of the good-output KPI ("kiln data stale since 10:30") — or null.
 */
export const lossesNotConfirmed = (kpis: KpiModel[]) => notConfirmedReason(...kpis.filter((k) => k.id === 'constraint-downtime' || k.id === 'good-output'));

/**
 * The one-paragraph answer of Plan & flow: attainment against the plan, the largest loss and the
 * constraint — each only as far as the data support it. Output vs plan is stated as not confirmed when
 * the good-output / attainment KPI rests on a stale feed (`kpis`, provenance 'stale'); the constraint
 * is the shared claim's sentence (constraintPhrase), the same words as the Overview.
 */
export function planSummary(lm: LineMetrics, losses: LossItem[], cv: ConstraintView, kpis: KpiModel[] = [], toDate = false): string {
  const st = targetStatus(lm.attainment);
  if (st === 'none') return 'No planned production time has elapsed in this period yet, so there is no plan to compare with.';
  const gap = lm.targetM2 - lm.outputM2;
  const parts: string[] = [];
  const notConfirmed = notConfirmedReason(...kpis.filter((k) => k.id === 'good-output' || k.id === 'target-attainment'));
  parts.push(
    notConfirmed
      ? `${unconfirmedOutputPhrase(notConfirmed, lm.outputM2, lm.targetM2, toDate)}.`
      : `Good output is ${m2S(lm.outputM2)} against a plan of ${m2S(lm.targetM2)} (${pctS(lm.attainment, 1)} — ${lower(TARGET_STATUS_LABEL[st])}${gap > 0.5 ? `, ${m2S(gap)} short` : ''}).`,
  );
  const top = losses[0];
  // The losses are the kiln's accounting closed to good output: a stale kiln or sorting feed leaves them unconfirmed too.
  const lossesUnconfirmed = lossesNotConfirmed(kpis);
  const lossNote = lossesUnconfirmed ? ` (not confirmed — ${lossesUnconfirmed})` : '';
  const constraint = `${constraintPhrase(cv.constraint)}${cv.restriction ? `; event records place the restriction at ${cv.restriction}` : ''}`;
  parts.push(
    top
      ? `The largest loss against design capacity is ${top.short}, ${m2S(top.m2)}${lossNote}. ${cap(constraint)}.`
      : `No loss against design capacity was recorded at the kiln${lossNote}. ${cap(constraint)}.`,
  );
  return parts.join(' ');
}

// ── Everything Plan & flow shows ─────────────────────────────────────────────

export type PlanData = ReturnType<typeof planData>;

/** The Plan & flow view model for a period, computed once (one bottleneck trace, one claim, one loss ledger). */
export function planData(s: SimState, p: Period, f: FinanceAssumptions) {
  const bn = bottleneck(s);
  const claim = constraintClaim(s, 120, bn);
  const L = lossLedger(s, p, f);
  const cv = constraintView(s, bn, claim);
  const losses = productionLosses(s, p, f, L);
  const kpis = productionKpis(s, p);
  return {
    p,
    kpis,
    cv,
    flow: stageFlow(s, p, bn, claim),
    losses,
    cap: L.cap,
    shortfallM2: Math.max(0, L.planGapM2),
    allowance: L.theoreticalM2 > 0 ? L.allowanceM2 / L.theoreticalM2 : null,
    events: productionEvents(s, p),
    now: s.minute,
    /** Why the losses are not confirmed ("kiln data stale since 10:30"), or null. */
    lossStale: lossesNotConfirmed(kpis),
    summary: planSummary(L.lm, losses, cv, kpis, p.to >= s.minute),
  };
}
