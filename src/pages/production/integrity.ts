/**
 * OEE integrity checks (master prompt §10) and the count reconciliation, evaluated from the data.
 *
 * `integrityInputs` collects every figure the checks need from the one simulation state, exactly as
 * the product computes and shows them (lineMetrics, the kiln time accounting, the downtime records,
 * qualityIn, countReconciliation, capacityBreakdown, the OEE loss tree). `evaluateIntegrity` is pure
 * arithmetic on those inputs, so a deliberately inconsistent input is flagged the same way a real
 * counting problem would be. Nothing here adjusts a figure to make the checks pass.
 */
import { M2_PER_TILE, OPS_BY_ID, PROCESS_MACHINES, TARGET } from '../../model/plant';
import type { HourBucket } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { contributionPerM2, type FinanceAssumptions } from '../../sim/finance';
import {
  capacityBreakdown,
  clippedDuration,
  countReconciliation,
  downtimeIn,
  hourlyTrend,
  lineLossTree,
  lineMetrics,
  qualityIn,
  sumBuckets,
  type Period,
} from '../../sim/metrics';
import type { Metric } from '../../sim/oee';
import { formatClock, formatDateTime } from '../../sim/time';
import { constraintFeedStale } from '../../intel/kpis';
import { KILN } from './loss';

const n0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const n1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pctS = (f: number | null | undefined, d = 1) => (f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(d)} %`);
const minS = (v: number) => `${n1.format(v)} min`;
const tiles = (v: number) => `${n0.format(v)} tiles`;
const money = (cur: string, v: number) => `${cur} ${v.toFixed(2)}`;

/** Rounding tolerance of counters and minute accounting (0.5 %, as in src/sim/oee.ts). */
const REL_TOL = 0.005;
/** Absolute tolerances: half a tile, one minute, half a square metre. */
const TILE_TOL = 0.5;
const MIN_TOL = 1;
const M2_TOL = 0.5;

export type CheckStatus = 'pass' | 'attention' | 'na';
export type IntegrityCheck = { n: number; key: string; title: string; status: CheckStatus; evidence: string };

export type CountChain = ReturnType<typeof countReconciliation>;

export type IntegrityInputs = {
  /** Calendar minutes of the period simulated so far. */
  periodMin: number;
  /** Kiln (H-KILN) time accounting and count for the period. */
  kiln: HourBucket;
  /** Kiln design rate (tiles/h), null when not configured. */
  kilnIdealPerHour: number | null;
  /** The line OEE components as the product shows them (lineMetrics). */
  oee: { availability: Metric; performance: Metric; quality: Metric; oee: Metric };
  /** Sorting counts (qualityIn) and the sorter's own count. */
  quality: { inspected: number; rejected: number; accepted: number; byDefectSum: number; sorterCount: number };
  /** Plan of the period (good tiles) and the plan rate. */
  planTiles: number;
  planPerHour: number;
  /** Configured ideal rate per process machine (null = missing). */
  idealRates: Record<string, number | null>;
  /** Kiln downtime records clipped to the period: unplanned stops and planned stops, minutes. */
  records: { unplannedMin: number; plannedMin: number };
  /** Period totals and the sums of the hour buckets. */
  totals: { good: number; plan: number; rejects: number };
  hourly: { good: number; plan: number; rejects: number; hours: number };
  chain: CountChain;
  capacity: { theoreticalM2: number; goodM2: number; steps: { key: string; m2: number; kind: 'loss' | 'transit' }[] };
  tree: { planned: number; availabilityLoss: number; performanceLoss: number; qualityLoss: number; fullyProductive: number } | null;
  finance: FinanceAssumptions;
  /**
   * Data feed of the line constraint (H-KILN) in the period: the minute it went stale and is still stale
   * (constraintFeedStale), and earlier gaps inside the period that have since been restored (simulated feed-loss windows).
   */
  constraintFeed: { staleSince: number | null; gaps: { from: number; to: number }[]; now: number };
};

/** Collects the inputs of the checks for a period from the simulation. */
export function integrityInputs(s: SimState, p: Period, finance: FinanceAssumptions): IntegrityInputs {
  const lm = lineMetrics(s, p);
  const q = qualityIn(s, p);
  const kiln = sumBuckets(s, KILN, p);
  const kilnDowntime = downtimeIn(s, p).filter((d) => d.equipmentId === KILN);
  const recordMin = (pred: (c: string) => boolean) => kilnDowntime.filter((d) => pred(d.category)).reduce((a, d) => a + clippedDuration(d, p, s.minute), 0);
  const hours = hourlyTrend(s, p);
  const cap = capacityBreakdown(s, p);
  const tree = lineLossTree(s, p);
  return {
    periodMin: Math.max(0, Math.min(p.to, s.minute) - p.from),
    kiln,
    kilnIdealPerHour: OPS_BY_ID[KILN]?.idealRatePerHour ?? null,
    oee: { availability: lm.oee.availability, performance: lm.oee.performance, quality: lm.oee.quality, oee: lm.oee.oee },
    quality: {
      inspected: q.inspected,
      rejected: q.rejected,
      accepted: q.accepted,
      byDefectSum: Object.values(q.byDefect).reduce((a, b) => a + b, 0),
      sorterCount: sumBuckets(s, 'I-SORT', p).count,
    },
    planTiles: lm.target,
    planPerHour: TARGET.goodPerHour,
    idealRates: Object.fromEntries(PROCESS_MACHINES.map((id) => [id, OPS_BY_ID[id]?.idealRatePerHour ?? null])),
    records: { unplannedMin: recordMin((c) => c !== 'Starved' && c !== 'Blocked' && c !== 'Planned'), plannedMin: recordMin((c) => c === 'Planned') },
    totals: { good: lm.output, plan: lm.target, rejects: lm.rejected },
    hourly: { good: hours.reduce((a, h) => a + h.output, 0), plan: hours.reduce((a, h) => a + h.target, 0), rejects: hours.reduce((a, h) => a + h.rejects, 0), hours: hours.length },
    chain: countReconciliation(s, p),
    capacity: { theoreticalM2: cap.theoreticalM2, goodM2: cap.goodM2, steps: cap.losses.map((l) => ({ key: l.key, m2: l.m2, kind: l.kind })) },
    tree: tree ? { planned: tree.planned, availabilityLoss: tree.availabilityLoss, performanceLoss: tree.performanceLoss, qualityLoss: tree.qualityLoss, fullyProductive: tree.fullyProductive } : null,
    finance,
    constraintFeed: { staleSince: constraintFeedStale(s, p), gaps: restoredFeedGaps(s, KILN, p), now: s.minute },
  };
}

/**
 * Feed-loss windows of an asset inside the period that have ended (the feed is updating again). A feed is
 * only ever lost through a signal-loss activation in the simulation, so its windows are those activations.
 */
export function restoredFeedGaps(s: SimState, id: string, p: Period): { from: number; to: number }[] {
  const to = Math.min(p.to, s.minute);
  return s.scenarios
    .filter((sc) => sc.kind === 'signal-loss' && sc.equipmentId === id && sc.end != null && sc.end <= s.minute && sc.start < to && sc.end > p.from)
    .map((sc) => ({ from: Math.max(sc.start, p.from), to: Math.min(sc.end!, to) }))
    .filter((g) => g.to > g.from)
    .sort((a, b) => a.from - b.from);
}

const clockOf = (t: number, now: number) => (Math.floor(t / 1440) === Math.floor(now / 1440) ? formatClock(t) : formatDateTime(t));

const close = (a: number, b: number, abs: number) => Math.abs(a - b) <= Math.max(abs, REL_TOL * Math.max(Math.abs(a), Math.abs(b)));
const sign = (v: number) => `${v >= 0 ? '+' : '−'}${n1.format(Math.abs(v))}`;

/**
 * The ten checks of §10 plus the freshness of the constraint's data feed (11), each pass / attention /
 * not applicable with the evidence behind it.
 */
export function evaluateIntegrity(x: IntegrityInputs): IntegrityCheck[] {
  const k = x.kiln;
  const out: IntegrityCheck[] = [];
  const add = (key: string, title: string, status: CheckStatus, evidence: string) => out.push({ n: out.length + 1, key, title, status, evidence });
  const ideal = x.kilnIdealPerHour;

  // 1. Availability ≤ 100 %.
  {
    const title = 'Availability does not exceed 100 %';
    if (k.planned <= 0) add('availability', title, 'na', 'No planned production time at the kiln in this period yet.');
    else {
      const a = k.operating / k.planned;
      const m = x.oee.availability;
      const shown = m.status === 'ok' ? m.value! : null;
      if (a > 1 + REL_TOL)
        add('availability', title, 'attention', `Operating ${minS(k.operating)} exceeds planned ${minS(k.planned)} (${pctS(a)}): ${m.status === 'invalid' ? 'reported as invalid, not shown as a number' : 'check the time accounting'}.`);
      else if (shown == null || Math.abs(shown - a) > 1e-9) add('availability', title, 'attention', `Computed ${pctS(a)} from ${minS(k.operating)} ÷ ${minS(k.planned)}, but the displayed availability is ${shown == null ? m.status : pctS(shown)}.`);
      else add('availability', title, 'pass', `Kiln operating ${minS(k.operating)} ÷ planned ${minS(k.planned)} = ${pctS(a)} — within 100 %.`);
    }
  }

  // 2. Performance is not capped: the shown value is the raw ratio.
  {
    const title = 'Performance is not capped (raw value shown)';
    const m = x.oee.performance;
    if (!ideal || ideal <= 0) add('performance', title, 'attention', 'No ideal rate is configured for the kiln, so performance cannot be computed — it is not replaced with an assumed value.');
    else if (k.operating <= 0) add('performance', title, 'na', 'The kiln did not operate in this period.');
    else {
      const raw = ((60 / ideal) * k.count) / k.operating;
      if (raw > 1 + REL_TOL)
        add(
          'performance',
          title,
          'attention',
          `Raw performance ${pctS(raw)} (${tiles(k.count)} in ${minS(k.operating)} at ${n0.format(ideal)} tiles/h) exceeds the ideal rate — ${m.status === 'invalid' ? 'reported as invalid instead of being capped at 100 %' : 'shown without a flag'}; check the ideal cycle time or the counter.`,
        );
      else if (m.status !== 'ok' || Math.abs(m.value! - raw) > 1e-9)
        add('performance', title, 'attention', `Raw ${pctS(raw)} but displayed ${m.status === 'ok' ? pctS(m.value) : m.status} — the shown value is not the raw ratio.`);
      else add('performance', title, 'pass', `Raw ratio ${pctS(raw, 2)} = ideal cycle ${(3600 / ideal).toFixed(2)} s × ${tiles(k.count)} ÷ ${minS(k.operating)}, shown unrounded in the calculation; values above 100 % would be flagged invalid, never capped.`);
    }
  }

  // 3. Quality uses compatible good and total counts at the same counting point.
  {
    const title = 'Quality counts are compatible (same boundary)';
    const qd = x.quality;
    if (qd.inspected <= 0) add('quality', title, 'na', 'No tiles have been inspected in this period yet.');
    else {
      const issues: string[] = [];
      if (!close(qd.accepted + qd.rejected, qd.inspected, TILE_TOL)) issues.push(`good ${tiles(qd.accepted)} + rejected ${tiles(qd.rejected)} ≠ inspected ${tiles(qd.inspected)}`);
      if (qd.accepted > qd.inspected * (1 + REL_TOL)) issues.push('good exceeds inspected');
      if (!close(qd.sorterCount, qd.inspected, TILE_TOL)) issues.push(`inspected ${tiles(qd.inspected)} ≠ sorter count ${tiles(qd.sorterCount)}`);
      const m = x.oee.quality;
      const q = qd.accepted / qd.inspected;
      if (m.status !== 'ok' || Math.abs(m.value! - q) > 1e-9) issues.push(`displayed quality ${m.status === 'ok' ? pctS(m.value) : m.status} ≠ good ÷ inspected ${pctS(q)}`);
      if (issues.length) add('quality', title, 'attention', `${issues.join('; ')}.`);
      else
        add(
          'quality',
          title,
          'pass',
          `Good ${tiles(qd.accepted)} + rejected ${tiles(qd.rejected)} = ${tiles(qd.inspected)} inspected at sorting, the same counting point as the sorter (${tiles(qd.sorterCount)}); quality = ${pctS(q)}.`,
        );
    }
  }

  // 4. Same time scope, equipment scope and production boundary.
  {
    const title = 'Components share time scope, equipment scope and boundary';
    const calendar = k.planned + k.plannedStop;
    const r = x.chain.residuals.firedVsSorted;
    const dK = x.chain.wip.kilnOutfeed;
    if (x.periodMin <= 0) add('scope', title, 'na', 'The period has not started yet.');
    else if (!close(calendar, x.periodMin, MIN_TOL)) add('scope', title, 'attention', `Kiln time accounting covers ${minS(calendar)} but the period has ${minS(x.periodMin)} — A and P would not describe the same window.`);
    else if (r == null || dK == null) add('scope', title, 'attention', 'The kiln outfeed buffer level at the period start is not recorded, so the difference between tiles fired (P) and tiles inspected (Q) cannot be explained.');
    else if (Math.abs(r) > TILE_TOL) add('scope', title, 'attention', `Fired − sorted − Δ kiln outfeed = ${sign(r)} tiles: the boundary between the kiln (A, P) and sorting (Q) does not reconcile.`);
    else
      add(
        'scope',
        title,
        'pass',
        `A and P: H-KILN over ${minS(calendar)} (= the period); Q: sorting over the same hours. Two points of one line: ${tiles(x.chain.fired)} fired vs ${tiles(x.chain.sorted)} inspected, the difference is the kiln outfeed buffer (${sign(dK)} tiles).`,
      );
  }

  // 5. Ideal cycle times are defined per asset — no arbitrary fallback.
  {
    const title = 'Ideal cycle time defined per asset (no fallback)';
    const missing = Object.entries(x.idealRates).filter(([, v]) => v == null || !(v > 0)).map(([id]) => id);
    const n = Object.keys(x.idealRates).length;
    if (!ideal || missing.length)
      add('ideal', title, 'attention', `Missing ideal rate: ${[...(!ideal ? [KILN] : []), ...missing].filter((v, i, a) => a.indexOf(v) === i).join(', ')} — OEE is unavailable for these instead of using an assumed value.`);
    else add('ideal', title, 'pass', `Kiln design rate ${n0.format(ideal)} tiles/h (ideal cycle ${(3600 / ideal).toFixed(2)} s); all ${n} process machines have their own configured rate. Conveyors have none and show no OEE.`);
  }

  // 6. Planned downtime policy.
  {
    const title = 'Planned downtime policy applied consistently';
    const policy = 'Policy: planned kiln stops are excluded from planned production time and from the plan; they are not a loss.';
    if (x.periodMin <= 0) add('planned', title, 'na', `${policy} The period has not started yet.`);
    else {
      const expectPlanned = x.periodMin - Math.min(x.periodMin, k.plannedStop);
      const expectPlan = (x.planPerHour * expectPlanned) / 60;
      const issues: string[] = [];
      if (!close(k.planned, expectPlanned, MIN_TOL)) issues.push(`planned time ${minS(k.planned)} ≠ calendar − planned stops ${minS(expectPlanned)}`);
      if (!close(x.planTiles, expectPlan, TILE_TOL)) issues.push(`plan ${tiles(x.planTiles)} ≠ ${n0.format(x.planPerHour)}/h × ${minS(expectPlanned)} = ${tiles(expectPlan)}`);
      if (!close(x.records.plannedMin, k.plannedStop, MIN_TOL)) issues.push(`planned-stop records ${minS(x.records.plannedMin)} ≠ planned stop time ${minS(k.plannedStop)}`);
      if (issues.length) add('planned', title, 'attention', `${policy} ${issues.join('; ')}.`);
      else
        add(
          'planned',
          title,
          'pass',
          `${policy} ${minS(k.plannedStop)} planned at the kiln → planned time ${minS(k.planned)}; plan ${tiles(x.planTiles)} = ${n0.format(x.planPerHour)} good tiles per planned hour.`,
        );
    }
  }

  // 7. No double counting of rejects, good and finished units.
  {
    const title = 'No double counting of rejects, good and finished tiles';
    const qd = x.quality;
    const c = x.chain;
    const qualityStep = x.capacity.steps.find((s) => s.key === 'quality');
    if (qd.inspected <= 0 && c.packed <= 0) add('double', title, 'na', 'Nothing was inspected or packed in this period yet.');
    else {
      const issues: string[] = [];
      if (!close(qd.byDefectSum, qd.rejected, TILE_TOL)) issues.push(`Σ defect categories ${tiles(qd.byDefectSum)} ≠ rejected ${tiles(qd.rejected)}`);
      if (c.residuals.goodVsPacked == null) issues.push('accumulation buffer level at the period start not recorded');
      else if (Math.abs(c.residuals.goodVsPacked) > TILE_TOL) issues.push(`good − packed − Δ accumulation = ${sign(c.residuals.goodVsPacked)} tiles (packing would be counting tiles other than good ones)`);
      if (qualityStep && !close(qualityStep.m2, qd.rejected * M2_PER_TILE, M2_TOL)) issues.push(`quality loss ${n1.format(qualityStep.m2)} m² ≠ rejected ${n1.format(qd.rejected * M2_PER_TILE)} m²`);
      if (issues.length) add('double', title, 'attention', `${issues.join('; ')}.`);
      else
        add(
          'double',
          title,
          'pass',
          `Each rejected tile has one defect category (Σ = ${tiles(qd.rejected)}); good = inspected − rejected; sorting passes only accepted tiles, so packing (${tiles(c.packed)}) counts good output plus the accumulation-buffer change; rejects enter the losses once, as the quality step.`,
        );
    }
  }

  // 8. Shift (period) totals reconcile with the hour buckets and the event records.
  {
    const title = 'Period totals reconcile with hour buckets and stop records';
    if (x.hourly.hours <= 0) add('totals', title, 'na', 'No hour of this period has been simulated yet.');
    else {
      const issues: string[] = [];
      if (!close(x.hourly.good, x.totals.good, TILE_TOL)) issues.push(`Σ hourly good ${tiles(x.hourly.good)} ≠ period ${tiles(x.totals.good)}`);
      if (!close(x.hourly.plan, x.totals.plan, TILE_TOL)) issues.push(`Σ hourly plan ${tiles(x.hourly.plan)} ≠ period plan ${tiles(x.totals.plan)}`);
      if (!close(x.hourly.rejects, x.totals.rejects, TILE_TOL)) issues.push(`Σ hourly rejects ${tiles(x.hourly.rejects)} ≠ period ${tiles(x.totals.rejects)}`);
      if (!close(x.records.unplannedMin, k.down, MIN_TOL)) issues.push(`kiln stop records ${minS(x.records.unplannedMin)} ≠ kiln down time ${minS(k.down)}`);
      if (issues.length) add('totals', title, 'attention', `${issues.join('; ')}.`);
      else
        add(
          'totals',
          title,
          'pass',
          `${x.hourly.hours} hour buckets add up to the period: good ${tiles(x.totals.good)}, plan ${tiles(x.totals.plan)}, rejects ${tiles(x.totals.rejects)}; kiln stop records ${minS(x.records.unplannedMin)} = kiln down time ${minS(k.down)}.`,
        );
    }
  }

  // 9. Losses reconcile with the baseline (capacity closes to good output; the OEE loss tree closes).
  {
    const title = 'Losses reconcile with capacity and planned time';
    const cap = x.capacity;
    if (cap.theoreticalM2 <= 0) add('losses', title, 'na', 'No production time in this period yet.');
    else {
      const sum = cap.steps.reduce((a, s) => a + s.m2, 0);
      const residual = cap.theoreticalM2 - sum - cap.goodM2;
      const t = x.tree;
      const treeResidual = t ? t.planned - t.availabilityLoss - t.performanceLoss - t.qualityLoss - t.fullyProductive : null;
      const oeeOk = x.oee.oee.status === 'ok';
      const treeOee = t && t.planned > 0 ? t.fullyProductive / t.planned : null;
      const issues: string[] = [];
      if (Math.abs(residual) > M2_TOL) issues.push(`capacity steps leave ${sign(residual)} m² unexplained`);
      if (treeResidual != null && Math.abs(treeResidual) > 0.05) issues.push(`OEE loss tree leaves ${sign(treeResidual)} min unexplained`);
      if (oeeOk && treeOee != null && Math.abs(treeOee - x.oee.oee.value!) > 1e-6) issues.push(`fully productive ÷ planned ${pctS(treeOee)} ≠ OEE ${pctS(x.oee.oee.value)}`);
      if (issues.length) add('losses', title, 'attention', `${issues.join('; ')}.`);
      else {
        const loss = cap.steps.filter((s) => s.kind === 'loss').reduce((a, s) => a + s.m2, 0);
        const transit = cap.steps.filter((s) => s.kind === 'transit').reduce((a, s) => a + s.m2, 0);
        add(
          'losses',
          title,
          'pass',
          `Theoretical ${n0.format(cap.theoreticalM2)} m² − losses ${n0.format(loss)} m² − in transit ${sign(transit)} m² = good ${n0.format(cap.goodM2)} m² (residual ${n1.format(residual)} m²)${t ? `; planned ${minS(t.planned)} − availability, performance and quality losses = ${minS(t.fullyProductive)} fully productive = OEE × planned` : ''}.`,
        );
      }
    }
  }

  // 10. Financial impacts show their assumptions and are not presented as savings.
  {
    const title = 'Financial estimates show their assumptions';
    const f = x.finance;
    const contrib = contributionPerM2(f);
    const nums = [f.sellingPricePerM2, f.variableCostPerM2, f.scrapCostPerM2, f.reworkCostPerM2, f.truckWaitCostPerHour];
    const issues: string[] = [];
    if (nums.some((v) => !Number.isFinite(v) || v < 0)) issues.push('a price or cost is negative or not a number');
    if (!(f.soldOutShare >= 0 && f.soldOutShare <= 1) || !(f.reworkShare >= 0 && f.reworkShare <= 1)) issues.push('a share is outside 0–100 %');
    if (contrib <= 0) issues.push(`contribution ${money(f.currency, contrib)}/m² is not positive, so lost output has no positive value under these assumptions`);
    if (issues.length) add('finance', title, 'attention', `${issues.join('; ')}. Every money figure is labelled an estimate with its basis.`);
    else
      add(
        'finance',
        title,
        'pass',
        `Every money figure is labelled an estimate with its basis: contribution ${money(f.currency, contrib)}/m² (price ${money(f.currency, f.sellingPricePerM2)} − variable cost ${money(f.currency, f.variableCostPerM2)}) × ${pctS(f.soldOutShare, 0)} sold-out share; rejects ${pctS(1 - f.reworkShare, 0)} scrapped at ${money(f.currency, f.scrapCostPerM2)}/m², ${pctS(f.reworkShare, 0)} reworked at ${money(f.currency, f.reworkCostPerM2)}/m². Estimates, never savings.`,
      );
  }

  // 11. The constraint's data feed updated for the whole period (A and P rest on counts the feed confirmed).
  {
    const title = 'Constraint data fresh for the whole period';
    const cf = x.constraintFeed;
    const at = (t: number) => clockOf(t, cf.now);
    if (x.periodMin <= 0) add('fresh', title, 'na', 'The period has not started yet.');
    else if (cf.staleSince != null)
      add(
        'fresh',
        title,
        'attention',
        `The ${KILN} data feed has not updated since ${at(cf.staleSince)}: availability and performance after that minute rest on simulated values the feed has not confirmed. Line OEE and downtime affecting output are marked stale (not confirmed), not adjusted.`,
      );
    else if (cf.gaps.length) {
      const min = cf.gaps.reduce((a, g) => a + g.to - g.from, 0);
      add(
        'fresh',
        title,
        'attention',
        `The ${KILN} data feed was stale ${cf.gaps.map((g) => `${at(g.from)}–${at(g.to)}`).join(', ')} in this period (${minS(min)}); it is updating again, but the kiln's state in those minutes was not observed by the feed.`,
      );
    } else add('fresh', title, 'pass', `The ${KILN} data feed updated in every minute of the period: no stale or frozen counter behind availability and performance (simulated feed).`);
  }

  return out;
}

/** Convenience: the checks for a period of the simulation. */
export const integrityChecks = (s: SimState, p: Period, f: FinanceAssumptions) => evaluateIntegrity(integrityInputs(s, p, f));

// ── Count reconciliation chain ───────────────────────────────────────────────

export type ChainStep = { key: string; label: string; point: string; value: number; note?: string };
export type ChainLink = { key: string; text: string; delta: number | null; residual: number | null; kind: 'buffer' | 'same' | 'reject' };

/**
 * The count chain fired → sorted → inspected (rejected) → good → packed → palletised with the
 * buffer change explaining each difference and the residual left over (≈ 0 when the counts reconcile).
 */
export function reconciliationView(c: CountChain) {
  const steps: ChainStep[] = [
    { key: 'fired', label: 'Fired at the kiln', point: 'H-KILN.count_total', value: c.fired },
    { key: 'sorted', label: 'Sorted', point: 'I-SORT.count_total', value: c.sorted },
    { key: 'inspected', label: 'Inspected (gauge + vision)', point: 'I-VIS.count_inspected', value: c.inspected, note: `${n0.format(c.rejected)} rejected` },
    { key: 'good', label: 'Good (first-quality accepted)', point: 'I-SORT.count_good', value: c.good },
    { key: 'packed', label: 'Packed', point: 'J-BOX.count_total', value: c.packed },
    { key: 'palletised', label: 'Palletised', point: 'J-PAL.count_total', value: c.palletised, note: `${n1.format(c.pallets)} pallets` },
  ];
  const links: ChainLink[] = [
    { key: 'kout', kind: 'buffer', text: 'Kiln outfeed buffer change (fired, not yet sorted)', delta: c.wip.kilnOutfeed, residual: c.residuals.firedVsSorted },
    { key: 'same', kind: 'same', text: 'Same tiles: every sorted tile passes both inspection stations', delta: null, residual: c.residuals.sortedVsInspected },
    { key: 'rej', kind: 'reject', text: 'Rejected tiles leave the line at sorting', delta: -c.rejected, residual: c.inspected - c.rejected - c.good },
    { key: 'acc', kind: 'buffer', text: 'Accumulation buffer change (accepted, not yet packed)', delta: c.wip.accumulation, residual: c.residuals.goodVsPacked },
    { key: 'ctn', kind: 'buffer', text: 'Carton transfer change (packed, not yet palletised)', delta: c.wip.cartonTransfer, residual: c.residuals.packedVsPalletised },
  ];
  const unknown = links.some((l) => l.residual == null);
  const worst = Math.max(0, ...links.map((l) => Math.abs(l.residual ?? 0)));
  return { steps, links, reconciles: !unknown && worst <= TILE_TOL, unknown, worst };
}
