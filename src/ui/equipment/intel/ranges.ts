/**
 * Time ranges of the equipment / stage panels (brief §6B): the window a chart range covers on the plant clock and
 * which ranges the data can serve. 15 min / 1 h are minute data and 8 h 5-min steps of minute data (the minute log
 * keeps 8 h, so these are always offered); 24 h and 7 days are hourly and need that much simulated history — a
 * range the history cannot fill stays visible but disabled, with the reason, instead of drawing an empty chart.
 */
import { RANGE_BY_KEY, RANGE_OPTIONS, type RangeKey } from '../../../model/telemetry';
import { rangeWindow } from '../../../intel/rules/context';
import type { SimState } from '../../../sim/engine';
import { seriesOf } from '../../../sim/telemetry';
import { formatDuration } from '../../../sim/time';

export type RangeWindow = {
  key: RangeKey;
  /** [from, to) in plant minutes (hourly ranges are whole hours ending with the current one). */
  from: number;
  to: number;
  stepMin: number;
  resolution: 'minute' | 'hour';
  /** "Last 8 h · 5-min steps of minute data". */
  label: string;
};

/** What a range draws: 'minute data', '5-min steps of minute data', 'hourly data'. */
export const resolutionLabel = (key: RangeKey) => {
  const r = RANGE_BY_KEY[key];
  return r.resolution === 'hour' ? 'hourly data' : r.stepMin === 1 ? 'minute data' : `${r.stepMin}-min steps of minute data`;
};

/** The window of a chart range ending now (aligned with the telemetry series of src/sim/telemetry.ts). */
export function windowOf(s: SimState, key: RangeKey): RangeWindow {
  const r = RANGE_BY_KEY[key];
  const w = rangeWindow(key, s.minute);
  return { key, from: w.from, to: w.to, stepMin: w.stepMin, resolution: r.resolution, label: `Last ${r.label} · ${resolutionLabel(key)}` };
}

/**
 * Disabled reasons per range for charts of `signalIds` (an empty list: the history length alone decides). Minute
 * ranges are always available; an hourly range is disabled while the simulation holds less history than the range,
 * or when none of the signals has a single sample in it.
 */
export function rangeAvailability(s: SimState, signalIds: readonly string[] = []): Partial<Record<RangeKey, string>> {
  const out: Partial<Record<RangeKey, string>> = {};
  for (const r of RANGE_OPTIONS) {
    if (r.resolution !== 'hour') continue;
    if (s.minute < r.minutes) {
      out[r.key] = `The simulation holds ${formatDuration(s.minute)} of history — ${r.label} needs ${r.label}`;
      continue;
    }
    const numeric = signalIds.map((id) => seriesOf(s, id, r.key)).filter((x) => x != null);
    if (numeric.length && numeric.every((x) => x.coverage.present === 0)) out[r.key] = `No ${r.label} history for these signals`;
  }
  return out;
}

/** The selected range, or the closest shorter one that is available (a 7-day choice on a young simulation shows 24 h). */
export function effectiveRange(key: RangeKey, disabled: Partial<Record<RangeKey, string>>): RangeKey {
  if (!disabled[key]) return key;
  const i = RANGE_OPTIONS.findIndex((r) => r.key === key);
  for (let j = i - 1; j >= 0; j--) if (!disabled[RANGE_OPTIONS[j].key]) return RANGE_OPTIONS[j].key;
  return '8h';
}

/** The shortest range that covers a window ending at plant minute `now` (a finding's window → the range its chart link sets). */
export function rangeCovering(now: number, window: { from: number; to: number }, disabled: Partial<Record<RangeKey, string>> = {}): RangeKey {
  const need = now - window.from;
  const fit = RANGE_OPTIONS.find((r) => r.minutes >= need && !disabled[r.key]);
  return fit?.key ?? effectiveRange('7d', disabled);
}
