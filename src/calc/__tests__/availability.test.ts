import { describe, expect, it } from 'vitest';
import { availability, downtimeMinutes } from '../availability';
import type { StopRecord, Window } from '../types';

describe('availability', () => {
  const cases: { name: string; operating: number | null; planned: number | null; status: string; value?: number }[] = [
    { name: 'textbook 373 of 420 min', operating: 373, planned: 420, status: 'ok', value: 373 / 420 },
    { name: 'a genuine 0 is 0, not unavailable', operating: 0, planned: 60, status: 'ok', value: 0 },
    { name: 'fully available', operating: 60, planned: 60, status: 'ok', value: 1 },
    { name: 'rounding just above planned is capped at 1', operating: 60.2, planned: 60, status: 'ok', value: 1 },
    { name: 'missing operating time', operating: null, planned: 60, status: 'unavailable' },
    { name: 'missing planned time', operating: 30, planned: null, status: 'unavailable' },
    { name: 'no planned time (division by zero)', operating: 0, planned: 0, status: 'unavailable' },
    { name: 'operating above planned', operating: 75, planned: 60, status: 'invalid' },
    { name: 'negative time', operating: -1, planned: 60, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ operating, planned, status, value }) => {
    const r = availability(operating, planned);
    expect(r.status).toBe(status);
    if (value === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(value, 9);
  });

  it('says why it capped a rounding overshoot', () => {
    const r = availability(60.2, 60);
    expect(r.status === 'ok' && r.note).toMatch(/rounding/);
  });
});

describe('downtimeMinutes', () => {
  const w: Window = { from: 100, to: 200 };
  const stop = (equipmentId: string, start: number, end: number | null, planned = false): StopRecord => ({ equipmentId, start, end, reasonCode: 'X', planned });

  const cases: { name: string; stops: StopRecord[]; window?: Window; includePlanned?: boolean; minutes: number }[] = [
    { name: 'no stops is 0', stops: [], minutes: 0 },
    { name: 'a stop inside the window', stops: [stop('A', 120, 135)], minutes: 15 },
    { name: 'clipped at the window start', stops: [stop('A', 90, 110)], minutes: 10 },
    { name: 'clipped at the window end', stops: [stop('A', 190, 230)], minutes: 10 },
    { name: 'an open stop runs to the window end', stops: [stop('A', 150, null)], minutes: 50 },
    { name: 'an open stop that started before the window covers all of it', stops: [stop('A', 50, null)], minutes: 100 },
    { name: 'stops outside the window do not count', stops: [stop('A', 10, 20), stop('A', 200, 250), stop('A', 250, null)], minutes: 0 },
    { name: 'planned stops are left out by default', stops: [stop('A', 120, 130), stop('A', 140, 170, true)], minutes: 10 },
    { name: 'planned stops on request', stops: [stop('A', 120, 130), stop('A', 140, 170, true)], includePlanned: true, minutes: 40 },
    { name: 'overlapping records of one machine count once', stops: [stop('A', 120, 140), stop('A', 130, 150)], minutes: 30 },
    { name: 'different machines add up (equipment-minutes)', stops: [stop('A', 120, 140), stop('B', 130, 150)], minutes: 40 },
    { name: 'malformed records are skipped', stops: [stop('A', 150, 140), stop('A', Number.NaN, 160), stop('A', 110, 115)], minutes: 5 },
    { name: 'an empty window is 0', stops: [stop('A', 120, 130)], window: { from: 200, to: 200 }, minutes: 0 },
  ];
  it.each(cases)('$name', ({ stops, window, includePlanned, minutes }) => {
    expect(downtimeMinutes(stops, window ?? w, { includePlanned })).toBe(minutes);
  });
});
