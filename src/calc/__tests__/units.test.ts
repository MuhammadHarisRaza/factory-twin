import { describe, expect, it } from 'vitest';
import { conversionFactor, convert, dimensionOf, tilesToMassT, UNIT_DIMENSION } from '../units';

/** Simulated assumption used in the tests (0.36 m² × 21 kg/m²); the catalogue owns the real constant. */
const KG_PER_TILE = 7.56;

describe('UNIT_DIMENSION', () => {
  // Every engineering unit the signal catalogue uses for numeric signals.
  const catalogueUnits = [
    ...['tiles', 'tiles/h', '%', '°C', 'bar', 'kW', 'kWh', 'Nm³/h', 'mm/s RMS', 'A'],
    ...['m/min', 'rpm', 't/h', 'g/cm³', 'g/L', '1/min', 's', 'cartons', 'pallets'],
    // stage catalogue (src/model/catalog/stages) and the tile-equivalent registry units
    ...['Pa', 'mbar', 'mm', 'ms', 'N', 'L/min', 'g/m²', '%RH', 'tile-eq', 'tile-eq/h', 'min', 'h', 'kg', 't'],
  ];
  it.each(catalogueUnits)('knows %s', (unit) => {
    expect(dimensionOf(unit)).not.toBeNull();
  });

  it('separates the dimensions the brief keeps apart', () => {
    expect(UNIT_DIMENSION['tiles']).toBe('count');
    expect(UNIT_DIMENSION['m²']).toBe('area');
    expect(UNIT_DIMENSION['t']).toBe('mass');
    expect(UNIT_DIMENSION['t/h']).toBe('mass-rate');
    expect(UNIT_DIMENSION['tiles/h']).toBe('count-rate');
    expect(UNIT_DIMENSION['m²/h']).toBe('area-rate');
  });

  it('does not know an invented unit', () => {
    expect(dimensionOf('furlongs')).toBeNull();
    expect(dimensionOf('toString')).toBeNull();
  });
});

describe('convert', () => {
  const cases: { name: string; value: number | null; from: string; to: string; factor?: number; status: string; result?: number }[] = [
    { name: 'kg → t', value: 7560, from: 'kg', to: 't', status: 'ok', result: 7.56 },
    { name: 't → kg', value: 1.5, from: 't', to: 'kg', status: 'ok', result: 1500 },
    { name: 't/h → kg/h', value: 10.9, from: 't/h', to: 'kg/h', status: 'ok', result: 10900 },
    { name: 'g/cm³ → g/L', value: 1.7, from: 'g/cm³', to: 'g/L', status: 'ok', result: 1700 },
    { name: 'min → s', value: 2.5, from: 'min', to: 's', status: 'ok', result: 150 },
    { name: 's → h', value: 5400, from: 's', to: 'h', status: 'ok', result: 1.5 },
    { name: 'same unit', value: 42, from: '°C', to: '°C', status: 'ok', result: 42 },
    { name: 'same unknown unit is an identity', value: 3, from: 'docks', to: 'docks', status: 'ok', result: 3 },
    { name: 'negative values convert', value: -250, from: 'kg', to: 't', status: 'ok', result: -0.25 },
    { name: 'tile-eq. rate → t/h with a factor', value: 1440, from: 'tiles/h', to: 't/h', factor: KG_PER_TILE / 1000, status: 'ok', result: 10.8864 },
    { name: 'tiles → cartons with an explicit factor', value: 600, from: 'tiles', to: 'cartons', factor: 1 / 6, status: 'ok', result: 100 },
    { name: 'tiles → m² with an explicit factor', value: 100, from: 'tiles', to: 'm²', factor: 0.36, status: 'ok', result: 36 },
    { name: 'an explicit factor that agrees with the fixed one', value: 2000, from: 'kg', to: 't', factor: 0.001, status: 'ok', result: 2 },
    { name: 'bar → Pa', value: 2.5, from: 'bar', to: 'Pa', status: 'ok', result: 250000 },
    { name: 'mbar → bar', value: 40, from: 'mbar', to: 'bar', status: 'ok', result: 0.04 },
    { name: 'ms → s', value: 250, from: 'ms', to: 's', status: 'ok', result: 0.25 },
    { name: 'tile-eq → tiles without a factor (tile-equivalents are not tiles)', value: 10, from: 'tile-eq', to: 'tiles', status: 'invalid' },
    { name: 'L/min → Nm³/h without a factor (liquid vs normal gas volume)', value: 10, from: 'L/min', to: 'Nm³/h', status: 'invalid' },
    { name: '% → %RH without a factor', value: 10, from: '%', to: '%RH', status: 'invalid' },
    { name: 'unit mismatch: t/h → tiles/h without a factor', value: 10, from: 't/h', to: 'tiles/h', status: 'invalid' },
    { name: 'unit mismatch: % → t (no mass from a level)', value: 55, from: '%', to: 't', status: 'invalid' },
    { name: 'unit mismatch: tiles → t without a factor', value: 100, from: 'tiles', to: 't', status: 'invalid' },
    { name: 'two count units without a factor', value: 600, from: 'tiles', to: 'cartons', status: 'invalid' },
    { name: 'unknown source unit', value: 1, from: 'furlongs', to: 'm/min', status: 'invalid' },
    { name: 'unknown target unit', value: 1, from: 'm/min', to: 'furlongs', status: 'invalid' },
    { name: 'a factor that contradicts the fixed one', value: 5, from: 'kg', to: 't', factor: 1000, status: 'invalid' },
    { name: 'a non-positive factor', value: 5, from: 'tiles', to: 'cartons', factor: 0, status: 'invalid' },
    { name: 'missing value with valid units', value: null, from: 'kg', to: 't', status: 'unavailable' },
    { name: 'a unit problem is reported even without a value', value: null, from: 't/h', to: 'tiles/h', status: 'invalid' },
  ];
  it.each(cases)('$name', ({ value, from, to, factor, status, result }) => {
    const r = convert(value, from, to, factor);
    expect(r.status).toBe(status);
    if (result === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(result, 9);
  });

  it('explains a cross-dimension refusal', () => {
    const r = convert(10, 't/h', 'tiles/h');
    expect(r.status !== 'ok' && r.reason).toBe('Cannot convert t/h (mass-rate) to tiles/h (count-rate) without an explicit factor');
  });

  it('discloses an explicit factor', () => {
    const r = convert(1440, 'tiles/h', 't/h', KG_PER_TILE / 1000);
    expect(r.status === 'ok' && r.note).toBe('tiles/h → t/h with an explicit factor ×0.00756');
  });

  it('exposes the factor itself', () => {
    expect(conversionFactor('t', 'kg')).toEqual({ status: 'ok', value: 1000 });
  });
});

describe('tilesToMassT', () => {
  const cases: { name: string; tiles: number | null; kgPerTile: number; status: string; value?: number }[] = [
    { name: '1000 tiles', tiles: 1000, kgPerTile: KG_PER_TILE, status: 'ok', value: 7.56 },
    { name: 'zero tiles is 0 t', tiles: 0, kgPerTile: KG_PER_TILE, status: 'ok', value: 0 },
    { name: 'missing count', tiles: null, kgPerTile: KG_PER_TILE, status: 'unavailable' },
    { name: 'negative count', tiles: -1, kgPerTile: KG_PER_TILE, status: 'invalid' },
    { name: 'no mass per tile', tiles: 1000, kgPerTile: 0, status: 'invalid' },
  ];
  it.each(cases)('$name', ({ tiles, kgPerTile, status, value }) => {
    const r = tilesToMassT(tiles, kgPerTile);
    expect(r.status).toBe(status);
    if (value === undefined) expect(r.value).toBeNull();
    else expect(r.value).toBeCloseTo(value, 9);
  });

  it('discloses the assumption', () => {
    const r = tilesToMassT(1000, KG_PER_TILE);
    expect(r.status === 'ok' && r.note).toBe('Assumes 7.56 kg per tile');
  });
});
