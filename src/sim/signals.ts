/**
 * Current simulated value of every configured signal (SIGNALS in src/model/plant.ts).
 *
 * Pure and deterministic: the value is derived from the simulation state only —
 * machine runtime for state / counters / rate / alarm, buffer fill for levels, the
 * hourly quality buckets for inspection counters, logistics state for gate / dock /
 * vehicle-zone signals, and the energy model (src/sim/energy.ts) for power and gas.
 * Process temperatures and pressure have no physical model in this release: they are
 * bounded, smoothly varying values from `noise01`, nudged by the relevant machine
 * states so they stay plausible. A
 * future read-only gateway would supply the same signal ids with real values.
 */
import { BUFFERS, DOCKS, GEOFENCES, INSPECTION_STATIONS, REASON_BY_CODE } from '../model/plant';
import type { MachineState } from '../model/types';
import { findDowntime, type SimState } from './engine';
import { internalActivity } from './metrics';
import { noise01 } from './rng';
import { CONSUMERS, powerNow } from './energy';
import { HEALTH_BY_ID, sensorsAt } from './health';

export type SignalReading = {
  /** Raw value: number for counters / analog, string for state / event signals, null if no value yet. */
  value: number | string | null;
  /** Display text without the unit. */
  text: string;
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

/** Smooth bounded noise in [0, 1): smoothstep between knots every `period` minutes. */
function smooth(seed: number, key: string, t: number, period: number) {
  const k = Math.floor(t / period);
  const f = (t % period) / period;
  const a = noise01(seed, key, k);
  const b = noise01(seed, key, k + 1);
  return a + (b - a) * (f * f * (3 - 2 * f));
}

const isStopped = (s: SimState, id: string) => {
  const st = s.machines[id]?.state;
  return st === 'down' || st === 'planned';
};

/** Simulated analog value for the energy / process signals. */
function analog(s: SimState, equipmentId: string, name: string): SignalReading | null {
  const t = s.minute;
  const n = (period = 15) => smooth(s.seed, `sig:${equipmentId}.${name}`, t, period);
  if (name === 'vibration' || name === 'temperature' || name === 'motor_current') {
    if (!HEALTH_BY_ID[equipmentId]) return null;
    const r = sensorsAt(s, equipmentId, Math.max(0, s.minute - 1));
    return name === 'vibration' ? num(r.vibration, 2) : name === 'temperature' ? num(r.temperature, 1) : num(r.current, 0);
  }
  if (name === 'energy_kwh') {
    let kwh = 0;
    for (const b of s.energy[equipmentId]?.values() ?? []) kwh += b.elec + b.thermal;
    return num(kwh);
  }
  switch (`${equipmentId}.${name}`) {
    case 'H-KILN.temp_firing':
      // Kiln thermal mass: a stop only lowers the firing zone slightly.
      return num((isStopped(s, 'H-KILN') ? 1150 : 1182) + 20 * n());
    case 'H-KILN.temp_preheat':
      return num((isStopped(s, 'H-KILN') ? 610 : 645) + 45 * n());
    case 'D-TWR.temp_inlet':
      return num((isStopped(s, 'D-TWR') ? 430 : 545) + 35 * n());
    case 'D-TWR.powder_moisture':
      return num(5.6 + 0.8 * n(20), 2);
    case 'F-DRY.temp_deck':
      return num((isStopped(s, 'F-DRY') ? 165 : 192) + 22 * n());
    case 'A-COMP.header_pressure':
      return num(6.8 + 0.6 * n(10), 2);
    case 'A-COMP.active_power':
      return num(powerNow(s, 'A-COMP').elec);
    case 'A-SUB.active_power': {
      // Site electrical demand from the energy model (sum of all consumers).
      const kw = CONSUMERS.reduce((a, c) => a + powerNow(s, c.id).elec, 0);
      return num(kw);
    }
    case 'A-GAS.gas_flow': {
      // Natural gas at ~10.5 kWh/Nm³ (LHV) for the kiln, hot-air generator and dryer, from the energy model.
      const kwTh = CONSUMERS.reduce((a, c) => a + powerNow(s, c.id).thermal, 0);
      return num(kwTh / 10.5);
    }
    case 'A-WTR.tank_level':
      return num(55 + 30 * n(120), 1);
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
  const name = signalId.slice(dot + 1);
  const m = s.machines[equipmentId];

  switch (name) {
    case 'state':
      return m ? { value: m.state, text: STATE_TEXT[m.state] } : NONE;
    case 'count_total':
      return m ? num(m.countTotal) : NONE;
    case 'rate':
      return m ? num(m.ratePerHour) : NONE;
    case 'alarm': {
      if (!m) return NONE;
      const ev = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
      if (!ev || REASON_BY_CODE[ev.reasonCode].planned) return { value: 'none', text: 'No active alarm' };
      return { value: ev.reasonCode, text: ev.reasonCode };
    }
    case 'level': {
      const b = BUFFERS.find((x) => x.equipmentId === equipmentId);
      return b ? num((s.buffers[b.id] / b.capacity) * 100, 1) : NONE;
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
