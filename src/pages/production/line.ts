/**
 * OEE & Loss Intelligence — line level: the flow through the stages, traced from the line
 * constraint, and what the buffers between them say about it (upstream accumulation, downstream
 * starvation, how long the WIP protects the next stage). Pure functions over the one SimState.
 */
import { BUFFERS, LINE, M2_PER_TILE, OPS_BY_ID, STAGES, STAGE_BY_ID, TARGET } from '../../model/plant';
import type { OperationalState, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { operationalState, type LineMetrics, type StageMetrics, bottleneck } from '../../sim/metrics';

type Bottleneck = ReturnType<typeof bottleneck>;

const KILN = 'H-KILN';
/** Raw-material buffers (slip, powder) hold tile-equivalents of material, not tiles in process. */
const MATERIAL = new Set(['BUF-SLIP', 'BUF-SILO']);
const n0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const mins = (v: number) => `${n0.format(Math.round(v))} min`;

/** Design rate of a stage, tiles per minute (sum of its machines). */
export const stageRatePerMin = (id: StageId) => STAGE_BY_ID[id].machines.reduce((a, m) => a + (OPS_BY_ID[m].idealRatePerHour ?? 0), 0) / 60;

/** Logged buffer level (tiles) at minute t, or null outside the per-minute log. */
export function bufferAt(s: SimState, id: string, t: number): number | null {
  const log = s.bufferLog[id];
  if (!log || t < 0) return null;
  const i = t % log.t.length;
  return log.t[i] === t ? log.level[i] : null;
}

export type BufferTrend = 'filling' | 'draining' | 'steady';

export type FlowBuffer = {
  id: string;
  name: string;
  tiles: number;
  capacity: number;
  fill: number;
  /** Change over the last 60 simulated minutes, tiles (null when not logged yet). */
  delta60: number | null;
  trend: BufferTrend | null;
  /** Minutes the consuming stage could run on this buffer alone, at its design rate. */
  coverMin: number;
  /** Minutes the feeding stage could keep discharging into the free space, at its design rate. */
  spaceMin: number | null;
  feeds: StageId;
  fedBy: StageId | null;
  material: boolean;
  /** What the level means for the flow, in words. */
  effect: string;
  tone: 'good' | 'warning' | 'neutral';
};

export type FlowStage = {
  stage: StageId;
  name: string;
  index: number;
  /** Position relative to the traced bottleneck. */
  role: 'bottleneck' | 'upstream' | 'downstream';
  isDesignConstraint: boolean;
  /** Shares of the bottleneck window (minute log, planned stops excluded); they add up to 1. */
  workingShare: number;
  downShare: number;
  starvedShare: number;
  blockedShare: number;
  machines: { id: string; state: OperationalState }[];
  idealPerHour: number;
  /** Buffer feeding this stage (null for the first stage). */
  input: FlowBuffer | null;
};

function flowBuffer(s: SimState, id: string, feeds: StageId, fedBy: StageId | null, bnIndex: number): FlowBuffer {
  const def = BUFFERS.find((b) => b.id === id)!;
  const tiles = s.buffers[id] ?? 0;
  const fill = def.capacity > 0 ? tiles / def.capacity : 0;
  const now = bufferAt(s, id, s.minute - 1);
  const then = bufferAt(s, id, s.minute - 61);
  const delta60 = now != null && then != null ? now - then : null;
  const band = Math.max(5, def.capacity * 0.02);
  const trend: BufferTrend | null = delta60 == null ? null : delta60 > band ? 'filling' : delta60 < -band ? 'draining' : 'steady';
  const consume = stageRatePerMin(feeds);
  const produce = fedBy ? stageRatePerMin(fedBy) : 0;
  const coverMin = consume > 0 ? tiles / consume : 0;
  const spaceMin = produce > 0 ? (def.capacity - tiles) / produce : null;
  const feedsIdx = STAGES.findIndex((x) => x.id === feeds);
  const feedsName = STAGE_BY_ID[feeds].name.toLowerCase();
  const fedName = fedBy ? STAGE_BY_ID[fedBy].name.toLowerCase() : 'supply';
  // Ahead of the bottleneck WIP accumulates; behind it buffers drain.
  const side = feedsIdx <= bnIndex ? 'upstream' : 'downstream';
  let effect: string;
  let tone: FlowBuffer['tone'] = 'neutral';
  if (fill >= 0.9) {
    tone = 'warning';
    effect = `Nearly full — ${fedName} is or will be blocked; ${side === 'upstream' ? 'WIP accumulating ahead of the bottleneck' : `${feedsName} is not taking tiles fast enough`}.`;
  } else if (fill <= 0.08) {
    tone = 'warning';
    effect = `Nearly empty — ${feedsName} is or will be starved (${mins(coverMin)} of feed left).`;
  } else if (trend === 'filling') {
    effect = `Filling (+${n0.format(delta60!)} tiles in 60 min): ${fedName} delivers more than ${feedsName} takes${side === 'upstream' ? ' — accumulation upstream of the bottleneck' : ''}.`;
  } else if (trend === 'draining') {
    tone = coverMin < 20 ? 'warning' : 'neutral';
    effect = `Draining (${n0.format(delta60!)} tiles in 60 min): ${feedsName} takes more than ${fedName} delivers${side === 'downstream' ? ' — starvation risk downstream of the bottleneck' : ''}; ${mins(coverMin)} of feed left.`;
  } else {
    tone = 'good';
    effect = trend == null ? `${mins(coverMin)} of ${feedsName} feed at its design rate.` : `Steady — ${mins(coverMin)} of ${feedsName} feed at its design rate.`;
  }
  return { id, name: def.name, tiles, capacity: def.capacity, fill, delta60, trend, coverMin, spaceMin, feeds, fedBy, material: MATERIAL.has(id), effect, tone };
}

/** Stages in process order with their state shares (the bottleneck window) and the buffer feeding each. */
export function lineFlow(s: SimState, bn: Bottleneck): FlowStage[] {
  const bnIndex = STAGES.findIndex((x) => x.id === bn.current.stage);
  const shares = new Map<StageId, StageMetrics>(bn.stages.map((st) => [st.stage, st]));
  return STAGES.map((st, i) => {
    const m = shares.get(st.id);
    const working = m?.workingShare ?? 0;
    const down = m?.downShare ?? 0;
    const starved = m?.starvedShare ?? 0;
    const blocked = m?.blockedShare ?? 0;
    return {
      stage: st.id,
      name: st.name,
      index: i,
      role: i === bnIndex ? 'bottleneck' : i < bnIndex ? 'upstream' : 'downstream',
      isDesignConstraint: st.id === LINE.designConstraint,
      workingShare: working,
      downShare: down,
      starvedShare: starved,
      blockedShare: blocked,
      machines: st.machines.map((id) => ({ id, state: operationalState(s, id) })),
      idealPerHour: stageRatePerMin(st.id) * 60,
      input: st.inputBuffer ? flowBuffer(s, st.inputBuffer, st.id, STAGES[i - 1]?.id ?? null, bnIndex) : null,
    };
  });
}

export type LineSummary = {
  /** Good m² per hour over the period (null before any production time). */
  goodPerHourM2: number | null;
  planPerHourM2: number;
  /** Tiles fired per hour at the kiln over the period. */
  firedPerHour: number | null;
  designPerHour: number;
  /** Tiles in process buffers (green tile collector → carton transfer), excluding slip and powder. */
  wipTiles: number;
  wipCapacity: number;
  /** Minutes the kiln could keep firing from its infeed buffer if everything upstream stopped. */
  kilnFeedMin: number;
  /** Minutes the kiln could keep discharging into its outfeed buffer if sorting stopped. */
  kilnSpaceMin: number;
};

export function lineSummary(s: SimState, lm: LineMetrics, calendarMin: number): LineSummary {
  const hrs = calendarMin / 60;
  const kilnRate = (OPS_BY_ID[KILN].idealRatePerHour ?? 0) / 60;
  const wip = BUFFERS.filter((b) => !MATERIAL.has(b.id));
  const kin = BUFFERS.find((b) => b.id === 'BUF-KIN')!;
  const kout = BUFFERS.find((b) => b.id === 'BUF-KOUT')!;
  return {
    goodPerHourM2: hrs > 0 ? lm.outputM2 / hrs : null,
    planPerHourM2: TARGET.goodPerHour * M2_PER_TILE,
    firedPerHour: hrs > 0 ? lm.constraint.totals.count / hrs : null,
    designPerHour: OPS_BY_ID[KILN].idealRatePerHour ?? 0,
    wipTiles: wip.reduce((a, b) => a + (s.buffers[b.id] ?? 0), 0),
    wipCapacity: wip.reduce((a, b) => a + b.capacity, 0),
    kilnFeedMin: kilnRate > 0 ? (s.buffers[kin.id] ?? 0) / kilnRate : 0,
    kilnSpaceMin: kilnRate > 0 ? (kout.capacity - (s.buffers[kout.id] ?? 0)) / kilnRate : 0,
  };
}
