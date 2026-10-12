/**
 * Operational context of one asset for the equipment workspace: its recent event records, the
 * impact of an event still in progress, its role in the line constraint and the recommended next
 * steps. Pure functions over the shared SimState; every statement comes from an existing event
 * record, the constraint claim / bottleneck analysis or the rule-based insights — nothing is
 * generated here.
 */
import { GEOFENCES, STAGE_BY_ID } from '../../model/plant';
import type { OpEvent, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { eventsFor } from '../../sim/events';
import { HELD_UP_SHARE, bottleneck } from '../../sim/metrics';
import { recommendationsFor, type Insight, type InsightLink, type InsightSeverity } from '../../intel/insights';
import { constraintMarker, type ConstraintMarker } from '../twin/constraint';
import type { AssetProfile } from './profile';

const SEV_RANK = { info: 0, warning: 1, serious: 2, critical: 3 } as const;
const FLOW_TYPES = new Set<OpEvent['type']>(['starvation', 'blockage']);

/**
 * Event records concerning an asset, newest first: its own (eventsFor equipmentId), the stage-level
 * starvation / blockage events of the stage it belongs to, and logistics events in the geofences /
 * docks that belong to it.
 */
export function eventsOfAsset(s: SimState, id: string): OpEvent[] {
  const own = eventsFor(s, { equipmentId: id });
  const fences = new Set(GEOFENCES.filter((g) => g.equipmentId === id).map((g) => g.id));
  const inStage = (stage: string | undefined) => !!stage && !!STAGE_BY_ID[stage as StageId]?.machines.includes(id);
  const extra = s.events.filter(
    (e) =>
      e.asset.equipmentId !== id &&
      ((FLOW_TYPES.has(e.type) && inStage(e.asset.stage)) || (!!e.asset.geofenceId && fences.has(e.asset.geofenceId)) || (id === 'K-DOCK' && !!e.asset.dockId)),
  );
  return [...own, ...extra].sort((a, b) => b.start - a.start || b.id.localeCompare(a.id));
}

/** The newest `n` event records of an asset (each opens its report). */
export const recentEvents = (s: SimState, id: string, n = 3) => eventsOfAsset(s, id).slice(0, n);

/** Root events still in progress on the asset (condition present), most severe first. */
export function activeRootEvents(s: SimState, id: string): OpEvent[] {
  return eventsOfAsset(s, id)
    .filter((e) => e.end == null && !e.consequenceOf)
    .sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.start - a.start);
}

/** Unresolved events of the asset (condition present or cleared but not yet resolved by a user). */
export const openEventsOf = (s: SimState, id: string) => eventsOfAsset(s, id).filter((e) => e.status !== 'resolved');

export type ConstraintRole =
  /** The asset's process stage is where the constraint claim sits (the kiln, or the stage the trace ended at). */
  | { kind: 'constraint'; stage: StageId; marker: ConstraintMarker }
  /** Held up by its neighbours in the bottleneck window (starved / blocked above the threshold). */
  | { kind: 'held-up'; stage: StageId; name: string; starvedShare: number; blockedShare: number; window: string; marker: ConstraintMarker }
  | null;

/**
 * Role of the asset's process stage in the line constraint, in the Overview's wording
 * (constraintClaim, via constraintMarker): the stage the claim names — "constraining output" only
 * when the evidence supports it, otherwise the kiln as the modeled design constraint — or a stage
 * held up by its neighbours (starved / blocked above 5 % of the bottleneck window, src/sim/metrics.ts
 * bottleneck). Process machines only; null when neither applies.
 */
export function constraintRole(s: SimState, prof: AssetProfile, marker: ConstraintMarker = constraintMarker(s)): ConstraintRole {
  const stage = prof.kind === 'machine' ? prof.stage : null;
  if (!stage) return null;
  if (marker.processStage === stage) return { kind: 'constraint', stage, marker };
  const bn = bottleneck(s);
  const row = bn.stages.find((r) => r.stage === stage);
  if (row && (row.starvedShare > HELD_UP_SHARE || row.blockedShare > HELD_UP_SHARE))
    return { kind: 'held-up', stage, name: row.name, starvedShare: row.starvedShare, blockedShare: row.blockedShare, window: bn.period.label.toLowerCase(), marker };
  return null;
}

export type NextStep = {
  key: string;
  /** Where the step comes from: an event record's recommendations or a rule-based insight. */
  origin: 'event' | 'insight';
  severity: InsightSeverity;
  title: string;
  text: string;
  /** Event the step belongs to (report link). */
  eventId?: string;
  links: InsightLink[];
};

const norm = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Recommended next steps for the asset, most important first: the recommendations of its open
 * root events (each labelled with its event), then the rule-based insights that concern it
 * (recommendationsFor), without repeating the same advice.
 */
export function nextSteps(s: SimState, id: string, limit = 3, insights: Insight[] = recommendationsFor(s, id)): NextStep[] {
  const out: NextStep[] = [];
  const seen = new Set<string>();
  const push = (st: NextStep) => {
    const k = norm(st.text);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(st);
  };
  const open = openEventsOf(s, id)
    .filter((e) => !e.consequenceOf && e.recommendations.length > 0)
    .sort((a, b) => Number(b.end == null) - Number(a.end == null) || SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.start - a.start);
  for (const e of open)
    push({ key: `ev:${e.id}`, origin: 'event', severity: e.severity, title: e.title, text: e.recommendations[0], eventId: e.id, links: [{ kind: 'event', id: e.id, label: `Report ${e.id}` }] });
  for (const i of insights) {
    if (!i.recommendation || i.severity === 'positive') continue;
    push({ key: `in:${i.id}`, origin: 'insight', severity: i.severity, title: i.title, text: i.recommendation, links: i.links });
  }
  return out.slice(0, limit);
}
