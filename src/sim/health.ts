/**
 * Machine health: illustrative condition-monitoring signals and rule-based detection.
 *
 * Signals (temperature, vibration, motor current) are a pure function of the simulated
 * plant: load comes from the machine's actual output, and a hidden *degradation severity*
 * (0 = healthy, 1 = failure) raises vibration, temperature and current. Detection only
 * looks at the observed signals — it compares them with the expected value for the current
 * load and extrapolates the trend — so it can flag a problem before the failure happens.
 *
 * Nothing here is a trained predictive model and no sensor is connected; the UI says so.
 */
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { OPS_BY_ID, REASON_BY_CODE } from '../model/plant';
import type { AlertSeverity, RecordSource } from '../model/types';
import type { SimState } from './engine';
import { minuteAt, nextId, openDowntime, raiseAlert } from './engine';
import { lerpRange, noiseAt, noiseKey, streamFor } from './rng';
import { MIN_PER_DAY } from './time';

export type HealthAsset = {
  id: string;
  component: string;
  /** Downtime reason opened when the component fails. */
  failureReason: string;
  /** Bearing / oil temperature at full load (°C), alarm and trip limits. */
  temp: { full: number; alarm: number; trip: number };
  /** Vibration velocity RMS (mm/s) at full load when healthy; alarm and trip limits (ISO 10816-style zones). */
  vib: { full: number; alarm: number; trip: number };
  /** Rated motor current (A). */
  currentRated: number;
  /** Preventive-maintenance interval (run hours). */
  pmIntervalH: number;
  /** Corrective repair duration bounds (min). */
  repair: [number, number];
  action: string;
};

export const HEALTH_ASSETS: HealthAsset[] = [
  ...['C-BM1', 'C-BM2', 'C-BM3'].map(
    (id): HealthAsset => ({
      id,
      component: 'Mill gearbox · output-shaft bearing',
      failureReason: 'MECH_BEARING',
      temp: { full: 68, alarm: 85, trip: 95 },
      vib: { full: 2.4, alarm: 7.1, trip: 11.2 },
      currentRated: 285,
      pmIntervalH: 2000,
      repair: [180, 260],
      action: 'Inspect the gearbox output-shaft bearing, check lubricant condition and backlash; replace the bearing at the next planned stop.',
    }),
  ),
  {
    id: 'D-TWR',
    component: 'Atomiser wheel · spindle bearing',
    failureReason: 'MECH_NOZZLE',
    temp: { full: 66, alarm: 80, trip: 90 },
    vib: { full: 1.8, alarm: 4.5, trip: 7.1 },
    currentRated: 120,
    pmIntervalH: 1500,
    repair: [120, 180],
    action: 'Inspect the atomiser spindle bearing and wheel balance; swap to the standby atomiser during the next planned stop.',
  },
  ...['E-PRS1', 'E-PRS2', 'E-PRS3'].map(
    (id): HealthAsset => ({
      id,
      component: 'Hydraulic power unit · main pump',
      failureReason: 'MECH_HYD',
      temp: { full: 52, alarm: 62, trip: 70 },
      vib: { full: 2.0, alarm: 6.0, trip: 9.0 },
      currentRated: 230,
      pmIntervalH: 1200,
      repair: [150, 220],
      action: 'Inspect the main hydraulic pump (case-drain flow, inlet strainer, coupling); check oil temperature and cooler; change the pump during a planned stop.',
    }),
  ),
  {
    id: 'F-DRY',
    component: 'Recirculation fan · drive-end bearing',
    failureReason: 'MECH_BEARING',
    temp: { full: 72, alarm: 85, trip: 95 },
    vib: { full: 2.2, alarm: 7.1, trip: 11.2 },
    currentRated: 95,
    pmIntervalH: 3000,
    repair: [120, 200],
    action: 'Inspect the recirculation fan bearing and impeller for build-up; rebalance or replace the bearing at the next planned stop.',
  },
  {
    id: 'H-KILN',
    component: 'Roller drive gearmotor · firing zone',
    failureReason: 'MECH_ROLLER',
    temp: { full: 74, alarm: 90, trip: 100 },
    vib: { full: 1.9, alarm: 4.5, trip: 7.1 },
    currentRated: 60,
    pmIntervalH: 4000,
    repair: [90, 150],
    action: 'Inspect the firing-zone roller drive gearmotor and chain; check for roller jams; replace the gearmotor from stores while the kiln runs on the standby drive.',
  },
  {
    id: 'J-PAL',
    component: 'Robot axis 2 · gearbox',
    failureReason: 'ELEC_ROBOT',
    temp: { full: 52, alarm: 70, trip: 80 },
    vib: { full: 1.2, alarm: 3.5, trip: 5.5 },
    currentRated: 22,
    pmIntervalH: 2500,
    repair: [90, 140],
    action: 'Check axis-2 gearbox backlash and grease; run the robot diagnostic cycle; replace the gearbox during a planned stop.',
  },
];
export const HEALTH_BY_ID = Object.fromEntries(HEALTH_ASSETS.map((a) => [a.id, a]));

export type DegradationEpisode = {
  id: string;
  equipmentId: string;
  start: number;
  startSeverity: number;
  /** Severity gained per minute. */
  ratePerMin: number;
  end: number | null;
  endReason: 'trip' | 'maintenance' | null;
  cause: string;
  source: RecordSource;
  scenarioId?: string;
};

export type MaintenanceRecord = {
  id: string;
  equipmentId: string;
  start: number;
  end: number;
  type: 'Preventive' | 'Corrective' | 'Condition-based';
  description: string;
  source: RecordSource;
};

export type HealthLevel = 'normal' | 'watch' | 'warning' | 'alarm' | 'offline';
export const LEVEL_RANK: Record<HealthLevel, number> = { offline: 0, normal: 1, watch: 2, warning: 3, alarm: 4 };

export type HealthState = {
  episodes: DegradationEpisode[];
  maintenance: MaintenanceRecord[];
  /** Last assessed level per asset (alerting on escalation). */
  level: Record<string, HealthLevel>;
  /** Maintenance stop end time per asset: the degradation is removed then. */
  fixAt: Record<string, { at: number; scenarioId?: string }>;
};

// ── Creation ──────────────────────────────────────────────────────────────────

export function createHealth(seed: number): HealthState {
  const h: HealthState = { episodes: [], maintenance: [], level: {}, fixAt: {} };
  const r = streamFor(seed, 'maint');
  // Historical preventive maintenance (before the simulated week), deterministic.
  for (const a of HEALTH_ASSETS) {
    let t = -Math.round(lerpRange(r(), 3, 30) * MIN_PER_DAY);
    for (let i = 0; i < 3; i++) {
      h.maintenance.push({
        id: `MR-${a.id}-${i}`,
        equipmentId: a.id,
        start: t,
        end: t + Math.round(lerpRange(r(), 90, 240)),
        type: 'Preventive',
        description: i === 0 ? `Scheduled PM: ${a.component.split(' · ')[1] ?? a.component} inspection, lubrication` : 'Scheduled PM: inspection, lubrication, alignment check',
        source: 'simulation',
      });
      t -= Math.round(lerpRange(r(), 45, 80) * MIN_PER_DAY);
    }
    h.level[a.id] = 'normal';
  }
  // Baseline: ball mill 2 gearbox bearing has been wearing slowly since Friday (still far from failure).
  h.episodes.push({
    id: 'DG-BASE-BM2',
    equipmentId: 'C-BM2',
    start: 4 * MIN_PER_DAY,
    startSeverity: 0,
    ratePerMin: 0.22 / (7 * MIN_PER_DAY + 270 - 4 * MIN_PER_DAY),
    end: null,
    endReason: null,
    cause: 'Gradual bearing wear (lubricant degradation)',
    source: 'simulation',
  });
  return h;
}

// ── Signals ───────────────────────────────────────────────────────────────────

export function severityAt(s: SimState, id: string, t: number) {
  let sev = 0;
  for (const e of s.health.episodes) {
    if (e.equipmentId !== id || e.start > t || (e.end != null && t >= e.end)) continue;
    sev = Math.max(sev, e.startSeverity + e.ratePerMin * (t - e.start));
  }
  return Math.min(1.05, Math.max(0, sev));
}

/**
 * Load 0–1 (output relative to ideal rate) of a machine at minute t; null when nothing is known about
 * the minute (no ideal rate, before the simulation start, no record of the hour), never a fabricated 0.
 */
export function loadAt(s: SimState, id: string, t: number): number | null {
  const ideal = OPS_BY_ID[id]?.idealRatePerHour;
  if (!ideal || t < 0) return null;
  if (t >= s.minute - 1) {
    const m = s.machines[id];
    if (!m) return null;
    return m.state === 'down' || m.state === 'planned' ? 0 : Math.min(1, m.ratePerHour / ideal);
  }
  // Minute-accurate while the minute log still holds t: a stopped minute is a stopped minute.
  const x = minuteAt(s, id, t);
  if (x) return x.state === 'down' || x.state === 'planned' ? 0 : Math.min(1, (x.rate * 60) / ideal);
  // Older: the machine was not running if one of its own stop records covers t.
  for (let i = s.downtime.length - 1; i >= 0; i--) {
    const d = s.downtime[i];
    if (d.equipmentId === id && d.start <= t && (d.end ?? s.minute) > t && (d.category !== 'Starved' && d.category !== 'Blocked')) return 0;
    if (d.end != null && d.end < t - 600) break;
  }
  const h = Math.floor(t / 60);
  const b = s.hours[id]?.get(h);
  if (!b) return null;
  const minutes = h === Math.floor((s.minute - 1) / 60) ? ((s.minute - 1) % 60) + 1 : 60;
  return Math.min(1, b.count / ((ideal / 60) * minutes));
}

export type SensorReading = { t: number; temperature: number; vibration: number; current: number; running: boolean; load: number };

const ambient = 28;
/** Healthy-baseline temperature (°C) for the current load. */
export const expectedTemp = (a: HealthAsset, load: number) => ambient + (a.temp.full - ambient) * (0.45 + 0.55 * load);
/** Healthy-baseline vibration (mm/s RMS) for the current load. */
export const expectedVib = (a: HealthAsset, load: number, running: boolean) => (running ? a.vib.full * (0.8 + 0.25 * load) : 0.25);

/** The noise streams `sens:<id>:t|v|c` of an asset, keyed once per seed (every condition sample of charts and rules). */
const SENSOR_KEYS = new Map<string, { seed: number; t: number; v: number; c: number }>();
function sensorKeys(seed: number, id: string) {
  let k = SENSOR_KEYS.get(id);
  if (!k || k.seed !== seed) SENSOR_KEYS.set(id, (k = { seed, t: noiseKey(seed, `sens:${id}:t`), v: noiseKey(seed, `sens:${id}:v`), c: noiseKey(seed, `sens:${id}:c`) }));
  return k;
}

/** Condition signals of a monitored asset at minute t; null when the minute has no load record (nothing to base a reading on). */
export function sensorsAt(s: SimState, id: string, t: number): SensorReading | null {
  const a = HEALTH_BY_ID[id];
  const load = a ? loadAt(s, id, t) : null;
  if (load == null) return null;
  const running = load > 0.05;
  const sev = severityAt(s, id, t);
  const k = Math.floor(t / 5);
  const keys = sensorKeys(s.seed, id);
  const n = (key: 't' | 'v' | 'c') => noiseAt(keys[key], k) - 0.5;
  const kv = a.vib.trip / a.vib.full - 1;
  const temperature = expectedTemp(a, load) + (a.temp.trip - 2 - a.temp.full) * sev ** 1.6 + n('t') * 1.6;
  const vibration = running ? expectedVib(a, load, true) * (1 + kv * sev ** 1.4) + n('v') * 0.12 * a.vib.full : 0.25 + n('v') * 0.05;
  const current = running ? a.currentRated * (0.35 + 0.62 * load) * (1 + 0.1 * sev) + n('c') * 0.02 * a.currentRated : 0.02 * a.currentRated;
  return { t, temperature, vibration: Math.max(0, vibration), current: Math.max(0, current), running, load };
}

/** Sampled history for charts (every `step` minutes, oldest first; minutes without a record are left out). */
export function sensorHistory(s: SimState, id: string, minutes: number, step = 10) {
  const out: SensorReading[] = [];
  const end = s.minute - 1;
  for (let t = Math.max(0, end - minutes); t <= end; t += step) {
    const r = sensorsAt(s, id, t);
    if (r) out.push(r);
  }
  return out;
}

// ── Assessment (rule-based detection on observed signals) ────────────────────

export type HealthAssessment = {
  id: string;
  level: HealthLevel;
  score: number;
  reading: SensorReading;
  expectedVibration: number;
  vibrationRatio: number | null;
  /** mm/s per hour over the last 3 h (running samples). */
  trend: number | null;
  etaAlarmH: number | null;
  etaTripH: number | null;
  findings: string[];
  impact: string | null;
  recommendation: string | null;
  runtimeSincePmH: number;
  pmDueH: number;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function assess(s: SimState, id: string): HealthAssessment {
  const a = HEALTH_BY_ID[id];
  const now = Math.max(0, s.minute - 1);
  const samples: SensorReading[] = [];
  for (let t = Math.max(0, now - 180); t <= now; t += 5) {
    const r = sensorsAt(s, id, t);
    if (r) samples.push(r);
  }
  // No record at all (before the first simulated minute): an offline reading at rest, assessed as 'offline'.
  const reading = samples[samples.length - 1] ?? { t: now, temperature: ambient, vibration: 0, current: 0, running: false, load: 0 };
  const recent = samples.filter((x) => x.running && x.t > now - 60);
  const ratios = recent.map((x) => x.vibration / expectedVib(a, x.load, true));
  const ratio = mean(ratios);
  // Linear regression of vibration vs time (h) over running samples.
  const run = samples.filter((x) => x.running);
  let trend: number | null = null;
  if (run.length >= 8) {
    const xs = run.map((x) => x.t / 60);
    const ys = run.map((x) => x.vibration);
    const mx = mean(xs)!;
    const my = mean(ys)!;
    const num = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0);
    const den = xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
    trend = den > 0 ? num / den : null;
  }
  const vibNow = mean(recent.map((x) => x.vibration)) ?? reading.vibration;
  const rising = trend != null && trend > 0.05;
  const etaAlarmH = rising && vibNow < a.vib.alarm ? (a.vib.alarm - vibNow) / trend! : null;
  const etaTripH = rising && vibNow < a.vib.trip ? (a.vib.trip - vibNow) / trend! : null;

  let level: HealthLevel = 'normal';
  if (!recent.length) level = 'offline';
  else if (vibNow >= a.vib.alarm || reading.temperature >= a.temp.alarm) level = 'alarm';
  else if ((ratio ?? 1) >= 1.6 || vibNow >= 0.8 * a.vib.alarm || reading.temperature >= a.temp.alarm - 5) level = 'warning';
  else if ((ratio ?? 1) >= 1.25 || (rising && trend! > 0.3)) level = 'watch';

  const findings: string[] = [];
  if (ratio != null && ratio >= 1.25)
    findings.push(
      `Vibration ${vibNow.toFixed(1)} mm/s RMS is ${ratio.toFixed(1)}× the ${expectedVib(a, reading.load, true).toFixed(1)} mm/s expected at the current load (alarm ${a.vib.alarm}, trip ${a.vib.trip} mm/s).`,
    );
  if (rising) findings.push(`Rising ${trend!.toFixed(2)} mm/s per hour over the last 3 h of running.`);
  if (reading.temperature >= expectedTemp(a, reading.load) + 4)
    findings.push(`Temperature ${reading.temperature.toFixed(0)} °C, ${(reading.temperature - expectedTemp(a, reading.load)).toFixed(0)} °C above the load-corrected expectation (alarm ${a.temp.alarm} °C).`);

  const name = EQUIPMENT_BY_ID[id].name;
  const repairH = `${(a.repair[0] / 60).toFixed(1)}–${(a.repair[1] / 60).toFixed(1)} h`;
  const impact =
    level === 'normal' || level === 'offline'
      ? null
      : etaTripH != null
        ? `At this rate ${name} reaches its trip limit in ~${formatH(etaTripH)}; an unplanned failure would stop it for an estimated ${repairH} (${REASON_BY_CODE[a.failureReason].label.toLowerCase()}).`
        : `An unplanned failure of the ${a.component.toLowerCase()} would stop ${name} for an estimated ${repairH}.`;
  const recommendation = level === 'normal' || level === 'offline' ? null : a.action;

  const lastPm = [...s.health.maintenance].filter((m) => m.equipmentId === id && m.start <= now).sort((x, y) => y.start - x.start)[0];
  const since = lastPm ? lastPm.end : 0;
  let runMin = 0;
  for (let t = Math.max(0, since); t <= now; t += 60) runMin += Math.min(60, (s.hours[id]?.get(Math.floor(t / 60))?.operating ?? 0));
  // Before the simulated week, assume 90 % utilisation (illustrative).
  if (since < 0) runMin += -since * 0.9;
  const runtimeSincePmH = runMin / 60;

  const penalty = Math.max(0, ((ratio ?? 1) - 1) * 70) + (level === 'alarm' ? 15 : 0) + Math.max(0, reading.temperature - (a.temp.alarm - 10)) * 2;
  const score = level === 'offline' ? 0 : Math.round(Math.max(5, Math.min(100, 100 - penalty)));
  return {
    id,
    level,
    score,
    reading,
    expectedVibration: expectedVib(a, reading.load, reading.running),
    vibrationRatio: ratio,
    trend,
    etaAlarmH,
    etaTripH,
    findings,
    impact,
    recommendation,
    runtimeSincePmH,
    pmDueH: a.pmIntervalH - runtimeSincePmH,
  };
}

export const formatH = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

// ── Step ──────────────────────────────────────────────────────────────────────

/** A developing-fault scenario is over once its fault has tripped the machine or been repaired. */
function endScenarioOf(s: SimState, scenarioId: string | undefined, t: number) {
  const sc = scenarioId ? s.scenarios.find((x) => x.id === scenarioId) : undefined;
  if (sc && (sc.end == null || sc.end > t)) sc.end = t;
}

export function stepHealth(s: SimState, t: number) {
  const h = s.health;
  // Condition-based maintenance completing — before the trip check, so a repair that finishes this
  // minute removes the fault instead of racing it.
  for (const [id, fix] of Object.entries(h.fixAt)) {
    if (t < fix.at) continue;
    for (const e of h.episodes)
      if (e.equipmentId === id && e.end == null && e.start <= t) {
        e.end = t;
        e.endReason = 'maintenance';
        endScenarioOf(s, e.scenarioId, t);
      }
    delete h.fixAt[id];
  }
  // Failures when a degradation reaches the end of its life (each episode on its own severity).
  for (const e of h.episodes) {
    if (e.end != null || e.start > t) continue;
    // Progression pauses while the asset is stopped for condition-based maintenance.
    if (h.fixAt[e.equipmentId]) continue;
    const sev = Math.min(1.05, e.startSeverity + e.ratePerMin * (t - e.start));
    if (sev < 1) continue;
    const m = s.machines[e.equipmentId];
    if (m.state === 'down' || m.state === 'planned') continue;
    const a = HEALTH_BY_ID[e.equipmentId];
    const r = streamFor(s.seed, `trip:${e.id}`);
    const duration = Math.round(lerpRange(r(), a.repair[0], a.repair[1]));
    if (m.activeDowntimeId) continue;
    openDowntime(s, e.equipmentId, a.failureReason, t, t + duration, e.source, e.scenarioId);
    // The failed component is replaced in the repair: every open episode of the asset ends here.
    for (const o of h.episodes)
      if (o.equipmentId === e.equipmentId && o.end == null && o.start <= t) {
        o.end = t;
        o.endReason = 'trip';
        endScenarioOf(s, o.scenarioId, t);
      }
    h.maintenance.push({
      id: nextId(s, 'MR'),
      equipmentId: e.equipmentId,
      start: t,
      end: t + duration,
      type: 'Corrective',
      description: `Breakdown repair: ${a.component} failure`,
      source: e.source,
    });
    raiseAlert(s, t, 'critical', `${e.equipmentId} failed: ${a.component}`, 'Unplanned stop after a developing fault reached its trip limit', { equipmentId: e.equipmentId }, e.source);
  }
  // Escalation alerts every 10 minutes.
  if (t % 10 === 0 && t > 0) {
    for (const a of HEALTH_ASSETS) {
      const lvl = assess(s, a.id).level;
      const prev = h.level[a.id] ?? 'normal';
      if (lvl !== 'offline') {
        if (LEVEL_RANK[lvl] > LEVEL_RANK[prev] && lvl !== 'normal') {
          const sev: AlertSeverity = lvl === 'alarm' ? 'critical' : lvl === 'warning' ? 'serious' : 'warning';
          raiseAlert(s, t, sev, `Condition monitoring: ${a.id} ${lvl}`, `${a.component} — abnormal vibration/temperature pattern (rule-based detection on simulated signals)`, { equipmentId: a.id }, 'simulation');
        }
        h.level[a.id] = lvl;
      }
    }
  }
}

/** Starts a condition-based maintenance stop that removes the developing fault when it ends. */
export function startMaintenance(s: SimState, id: string, duration: number, scenarioId?: string) {
  const a = HEALTH_BY_ID[id];
  const m = s.machines[id];
  const start = s.minute;
  if (m && !m.activeDowntimeId) openDowntime(s, id, 'PLN_MAINT', start, start + duration, 'scenario', scenarioId);
  s.health.fixAt[id] = { at: start + duration, scenarioId };
  s.health.maintenance.push({
    id: nextId(s, 'MR'),
    equipmentId: id,
    start,
    end: start + duration,
    type: 'Condition-based',
    description: a ? `Condition-based maintenance: ${a.action.split(';')[0]}` : 'Condition-based maintenance',
    source: 'scenario',
  });
}

/** Extra electrical load fraction from friction/misalignment of degrading components. */
export function degradationLoad(s: SimState, t: number) {
  const out: Record<string, number> = {};
  for (const e of s.health.episodes) if (e.end == null && e.start <= t) out[e.equipmentId] = 0.08 * severityAt(s, e.equipmentId, t);
  return out;
}
