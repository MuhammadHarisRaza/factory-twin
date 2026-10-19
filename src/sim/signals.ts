/**
 * Current simulated value of every configured signal (SIGNALS in src/model/plant.ts).
 *
 * Pure and deterministic: the value is derived from the simulation state only —
 * machine runtime for state / counters / rate / alarm, buffer fill for levels (also the level signals
 * of the buffers without equipment, on their host conveyor — HOSTED_BUFFER_LEVELS), the
 * hourly quality buckets for inspection counters, logistics state for gate / dock /
 * vehicle-zone signals, and the energy model (src/sim/energy.ts) for power and gas.
 * The process analogs of the original signal list (kiln, spray dryer and dryer temperatures,
 * powder moisture, air header pressure, water tank level) have no model behind them and read
 * null ('Not modelled'); the simulated process values are the PROCESS_SIGNALS read through
 * src/sim/process.ts and src/sim/telemetry.ts. A stale feed serves the snapshot of every signal
 * of the asset taken when it went stale, so nothing live leaks through.
 * A future read-only gateway would supply the same signal ids with real values.
 */
import { CONVEYOR_BY_ID, DOCKS, GEOFENCES, INSPECTION_STATIONS, OPS_BY_ID, REASON_BY_CODE, bufferOfLevelSignal } from '../model/plant';
import type { MachineState } from '../model/types';
import { findDowntime, type SimState } from './engine';
import { internalActivity } from './metrics';
import { smoothNoise } from './rng';
import { CONSUMERS, powerNow } from './energy';
import { HEALTH_BY_ID, sensorsAt } from './health';

export type SignalReading = {
  /** Raw value: number for counters / analog, string for state / event signals, null if no value yet. */
  value: number | string | null;
  /** Display text without the unit. */
  text: string;
  /** 'stale' when the asset's data feed stopped updating — the value is the last one received. */
  quality?: 'good' | 'stale';
  /** Plant minute of the last update when stale. */
  since?: number;
};

const STATE_TEXT: Record<MachineState, string> = {
  running: 'Running',
  reduced: 'Reduced rate',
  starved: 'Starved',
  blocked: 'Blocked',
  down: 'Down',
  planned: 'Planned stop',
};

const GEOFENCE_NAME = Object.fromEntries(GEOFENCES.map((g) => [g.id, g.name]));
const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const num = (v: number, digits = 0): SignalReading => ({
  value: Number(v.toFixed(digits)),
  text: digits ? v.toFixed(digits) : intFmt.format(Math.round(v)),
});
const NONE: SignalReading = { value: null, text: '—' };

/** Signals of the original list with no model behind them: they never carry a value (shown as 'Not modelled'). */
export const PLACEHOLDER_SIGNAL_IDS: ReadonlySet<string> = new Set([
  'H-KILN.temp_firing',
  'H-KILN.temp_preheat',
  'D-TWR.temp_inlet',
  'D-TWR.powder_moisture',
  'F-DRY.temp_deck',
  'A-COMP.header_pressure',
  'A-WTR.tank_level',
]);

/**
 * Belt / roller speed of a running conveyor read at the start of minute `at` (m/min, ±2 % around nominal);
 * the live reading uses at = s.minute, a history sample of minute t uses at = t + 1.
 */
export const conveyorSpeed = (seed: number, id: string, at: number) => (CONVEYOR_BY_ID[id]?.speedMpm ?? 0) * (0.98 + 0.04 * smoothNoise(seed, `spd:${id}`, at, 10));

/** Sum of the energy model's current power over all consumers (null when no consumer has a bucket yet). */
function sitePower(s: SimState, key: 'elec' | 'thermal') {
  let kw = 0;
  let any = false;
  for (const c of CONSUMERS) {
    const p = powerNow(s, c.id);
    if (!p) continue;
    kw += p[key];
    any = true;
  }
  return any ? kw : null;
}

/** Simulated analog value for the energy / condition signals; the placeholder process analogs have none. */
function analog(s: SimState, equipmentId: string, name: string): SignalReading | null {
  if (PLACEHOLDER_SIGNAL_IDS.has(`${equipmentId}.${name}`)) return NONE;
  if (name === 'vibration' || name === 'temperature' || name === 'motor_current') {
    if (!HEALTH_BY_ID[equipmentId]) return null;
    const r = sensorsAt(s, equipmentId, Math.max(0, s.minute - 1));
    if (!r) return NONE;
    return name === 'vibration' ? num(r.vibration, 2) : name === 'temperature' ? num(r.temperature, 1) : num(r.current, 0);
  }
  if (name === 'energy_kwh') {
    const map = s.energy[equipmentId];
    if (!map?.size) return NONE;
    let kwh = 0;
    for (const b of map.values()) kwh += b.elec + b.thermal;
    return num(kwh);
  }
  switch (`${equipmentId}.${name}`) {
    case 'A-COMP.active_power': {
      const p = powerNow(s, 'A-COMP');
      return p ? num(p.elec) : NONE;
    }
    case 'A-SUB.active_power': {
      // Site electrical demand from the energy model (sum of all consumers).
      const kw = sitePower(s, 'elec');
      return kw == null ? NONE : num(kw);
    }
    case 'A-GAS.gas_flow': {
      // Natural gas at ~10.5 kWh/Nm³ (LHV) for the kiln, hot-air generator and dryer, from the energy model.
      const kwTh = sitePower(s, 'thermal');
      return kwTh == null ? NONE : num(kwTh / 10.5);
    }
    default:
      return null;
  }
}

/** Lifetime station counters (all hours simulated so far). */
function stationTotals(s: SimState, stationId: string) {
  let inspected = 0;
  let rejected = 0;
  for (const q of s.quality.values()) {
    const b = q[stationId];
    if (!b) continue;
    inspected += b.inspected;
    rejected += b.rejected;
  }
  return { inspected, rejected };
}

/** Current simulated value of a signal id (`<equipmentId>.<name>`). */
export function signalValue(s: SimState, signalId: string): SignalReading {
  const dot = signalId.indexOf('.');
  if (dot < 0) return NONE;
  const equipmentId = signalId.slice(0, dot);
  const f = s.feeds[equipmentId];
  if (f?.status === 'stale') return { ...staleValue(s, signalId), quality: 'stale', since: f.since };
  return liveValue(s, signalId);
}

/**
 * Value as last received before a feed went stale: the snapshot of every signal of the asset taken when
 * the feed stopped (snapshotSignals). A signal missing from the snapshot has no value, never a live one.
 */
function staleValue(s: SimState, signalId: string): SignalReading {
  const equipmentId = signalId.slice(0, signalId.indexOf('.'));
  const last = s.feeds[equipmentId]?.last?.[signalId];
  return last ? { value: last.value, text: last.text } : NONE;
}

/**
 * Current reading of every configured signal of an asset, taken when a feed goes stale or a data-quality
 * scenario freezes / resets its values: what a gateway would still hold as the last values received.
 */
export function snapshotSignals(s: SimState, equipmentId: string): Record<string, { value: number | string | null; text: string }> {
  const out: Record<string, { value: number | string | null; text: string }> = {};
  for (const id of OPS_BY_ID[equipmentId]?.signals ?? []) {
    const r = liveValue(s, id);
    out[id] = { value: r.value, text: r.text };
  }
  return out;
}

const CONVEYOR_STATE_TEXT: Record<MachineState, string> = {
  running: 'Running',
  reduced: 'Running',
  starved: 'Running empty',
  blocked: 'Accumulating',
  down: 'Stopped',
  planned: 'Stopped (planned)',
};

function liveValue(s: SimState, signalId: string): SignalReading {
  const dot = signalId.indexOf('.');
  const equipmentId = signalId.slice(0, dot);
  const name = signalId.slice(dot + 1);
  const m = s.machines[equipmentId];
  // Buffer levels: `<equipmentId>.level`, and the hosted level signals of the buffers without equipment.
  const buffer = bufferOfLevelSignal(signalId);
  if (buffer) return num((s.buffers[buffer.id] / buffer.capacity) * 100, 1);

  switch (name) {
    case 'state':
      return m ? { value: m.state, text: STATE_TEXT[m.state] } : NONE;
    case 'count_total':
    case 'tile_count':
      return m ? num(m.countTotal) : NONE;
    case 'run_state':
      return m ? { value: m.state, text: CONVEYOR_STATE_TEXT[m.state] } : NONE;
    case 'speed': {
      const c = CONVEYOR_BY_ID[equipmentId];
      return c && m ? num(m.state === 'down' ? 0 : conveyorSpeed(s.seed, equipmentId, s.minute), 1) : NONE;
    }
    case 'rate':
      return m ? num(m.ratePerHour) : NONE;
    case 'alarm': {
      if (!m) return NONE;
      const ev = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
      if (!ev || REASON_BY_CODE[ev.reasonCode].planned) return { value: 'none', text: 'No active alarm' };
      return { value: ev.reasonCode, text: ev.reasonCode };
    }
    case 'count_inspected':
    case 'count_rejected': {
      const st = INSPECTION_STATIONS.find((x) => x.equipmentId === equipmentId);
      if (!st) return NONE;
      const tot = stationTotals(s, st.id);
      return num(name === 'count_inspected' ? tot.inspected : tot.rejected);
    }
    case 'sample_result': {
      const st = INSPECTION_STATIONS.find((x) => x.equipmentId === equipmentId);
      for (let i = s.inspections.length - 1; i >= 0; i--) {
        const r = s.inspections[i];
        if (r.stationId === st?.id) return { value: r.result, text: r.result === 'pass' ? 'Pass' : 'Fail' };
      }
      return NONE;
    }
    case 'count_good': {
      let good = 0;
      for (const v of s.lineGood.values()) good += v;
      return num(good);
    }
    case 'gate_event': {
      const g = s.logistics.gateEvents[s.logistics.gateEvents.length - 1];
      if (!g) return NONE;
      const label = s.logistics.vehicles[g.vehicleId]?.label ?? g.vehicleId;
      return { value: g.direction, text: `${g.direction === 'in' ? 'In' : 'Out'} · ${label}` };
    }
    case 'dock_occupancy': {
      const occupied = DOCKS.filter((d) => s.logistics.docks[d.id]?.vehicleId).length;
      return { value: occupied, text: `${occupied} / ${DOCKS.length}` };
    }
    case 'vehicle_zone': {
      const ids = equipmentId === 'B-LOAD' ? ['WL-01'] : s.logistics.active.filter((id) => s.logistics.vehicles[id]?.type === 'forklift');
      const parts = ids
        .map((id) => {
          const v = s.logistics.vehicles[id];
          const zone = v ? internalActivity(v, s.minute).zone : null;
          return zone ? { id, zone } : null;
        })
        .filter((x): x is { id: string; zone: string } => x != null);
      if (!parts.length) return NONE;
      if (parts.length === 1) return { value: parts[0].zone, text: GEOFENCE_NAME[parts[0].zone] ?? parts[0].zone };
      return { value: parts.map((p) => p.zone).join(','), text: parts.map((p) => `${p.id} ${p.zone}`).join(' · ') };
    }
    default:
      return analog(s, equipmentId, name) ?? NONE;
  }
}
