/**
 * Equipment state intervals (brief §10): time in each state over a window, state transitions, and
 * merging of adjacent intervals. Segments are [from, to) in plant minutes and are assumed not to overlap
 * (one state at a time, as a state signal reports it); `to` may be Infinity for a state still in force.
 */
import type { StateSegment, Window } from './types';
import { isNum, validWindow } from './internal';

export type StateTransition<S extends string> = { at: number; from: S; to: S };

/** Segments with a finite start and an end after it (zero-length and malformed segments are dropped), as copies in time order. */
function ordered<S extends string>(segments: StateSegment<S>[]): StateSegment<S>[] {
  return segments
    .filter((s) => isNum(s.from) && !Number.isNaN(s.to) && s.to > s.from)
    .map((s) => ({ ...s }))
    .sort((a, b) => a.from - b.from);
}

/**
 * Minutes per state inside the window: each segment is clipped to [window.from, window.to). States with
 * no time in the window are absent (not 0), and time the segments do not cover is not attributed to any
 * state — the caller can show it as 'no data'. An empty or invalid window gives {}.
 */
export function stateDurations<S extends string>(segments: StateSegment<S>[], window: Window): Partial<Record<S, number>> {
  const out: Partial<Record<S, number>> = {};
  if (!validWindow(window)) return out;
  for (const seg of ordered(segments)) {
    const from = Math.max(seg.from, window.from);
    const to = Math.min(seg.to, window.to);
    if (to > from) out[seg.state] = (out[seg.state] ?? 0) + (to - from);
  }
  return out;
}

/**
 * State changes in time order: one entry where a segment's state differs from the previous segment's.
 * A gap between two segments (state unknown) is not a state of its own; the change is reported at the
 * start of the next segment. Consecutive segments in the same state are not a transition.
 */
export function stateTransitions<S extends string>(segments: StateSegment<S>[]): StateTransition<S>[] {
  const segs = ordered(segments);
  const out: StateTransition<S>[] = [];
  for (let i = 1; i < segs.length; i++) if (segs[i].state !== segs[i - 1].state) out.push({ at: segs[i].from, from: segs[i - 1].state, to: segs[i].state });
  return out;
}

/**
 * Merges segments that touch or overlap and have the same state and the same reason (a different reason
 * is a different stop and stays separate). The merged segment keeps the first segment's label. Returns
 * new objects in time order; the input is not changed. Zero-length and malformed segments are dropped.
 */
export function mergeSegments<S extends string>(segments: StateSegment<S>[]): StateSegment<S>[] {
  const out: StateSegment<S>[] = [];
  for (const seg of ordered(segments)) {
    const last = out[out.length - 1];
    if (last && last.state === seg.state && last.reason === seg.reason && seg.from <= last.to) last.to = Math.max(last.to, seg.to);
    else out.push(seg);
  }
  return out;
}
