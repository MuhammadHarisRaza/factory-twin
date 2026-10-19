/**
 * Reliability tab of Events & Reports (brief §8 E): downtime Pareto, recurring fault codes, longest stops,
 * MTBF / MTTR and equipment-state timelines over one time window, from the shared stop records (s.downtime)
 * and the telemetry state timelines (src/sim/telemetry.ts stateTimeline) — pure, testable.
 *
 * Counting rules (stated in the view):
 * - Own stops only, in three classes that never overlap: unplanned (faults and stops), product changeover
 *   (its own class, an availability loss but not a failure) and planned (cleaning, maintenance). Starved /
 *   blocked spells are waits on a neighbour, not stops of the machine, and are not counted here.
 * - Minutes are clipped to the window (an open stop runs to now) and per equipment counted once
 *   (calc downtimeMinutes); the Pareto and the longest stops count stops overlapping the window.
 * - Recurrence and MTBF / MTTR count unplanned stops STARTING in the window (calc faultRecurrence /
 *   mtbfMttr); changeovers and planned stops are never failures. MTBF with no failure is unavailable, never
 *   infinite or zero. Operating time = minutes the state timeline shows the asset available (running,
 *   below rate, idle, starved, blocked); minutes in an unknown state (stale feed) are not operating time.
 */
import { downtimeMinutes, faultRecurrence, longestStops, mtbfMttr, stateDurations, type Calc, type RecurrenceRow, type StopRecord, type Window } from '../../calc';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { findingsFor, type RuleFinding } from '../../intel/rules';
import type { EquipmentStateSegment } from '../../model/telemetry';
import { CONVEYOR_BY_ID, CONVEYOR_IDS, PROCESS_MACHINES, REASON_BY_CODE } from '../../model/plant';
import type { DowntimeCategory, DowntimeEvent, OpEvent, OperationalState, RecordSource } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { stateTimeline } from '../../sim/telemetry';
import { inWindow, newestFirst, windowRange, WINDOW_OPTIONS, type WindowKey } from './filters';

// ── Windows ──────────────────────────────────────────────────────────────────

/** The Events tab's windows without 'All' (stop records and state history are kept for 8 days). */
export const RELIABILITY_WINDOWS = WINDOW_OPTIONS.filter((o) => o.value !== 'all');
export type ReliabilityWindowKey = Exclude<WindowKey, 'all' | 'prev-shift' | 'today'>;

/** The window [from, to) in plant minutes (never before the simulation start). */
export function reliabilityWindow(key: ReliabilityWindowKey, now: number): Window & { label: string } {
  const w = windowRange(key, now);
  return { from: Math.max(0, w.from), to: w.to, label: w.label };
}

// ── Stops ────────────────────────────────────────────────────────────────────

export type StopClass = 'unplanned' | 'changeover' | 'planned';
export const STOP_CLASSES: StopClass[] = ['unplanned', 'changeover', 'planned'];
export const STOP_CLASS_LABEL: Record<StopClass, string> = { unplanned: 'Unplanned', changeover: 'Changeover', planned: 'Planned' };

/** Class of a downtime record; null for starved / blocked spells (waits on a neighbour, not own stops). */
export function stopClassOf(d: Pick<DowntimeEvent, 'reasonCode' | 'category'>): StopClass | null {
  if (d.category === 'Starved' || d.category === 'Blocked') return null;
  if (d.category === 'Planned' || REASON_BY_CODE[d.reasonCode]?.planned) return 'planned';
  if (d.category === 'Changeover' || d.reasonCode === 'CHG_PRODUCT') return 'changeover';
  return 'unplanned';
}

/** An own stop as the reliability calculations need it, with where it came from and its event record. */
export type ReliabilityStop = StopRecord & {
  id: string;
  cls: StopClass;
  category: DowntimeCategory;
  source: RecordSource;
  scenarioId?: string;
  /** The event raised for this stop (OpEvent.refs.downtimeId), when there is one. */
  eventId: string | null;
  name: string;
};

export const assetName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;

/** Own stops overlapping the window (an open stop reaches now), oldest first. */
export function reliabilityStops(downtime: DowntimeEvent[], events: OpEvent[], window: Window, now: number): ReliabilityStop[] {
  const eventOf = new Map<string, string>();
  for (const e of events) if (e.refs.downtimeId && !eventOf.has(e.refs.downtimeId)) eventOf.set(e.refs.downtimeId, e.id);
  const out: ReliabilityStop[] = [];
  for (const d of downtime) {
    const cls = stopClassOf(d);
    if (!cls || d.start >= window.to || (d.end ?? now) <= window.from) continue;
    out.push({
      id: d.id,
      start: d.start,
      end: d.end,
      equipmentId: d.equipmentId,
      reasonCode: d.reasonCode,
      reasonLabel: REASON_BY_CODE[d.reasonCode]?.label ?? d.reasonCode,
      // Changeovers and planned stops are not failures (calc recurrence / MTBF leave out planned records).
      planned: cls !== 'unplanned',
      cls,
      category: d.category,
      source: d.source,
      ...(d.scenarioId ? { scenarioId: d.scenarioId } : {}),
      eventId: eventOf.get(d.id) ?? null,
      name: assetName(d.equipmentId),
    });
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export type ClassTotal = { cls: StopClass; minutes: number; stops: number; open: number };

/** Minutes (clipped, equipment-minutes) and stop counts per class — each stop in exactly one class. */
export function classTotals(stops: ReliabilityStop[], window: Window): Record<StopClass, ClassTotal> {
  const out = {} as Record<StopClass, ClassTotal>;
  for (const cls of STOP_CLASSES) {
    const list = stops.filter((x) => x.cls === cls);
    out[cls] = { cls, minutes: downtimeMinutes(list, window, { includePlanned: true }), stops: list.length, open: list.filter((x) => x.end == null).length };
  }
  return out;
}

// ── Pareto ───────────────────────────────────────────────────────────────────

export type ParetoBy = 'reason' | 'equipment';
export type ParetoRow = { key: string; label: string; sub: string; minutes: number; stops: number; share: number; cumulative: number };

/** Stop minutes of one class grouped by reason or by equipment, largest first, with share and cumulative share. */
export function downtimePareto(stops: ReliabilityStop[], window: Window, cls: StopClass, by: ParetoBy): ParetoRow[] {
  const groups = new Map<string, ReliabilityStop[]>();
  for (const x of stops) {
    if (x.cls !== cls) continue;
    const k = by === 'reason' ? x.reasonCode : x.equipmentId;
    const g = groups.get(k);
    if (g) g.push(x);
    else groups.set(k, [x]);
  }
  const rows = [...groups.entries()].map(([key, list]): ParetoRow => {
    const assets = new Set(list.map((x) => x.equipmentId)).size;
    const reasons = new Set(list.map((x) => x.reasonCode)).size;
    return {
      key,
      label: by === 'reason' ? (list[0].reasonLabel ?? key) : `${assetName(key)} (${key})`,
      sub: by === 'reason' ? `${key} · ${assets} asset${assets === 1 ? '' : 's'}` : `${reasons} reason${reasons === 1 ? '' : 's'}`,
      minutes: downtimeMinutes(list, window, { includePlanned: true }),
      stops: list.length,
      share: 0,
      cumulative: 0,
    };
  });
  rows.sort((a, b) => b.minutes - a.minutes || b.stops - a.stops || a.key.localeCompare(b.key));
  const total = rows.reduce((a, r) => a + r.minutes, 0);
  let cum = 0;
  for (const r of rows) {
    r.share = total > 0 ? r.minutes / total : 0;
    cum += r.share;
    r.cumulative = Math.min(1, cum);
  }
  return rows.filter((r) => r.minutes > 0);
}

// ── Recurrence, longest stops, MTBF / MTTR ───────────────────────────────────

export type RecurringRow = RecurrenceRow & { equipmentId: string; reasonCode: string; name: string; label: string; meanMin: number };

/** The same fault code on the same asset at least `minCount` times (unplanned stops starting in the window). */
export function recurringFaults(stops: ReliabilityStop[], window: Window, minCount = 2): RecurringRow[] {
  return faultRecurrence(
    stops.filter((x) => x.cls === 'unplanned'),
    window,
    { by: 'both', minCount },
  ).map((r) => ({
    ...r,
    equipmentId: r.equipmentId!,
    reasonCode: r.reasonCode!,
    name: assetName(r.equipmentId!),
    label: r.reasonLabel ?? REASON_BY_CODE[r.reasonCode!]?.label ?? r.reasonCode!,
    meanMin: r.count ? r.totalMin / r.count : 0,
  }));
}

export type LongStop = ReliabilityStop & { minutes: number; ongoing: boolean };

/** The `n` longest stops of one class by minutes inside the window (an open stop runs to now). */
export function longestStoppages(stops: ReliabilityStop[], window: Window, cls: StopClass, n = 8): LongStop[] {
  // calc longestStops returns copies of the given records with `minutes` added; they are ReliabilityStops.
  const rows = longestStops(
    stops.filter((x) => x.cls === cls),
    window,
    n,
    { includePlanned: true },
  ) as (ReliabilityStop & { minutes: number })[];
  return rows.map((x) => ({ ...x, ongoing: x.end == null }));
}

/** States in which an asset is available (it is not in an own stop and its state is known). */
const OPERATING: ReadonlySet<string> = new Set<OperationalState>(['running', 'reduced', 'idle', 'starved', 'blocked']);
const OWN_STOP: ReadonlySet<string> = new Set<OperationalState>(['stopped', 'fault', 'planned', 'changeover']);

export type OperatingTime = { operatingMin: number | null; ownStopMin: number; unknownMin: number; coveredMin: number };

/** Operating time of an asset from its state timeline (null when the timeline covers none of the window). */
export function operatingTime(segments: EquipmentStateSegment[], window: Window): OperatingTime {
  const d = stateDurations(segments, window) as Record<string, number | undefined>;
  let operating = 0;
  let own = 0;
  let unknown = 0;
  for (const [state, min] of Object.entries(d)) {
    if (min == null) continue;
    if (OPERATING.has(state)) operating += min;
    else if (OWN_STOP.has(state)) own += min;
    else unknown += min;
  }
  const covered = operating + own + unknown;
  return { operatingMin: covered > 0 ? operating : null, ownStopMin: own, unknownMin: unknown, coveredMin: covered };
}

export type MtbfRow = {
  equipmentId: string;
  name: string;
  kind: 'machine' | 'conveyor';
  /** Unplanned stops starting in the window. */
  failures: number;
  operating: OperatingTime;
  mtbfH: Calc<number>;
  mttrMin: Calc<number>;
};

/** MTBF (h) and MTTR (min) per tracked asset over the window. */
export function mtbfRows(stops: ReliabilityStop[], window: Window, operating: Record<string, OperatingTime>, ids: string[] = [...PROCESS_MACHINES, ...CONVEYOR_IDS]): MtbfRow[] {
  return ids.map((id) => {
    const own = stops.filter((x) => x.equipmentId === id);
    const op = operating[id] ?? { operatingMin: null, ownStopMin: 0, unknownMin: 0, coveredMin: 0 };
    const r = mtbfMttr(own, window, op.operatingMin);
    return {
      equipmentId: id,
      name: assetName(id),
      kind: CONVEYOR_BY_ID[id] ? 'conveyor' : 'machine',
      failures: own.filter((x) => x.cls === 'unplanned' && x.start >= window.from && x.start < window.to).length,
      operating: op,
      mtbfH: r.mtbfH,
      mttrMin: r.mttrMin,
    };
  });
}

// ── State timelines ──────────────────────────────────────────────────────────

export type LaneGroup = 'machines' | 'conveyors';
export const LANE_GROUP_IDS: Record<LaneGroup, string[]> = { machines: PROCESS_MACHINES, conveyors: CONVEYOR_IDS };

export type TimelineLane = { id: string; label: string; segments: { from: number; to: number; state: string; label?: string }[] };

/** StateTimeline lanes of the given assets (labels keep the stop reason or why the state is unknown). */
export function stateLanes(timelines: Record<string, EquipmentStateSegment[]>, ids: string[]): TimelineLane[] {
  return ids.map((id) => ({
    id,
    label: `${id} · ${assetName(id)}`,
    segments: (timelines[id] ?? []).map((x) => ({ from: x.from, to: x.to, state: x.state, ...(x.label ? { label: x.label } : {}) })),
  }));
}

// ── Communication / data-quality issues and rule findings ────────────────────

/** Data-feed events (communication loss, counters not updating) overlapping the window, newest first. */
export const communicationEvents = (events: OpEvent[], window: Window, now: number): OpEvent[] =>
  events.filter((e) => e.category === 'data' && inWindow(e, window, now)).sort(newestFirst);

export type FindingGroup = { shown: RuleFinding[]; fired: number; insufficient: number; clear: number };

/** Fired and not-evaluated findings of one family (clear ones are counted, not listed). */
export function findingGroup(findings: RuleFinding[], family: RuleFinding['family']): FindingGroup {
  const fam = findings.filter((f) => f.family === family);
  const shown = fam.filter((f) => f.status !== 'clear');
  return { shown, fired: fam.filter((f) => f.status === 'fired').length, insufficient: fam.filter((f) => f.status === 'insufficient-data').length, clear: fam.length - shown.length };
}

// ── The view model ───────────────────────────────────────────────────────────

export type ReliabilityModel = {
  now: number;
  window: Window & { label: string };
  stops: ReliabilityStop[];
  totals: Record<StopClass, ClassTotal>;
  recurring: RecurringRow[];
  mtbf: MtbfRow[];
  lanes: Record<LaneGroup, TimelineLane[]>;
  communication: OpEvent[];
  reliabilityFindings: FindingGroup;
  dataFindings: FindingGroup;
};

/** Everything the Reliability tab shows for one window (the class / grouping choices are applied by the view). */
export function reliabilityModel(s: SimState, key: ReliabilityWindowKey): ReliabilityModel {
  const now = s.minute;
  const window = reliabilityWindow(key, now);
  const stops = reliabilityStops(s.downtime, s.events, window, now);
  const timelines: Record<string, EquipmentStateSegment[]> = {};
  const operating: Record<string, OperatingTime> = {};
  for (const id of [...PROCESS_MACHINES, ...CONVEYOR_IDS]) {
    timelines[id] = stateTimeline(s, id, window);
    operating[id] = operatingTime(timelines[id], window);
  }
  const findings = findingsFor(s, { kind: 'plant' });
  return {
    now,
    window,
    stops,
    totals: classTotals(stops, window),
    recurring: recurringFaults(stops, window),
    mtbf: mtbfRows(stops, window, operating),
    lanes: { machines: stateLanes(timelines, LANE_GROUP_IDS.machines), conveyors: stateLanes(timelines, LANE_GROUP_IDS.conveyors) },
    communication: communicationEvents(s.events, window, now),
    reliabilityFindings: findingGroup(findings, 'reliability'),
    dataFindings: findingGroup(findings, 'data'),
  };
}

/** The tab's one-sentence summary (header), from the stop records only — cheap enough for every render. */
export function reliabilityHeadline(s: SimState, key: ReliabilityWindowKey): string {
  const window = reliabilityWindow(key, s.minute);
  const t = classTotals(reliabilityStops(s.downtime, [], window, s.minute), window);
  const u = t.unplanned;
  const dur = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);
  return `${window.label[0].toUpperCase()}${window.label.slice(1)}: ${dur(u.minutes)} of unplanned downtime in ${u.stops} stop${u.stops === 1 ? '' : 's'}${u.open ? ` (${u.open} still open)` : ''}, ${dur(t.changeover.minutes)} of changeovers and ${dur(t.planned.minutes)} of planned stops — own stops only; waits on a neighbour (starved / blocked) are not counted.`;
}
