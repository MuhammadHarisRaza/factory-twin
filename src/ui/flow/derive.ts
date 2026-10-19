/**
 * Production flow strip — pure derivations over the one simulation state.
 *
 * One entry per monitored stage, in line order (PREP → … → WH), with only what a rapid scan needs:
 * operating status (worst operational state of the stage's machines and conveyors), output in the
 * period from the stage's own counting point (stageIO), the deviation from plan ONLY at the line's
 * output stage (sorting: good output vs the shift plan — no stage targets are invented), the
 * unresolved events filed under the stage and the constraint marker (constraintClaim). A neutral
 * "working at own pace" share is kept for detail views, clearly named.
 *
 * A stale data feed at the stage's output counting point (one rule for every aggregate figure): the
 * output keeps the simulation's running accounting — the SAME number as the KPI cards, the stage
 * card, the Production stage view and the reports — and carries the mark "Not confirmed · <asset>
 * data stale since hh:mm" (Stale badge + text, see outputStale). Only raw signal values (signal
 * tables, technical details) show the frozen last value received.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID, INSPECTION_STATIONS, LINE, M2_PER_TILE, MONITORED_STAGES, MONITORED_STAGE_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity, MonitoredStage, MonitoredStageId, OpEvent, OperationalState, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { eventStageOf } from '../../sim/events';
import { lineMetrics, operationalState, stageIO, sumBuckets, targetStatus, type Period, type TargetStatus } from '../../sim/metrics';
import { clockLabel, constraintClaim, toMonitoredStage, type ConstraintClaim } from '../../intel/summary';

/** Short captions for the compact strip (the full registry name is the tooltip and the detail title). */
export const STAGE_SHORT: Record<MonitoredStageId, string> = {
  PREP: 'Preparation',
  SPRAY: 'Spray drying',
  PRESS: 'Pressing',
  DRY: 'Drying',
  GLAZE: 'Glazing',
  DECOR: 'Decoration',
  KILN: 'Kiln',
  SORT: 'Sorting',
  PACK: 'Packing',
  PAL: 'Palletising',
  WH: 'Warehouse',
};

/**
 * Order used to pick a stage's worst state (the operational-state model the product shows): a stale
 * feed ('unknown') outranks normal running but never hides a stop or a fault.
 */
export const OP_RANK: Record<OperationalState, number> = {
  running: 1,
  idle: 2,
  planned: 3,
  changeover: 3.5,
  disconnected: 4,
  unknown: 5,
  starved: 6,
  blocked: 7,
  reduced: 8,
  stopped: 9,
  fault: 10,
};

const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/** Monitored stage that contains a process stage (glazing + decoration, packing + palletising). */
export const monitoredOf = (st: StageId | MonitoredStageId): MonitoredStageId => (st === 'WH' ? 'WH' : toMonitoredStage(st));

/**
 * The one monitored stage an asset is filed under: a conveyor belongs to the stage that lists it and
 * that it feeds (eventStageOf — the same rule the event engine uses), a process machine to its process
 * stage, an inspection station to sorting, other assets to the stage whose equipment lists them.
 */
export function assetStage(id: string): MonitoredStageId | null {
  const st = eventStageOf(id);
  if (st) return monitoredOf(st);
  if (INSPECTION_STATIONS.some((x) => x.equipmentId === id)) return 'SORT';
  return MONITORED_STAGES.find((m) => m.equipment.includes(id))?.id ?? null;
}

/**
 * The one monitored stage an event is filed under: its asset's stage (above); without an asset, the
 * stage on the record; warehouse dock / zone-K events under warehouse transfer; vehicle events in the
 * yard or at the gate are not on the line (null). Quality events are filed where they were detected
 * (sorting), not under the defect's hypothesised origin stage.
 */
export function eventStage(ev: OpEvent): MonitoredStageId | null {
  const a = ev.asset;
  if (a.equipmentId) {
    const st = assetStage(a.equipmentId);
    if (st) return st;
  }
  if (a.stationId) return 'SORT';
  if (a.stage && !a.equipmentId) return monitoredOf(a.stage);
  if (a.dockId || a.zone === 'K') return 'WH';
  return null;
}

/** Machines and conveyors whose state the stage shows (assets with a state signal only). */
export function stageAssets(s: SimState, ms: MonitoredStage): string[] {
  const conveyors = ms.conveyors.filter((id) => assetStage(id) === ms.id);
  return [...ms.equipment, ...conveyors].filter((id) => s.machines[id] != null);
}

export type FlowStage = {
  id: MonitoredStageId;
  /** Registry name, e.g. "Kiln firing & cooling". */
  name: string;
  short: string;
  /** Worst operational state of the stage's machines and conveyors; null when no asset has a state signal. */
  status: OperationalState | null;
  /** Asset in that state (first on ties), to locate or name. */
  statusAssetId: string | null;
  statusAssetName: string | null;
  /** Output in the period in display units (m² for tiles, pallets for warehouse transfer); null if not counted. */
  output: number | null;
  unit: 'm²' | 'pallets';
  /** The output is a tile-equivalent of slip or powder, not tiles. */
  tileEquivalent: boolean;
  /** What is counted, from the counting registry. */
  outputLabel: string;
  /** Plan comparison — only at the line output stage (sorting), against the shift plan. */
  plan: { planM2: number; gapM2: number; attainment: number | null; status: TargetStatus } | null;
  /** Share of planned time the stage produced at its own pace in the period (not starved, blocked or down). */
  workingShare: number | null;
  /** Unresolved events filed under the stage. */
  alerts: { count: number; worst: AlertSeverity | null; ids: string[] };
  /** Set when the constraint claim names this stage. */
  constraint: ConstraintClaim | null;
  /**
   * Set when a data feed at the output counting point is stale in the period: `output` (and `plan`) are
   * then the simulation's running figures, not confirmed by the feed — shown with `stale.label`.
   */
  stale: FlowStale | null;
};

/** The not-confirmed mark of an aggregate figure whose counting point's data feed is stale. */
export type FlowStale = {
  /** Earliest minute a feed of the stage's output counting point froze. */
  since: number;
  /** Assets of the output counting point whose feed is stale. */
  assetIds: string[];
  /** Every output-counting asset is stale (otherwise only part of the count is unconfirmed). */
  frozen: boolean;
  /** "kiln data stale since 10:30" (the KPI wording: kiln, sorting, else the asset ids). */
  reason: string;
  /** The mark shown next to the figure: "Not confirmed · kiln data stale since 10:30" (same text as the KPI status). */
  label: string;
  /** Same text as `label` (the strip's caption). */
  short: string;
  /** One-sentence explanation (tooltip, detail line). */
  note: string;
};

/** Process stages behind a monitored stage. */
const processStages = (id: MonitoredStageId): StageId[] => (id === 'GLAZE' ? ['GLAZE', 'DECOR'] : id === 'PACK' ? ['PACK', 'PAL'] : id === 'WH' ? [] : [id]);

function workingShare(s: SimState, id: MonitoredStageId, p: Period): number | null {
  const machines = processStages(id).flatMap((st) => STAGE_BY_ID[st].machines);
  if (!machines.length) return null;
  let planned = 0;
  let held = 0;
  for (const m of machines) {
    const t = sumBuckets(s, m, p);
    planned += t.planned;
    held += t.starved + t.blocked + t.down;
  }
  return planned > 0 ? Math.max(0, planned - held) / planned : null;
}

/** Machines whose counters make a stage's output (the machines of its last process stage). */
export const outputMachines = (id: MonitoredStageId): string[] => {
  const ps = processStages(id);
  return ps.length ? STAGE_BY_ID[ps[ps.length - 1]].machines : [];
};

/** The asset word of the stale mark, in the KPI wording (src/intel/kpis.ts markStale): kiln, sorting, else the asset id. */
const FEED_WORD: Record<string, string> = { 'H-KILN': 'kiln', 'I-SORT': 'sorting' };
export const feedWord = (ids: string[]) => ids.map((id) => FEED_WORD[id] ?? id).join(', ');

/**
 * The not-confirmed mark of a stage's output in the period: set when a data feed of its output
 * counting point (outputMachines) is stale inside the period. The figure itself stays the
 * simulation's running accounting (the same number on every surface); the mark says it is not
 * confirmed and since when — "Not confirmed · kiln data stale since 10:30". Null when every feed is
 * fresh, and for warehouse transfer (pallets, no machine counter).
 */
export function outputStale(s: SimState, id: MonitoredStageId, p: Period): FlowStale | null {
  if (id === 'WH') return null;
  const machines = outputMachines(id);
  const feeds: { id: string; since: number }[] = [];
  for (const m of machines) {
    const f = s.feeds[m];
    if (f?.status === 'stale' && f.since < p.to) feeds.push({ id: m, since: f.since });
  }
  if (!feeds.length) return null;
  const since = Math.min(...feeds.map((x) => x.since));
  const ids = feeds.map((x) => x.id);
  const frozen = feeds.length === machines.length;
  const reason = `${feedWord(ids)} data stale since ${clockLabel(since, s.minute)}`;
  const label = `Not confirmed · ${reason}`;
  const who = ids.join(', ');
  return {
    since,
    assetIds: ids,
    frozen,
    reason,
    label,
    short: label,
    note: `Data feed of ${who} stale since ${clockLabel(since, s.minute)}: the figure is the simulation's running count${frozen ? '' : `, including ${who}`}, which the feed has not confirmed. Raw signal values show the last value received.`,
  };
}

/** Unresolved events per monitored stage. */
export function stageAlerts(s: SimState): Map<MonitoredStageId, OpEvent[]> {
  const by = new Map<MonitoredStageId, OpEvent[]>();
  for (const e of s.events) {
    if (e.status === 'resolved') continue;
    const st = eventStage(e);
    if (!st) continue;
    const list = by.get(st) ?? [];
    list.push(e);
    by.set(st, list);
  }
  return by;
}

/** The flow strip for a period (the Overview uses the current shift). */
export function flowStages(s: SimState, p: Period, claim: ConstraintClaim = constraintClaim(s)): FlowStage[] {
  const alerts = stageAlerts(s);
  const lm = lineMetrics(s, p);
  return MONITORED_STAGES.map((ms) => {
    let worst: { id: string; op: OperationalState } | null = null;
    for (const id of stageAssets(s, ms)) {
      const op = operationalState(s, id);
      if (!worst || OP_RANK[op] > OP_RANK[worst.op]) worst = { id, op };
    }
    const io = stageIO(s, ms.id, p);
    const isOutput = ms.id === LINE.outputStage;
    const output = isOutput ? lm.outputM2 : io.output == null ? null : io.unit === 'pallets' ? io.output : io.output * M2_PER_TILE;
    const list = alerts.get(ms.id) ?? [];
    let sev: AlertSeverity | null = null;
    for (const e of list) if (sev == null || SEV_RANK[e.severity] > SEV_RANK[sev]) sev = e.severity;
    // A stale counting point: the running figure stays (same number as the KPIs), marked not confirmed.
    const stale = outputStale(s, ms.id, p);

    return {
      id: ms.id,
      name: ms.name,
      short: STAGE_SHORT[ms.id],
      status: worst?.op ?? null,
      statusAssetId: worst?.id ?? null,
      statusAssetName: worst ? (CONVEYOR_BY_ID[worst.id]?.name ?? EQUIPMENT_BY_ID[worst.id]?.name ?? worst.id) : null,
      output,
      unit: io.unit === 'pallets' ? 'pallets' : 'm²',
      tileEquivalent: !isOutput && /tile-equivalent/i.test(ms.output.label),
      outputLabel: isOutput ? 'Good output — tiles accepted at sorting' : ms.output.label,
      // The plan comparison of the running figure (shown as not confirmed while `stale` is set).
      plan: isOutput ? { planM2: lm.targetM2, gapM2: lm.outputM2 - lm.targetM2, attainment: lm.attainment, status: targetStatus(lm.attainment) } : null,
      workingShare: workingShare(s, ms.id, p),
      alerts: { count: list.length, worst: sev, ids: list.map((e) => e.id) },
      constraint: claim.stage === ms.id ? claim : null,
      stale,
    };
  });
}

/** Display name of a monitored stage. */
export const stageName = (id: MonitoredStageId) => MONITORED_STAGE_BY_ID[id]?.name ?? id;
