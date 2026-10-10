/**
 * Deterministic production simulation.
 *
 * The line is modelled as stages linked by finite WIP buffers (slip tanks, powder
 * silos, buffer racks…). Every plant minute each stage produces
 *   min(capacity, input available, output space)
 * so starvation and blocking propagate naturally up and down the line, and a
 * capacity loss at one stage reaches the others only once the buffers between
 * them have drained or filled.
 *
 * All variation comes from seeded per-entity streams (src/sim/rng.ts); scenarios are
 * explicit, timestamped inputs. Given the same seed and scenario log, the state at any
 * minute is identical — "reset" replays the baseline.
 */
import {
  BASE_REJECT_RATE,
  BUFFERS,
  CHANGEOVER_EVERY_MIN,
  DEFECTS,
  DEFECT_ORDER,
  INSPECTION_STATIONS,
  LINE,
  OPS_BY_ID,
  OUTPUT_BUFFER,
  PLANNED_STOPS,
  PROCESS_MACHINES,
  PRODUCTS,
  REASON_BY_CODE,
  STAGES,
  STAGE_BY_ID,
  TILES_PER_PALLET,
} from '../model/plant';
import type {
  Alert,
  AlertSeverity,
  DefectCategory,
  DowntimeEvent,
  EquipmentRuntime,
  HourBucket,
  MachineState,
  ProductionBatch,
  QualityBucket,
  QualityInspection,
  ScenarioActivation,
  StageId,
} from '../model/types';
import { createLogistics, stepLogistics, applyLogisticsScenario, type LogisticsState } from './logistics';
import { expBounded, lerpRange, noise01, streamFor, weighted, type Rng } from './rng';
import { DEFAULT_START, SHIFT_MIN, formatDate } from './time';

export const DEFAULT_SEED = 20261012;

export type SimState = {
  seed: number;
  /** Next minute to simulate; the state describes the plant at the start of this minute. */
  minute: number;
  machines: Record<string, EquipmentRuntime>;
  /** equipmentId → hour index → bucket. */
  hours: Record<string, Map<number, HourBucket>>;
  /** Buffer id → tiles currently held. */
  buffers: Record<string, number>;
  /** Buffer id → hour → average level (fraction), for trends. */
  bufferHours: Record<string, Map<number, number>>;
  downtime: DowntimeEvent[];
  /** Line output: first-quality tiles accepted at sorting, per hour. */
  lineGood: Map<number, number>;
  quality: Map<number, Record<string, QualityBucket>>;
  inspections: QualityInspection[];
  batches: ProductionBatch[];
  scenarios: ScenarioActivation[];
  alerts: Alert[];
  logistics: LogisticsState;
  /** Internal bookkeeping (not for display). */
  internal: Internal;
  /** Incremented on every change; UI memoisation key. */
  version: number;
};

type Internal = {
  failRng: Record<string, Rng>;
  nextFailure: Record<string, number>;
  /** Scheduled stop windows not yet started: equipmentId → list. */
  pendingStops: { equipmentId: string; start: number; duration: number; reason: string }[];
  /** Starved/blocked spell tracking per machine. */
  spell: Record<string, { kind: 'Starved' | 'Blocked'; start: number; eventId: string | null } | null>;
  /** Fractional reject accumulators per station+defect for record emission. */
  recordAcc: Record<string, number>;
  qualityRng: Rng;
  palletAcc: number;
  seq: number;
  /** Last minute an alert of a given key fired (de-duplication). */
  alertAt: Record<string, number>;
};

const BUFFER_CAP = Object.fromEntries(BUFFERS.map((b) => [b.id, b.capacity]));
/** Tiles per illustrative inspection record. */
const TILES_PER_RECORD = 6;
const MAX_INSPECTIONS = 4000;
const MAX_ALERTS = 400;

const emptyBucket = (): HourBucket => ({
  planned: 0,
  operating: 0,
  down: 0,
  plannedStop: 0,
  starved: 0,
  blocked: 0,
  count: 0,
  rejects: 0,
});

export const nextId = (s: SimState, prefix: string) => `${prefix}-${String(++s.internal.seq).padStart(6, '0')}`;

// ── Creation & stepping ───────────────────────────────────────────────────────

export function createSim(seed = DEFAULT_SEED, startMinute = DEFAULT_START): SimState {
  const s: SimState = {
    seed,
    minute: 0,
    machines: {},
    hours: {},
    buffers: Object.fromEntries(BUFFERS.map((b) => [b.id, Math.round(b.capacity * b.initialFill)])),
    bufferHours: Object.fromEntries(BUFFERS.map((b) => [b.id, new Map()])),
    downtime: [],
    lineGood: new Map(),
    quality: new Map(),
    inspections: [],
    batches: [],
    scenarios: [],
    alerts: [],
    logistics: createLogistics(seed),
    internal: {
      failRng: {},
      nextFailure: {},
      pendingStops: [],
      spell: {},
      recordAcc: {},
      qualityRng: streamFor(seed, 'quality'),
      palletAcc: 0,
      seq: 0,
      alertAt: {},
    },
    version: 0,
  };
  for (const id of PROCESS_MACHINES) {
    s.machines[id] = {
      id,
      state: 'running',
      since: 0,
      rateFactor: 1,
      ratePerHour: 0,
      countTotal: 0,
      countRejectAttributed: 0,
      activeDowntimeId: null,
    };
    s.hours[id] = new Map();
    const rng = streamFor(seed, `fail:${id}`);
    s.internal.failRng[id] = rng;
    const rel = OPS_BY_ID[id].reliability!;
    s.internal.nextFailure[id] = Math.round(expBounded(rng(), rel.mtbf, 20, rel.mtbf * 3));
    s.internal.spell[id] = null;
  }
  s.batches.push({ id: batchId(0, 0), sku: PRODUCTS[0].sku, start: 0, end: null });
  advance(s, startMinute);
  return s;
}

/** Simulate whole minutes up to (not including) `toMinute`. */
export function advance(s: SimState, toMinute: number) {
  while (s.minute < toMinute) stepMinute(s);
  s.version++;
}

function stepMinute(s: SimState) {
  const t = s.minute;
  scheduleCalendarStops(s, t);
  startDueStops(s, t);
  startFailures(s, t);
  applyScenarioStops(s, t);
  endFinishedDowntime(s, t);
  produce(s, t);
  stepLogistics(s, t);
  s.minute = t + 1;
}

// ── Calendar: planned cleaning, product changeovers, batches ────────────────

const batchId = (minute: number, n: number) => `B-${formatDate(minute).slice(2).replace(/-/g, '')}-${String(n).padStart(2, '0')}`;

function scheduleCalendarStops(s: SimState, t: number) {
  if (t % SHIFT_MIN === 0) {
    for (const p of PLANNED_STOPS)
      s.internal.pendingStops.push({ equipmentId: p.equipmentId, start: t + p.offset, duration: p.duration, reason: 'PLN_CLEAN' });
  }
  if (t > 0 && t % CHANGEOVER_EVERY_MIN === 120) {
    // New production batch starts at the presses; glaze line changes colour when it arrives (~2.5 h later).
    const n = s.batches.length;
    const prev = s.batches[n - 1];
    prev.end = t;
    s.batches.push({ id: batchId(t, n), sku: PRODUCTS[n % PRODUCTS.length].sku, start: t, end: null });
    const rng = streamFor(s.seed, `chg:${t}`);
    ['E-PRS1', 'E-PRS2', 'E-PRS3'].forEach((id, i) =>
      s.internal.pendingStops.push({ equipmentId: id, start: t + i * 12, duration: Math.round(lerpRange(rng(), 18, 30)), reason: 'CHG_PRODUCT' }),
    );
    s.internal.pendingStops.push({ equipmentId: 'G-LINE', start: t + 150, duration: Math.round(lerpRange(rng(), 12, 20)), reason: 'CHG_PRODUCT' });
    s.internal.pendingStops.push({ equipmentId: 'G-INK', start: t + 158, duration: Math.round(lerpRange(rng(), 8, 14)), reason: 'CHG_PRODUCT' });
  }
}

function startDueStops(s: SimState, t: number) {
  const due = s.internal.pendingStops.filter((p) => p.start <= t);
  if (!due.length) return;
  s.internal.pendingStops = s.internal.pendingStops.filter((p) => p.start > t);
  for (const p of due) {
    const m = s.machines[p.equipmentId];
    if (m.activeDowntimeId) continue; // already stopped; the window is skipped
    openDowntime(s, p.equipmentId, p.reason, t, t + p.duration, 'simulation');
  }
}

function startFailures(s: SimState, t: number) {
  for (const id of PROCESS_MACHINES) {
    if (s.internal.nextFailure[id] > t) continue;
    const m = s.machines[id];
    const rel = OPS_BY_ID[id].reliability!;
    const rng = s.internal.failRng[id];
    if (!m.activeDowntimeId) {
      const reason = weighted(rng(), rel.reasons.map((r, i): [string, number] => [r, 3 - i]));
      const duration = Math.round(lerpRange(rng() ** 1.6, rel.repairMin, rel.repairMax));
      openDowntime(s, id, reason, t, t + duration, 'simulation');
      s.internal.nextFailure[id] = t + duration + Math.round(expBounded(rng(), rel.mtbf, 20, rel.mtbf * 3));
    } else {
      s.internal.nextFailure[id] = t + 5;
    }
  }
}

/** End time scheduled for an open downtime event (not exposed in the record until it ends). */
const scheduledEnd = new WeakMap<DowntimeEvent, number | null>();

function openDowntime(
  s: SimState,
  equipmentId: string,
  reasonCode: string,
  start: number,
  end: number | null,
  source: DowntimeEvent['source'],
  scenarioId?: string,
) {
  const reason = REASON_BY_CODE[reasonCode];
  const ev: DowntimeEvent = {
    id: nextId(s, 'DT'),
    equipmentId,
    reasonCode,
    category: reason.category,
    start,
    end: null,
    lostTiles: 0,
    constraintImpactMin: 0,
    source,
    scenarioId,
  };
  scheduledEnd.set(ev, end);
  s.downtime.push(ev);
  const m = s.machines[equipmentId];
  m.activeDowntimeId = ev.id;
  setState(m, reason.planned ? 'planned' : 'down', start);
  if (!reason.planned) {
    const severity: AlertSeverity = equipmentId === 'H-KILN' ? 'critical' : OPS_BY_ID[equipmentId].stage === 'PRESS' ? 'serious' : 'warning';
    raiseAlert(s, start, severity, `${equipmentId} stopped`, reason.label, { equipmentId }, source);
  }
  return ev;
}

function closeDowntime(s: SimState, ev: DowntimeEvent, t: number) {
  ev.end = t;
  const m = s.machines[ev.equipmentId];
  if (m.activeDowntimeId === ev.id) {
    m.activeDowntimeId = null;
    setState(m, 'running', t);
  }
}

function endFinishedDowntime(s: SimState, t: number) {
  for (const id of PROCESS_MACHINES) {
    const m = s.machines[id];
    if (!m.activeDowntimeId) continue;
    const ev = findDowntime(s, m.activeDowntimeId);
    const end = ev ? scheduledEnd.get(ev) : null;
    if (ev && end != null && end <= t) closeDowntime(s, ev, t);
  }
}

export const findDowntime = (s: SimState, id: string) => {
  for (let i = s.downtime.length - 1; i >= 0; i--) if (s.downtime[i].id === id) return s.downtime[i];
  return undefined;
};

function setState(m: EquipmentRuntime, state: MachineState, t: number) {
  if (m.state !== state) {
    m.state = state;
    m.since = t;
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

const activeScenarios = (s: SimState, t: number) => s.scenarios.filter((sc) => sc.start <= t && (sc.end == null || sc.end > t));

function applyScenarioStops(s: SimState, t: number) {
  for (const sc of activeScenarios(s, t)) {
    if (sc.kind !== 'machine-stop' || !sc.equipmentId) continue;
    const m = s.machines[sc.equipmentId];
    const current = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
    if (current?.scenarioId === sc.id) continue;
    if (current) closeDowntime(s, current, t);
    openDowntime(s, sc.equipmentId, 'SCN_STOP', t, sc.end, 'scenario', sc.id);
  }
}

/** Scenario-driven rate factor for one machine at minute t. */
function scenarioRate(s: SimState, id: string, stage: StageId, t: number) {
  let f = 1;
  for (const sc of activeScenarios(s, t)) {
    if (sc.kind === 'reduced-rate' && sc.equipmentId === id) f *= sc.factor ?? 0.6;
    if (sc.kind === 'bottleneck' && sc.stage === stage) f *= sc.factor ?? 0.55;
  }
  return f;
}

export function activateScenario(s: SimState, def: Omit<ScenarioActivation, 'id' | 'start'> & { start?: number }) {
  const sc: ScenarioActivation = { ...def, id: nextId(s, 'SCN'), start: def.start ?? s.minute };
  s.scenarios.push(sc);
  if (sc.kind === 'machine-stop') applyScenarioStops(s, s.minute);
  applyLogisticsScenario(s, sc);
  raiseAlert(s, sc.start, 'info', `Scenario started: ${sc.label}`, 'Simulated scenario input', { equipmentId: sc.equipmentId }, 'scenario');
  s.version++;
  return sc;
}

export function clearScenario(s: SimState, id: string) {
  const sc = s.scenarios.find((x) => x.id === id);
  if (!sc || (sc.end != null && sc.end <= s.minute)) return;
  sc.end = s.minute;
  if (sc.kind === 'machine-stop' && sc.equipmentId) {
    const m = s.machines[sc.equipmentId];
    const ev = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
    if (ev?.scenarioId === sc.id) closeDowntime(s, ev, s.minute);
  }
  raiseAlert(s, s.minute, 'info', `Scenario cleared: ${sc.label}`, 'Simulated scenario input', { equipmentId: sc.equipmentId }, 'scenario');
  s.version++;
}

// ── Production ────────────────────────────────────────────────────────────────

/** Smooth bounded performance variation (micro-stops, speed losses): 0.90–0.99. */
function performanceNoise(seed: number, id: string, t: number) {
  const k = Math.floor(t / 20);
  const f = (t % 20) / 20;
  const a = noise01(seed, `perf:${id}`, k);
  const b = noise01(seed, `perf:${id}`, k + 1);
  const v = a + (b - a) * (f * f * (3 - 2 * f));
  return 0.9 + 0.09 * v;
}

/** Slow drift of the baseline reject rate (×0.7 – ×1.35). */
function qualityDrift(seed: number, t: number) {
  const k = Math.floor(t / 90);
  const f = (t % 90) / 90;
  const a = noise01(seed, 'qdrift', k);
  const b = noise01(seed, 'qdrift', k + 1);
  return 0.7 + 0.65 * (a + (b - a) * f);
}

const bucket = (s: SimState, id: string, hour: number) => {
  const map = s.hours[id];
  let b = map.get(hour);
  if (!b) {
    b = emptyBucket();
    map.set(hour, b);
  }
  return b;
};

function produce(s: SimState, t: number) {
  const hour = Math.floor(t / 60);
  /** Was the constraint (kiln) held up by input/output this minute? */
  let constraintStalled = false;

  for (let si = STAGES.length - 1; si >= 0; si--) {
    const stage = STAGES[si];
    const inBuf = stage.inputBuffer;
    const outBuf = OUTPUT_BUFFER[stage.id];
    const caps = stage.machines.map((id) => {
      const m = s.machines[id];
      if (m.activeDowntimeId) return 0;
      const ideal = OPS_BY_ID[id].idealRatePerHour! / 60;
      const scn = scenarioRate(s, id, stage.id, t);
      m.rateFactor = scn;
      return ideal * scn * performanceNoise(s.seed, id, t);
    });
    const capTotal = caps.reduce((a, b) => a + b, 0);
    const available = inBuf ? s.buffers[inBuf] : Infinity;
    const space = outBuf ? BUFFER_CAP[outBuf] - s.buffers[outBuf] : Infinity;
    const produced = Math.max(0, Math.min(capTotal, available, space));
    const limitedBy: 'input' | 'output' | null =
      produced < capTotal * 0.999 ? (available <= space ? 'input' : 'output') : null;

    if (inBuf) s.buffers[inBuf] -= produced;
    if (outBuf) s.buffers[outBuf] += produced;

    stage.machines.forEach((id, i) => {
      const m = s.machines[id];
      const b = bucket(s, id, hour);
      const share = capTotal > 0 ? caps[i] / capTotal : 0;
      const made = produced * share;
      m.countTotal += made;
      b.count += made;
      m.ratePerHour = made * 60;
      if (m.activeDowntimeId) {
        const ev = findDowntime(s, m.activeDowntimeId)!;
        if (REASON_BY_CODE[ev.reasonCode].planned) b.plannedStop++;
        else {
          b.planned++;
          b.down++;
          ev.lostTiles += OPS_BY_ID[id].idealRatePerHour! / 60;
        }
        trackSpell(s, id, null, t);
        return;
      }
      b.planned++;
      const runFrac = caps[i] > 0 ? Math.min(1, made / caps[i]) : 0;
      b.operating += runFrac;
      if (limitedBy && runFrac < 0.5) {
        const kind = limitedBy === 'input' ? 'Starved' : 'Blocked';
        if (kind === 'Starved') b.starved += 1 - runFrac;
        else b.blocked += 1 - runFrac;
        setState(m, kind === 'Starved' ? 'starved' : 'blocked', t);
        trackSpell(s, id, kind, t);
      } else {
        if (limitedBy === 'input') b.starved += 1 - runFrac;
        else if (limitedBy === 'output') b.blocked += 1 - runFrac;
        setState(m, m.rateFactor < 0.95 ? 'reduced' : 'running', t);
        trackSpell(s, id, null, t);
      }
    });

    if (stage.id === LINE.designConstraint && (capTotal === 0 || (limitedBy && produced < capTotal * 0.5))) constraintStalled = true;
    if (stage.id === 'SORT') inspect(s, t, hour, produced);
    if (stage.id === 'PAL') {
      s.internal.palletAcc += produced;
      while (s.internal.palletAcc >= TILES_PER_PALLET) {
        s.internal.palletAcc -= TILES_PER_PALLET;
        s.logistics.palletsProduced++;
        s.logistics.putawayQueue++;
        // Warehouse stock counts the pallet from the moment it leaves the wrapper (incl. awaiting put-away).
        s.logistics.stockPallets++;
      }
    }
  }

  // Operational impact: every open unplanned event accrues constraint-stall minutes.
  if (constraintStalled)
    for (const id of PROCESS_MACHINES) {
      const m = s.machines[id];
      if (!m.activeDowntimeId) continue;
      const ev = findDowntime(s, m.activeDowntimeId)!;
      if (!REASON_BY_CODE[ev.reasonCode].planned) ev.constraintImpactMin++;
    }
  if (constraintStalled && s.machines['H-KILN'].state !== 'down' && s.machines['H-KILN'].state !== 'planned') {
    const since = s.machines['H-KILN'].since;
    if (t - since === 10)
      raiseAlert(s, t, 'serious', `Constraint ${s.machines['H-KILN'].state}: H-KILN`, 'Kiln held up for 10 min — line output lost', { equipmentId: 'H-KILN' }, 'simulation');
  }

  for (const b of BUFFERS) {
    const map = s.bufferHours[b.id];
    const minuteInHour = t % 60;
    const level = s.buffers[b.id] / b.capacity;
    map.set(hour, ((map.get(hour) ?? 0) * minuteInHour + level) / (minuteInHour + 1));
  }
}

/** Opens a starved/blocked event once a spell lasts 3 min; closes it when it ends. */
function trackSpell(s: SimState, id: string, kind: 'Starved' | 'Blocked' | null, t: number) {
  const sp = s.internal.spell[id];
  if (sp && sp.kind !== kind) {
    if (sp.eventId) {
      const ev = findDowntime(s, sp.eventId);
      if (ev) ev.end = t;
    }
    s.internal.spell[id] = null;
  }
  if (!kind) return;
  const cur = s.internal.spell[id];
  if (!cur) {
    s.internal.spell[id] = { kind, start: t, eventId: null };
    return;
  }
  if (!cur.eventId && t - cur.start >= 3) {
    const ev: DowntimeEvent = {
      id: nextId(s, 'DT'),
      equipmentId: id,
      reasonCode: kind === 'Starved' ? 'STARVED' : 'BLOCKED',
      category: kind,
      start: cur.start,
      end: null,
      lostTiles: (OPS_BY_ID[id].idealRatePerHour! / 60) * (t - cur.start),
      constraintImpactMin: 0,
      source: 'simulation',
    };
    s.downtime.push(ev);
    cur.eventId = ev.id;
  } else if (cur.eventId) {
    const ev = findDowntime(s, cur.eventId);
    if (ev) ev.lostTiles += OPS_BY_ID[id].idealRatePerHour! / 60;
  }
}

// ── Quality ───────────────────────────────────────────────────────────────────

function rejectRate(s: SimState, t: number) {
  let rate = BASE_REJECT_RATE * qualityDrift(s.seed, t);
  const boosts: Partial<Record<DefectCategory, number>> = {};
  for (const sc of activeScenarios(s, t)) {
    if (sc.kind !== 'quality-deterioration') continue;
    const mult = sc.factor ?? 3;
    // Concentrate the deterioration in the defects originating at the chosen stage.
    for (const d of DEFECT_ORDER) if (!sc.stage || DEFECTS[d].origin === sc.stage) boosts[d] = (boosts[d] ?? 1) * mult;
  }
  const weights = DEFECT_ORDER.map((d): [DefectCategory, number] => [d, DEFECTS[d].weight * (boosts[d] ?? 1)]);
  const baseWeight = DEFECT_ORDER.reduce((a, d) => a + DEFECTS[d].weight, 0);
  const totalWeight = weights.reduce((a, [, w]) => a + w, 0);
  return { rate: rate * (totalWeight / baseWeight), weights, totalWeight };
}

function inspect(s: SimState, t: number, hour: number, inspected: number) {
  if (inspected <= 0) return;
  const { rate, weights, totalWeight } = rejectRate(s, t);
  const rejected = Math.min(inspected, inspected * rate);
  const good = inspected - rejected;
  s.lineGood.set(hour, (s.lineGood.get(hour) ?? 0) + good);
  const sortBucket = bucket(s, 'I-SORT', hour);
  void sortBucket;

  let qh = s.quality.get(hour);
  if (!qh) {
    qh = Object.fromEntries(INSPECTION_STATIONS.map((st) => [st.id, { inspected: 0, rejected: 0, byDefect: {} }]));
    s.quality.set(hour, qh);
  }
  qh['ST-GAUGE'].inspected += inspected;
  qh['ST-VIS'].inspected += inspected;

  const batch = batchAt(s, t - 180);
  for (const [defect, w] of weights) {
    const n = rejected * (w / totalWeight);
    const def = DEFECTS[defect];
    const st = qh[def.station];
    st.rejected += n;
    st.byDefect[defect] = (st.byDefect[defect] ?? 0) + n;
    attributeRejects(s, def.origin, hour, n);
    const key = `${def.station}:${defect}`;
    s.internal.recordAcc[key] = (s.internal.recordAcc[key] ?? 0) + n;
    while (s.internal.recordAcc[key] >= TILES_PER_RECORD) {
      s.internal.recordAcc[key] -= TILES_PER_RECORD;
      pushInspection(s, t, def.station, batch.id, defect);
    }
  }
  // QC laboratory sample every 60 min.
  if (t % 60 === 30) {
    const rng = s.internal.qualityRng;
    const pass = rng() > 0.05;
    const wa = (0.32 + rng() * (pass ? 0.12 : 0.3)).toFixed(2);
    const mor = (34 + rng() * 8).toFixed(1);
    pushRecord(s, {
      id: nextId(s, 'INS'),
      time: t,
      stationId: 'ST-QC',
      batchId: batch.id,
      result: pass ? 'pass' : 'reject',
      defect: null,
      severity: pass ? null : 'minor',
      measurement: `Water absorption ${wa} % · MOR ${mor} N/mm²${pass ? '' : ' · retest requested'}`,
      tiles: 5,
      source: 'simulation',
    });
  }
  const recent = recentRejectRate(s, t);
  if (recent > 0.05 && t - (s.internal.alertAt['quality'] ?? -1e9) > 120) {
    s.internal.alertAt['quality'] = t;
    raiseAlert(s, t, 'serious', 'Reject rate above 5 %', `Sorting reject rate ${(recent * 100).toFixed(1)} % over the last hour`, { equipmentId: 'I-VIS' }, 'simulation');
  }
}

function recentRejectRate(s: SimState, t: number) {
  const h = Math.floor(t / 60);
  const q = s.quality.get(h);
  if (!q || q['ST-VIS'].inspected < 200) return 0;
  return (q['ST-VIS'].rejected + q['ST-GAUGE'].rejected) / q['ST-VIS'].inspected;
}

/** Reject tiles are charged to the machines of the stage where the defect originated. */
function attributeRejects(s: SimState, stage: StageId, hour: number, n: number) {
  const machines = STAGE_BY_ID[stage].machines;
  const counts = machines.map((id) => s.hours[id].get(hour)?.count ?? 0);
  const total = counts.reduce((a, b) => a + b, 0);
  machines.forEach((id, i) => {
    const share = total > 0 ? counts[i] / total : 1 / machines.length;
    bucket(s, id, hour).rejects += n * share;
    s.machines[id].countRejectAttributed += n * share;
  });
}

const MEASURE: Record<DefectCategory, (r: Rng) => string> = {
  crack: (r) => `Crack length ≈ ${Math.round(6 + r() * 30)} mm`,
  chip: (r) => `Edge chip ≈ ${(1.5 + r() * 4).toFixed(1)} mm`,
  surface: (r) => `${Math.round(2 + r() * 9)} pinholes / spots in 100 cm²`,
  glaze: (r) => `Glaze weight deviation ${(r() > 0.5 ? '+' : '−')}${(4 + r() * 9).toFixed(1)} %`,
  shade: (r) => `ΔE ${(1.1 + r() * 1.6).toFixed(1)} vs master`,
  planarity: (r) => `Centre deviation ${(r() > 0.4 ? '+' : '−')}${(0.42 + r() * 0.5).toFixed(2)} mm (limit ±0.40)`,
  dimension: (r) => `Caliber ${(600 + (r() - 0.5) * 2.4).toFixed(1)} mm (600 ± 0.6)`,
};

function pushInspection(s: SimState, t: number, stationId: string, batchIdValue: string, defect: DefectCategory) {
  const r = s.internal.qualityRng;
  const sev = weighted(r(), [
    ['minor', 0.62],
    ['major', 0.32],
    ['critical', 0.06],
  ] as ['minor' | 'major' | 'critical', number][]);
  pushRecord(s, {
    id: nextId(s, 'INS'),
    time: t,
    stationId,
    batchId: batchIdValue,
    result: 'reject',
    defect,
    severity: sev,
    measurement: MEASURE[defect](r),
    tiles: TILES_PER_RECORD,
    source: activeScenarios(s, t).some((sc) => sc.kind === 'quality-deterioration') ? 'scenario' : 'simulation',
  });
}

function pushRecord(s: SimState, rec: QualityInspection) {
  s.inspections.push(rec);
  if (s.inspections.length > MAX_INSPECTIONS) s.inspections.splice(0, s.inspections.length - MAX_INSPECTIONS);
}

export function batchAt(s: SimState, t: number): ProductionBatch {
  for (let i = s.batches.length - 1; i >= 0; i--) if (s.batches[i].start <= t) return s.batches[i];
  return s.batches[0];
}

// ── Alerts ────────────────────────────────────────────────────────────────────

export function raiseAlert(
  s: SimState,
  time: number,
  severity: AlertSeverity,
  title: string,
  detail: string,
  ref: { equipmentId?: string; vehicleId?: string },
  source: Alert['source'],
) {
  s.alerts.push({ id: nextId(s, 'AL'), time, severity, title, detail, ...ref, source });
  if (s.alerts.length > MAX_ALERTS) s.alerts.splice(0, s.alerts.length - MAX_ALERTS);
}

/** Open (unfinished) downtime events. */
export const activeDowntime = (s: SimState) => s.downtime.filter((d) => d.end == null);

/** Scenarios currently in effect. */
export const scenariosActive = (s: SimState) => activeScenarios(s, s.minute);
