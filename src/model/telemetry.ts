/**
 * Telemetry contract (brief §6B / §12): how charts, signal tables and rules read current values and
 * history, independent of where the data comes from. The demo implements it over the simulation
 * (src/sim/telemetry.ts `simulatedSource`); a real adapter (PLC gateway, SCADA, historian, MES, QMS,
 * WMS) would implement the same interface — the UI and the rules do not change.
 */
import type { Quality, Series, StateSegment } from '../calc/types';
import type { AvailabilityStatus } from './catalog/types';
import type { OperationalState } from './types';

/** Time ranges offered by charts. */
export type RangeKey = '15m' | '1h' | '8h' | '24h' | '7d';

export type RangeOption = {
  key: RangeKey;
  label: string;
  minutes: number;
  /** Sample step used for the range (minute data up to 8 h, hourly beyond). */
  stepMin: number;
  resolution: 'minute' | 'hour';
};

export const RANGE_OPTIONS: RangeOption[] = [
  { key: '15m', label: '15 min', minutes: 15, stepMin: 1, resolution: 'minute' },
  { key: '1h', label: '1 h', minutes: 60, stepMin: 1, resolution: 'minute' },
  { key: '8h', label: '8 h', minutes: 480, stepMin: 5, resolution: 'minute' },
  { key: '24h', label: '24 h', minutes: 1440, stepMin: 60, resolution: 'hour' },
  { key: '7d', label: '7 days', minutes: 10080, stepMin: 60, resolution: 'hour' },
];

export const RANGE_BY_KEY: Record<RangeKey, RangeOption> = Object.fromEntries(RANGE_OPTIONS.map((r) => [r.key, r])) as Record<RangeKey, RangeOption>;

/** The current reading of one signal. */
export type TelemetrySample = {
  signalId: string;
  /** Number for analog / counter, string for enum / event, boolean for commands; null = no value. */
  value: number | string | boolean | null;
  /** Display text without the unit ('—' when there is no value). */
  text: string;
  unit: string | null;
  quality: Quality;
  /** Plant minute of the value (null = never received). Stale values keep their last timestamp. */
  timestamp: number | null;
  /** What the demo has for the signal (catalogue availabilityStatus, or 'not-modelled'/'unavailable' at read time). */
  status: AvailabilityStatus;
  /** Why there is no value / why it is not 'good' (e.g. 'Feed stale since 10:20', 'No calibration configured'). */
  note?: string;
};

/** A history series with what it covers. */
export type TelemetrySeries = Series & {
  signalId: string;
  resolution: 'minute' | 'hour';
  /** Where the history came from, e.g. 'minute log', 'hourly buckets', 'process model', 'condition model'. */
  source: string;
  status: AvailabilityStatus;
  /** Samples expected vs present in the window (for honest coverage notes). */
  coverage: { expected: number; present: number };
  /** Why part of the requested window has no data (e.g. 'Minute history covers the last 8 h'). */
  note?: string;
};

/** An equipment state interval in the brief's state vocabulary (OperationalState + changeover). */
export type EquipmentStateSegment = StateSegment<OperationalState | 'changeover'>;

/** The adapter boundary: every consumer reads telemetry through this. */
export interface TelemetrySource<S = unknown> {
  /** 'simulated' for the demo; 'connected' only for a verified real integration. */
  readonly kind: 'simulated' | 'connected';
  read(state: S, signalId: string): TelemetrySample;
  /** History of a numeric signal; null when the signal has no numeric history at all. */
  series(state: S, signalId: string, window: { from: number; to: number; stepMin: number }): TelemetrySeries | null;
  /** State intervals of an equipment item over a window (from its state signal and stop records). */
  states(state: S, equipmentId: string, window: { from: number; to: number }): EquipmentStateSegment[];
}
