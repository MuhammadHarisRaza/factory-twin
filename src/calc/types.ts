/**
 * Shared types of the calculation library (src/calc). The functions are pure and SimState-free: they
 * take plain numbers, samples and records, so the same code runs on simulated data and on data from a
 * future real adapter. Missing input never becomes zero: a result is either a value with status 'ok'
 * or null with a status and a reason the UI can show.
 */

/** Quality of a sample as a data consumer sees it. 'missing' = no sample where one was expected. */
export type Quality = 'good' | 'uncertain' | 'bad' | 'stale' | 'missing';

/** One timestamped sample. `t` is a plant minute (the simulation's clock; a real adapter converts). */
export type Sample = { t: number; v: number | null; q?: Quality };

/**
 * A regularly stepped series: t[i] = from + i × stepMin. A null in `v` is a gap (no sample, a bad or
 * stale sample) and is never drawn or counted as zero.
 */
export type Series = {
  t: number[];
  v: (number | null)[];
  /** Per-sample quality, when known (same length as v). */
  q?: Quality[];
  stepMin: number;
  unit: string | null;
};

/** A computed figure, or the honest reason there is none. */
export type Calc<T> =
  | { status: 'ok'; value: T; note?: string }
  | { status: 'unavailable' | 'insufficient' | 'invalid'; value: null; reason: string };

export const ok = <T>(value: T, note?: string): Calc<T> => (note ? { status: 'ok', value, note } : { status: 'ok', value });
export const unavailable = <T = never>(reason: string): Calc<T> => ({ status: 'unavailable', value: null, reason });
export const insufficient = <T = never>(reason: string): Calc<T> => ({ status: 'insufficient', value: null, reason });
export const invalid = <T = never>(reason: string): Calc<T> => ({ status: 'invalid', value: null, reason });

/** A time interval in plant minutes, [from, to). */
export type Window = { from: number; to: number };

/** A state interval (an equipment state from a state signal or stop records). */
export type StateSegment<S extends string = string> = { from: number; to: number; state: S; label?: string; reason?: string };

/** A stop / fault record as the reliability calculations need it. */
export type StopRecord = { start: number; end: number | null; equipmentId: string; reasonCode: string; reasonLabel?: string; planned?: boolean };
