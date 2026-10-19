/**
 * The calculation library (brief §10 / §12): pure functions over numbers, samples and records — no
 * SimState, no React — shared by the rules, the panels and the pages, on simulated data today and on a
 * real adapter's data later. Missing, zero-denominator and invalid inputs return a `Calc` with a reason.
 */
export * from './types';
export * from './counter';
export * from './rate';
export * from './cycle';
export * from './availability';
export * from './quality';
export * from './buffer';
export * from './states';
export * from './recurrence';
export * from './freshness';
export * from './setpoint';
export * from './series';
export * from './units';
