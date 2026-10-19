import { describe, expect, it } from 'vitest';
import { faultRecurrence, longestStops, mtbfMttr, repeatedStops } from '../recurrence';
import type { StopRecord, Window } from '../types';

const W: Window = { from: 0, to: 480 };
const stop = (equipmentId: string, reasonCode: string, start: number, end: number | null, extra: Partial<StopRecord> = {}): StopRecord => ({
  equipmentId,
  reasonCode,
  start,
  end,
  ...extra,
});

const stops: StopRecord[] = [
  stop('E-PRS1', 'JAM', 20, 30, { reasonLabel: 'Die jam' }),
  stop('E-PRS1', 'JAM', 100, 104),
  stop('E-PRS1', 'JAM', 300, 312, { reasonLabel: 'Die jam (ejector)' }),
  stop('E-PRS2', 'JAM', 200, 205, { reasonLabel: 'Die jam' }),
  stop('E-PRS1', 'HYD', 150, 190, { reasonLabel: 'Hydraulic pressure low' }),
  stop('E-PRS1', 'CLEAN', 400, 430, { planned: true, reasonLabel: 'Cleaning' }),
  stop('E-PRS1', 'JAM', -30, 5), // started before the window
  stop('E-PRS2', 'MOTOR', 470, null, { reasonLabel: 'Motor trip' }), // still open
];

describe('faultRecurrence', () => {
  it('groups by equipment and reason (default), most frequent first', () => {
    expect(faultRecurrence(stops, W)).toEqual([
      { key: 'E-PRS1|JAM', equipmentId: 'E-PRS1', reasonCode: 'JAM', reasonLabel: 'Die jam (ejector)', count: 3, totalMin: 26, lastAt: 300 },
      { key: 'E-PRS1|HYD', equipmentId: 'E-PRS1', reasonCode: 'HYD', reasonLabel: 'Hydraulic pressure low', count: 1, totalMin: 40, lastAt: 150 },
      { key: 'E-PRS2|MOTOR', equipmentId: 'E-PRS2', reasonCode: 'MOTOR', reasonLabel: 'Motor trip', count: 1, totalMin: 10, lastAt: 470 },
      { key: 'E-PRS2|JAM', equipmentId: 'E-PRS2', reasonCode: 'JAM', reasonLabel: 'Die jam', count: 1, totalMin: 5, lastAt: 200 },
    ]);
  });

  const cases: { name: string; opts: Parameters<typeof faultRecurrence>[2]; keys: string[]; counts: number[] }[] = [
    { name: 'by reason across machines', opts: { by: 'reason' }, keys: ['JAM', 'HYD', 'MOTOR'], counts: [4, 1, 1] },
    { name: 'by equipment', opts: { by: 'equipment' }, keys: ['E-PRS1', 'E-PRS2'], counts: [4, 2] },
    { name: 'recurring only (minCount 2)', opts: { minCount: 2 }, keys: ['E-PRS1|JAM'], counts: [3] },
    { name: 'with planned stops', opts: { by: 'reason', includePlanned: true }, keys: ['JAM', 'HYD', 'CLEAN', 'MOTOR'], counts: [4, 1, 1, 1] },
  ];
  it.each(cases)('$name', ({ opts, keys, counts }) => {
    const rows = faultRecurrence(stops, W, opts);
    expect(rows.map((r) => r.key)).toEqual(keys);
    expect(rows.map((r) => r.count)).toEqual(counts);
  });

  it('omits the equipment when grouping by reason and the reason when grouping by equipment', () => {
    const [byReason] = faultRecurrence(stops, W, { by: 'reason' });
    expect(byReason.equipmentId).toBeUndefined();
    expect(byReason.reasonCode).toBe('JAM');
    const [byEquipment] = faultRecurrence(stops, W, { by: 'equipment' });
    expect(byEquipment.reasonCode).toBeUndefined();
    expect(byEquipment.reasonLabel).toBeUndefined();
  });

  it('is empty for an empty window', () => {
    expect(faultRecurrence(stops, { from: 10, to: 10 })).toEqual([]);
  });
});

describe('repeatedStops', () => {
  const cases: { name: string; window: Window; minCount: number; status: string; value?: { count: number; first: number; last: number } }[] = [
    { name: 'six unplanned stops in the shift', window: W, minCount: 3, status: 'ok', value: { count: 6, first: 20, last: 470 } },
    { name: 'exactly at the threshold', window: { from: 0, to: 120 }, minCount: 2, status: 'ok', value: { count: 2, first: 20, last: 100 } },
    { name: 'below the threshold is "not repeated"', window: { from: 0, to: 120 }, minCount: 3, status: 'insufficient' },
    { name: 'no stops at all', window: { from: 1000, to: 1100 }, minCount: 1, status: 'insufficient' },
    { name: 'planned stops do not count', window: { from: 390, to: 440 }, minCount: 1, status: 'insufficient' },
    { name: 'an empty window', window: { from: 5, to: 5 }, minCount: 1, status: 'invalid' },
    { name: 'a threshold below 1', window: W, minCount: 0, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ window, minCount, status, value }) => {
    const r = repeatedStops(stops, window, minCount);
    expect(r.status).toBe(status);
    expect(r.value).toEqual(value ?? null);
  });

  it('puts the count in the reason when the stops do not repeat', () => {
    const r = repeatedStops(stops, { from: 0, to: 120 }, 3);
    expect(r.status !== 'ok' && r.reason).toBe('2 unplanned stops in the window — below the repeat threshold of 3');
  });
});

describe('mtbfMttr', () => {
  it('computes MTBF from operating time and MTTR from completed repairs', () => {
    const { mtbfH, mttrMin } = mtbfMttr(stops, W, 360);
    // 6 unplanned stops start in the window; 5 of them have ended (10 + 4 + 12 + 5 + 40 = 71 min).
    expect(mtbfH.status).toBe('ok');
    expect(mtbfH.value).toBeCloseTo(1, 9);
    expect(mttrMin.value).toBeCloseTo(71 / 5, 9);
    expect(mttrMin.status === 'ok' && mttrMin.note).toBe('1 open stop not included');
  });

  it('uses the full duration of a repair that ends after the window', () => {
    const { mttrMin } = mtbfMttr([stop('A', 'X', 470, 500)], W, 400);
    expect(mttrMin.value).toBe(30);
  });

  const cases: { name: string; stops: StopRecord[]; window: Window; operating: number | null; mtbf: string; mttr: string }[] = [
    { name: 'no failures: neither is defined', stops: [], window: W, operating: 480, mtbf: 'unavailable', mttr: 'unavailable' },
    {
      name: 'only planned stops are not failures',
      stops: [stop('A', 'CLEAN', 10, 40, { planned: true })],
      window: W,
      operating: 450,
      mtbf: 'unavailable',
      mttr: 'unavailable',
    },
    { name: 'only an open stop', stops: [stop('A', 'X', 100, null)], window: W, operating: 100, mtbf: 'ok', mttr: 'unavailable' },
    { name: 'missing operating time', stops: [stop('A', 'X', 100, 110)], window: W, operating: null, mtbf: 'unavailable', mttr: 'ok' },
    { name: 'negative operating time', stops: [stop('A', 'X', 100, 110)], window: W, operating: -5, mtbf: 'invalid', mttr: 'ok' },
    { name: 'an empty window', stops: [stop('A', 'X', 100, 110)], window: { from: 9, to: 9 }, operating: 100, mtbf: 'invalid', mttr: 'invalid' },
  ];
  it.each(cases)('$name', ({ stops: list, window, operating, mtbf, mttr }) => {
    const r = mtbfMttr(list, window, operating);
    expect(r.mtbfH.status).toBe(mtbf);
    expect(r.mttrMin.status).toBe(mttr);
    if (mtbf !== 'ok') expect(r.mtbfH.value).toBeNull();
    if (mttr !== 'ok') expect(r.mttrMin.value).toBeNull();
  });
});

describe('longestStops', () => {
  it('lists the longest unplanned stops by minutes inside the window', () => {
    const top = longestStops(stops, W, 3);
    expect(top.map((s) => [s.reasonCode, s.start, s.minutes])).toEqual([
      ['HYD', 150, 40],
      ['JAM', 300, 12],
      ['MOTOR', 470, 10],
    ]);
  });

  it('clips at the window, runs open stops to its end, and breaks ties by the most recent', () => {
    const top = longestStops(stops, W, 10);
    expect(top.find((s) => s.start === -30)?.minutes).toBe(5);
    expect(top.find((s) => s.end === null)?.minutes).toBe(10);
    // MOTOR (470, open) and JAM (20–30) both have 10 min: the more recent comes first.
    expect(top.filter((s) => s.minutes === 10).map((s) => s.start)).toEqual([470, 20]);
  });

  const cases: { name: string; n: number; includePlanned?: boolean; length: number; first?: number }[] = [
    { name: 'planned stops on request', n: 1, includePlanned: true, length: 1, first: 40 },
    { name: 'n larger than the list', n: 50, length: 7 },
    { name: 'n = 0', n: 0, length: 0 },
  ];
  it.each(cases)('$name', ({ n, includePlanned, length, first }) => {
    const top = longestStops(stops, W, n, { includePlanned });
    expect(top).toHaveLength(length);
    if (first !== undefined) expect(top[0].minutes).toBe(first);
  });
});
