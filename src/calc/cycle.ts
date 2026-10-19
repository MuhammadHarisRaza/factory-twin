/**
 * Cycle time and value distributions (brief §10): mean cycle time from a count over run time, and a
 * histogram with mean / median / 90th percentile for cycle-time (or any other) distributions.
 */
import { insufficient, invalid, ok, unavailable, type Calc } from './types';
import { fmt, isNum, plural } from './internal';

export type HistogramBin = { from: number; to: number; count: number };

export type Histogram = { bins: HistogramBin[]; n: number; mean: number; p50: number; p90: number };

export type HistogramOptions = {
  /** Width of every bin (in the values' unit); must be positive. */
  binWidth: number;
  /** Lower edge of the first bin; values below it are left out. Default: the smallest value rounded down to a bin edge. */
  min?: number;
  /** Upper edge of the last bin (inclusive); values above it are left out. Default: past the largest value. */
  max?: number;
  /** Fewer values (inside the range) than this → 'insufficient'. Default 5. */
  minSamples?: number;
};

/** Upper bound on the number of bins, against a mistyped bin width. */
export const MAX_BINS = 1000;

/**
 * Mean cycle time in seconds: run time ÷ cycles, where cycles = units ÷ unitsPerCycle (e.g. a two-cavity
 * press makes 2 tiles per stroke). Assumes the units were all made within the run time. No units →
 * 'unavailable' (cycle time undefined, not 0); units with zero run time, negative inputs or a non-positive
 * unitsPerCycle → 'invalid'.
 */
export function cycleTimeSec(units: number | null, runMinutes: number | null, unitsPerCycle = 1): Calc<number> {
  if (!isNum(units) || !isNum(runMinutes)) return unavailable('Unit count or run time not reported');
  if (!isNum(unitsPerCycle) || unitsPerCycle <= 0) return invalid(`Units per cycle must be a positive number (got ${unitsPerCycle})`);
  if (units < 0 || runMinutes < 0) return invalid('Negative unit count or run time');
  if (units === 0) return unavailable('No units produced — cycle time undefined');
  if (runMinutes === 0) return invalid(`${fmt(units)} units counted with no run time`);
  return ok((runMinutes * 60) / (units / unitsPerCycle));
}

/** Rounds bin edges so 0.1-wide bins read 0.3, not 0.30000000000000004. */
const edge = (x: number) => Math.round(x * 1e9) / 1e9;

/** Linear interpolation between order statistics (numpy default / Excel PERCENTILE.INC). `sorted` is non-empty. */
function quantile(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Histogram of the finite values (nulls are gaps and are ignored). Bins are [from, to) of equal width,
 * except that the last bin includes its upper edge and is cut at `max` when one is given. n, mean, p50 and
 * p90 describe the values inside the range, so Σ bin counts = n; values outside [min, max] are reported in
 * the note. Percentiles interpolate linearly between order statistics.
 */
export function histogram(values: (number | null)[], opts: HistogramOptions): Calc<Histogram> {
  const { binWidth, min, max } = opts;
  const minSamples = opts.minSamples ?? 5;
  if (!isNum(binWidth) || binWidth <= 0) return invalid(`Bin width must be a positive number (got ${binWidth})`);
  if ((min !== undefined && !isNum(min)) || (max !== undefined && !isNum(max))) return invalid('Histogram range must be finite numbers');
  if (min !== undefined && max !== undefined && min >= max) return invalid(`Histogram range ${fmt(min)}–${fmt(max)} is empty`);
  const finite = values.filter(isNum);
  const inRange = finite.filter((v) => (min === undefined || v >= min) && (max === undefined || v <= max));
  if (inRange.length < Math.max(1, minSamples))
    return insufficient(`${plural(inRange.length, 'value')} — a distribution needs at least ${Math.max(1, minSamples)}`);
  const sorted = [...inRange].sort((a, b) => a - b);
  const lo = min ?? edge(Math.floor(sorted[0] / binWidth + 1e-9) * binWidth);
  // Without a max, the last bin is a full bin on the grid that starts at lo (so an off-grid min gets no narrow last bin).
  const hi = max ?? edge(lo + (Math.floor((sorted[sorted.length - 1] - lo) / binWidth + 1e-9) + 1) * binWidth);
  const count = Math.max(1, Math.ceil((hi - lo) / binWidth - 1e-9));
  if (count > MAX_BINS) return invalid(`${count} bins requested — at most ${MAX_BINS}; use a wider bin`);
  const bins: HistogramBin[] = Array.from({ length: count }, (_, i) => ({
    from: edge(lo + i * binWidth),
    to: i === count - 1 ? hi : edge(lo + (i + 1) * binWidth),
    count: 0,
  }));
  for (const v of sorted) bins[Math.min(count - 1, Math.max(0, Math.floor((v - lo) / binWidth + 1e-9)))].count++;
  const mean = sorted.reduce((a, v) => a + v, 0) / sorted.length;
  const outside = finite.length - inRange.length;
  const gaps = values.length - finite.length;
  const notes = [outside ? `${plural(outside, 'value')} outside the range left out` : '', gaps ? `${plural(gaps, 'missing value')} ignored` : ''];
  const note = notes.filter(Boolean).join(' · ') || undefined;
  return ok({ bins, n: sorted.length, mean, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) }, note);
}
