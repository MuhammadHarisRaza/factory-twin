/**
 * Signals of one asset for "Technical details": every configured signal id (src/model/plant.ts
 * SIGNALS) with its unit, kind, current simulated value, the metrics it feeds, its source and how
 * the value is produced — so a placeholder process value is never mistaken for a measurement.
 */
import { DATA_SOURCES, SIGNALS } from '../../model/plant';
import type { MetricId, SignalDef } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { signalValue, type SignalReading } from '../../sim/signals';

export const METRIC_LABEL: Record<MetricId, string> = {
  availability: 'Availability',
  performance: 'Performance',
  quality: 'Quality',
  oee: 'OEE',
  output: 'Output',
  downtime: 'Downtime',
  rejects: 'Rejects',
  'buffer-level': 'Buffer level',
  energy: 'Process value',
  health: 'Condition',
  turnaround: 'Turnaround',
};

export const SIGNAL_KIND_LABEL: Record<SignalDef['kind'], string> = { state: 'State', counter: 'Counter', analog: 'Analog', event: 'Event' };

/** Analog process values without a physical model: bounded, smoothly varying placeholders (src/sim/signals.ts). */
const PLACEHOLDER = new Set(['temp_firing', 'temp_preheat', 'temp_inlet', 'powder_moisture', 'temp_deck', 'header_pressure', 'tank_level']);
/** Values of the illustrative energy model (not a product module; kept for data provenance only). */
const ENERGY_MODEL = new Set(['energy_kwh', 'active_power', 'gas_flow']);
const CONDITION = new Set(['vibration', 'temperature', 'motor_current']);

export type SignalBasis = 'engine' | 'condition' | 'placeholder' | 'energy-model';

export const BASIS_LABEL: Record<SignalBasis, string> = {
  engine: 'Simulation engine state',
  condition: 'Condition-monitoring model',
  placeholder: 'No physical model — value not shown',
  'energy-model': 'Energy is not monitored in this product',
};

export type SignalRow = {
  def: SignalDef;
  reading: SignalReading;
  /** Value with its unit where the unit is a physical one. */
  text: string;
  basis: SignalBasis;
  metrics: string;
  source: string;
};

const NO_UNIT = new Set(['enum', 'code', 'in/out', 'docks', 'pass/fail', 'zone id']);
const SOURCE_NAME = Object.fromEntries(DATA_SOURCES.map((d) => [d.id, d.name]));

export const basisOf = (name: string): SignalBasis =>
  PLACEHOLDER.has(name) ? 'placeholder' : ENERGY_MODEL.has(name) ? 'energy-model' : CONDITION.has(name) ? 'condition' : 'engine';

export function assetSignals(s: SimState, equipmentId: string): SignalRow[] {
  return SIGNALS.filter((d) => d.equipmentId === equipmentId).map((def) => {
    const reading = signalValue(s, def.id);
    const unit = typeof reading.value === 'number' && !NO_UNIT.has(def.unit) ? ` ${def.unit}` : '';
    const basis = basisOf(def.name);
    // A process value without a physical model (or of the illustrative energy model, which is not a product
    // module) is never shown as a plausible-looking number: the signal is listed, its value is not.
    const text =
      basis === 'placeholder' ? 'Not modelled' : basis === 'energy-model' ? 'Not monitored' : reading.value == null ? '—' : `${reading.text}${unit}`;
    return {
      def,
      reading,
      text,
      basis,
      metrics: def.metrics.length ? def.metrics.map((m) => METRIC_LABEL[m]).join(', ') : 'Position only',
      source: SOURCE_NAME[def.sourceId] ?? def.sourceId,
    };
  });
}
