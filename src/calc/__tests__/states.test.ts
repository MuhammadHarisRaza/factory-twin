import { describe, expect, it } from 'vitest';
import { mergeSegments, stateDurations, stateTransitions } from '../states';
import type { StateSegment, Window } from '../types';

type S = 'running' | 'starved' | 'fault' | 'planned';
const seg = (from: number, to: number, state: S, reason?: string): StateSegment<S> => (reason ? { from, to, state, reason } : { from, to, state });

const shift: StateSegment<S>[] = [
  seg(0, 60, 'running'),
  seg(60, 75, 'fault', 'jam'),
  seg(75, 120, 'running'),
  seg(120, 130, 'starved'),
  seg(130, 180, 'running'),
];

describe('stateDurations', () => {
  const cases: { name: string; segments: StateSegment<S>[]; window: Window; want: Partial<Record<S, number>> }[] = [
    { name: 'whole timeline', segments: shift, window: { from: 0, to: 180 }, want: { running: 155, fault: 15, starved: 10 } },
    { name: 'clipped to a window', segments: shift, window: { from: 70, to: 125 }, want: { fault: 5, running: 45, starved: 5 } },
    { name: 'a state with no time in the window is absent, not 0', segments: shift, window: { from: 0, to: 30 }, want: { running: 30 } },
    {
      name: 'uncovered time is not attributed to a state',
      segments: [seg(0, 10, 'running'), seg(20, 30, 'running')],
      window: { from: 0, to: 40 },
      want: { running: 20 },
    },
    { name: 'an open segment (to = Infinity) is clipped', segments: [seg(100, Infinity, 'planned')], window: { from: 0, to: 160 }, want: { planned: 60 } },
    {
      name: 'malformed and zero-length segments are ignored',
      segments: [seg(10, 5, 'fault'), seg(Number.NaN, 5, 'fault'), seg(5, 5, 'fault'), seg(0, 10, 'running')],
      window: { from: 0, to: 10 },
      want: { running: 10 },
    },
    { name: 'an empty window', segments: shift, window: { from: 50, to: 50 }, want: {} },
    { name: 'no segments', segments: [], window: { from: 0, to: 60 }, want: {} },
  ];
  it.each(cases)('$name', ({ segments, window, want }) => {
    expect(stateDurations(segments, window)).toEqual(want);
  });
});

describe('stateTransitions', () => {
  it('lists every change in time order', () => {
    expect(stateTransitions(shift)).toEqual([
      { at: 60, from: 'running', to: 'fault' },
      { at: 75, from: 'fault', to: 'running' },
      { at: 120, from: 'running', to: 'starved' },
      { at: 130, from: 'starved', to: 'running' },
    ]);
  });

  const cases: { name: string; segments: StateSegment<S>[]; want: { at: number; from: S; to: S }[] }[] = [
    { name: 'unsorted input', segments: [seg(10, 20, 'fault'), seg(0, 10, 'running')], want: [{ at: 10, from: 'running', to: 'fault' }] },
    { name: 'same state twice is not a transition', segments: [seg(0, 10, 'running'), seg(10, 20, 'running')], want: [] },
    { name: 'a gap: the change is at the next segment', segments: [seg(0, 10, 'running'), seg(25, 30, 'fault')], want: [{ at: 25, from: 'running', to: 'fault' }] },
    { name: 'one segment', segments: [seg(0, 10, 'running')], want: [] },
    { name: 'none', segments: [], want: [] },
  ];
  it.each(cases)('$name', ({ segments, want }) => {
    expect(stateTransitions(segments)).toEqual(want);
  });
});

describe('mergeSegments', () => {
  const cases: { name: string; segments: StateSegment<S>[]; want: StateSegment<S>[] }[] = [
    { name: 'adjacent same state', segments: [seg(0, 10, 'running'), seg(10, 20, 'running')], want: [seg(0, 20, 'running')] },
    { name: 'overlapping same state', segments: [seg(0, 15, 'running'), seg(10, 20, 'running')], want: [seg(0, 20, 'running')] },
    { name: 'a contained segment', segments: [seg(0, 30, 'running'), seg(10, 20, 'running')], want: [seg(0, 30, 'running')] },
    { name: 'a gap keeps them apart', segments: [seg(0, 10, 'running'), seg(12, 20, 'running')], want: [seg(0, 10, 'running'), seg(12, 20, 'running')] },
    { name: 'different states stay apart', segments: [seg(0, 10, 'running'), seg(10, 20, 'fault')], want: [seg(0, 10, 'running'), seg(10, 20, 'fault')] },
    {
      name: 'same state, different reason stays apart',
      segments: [seg(0, 10, 'fault', 'jam'), seg(10, 20, 'fault', 'motor')],
      want: [seg(0, 10, 'fault', 'jam'), seg(10, 20, 'fault', 'motor')],
    },
    { name: 'same state and reason merges', segments: [seg(0, 10, 'fault', 'jam'), seg(10, 20, 'fault', 'jam')], want: [seg(0, 20, 'fault', 'jam')] },
    { name: 'unsorted, with a zero-length one', segments: [seg(10, 20, 'running'), seg(5, 5, 'fault'), seg(0, 10, 'running')], want: [seg(0, 20, 'running')] },
  ];
  it.each(cases)('$name', ({ segments, want }) => {
    expect(mergeSegments(segments)).toEqual(want);
  });

  it('does not change its input', () => {
    const input = [seg(0, 10, 'running'), seg(10, 20, 'running')];
    const copy = structuredClone(input);
    mergeSegments(input);
    expect(input).toEqual(copy);
  });
});
