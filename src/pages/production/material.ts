/**
 * Material flow (Production ?tab=material, brief §8 Material Flow) — pure derivations, read through the telemetry
 * boundary (src/sim/telemetry.ts readSignal / seriesOf) and the calculation library (src/calc), never from the
 * simulation's buffer contents:
 *
 * - The stage chain upstream → downstream: per process stage its output rate in its physical unit (stages 1–2: t/h
 *   from the simulated slip / powder flow signals, a disclosed conversion of tile-equivalents; after pressing
 *   tiles/h and m²/h) and per buffer its level (%), level trend (%/h, least squares), time to empty / full (a linear
 *   extrapolation, not a forecast) or "balanced", and inflow vs outflow (flowBalance) in the buffer's unit. Silos and
 *   slip tanks are % only: no level-to-mass calibration is configured (massFromLevel). Stage 8 is the kiln outfeed
 *   (partial), stage 9 (polishing & rectification) is not present — flagged for configuration.
 * - The bottleneck ranking of the shared trace (src/sim/metrics.ts bottleneck / logShares, partial starvation and
 *   blocking included) and the starvation / blockage findings of the rule engine (flow family, Rule-based).
 * - Chart series per buffer for a time range (level, inflow vs outflow) with null gaps — never zeros.
 * Missing is never zero: every figure is a Calc with a reason when there is none.
 */
import { counterRate, flowBalance, insufficient, massFromLevel, ok, seriesToSamples, timeToEmpty, timeToFull, trendSlope, unavailable, type Calc, type FlowDirection } from '../../calc';
import { FLOW_RULES, findingsFor, paramOf, useRuleThresholds, type RuleFinding } from '../../intel/rules';
import { constraintClaim, constraintPhrase } from '../../intel/summary';
import { STAGES_12, stageOfBuffer, stageOfEquipment, type ProductionStageDef, type ProductionStageNo } from '../../model/catalog';
import { BUFFERS, BUFFER_LEVEL_SIGNAL, CONVEYORS, CONVEYOR_BY_ID, LINE, M2_PER_TILE, MONITORED_STAGE_BY_ID, OPS_BY_ID, STAGES } from '../../model/plant';
import { RANGE_BY_KEY, type RangeKey } from '../../model/telemetry';
import type { BufferDef, MonitoredStageId, OperationalState, ProcessStage, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { HELD_UP_SHARE, bottleneck, operationalState, type BottleneckCause } from '../../sim/metrics';
import { readSignal, seriesOf } from '../../sim/telemetry';
import { formatClock, formatDuration } from '../../sim/time';
import { STATE_RANK, monitoredStageOf } from './stage/derive';
import { MASS_DISCLOSURE, MATERIAL_PROCESS_STAGES, NO_CALIBRATION, massFlowSignalOf, tileEqToT } from './units';

/** Trailing window of the chain's figures (rates, level trend, balance), minutes. */
export const MATERIAL_WINDOW_MIN = 60;
/** Share of the window's samples a mean needs, else 'insufficient'. */
const MIN_COVERAGE = 0.5;
/** Time to empty / full beyond this is shown as "more than a day" (a linear extrapolation that far means little). */
const HORIZON_CAP_MIN = 1440;

const n0 = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const n1 = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export type FlowUnit = 't/h' | 'tiles/h';
type Win = { from: number; to: number };

/** A figure in a flow unit as text ('9.9 t/h', '1,168 tiles/h'); missing → null (the caller says why). */
export const flowText = (v: number | null, unit: FlowUnit) => (v == null || !Number.isFinite(v) ? null : `${unit === 't/h' ? n1.format(v) : n0.format(v)} ${unit}`);

// ── Line topology ────────────────────────────────────────────────────────────

const KILN_INDEX = STAGES.findIndex((st) => st.id === LINE.designConstraint);

/** Brief stage numbers (1–12) a process stage covers, from its machines. */
export const briefStagesOf = (st: ProcessStage): ProductionStageNo[] =>
  [...new Set(st.machines.map(stageOfEquipment).filter((x): x is ProductionStageNo => x != null))].sort((a, b) => a - b);

/** A rate (or a counter read as a rate) × factor into the side's unit. */
type FlowSource = { signalId: string; counter: boolean; factor: number };

const rateSource = (id: string): FlowSource => ({ signalId: `${id}.rate`, counter: false, factor: 1 });
/** A ball mill / the spray dryer: its simulated mass flow (t/h), else its tile-equivalent rate converted. */
const massSource = (id: string): FlowSource => {
  const sig = massFlowSignalOf(id);
  return sig ? { signalId: sig, counter: false, factor: 1 } : { signalId: `${id}.rate`, counter: false, factor: tileEqToT(1)! };
};

/** What a stage puts out, in its physical unit. */
function stageSources(st: ProcessStage): { unit: FlowUnit; sources: FlowSource[] } {
  if (MATERIAL_PROCESS_STAGES.has(st.id)) return { unit: 't/h', sources: st.machines.map(massSource) };
  return { unit: 'tiles/h', sources: st.machines.map(rateSource) };
}

/** Design rate of a stage in a flow unit (sum of its machines' ideal rates; tile-equivalents → t/h for mass). */
const designRate = (st: ProcessStage, unit: FlowUnit) => {
  const tiles = st.machines.reduce((a, m) => a + (OPS_BY_ID[m]?.idealRatePerHour ?? 0), 0);
  return unit === 't/h' ? tileEqToT(tiles)! : tiles;
};

type BufferTopology = {
  buf: BufferDef;
  levelSignal: string;
  /** Equipment item carrying the level signal (its own equipment, or the conveyor holding it). */
  holder: string;
  fedBy: ProcessStage | null;
  feeds: ProcessStage | null;
  /** Feeds a stage at or before the kiln: running empty is the concern, full is normal balancing. */
  ahead: boolean;
  /** Slip tanks / powder silos (fed by a slip / powder stage): % only, flows in t/h. */
  bulk: boolean;
  /** An accumulation on a conveyor (small, changes fast). */
  accumulation: boolean;
  briefNo: ProductionStageNo | null;
  unit: FlowUnit;
  inflow: FlowSource[];
  outflow: FlowSource[];
};

function topology(b: BufferDef): BufferTopology | null {
  const levelSignal = BUFFER_LEVEL_SIGNAL[b.id];
  if (!levelSignal) return null;
  const i = STAGES.findIndex((st) => st.inputBuffer === b.id);
  const feeds = i >= 0 ? STAGES[i] : null;
  const fedBy = i > 0 ? STAGES[i - 1] : null;
  const holder = levelSignal.slice(0, levelSignal.indexOf('.'));
  const bulk = !!fedBy && MATERIAL_PROCESS_STAGES.has(fedBy.id);
  const unit: FlowUnit = bulk ? 't/h' : 'tiles/h';
  const inflow = !fedBy ? [] : bulk ? fedBy.machines.map(massSource) : fedBy.id === 'SORT' ? fedBy.machines.map((m) => ({ signalId: `${m}.count_good`, counter: true, factor: 1 })) : fedBy.machines.map(rateSource);
  let outflow: FlowSource[] = [];
  if (feeds) {
    if (MATERIAL_PROCESS_STAGES.has(feeds.id)) outflow = feeds.machines.map(massSource);
    else if (bulk) {
      // The presses have no mass-flow signal: the powder feed conveyor's tile-equivalent counter, converted with the same factor.
      const belt = CONVEYORS.find((c) => c.bufferId === b.id);
      outflow = belt ? [{ signalId: `${belt.id}.tile_count`, counter: true, factor: tileEqToT(1)! }] : feeds.machines.map(massSource);
    } else outflow = feeds.machines.map(rateSource);
  }
  return {
    buf: b,
    levelSignal,
    holder,
    fedBy,
    feeds,
    ahead: i >= 0 && i <= KILN_INDEX,
    bulk,
    accumulation: !!CONVEYOR_BY_ID[holder],
    briefNo: stageOfBuffer(b.id),
    unit,
    inflow,
    outflow,
  };
}

/** Every buffer with a level signal, in line order. */
export const BUFFER_TOPOLOGY: BufferTopology[] = BUFFERS.map(topology).filter((x): x is BufferTopology => x != null);
const BY_BUFFER = new Map(BUFFER_TOPOLOGY.map((b) => [b.buf.id, b]));
const BY_HOLDER = new Map(BUFFER_TOPOLOGY.map((b) => [b.holder, b.buf.id]));

// ── Reading signals over a window ────────────────────────────────────────────

/** Mean of a numeric signal over the window (minute samples); 'insufficient' below half coverage. */
function meanOver(s: SimState, signalId: string, w: Win): Calc<number> {
  const ser = seriesOf(s, signalId, { from: w.from, to: w.to, stepMin: 1 });
  if (!ser) return unavailable(`${signalId} keeps no numeric history`);
  const xs = ser.v.filter((v): v is number => v != null && Number.isFinite(v));
  const expected = ser.coverage.expected;
  if (!expected) return insufficient('No simulated minute in the window yet');
  if (xs.length < expected * MIN_COVERAGE) return insufficient(`${signalId}: ${xs.length} of ${expected} minute samples usable${ser.note ? ` (${ser.note})` : ''}`);
  return ok(xs.reduce((a, b) => a + b, 0) / xs.length, xs.length < expected ? `${expected - xs.length} of ${expected} samples without a good value left out` : undefined);
}

/** Rate of a cumulative counter over the window (counts per hour; resets and implausible steps handled by counterRate). */
function counterOver(s: SimState, signalId: string, w: Win): Calc<number> {
  const ser = seriesOf(s, signalId, { from: w.from - 1, to: w.to, stepMin: 1 });
  if (!ser) return unavailable(`${signalId} keeps no numeric history`);
  const eq = signalId.slice(0, signalId.indexOf('.'));
  const capPerH = CONVEYOR_BY_ID[eq]?.capacityPerHour ?? OPS_BY_ID[eq]?.idealRatePerHour ?? null;
  const r = counterRate(seriesToSamples(ser, w.from - 1), capPerH ? { maxPlausibleDelta: (capPerH / 60) * (w.to - w.from + 1) * 1.5 } : {});
  return r.status === 'ok' ? ok(r.value.perHour, r.note) : { ...r, reason: `${signalId}: ${r.reason}` };
}

const sourceOver = (s: SimState, src: FlowSource, w: Win): Calc<number> => {
  const c = src.counter ? counterOver(s, src.signalId, w) : meanOver(s, src.signalId, w);
  return c.status === 'ok' ? ok(c.value * src.factor, c.note) : c;
};

/** Sum of the sources; the first source without a value makes the sum unavailable (never a partial sum shown as the whole). */
function sumOver(s: SimState, sources: FlowSource[], w: Win): Calc<number> {
  if (!sources.length) return unavailable('No flow signal configured');
  let total = 0;
  for (const src of sources) {
    const c = sourceOver(s, src, w);
    if (c.status !== 'ok') return c;
    total += c.value;
  }
  return ok(total);
}

// ── The chain ────────────────────────────────────────────────────────────────

export type MaterialStage = {
  id: StageId;
  name: string;
  monitored: MonitoredStageId | null;
  briefNos: ProductionStageNo[];
  machines: { id: string; state: OperationalState }[];
  /** Worst state of its machines now. */
  state: OperationalState | null;
  unit: FlowUnit;
  /** Output rate, mean over the window, in `unit`. */
  rate: Calc<number>;
  /** Design rate in `unit` (sum of the machines' ideal rates). */
  design: number;
  share: number | null;
  /** m²/h for tile stages (null for slip / powder). */
  m2PerHour: number | null;
  signals: string[];
  /** How the figure is made, in words (with the mass disclosure for slip / powder). */
  basis: string;
};

export type HorizonKind = 'empty' | 'full' | 'balanced' | 'none';
export type Horizon = { kind: HorizonKind; minutes: number | null; text: string };

export type MaterialBuffer = {
  id: string;
  name: string;
  levelSignal: string;
  holder: string;
  briefNo: ProductionStageNo | null;
  fedBy: { id: StageId; name: string } | null;
  feeds: { id: StageId; name: string } | null;
  ahead: boolean;
  bulk: boolean;
  accumulation: boolean;
  /** Configured capacity in tiles (tile buffers only — a silo / tank level has no quantity without a calibration). */
  capacityTiles: number | null;
  /** Level now, % (from the level signal; quality checked). */
  level: Calc<number>;
  /** Least-squares level trend over the window, %/h. */
  trend: Calc<number>;
  /** What counts as moving: F-BUFFER-TREND's threshold for storage / conveyor accumulations, %/h. */
  trendThreshold: number;
  direction: 'rising' | 'falling' | 'steady' | null;
  horizon: Horizon;
  unit: FlowUnit;
  inflow: Calc<number>;
  outflow: Calc<number>;
  inSignals: string[];
  outSignals: string[];
  balance: Calc<{ net: number; direction: FlowDirection }>;
  /** ± net flow counted as balanced (F-BALANCE deadband share × the drawing stage's design rate), in `unit`. */
  deadband: number;
  /** Silos / slip tanks: always 'unavailable' (no level-to-mass calibration configured). Null for tile buffers. */
  mass: Calc<number> | null;
  /** Flow findings about this buffer (fired first). */
  findings: RuleFinding[];
};

export type ChainItem = { kind: 'stage'; stage: MaterialStage } | { kind: 'buffer'; buffer: MaterialBuffer } | { kind: 'absent'; def: ProductionStageDef };

const worst = (xs: { state: OperationalState }[]) => (xs.length ? xs.reduce((a, b) => (STATE_RANK[b.state] < STATE_RANK[a.state] ? b : a)).state : null);

export function materialStage(s: SimState, st: ProcessStage, w: Win): MaterialStage {
  const { unit, sources } = stageSources(st);
  const rate = sumOver(s, sources, w);
  const design = designRate(st, unit);
  const machines = st.machines.map((id) => ({ id, state: operationalState(s, id) }));
  const minutes = w.to - w.from;
  const sig = sources.map((x) => x.signalId);
  return {
    id: st.id,
    name: st.name,
    monitored: monitoredStageOf(st.id),
    briefNos: briefStagesOf(st),
    machines,
    state: worst(machines),
    unit,
    rate,
    design,
    share: rate.status === 'ok' && design > 0 ? rate.value / design : null,
    m2PerHour: unit === 'tiles/h' && rate.status === 'ok' ? rate.value * M2_PER_TILE : null,
    signals: sig,
    basis:
      unit === 't/h'
        ? `Mean of ${sig.join(' + ')} over the last ${minutes} min · dry-body equivalent (${MASS_DISCLOSURE})`
        : `Mean of ${sig.join(' + ')} over the last ${minutes} min · m²/h = tiles/h × ${M2_PER_TILE} m² per tile`,
  };
}

/** Time to empty / full at the trend (linear extrapolation), or balanced; with the reason when neither can be said. */
export function horizonOf(level: Calc<number>, trend: Calc<number>, threshold: number): Horizon {
  if (level.status !== 'ok') return { kind: 'none', minutes: null, text: `Level not available — ${level.reason}` };
  if (trend.status !== 'ok') return { kind: 'none', minutes: null, text: `No level trend — ${trend.reason}` };
  const slope = trend.value;
  if (Math.abs(slope) < threshold) {
    const at = level.value >= 98 ? 'Steady at full' : level.value <= 2 ? 'Steady at empty' : 'Balanced';
    return { kind: 'balanced', minutes: null, text: `${at} — level moving less than ${n1.format(threshold)} %/h` };
  }
  const c = slope < 0 ? timeToEmpty(level.value, slope) : timeToFull(level.value, slope);
  const kind: HorizonKind = slope < 0 ? 'empty' : 'full';
  if (c.status !== 'ok') return { kind: 'none', minutes: null, text: c.reason };
  if (c.value <= 0) return { kind, minutes: 0, text: kind === 'empty' ? 'Empty now' : 'Full now' };
  const when = c.value > HORIZON_CAP_MIN ? 'more than 24 h' : `≈ ${formatDuration(c.value)}`;
  return { kind, minutes: c.value, text: `${kind === 'empty' ? 'Empty' : 'Full'} in ${when} at this trend (linear extrapolation, not a forecast)` };
}

/** The level reading as a figure: bad / stale / missing samples are not a level (never 0). */
function levelNow(s: SimState, signalId: string): Calc<number> {
  const r = readSignal(s, signalId);
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return unavailable(r.note ?? 'No level received');
  if (r.quality === 'bad') return unavailable(`flagged bad by the source — not used${r.note ? ` (${r.note})` : ''}`);
  if (r.quality === 'stale' || r.quality === 'missing')
    return unavailable(`${r.timestamp != null ? `last value ${formatClock(r.timestamp)}, ` : ''}${r.note ?? 'not current'}`);
  return ok(r.value, r.quality === 'uncertain' ? 'Uncertain quality' : undefined);
}

export function materialBuffer(s: SimState, t: BufferTopology, w: Win, findings: RuleFinding[], values = useRuleThresholds.getState().values): MaterialBuffer {
  const level = levelNow(s, t.levelSignal);
  const ser = seriesOf(s, t.levelSignal, { from: w.from, to: w.to, stepMin: 1 });
  const minutes = w.to - w.from;
  const trend = ser ? trendSlope(seriesToSamples(ser, w.from), { minSamples: 10, minSpanMin: Math.min(20, minutes / 2) }) : unavailable<number>(`${t.levelSignal} keeps no history`);
  const trendThreshold = paramOf(values, 'F-BUFFER-TREND', t.accumulation ? 'slopePctTransfer' : 'slopePct', t.holder);
  const direction = trend.status !== 'ok' ? null : Math.abs(trend.value) < trendThreshold ? 'steady' : trend.value > 0 ? 'rising' : 'falling';
  const inflow = t.fedBy ? sumOver(s, t.inflow, w) : unavailable<number>('First stage of the line — no flow into it is measured');
  const outflow = t.feeds ? sumOver(s, t.outflow, w) : unavailable<number>('No stage draws from it');
  const deadband = paramOf(values, 'F-BALANCE', 'deadband', t.holder) * (t.feeds ? designRate(t.feeds, t.unit) : 0);
  const balance = inflow.status === 'ok' && outflow.status === 'ok' ? flowBalance(inflow.value, outflow.value, { deadband }) : unavailable<{ net: number; direction: FlowDirection }>(inflow.status !== 'ok' ? `Inflow: ${inflow.reason}` : `Outflow: ${outflow.status !== 'ok' ? outflow.reason : ''}`);
  const own = findings.filter((f) => bufferOfFinding(f) === t.buf.id);
  return {
    id: t.buf.id,
    name: t.buf.name,
    levelSignal: t.levelSignal,
    holder: t.holder,
    briefNo: t.briefNo,
    fedBy: t.fedBy ? { id: t.fedBy.id, name: t.fedBy.name } : null,
    feeds: t.feeds ? { id: t.feeds.id, name: t.feeds.name } : null,
    ahead: t.ahead,
    bulk: t.bulk,
    accumulation: t.accumulation,
    capacityTiles: t.bulk ? null : t.buf.capacity,
    level,
    trend,
    trendThreshold,
    direction,
    horizon: horizonOf(level, trend, trendThreshold),
    unit: t.unit,
    inflow,
    outflow,
    inSignals: t.inflow.map((x) => x.signalId),
    outSignals: t.outflow.map((x) => x.signalId),
    balance,
    deadband,
    // A level percentage is not a quantity: without a calibration there is no mass (calc massFromLevel says why).
    mass: t.bulk ? massFromLevel(level.status === 'ok' ? level.value : null, null) : null,
    findings: own,
  };
}

// ── Rule-engine findings (flow family) ───────────────────────────────────────

const BUFFER_IDS = new Set(BUFFERS.map((b) => b.id));

/** The buffer a flow finding is about: its subject (buffer rules, F-STARVE / F-BLOCK) or the buffer its equipment holds (the chain rules). */
export function bufferOfFinding(f: RuleFinding): string | null {
  if (f.subject && BUFFER_IDS.has(f.subject)) return f.subject;
  return f.scope.kind === 'equipment' ? (BY_HOLDER.get(f.scope.equipmentId) ?? null) : null;
}

const findingsMemo = new WeakMap<SimState, { key: string; value: RuleFinding[] }>();

/**
 * The flow family of the rule engine for the whole plant (findingsFor, plant scope, FLOW_RULES only — the same
 * findings and keys as the full engine, at a fraction of the cost), memoised per simulated minute and thresholds.
 */
export function flowFindings(s: SimState): RuleFinding[] {
  const key = `${s.minute}|${s.version}|${useRuleThresholds.getState().version}`;
  const hit = findingsMemo.get(s);
  if (hit && hit.key === key) return hit.value;
  const value = findingsFor(s, { kind: 'plant' }, { rules: FLOW_RULES }).filter((f) => f.family === 'flow');
  findingsMemo.set(s, { key, value });
  return value;
}

// ── Bottleneck ranking ───────────────────────────────────────────────────────

export type RankRow = {
  stage: StageId;
  name: string;
  monitored: MonitoredStageId | null;
  /** The stage the trace ended at (the line is waiting for it). */
  traced: boolean;
  /** The modeled design constraint (the kiln). */
  design: boolean;
  /** Shares of planned time in the window (null: no planned time — never 0). */
  activeShare: number | null;
  workingShare: number | null;
  downShare: number | null;
  starvedShare: number | null;
  blockedShare: number | null;
};

export type Ranking = {
  windowLabel: string;
  cause: BottleneckCause;
  /** The shared constraint claim in the Overview's words. */
  claim: string;
  heldUpShare: number;
  rows: RankRow[];
};

/** The trace of src/sim/metrics.ts bottleneck (minute log; partial starvation / blocking counted as the held-back fraction), ranked. */
export function bottleneckRanking(s: SimState, bn = bottleneck(s)): Ranking {
  const claim = constraintClaim(s, 120, bn);
  return {
    windowLabel: claim.window,
    cause: bn.cause,
    claim: constraintPhrase(claim),
    heldUpShare: HELD_UP_SHARE,
    rows: bn.ranked.map((st) => ({
      stage: st.stage,
      name: st.name,
      monitored: monitoredStageOf(st.stage),
      traced: st.stage === bn.current.stage,
      design: st.stage === LINE.designConstraint,
      activeShare: st.activeShare,
      workingShare: st.workingShare,
      downShare: st.downShare,
      starvedShare: st.starvedShare,
      blockedShare: st.blockedShare,
    })),
  };
}

// ── The 12-stage mapping ─────────────────────────────────────────────────────

export type MappingRow = {
  no: ProductionStageNo;
  name: string;
  monitored: { id: MonitoredStageId; name: string } | null;
  equipment: string[];
  buffers: string[];
  present: ProductionStageDef['present'];
  /** 'Present', 'Partial' or 'Not present — flagged for configuration'. */
  flag: string;
  note: string;
};

export const PRESENT_LABEL: Record<ProductionStageDef['present'], string> = { yes: 'Present', partial: 'Partial', no: 'Not present — flagged for configuration' };

/** Which brief stage (1–12) each monitored stage covers (src/model/catalog/stages.ts STAGES_12). */
export const stageMapping = (): MappingRow[] =>
  STAGES_12.map((d) => ({
    no: d.no,
    name: d.name,
    monitored: d.monitoredStage ? { id: d.monitoredStage, name: MONITORED_STAGE_BY_ID[d.monitoredStage].name } : null,
    equipment: d.equipment,
    buffers: d.buffers,
    present: d.present,
    flag: PRESENT_LABEL[d.present],
    note: d.note,
  }));

// ── Everything the tab shows ─────────────────────────────────────────────────

export type MaterialFlowData = {
  now: number;
  window: Win & { minutes: number };
  chain: ChainItem[];
  stages: MaterialStage[];
  buffers: MaterialBuffer[];
  ranking: Ranking;
  findings: { fired: RuleFinding[]; insufficient: RuleFinding[]; clear: number; total: number };
  mapping: MappingRow[];
  /** The buffer the chart area opens on: the one with the most severe fired finding, else the kiln infeed. */
  focus: string;
  summary: string;
};

const STAGE9 = STAGES_12.find((d) => d.no === 9)!;

/** The material-flow view model over the trailing window (default MATERIAL_WINDOW_MIN). */
export function materialFlow(s: SimState, opts: { windowMin?: number } = {}): MaterialFlowData {
  const minutes = opts.windowMin ?? MATERIAL_WINDOW_MIN;
  const w: Win = { from: Math.max(0, s.minute - minutes), to: s.minute };
  const all = flowFindings(s);
  const values = useRuleThresholds.getState().values;
  const stages = STAGES.map((st) => materialStage(s, st, w));
  const buffers = BUFFER_TOPOLOGY.map((t) => materialBuffer(s, t, w, all, values));
  const byBuffer = new Map(buffers.map((b) => [b.id, b]));
  const chain: ChainItem[] = [];
  STAGES.forEach((st, i) => {
    const b = st.inputBuffer ? byBuffer.get(st.inputBuffer) : null;
    if (b) chain.push({ kind: 'buffer', buffer: b });
    // Stage 9 (polishing & rectification) would sit between the cooling buffer (stage 8) and sorting (stage 10).
    if (b && b.briefNo === 8) chain.push({ kind: 'absent', def: STAGE9 });
    chain.push({ kind: 'stage', stage: stages[i] });
  });
  const fired = all.filter((f) => f.status === 'fired');
  const insufficientData = all.filter((f) => f.status === 'insufficient-data');
  const ranking = bottleneckRanking(s);
  const focusFinding = fired.find((f) => bufferOfFinding(f) != null);
  const focus = (focusFinding && bufferOfFinding(focusFinding)) || (STAGES[KILN_INDEX].inputBuffer ?? buffers[0]?.id ?? '');
  const top = fired[0];
  const silos = buffers.filter((b) => b.bulk).map((b) => b.name.toLowerCase());
  const summary = [
    fired.length
      ? `${fired.length} material-flow finding${fired.length === 1 ? '' : 's'} detected (rule-based, simulated) — the most severe: ${top.title}.`
      : `No material-flow finding detected in the last ${minutes} min (rule-based, simulated).`,
    `${cap(ranking.claim)}.`,
    silos.length ? `${cap(silos.join(' and '))} are shown as level % only: ${NO_CALIBRATION.toLowerCase()}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    now: s.minute,
    window: { ...w, minutes },
    chain,
    stages,
    buffers,
    ranking,
    findings: { fired, insufficient: insufficientData, clear: all.length - fired.length - insufficientData.length, total: all.length },
    mapping: stageMapping(),
    focus,
    summary,
  };
}

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

// ── Chart series of one buffer ───────────────────────────────────────────────

export type ChartLine = { t: number[]; v: (number | null)[] };

export type BufferChart = {
  bufferId: string;
  name: string;
  from: number;
  to: number;
  stepMin: number;
  resolution: 'minute' | 'hour';
  unit: FlowUnit;
  level: ChartLine & { signalId: string; coverage: { expected: number; present: number } };
  inflow: ChartLine & { label: string; signals: string[] };
  outflow: ChartLine & { label: string; signals: string[] };
  /** Coverage and data-quality notes of the series (gaps are shown as gaps). */
  notes: string[];
};

/** One source on the range's grid in the side's unit: a rate as is, a counter differenced per step (a reset or a gap → null). */
function sourceLine(s: SimState, src: FlowSource, range: RangeKey): (ChartLine & { note?: string }) | null {
  const ser = seriesOf(s, src.signalId, range);
  if (!ser) return null;
  if (!src.counter) return { t: ser.t, v: ser.v.map((v) => (v == null ? null : v * src.factor)), note: ser.note };
  const v = ser.v.map((x, i) => {
    const prev = i > 0 ? ser.v[i - 1] : null;
    if (x == null || prev == null || x < prev) return null;
    return ((x - prev) * 60 * src.factor) / ser.stepMin;
  });
  return { t: ser.t, v, note: ser.note };
}

/** Sum of aligned lines; a step where any line has no value is a gap. */
function sumLines(lines: ChartLine[]): ChartLine {
  const t = lines[0]?.t ?? [];
  return { t, v: t.map((_, i) => (lines.every((l) => l.v[i] != null) ? lines.reduce((a, l) => a + (l.v[i] as number), 0) : null)) };
}

/** Level, inflow and outflow of a buffer over a chart range (RANGE_OPTIONS), nulls as gaps. Null for an unknown buffer. */
export function bufferChart(s: SimState, bufferId: string, range: RangeKey): BufferChart | null {
  const t = BY_BUFFER.get(bufferId);
  if (!t) return null;
  const lv = seriesOf(s, t.levelSignal, range);
  if (!lv) return null;
  const notes: string[] = [];
  if (lv.note) notes.push(`${t.levelSignal}: ${lv.note}`);
  const side = (sources: FlowSource[]) => {
    const lines = sources.map((x) => sourceLine(s, x, range));
    for (const [i, l] of lines.entries()) if (l?.note) notes.push(`${sources[i].signalId}: ${l.note}`);
    return lines.every((l): l is ChartLine => l != null) && lines.length ? sumLines(lines) : { t: lv.t, v: lv.t.map(() => null) };
  };
  const r = RANGE_BY_KEY[range];
  const inflow = side(t.inflow);
  const outflow = side(t.outflow);
  const unitNote = t.unit === 't/h' ? ` (t/h, ${MASS_DISCLOSURE})` : ' (tiles/h)';
  return {
    bufferId,
    name: t.buf.name,
    from: r.resolution === 'hour' ? (lv.t[0] ?? s.minute - r.minutes) : s.minute - r.minutes,
    to: s.minute,
    stepMin: lv.stepMin,
    resolution: lv.resolution,
    unit: t.unit,
    level: { t: lv.t, v: lv.v, signalId: t.levelSignal, coverage: lv.coverage },
    inflow: { ...inflow, label: `Inflow · ${t.fedBy ? t.fedBy.name.toLowerCase() : 'not measured'}${unitNote}`, signals: t.inflow.map((x) => x.signalId) },
    outflow: { ...outflow, label: `Outflow · ${t.feeds ? t.feeds.name.toLowerCase() : 'not measured'}${unitNote}`, signals: t.outflow.map((x) => x.signalId) },
    notes: [...new Set(notes)],
  };
}
