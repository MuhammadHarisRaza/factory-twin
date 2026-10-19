import { describe, expect, it } from 'vitest';
import * as calc from '../index';

describe('calc barrel', () => {
  const api = [
    // types.ts helpers
    'ok',
    'unavailable',
    'insufficient',
    'invalid',
    // the planned API, module by module
    'counterDelta',
    'counterRate',
    'productionRate',
    'varianceVsTarget',
    'cycleTimeSec',
    'histogram',
    'availability',
    'downtimeMinutes',
    'rejectRate',
    'firstPassYield',
    'proportionChange',
    'trendSlope',
    'flowBalance',
    'timeToEmpty',
    'timeToFull',
    'massFromLevel',
    'stateDurations',
    'stateTransitions',
    'mergeSegments',
    'faultRecurrence',
    'repeatedStops',
    'mtbfMttr',
    'longestStops',
    'freshness',
    'setpointDeviation',
    'deviationEpisodes',
    'withinLimitsShare',
    'seriesToSamples',
    'gaps',
    'outOfRange',
    'stats',
    'convert',
    'tilesToMassT',
  ] as const;
  it.each(api)('exports %s', (name) => {
    expect(typeof calc[name]).toBe('function');
  });

  it('exports the unit table', () => {
    expect(calc.UNIT_DIMENSION['t/h']).toBe('mass-rate');
  });

  it('keeps the Calc helpers honest: no value unless ok', () => {
    expect(calc.ok(0)).toEqual({ status: 'ok', value: 0 });
    expect(calc.unavailable('No data')).toEqual({ status: 'unavailable', value: null, reason: 'No data' });
  });
});
