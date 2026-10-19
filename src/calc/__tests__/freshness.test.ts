import { describe, expect, it } from 'vitest';
import { freshness, type Freshness } from '../freshness';

describe('freshness', () => {
  // Times are plant minutes; the interval is in seconds. now = minute 100.
  const now = 100;
  const cases: {
    name: string;
    last: number | null;
    intervalS: number | null;
    opts?: { lateFactor?: number; staleFactor?: number };
    want: Freshness;
  }[] = [
    { name: 'updated this minute', last: 100, intervalS: 60, want: { ageS: 0, status: 'fresh' } },
    { name: 'one interval old', last: 99, intervalS: 60, want: { ageS: 60, status: 'fresh' } },
    { name: 'exactly 2× the interval is still fresh', last: 98, intervalS: 60, want: { ageS: 120, status: 'fresh' } },
    { name: 'just over 2× is late', last: 97.5, intervalS: 60, want: { ageS: 150, status: 'late' } },
    { name: 'exactly 5× is late', last: 95, intervalS: 60, want: { ageS: 300, status: 'late' } },
    { name: 'over 5× is stale', last: 94, intervalS: 60, want: { ageS: 360, status: 'stale' } },
    { name: 'a fast signal one minute old is stale', last: 99, intervalS: 5, want: { ageS: 60, status: 'stale' } },
    { name: 'never received is missing', last: null, intervalS: 60, want: { ageS: null, status: 'missing' } },
    { name: 'event-driven signal: age shown, not judged', last: 40, intervalS: null, want: { ageS: 3600, status: 'event-driven' } },
    { name: 'a zero interval counts as event-driven', last: 40, intervalS: 0, want: { ageS: 3600, status: 'event-driven' } },
    { name: 'custom factors (late 1×, stale 3×)', last: 98, intervalS: 60, opts: { lateFactor: 1, staleFactor: 3 }, want: { ageS: 120, status: 'late' } },
    { name: 'custom factors: stale', last: 96, intervalS: 60, opts: { lateFactor: 1, staleFactor: 3 }, want: { ageS: 240, status: 'stale' } },
    {
      name: 'a stale factor below the late factor is raised to it',
      last: 97,
      intervalS: 60,
      opts: { lateFactor: 4, staleFactor: 2 },
      want: { ageS: 180, status: 'fresh' },
    },
    { name: 'a timestamp ahead of now counts as age 0', last: 100.5, intervalS: 60, want: { ageS: 0, status: 'fresh' } },
    { name: 'fractional minutes do not leave float noise', last: 99.9, intervalS: 60, want: { ageS: 6, status: 'fresh' } },
  ];
  it.each(cases)('$name', ({ last, intervalS, opts, want }) => {
    expect(freshness(last, now, intervalS, opts)).toEqual(want);
  });

  it('treats a non-finite clock as missing', () => {
    expect(freshness(10, Number.NaN, 60)).toEqual({ ageS: null, status: 'missing' });
  });
});
