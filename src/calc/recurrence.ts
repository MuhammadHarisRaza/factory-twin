/**
 * Reliability from stop records (brief §7 / §10): recurring fault reasons, repeated stops, MTBF / MTTR
 * and the longest stops. Times are plant minutes. Occurrence counts use stops that START inside the
 * window [from, to); minutes are clipped to the window (an open stop runs to window.to). Planned stops
 * (changeovers, cleaning) are not failures and are left out unless a function says otherwise.
 */
import { insufficient, invalid, ok, unavailable, type Calc, type StopRecord, type Window } from './types';
import { clippedMinutes, fmt, isNum, plural, startsIn, validWindow } from './internal';

export type RecurrenceRow = {
  /** reasonCode, equipmentId, or `${equipmentId}|${reasonCode}` depending on `by`. */
  key: string;
  equipmentId?: string;
  reasonCode?: string;
  /** Label of the most recent stop in the group that has one. */
  reasonLabel?: string;
  count: number;
  /** Stop minutes inside the window. */
  totalMin: number;
  /** Start of the most recent stop in the group. */
  lastAt: number;
};

export type RecurrenceOptions = {
  /** Group by reason code, by equipment, or by both (default). */
  by?: 'reason' | 'equipment' | 'both';
  /** Only groups with at least this many stops (default 1). */
  minCount?: number;
  includePlanned?: boolean;
};

/**
 * Stops grouped by reason and / or equipment, sorted by count (desc), then minutes (desc), then the most
 * recent first, then key — a deterministic order. Only stops starting inside the window are counted.
 */
export function faultRecurrence(stops: StopRecord[], window: Window, opts: RecurrenceOptions = {}): RecurrenceRow[] {
  const by = opts.by ?? 'both';
  const minCount = opts.minCount ?? 1;
  if (!validWindow(window)) return [];
  const rows = new Map<string, RecurrenceRow>();
  const labelAt = new Map<string, number>();
  for (const s of stops) {
    if ((s.planned && !opts.includePlanned) || !startsIn(s, window)) continue;
    const key = by === 'reason' ? s.reasonCode : by === 'equipment' ? s.equipmentId : `${s.equipmentId}|${s.reasonCode}`;
    let row = rows.get(key);
    if (!row) {
      row = { key, count: 0, totalMin: 0, lastAt: s.start };
      if (by !== 'reason') row.equipmentId = s.equipmentId;
      if (by !== 'equipment') row.reasonCode = s.reasonCode;
      rows.set(key, row);
    }
    row.count++;
    row.totalMin += clippedMinutes(s, window);
    row.lastAt = Math.max(row.lastAt, s.start);
    if (by !== 'equipment' && s.reasonLabel && s.start >= (labelAt.get(key) ?? -Infinity)) {
      row.reasonLabel = s.reasonLabel;
      labelAt.set(key, s.start);
    }
  }
  return [...rows.values()]
    .filter((r) => r.count >= minCount)
    .sort((a, b) => b.count - a.count || b.totalMin - a.totalMin || b.lastAt - a.lastAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Whether the given stops (typically one equipment item's own stops) repeat: unplanned stops starting
 * inside the window, counted. 'ok' ONLY when there are at least `minCount` of them — value = count and the
 * first / last start. Fewer → 'insufficient' with the count in the reason: that means "not repeated",
 * not missing data. An empty window or minCount < 1 → 'invalid'.
 */
export function repeatedStops(stops: StopRecord[], window: Window, minCount: number): Calc<{ count: number; first: number; last: number }> {
  if (!validWindow(window)) return invalid('The window is empty or not a valid time range');
  if (!isNum(minCount) || minCount < 1) return invalid('The repeat threshold must be at least 1');
  const starts = stops
    .filter((s) => !s.planned && startsIn(s, window))
    .map((s) => s.start)
    .sort((a, b) => a - b);
  if (starts.length < minCount)
    return insufficient(`${plural(starts.length, 'unplanned stop')} in the window — below the repeat threshold of ${fmt(minCount)}`);
  return ok({ count: starts.length, first: starts[0], last: starts[starts.length - 1] });
}

/**
 * MTBF (hours) = operating minutes ÷ 60 ÷ failures, and MTTR (minutes) = mean duration of the failures
 * that have ended. Failures are unplanned stops starting inside the window; MTTR uses their full duration
 * (not clipped), and open stops are left out of MTTR with a note. `operatingMin` is the operating time of
 * the equipment the stops belong to (equipment-minutes when several items are pooled). No failures →
 * MTBF 'unavailable' (not infinite); no completed repair → MTTR 'unavailable'; missing operating time →
 * MTBF 'unavailable'; negative operating time or an empty window → 'invalid'.
 */
export function mtbfMttr(stops: StopRecord[], window: Window, operatingMin: number | null): { mtbfH: Calc<number>; mttrMin: Calc<number> } {
  if (!validWindow(window)) {
    const r = invalid<number>('The window is empty or not a valid time range');
    return { mtbfH: r, mttrMin: r };
  }
  const failures = stops.filter((s) => !s.planned && startsIn(s, window));
  const closed = failures.filter((s) => s.end != null);
  let mtbfH: Calc<number>;
  if (!isNum(operatingMin)) mtbfH = unavailable('Operating time not reported');
  else if (operatingMin < 0) mtbfH = invalid('Negative operating time');
  else if (!failures.length) mtbfH = unavailable(`No unplanned stop in the window — MTBF not defined (${fmt(operatingMin / 60, 1)} operating h without one)`);
  else mtbfH = ok(operatingMin / 60 / failures.length, `${plural(failures.length, 'failure')} in ${fmt(operatingMin / 60, 1)} operating h`);
  let mttrMin: Calc<number>;
  if (!failures.length) mttrMin = unavailable('No unplanned stop in the window');
  else if (!closed.length) mttrMin = unavailable(`No completed repair yet — ${plural(failures.length, 'stop')} still open`);
  else {
    const mean = closed.reduce((a, s) => a + ((s.end as number) - s.start), 0) / closed.length;
    const open = failures.length - closed.length;
    mttrMin = ok(mean, open ? `${plural(open, 'open stop')} not included` : undefined);
  }
  return { mtbfH, mttrMin };
}

/**
 * The `n` longest stops overlapping the window, by minutes inside the window (open stops run to
 * window.to), longest first; ties put the most recent first. Planned stops are left out unless
 * `opts.includePlanned` (an optional addition to the planned signature). Returns copies with `minutes`.
 */
export function longestStops(
  stops: StopRecord[],
  window: Window,
  n: number,
  opts: { includePlanned?: boolean } = {},
): (StopRecord & { minutes: number })[] {
  if (!validWindow(window) || !isNum(n) || n < 1) return [];
  return stops
    .filter((s) => opts.includePlanned || !s.planned)
    .map((s) => ({ ...s, minutes: clippedMinutes(s, window) }))
    .filter((s) => s.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes || b.start - a.start)
    .slice(0, Math.floor(n));
}
