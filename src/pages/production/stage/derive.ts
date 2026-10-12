/**
 * Stage view derivations (Production → Plan & flow → a stage) — pure functions over the one simulation state (no React,
 * no stores; unit-tested in derive.test.ts). Everything is read from the configurable
 * MONITORED_STAGES registry (counting points, equipment, conveyors, cameras) and the shared
 * metrics / event engine, so this workspace can never disagree with the others.
 *
 * Observed vs inferred: a stage's state is what its equipment signals report; a cause is only
 * attached when the event engine linked the stage's starvation / blockage to a root event
 * (`consequenceOf`) — never guessed here.
 */
import { EQUIPMENT_BY_ID } from '../../../data/equipment';
import { eventInMonitoredStage } from '../../../sim/events';
import {
  BUFFERS,
  CONDITION_MONITORED,
  CONVEYOR_BY_ID,
  DOCKS,
  LINE,
  M2_PER_TILE,
  MONITORED_STAGES,
  OPS_BY_ID,
  SCENARIO_KIND_LABELS,
  SIGNALS,
  STAGES,
} from '../../../model/plant';
import type {
  AlertSeverity,
  MonitoredStage,
  MonitoredStageId,
  OpEvent,
  OperationalState,
  ScenarioActivation,
  ScenarioKind,
  SignalDef,
  StageId,
} from '../../../model/types';
import { LOG_MIN, TRACKED_ASSETS, minuteAt, type SimState } from '../../../sim/engine';
import { eventById } from '../../../sim/events';
import { lineGoodLostTiles } from '../../../intel/report';
import { HEALTH_BY_ID, sensorHistory } from '../../../sim/health';
import { operationalState, stageIO, sumBuckets, type Period, type PeriodKey, type StageIO } from '../../../sim/metrics';
import { constraintClaim, constraintPhrase, type ConstraintClaim } from '../../../intel/summary';
import { outputStale, type FlowStale } from '../../../ui/flow/derive';
import { signalValue } from '../../../sim/signals';
import { BASIS_LABEL, basisOf, type SignalBasis } from '../../../ui/equipment/signals';
import { formatClock, formatDateTime, formatDay, formatDuration, shiftAt } from '../../../sim/time';

/** "since 09:12" for a time today, "since Sun 11 Oct 11:37" for an older one (a bare clock time would read as today). */
export const sinceLabel = (t: number, now: number) => (now - t < 720 && Math.floor(t / 1440) === Math.floor(now / 1440) ? formatClock(t) : formatDateTime(t));

// ── Registry helpers ──────────────────────────────────────────────────────────

/** Process stages whose machines all belong to a monitored stage (GLAZE = glazing + decoration, PACK = packing + palletising). */
export const SUB_STAGES: Record<MonitoredStageId, StageId[]> = Object.fromEntries(
  MONITORED_STAGES.map((ms) => [ms.id, STAGES.filter((st) => st.machines.every((m) => ms.equipment.includes(m))).map((st) => st.id)]),
) as Record<MonitoredStageId, StageId[]>;

/** Monitored stage (registry) that contains an asset — its equipment first, then the stages listing it as a conveyor. */
export function assetStage(id: string): MonitoredStageId | null {
  return MONITORED_STAGES.find((ms) => ms.equipment.includes(id))?.id ?? MONITORED_STAGES.find((ms) => ms.conveyors.includes(id))?.id ?? null;
}

/** Monitored stage that contains a process stage. */
export const monitoredStageOf = (stage: StageId): MonitoredStageId | null =>
  MONITORED_STAGES.find((ms) => SUB_STAGES[ms.id].includes(stage))?.id ?? null;

const TRACKED = new Set(TRACKED_ASSETS);
export const isTracked = (id: string) => TRACKED.has(id);
export const isConveyor = (id: string) => CONVEYOR_BY_ID[id] != null;
export const isMachine = (id: string) => OPS_BY_ID[id]?.idealRatePerHour != null;
export const assetName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;

export type AssetKind = 'machine' | 'conveyor' | 'asset';
export const assetKind = (id: string): AssetKind => (isConveyor(id) ? 'conveyor' : isMachine(id) ? 'machine' : 'asset');
export const ASSET_KIND_LABEL: Record<AssetKind, string> = { machine: 'Machine', conveyor: 'Conveyor', asset: 'Storage / dock' };

/** Equipment then conveyors of a stage, in registry order. */
export const stageAssetIds = (ms: MonitoredStage) => [...ms.equipment, ...ms.conveyors];

// ── Asset state & data feed ──────────────────────────────────────────────────

/** Worst first: stopped / faulted, then unknown (stale data), held up, slow, idle, planned, running. */
export const STATE_RANK: Record<OperationalState, number> = {
  fault: 0,
  stopped: 1,
  unknown: 2,
  disconnected: 3,
  starved: 4,
  blocked: 5,
  reduced: 6,
  idle: 7,
  planned: 8,
  running: 9,
};

export type FeedView = { status: 'simulated' | 'stale'; since: number | null; label: string };

/** Data-feed status of an asset. Nothing is connected, so a healthy feed reads "Simulated" — never "Live". */
export function feedOf(s: SimState, id: string): FeedView {
  const f = s.feeds[id];
  if (f?.status === 'stale') return { status: 'stale', since: f.since, label: `Stale since ${formatClock(f.since)}` };
  return { status: 'simulated', since: null, label: 'Simulated' };
}

export type AssetView = {
  id: string;
  name: string;
  kind: AssetKind;
  /** Null when the asset has no state signal configured (storage, docks). */
  state: OperationalState | null;
  /** Minute the shown state started (feed loss time when the state is unknown). */
  since: number | null;
  feed: FeedView;
  /** Current rate, tiles/h (last value received when the feed is stale). */
  rate: number | null;
  /** Ideal rate (machines) or nominal capacity (conveyors), tiles/h. */
  nominal: number | null;
  /** Current reading of an asset without a state signal (warehouse stock, dock occupancy), if any. */
  reading: string | null;
};

export function assetView(s: SimState, id: string): AssetView {
  const m = s.machines[id];
  const feed = feedOf(s, id);
  const stale = feed.status === 'stale';
  const f = s.feeds[id];
  return {
    id,
    name: assetName(id),
    kind: assetKind(id),
    state: m ? operationalState(s, id) : null,
    since: m ? (stale ? feed.since : m.since) : null,
    feed,
    rate: m ? (stale ? (f?.lastRate ?? null) : m.ratePerHour) : null,
    nominal: OPS_BY_ID[id]?.idealRatePerHour ?? CONVEYOR_BY_ID[id]?.capacityPerHour ?? null,
    reading: m ? null : warehouseReading(s, id),
  };
}

export const worstFirst = (xs: AssetView[]) =>
  [...xs].sort((a, b) => (a.state == null ? 99 : STATE_RANK[a.state]) - (b.state == null ? 99 : STATE_RANK[b.state]));

// ── Events of a stage ─────────────────────────────────────────────────────────

/** Assets whose events also belong to a stage although they are not in its equipment list (detection points). */

/**
 * Whether an event belongs to a monitored stage: its asset is one of the stage's machines or
 * conveyors, or its stage is one of the stage's process stages (quality events carry the defect's
 * origin stage). Conveyor events match only the stages that list the conveyor.
 */
export const eventInStage = (ms: MonitoredStage, e: OpEvent): boolean => eventInMonitoredStage(ms, e);

/** Events of a stage overlapping [from, to] (all when omitted), newest first. */
export function stageEvents(s: SimState, ms: MonitoredStage, from?: number, to?: number): OpEvent[] {
  return s.events
    .filter((e) => eventInStage(ms, e) && (from == null || (e.end ?? s.minute) >= from) && (to == null || e.start <= to))
    .sort((a, b) => b.start - a.start || (a.id < b.id ? 1 : -1));
}

const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };
export const worstSeverity = (events: OpEvent[]): AlertSeverity | null =>
  events.reduce<AlertSeverity | null>((w, e) => (w == null || SEV_RANK[e.severity] > SEV_RANK[w] ? e.severity : w), null);

export type CauseLine = { held: 'starved' | 'blocked'; root: OpEvent; consequence: OpEvent; confidence: 'confirmed' | 'likely' | 'possible' };

/**
 * Inferred cause of a stage being starved / blocked — only when the event engine linked an active
 * starvation / blockage event of the stage to a root event. Otherwise null: show the state only.
 */
export function inferredCause(s: SimState, events: OpEvent[]): CauseLine | null {
  const c = events.find((e) => e.end == null && (e.type === 'starvation' || e.type === 'blockage') && e.consequenceOf);
  if (!c) return null;
  const root = eventById(s, c.consequenceOf!);
  if (!root) return null;
  const linked = c.causes.find((x) => x.relatedEventId === root.id) ?? c.causes[0];
  return { held: c.type === 'starvation' ? 'starved' : 'blocked', root, consequence: c, confidence: linked?.confidence ?? 'likely' };
}

// ── Overview ──────────────────────────────────────────────────────────────────

/**
 * The line constraint as Production marks it: the stage the shared constraint claim names
 * (constraintClaim in src/intel/summary.ts — the Overview's, flow strip's and twin's statement), never
 * a trace of its own.
 */
export type BottleneckView = {
  /** Monitored stage the claim names. */
  stage: MonitoredStageId;
  processStage: StageId;
  name: string;
  /** "Currently constraining output" is supported by the evidence. */
  constraining: boolean;
  /** "Constraint" or "Design constraint" (claim.label). */
  label: string;
  /** Trace window in words, e.g. "the last 2 h". */
  windowLabel: string;
  claim: ConstraintClaim;
};

export function bottleneckView(s: SimState, claim: ConstraintClaim = constraintClaim(s)): BottleneckView {
  return { stage: claim.stage, processStage: claim.processStage, name: claim.name, constraining: claim.constraining, label: claim.label, windowLabel: claim.window, claim };
}

export type StageRow = {
  ms: MonitoredStage;
  io: StageIO;
  /** Equipment (worst first) and conveyors (worst first). */
  equipment: AssetView[];
  conveyors: AssetView[];
  /** Worst observed state of the stage's state-monitored equipment; null when none has a state signal. */
  state: OperationalState | null;
  cause: CauseLine | null;
  active: OpEvent[];
  worst: AlertSeverity | null;
  /** Assets whose data feed is stale (state unknown, counter frozen at the last received value). */
  stale: AssetView[];
  /**
   * The not-confirmed mark of the stage's counts: a feed of its output counting point is stale in the
   * period (outputStale — the flow strip's rule and text). The counts stay the running figures.
   */
  staleMark: FlowStale | null;
  /** The constraint claim names this stage. */
  isBottleneck: boolean;
  /** The claim, when it names this stage (its label and phrase are what the stage shows). */
  constraint: ConstraintClaim | null;
  /** The line's configured (modeled) design constraint is in this stage. */
  isConstraint: boolean;
  /** Plant minute the row describes ("now"). */
  now: number;
};

export function stageRow(s: SimState, ms: MonitoredStage, p: Period, bn: BottleneckView, events?: OpEvent[]): StageRow {
  const equipment = worstFirst(ms.equipment.map((id) => assetView(s, id)));
  const conveyors = worstFirst(ms.conveyors.map((id) => assetView(s, id)));
  const evs = events ?? stageEvents(s, ms);
  const active = evs.filter((e) => e.end == null);
  const monitored = equipment.filter((a) => a.state != null);
  return {
    ms,
    io: stageIO(s, ms.id, p),
    equipment,
    conveyors,
    state: monitored[0]?.state ?? null,
    cause: inferredCause(s, active),
    active,
    worst: worstSeverity(active),
    stale: [...equipment, ...conveyors].filter((a) => a.feed.status === 'stale'),
    staleMark: outputStale(s, ms.id, p),
    isBottleneck: bn.stage === ms.id,
    constraint: bn.stage === ms.id ? bn.claim : null,
    isConstraint: (SUB_STAGES[ms.id] as string[]).includes(LINE.designConstraint),
    now: s.minute,
  };
}

export type Overview = {
  rows: StageRow[];
  bn: BottleneckView;
  stopped: AssetView[];
  stale: AssetView[];
  active: OpEvent[];
  worst: AlertSeverity | null;
  /** Stages with a stopped / unknown / held-up state or an active warning-or-worse event. */
  attention: StageRow[];
  lineGood: number | null;
};

const NEEDS_ATTENTION: OperationalState[] = ['fault', 'stopped', 'unknown', 'disconnected', 'starved', 'blocked', 'reduced'];

export function overview(s: SimState, p: Period, bn: BottleneckView = bottleneckView(s)): Overview {
  const rows = MONITORED_STAGES.map((ms) => stageRow(s, ms, p, bn));
  const assets = new Map<string, AssetView>();
  for (const r of rows) for (const a of [...r.equipment, ...r.conveyors]) assets.set(a.id, a);
  const all = [...assets.values()];
  const active = new Map<string, OpEvent>();
  for (const r of rows) for (const e of r.active) active.set(e.id, e);
  const act = [...active.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.start - a.start);
  return {
    rows,
    bn,
    stopped: all.filter((a) => a.state === 'fault' || a.state === 'stopped'),
    stale: all.filter((a) => a.feed.status === 'stale'),
    active: act,
    worst: worstSeverity(act),
    attention: rows.filter((r) => (r.state != null && NEEDS_ATTENTION.includes(r.state)) || r.active.some((e) => SEV_RANK[e.severity] >= SEV_RANK.warning)),
    lineGood: rows.find((r) => r.ms.id === 'SORT')?.io.good ?? null,
  };
}

// ── Counting-point display ────────────────────────────────────────────────────

export type CountCell = { measured: boolean; value: number | null; unit: string; label: string; note: string | null; signalId: string | null };

/** A counted quantity as the registry defines it: not measured → no number, whatever the model could infer. */
export function countCell(ms: MonitoredStage, which: 'input' | 'output' | 'good' | 'rejected', io: StageIO): CountCell | null {
  const cp = ms[which];
  if (!cp) return null;
  return { measured: cp.measured, value: cp.measured ? io[which] : null, unit: cp.unit, label: cp.label, note: cp.note ?? null, signalId: cp.signalId };
}

/** Actual rate as a share of the expected rate (ideal × planned running time); null when there is no expectation. */
export const rateShare = (io: StageIO) => (io.expectedPerHour != null && io.expectedPerHour > 0 && io.ratePerHour != null ? io.ratePerHour / io.expectedPerHour : null);

export const wipShare = (io: StageIO) => (io.wip != null && io.wipCapacity ? io.wip / io.wipCapacity : null);

export const bufferName = (id: string | null) => (id ? (BUFFERS.find((b) => b.id === id)?.name ?? id) : null);

// ── Sentences ─────────────────────────────────────────────────────────────────

const PERIOD_PHRASE: Record<PeriodKey, string> = {
  shift: 'this shift',
  'prev-shift': 'in the previous shift',
  today: 'today',
  '24h': 'in the last 24 h',
  '7d': 'in the last 7 days',
};

const fmtN = (v: number) => Math.round(v).toLocaleString('en-GB');
const STATE_WORD: Record<OperationalState, string> = {
  running: 'running',
  reduced: 'running below rate',
  idle: 'idle (no material)',
  stopped: 'stopped',
  fault: 'in fault',
  starved: 'starved',
  blocked: 'blocked',
  planned: 'in a planned stop',
  disconnected: 'disconnected',
  unknown: 'of unknown state (data stale)',
};
export const stateWord = (st: OperationalState) => STATE_WORD[st];

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

/**
 * One-sentence answer: what the stage made (stated as not confirmed while its counting point's feed is
 * stale), how its equipment is doing, its buffer, any data gaps and — at the stage the shared
 * constraint claim names — the claim in the Overview's words.
 */
export function stageSentence(r: StageRow, periodKey: PeriodKey): string {
  const { ms, io } = r;
  const when = PERIOD_PHRASE[periodKey];
  const parts: string[] = [];
  if (ms.id === 'WH') {
    parts.push(`${ms.name} received ${fmtN(io.input ?? 0)} pallets from the wrapper and dispatched ${fmtN(io.output ?? 0)} ${when}; ${fmtN(io.wip ?? 0)} pallets are in stock.`);
  } else {
    const share = rateShare(io);
    const rate = share != null ? `${Math.round(share * 100)} % of the expected rate` : null;
    parts.push(
      r.staleMark
        ? `${ms.name} output ${when} not confirmed — ${r.staleMark.reason} (simulated running total ${fmtN(io.output ?? 0)} ${ms.output.unit}${rate ? `, ${rate}` : ''}).`
        : `${ms.name} put out ${fmtN(io.output ?? 0)} ${ms.output.unit} ${when}${rate ? ` — ${rate}` : ''}.`,
    );
  }
  if (r.constraint) parts.push(`${cap(constraintPhrase(r.constraint))}.`);
  const monitored = r.equipment.filter((a) => a.state != null);
  const off = monitored.filter((a) => a.state !== 'running');
  if (monitored.length && !off.length) parts.push(monitored.length === 1 ? `${monitored[0].id} is running.` : `All ${monitored.length} machines are running.`);
  else if (off.length)
    parts.push(
      `${off
        .slice(0, 3)
        .map((a) => `${a.id} is ${STATE_WORD[a.state!]}${a.since != null ? ` since ${sinceLabel(a.since, r.now)}` : ''}`)
        .join('; ')}${off.length > 3 ? ` (+${off.length - 3} more)` : ''}.`,
    );
  const stoppedConv = r.conveyors.filter((c) => c.state === 'stopped' || c.state === 'fault' || c.state === 'unknown');
  if (stoppedConv.length) parts.push(`${stoppedConv.map((c) => `${c.id} is ${STATE_WORD[c.state!]}`).join('; ')}.`);
  const w = wipShare(io);
  if (w != null) parts.push(`Input buffer (${bufferName(ms.wipBufferId)}) at ${Math.round(w * 100)} %.`);
  if (r.stale.length)
    parts.push(
      `Data feed of ${r.stale.map((a) => `${a.id} stale since ${sinceLabel(a.feed.since ?? a.since ?? 0, r.now)}`).join(', ')}: state unknown, signal values frozen at the last value received.`,
    );
  return parts.join(' ');
}

// ── Production trend ──────────────────────────────────────────────────────────

export type TrendBucket = { key: string; label: string; tip: string; from: number; to: number; input: number | null; output: number; expected: number | null; partial: boolean };

/** Hourly buckets up to ~26 h, shift buckets beyond (same rule as the line trend). */
export function stageTrend(s: SimState, ms: MonitoredStage, p: Period): { granularity: 'hour' | 'shift'; buckets: TrendBucket[] } {
  const granularity = p.to - p.from > 26 * 60 ? 'shift' : 'hour';
  const slots: { from: number; to: number; start: number; end: number; label: string; tip: string }[] = [];
  if (granularity === 'hour') {
    for (let h = Math.floor(p.from / 60) * 60; h < p.to; h += 60)
      slots.push({ from: Math.max(h, p.from), to: Math.min(h + 60, p.to), start: h, end: h + 60, label: formatClock(h), tip: `${formatDay(h)} ${formatClock(h)}–${formatClock(h + 60)}` });
  } else {
    let sh = shiftAt(p.from);
    while (sh.start < p.to) {
      slots.push({ from: Math.max(sh.start, p.from), to: Math.min(sh.end, p.to), start: sh.start, end: sh.end, label: `${formatDay(sh.start).split(' ')[0].replace(',', '')} ${sh.id}`, tip: `${formatDay(sh.start)} · ${sh.label}` });
      sh = shiftAt(sh.end);
    }
  }
  const buckets = slots
    .filter((x) => x.to > x.from)
    .map((x) => {
      const io = stageIO(s, ms.id, { from: x.from, to: x.to, label: '' });
      const hrs = Math.max(1 / 60, (x.to - x.from) / 60);
      return {
        key: String(x.start),
        label: x.label,
        tip: x.tip,
        from: x.from,
        to: x.to,
        input: ms.input.measured ? io.input : null,
        output: io.output ?? 0,
        expected: io.expectedPerHour != null ? io.expectedPerHour * hrs : null,
        partial: x.from > x.start || x.to < x.end,
      };
    });
  return { granularity, buckets };
}

// ── Signal trends (configured per equipment type from SIGNALS) ───────────────

export type TrendSource = 'minute-log' | 'condition' | 'buffer-log';
export type TrendSignal = {
  signal: SignalDef;
  label: string;
  unit: string;
  source: TrendSource;
  bufferId?: string;
  /** Monitored component of a condition signal (HEALTH_BY_ID[id].component) — the sensor sits there, not on the process. */
  component?: string;
};

const CONDITION_MEASURE: Record<string, string> = { vibration: 'Vibration velocity', temperature: 'Temperature', motor_current: 'Motor current' };

/**
 * Signals of an asset that have a history in this release: output rate (per-minute log, last 4 h),
 * condition signals of condition-monitored assets, and buffer levels. Other signals are current-value only.
 * A condition chart is named after the monitored component ("Temperature · Roller drive gearmotor · firing zone"):
 * a bare "Temperature" on the kiln would read as a firing temperature, which the model does not have.
 */
export function trendSignals(assetId: string): TrendSignal[] {
  const out: TrendSignal[] = [];
  const health = HEALTH_BY_ID[assetId];
  for (const sig of SIGNALS) {
    if (sig.equipmentId !== assetId) continue;
    if (sig.name === 'rate' && isTracked(assetId)) out.push({ signal: sig, label: 'Output rate', unit: 'tiles/h', source: 'minute-log' });
    else if (sig.name === 'tile_count' && isTracked(assetId)) out.push({ signal: sig, label: 'Tiles transported', unit: 'tiles/h', source: 'minute-log' });
    else if (CONDITION_MONITORED.includes(assetId) && health && CONDITION_MEASURE[sig.name])
      out.push({ signal: sig, label: `${CONDITION_MEASURE[sig.name]} · ${health.component}`, unit: sig.unit, source: 'condition', component: health.component });
    else if (sig.name === 'level') {
      const b = BUFFERS.find((x) => x.equipmentId === assetId);
      if (b) out.push({ signal: sig, label: `${b.name} level`, unit: '%', source: 'buffer-log', bufferId: b.id });
    }
  }
  return out;
}

export type SignalRow = {
  id: string;
  name: string;
  unit: string;
  kind: SignalDef['kind'];
  /**
   * Current simulated value — null when the signal has no physical model behind it (placeholder process values such as
   * kiln / dryer temperatures, powder moisture) or belongs to the illustrative energy model: those are listed, never valued.
   */
  value: string | null;
  /** Shown instead of a value when `value` is null ("Not modelled" / "Not monitored"). */
  valueLabel: string | null;
  /** How the value is produced (the same classification as the equipment workspace's Technical details). */
  basis: SignalBasis;
  basisLabel: string;
  staleSince: number | null;
  trend: boolean;
};

/** Every configured signal of an asset with its current (simulated) value — placeholder / energy-model values withheld. */
export function signalRows(s: SimState, assetId: string): SignalRow[] {
  const trend = new Set(trendSignals(assetId).map((t) => t.signal.id));
  return SIGNALS.filter((x) => x.equipmentId === assetId).map((x) => {
    const r = signalValue(s, x.id);
    const basis = basisOf(x.name);
    const withheld = basis === 'placeholder' ? 'Not modelled' : basis === 'energy-model' ? 'Not monitored' : null;
    return {
      id: x.id,
      name: x.name,
      unit: x.unit,
      kind: x.kind,
      value: withheld ? null : r.text,
      valueLabel: withheld,
      basis,
      basisLabel: BASIS_LABEL[basis],
      staleSince: !withheld && r.quality === 'stale' ? (r.since ?? null) : null,
      trend: trend.has(x.id),
    };
  });
}

export type Series = { t: number[]; v: (number | null)[] };

/** First minute of a trend window: the last `minutes` simulated minutes, clipped to the minute log. */
const windowStart = (s: SimState, minutes: number) => Math.max(0, s.minute - Math.min(minutes, LOG_MIN));

/** Per-minute output rate (tiles/h) from the minute log; no values after a data feed went stale. */
export function rateHistory(s: SimState, id: string, minutes = LOG_MIN): Series {
  const staleFrom = feedOf(s, id).since;
  const t: number[] = [];
  const v: (number | null)[] = [];
  for (let m = windowStart(s, minutes); m < s.minute; m++) {
    t.push(m);
    const x = staleFrom != null && m >= staleFrom ? null : minuteAt(s, id, m);
    v.push(x ? Math.round(x.rate * 60) : null);
  }
  return { t, v };
}

/** Condition signals (simulated sensors) sampled every `step` minutes; no values after a feed went stale. */
export function conditionHistory(s: SimState, id: string, minutes = LOG_MIN, step = 2) {
  const staleFrom = feedOf(s, id).since;
  const hist = HEALTH_BY_ID[id] ? sensorHistory(s, id, minutes, step) : [];
  const cut = <T,>(r: { t: number }, v: T) => (staleFrom != null && r.t >= staleFrom ? null : v);
  return {
    t: hist.map((r) => r.t),
    vibration: hist.map((r) => cut(r, Math.round(r.vibration * 100) / 100)),
    temperature: hist.map((r) => cut(r, Math.round(r.temperature * 10) / 10)),
    current: hist.map((r) => cut(r, Math.round(r.current))),
  };
}

/** Buffer level (% of capacity) per minute from the buffer log. */
export function bufferHistory(s: SimState, bufferId: string, minutes = LOG_MIN): Series {
  const log = s.bufferLog[bufferId];
  const cap = BUFFERS.find((b) => b.id === bufferId)?.capacity ?? 0;
  const t: number[] = [];
  const v: (number | null)[] = [];
  for (let m = windowStart(s, minutes); m < s.minute; m++) {
    t.push(m);
    const i = m % LOG_MIN;
    v.push(log && cap && log.t[i] === m ? Math.round((log.level[i] / cap) * 1000) / 10 : null);
  }
  return { t, v };
}

// ── Production losses ─────────────────────────────────────────────────────────

export type LossRow = {
  id: string;
  name: string;
  kind: AssetKind;
  downMin: number;
  starvedMin: number;
  blockedMin: number;
  plannedStopMin: number;
  /** Tiles not made vs the ideal rate over planned time (machines only; null for conveyors). */
  lostTiles: number | null;
  speedLossTiles: number | null;
  /** Minutes the kiln was held up with one of this asset's events as the root cause. */
  constraintMin: number;
  /** Good line output lost in those minutes (tiles): kiln tiles × first-pass yield, as in the event report. */
  constraintLostTiles: number;
  /** Root events counted for the constraint figures. */
  eventIds: string[];
  isConstraint: boolean;
};

/**
 * Asset-level losses of a stage over a period (hour-bucket accounting) and whether they reached the
 * line constraint: kiln-held minutes accumulated by the asset's own root events (consequence events
 * are excluded — their loss belongs to the root, as in the event report).
 */
export function stageLosses(s: SimState, ms: MonitoredStage, p: Period): LossRow[] {
  const ids = stageAssetIds(ms).filter(isTracked);
  return ids.map((id) => {
    const b = sumBuckets(s, id, p);
    const ideal = OPS_BY_ID[id]?.idealRatePerHour;
    const perMin = ideal ? ideal / 60 : null;
    const lost = perMin != null ? Math.max(0, perMin * b.planned - b.count) : null;
    const held = perMin != null ? perMin * (b.down + b.starved + b.blocked) : 0;
    const roots = s.events.filter(
      (e) => e.asset.equipmentId === id && e.category === 'production' && !e.consequenceOf && e.start < p.to && (e.end ?? s.minute) >= p.from,
    );
    return {
      id,
      name: assetName(id),
      kind: assetKind(id),
      downMin: b.down,
      starvedMin: b.starved,
      blockedMin: b.blocked,
      plannedStopMin: b.plannedStop,
      lostTiles: lost,
      speedLossTiles: lost != null ? Math.max(0, lost - held) : null,
      constraintMin: roots.reduce((a, e) => a + e.acc.constraintMin, 0),
      constraintLostTiles: roots.reduce((a, e) => a + lineGoodLostTiles(s, e), 0),
      eventIds: roots.filter((e) => e.acc.constraintMin > 0).map((e) => e.id),
      isConstraint: OPS_BY_ID[id]?.stage === LINE.designConstraint,
    };
  });
}

export type LossTotals = {
  lostTiles: number;
  downMin: number;
  /** Starved + blocked minutes, summed over the assets. */
  heldMin: number;
  constraintMin: number;
  constraintLostTiles: number;
  eventIds: string[];
};

/** Stage totals of the asset rows (minutes summed over assets; constraint figures per root event). */
export function lossTotals(rows: LossRow[]): LossTotals {
  const ids = new Set<string>();
  const t: LossTotals = { lostTiles: 0, downMin: 0, heldMin: 0, constraintMin: 0, constraintLostTiles: 0, eventIds: [] };
  for (const r of rows) {
    t.lostTiles += r.lostTiles ?? 0;
    t.downMin += r.downMin;
    t.heldMin += r.starvedMin + r.blockedMin;
    t.constraintMin += r.constraintMin;
    t.constraintLostTiles += r.constraintLostTiles;
    for (const id of r.eventIds) ids.add(id);
  }
  t.eventIds = [...ids];
  return t;
}

export const m2 = (tiles: number) => tiles * M2_PER_TILE;

// ── Shift summary ─────────────────────────────────────────────────────────────

export type ShiftSummary = {
  period: Period;
  elapsedMin: number;
  io: StageIO;
  /** Expected output of the shift so far (ideal rate × planned running time); null without an expectation. */
  expected: number | null;
  /** Events overlapping the shift (what the shift report lists) and those detected in it. */
  events: OpEvent[];
  raised: OpEvent[];
  active: OpEvent[];
  resolved: number;
  bySeverity: Record<AlertSeverity, number>;
  topLoss: LossRow | null;
  reachedConstraintMin: number;
  scenarios: ScenarioActivation[];
};

export function shiftSummary(s: SimState, ms: MonitoredStage): ShiftSummary {
  const sh = shiftAt(s.minute);
  const p: Period = { from: sh.start, to: s.minute, label: sh.label };
  const evs = stageEvents(s, ms, p.from, p.to);
  const raised = evs.filter((e) => e.start >= p.from);
  const bySeverity: Record<AlertSeverity, number> = { info: 0, warning: 0, serious: 0, critical: 0 };
  for (const e of raised) bySeverity[e.severity]++;
  const losses = stageLosses(s, ms, p);
  // Machines rank by tiles not made; conveyors (no ideal rate) only by stop minutes, and only when no machine lost anything.
  const machines = losses.filter((r) => r.lostTiles != null && r.lostTiles > 0.5).sort((a, b) => b.lostTiles! - a.lostTiles!);
  const conveyors = losses.filter((r) => r.lostTiles == null && r.downMin > 0).sort((a, b) => b.downMin - a.downMin);
  const top = machines[0] ?? conveyors[0] ?? null;
  const io = stageIO(s, ms.id, p);
  return {
    period: p,
    elapsedMin: p.to - p.from,
    io,
    expected: io.expectedPerHour != null ? io.expectedPerHour * Math.max(1 / 60, (p.to - p.from) / 60) : null,
    events: evs,
    raised,
    active: evs.filter((e) => e.end == null),
    resolved: raised.filter((e) => e.status === 'resolved').length,
    bySeverity,
    topLoss: top,
    reachedConstraintMin: losses.reduce((a, r) => a + r.constraintMin, 0),
    scenarios: stageScenarios(s, ms),
  };
}

// ── Presenter quick actions (scenarios) ───────────────────────────────────────

/** Scenarios in effect on a stage's assets or stages. */
export function stageScenarios(s: SimState, ms: MonitoredStage): ScenarioActivation[] {
  const assets = new Set(stageAssetIds(ms));
  const stages = SUB_STAGES[ms.id] as string[];
  return s.scenarios.filter(
    (sc) => sc.start <= s.minute && (sc.end == null || sc.end > s.minute) && ((sc.equipmentId && assets.has(sc.equipmentId)) || (sc.stage && stages.includes(sc.stage))),
  );
}

export type QuickKind = 'machine-stop' | 'conveyor-stop' | 'reduced-rate' | 'signal-loss';

/** Stage-relevant scenarios an asset supports (machine stop / reduced rate for machines, conveyor stop, feed loss for both). */
export function quickKindsFor(id: string): QuickKind[] {
  if (!isTracked(id)) return [];
  return isConveyor(id) ? ['conveyor-stop', 'signal-loss'] : ['machine-stop', 'reduced-rate', 'signal-loss'];
}

export const QUICK_FACTOR = 0.6;

export const QUICK_HINT: Record<QuickKind, string> = {
  'machine-stop': 'Unplanned stop with a downtime event; buffers absorb it for a while, then neighbours starve or block.',
  'conveyor-stop': 'Stops the transfer: the stages it feeds get no tiles, the ones feeding it cannot discharge.',
  'reduced-rate': `Runs the machine at ${Math.round(QUICK_FACTOR * 100)} % of its ideal rate — a performance loss, not downtime.`,
  'signal-loss': 'The asset keeps working but its PLC link freezes: state shows Unknown and counters stop updating.',
};

export type ScenarioDef = Omit<ScenarioActivation, 'id' | 'start'>;

/** Activation for a quick action (the same definitions the scenario panel uses). */
export function quickDef(kind: QuickKind, id: string, durationMin: number, now: number): ScenarioDef {
  const dur = durationMin > 0 ? ` · ${formatDuration(durationMin)}` : '';
  return {
    kind,
    equipmentId: id,
    ...(kind === 'reduced-rate' ? { factor: QUICK_FACTOR } : {}),
    end: durationMin > 0 ? now + durationMin : null,
    label: `${SCENARIO_KIND_LABELS[kind]} · ${id}${kind === 'reduced-rate' ? ` at ${Math.round(QUICK_FACTOR * 100)} %` : ''}${dur}`,
  };
}

/** The running scenario of the same kind on the same asset (activating again would stack it). */
export const runningScenario = (s: SimState, kind: ScenarioKind, id: string) =>
  s.scenarios.find((sc) => sc.kind === kind && sc.equipmentId === id && sc.start <= s.minute && (sc.end == null || sc.end > s.minute)) ?? null;

/** Warehouse quick actions (one-off logistics injections). */
export const WH_TRUCK_DEF: ScenarioDef = { kind: 'truck-arrival', end: null, label: 'Additional truck arrival' };
export const WH_HOLD_MIN = 75;
export const WH_HOLD_DEF: ScenarioDef = { kind: 'prolonged-dock-stay', count: WH_HOLD_MIN, end: null, label: `Dock hold +${WH_HOLD_MIN} min` };
export const dockedTrucks = (s: SimState) => DOCKS.filter((d) => s.logistics.docks[d.id]?.vehicleId).length;

// ── Warehouse readings ────────────────────────────────────────────────────────

/** Current reading of a warehouse asset that has no state signal (from the simulated logistics state). */
export function warehouseReading(s: SimState, id: string): string | null {
  if (id === 'K-DOCK') return `${signalValue(s, 'K-DOCK.dock_occupancy').text} docks occupied`;
  if (id === 'K-RACK') return `${fmtN(s.logistics.stockPallets)} pallets in stock (${fmtN(s.logistics.putawayQueue)} awaiting put-away)`;
  return null;
}
