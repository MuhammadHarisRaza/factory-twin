/**
 * OEE & Loss Intelligence — pure derivations for the factory view: the capacity ledger at the
 * line constraint, where its losses come from, what they are worth (estimates) and what-if gains.
 *
 * One rule runs through everything here: a lost unit of output is counted ONCE, at the line
 * constraint (the kiln, H-KILN). Time lost elsewhere costs line output only for the minutes it
 * held up the kiln (from the event engine's per-minute constraint accounting), so machine-level
 * losses are never summed into the line loss. Money is always an estimate from the editable
 * financial assumptions (src/sim/finance.ts): lost good output at contribution margin × sold-out
 * share, rejects at scrap / rework cost — never theoretical capacity × price.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { BASE_REJECT_RATE, CONVEYOR_BY_ID, DEFECTS, DEFECT_ORDER, M2_PER_TILE, REASON_BY_CODE, STAGE_BY_ID, TARGET } from '../../model/plant';
import type { DefectCategory, OpEvent } from '../../model/types';
import { findDowntime, type SimState } from '../../sim/engine';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import type { Tariffs } from '../../sim/energy';
import { contributionPerM2, lostOutputValue, rejectCost, waitingCost, type FinanceAssumptions, type MoneyLine } from '../../sim/finance';
import {
  HELD_UP_SHARE,
  TARGET_STATUS_LABEL,
  bottleneck,
  capacityBreakdown,
  clippedDuration,
  downtimeIn,
  downtimePareto,
  energyIn,
  impactVsBaseline,
  lineMetrics,
  machineMetrics,
  qualityIn,
  sumBuckets,
  targetStatus,
  type LineMetrics,
  type ParetoRow,
  type Period,
  type PeriodKey,
} from '../../sim/metrics';
import { SHIFT_MIN } from '../../sim/time';

export const KILN = 'H-KILN';
const M2 = M2_PER_TILE;
const eqName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;
const overlap = (start: number, end: number, p: Period) => Math.max(0, Math.min(end, p.to) - Math.max(start, p.from));

// ── Formatting (shared by the views; plain strings so the answers stay testable) ──

const n0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const n2 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "USD 1,234" (≥ 100) or "USD 12.40"; a leading "−" for negative values. */
export const fmtMoney = (v: number | null | undefined, currency: string) =>
  v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}${currency} ${Math.abs(v) >= 100 ? n0.format(Math.abs(v)) : n2.format(Math.abs(v))}`;
const m2s = (v: number) => `${n0.format(Math.round(v))} m²`;
const pctS = (f: number | null | undefined, d = 0) => (f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(d)} %`);
const minS = (v: number) => `${n0.format(Math.round(v))} min`;

// ── Constraint attribution ────────────────────────────────────────────────────

export type CauseReason = { code: string | null; label: string; minutes: number };
export type ConstraintCause = {
  equipmentId: string;
  name: string;
  /** Kiln minutes held up (starved / blocked) by this asset's root events in the period (pro-rated). */
  minutes: number;
  /** Root events, most minutes first. */
  eventIds: string[];
  reasons: CauseReason[];
  /** Last minute one of its root events was active (the current minute while one is open). */
  lastActive: number;
};

export type ConstraintAttribution = {
  plannedMin: number;
  plannedStopMin: number;
  operatingMin: number;
  /** Kiln's own unplanned downtime. */
  downMin: number;
  starvedMin: number;
  blockedMin: number;
  /** starved + blocked: kiln waiting on other stages. */
  heldMin: number;
  causes: ConstraintCause[];
  attributedMin: number;
  /** Held-up minutes no recorded root event explains. */
  unattributedMin: number;
  /** Kiln's own stops by reason (clipped to the period). */
  kilnReasons: ParetoRow[];
};

function rootReason(s: SimState, ev: OpEvent): { code: string | null; label: string } {
  if (ev.refs.downtimeId) {
    const d = findDowntime(s, ev.refs.downtimeId);
    if (d) return { code: d.reasonCode, label: REASON_BY_CODE[d.reasonCode]?.label ?? d.reasonCode };
  }
  return { code: null, label: ev.type === 'below-rate' ? 'Running below rate' : EVENT_TYPE_LABEL[ev.type] };
}

/**
 * Which assets held the kiln up in the period. The event engine charges every minute the kiln is
 * starved or blocked to the root event that explains it (a stopped conveyor, a press below rate…);
 * those minutes are summed per asset here, pro-rated when an event straddles the period start, and
 * capped at the kiln's held-up minutes so nothing is counted twice.
 */
export function constraintAttribution(s: SimState, p: Period): ConstraintAttribution {
  const k = sumBuckets(s, KILN, p);
  const heldMin = k.starved + k.blocked;
  type Acc = { minutes: number; events: { id: string; m: number }[]; reasons: Map<string, CauseReason>; last: number };
  const acc = new Map<string, Acc>();
  let raw = 0;
  for (const ev of s.events) {
    const eq = ev.asset.equipmentId;
    if (!eq || eq === KILN || ev.consequenceOf || ev.acc.constraintMin <= 0) continue;
    const end = ev.end ?? s.minute;
    const ov = overlap(ev.start, end, p);
    if (ov <= 0) continue;
    const m = ev.acc.constraintMin * Math.min(1, ov / Math.max(1, end - ev.start));
    if (m <= 0) continue;
    raw += m;
    const a: Acc = acc.get(eq) ?? { minutes: 0, events: [], reasons: new Map(), last: 0 };
    a.minutes += m;
    a.last = Math.max(a.last, Math.min(end, p.to));
    a.events.push({ id: ev.id, m });
    const r = rootReason(s, ev);
    const rk = r.code ?? r.label;
    const row = a.reasons.get(rk) ?? { code: r.code, label: r.label, minutes: 0 };
    row.minutes += m;
    a.reasons.set(rk, row);
    acc.set(eq, a);
  }
  const scale = raw > heldMin && raw > 0 ? heldMin / raw : 1;
  const causes: ConstraintCause[] = [...acc.entries()]
    .map(([equipmentId, a]) => ({
      equipmentId,
      name: eqName(equipmentId),
      minutes: a.minutes * scale,
      eventIds: a.events.sort((x, y) => y.m - x.m).map((e) => e.id),
      reasons: [...a.reasons.values()].map((r) => ({ ...r, minutes: r.minutes * scale })).sort((x, y) => y.minutes - x.minutes),
      lastActive: a.last,
    }))
    .sort((a, b) => b.minutes - a.minutes);
  const attributedMin = raw * scale;
  return {
    plannedMin: k.planned,
    plannedStopMin: k.plannedStop,
    operatingMin: k.operating,
    downMin: k.down,
    starvedMin: k.starved,
    blockedMin: k.blocked,
    heldMin,
    causes,
    attributedMin,
    unattributedMin: Math.max(0, heldMin - attributedMin),
    kilnReasons: downtimePareto(s, p, { equipmentId: KILN }),
  };
}

// ── Loss ledger (capacity at the constraint + cost categories) ────────────────

export type LossKey = 'planned' | 'downtime' | 'constraint' | 'speed' | 'quality' | 'transit' | 'energy' | 'logistics';

export type LossRow = {
  key: LossKey;
  label: string;
  /** 'output' = lost line output at the constraint (in the m² total); 'cost' = money only; 'other' = neither. */
  kind: 'output' | 'cost' | 'other';
  /** Output at the constraint, m² of tile (null = not an output quantity). */
  m2: number | null;
  /** Kiln / truck minutes behind the figure, where meaningful. */
  minutes: number | null;
  /** Estimated value (null = deliberately not valued). */
  money: number | null;
  lines: MoneyLine[];
  /** How the quantity is measured. */
  basis: string;
  /** How (or why not) it is valued. */
  valuation: string;
};

export type LossLedger = {
  period: Period;
  lm: LineMetrics;
  /** The core capacity comparison (src/sim/metrics.ts) this ledger splits further. */
  cap: CapacityBreakdown;
  calendarMin: number;
  idealPerHour: number;
  /** First-pass yield at sorting in the period (null when nothing was sorted). */
  fpy: number | null;
  /** FPY used to convert lost kiln tiles into lost good tiles (the period's, else the baseline yield). */
  fpyUsed: number;
  theoreticalM2: number;
  /** The production plan (target) for the period. */
  plannedM2: number;
  /** Tiles fired at the kiln. */
  actualM2: number;
  sortedM2: number;
  goodM2: number;
  /** Theoretical − good. */
  capacityGapM2: number;
  /** Plan − good (negative = ahead of plan). */
  planGapM2: number;
  /** Theoretical − plan: what the plan allows for normal losses. */
  allowanceM2: number;
  /** Good ÷ theoretical. */
  utilisation: number | null;
  downM2: number;
  constraintM2: number;
  speedM2: number;
  qualityM2: number;
  plannedStopM2: number;
  transitM2: number;
  rows: LossRow[];
  /** Sum of the output categories (downtime, constraint, speed, quality), m². */
  outputLossM2: number;
  outputMoney: number;
  totalMoney: number;
  energyExcessKwh: number;
  truckWaitMin: number;
  attribution: ConstraintAttribution;
  /**
   * Estimated financial impact against the plan: the shortfall of good output valued at contribution,
   * plus the direct costs of the period (reject scrap / rework, energy above the model, truck detention).
   * Losses vs the design rate are deliberately not in it — theoretical capacity is not revenue.
   * shortfallM2 is the gap to plan (as attainment shows it); valuedShortfallM2 is the part valued at
   * contribution — reworked rejects are recovered output, charged at rework cost only (never twice).
   */
  impact: { lines: MoneyLine[]; total: number; shortfallM2: number; valuedShortfallM2: number };
  assumptions: string[];
  missing: string[];
};

export type CapacityBreakdown = ReturnType<typeof capacityBreakdown>;

/** Rejects valued once: scrapped share at sunk cost + its lost sale (contribution), reworked share at rework cost. */
export function qualityLossValue(f: FinanceAssumptions, rejectTiles: number): MoneyLine[] {
  const sale = lostOutputValue(f, rejectTiles * (1 - f.reworkShare));
  return [...rejectCost(f, rejectTiles), { label: 'Lost sale of scrapped tiles (contribution)', amount: sale.amount, basis: sale.basis }];
}

const total = (lines: MoneyLine[]) => lines.reduce((a, l) => a + l.amount, 0);

/**
 * The loss ledger of a period. Its totals are the core capacityBreakdown (theoretical → plan →
 * fired → good); the availability loss is split into the kiln's own downtime and the minutes it was
 * held up by other stages, and the quality step into rejects and tiles still between kiln and sorting.
 */
export function lossLedger(s: SimState, p: Period, f: FinanceAssumptions, tariffs: Tariffs): LossLedger {
  const cap = capacityBreakdown(s, p);
  const lm = lineMetrics(s, p);
  const k = lm.constraint.totals;
  const idealPerHour = lm.constraint.idealRatePerHour;
  const ideal = idealPerHour / 60;
  const calendarMin = cap.calendarMin;
  const fpy = lm.inspected > 0 ? lm.good / lm.inspected : null;
  const fpyUsed = fpy ?? 1 - BASE_REJECT_RATE;
  const att = constraintAttribution(s, p);
  const capLoss = (key: string) => cap.losses.find((l) => l.key === key)?.m2 ?? 0;

  const availTiles = capLoss('availability') / M2;
  const heldTiles = Math.min(availTiles, ideal * (k.starved + k.blocked));
  const downTiles = availTiles - heldTiles;
  const speedTiles = capLoss('speed') / M2;
  const plannedStopTiles = capLoss('planned') / M2;
  const transitTiles = k.count - lm.inspected;

  const theoreticalM2 = cap.theoreticalM2;
  const goodM2 = cap.goodM2;
  const rate = `design rate ${n0.format(idealPerHour)} tiles/h`;
  const cur = f.currency;
  const contrib = `contribution ${fmtMoney(contributionPerM2(f), cur)}/m² × FPY ${pctS(fpyUsed, 1)} × ${pctS(f.soldOutShare)} sold-out share`;

  const downLine = lostOutputValue(f, downTiles * fpyUsed);
  const heldLine = lostOutputValue(f, heldTiles * fpyUsed);
  const speedLine = lostOutputValue(f, speedTiles * fpyUsed);
  const qualityLines = qualityLossValue(f, lm.rejected);

  const topCause = att.causes[0];
  const e = energyIn(s, p, tariffs);
  let energyExcessKwh = 0;
  let energyExcessCost = 0;
  let above = 0;
  for (const r of e.rows) {
    const c = r.cost - r.expectedCost;
    if (c <= 0.005) continue;
    above++;
    energyExcessCost += c;
    energyExcessKwh += Math.max(0, r.total - r.expected);
  }

  let truckWaitMin = 0;
  let trucks = 0;
  for (const ev of s.events) {
    if (ev.type !== 'truck-waiting') continue;
    const end = ev.end ?? s.minute;
    const m = overlap(end - ev.acc.waitMin, end, p);
    if (m <= 0) continue;
    truckWaitMin += m;
    trucks++;
  }
  const waitLine = waitingCost(f, truckWaitMin);

  const rows: LossRow[] = [
    {
      key: 'planned',
      label: 'Planned stops',
      kind: 'other',
      m2: plannedStopTiles * M2,
      minutes: k.plannedStop,
      money: null,
      lines: [],
      basis: `${minS(k.plannedStop)} of planned stops at the kiln × ${rate}`,
      valuation: 'Not valued — planned stops are part of the plan, not a loss',
    },
    {
      key: 'downtime',
      label: 'Downtime at the constraint',
      kind: 'output',
      m2: downTiles * M2,
      minutes: k.down,
      money: downLine.amount,
      lines: [downLine],
      basis: `${minS(k.down)} the kiln itself was stopped (unplanned) × ${rate}${att.kilnReasons[0] ? ` · largest: ${att.kilnReasons[0].label.toLowerCase()}` : ''}`,
      valuation: `Lost good output: m² × ${contrib}`,
    },
    {
      key: 'constraint',
      label: 'Constraint held up (starved / blocked)',
      kind: 'output',
      m2: heldTiles * M2,
      minutes: att.heldMin,
      money: heldLine.amount,
      lines: [heldLine],
      basis: `${minS(k.starved)} starved + ${minS(k.blocked)} blocked at the kiln, waiting on other stages, × ${rate}${topCause ? ` · largest cause: ${topCause.equipmentId} (${minS(topCause.minutes)})` : ''}`,
      valuation: `Lost good output: m² × ${contrib}. Stops elsewhere are valued only through these kiln minutes`,
    },
    {
      key: 'speed',
      label: 'Speed loss at the constraint',
      kind: 'output',
      m2: speedTiles * M2,
      minutes: null,
      money: speedLine.amount,
      lines: [speedLine],
      basis: `Kiln fired ${n0.format(k.count)} tiles in ${minS(k.operating)} of operating time vs ${n0.format(ideal * k.operating)} at ${rate}`,
      valuation: `Lost good output: m² × ${contrib}`,
    },
    {
      key: 'quality',
      label: 'Quality loss (rejects)',
      kind: 'output',
      m2: lm.rejected * M2,
      minutes: null,
      money: total(qualityLines),
      lines: qualityLines,
      basis: `${n0.format(lm.rejected)} of ${n0.format(lm.inspected)} sorted tiles rejected at gauge & vision (first-pass yield ${pctS(fpy, 1)})`,
      valuation: `Scrapped ${pctS(1 - f.reworkShare)}: sunk cost ${fmtMoney(f.scrapCostPerM2, cur)}/m² + lost contribution; reworked ${pctS(f.reworkShare)}: ${fmtMoney(f.reworkCostPerM2, cur)}/m²`,
    },
    {
      key: 'transit',
      label: transitTiles >= 0 ? 'Fired, not yet sorted' : 'Sorted from the kiln outfeed buffer',
      kind: 'other',
      m2: transitTiles * M2,
      minutes: null,
      money: null,
      lines: [],
      basis: `Tiles fired − tiles sorted in the period: work in progress between kiln and sorting at the period boundaries`,
      valuation: 'Not a loss — still in process',
    },
    {
      key: 'energy',
      label: 'Energy above the model',
      kind: 'cost',
      m2: null,
      minutes: null,
      money: energyExcessCost,
      lines: [{ label: 'Energy above the model', amount: energyExcessCost, basis: `${n0.format(energyExcessKwh)} kWh at the configured tariffs` }],
      basis: `${above} of ${e.rows.length} metered consumers above the illustrative energy model: ${n0.format(energyExcessKwh)} kWh`,
      valuation: `At the configured tariffs (electricity ${tariffs.currency} ${tariffs.electricity}/kWh, gas ${tariffs.currency} ${tariffs.gas}/kWh) — a cost, not lost output`,
    },
    {
      key: 'logistics',
      label: 'Truck waiting (logistics delay)',
      kind: 'cost',
      m2: null,
      minutes: truckWaitMin,
      money: waitLine.amount,
      lines: [waitLine],
      basis: `${trucks} truck-waiting event${trucks === 1 ? '' : 's'}: ${minS(truckWaitMin)} beyond the ${s.rules.truckWaitMax}-min threshold inside the period`,
      valuation: `× ${fmtMoney(f.truckWaitCostPerHour, cur)}/h detention — a cost, not lost output (dispatch does not limit the line)`,
    },
  ];

  const outputRows = rows.filter((r) => r.kind === 'output');
  const outputLossM2 = outputRows.reduce((a, r) => a + (r.m2 ?? 0), 0);
  const outputMoney = outputRows.reduce((a, r) => a + (r.money ?? 0), 0);
  const totalMoney = rows.reduce((a, r) => a + (r.money ?? 0), 0);

  // Financial impact vs the plan: shortfall of good output (already good tiles — no FPY) + direct costs.
  // Reworked rejects are regraded and sold: recovered output, charged at rework cost (rejectCost) only,
  // so the contribution is valued on the shortfall of good + reworked output, not on the plan gap.
  const shortfallM2 = Math.max(0, cap.planGapM2);
  const reworkedM2 = lm.rejected * f.reworkShare * M2;
  const valuedShortfallM2 = Math.max(0, cap.plannedM2 - (cap.goodM2 + reworkedM2));
  const shortLine = lostOutputValue(f, valuedShortfallM2 / M2);
  const recovered = shortfallM2 - valuedShortfallM2;
  const shortBasis =
    shortfallM2 <= 0
      ? 'Good output at or above plan — no shortfall'
      : valuedShortfallM2 <= 0
        ? `${m2s(shortfallM2)} short of plan, all covered by ${m2s(reworkedM2)} of reworked rejects (recovered output, charged at rework cost only)`
        : `${shortLine.basis}${recovered > 0.05 ? ` · ${m2s(shortfallM2)} short of plan less ${m2s(recovered)} of reworked rejects (recovered output, charged at rework cost only)` : ''}`;
  const impactLines: MoneyLine[] = [
    { label: 'Shortfall vs plan (lost contribution)', amount: shortLine.amount, basis: shortBasis },
    ...rejectCost(f, lm.rejected),
    { label: 'Energy above the model', amount: energyExcessCost, basis: `${n0.format(energyExcessKwh)} kWh above the illustrative model at the configured tariffs` },
    waitLine,
  ];

  return {
    period: p,
    lm,
    cap,
    calendarMin,
    idealPerHour,
    fpy,
    fpyUsed,
    theoreticalM2,
    plannedM2: cap.plannedM2,
    actualM2: cap.actualM2,
    sortedM2: lm.inspected * M2,
    goodM2,
    capacityGapM2: cap.capacityGapM2,
    planGapM2: cap.planGapM2,
    allowanceM2: theoreticalM2 - cap.plannedM2,
    utilisation: theoreticalM2 > 0 ? goodM2 / theoreticalM2 : null,
    downM2: downTiles * M2,
    constraintM2: heldTiles * M2,
    speedM2: speedTiles * M2,
    qualityM2: lm.rejected * M2,
    plannedStopM2: plannedStopTiles * M2,
    transitM2: transitTiles * M2,
    rows,
    outputLossM2,
    outputMoney,
    totalMoney,
    energyExcessKwh,
    truckWaitMin,
    attribution: att,
    impact: { lines: impactLines, total: total(impactLines), shortfallM2, valuedShortfallM2 },
    assumptions: [
      `Theoretical capacity = design rate of the line constraint H-KILN (${n0.format(idealPerHour)} tiles/h, ${n0.format(idealPerHour * M2)} m²/h) × ${minS(calendarMin)} of calendar time. It is a ceiling, not a target and not revenue.`,
      `Plan = ${n0.format(TARGET.goodPerHour)} good tiles per planned hour (${pctS(TARGET.oeeTarget)} OEE target); it allows ${pctS(1 - TARGET.goodPerHour / idealPerHour)} of design capacity for normal losses.`,
      'Every loss is measured once, at the kiln: time lost elsewhere counts only for the minutes it held the kiln up (event records), so machine losses are never added to it.',
      `Lost kiln tiles are converted into lost good tiles with the period's first-pass yield (${pctS(fpyUsed, 1)}${fpy == null ? ', baseline value — nothing sorted yet' : ''}).`,
      'One tile format (60×60 cm, 0.36 m²) for all products.',
      'Energy and truck detention are costs, not lost output — they are not in the m² total.',
    ],
    missing: [
      'Production orders and demand (MES / ERP not connected): the plan is the configured target rate, and the sold-out share is an assumption.',
      'Actual prices and costs per product (ERP not connected): the financial values are illustrative.',
      'Regrade / rework outcome of rejects is not measured: the rework share is an assumption.',
      'No real energy meters or tariffs: energy figures come from an illustrative model.',
      'Truck detention terms (free time, rate) are not connected: the waiting threshold and the hourly cost are assumptions.',
    ],
  };
}

/**
 * Waterfall steps in m², one axis: theoretical → planned stops → downtime → held up → speed →
 * actual (fired) → quality → in transit → good, then the capacity gap (theoretical − good).
 */
export type CapacityStep = {
  key: string;
  label: string;
  value: number;
  /** total = a level; loss = unplanned loss at the constraint; neutral = not a loss (planned stops, WIP); gap = theoretical − good. */
  kind: 'total' | 'loss' | 'neutral' | 'gap';
  basis: string;
};

export function capacitySteps(L: LossLedger): CapacityStep[] {
  const row = (k: LossKey) => L.rows.find((r) => r.key === k)!;
  const steps: CapacityStep[] = [
    { key: 'theoretical', label: 'Theoretical\ncapacity', value: L.theoreticalM2, kind: 'total', basis: L.assumptions[0] },
    { key: 'planned', label: 'Planned\nstops', value: L.plannedStopM2, kind: 'neutral', basis: `${row('planned').basis}. ${row('planned').valuation}.` },
    { key: 'downtime', label: 'Kiln\ndowntime', value: L.downM2, kind: 'loss', basis: row('downtime').basis },
    { key: 'constraint', label: 'Held up\n(flow)', value: L.constraintM2, kind: 'loss', basis: row('constraint').basis },
    { key: 'speed', label: 'Speed', value: L.speedM2, kind: 'loss', basis: row('speed').basis },
    { key: 'actual', label: 'Actual\n(fired)', value: L.actualM2, kind: 'total', basis: 'Tiles fired at the kiln (H-KILN.count_total) × 0.36 m²' },
    { key: 'quality', label: 'Quality\n(rejects)', value: L.qualityM2, kind: 'loss', basis: row('quality').basis },
  ];
  if (Math.abs(L.transitM2) >= 0.5) steps.push({ key: 'transit', label: 'In\ntransit', value: L.transitM2, kind: 'neutral', basis: `${row('transit').basis}. ${row('transit').valuation}.` });
  steps.push({ key: 'good', label: 'Good\noutput', value: L.goodM2, kind: 'total', basis: 'First-quality tiles accepted at sorting (gauge + vision) × 0.36 m²' });
  steps.push({
    key: 'gap',
    label: 'Capacity\ngap',
    value: L.capacityGapM2,
    kind: 'gap',
    basis: `Theoretical − good = planned stops + unplanned losses at the kiln${Math.abs(L.transitM2) >= 0.5 ? ' + tiles in transit' : ''}. Of it, ${m2s(L.allowanceM2)} is the allowance the plan already makes for normal losses.`,
  });
  return steps;
}

/** Appends the page's reporting period to a copilot question (the copilot reads the period from the wording). */
export function withPeriod(question: string, key: PeriodKey): string {
  const phrase: Record<PeriodKey, string> = { shift: '', 'prev-shift': ' in the previous shift', today: ' today', '24h': ' in the last 24 hours', '7d': ' this week' };
  return key === 'shift' ? question : `${question.replace(/\?\s*$/, '')}${phrase[key]}?`;
}

// ── Equipment contribution to the capacity gap ────────────────────────────────

export type Contribution = {
  key: string;
  /** null for the unattributed remainder. */
  equipmentId: string | null;
  label: string;
  m2: number;
  downtime: number;
  speed: number;
  constraint: number;
  quality: number;
  /** Kiln minutes held up by this asset (constraint part). */
  heldMin: number;
};

/**
 * Unplanned losses at the constraint charged to the asset that caused them: the kiln for its own
 * downtime and speed, the root asset for each minute it held the kiln up, and the defect's origin
 * stage for rejects (split by each machine's attributed rejects). Sums to the ledger's output loss.
 */
export function equipmentContribution(s: SimState, p: Period, L: LossLedger): Contribution[] {
  const map = new Map<string, Contribution>();
  const get = (id: string) => {
    let c = map.get(id);
    if (!c) {
      c = { key: id, equipmentId: id, label: eqName(id), m2: 0, downtime: 0, speed: 0, constraint: 0, quality: 0, heldMin: 0 };
      map.set(id, c);
    }
    return c;
  };
  const kiln = get(KILN);
  kiln.downtime = L.downM2;
  kiln.speed = L.speedM2;
  const att = L.attribution;
  for (const c of att.causes) {
    const x = get(c.equipmentId);
    x.constraint += att.heldMin > 0 ? (L.constraintM2 * c.minutes) / att.heldMin : 0;
    x.heldMin += c.minutes;
  }
  const out: Contribution[] = [];
  if (att.unattributedMin > 0.5 && att.heldMin > 0) {
    const m = (L.constraintM2 * att.unattributedMin) / att.heldMin;
    out.push({ key: '__flow', equipmentId: null, label: 'Kiln held up — no single root event recorded', m2: m, downtime: 0, speed: 0, constraint: m, quality: 0, heldMin: att.unattributedMin });
  }
  const q = qualityIn(s, p);
  for (const d of DEFECT_ORDER) {
    const tiles = q.byDefect[d] ?? 0;
    if (tiles <= 0) continue;
    const machines = STAGE_BY_ID[DEFECTS[d].origin].machines;
    const rej = machines.map((id) => machineMetrics(s, id, p).totals.rejects);
    const sum = rej.reduce((a, b) => a + b, 0);
    machines.forEach((id, i) => {
      get(id).quality += tiles * M2 * (sum > 0 ? rej[i] / sum : 1 / machines.length);
    });
  }
  for (const c of map.values()) {
    c.m2 = c.downtime + c.speed + c.constraint + c.quality;
    out.push(c);
  }
  return out.filter((c) => c.m2 >= 0.05).sort((a, b) => b.m2 - a.m2);
}

/** Short description of what an asset's contribution is made of. */
export function contributionParts(c: Contribution): string {
  const parts: string[] = [];
  if (c.downtime >= 0.5) parts.push(`own downtime ${m2s(c.downtime)}`);
  if (c.speed >= 0.5) parts.push(`speed loss ${m2s(c.speed)}`);
  if (c.constraint >= 0.5) parts.push(`held up the kiln ${minS(c.heldMin)} → ${m2s(c.constraint)}`);
  if (c.quality >= 0.5) parts.push(`rejects from its stage ${m2s(c.quality)}`);
  return parts.join(' · ') || 'below 1 m²';
}

// ── Loss investigation (answer-first) ─────────────────────────────────────────

export type InvestigationLink =
  | { kind: 'equipment'; id: string; label: string }
  | { kind: 'level'; id: 'line' | 'equipment'; label: string }
  | { kind: 'event'; id: string; label: string };

export type Answer = {
  key: 'target' | 'equipment' | 'category' | 'constraint';
  question: string;
  /** Question sent to the copilot (worded for its rule-based intents). */
  copilot: string;
  tone: 'good' | 'warning' | 'critical' | 'neutral';
  headline: string;
  detail: string[];
  links: InvestigationLink[];
};

type Bottleneck = ReturnType<typeof bottleneck>;

/** Answers the four standing loss questions from the ledger, the attribution and the traced bottleneck. */
export function investigate(L: LossLedger, contributions: Contribution[], bn: Bottleneck, f: FinanceAssumptions): Answer[] {
  const lm = L.lm;
  const status = targetStatus(lm.attainment);
  const lossShare = L.theoreticalM2 > 0 ? L.capacityGapM2 / L.theoreticalM2 : null;
  const allowShare = L.theoreticalM2 > 0 ? L.allowanceM2 / L.theoreticalM2 : null;
  const outputRows = L.rows.filter((r) => r.kind === 'output').sort((a, b) => (b.m2 ?? 0) - (a.m2 ?? 0));
  const topRow = outputRows[0];
  const eqContrib = contributions.filter((c) => c.equipmentId);
  const top = contributions[0];
  const cur = f.currency;
  const share = (v: number) => (L.outputLossM2 > 0 ? v / L.outputLossM2 : null);
  const eqLink = (id: string): InvestigationLink => ({ kind: 'equipment', id, label: `${id} drill-down` });
  /** Report of the root event that held the kiln up longest for an asset (same record as Events & Reports). */
  const topEventLink = (id: string | null | undefined): InvestigationLink[] => {
    const ev = id ? L.attribution.causes.find((x) => x.equipmentId === id)?.eventIds[0] : undefined;
    return ev ? [{ kind: 'event', id: ev, label: `${ev} report` }] : [];
  };

  // 1. Why are we below target?
  let target: Answer;
  const base = { key: 'target' as const, question: 'Why are we below target?', copilot: 'Why is production below target?' };
  if (status === 'none') target = { ...base, tone: 'neutral', headline: 'No production time in this period yet', detail: [], links: [] };
  else if (status === 'ahead' || status === 'on-track') {
    target = {
      ...base,
      tone: 'good',
      headline: `Not below target — ${TARGET_STATUS_LABEL[status].toLowerCase()} at ${pctS(lm.attainment)} of plan`,
      detail: [
        `Good output ${m2s(L.goodM2)} vs plan ${m2s(L.plannedM2)}${L.planGapM2 > 0.5 ? ` — ${m2s(L.planGapM2)} short, inside the 3 % band treated as on track` : ''}.`,
        `Losses at the kiln were ${pctS(lossShare, 1)} of design capacity; the plan allows ${pctS(allowShare, 1)} for normal losses.`,
      ],
      links: [],
    };
  } else {
    const detail = [
      `The plan allows ${m2s(L.allowanceM2)} (${pctS(allowShare, 1)}) of design capacity for normal losses; losses at the kiln were ${m2s(L.capacityGapM2)} (${pctS(lossShare, 1)}). The excess is the shortfall.`,
    ];
    if (topRow && (topRow.m2 ?? 0) > 0.5) detail.push(`Largest loss: ${topRow.label.toLowerCase()} ${m2s(topRow.m2!)} (${pctS(share(topRow.m2!))} of unplanned losses).`);
    if (top) detail.push(`Main contributor: ${top.equipmentId ? `${top.equipmentId} · ${top.label}` : top.label} — ${contributionParts(top)}.`);
    target = {
      ...base,
      tone: status === 'behind' ? 'warning' : 'critical',
      headline: `${TARGET_STATUS_LABEL[status]}: ${m2s(L.planGapM2)} short of plan (${pctS(lm.attainment)} attainment)`,
      detail,
      links: top?.equipmentId ? [eqLink(top.equipmentId)] : [{ kind: 'level', id: 'line', label: 'Line flow' }],
    };
  }

  // 2. Which equipment contributes most to the capacity gap?
  const equipment: Answer = {
    key: 'equipment',
    question: 'Which equipment contributes most to the capacity gap?',
    copilot: 'Which equipment causes the largest capacity loss?',
    tone: top ? 'warning' : 'good',
    headline: top
      ? `${top.equipmentId ? `${top.equipmentId} · ${top.label}` : top.label}: ${m2s(top.m2)} (${pctS(share(top.m2))} of unplanned losses)`
      : 'No unplanned losses at the constraint in this period',
    detail: top
      ? [
          `${top.equipmentId ? `${top.equipmentId}: ` : ''}${contributionParts(top)}.`,
          ...(contributions.length > 1
            ? [`Next: ${contributions.slice(1, 3).map((c) => `${c.equipmentId ?? c.label} ${m2s(c.m2)}`).join(', ')}.`]
            : []),
          'Valued once at the kiln: a stop elsewhere counts only for the minutes it held the kiln up (event records).',
        ]
      : [],
    links: [...eqContrib.slice(0, 3).map((c) => eqLink(c.equipmentId!)), ...topEventLink(top?.equipmentId)],
  };

  // 3. Which loss category is largest?
  const valued = [...L.rows].filter((r) => r.money != null && r.money > 0).sort((a, b) => b.money! - a.money!);
  const catDetail: string[] = [];
  if (topRow && (topRow.m2 ?? 0) > 0.5) {
    const rest = outputRows.slice(1).filter((r) => (r.m2 ?? 0) > 0.5);
    if (rest.length) catDetail.push(`Then: ${rest.map((r) => `${r.label.toLowerCase()} ${m2s(r.m2!)}`).join(', ')}.`);
    if (valued[0] && valued[0].key !== topRow.key) catDetail.push(`By estimated value the largest is ${valued[0].label.toLowerCase()} (≈ ${fmtMoney(valued[0].money, cur)}, estimate).`);
    if (L.plannedStopM2 > 0.5) catDetail.push(`Planned stops (${m2s(L.plannedStopM2)}) are part of the plan and not counted as a loss.`);
  }
  const category: Answer = {
    key: 'category',
    question: 'Which loss category is largest?',
    copilot: 'What prevents us from reaching theoretical output?',
    tone: topRow && (topRow.m2 ?? 0) > 0.5 ? 'warning' : 'good',
    headline:
      topRow && (topRow.m2 ?? 0) > 0.5
        ? `${topRow.label}: ${m2s(topRow.m2!)} (${pctS(share(topRow.m2!))}) · ≈ ${fmtMoney(topRow.money, cur)} estimate`
        : 'No unplanned output loss at the constraint in this period',
    detail: catDetail,
    links: topRow?.key === 'constraint' || topRow?.key === 'downtime' ? [{ kind: 'level', id: 'line', label: 'Line flow & bottleneck' }] : [],
  };

  // 4. What is constraining good output?
  const c = bn.current;
  const win = bn.period.label.toLowerCase();
  const A = lm.oee.availability.status === 'ok' ? pctS(lm.oee.availability.value, 1) : '—';
  const P = lm.oee.performance.status === 'ok' ? pctS(lm.oee.performance.value, 1) : '—';
  const stageLinks = (c.machines.length ? c.machines.map((m) => m.id) : []).slice(0, 3).map(eqLink);
  const constraint: Answer =
    bn.cause === 'constraint'
      ? {
          key: 'constraint',
          question: 'What is constraining good output?',
          copilot: 'What constraint is limiting good output?',
          tone: 'neutral',
          headline: `The kiln (H-KILN) limits good output, as designed`,
          detail: [
            `${bn.period.label}: the kiln was starved ${pctS(bn.constraint.starvedShare)} and blocked ${pctS(bn.constraint.blockedShare)} — under the ${pctS(HELD_UP_SHARE)} threshold, so output is set by its own availability (${A}) and speed (${P}) this period.`,
            `First-pass yield ${pctS(L.fpy, 1)}: ${m2s(L.qualityM2)} rejected after firing.`,
          ],
          links: [eqLink(KILN), { kind: 'level', id: 'line', label: 'Bottleneck trace' }],
        }
      : (() => {
          const starving = bn.cause === 'starving';
          // The traced stage was itself held on the kiln side: the restriction sits between it and the kiln.
          const between = starving ? c.blockedShare > HELD_UP_SHARE : c.starvedShare > HELD_UP_SHARE;
          const root = L.attribution.causes.find((x) => x.minutes >= 1);
          // Only a root cause active inside the trace window can explain the current bottleneck.
          const rootOutside = !!root && root.lastActive >= bn.period.from && !c.machines.some((m) => m.id === root.equipmentId);
          const detail = [
            starving
              ? `The kiln waited for tiles ${pctS(bn.constraint.starvedShare)} of the ${win}; ${c.name.toLowerCase()} is the first stage upstream that was not itself waiting (working ${pctS(c.workingShare)}, down ${pctS(c.downShare)}).`
              : `The kiln could not discharge ${pctS(bn.constraint.blockedShare)} of the ${win}; ${c.name.toLowerCase()} is the first stage downstream that was not itself blocked (working ${pctS(c.workingShare)}, down ${pctS(c.downShare)}).`,
          ];
          if (between)
            detail.push(
              `${c.name} was itself ${starving ? 'blocked' : 'starved'} ${pctS(starving ? c.blockedShare : c.starvedShare)} of the window — the restriction sits between it and the kiln (a transfer or conveyor).`,
            );
          if (root)
            detail.push(`Event records (${L.period.label}): ${root.equipmentId} · ${root.name} held the kiln up ${minS(root.minutes)}${root.reasons[0] ? ` (${root.reasons[0].label.toLowerCase()})` : ''} — the largest recorded cause.`);
          detail.push('Every minute the kiln waits is line output lost; it cannot be recovered later.');
          return {
            key: 'constraint' as const,
            question: 'What is constraining good output?',
            copilot: 'What constraint is limiting good output?',
            tone: 'warning' as const,
            headline:
              between && rootOutside
                ? root!.lastActive >= bn.period.to
                  ? `${root!.equipmentId} · ${root!.name} is ${starving ? 'starving' : 'blocking'} the kiln (traced past ${c.name.toLowerCase()})`
                  : `${root!.equipmentId} · ${root!.name} ${starving ? 'starved' : 'blocked'} the kiln in the ${win} (traced past ${c.name.toLowerCase()})`
                : `${c.name} is ${starving ? 'starving' : 'blocking'} the kiln`,
            detail,
            links: [...(rootOutside ? [eqLink(root!.equipmentId), ...topEventLink(root!.equipmentId)] : []), ...stageLinks, { kind: 'level' as const, id: 'line' as const, label: 'Bottleneck trace' }].slice(0, 4),
          };
        })();

  return [target, equipment, category, constraint];
}

// ── Improvement scenarios (what-if estimates) ─────────────────────────────────

export type WhatIf = {
  key: 'top-downtime' | 'kiln-speed' | 'defect' | 'changeover';
  title: string;
  /** What changes, in plain words. */
  change: string;
  available: boolean;
  note?: string;
  /** Good tiles gained over the period. */
  gainTiles: number;
  gainM2PerShift: number;
  moneyPerShift: number;
  lines: MoneyLine[];
  basis: string;
  assumptions: string[];
};

export type WhatIfOptions = { kilnPts: number; changeoverCut: number };
export const DEFAULT_WHAT_IF: WhatIfOptions = { kilnPts: 2, changeoverCut: 0.25 };

/**
 * What-if estimates on the period's own data, scaled to an 8-hour shift. They are arithmetic on
 * the ledger, not simulation runs: each states the change, the basis and its assumptions.
 */
export function whatIfs(s: SimState, L: LossLedger, opts: WhatIfOptions, f: FinanceAssumptions): WhatIf[] {
  const att = L.attribution;
  const ideal = L.idealPerHour / 60;
  const k = L.lm.constraint.totals;
  const perShift = L.calendarMin > 0 ? SHIFT_MIN / L.calendarMin : 0;
  /** Kiln tiles per operating minute in the period (its realistic running rate). */
  const runRate = k.operating > 1 ? k.count / k.operating : ideal * 0.945;
  const fpy = L.fpyUsed;
  const short = L.calendarMin < 120 ? [`Based on only ${minS(L.calendarMin)} of data — indicative.`] : [];
  const make = (w: Omit<WhatIf, 'gainM2PerShift' | 'moneyPerShift'>): WhatIf => ({
    ...w,
    gainM2PerShift: w.gainTiles * M2 * perShift,
    moneyPerShift: total(w.lines) * perShift,
  });

  // 1. Top downtime reason at the constraint: the kiln's own stops, or a root cause holding it up.
  const cands: { label: string; minutes: number; where: string }[] = [
    ...att.kilnReasons.map((r) => ({ label: r.label, minutes: r.minutes, where: KILN })),
    ...att.causes.flatMap((c) => c.reasons.map((r) => ({ label: r.label, minutes: r.minutes, where: c.equipmentId }))),
  ].sort((a, b) => b.minutes - a.minutes);
  const topC = cands[0];
  const topTiles = topC ? topC.minutes * runRate * fpy : 0;
  const w1 = make({
    key: 'top-downtime',
    title: 'Eliminate the top downtime reason at the constraint',
    change: topC ? `Remove “${topC.label}” at ${topC.where} — ${minS(topC.minutes)} of kiln time in the period` : 'No downtime at or holding up the kiln',
    available: !!topC && topC.minutes >= 0.5,
    note: topC && topC.minutes >= 0.5 ? undefined : 'No unplanned downtime at the kiln and nothing held it up in this period — nothing to eliminate.',
    gainTiles: topC && topC.minutes >= 0.5 ? topTiles : 0,
    lines: topC && topC.minutes >= 0.5 ? [lostOutputValue(f, topTiles)] : [],
    basis: `Recovered kiln minutes × its running rate ${n0.format(runRate * 60)} tiles/h × FPY ${pctS(fpy, 1)}`,
    assumptions: ['The kiln has input and outlet space for the recovered minutes (it is the constraint).', 'The reason does not reappear as another stop.', ...short],
  });

  // 2. Kiln performance +N points.
  const perf = k.operating > 1 ? k.count / (ideal * k.operating) : null;
  const target = perf == null ? null : Math.min(1, perf + opts.kilnPts / 100);
  const speedTiles = perf == null || target == null ? 0 : ideal * k.operating * (target - perf) * fpy;
  const w2 = make({
    key: 'kiln-speed',
    title: `Raise kiln performance by ${opts.kilnPts} pts`,
    change: perf == null ? 'Kiln did not operate in the period' : `Kiln performance ${pctS(perf, 1)} → ${pctS(target, 1)} over ${minS(k.operating)} of operating time`,
    available: perf != null && target! > perf + 1e-6,
    note: perf == null ? 'No kiln operating time in this period.' : target! <= perf + 1e-6 ? 'The kiln already runs at its design rate.' : undefined,
    gainTiles: speedTiles,
    lines: speedTiles > 0 ? [lostOutputValue(f, speedTiles)] : [],
    basis: `Design rate ${n0.format(L.idealPerHour)} tiles/h × operating time × ${opts.kilnPts} pts × FPY ${pctS(fpy, 1)}; capped at 100 %`,
    assumptions: ['Upstream supplies the extra tiles (buffers and stages ahead of the kiln run faster).', 'Firing quality unchanged at the higher speed.', ...short],
  });

  // 3. Halve the largest defect category.
  const q = qualityIn(s, L.period);
  const topD = (DEFECT_ORDER.map((d) => [d, q.byDefect[d] ?? 0]) as [DefectCategory, number][]).sort((a, b) => b[1] - a[1])[0];
  const halved = topD && topD[1] > 0 ? topD[1] / 2 : 0;
  const w3 = make({
    key: 'defect',
    title: 'Halve the largest defect category',
    change: halved > 0 ? `${DEFECTS[topD[0]].label}: ${n0.format(topD[1])} → ${n0.format(topD[1] / 2)} rejected tiles (origin: ${STAGE_BY_ID[DEFECTS[topD[0]].origin].name.toLowerCase()})` : 'No rejects in the period',
    available: halved > 0,
    note: halved > 0 ? undefined : 'Nothing was rejected in this period.',
    gainTiles: halved,
    lines: halved > 0 ? qualityLossValue(f, halved) : [],
    basis: 'Half the rejects of the category become first-quality tiles; valued like the quality loss (scrap sunk cost + lost contribution, rework)',
    assumptions: ['The defect is reduced at its origin stage without extra kiln time.', 'Other defect categories unchanged.', ...short],
  });

  // 4. Shorten changeovers by X %.
  const chg = downtimeIn(s, L.period).filter((d) => d.reasonCode === 'CHG_PRODUCT');
  let chgMin = 0;
  let chgKiln = 0;
  for (const d of chg) {
    const c = clippedDuration(d, L.period, s.minute);
    chgMin += c;
    const dur = Math.max(1, (d.end ?? s.minute) - d.start);
    chgKiln += d.constraintImpactMin * Math.min(1, c / dur);
  }
  // Overlapping changeovers share the same kiln minutes: never more than the kiln actually lost.
  chgKiln = Math.min(chgKiln, k.down + k.starved + k.blocked);
  const recovered = chgKiln * opts.changeoverCut;
  const chgTiles = recovered * runRate * fpy;
  const cutS = pctS(opts.changeoverCut);
  const w4 = make({
    key: 'changeover',
    title: `Shorten changeovers by ${cutS}`,
    change: chg.length
      ? `${chg.length} changeover${chg.length === 1 ? '' : 's'}, ${minS(chgMin)} of machine time; the kiln was held up ${minS(chgKiln)} while they ran`
      : 'No product changeover in the period',
    available: chg.length > 0 && chgKiln >= 0.5,
    note: !chg.length
      ? 'No changeover in this period — choose a longer period (changeovers every 16 h).'
      : chgKiln < 0.5
        ? `Buffers absorbed the changeovers — shortening them frees ${minS(chgMin * opts.changeoverCut)} of machine time but adds no line output.`
        : undefined,
    gainTiles: chgKiln >= 0.5 ? chgTiles : 0,
    lines: chgKiln >= 0.5 ? [lostOutputValue(f, chgTiles)] : [],
    basis: `${cutS} of the kiln minutes held up during changeovers × running rate ${n0.format(runRate * 60)} tiles/h × FPY ${pctS(fpy, 1)}`,
    assumptions: ['Upper bound: other causes coinciding with a changeover are not separated.', 'Shorter changeovers keep first-batch quality unchanged.', ...short],
  });

  return [w1, w2, w3, w4];
}

// ── Compare with the no-scenario baseline ─────────────────────────────────────

export type BaselineRow = {
  key: string;
  label: string;
  now: string;
  base: string;
  delta: string;
  /** +1 better, −1 worse, 0 same, null not comparable. */
  direction: 1 | -1 | 0 | null;
  /** Estimated money effect (positive = better), null when not valued. */
  value: number | null;
  basis: string;
};

/** The live period vs the same seed simulated without scenarios, with estimated money effects. */
export function baselineComparison(s: SimState, base: SimState, p: Period, tariffs: Tariffs, f: FinanceAssumptions) {
  const im = impactVsBaseline(s, base, p, tariffs);
  const dir = (d: number | null, higherBetter: boolean, eps: number): BaselineRow['direction'] =>
    d == null ? null : Math.abs(d) < eps ? 0 : (d > 0) === higherBetter ? 1 : -1;
  const sign = (v: number, txt: string) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${txt}`;
  const outTiles = im.deltaOutputM2 / M2;
  const outValue = Math.sign(outTiles) * lostOutputValue(f, Math.abs(outTiles)).amount;
  const rows: BaselineRow[] = [
    {
      key: 'output',
      label: 'Good output',
      now: m2s(im.outputM2),
      base: m2s(im.baselineOutputM2),
      delta: sign(im.deltaOutputM2, m2s(Math.abs(im.deltaOutputM2))),
      direction: dir(im.deltaOutputM2, true, 0.5),
      value: Math.abs(im.deltaOutputM2) >= 0.5 ? outValue : 0,
      basis: `Δ good m² × contribution ${fmtMoney(contributionPerM2(f), f.currency)}/m² × ${pctS(f.soldOutShare)} sold-out share`,
    },
    {
      key: 'oee',
      label: 'Line OEE',
      now: pctS(im.oee, 1),
      base: pctS(im.baselineOee, 1),
      delta: im.deltaOeePts == null ? '—' : sign(im.deltaOeePts, `${Math.abs(im.deltaOeePts).toFixed(1)} pts`),
      direction: dir(im.deltaOeePts, true, 0.05),
      value: null,
      basis: 'Valued through good output',
    },
    {
      key: 'downtime',
      label: 'Unplanned downtime (all machines)',
      now: minS(im.downtimeMin),
      base: minS(im.downtimeMin - im.deltaDowntimeMin),
      delta: sign(im.deltaDowntimeMin, minS(Math.abs(im.deltaDowntimeMin))),
      direction: dir(im.deltaDowntimeMin, false, 0.5),
      value: null,
      basis: 'Machine time; costs output only where it held up the kiln',
    },
    {
      key: 'rejects',
      label: 'Reject rate',
      now: pctS(im.rejectRate, 2),
      base: pctS(im.baselineRejectRate, 2),
      delta: im.deltaRejectRatePts == null ? '—' : sign(im.deltaRejectRatePts, `${Math.abs(im.deltaRejectRatePts).toFixed(2)} pts`),
      direction: dir(im.deltaRejectRatePts, false, 0.005),
      value: null,
      basis: 'Valued through good output',
    },
    {
      key: 'energy',
      label: 'Energy cost',
      now: fmtMoney(im.energyCost, f.currency),
      base: fmtMoney(im.energyCost - im.deltaEnergyCost, f.currency),
      delta: sign(im.deltaEnergyCost, fmtMoney(Math.abs(im.deltaEnergyCost), f.currency)),
      direction: dir(im.deltaEnergyCost, false, 0.5),
      value: -im.deltaEnergyCost,
      basis: 'At the configured tariffs (illustrative model)',
    },
  ];
  const net = rows.reduce((a, r) => a + (r.value ?? 0), 0);
  return { impact: im, rows, net };
}
