/**
 * Illustrative energy model. Every consumer draws electrical and/or thermal (natural-gas)
 * power that depends on its state and throughput; the kiln and dryers keep burning gas
 * when they are starved, which is exactly the kind of loss energy monitoring reveals.
 *
 * "Expected" consumption is the same model without anomalies — the baseline an energy
 * team would build from metered history. "Actual" = expected × anomaly factor × small
 * bounded metering noise. All values are simulated; no meters are connected.
 */
import { OPS_BY_ID } from '../model/plant';
import type { ScenarioActivation } from '../model/types';
import type { SimState } from './engine';
import { noise01 } from './rng';

export type EnergyBucket = {
  /** Electrical energy, kWh. */
  elec: number;
  /** Thermal (natural gas) energy, kWh (lower heating value). */
  thermal: number;
  expElec: number;
  expThermal: number;
};

type Consumer = {
  id: string;
  label: string;
  /** Electrical kW: idle (ready, not producing) and at full ideal rate. */
  elec: [idle: number, run: number];
  /** Thermal kW, idle and full rate (0 if none). */
  thermal?: [idle: number, run: number];
  /** Machine whose utilisation drives this consumer (defaults to itself). */
  driver?: string;
  /** Power while stopped (down / planned), as a fraction of idle. */
  stoppedFactor?: number;
};

/** Energy consumers with illustrative ratings (kW). */
export const CONSUMERS: Consumer[] = [
  { id: 'C-BM1', label: 'Ball mill 1', elec: [45, 300] },
  { id: 'C-BM2', label: 'Ball mill 2', elec: [45, 300] },
  { id: 'C-BM3', label: 'Ball mill 3', elec: [45, 300] },
  { id: 'D-TWR', label: 'Spray dryer fans & atomiser', elec: [60, 185] },
  { id: 'D-HAG', label: 'Hot-air generator (gas)', elec: [8, 22], thermal: [650, 3200], driver: 'D-TWR', stoppedFactor: 0.6 },
  { id: 'E-PRS1', label: 'Press 1', elec: [35, 140] },
  { id: 'E-PRS2', label: 'Press 2', elec: [35, 140] },
  { id: 'E-PRS3', label: 'Press 3', elec: [35, 140] },
  { id: 'F-DRY', label: 'Roller dryer', elec: [30, 90], thermal: [420, 900], stoppedFactor: 0.8 },
  { id: 'G-LINE', label: 'Glaze line', elec: [15, 45] },
  { id: 'G-INK', label: 'Inkjet printer', elec: [18, 35] },
  // The kiln stays hot whenever it is not producing: most of its gas is burnt regardless of output.
  { id: 'H-KILN', label: 'Roller kiln', elec: [200, 230], thermal: [3400, 4300], stoppedFactor: 0.9 },
  { id: 'I-SORT', label: 'Sorting & inspection', elec: [15, 30] },
  { id: 'J-BOX', label: 'Carton packer', elec: [12, 40] },
  { id: 'J-PAL', label: 'Palletiser', elec: [8, 25] },
  { id: 'A-COMP', label: 'Air compressors', elec: [90, 175], driver: 'E-PRS1', stoppedFactor: 1 },
  { id: 'A-SUB', label: 'Base load (lighting, HVAC, offices)', elec: [140, 140], stoppedFactor: 1 },
];
export const CONSUMER_BY_ID = Object.fromEntries(CONSUMERS.map((c) => [c.id, c]));

/** Illustrative tariffs and emission factors (editable in Energy Intelligence). */
export type Tariffs = {
  currency: string;
  /** Per kWh electrical. */
  electricity: number;
  /** Per kWh thermal (gas, LHV). */
  gas: number;
  /** kg CO₂e per kWh. */
  co2Electricity: number;
  co2Gas: number;
};

export const DEFAULT_TARIFFS: Tariffs = { currency: 'USD', electricity: 0.12, gas: 0.045, co2Electricity: 0.45, co2Gas: 0.2 };

/** Anomaly multipliers on actual consumption from active 'energy-anomaly' scenarios. */
function anomaly(active: ScenarioActivation[], id: string) {
  let elec = 1;
  let thermal = 1;
  for (const sc of active) {
    if (sc.kind !== 'energy-anomaly' || sc.equipmentId !== id) continue;
    const f = sc.factor ?? 1.2;
    if (CONSUMER_BY_ID[id]?.thermal) thermal *= f;
    else elec *= f;
  }
  return { elec, thermal };
}

/** Utilisation 0–1 of a machine this minute (output relative to ideal rate), and whether it is stopped. */
function utilisation(s: SimState, id: string) {
  const m = s.machines[id];
  if (!m) return { u: 1, stopped: false };
  const ideal = OPS_BY_ID[id]?.idealRatePerHour ?? 1;
  const stopped = m.state === 'down' || m.state === 'planned';
  return { u: stopped ? 0 : Math.min(1, m.ratePerHour / ideal), stopped };
}

/** Called once per simulated minute after production. */
export function stepEnergy(s: SimState, t: number, active: ScenarioActivation[], extraElec: Record<string, number>) {
  const hour = Math.floor(t / 60);
  for (const c of CONSUMERS) {
    const { u, stopped } = c.id === 'A-SUB' ? { u: 0, stopped: false } : utilisation(s, c.driver ?? c.id);
    const lineRunning = c.id === 'A-COMP' ? pneumaticDemand(s) : u;
    const f = stopped ? (c.stoppedFactor ?? 0.15) : 1;
    const pElec = (c.elec[0] + (c.elec[1] - c.elec[0]) * lineRunning) * f * (1 + (extraElec[c.id] ?? 0));
    const pTh = c.thermal ? (c.thermal[0] + (c.thermal[1] - c.thermal[0]) * u) * f : 0;
    const a = anomaly(active, c.id);
    // ±2 % smoothed metering noise so the baseline never reads as a perfectly flat line.
    const n = 1 + (noise01(s.seed, `en:${c.id}`, Math.floor(t / 15)) - 0.5) * 0.04;
    let map = s.energy[c.id];
    if (!map) {
      map = new Map();
      s.energy[c.id] = map;
    }
    let b = map.get(hour);
    if (!b) {
      b = { elec: 0, thermal: 0, expElec: 0, expThermal: 0 };
      map.set(hour, b);
    }
    b.expElec += pElec / 60;
    b.expThermal += pTh / 60;
    b.elec += (pElec * a.elec * n) / 60;
    b.thermal += (pTh * a.thermal * n) / 60;
  }
}

/** Share of compressed-air users running (presses, glaze line, packing). */
function pneumaticDemand(s: SimState) {
  const users = ['E-PRS1', 'E-PRS2', 'E-PRS3', 'G-LINE', 'J-BOX', 'J-PAL'];
  return users.reduce((a, id) => a + utilisation(s, id).u, 0) / users.length;
}

/** Instantaneous power (kW) per consumer for the current minute, from the model (actual); null when the model has no bucket for it. */
export function powerNow(s: SimState, id: string): { elec: number; thermal: number } | null {
  const b = s.energy[id]?.get(Math.floor((s.minute - 1) / 60));
  if (!b) return null;
  // Average power so far in the current hour.
  const minutes = ((s.minute - 1) % 60) + 1;
  return { elec: (b.elec * 60) / minutes, thermal: (b.thermal * 60) / minutes };
}
