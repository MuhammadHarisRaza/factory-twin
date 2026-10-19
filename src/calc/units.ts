/**
 * Units and conversions (brief §10). Every unit used by the signal catalogue has a dimension; a
 * conversion inside a dimension uses a fixed scale (kg ↔ t, min ↔ s, g/cm³ ↔ g/L). Anything else — tiles
 * to t/h, tiles to cartons, a level % to a mass — needs an explicit, disclosed factor: the library refuses
 * to guess one. Conversions are scale-only (no offset units such as K or °F).
 */
import { invalid, ok, unavailable, type Calc } from './types';
import { fmt, isNum } from './internal';

export type UnitDimension =
  | 'count'
  | 'area'
  | 'mass'
  | 'count-rate'
  | 'area-rate'
  | 'mass-rate'
  | 'volume-rate'
  | 'temperature'
  | 'pressure'
  | 'ratio'
  | 'vibration'
  | 'current'
  | 'rotational-speed'
  | 'frequency'
  | 'linear-speed'
  | 'time'
  | 'density'
  | 'power'
  | 'energy'
  | 'length'
  | 'force'
  | 'humidity'
  | 'areal-density';

/**
 * Dimension of every unit the calculations know. Tiles, cartons and pallets are all counts, but of different
 * things (as are tile-equivalents, the simulation's unit for slip and powder — not tiles).
 */
export const UNIT_DIMENSION: Readonly<Record<string, UnitDimension>> = {
  tiles: 'count',
  'tile-eq': 'count',
  cartons: 'count',
  pallets: 'count',
  trucks: 'count',
  stacks: 'count',
  docks: 'count',
  nozzles: 'count',
  cycles: 'count',
  changes: 'count',
  'm²': 'area',
  kg: 'mass',
  t: 'mass',
  'tiles/h': 'count-rate',
  'tile-eq/h': 'count-rate',
  'cartons/h': 'count-rate',
  'pallets/h': 'count-rate',
  'm²/h': 'area-rate',
  'kg/h': 'mass-rate',
  't/h': 'mass-rate',
  'Nm³/h': 'volume-rate',
  'L/min': 'volume-rate',
  '°C': 'temperature',
  bar: 'pressure',
  mbar: 'pressure',
  Pa: 'pressure',
  '%': 'ratio',
  '%RH': 'humidity',
  mm: 'length',
  N: 'force',
  'g/m²': 'areal-density',
  ms: 'time',
  'mm/s RMS': 'vibration',
  A: 'current',
  rpm: 'rotational-speed',
  '1/min': 'frequency',
  'm/min': 'linear-speed',
  s: 'time',
  min: 'time',
  h: 'time',
  'g/cm³': 'density',
  'g/L': 'density',
  kW: 'power',
  kWh: 'energy',
};

/**
 * Fixed scale of a unit to its dimension's base unit (kg, kg/h, Pa, s, g/L …). Count units have none: tiles,
 * cartons and pallets convert only with an explicit factor (tiles per carton, cartons per pallet). Nor has
 * L/min: a liquid flow is not convertible to a gas flow in normal cubic metres (Nm³/h) by a fixed factor.
 */
export const UNIT_SCALE: Readonly<Record<string, number>> = {
  'm²': 1,
  kg: 1,
  t: 1000,
  'm²/h': 1,
  'kg/h': 1,
  't/h': 1000,
  'Nm³/h': 1,
  '°C': 1,
  Pa: 1,
  mbar: 100,
  bar: 100_000,
  '%': 1,
  '%RH': 1,
  mm: 1,
  N: 1,
  'g/m²': 1,
  ms: 0.001,
  'mm/s RMS': 1,
  A: 1,
  rpm: 1,
  '1/min': 1,
  'm/min': 1,
  s: 1,
  min: 60,
  h: 3600,
  'g/L': 1,
  'g/cm³': 1000,
  kW: 1,
  kWh: 1,
};

/** The dimension of a unit, or null when the unit is not known. */
export const dimensionOf = (unit: string): UnitDimension | null => (Object.hasOwn(UNIT_DIMENSION, unit) ? UNIT_DIMENSION[unit] : null);

/** The fixed from → to factor of two units of the same dimension, or null when there is none. */
function fixedFactor(from: string, to: string): number | null {
  if (from === to) return 1;
  const df = dimensionOf(from);
  if (!df || df !== dimensionOf(to) || !Object.hasOwn(UNIT_SCALE, from) || !Object.hasOwn(UNIT_SCALE, to)) return null;
  return UNIT_SCALE[from] / UNIT_SCALE[to];
}

/**
 * The factor that converts `from` into `to` (multiply by it). Same unit → 1; same dimension with fixed
 * scales → that ratio. An explicit `factor` (to-units per from-unit, must be positive) is accepted for any
 * pair, including units not in the table, unless it contradicts a fixed ratio. Without a factor, unknown
 * units, a different dimension, or two count units → 'invalid' (refused, never guessed).
 */
export function conversionFactor(from: string, to: string, factor?: number): Calc<number> {
  const fixed = fixedFactor(from, to);
  if (factor !== undefined) {
    if (!isNum(factor) || factor <= 0) return invalid(`Conversion factor must be a positive number (got ${factor})`);
    if (fixed !== null && Math.abs(factor - fixed) > 1e-9 * Math.max(1, fixed))
      return invalid(`Factor ${fmt(factor, 6)} contradicts the fixed ${from} → ${to} factor ${fmt(fixed, 6)}`);
    return ok(factor, fixed === null ? `${from} → ${to} with an explicit factor ×${fmt(factor, 6)}` : undefined);
  }
  if (fixed !== null) return ok(fixed);
  const df = dimensionOf(from);
  const dt = dimensionOf(to);
  if (!df) return invalid(`Unknown unit '${from}'`);
  if (!dt) return invalid(`Unknown unit '${to}'`);
  if (df !== dt) return invalid(`Cannot convert ${from} (${df}) to ${to} (${dt}) without an explicit factor`);
  return invalid(`No fixed factor between ${from} and ${to} — pass an explicit factor`);
}

/**
 * Converts a value between units (see conversionFactor for what is accepted). A unit problem is reported
 * before a missing value, so a misconfigured conversion is visible even while there is no data. A missing
 * value → 'unavailable'. Negative values are allowed (deviations, temperatures).
 */
export function convert(value: number | null, from: string, to: string, factor?: number): Calc<number> {
  const f = conversionFactor(from, to, factor);
  if (f.status !== 'ok') return f;
  if (!isNum(value)) return unavailable('Value not reported');
  return ok(value * f.value, f.note);
}

/**
 * Tile count → tonnes of dry body, with a stated mass per tile (a simulated assumption in this demo,
 * e.g. KG_PER_TILE from the catalogue); the note discloses the factor. Missing count → 'unavailable';
 * negative count or a non-positive factor → 'invalid'.
 */
export function tilesToMassT(tiles: number | null, kgPerTile: number): Calc<number> {
  if (!isNum(kgPerTile) || kgPerTile <= 0) return invalid('Mass per tile must be a positive number');
  if (!isNum(tiles)) return unavailable('Tile count not reported');
  if (tiles < 0) return invalid('Negative tile count');
  return ok((tiles * kgPerTile) / 1000, `Assumes ${fmt(kgPerTile)} kg per tile`);
}
