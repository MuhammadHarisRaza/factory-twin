/**
 * Availability and downtime (brief §10). Durations are plant minutes.
 */
import { invalid, ok, unavailable, type Calc, type StopRecord, type Window } from './types';
import { clipStop, fmt, isNum, validWindow } from './internal';

/** Relative tolerance for rounding in time accounting (0.5 %), as in src/sim/oee.ts. */
const TOLERANCE = 0.005;

/**
 * Availability = operating time ÷ planned production time. A genuine 0 operating minutes is 0. Missing
 * inputs or no planned time → 'unavailable' (not 0); negative times or operating time above planned time
 * (beyond a 0.5 % rounding tolerance) → 'invalid'. Within the tolerance the figure is capped at 1 with a note.
 */
export function availability(operatingMin: number | null, plannedMin: number | null): Calc<number> {
  if (!isNum(operatingMin) || !isNum(plannedMin)) return unavailable('Operating or planned time not reported');
  if (operatingMin < 0 || plannedMin < 0) return invalid('Negative time value');
  if (plannedMin === 0) return unavailable('No planned production time in this period');
  const a = operatingMin / plannedMin;
  if (a > 1 + TOLERANCE) return invalid(`Operating time (${fmt(operatingMin, 0)} min) exceeds planned time (${fmt(plannedMin, 0)} min)`);
  return a > 1 ? ok(1, 'Operating time exceeded planned time by less than 0.5 % (rounding) — shown as 100 %') : ok(a);
}

/**
 * Stop minutes inside a window. Each stop is clipped to the window; an open stop (end null) runs to
 * window.to. Planned stops are left out unless `includePlanned`. Per equipment, overlapping records are
 * counted once; across equipment the minutes add up (equipment-minutes). Malformed records (end before
 * start, non-finite times) and an empty window contribute nothing.
 */
export function downtimeMinutes(stops: StopRecord[], window: Window, opts: { includePlanned?: boolean } = {}): number {
  if (!validWindow(window)) return 0;
  const byEquipment = new Map<string, [number, number][]>();
  for (const s of stops) {
    if (s.planned && !opts.includePlanned) continue;
    const iv = clipStop(s, window);
    if (!iv) continue;
    const list = byEquipment.get(s.equipmentId);
    if (list) list.push(iv);
    else byEquipment.set(s.equipmentId, [iv]);
  }
  let total = 0;
  for (const list of byEquipment.values()) {
    list.sort((a, b) => a[0] - b[0]);
    let [from, to] = list[0];
    for (const [f, t] of list.slice(1)) {
      if (f <= to) to = Math.max(to, t);
      else {
        total += to - from;
        [from, to] = [f, t];
      }
    }
    total += to - from;
  }
  return total;
}
