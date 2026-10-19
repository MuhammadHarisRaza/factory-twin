/**
 * Buffers, silos and tanks (brief §10): level trend, inflow / outflow balance, time to empty / full,
 * and mass from level. A level reading is a percentage; it becomes a quantity only through an explicit
 * level-to-mass calibration — without one there is no mass, only the level and its trend.
 */
import { insufficient, invalid, ok, unavailable, type Calc, type Sample } from './types';
import { fmt, isNum, plural, usableValue } from './internal';

export type FlowDirection = 'filling' | 'draining' | 'balanced';

/** A level-to-mass calibration (e.g. from a strapping table or load cells): [level %, mass] points. */
export type LevelCalibration = { points: [levelPct: number, mass: number][]; unit: 't' | 'kg' };

/** A slope smaller than this (units per hour) counts as no movement. */
const SLOPE_EPS = 1e-9;

/**
 * Least-squares slope of the samples, in value units per hour (`t` in plant minutes). Samples without a
 * good value (null, bad / stale / missing quality) are ignored, so gaps do not bias the fit; timestamps
 * need not be evenly spaced. Needs `minSamples` good samples (default 3, at least 2) spanning more than
 * zero and at least `minSpanMin` minutes (default 0), else 'insufficient'.
 */
export function trendSlope(samples: Sample[], opts: { minSamples?: number; minSpanMin?: number } = {}): Calc<number> {
  const minSamples = Math.max(2, opts.minSamples ?? 3);
  const minSpan = opts.minSpanMin ?? 0;
  const pts: [number, number][] = [];
  for (const s of samples) {
    const v = usableValue(s);
    if (v !== null) pts.push([s.t, v]);
  }
  if (pts.length < minSamples) return insufficient(`${plural(pts.length, 'good sample')} — a trend needs at least ${minSamples}`);
  let tMin = Infinity;
  let tMax = -Infinity;
  let tSum = 0;
  let vSum = 0;
  for (const [t, v] of pts) {
    tMin = Math.min(tMin, t);
    tMax = Math.max(tMax, t);
    tSum += t;
    vSum += v;
  }
  const span = tMax - tMin;
  if (span <= 0) return insufficient('All samples have the same timestamp');
  if (span < minSpan) return insufficient(`Samples span ${fmt(span)} min — a trend needs at least ${fmt(minSpan)} min`);
  const tMean = tSum / pts.length;
  const vMean = vSum / pts.length;
  let sxx = 0;
  let sxy = 0;
  for (const [t, v] of pts) {
    sxx += (t - tMean) ** 2;
    sxy += (t - tMean) * (v - vMean);
  }
  const skipped = samples.length - pts.length;
  return ok((sxy / sxx) * 60, skipped ? `${plural(skipped, 'sample')} without a good value ignored` : undefined);
}

/**
 * Net flow into a buffer = inflow − outflow (same unit, e.g. tiles/h or t/h). |net| ≤ deadband (default 0)
 * is 'balanced'. Missing flows → 'unavailable'; negative flows or deadband → 'invalid'.
 */
export function flowBalance(
  inflow: number | null,
  outflow: number | null,
  opts: { deadband?: number } = {},
): Calc<{ net: number; direction: FlowDirection }> {
  if (!isNum(inflow)) return unavailable('Inflow not reported');
  if (!isNum(outflow)) return unavailable('Outflow not reported');
  const deadband = opts.deadband ?? 0;
  if (inflow < 0 || outflow < 0) return invalid('Negative flow');
  if (!isNum(deadband) || deadband < 0) return invalid('Deadband must be a non-negative number');
  const net = inflow - outflow;
  return ok({ net, direction: net > deadband ? 'filling' : net < -deadband ? 'draining' : 'balanced' });
}

/**
 * Minutes until the level reaches `emptyAt` (default 0) at the current trend (units per hour, same unit
 * as the level), by linear extrapolation — not a forecast. Already at or below it → 0. A level that is
 * steady or rising (slope ≥ ≈0) never empties at this trend → 'unavailable'; missing inputs → 'unavailable'.
 */
export function timeToEmpty(level: number | null, slopePerHour: number | null, emptyAt = 0): Calc<number> {
  if (!isNum(level)) return unavailable('Level not reported');
  if (!isNum(slopePerHour)) return unavailable('No level trend');
  if (!isNum(emptyAt)) return invalid('Empty level must be a finite number');
  if (level <= emptyAt) return ok(0, 'Already at or below the empty level');
  if (slopePerHour > -SLOPE_EPS) return unavailable(slopePerHour > SLOPE_EPS ? 'Level is rising — not emptying' : 'Level is steady — not emptying');
  return ok(((level - emptyAt) / -slopePerHour) * 60);
}

/**
 * Minutes until the level reaches `fullAt` (default 100, i.e. a level in %) at the current trend, by
 * linear extrapolation — not a forecast. Already at or above it → 0. A steady or falling level →
 * 'unavailable'; missing inputs → 'unavailable'.
 */
export function timeToFull(level: number | null, slopePerHour: number | null, fullAt = 100): Calc<number> {
  if (!isNum(level)) return unavailable('Level not reported');
  if (!isNum(slopePerHour)) return unavailable('No level trend');
  if (!isNum(fullAt)) return invalid('Full level must be a finite number');
  if (level >= fullAt) return ok(0, 'Already at or above the full level');
  if (slopePerHour < SLOPE_EPS) return unavailable(slopePerHour < -SLOPE_EPS ? 'Level is falling — not filling' : 'Level is steady — not filling');
  return ok(((fullAt - level) / slopePerHour) * 60);
}

/**
 * Mass in a silo / tank from its level, by piecewise-linear interpolation of a calibration (result in
 * `calibration.unit`). No calibration → 'unavailable' ("No level-to-mass calibration configured"): a level
 * percentage alone never implies a quantity. A level outside the calibrated range is not extrapolated
 * ('unavailable'). A calibration needs at least two points with distinct levels, finite values and a mass
 * that does not fall as the level rises, else 'invalid'.
 */
export function massFromLevel(levelPct: number | null, calibration: LevelCalibration | null): Calc<number> {
  if (!calibration) return unavailable('No level-to-mass calibration configured');
  if (!isNum(levelPct)) return unavailable('Level not reported');
  if (levelPct < 0 || levelPct > 100) return invalid(`Level ${fmt(levelPct)} % is outside 0–100 %`);
  const raw = calibration.points ?? [];
  if (raw.length < 2) return invalid('A level calibration needs at least two points');
  if (raw.some(([l, m]) => !isNum(l) || !isNum(m) || m < 0)) return invalid('Calibration points must be finite, with a non-negative mass');
  const pts = [...raw].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] === pts[i - 1][0]) return invalid(`Calibration has two points at ${fmt(pts[i][0])} %`);
    if (pts[i][1] < pts[i - 1][1]) return invalid('Calibrated mass must not fall as the level rises');
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (levelPct < first[0] || levelPct > last[0])
    return unavailable(`Level ${fmt(levelPct)} % is outside the calibrated range ${fmt(first[0])}–${fmt(last[0])} %`);
  let i = 0;
  while (i < pts.length - 2 && levelPct > pts[i + 1][0]) i++;
  const [l0, m0] = pts[i];
  const [l1, m1] = pts[i + 1];
  return ok(m0 + ((m1 - m0) * (levelPct - l0)) / (l1 - l0), `From a ${pts.length}-point level calibration (${calibration.unit})`);
}
