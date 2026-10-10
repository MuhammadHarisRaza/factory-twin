/**
 * OEE & Loss Intelligence — equipment level: every process machine and conveyor for a period,
 * with its own figures (asset level) and what it cost the line at the constraint (from the loss
 * ledger's attribution, so the line loss is never a sum of machine losses).
 */
import { CONVEYORS, M2_PER_TILE, PROCESS_MACHINES, STAGE_BY_ID } from '../../model/plant';
import type { OpEvent, OperationalState, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { conveyorMetrics, machineMetrics, operationalState, type MachineMetrics, type Period } from '../../sim/metrics';
import { machineLoss } from './derive';
import type { Contribution } from './loss';

export type MachineRow = {
  id: string;
  name: string;
  stage: StageId;
  stageName: string;
  op: OperationalState;
  mm: MachineMetrics;
  outputM2: number;
  downMin: number;
  starvedShare: number | null;
  blockedShare: number | null;
  /** Ideal-rate output the machine itself did not make (down + starved + blocked) — asset level, not additive. */
  ownLostM2: number;
  /** Its share of the line loss at the constraint (additive across assets). */
  lineLossM2: number;
  events: number;
  activeEvents: number;
};

export type ConveyorRow = {
  id: string;
  name: string;
  from: StageId | null;
  to: StageId | null;
  route: string;
  op: OperationalState;
  /** Running share of planned time. */
  availability: number | null;
  /** Transported tiles ÷ nominal capacity over planned time. */
  utilisation: number | null;
  stops: number;
  downMin: number;
  transportedM2: number;
  lineLossM2: number;
  events: number;
  activeEvents: number;
};

const lineLoss = (contributions: Contribution[], id: string) => contributions.find((c) => c.equipmentId === id)?.m2 ?? 0;

const FLOW_TYPES = new Set<OpEvent['type']>(['starvation', 'blockage']);

/**
 * Events on one asset that overlap the period: active first, then newest. Its own events, plus the
 * starvation / blockage event of the stage it belongs to — raised once per stage on its first
 * machine, but every machine of the stage was held up (the same rule as the twin's assetEvents).
 */
export function assetEvents(s: SimState, id: string, p: Period): OpEvent[] {
  const inStage = (stage: string | undefined) => !!stage && !!STAGE_BY_ID[stage as StageId]?.machines.includes(id);
  return s.events
    .filter((e) => (e.asset.equipmentId === id || (FLOW_TYPES.has(e.type) && inStage(e.asset.stage))) && (e.end ?? s.minute) >= p.from && e.start <= p.to)
    .sort((a, b) => (a.end == null ? 0 : 1) - (b.end == null ? 0 : 1) || b.start - a.start);
}

/** Events elsewhere that the event engine linked as consequences of this asset's events (e.g. the kiln starved). */
export function consequenceEvents(s: SimState, own: OpEvent[]): OpEvent[] {
  const ids = new Set(own.map((e) => e.id));
  return s.events.filter((e) => e.consequenceOf && ids.has(e.consequenceOf)).sort((a, b) => b.start - a.start);
}

export function machineRows(s: SimState, p: Period, contributions: Contribution[]): MachineRow[] {
  return PROCESS_MACHINES.map((id) => {
    const mm = machineMetrics(s, id, p);
    const t = mm.totals;
    const ev = assetEvents(s, id, p);
    return {
      id,
      name: mm.name,
      stage: mm.stage,
      stageName: STAGE_BY_ID[mm.stage].name,
      op: operationalState(s, id),
      mm,
      outputM2: t.count * M2_PER_TILE,
      downMin: t.down,
      starvedShare: t.planned > 0 ? t.starved / t.planned : null,
      blockedShare: t.planned > 0 ? t.blocked / t.planned : null,
      ownLostM2: machineLoss(s, id, p).totalM2,
      lineLossM2: lineLoss(contributions, id),
      events: ev.length,
      activeEvents: ev.filter((e) => e.end == null).length,
    };
  });
}

export function conveyorRows(s: SimState, p: Period, contributions: Contribution[]): ConveyorRow[] {
  return CONVEYORS.map((c) => {
    const cm = conveyorMetrics(s, c.id, p);
    const ev = assetEvents(s, c.id, p);
    return {
      id: c.id,
      name: c.name,
      from: c.from,
      to: c.to,
      route: `${c.from ? STAGE_BY_ID[c.from].name : 'Supply'} → ${c.to ? STAGE_BY_ID[c.to].name : 'Dispatch'}`,
      op: operationalState(s, c.id),
      availability: cm.availability,
      utilisation: cm.utilisation,
      stops: cm.stops,
      downMin: cm.downMin,
      transportedM2: cm.totals.count * M2_PER_TILE,
      lineLossM2: lineLoss(contributions, c.id),
      events: ev.length,
      activeEvents: ev.filter((e) => e.end == null).length,
    };
  });
}
