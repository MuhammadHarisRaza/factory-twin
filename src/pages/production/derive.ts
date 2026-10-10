/**
 * Small pure helpers for the Production & OEE workspace. All figures still come from
 * src/sim/metrics.ts; these only bucket, filter or project them for display.
 */
import { M2_PER_TILE, OPS_BY_ID, PROCESS_MACHINES, REASON_BY_CODE, TARGET } from '../../model/plant';
import type { DowntimeCategory, DowntimeEvent, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import {
  downtimeIn,
  downtimePareto,
  hourlyTrend,
  lineGoodIn,
  lineMetrics,
  qualityIn,
  sumBuckets,
  type ParetoRow,
  type Period,
  type PeriodKey,
} from '../../sim/metrics';
import type { Metric, OeeResult } from '../../sim/oee';
import { formatClock, formatDay, shiftAt } from '../../sim/time';
import { fmtPct } from '../../ui/kit/format';

export type Granularity = 'hour' | 'shift';

/** Hourly up to ~a day; shift buckets for the 7-day window so the charts stay readable. */
export const granularityFor = (p: Period): Granularity => (p.to - p.from > 26 * 60 ? 'shift' : 'hour');

type Slot = { key: string; from: number; to: number; label: string; tip: string; partial: boolean };

function slots(p: Period, g: Granularity): Slot[] {
  const out: Slot[] = [];
  if (g === 'hour') {
    for (let h = Math.floor(p.from / 60) * 60; h < p.to; h += 60) {
      const to = Math.min(h + 60, p.to);
      out.push({ key: String(h), from: Math.max(h, p.from), to, label: formatClock(h), tip: `${formatDay(h)} ${formatClock(h)}–${formatClock(h + 60)}`, partial: to < h + 60 });
    }
    return out;
  }
  let sh = shiftAt(p.from);
  while (sh.start < p.to) {
    const from = Math.max(sh.start, p.from);
    const to = Math.min(sh.end, p.to);
    out.push({
      key: String(sh.start),
      from,
      to,
      label: `${formatDay(sh.start).split(' ')[0].replace(',', '')} ${sh.id}`,
      tip: `${formatDay(sh.start)} · ${sh.label}`,
      partial: from > sh.start || to < sh.end,
    });
    sh = shiftAt(sh.end);
  }
  return out;
}

export type TrendBucket = {
  key: string;
  label: string;
  tip: string;
  partial: boolean;
  outputM2: number;
  targetM2: number;
  oee: number | null;
  /** Tiles sorted / rejected at inspection in the bucket. */
  inspected: number;
  rejected: number;
  /** rejected ÷ inspected; null when nothing was sorted. */
  defectRate: number | null;
};

/** Line output vs target, OEE and defect rate per bucket (hourlyTrend for hours, lineMetrics per shift otherwise). */
export function lineTrend(s: SimState, p: Period, g: Granularity): TrendBucket[] {
  const sl = slots(p, g);
  const quality = (x: Slot) => {
    const q = qualityIn(s, { from: x.from, to: x.to, label: '' });
    return { inspected: q.inspected, rejected: q.rejected, defectRate: q.inspected > 0 ? q.rejected / q.inspected : null };
  };
  if (g === 'hour') {
    const pts = new Map(hourlyTrend(s, p).map((h) => [h.start, h]));
    return sl.map((x) => {
      const h = pts.get(Number(x.key));
      return {
        key: x.key,
        label: x.label,
        tip: x.tip,
        partial: x.partial,
        outputM2: (h?.output ?? 0) * M2_PER_TILE,
        targetM2: (h?.target ?? 0) * M2_PER_TILE,
        oee: h?.oee ?? null,
        ...quality(x),
      };
    });
  }
  return sl.map((x) => {
    const lm = lineMetrics(s, { from: x.from, to: x.to, label: x.tip });
    return {
      key: x.key,
      label: x.label,
      tip: x.tip,
      partial: x.partial,
      outputM2: lm.outputM2,
      targetM2: lm.targetM2,
      oee: lm.oee.oee.status === 'ok' ? lm.oee.oee.value : null,
      ...quality(x),
    };
  });
}

// ── Planned vs actual (cumulative) ────────────────────────────────────────────

export type CumulativePlan = {
  /** Plant minute of every point (uniform grid, aligned to the period start). */
  times: number[];
  labels: string[];
  tickEvery: number;
  /** Grid step, minutes (1, or 60 for the 7-day view). */
  step: number;
  /** Cumulative first-quality m² up to each point; null after "now". */
  actual: (number | null)[];
  /** Cumulative plan: target rate pro-rated over calendar time. */
  plan: number[];
  /** Straight-line projection from now to the end of the shift; null before now. */
  projection: (number | null)[];
  /** Last point of the chart: end of the current shift for live shift / day views, else the period end. */
  end: number;
  /** Time the actual series ends at (now, or the period end for completed periods). */
  actualTo: number;
  actualNowM2: number;
  planNowM2: number;
  planEndM2: number;
  /** Projected cumulative m² at `end`, at the shift-to-date average rate (null in the first 15 min of a shift). */
  projectedEndM2: number | null;
  /** Shift-to-date average rate used by the projection, m²/h. */
  projectionRateM2h: number | null;
  /** Whether this period shows a projection to the end of the current shift. */
  projects: boolean;
};

/**
 * Cumulative actual output vs cumulative plan over the period, plus the end-of-shift projection.
 * Line output is counted per plant hour at sorting, so values inside an hour are interpolated
 * linearly (the current, partial hour up to now).
 */
export function cumulativeVsPlan(s: SimState, key: PeriodKey, p: Period): CumulativePlan {
  const now = s.minute;
  const projects = key === 'shift' || key === 'today';
  const sh = shiftAt(now);
  const end = projects ? Math.max(sh.end, p.to) : p.to;
  const step = end - p.from > 26 * 60 ? 60 : 1;
  const actualTo = Math.min(now, p.to);
  const planPerMin = (TARGET.goodPerHour / 60) * M2_PER_TILE;

  // Prefix sums of hourly good output from the period start.
  const h0 = Math.floor(p.from / 60);
  const nHours = Math.max(0, Math.ceil((actualTo - h0 * 60) / 60));
  const good: number[] = [];
  const pre: number[] = [0];
  for (let i = 0; i < nHours; i++) {
    good.push(s.lineGood.get(h0 + i) ?? 0);
    pre.push(pre[i] + good[i]);
  }
  const cumTiles = (t: number) => {
    const k = Math.floor((t - h0 * 60) / 60);
    const hourStart = (h0 + k) * 60;
    let acc = pre[Math.min(k, nHours)];
    if (k < nHours && t > hourStart) {
      const covered = Math.min(60, actualTo - hourStart);
      if (covered > 0) acc += good[k] * Math.min(1, (t - hourStart) / covered);
    }
    return acc;
  };

  const actualNowM2 = cumTiles(actualTo) * M2_PER_TILE;
  let rateM2PerMin: number | null = null;
  if (projects) {
    const elapsed = now - sh.start;
    if (elapsed >= 15) rateM2PerMin = (lineGoodIn(s, { from: sh.start, to: now, label: '' }) * M2_PER_TILE) / elapsed;
  }

  const weekday = (t: number) => formatDay(t).split(' ')[0].replace(',', '');
  const times: number[] = [];
  for (let t = p.from; t <= end; t += step) times.push(t);
  const span = end - p.from;
  const tickEvery = step === 60 ? 24 : span <= 9 * 60 ? 60 : span <= 13 * 60 ? 120 : 180;

  return {
    times,
    labels: times.map((t) => (step === 60 ? `${weekday(t)} ${formatClock(t)}` : formatClock(t))),
    tickEvery,
    step,
    actual: times.map((t) => (t <= actualTo ? cumTiles(t) * M2_PER_TILE : null)),
    plan: times.map((t) => planPerMin * (t - p.from)),
    projection: times.map((t) => (rateM2PerMin == null || t < now ? null : actualNowM2 + rateM2PerMin * (t - now))),
    end,
    actualTo,
    actualNowM2,
    planNowM2: planPerMin * (actualTo - p.from),
    planEndM2: planPerMin * (end - p.from),
    projectedEndM2: rateM2PerMin == null ? null : actualNowM2 + rateM2PerMin * (end - now),
    projectionRateM2h: rateM2PerMin == null ? null : rateM2PerMin * 60,
    projects,
  };
}

// ── Losses by machine ─────────────────────────────────────────────────────────

export type MachineLoss = {
  id: string;
  stage: StageId;
  downMin: number;
  starvedMin: number;
  blockedMin: number;
  /** Ideal-rate output not made, m² (tile equivalent). */
  downM2: number;
  starvedM2: number;
  blockedM2: number;
  totalM2: number;
};

/** Output a machine did not make in the period through unplanned downtime and starved / blocked time, at its ideal rate. */
export function machineLoss(s: SimState, id: string, p: Period): MachineLoss {
  const t = sumBuckets(s, id, p);
  const m2PerMin = ((OPS_BY_ID[id].idealRatePerHour ?? 0) / 60) * M2_PER_TILE;
  const downM2 = t.down * m2PerMin;
  const starvedM2 = t.starved * m2PerMin;
  const blockedM2 = t.blocked * m2PerMin;
  return {
    id,
    stage: OPS_BY_ID[id].stage!,
    downMin: t.down,
    starvedMin: t.starved,
    blockedMin: t.blocked,
    downM2,
    starvedM2,
    blockedM2,
    totalM2: downM2 + starvedM2 + blockedM2,
  };
}

/** Every process machine, largest loss first (line order on ties). */
export const machineLosses = (s: SimState, p: Period): MachineLoss[] =>
  PROCESS_MACHINES.map((id) => machineLoss(s, id, p)).sort((a, b) => b.totalM2 - a.totalM2);

// ── How OEE is calculated ─────────────────────────────────────────────────────

export type RoundingCheck = {
  /** All four figures are valid numbers. */
  applicable: boolean;
  /** Product of the components as displayed (rounded), as a fraction. */
  productOfShown: number | null;
  /** The displayed OEE equals the product of the displayed components at the shown precision. */
  matches: boolean;
};

const shown = (v: number, digits: number) => Number((v * 100).toFixed(digits)) / 100;

/** Checks whether A × P × Q of the rounded, displayed components reproduces the displayed OEE. */
export function roundingCheck(r: Pick<OeeResult, 'availability' | 'performance' | 'quality' | 'oee'>, digits = 1): RoundingCheck {
  const parts: Metric[] = [r.availability, r.performance, r.quality, r.oee];
  if (parts.some((m) => m.status !== 'ok' || m.value == null)) return { applicable: false, productOfShown: null, matches: true };
  const prod = shown(r.availability.value!, digits) * shown(r.performance.value!, digits) * shown(r.quality.value!, digits);
  return { applicable: true, productOfShown: prod, matches: fmtPct(prod, digits) === fmtPct(r.oee.value, digits) };
}

export type OeeExplain = {
  /** Minutes simulated in the period at the kiln (planned production time + planned stops). */
  calendarMin: number;
  plannedStopMin: number;
  /** Planned production time at the kiln. */
  plannedMin: number;
  /** Kiln operating (producing) time. */
  operatingMin: number;
  idealRatePerHour: number;
  idealCycleSec: number;
  /** Ideal cycle time × total count, minutes. */
  netRunMin: number;
  /** Tiles fired at the kiln. */
  totalCount: number;
  /** Tiles inspected and accepted first time at sorting. */
  sorted: number;
  good: number;
  oee: OeeResult;
  rounding: RoundingCheck;
};

/** The underlying values of the line OEE for the period, exactly as lineMetrics combines them. */
export function oeeExplain(s: SimState, p: Period): OeeExplain {
  const lm = lineMetrics(s, p);
  const t = lm.constraint.totals;
  const ideal = lm.constraint.idealRatePerHour;
  return {
    calendarMin: t.planned + t.plannedStop,
    plannedStopMin: t.plannedStop,
    plannedMin: t.planned,
    operatingMin: t.operating,
    idealRatePerHour: ideal,
    idealCycleSec: 3600 / ideal,
    netRunMin: (60 / ideal) * t.count,
    totalCount: t.count,
    sorted: lm.inspected,
    good: lm.good,
    oee: lm.oee,
    rounding: roundingCheck(lm.oee),
  };
}

export type MachineBucket = { key: string; label: string; tip: string; outputM2: number; idealM2: number; plannedMin: number };

/** A machine's output vs its ideal-rate output over planned time, per bucket. */
export function machineTrend(s: SimState, id: string, p: Period, g: Granularity): MachineBucket[] {
  const ideal = OPS_BY_ID[id].idealRatePerHour ?? 0;
  return slots(p, g).map((x) => {
    const t = sumBuckets(s, id, { from: x.from, to: x.to, label: '' });
    return { key: x.key, label: x.label, tip: x.tip, outputM2: t.count * M2_PER_TILE, idealM2: ((ideal * t.planned) / 60) * M2_PER_TILE, plannedMin: t.planned };
  });
}

/** End-of-shift projection at the shift-to-date average rate. Null in the first 15 minutes. */
export function shiftProjection(s: SimState, outputTiles: number) {
  const sh = shiftAt(s.minute);
  const elapsed = s.minute - sh.start;
  if (elapsed < 15) return null;
  const perMin = outputTiles / elapsed;
  const projected = outputTiles + perMin * (sh.end - s.minute);
  const target = (TARGET.goodPerHour * (sh.end - sh.start)) / 60;
  return { projectedM2: projected * M2_PER_TILE, targetM2: target * M2_PER_TILE, attainment: projected / target, rateM2h: perMin * 60 * M2_PER_TILE, endsAt: sh.end };
}

/** Last complete plant hour: output and target. */
export function lastFullHour(s: SimState) {
  const h = Math.floor(s.minute / 60) - 1;
  const p: Period = { from: h * 60, to: h * 60 + 60, label: '' };
  const spark: number[] = [];
  for (let i = 7; i >= 0; i--) spark.push(lineGoodIn(s, { from: (h - i) * 60, to: (h - i) * 60 + 60, label: '' }) * M2_PER_TILE);
  return { from: p.from, outputM2: lineGoodIn(s, p) * M2_PER_TILE, targetM2: TARGET.goodPerHour * M2_PER_TILE, spark };
}

// ── Downtime filtering ────────────────────────────────────────────────────────

export type EventFilter = {
  category: DowntimeCategory | 'all';
  equipmentId: string | 'all';
  reason: string | null;
  /** Include starved/blocked (process-interaction) events. */
  includeFlow: boolean;
};

export const isFlow = (c: DowntimeCategory) => c === 'Starved' || c === 'Blocked';

/**
 * The filter with starved / blocked events switched on or off. Switching them off also drops a
 * starved / blocked category or reason, so no hidden filter is left behind (one rule for the
 * Pareto scope control and the event-table checkbox).
 */
export function withIncludeFlow(f: EventFilter, includeFlow: boolean): EventFilter {
  if (includeFlow) return { ...f, includeFlow };
  return {
    ...f,
    includeFlow,
    category: f.category !== 'all' && isFlow(f.category) ? 'all' : f.category,
    reason: f.reason === 'STARVED' || f.reason === 'BLOCKED' ? null : f.reason,
  };
}

/** Downtime events in the period matching the filter: active first, then newest first. */
export function filterEvents(s: SimState, p: Period, f: EventFilter): DowntimeEvent[] {
  return downtimeIn(s, p)
    .filter(
      (d) =>
        (f.includeFlow || !isFlow(d.category)) &&
        (f.category === 'all' || d.category === f.category) &&
        (f.equipmentId === 'all' || d.equipmentId === f.equipmentId) &&
        (f.reason == null || d.reasonCode === f.reason),
    )
    .sort((a, b) => (a.end == null ? 0 : 1) - (b.end == null ? 0 : 1) || b.start - a.start);
}

/** Pareto by reason with the category / machine filter applied; shares recomputed within the subset. */
export function filteredPareto(s: SimState, p: Period, f: EventFilter): ParetoRow[] {
  const rows = downtimePareto(s, p, { includeFlow: f.includeFlow, equipmentId: f.equipmentId === 'all' ? undefined : f.equipmentId })
    .filter((r) => f.category === 'all' || r.category === f.category)
    .map((r) => ({ ...r }));
  const total = rows.reduce((a, r) => a + r.minutes, 0);
  let cum = 0;
  for (const r of rows) {
    r.share = total > 0 ? r.minutes / total : 0;
    cum += r.share;
    r.cumulative = cum;
  }
  return rows;
}

export const reasonLabel = (code: string) => REASON_BY_CODE[code]?.label ?? code;
