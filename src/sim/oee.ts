/**
 * Centralised OEE calculations.
 *
 *   Availability = Operating time / Planned production time
 *   Performance  = Ideal cycle time × Total count / Operating time
 *   Quality      = Good count / Total count
 *   OEE          = Availability × Performance × Quality
 *
 * Values are never clamped to look plausible. A metric is either
 *   - 'ok'           a valid number,
 *   - 'unavailable'  inputs missing or the ratio undefined (e.g. no operating time) — distinct from 0,
 *   - 'invalid'      inputs contradict each other; `issue` explains what is wrong.
 */

export type MetricStatus = 'ok' | 'unavailable' | 'invalid';
export type Metric = { value: number | null; status: MetricStatus; issue?: string };

export type OeeInputs = {
  /** Planned production time (min). */
  plannedMin: number | null | undefined;
  /** Operating (run) time (min). */
  operatingMin: number | null | undefined;
  /** Ideal cycle time (min per unit). */
  idealCycleMin: number | null | undefined;
  totalCount: number | null | undefined;
  goodCount: number | null | undefined;
  /** Calendar length of the reporting period (min), to catch inconsistent boundaries. */
  periodMin?: number;
};

export type OeeResult = {
  availability: Metric;
  performance: Metric;
  quality: Metric;
  oee: Metric;
  /** Every issue found, for display next to the figures. */
  issues: string[];
};

/** Relative tolerance for rounding in counters (0.5 %). */
const TOLERANCE = 0.005;

const ok = (value: number): Metric => ({ value, status: 'ok' });
const unavailable = (issue: string): Metric => ({ value: null, status: 'unavailable', issue });
const invalid = (issue: string): Metric => ({ value: null, status: 'invalid', issue });

const missing = (v: number | null | undefined): v is null | undefined => v == null || Number.isNaN(v);

export function availability(plannedMin: OeeInputs['plannedMin'], operatingMin: OeeInputs['operatingMin'], periodMin?: number): Metric {
  if (missing(plannedMin) || missing(operatingMin)) return unavailable('Planned or operating time not reported');
  if (plannedMin < 0 || operatingMin < 0) return invalid('Negative time value');
  if (periodMin != null && plannedMin > periodMin * (1 + TOLERANCE))
    return invalid(`Planned time (${Math.round(plannedMin)} min) exceeds the reporting period (${Math.round(periodMin)} min)`);
  if (plannedMin === 0) return unavailable('No planned production time in this period');
  if (operatingMin > plannedMin * (1 + TOLERANCE))
    return invalid(`Operating time (${Math.round(operatingMin)} min) exceeds planned time (${Math.round(plannedMin)} min)`);
  return ok(operatingMin / plannedMin);
}

export function performance(
  idealCycleMin: OeeInputs['idealCycleMin'],
  totalCount: OeeInputs['totalCount'],
  operatingMin: OeeInputs['operatingMin'],
): Metric {
  if (missing(idealCycleMin) || idealCycleMin <= 0) return unavailable('No ideal cycle time configured');
  if (missing(totalCount)) return unavailable('Total count not reported');
  if (missing(operatingMin)) return unavailable('Operating time not reported');
  if (totalCount < 0) return invalid('Negative count');
  if (operatingMin < 0) return invalid('Negative operating time');
  if (operatingMin === 0) {
    return totalCount > 0 ? invalid('Units counted with zero operating time') : unavailable('No operating time in this period');
  }
  const p = (idealCycleMin * totalCount) / operatingMin;
  if (p > 1 + TOLERANCE)
    return invalid(`Count implies ${(p * 100).toFixed(1)} % of ideal rate — check the ideal cycle time or the counter`);
  return ok(p);
}

export function quality(goodCount: OeeInputs['goodCount'], totalCount: OeeInputs['totalCount']): Metric {
  if (missing(totalCount)) return unavailable('Total count not reported');
  if (missing(goodCount)) return unavailable('No good-count signal for this asset');
  if (goodCount < 0 || totalCount < 0) return invalid('Negative count');
  if (totalCount === 0) return goodCount > 0 ? invalid('Good count without total count') : unavailable('Nothing produced in this period');
  if (goodCount > totalCount * (1 + TOLERANCE)) return invalid('Good count exceeds total count');
  return ok(goodCount / totalCount);
}

export function computeOee(inputs: OeeInputs): OeeResult {
  const a = availability(inputs.plannedMin, inputs.operatingMin, inputs.periodMin);
  const p = performance(inputs.idealCycleMin, inputs.totalCount, inputs.operatingMin);
  const q = quality(inputs.goodCount, inputs.totalCount);
  return combineOee(a, p, q);
}

/**
 * OEE from already-computed components. Used directly when the components come from
 * different measurement points (line OEE: A and P at the constraint, Q at inspection).
 */
export function combineOee(a: Metric, p: Metric, q: Metric): OeeResult {
  const parts = [a, p, q];
  const issues = parts.filter((m) => m.issue).map((m) => m.issue!);
  let oee: Metric;
  if (parts.some((m) => m.status === 'invalid')) oee = invalid('One or more components are invalid');
  // A genuine zero availability (no operating time at all) means zero OEE, whatever P and Q are.
  else if (a.status === 'ok' && a.value === 0) oee = ok(0);
  else if (parts.some((m) => m.status === 'unavailable')) oee = unavailable('One or more components are unavailable');
  else oee = ok(a.value! * p.value! * q.value!);
  return { availability: a, performance: p, quality: q, oee, issues };
}

/** Availability × Performance only, for assets without a quality signal. */
export function computeTeep(a: Metric, p: Metric): Metric {
  if (a.status === 'invalid' || p.status === 'invalid') return invalid('Component invalid');
  if (a.status === 'ok' && p.status === 'ok') return ok(a.value! * p.value!);
  return unavailable('Component unavailable');
}

/** Loss tree in minutes (for the waterfall): planned → availability → performance → quality losses. */
export function lossTree(inputs: OeeInputs) {
  const r = computeOee(inputs);
  if (r.oee.status !== 'ok' || missing(inputs.plannedMin)) return null;
  const planned = inputs.plannedMin;
  const operating = inputs.operatingMin ?? 0;
  const netRun = (inputs.idealCycleMin ?? 0) * (inputs.totalCount ?? 0);
  const fullyProductive = (inputs.idealCycleMin ?? 0) * (inputs.goodCount ?? 0);
  return {
    planned,
    availabilityLoss: planned - operating,
    performanceLoss: operating - netRun,
    qualityLoss: netRun - fullyProductive,
    fullyProductive,
  };
}
