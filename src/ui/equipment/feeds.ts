/**
 * Data-feed transparency (moved here from the retired Assets & Data page): one row per tracked asset
 * (process machines and conveyors) with the simulated feed status from s.feeds. Nothing is
 * "connected" in this release — a healthy feed reads "Simulated"; a feed lost in a signal-loss
 * scenario reads "Stale since hh:mm" and keeps the last values it delivered.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID, DATA_SOURCES, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { MachineState, OperationalState, StageId } from '../../model/types';
import { TRACKED_ASSETS, type SimState } from '../../sim/engine';
import { operationalState } from '../../sim/metrics';
import { formatClock, formatDuration } from '../../sim/time';

/** Integration a process feed would come from once connected (documentation of the boundary). */
export const PLANNED_SOURCE = 'Line PLCs via industrial gateway (not connected)';

export type FeedRow = {
  id: string;
  name: string;
  kind: 'machine' | 'conveyor';
  stage: StageId | null;
  stageName: string;
  /** Integration the feed would come from once connected. */
  plannedSource: string;
  status: 'simulated' | 'stale';
  /** "Simulated" or "Stale since hh:mm". */
  statusLabel: string;
  since: number | null;
  staleFor: number | null;
  scenarioId: string | null;
  state: OperationalState;
  /** Values received before the feed went stale (frozen), when stale. */
  last: { state: MachineState | null; rate: number | null; count: number | null } | null;
};

/** Feed row of one tracked asset (null for assets without a simulated operating feed). */
export function feedOf(s: SimState, id: string): FeedRow | null {
  if (!s.machines[id]) return null;
  const conv = CONVEYOR_BY_ID[id];
  const stage = (OPS_BY_ID[id]?.stage ?? conv?.to ?? null) as StageId | null;
  const f = s.feeds[id];
  const stale = f?.status === 'stale';
  return {
    id,
    name: EQUIPMENT_BY_ID[id]?.name ?? conv?.name ?? id,
    kind: conv ? 'conveyor' : 'machine',
    stage,
    stageName: stage ? (STAGE_BY_ID[stage]?.name ?? stage) : '—',
    plannedSource: PLANNED_SOURCE,
    status: stale ? 'stale' : 'simulated',
    statusLabel: stale ? `Stale since ${formatClock(f.since)}` : 'Simulated',
    since: stale ? f.since : null,
    staleFor: stale ? s.minute - f.since : null,
    scenarioId: stale ? (f.scenarioId ?? null) : null,
    state: operationalState(s, id),
    last: stale ? { state: f.lastState ?? null, rate: f.lastRate ?? null, count: f.lastCount ?? null } : null,
  };
}

export function feedRows(s: SimState): FeedRow[] {
  return TRACKED_ASSETS.map((id) => feedOf(s, id)).filter((r): r is FeedRow => r != null);
}

export function feedSummary(rows: FeedRow[]) {
  const stale = rows.filter((r) => r.status === 'stale');
  return {
    machines: rows.filter((r) => r.kind === 'machine').length,
    conveyors: rows.filter((r) => r.kind === 'conveyor').length,
    stale: stale.length,
    longest: stale.length ? formatDuration(Math.max(...stale.map((r) => r.staleFor ?? 0))) : null,
  };
}

/** The data source that delivers an asset's signals today (the simulation engine) and its status. */
export const SIM_SOURCE = DATA_SOURCES.find((d) => d.kind === 'simulation') ?? DATA_SOURCES[0];
