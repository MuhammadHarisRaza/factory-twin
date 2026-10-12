/**
 * Overview derivations — pure functions over the one simulation state:
 *  - the issues requiring attention (attentionEvents) shaped as what / where / when / impact /
 *    next step, the impact read from the event report model (eventImpact) and labelled as an
 *    estimate where it is one;
 *  - the compact selection card of the embedded 3D model (equipment, vehicle or stage).
 * Nothing here creates an incident or a value the simulation does not hold.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { CONVEYOR_BY_ID, DOCKS, GEOFENCES, INSPECTION_STATIONS, LINE, OPS_BY_ID, REASON_BY_CODE } from '../../model/plant';
import type { AlertSeverity, MonitoredStageId, OpEvent, OperationalState, Vehicle, VehicleType } from '../../model/types';
import { attentionEvents } from '../../intel/kpis';
import { eventImpact } from '../../intel/report';
import { findDowntime, type SimState } from '../../sim/engine';
import { phaseLabel } from '../../sim/logistics';
import { internalActivity, operationalState, type Period } from '../../sim/metrics';
import { formatClock, formatDay, formatDuration } from '../../sim/time';
import type { Tone } from '../../ui/kit/Status';
import { assetStage, eventStage, flowStages, stageName, type FlowStage } from '../../ui/flow/derive';

const int = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (x: number) => `${Math.round(x * 100)} %`;
const SEV_RANK: Record<AlertSeverity, number> = { info: 0, warning: 1, serious: 2, critical: 3 };

/** Issues shown by default, and at most (the rest are one click away in Events & Reports). */
export const ISSUES_SHOWN = 3;
export const ISSUES_MAX = 5;

// ── Issues requiring attention ───────────────────────────────────────────────

export type ImpactLine = {
  /** One short line, operational units (m², minutes, tiles). */
  text: string;
  /** True where the figure is an estimate (derived with stated assumptions) rather than a count. */
  estimate: boolean;
  /** How it was derived (tooltip). */
  basis: string;
};

/** Report impact rows used here (labels of src/intel/report.ts eventImpact; a missing row falls back). */
const ROW = {
  lineLost: 'Line good output lost',
  excess: 'Excess rejects',
  beyond: 'Minutes beyond the threshold',
  queue: 'Trucks waiting at detection',
  health: 'Health now',
  trip: 'Projected time to trip',
  gap: 'Data gap',
} as const;

/** The most decision-relevant impact of an event, in one line (from the event report's impact model). */
export function impactLine(s: SimState, ev: OpEvent): ImpactLine {
  const imp = eventImpact(s, ev);
  const row = (label: string) => imp.rows.find((r) => r.label === label);
  const fallback = (): ImpactLine => {
    const r = imp.rows.find((x) => !/duration/i.test(x.label)) ?? imp.rows[0];
    return r ? { text: `${r.label}: ${r.value}`, estimate: false, basis: r.basis } : { text: 'Impact not assessed for this event type', estimate: false, basis: '' };
  };
  switch (ev.category) {
    case 'production': {
      const lost = row(ROW.lineLost);
      if (ev.acc.constraintMin > 0 && lost)
        return { text: `≈ ${lost.value} of line good output lost · kiln held up ${int(ev.acc.constraintMin)} min`, estimate: true, basis: lost.basis };
      const note = imp.notes.find((n) => /line output/i.test(n));
      return note ? { text: note.replace(/\.$/, ''), estimate: false, basis: 'Minutes the kiln (line constraint) was held up by this event — none so far' } : fallback();
    }
    case 'quality': {
      const excess = row(ROW.excess);
      if (excess) return { text: `≈ ${excess.value} excess rejects vs the 24 h reference rate`, estimate: true, basis: excess.basis };
      const rejected = imp.rows.find((r) => r.label.startsWith('Rejected'));
      return rejected ? { text: `${rejected.value} rejected in the event window`, estimate: false, basis: rejected.basis } : fallback();
    }
    case 'logistics': {
      const beyond = row(ROW.beyond);
      if (beyond) return { text: `${beyond.value} beyond the limit`, estimate: false, basis: beyond.basis };
      const queue = row(ROW.queue);
      if (queue) return { text: `${queue.value} trucks waiting at detection`, estimate: false, basis: queue.basis };
      if (ev.type === 'restricted-entry') return { text: 'Safety exposure: vehicle inside a no-entry zone', estimate: false, basis: 'Geofence rule on simulated positions' };
      return fallback();
    }
    case 'equipment': {
      const health = row(ROW.health);
      const trip = row(ROW.trip);
      if (health) return { text: `Health ${health.value}${trip ? ` · projected trip in ${trip.value}` : ''}`, estimate: !!trip, basis: trip ? trip.basis : health.basis };
      return fallback();
    }
    case 'data': {
      const gap = row(ROW.gap);
      return gap ? { text: `Data gap ${gap.value} — the asset's counters and OEE are incomplete`, estimate: false, basis: gap.basis } : fallback();
    }
    default:
      return fallback();
  }
}

export type Subject = { id: string; name: string };

/** The assets / vehicles / places an event concerns, by name (duplicates removed). */
export function eventSubjects(s: SimState, ev: OpEvent): Subject[] {
  const a = ev.asset;
  const out: Subject[] = [];
  const add = (id: string | undefined, name: string | undefined) => {
    if (id && name && !out.some((x) => x.id === id || x.name === name)) out.push({ id, name });
  };
  if (a.vehicleId) add(a.vehicleId, s.logistics.vehicles[a.vehicleId]?.label ?? a.vehicleId);
  const station = a.stationId ? INSPECTION_STATIONS.find((x) => x.id === a.stationId) : undefined;
  if (station) add(station.equipmentId, station.name);
  else if (a.equipmentId) add(a.equipmentId, CONVEYOR_BY_ID[a.equipmentId]?.name ?? EQUIPMENT_BY_ID[a.equipmentId]?.name ?? a.equipmentId);
  if (a.dockId) add(a.dockId, DOCKS.find((d) => d.id === a.dockId)?.name);
  if (a.geofenceId && a.geofenceId !== 'GF-SITE' && !a.dockId) add(a.geofenceId, GEOFENCES.find((g) => g.id === a.geofenceId)?.name);
  return out;
}

export type IssueRow = {
  ev: OpEvent;
  where: { stageId: MonitoredStageId | null; place: string | null; subjects: Subject[] };
  when: { clock: string; ago: string; active: boolean; cleared: string | null };
  impact: ImpactLine;
  next: string;
  provenance: 'simulated' | 'scenario';
};

export function issueRow(s: SimState, ev: OpEvent): IssueRow {
  const now = s.minute;
  const stageId = eventStage(ev);
  const zone = ev.asset.zone ? ZONE_BY_ID[ev.asset.zone] : undefined;
  const sameDay = formatDay(ev.start) === formatDay(now);
  return {
    ev,
    where: { stageId, place: stageId ? stageName(stageId) : zone ? zone.name : null, subjects: eventSubjects(s, ev) },
    when: {
      clock: sameDay ? formatClock(ev.start) : `${formatDay(ev.start)} ${formatClock(ev.start)}`,
      ago: now - ev.start < 1 ? 'just now' : `${formatDuration(now - ev.start)} ago`,
      active: ev.end == null,
      cleared: ev.end == null ? null : formatClock(ev.end),
    },
    impact: impactLine(s, ev),
    next: ev.recommendations[0] ?? 'Open the event record and review the evidence.',
    provenance: ev.source === 'scenario' ? 'scenario' : 'simulated',
  };
}

/** The priority issues (attentionEvents order: most severe, still active, newest), at most `limit`. */
export function issueRows(s: SimState, limit = ISSUES_MAX): { rows: IssueRow[]; total: number } {
  const list = attentionEvents(s);
  return { rows: list.slice(0, limit).map((ev) => issueRow(s, ev)), total: list.length };
}

// ── Selection card ───────────────────────────────────────────────────────────

export type CardStatus = { kind: 'op'; op: OperationalState } | { kind: 'text'; label: string; tone: Tone } | null;

export type SelectionCardModel = {
  kind: 'equipment' | 'vehicle' | 'stage';
  id: string;
  title: string;
  subtitle: string;
  status: CardStatus;
  /** One or two facts. */
  facts: { label: string; value: string; hint?: string }[];
  stageId: MonitoredStageId | null;
  /**
   * Set when a data feed the card's figures rest on is stale (the card shows a Stale badge). `label` is
   * the not-confirmed mark of an aggregate figure ("Not confirmed · kiln data stale since 10:30", the
   * flow strip's and KPIs' text); an equipment card's raw values are frozen instead and carry no label.
   */
  stale?: { since: number; note: string; label?: string } | null;
};

export type TwinSelection = { selected: string | null; vehicle: string | null; stage: MonitoredStageId | null };

const VEHICLE_TYPE: Record<VehicleType, string> = {
  'outbound-truck': 'Outbound truck',
  'inbound-tipper': 'Inbound tipper',
  forklift: 'Forklift',
  'wheel-loader': 'Wheel loader',
};

function openEventsFact(list: OpEvent[]) {
  const open = list.filter((e) => e.status !== 'resolved');
  if (!open.length) return { label: 'Open events', value: 'None' };
  let worst: AlertSeverity = 'info';
  for (const e of open) if (SEV_RANK[e.severity] > SEV_RANK[worst]) worst = e.severity;
  return { label: 'Open events', value: `${open.length} unresolved · highest ${worst}` };
}

function equipmentCard(s: SimState, id: string): SelectionCardModel | null {
  const eq = EQUIPMENT_BY_ID[id];
  if (!eq) return null;
  const now = s.minute;
  const stageId = assetStage(id);
  const zone = ZONE_BY_ID[eq.zone];
  const subtitle = `${id} · ${stageId ? stageName(stageId) : zone ? zone.name : `Zone ${eq.zone}`}`;
  const facts: SelectionCardModel['facts'] = [];
  const m = s.machines[id];
  let status: CardStatus = null;
  if (m) {
    const op = operationalState(s, id);
    status = { kind: 'op', op };
    const f = s.feeds[id];
    if (op === 'unknown' && f?.status === 'stale') facts.push({ label: 'Data feed', value: `Stale since ${formatClock(f.since)} — values frozen` });
    else if (op === 'stopped' || op === 'fault' || op === 'planned') {
      const d = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
      const reason = d ? REASON_BY_CODE[d.reasonCode]?.label : undefined;
      facts.push({ label: reason ? 'Reason' : 'Since', value: reason ? `${reason} · since ${formatClock(d!.start)}` : formatClock(m.since) });
    } else if (op === 'running' || op === 'reduced') {
      const design = CONVEYOR_BY_ID[id]?.capacityPerHour ?? OPS_BY_ID[id]?.idealRatePerHour ?? null;
      facts.push({
        label: 'Rate now',
        value: `${int(m.ratePerHour)} tiles/h${design ? ` · ${pct(m.ratePerHour / design)} of ${CONVEYOR_BY_ID[id] ? 'capacity' : 'design rate'}` : ''}`,
      });
    } else facts.push({ label: 'Since', value: `${formatClock(m.since)} · ${formatDuration(now - m.since)}` });
  } else facts.push({ label: 'Area', value: eq.stage, hint: 'No state signal is modelled for this asset' });
  facts.push(openEventsFact(s.events.filter((e) => e.asset.equipmentId === id)));
  const f = s.feeds[id];
  const stale = m && f?.status === 'stale' ? { since: f.since, note: `Data feed stale since ${formatClock(f.since)}: state unknown, counters frozen at the last value received.` } : null;
  return { kind: 'equipment', id, title: eq.name, subtitle, status, facts, stageId, stale };
}

function vehicleCard(s: SimState, id: string): SelectionCardModel | null {
  const v: Vehicle | undefined = s.logistics.vehicles[id];
  if (!v) return null;
  const now = s.minute;
  const gone = v.despawned != null && v.despawned <= now;
  const leg = [...v.legs].reverse().find((l) => l.start <= now) ?? v.legs[0];
  const place = GEOFENCES.find((g) => g.id === leg?.zone)?.name ?? null;
  const facts: SelectionCardModel['facts'] = [];
  let status: CardStatus;
  if (gone) status = { kind: 'text', label: 'Left the site', tone: 'neutral' };
  else if (v.class === 'external') {
    const phase = v.visit && v.visit.gateIn > now ? 'approaching' : (v.phase ?? 'approaching');
    status = { kind: 'text', label: phaseLabel[phase], tone: phase === 'waiting' ? 'warning' : phase === 'loading' || phase === 'unloading' ? 'good' : 'neutral' };
  } else {
    const act = leg?.activity ?? v.task ?? 'Idle';
    status = { kind: 'text', label: act, tone: /idle|waiting|available/i.test(act) ? 'neutral' : 'good' };
  }
  if (v.class === 'external' && v.visit) {
    const vis = v.visit;
    if (vis.gateIn <= now) facts.push({ label: 'On site', value: formatDuration((vis.gateOut ?? now) - vis.gateIn) });
    const dock = vis.dockId ? DOCKS.find((d) => d.id === vis.dockId)?.name : null;
    facts.push(dock ? { label: 'Dock', value: dock } : { label: 'Location', value: place ?? '—', hint: 'Simulated position (zone level)' });
  } else if (!gone) {
    const a = internalActivity(v, now);
    facts.push({ label: 'Location', value: place ?? '—', hint: 'Simulated position (zone level) — no tracking system is connected' });
    facts.push({ label: 'At this stop', value: a.moving ? 'Moving' : a.stationaryMin != null && a.stationaryMin < 1 ? 'Just stopped' : formatDuration(a.stationaryMin) });
  }
  return { kind: 'vehicle', id, title: v.label, subtitle: `${VEHICLE_TYPE[v.type]} · ${v.operator}`, status, facts: facts.slice(0, 2), stageId: null };
}

function stageCard(st: FlowStage): SelectionCardModel {
  // The flow strip's figure — with a stale counting point the simulation's running count, marked not
  // confirmed (the same number and mark as the strip and the KPI cards).
  const out = st.output == null ? '—' : `${int(st.output)} ${st.unit}${st.tileEquivalent ? ' (tile-equivalent)' : ''}${st.stale ? ' · not confirmed' : ''}`;
  return {
    kind: 'stage',
    id: st.id,
    title: st.name,
    subtitle: `Production stage${st.constraint ? ` · ${st.constraint.label.toLowerCase()}` : ''}`,
    status: st.status ? { kind: 'op', op: st.status } : { kind: 'text', label: 'No state signal', tone: 'neutral' },
    facts: [
      { label: st.id === LINE.outputStage ? 'Good output this shift' : 'Output this shift', value: out, hint: st.stale ? `${st.outputLabel}. ${st.stale.note}` : st.outputLabel },
      { label: 'Open events', value: st.alerts.count ? `${st.alerts.count} unresolved · highest ${st.alerts.worst}` : 'None' },
    ],
    stageId: st.id,
    stale: st.stale ? { since: st.stale.since, note: st.stale.note, label: st.stale.label } : null,
  };
}

/**
 * The one card the embedded model shows for the twin selection: the selected equipment or vehicle,
 * otherwise the highlighted stage. Null when nothing is selected.
 */
export function selectionCard(s: SimState, sel: TwinSelection, p: Period, stages?: FlowStage[]): SelectionCardModel | null {
  if (sel.selected) return equipmentCard(s, sel.selected);
  if (sel.vehicle) return vehicleCard(s, sel.vehicle);
  if (sel.stage) {
    const st = (stages ?? flowStages(s, p)).find((x) => x.id === sel.stage);
    return st ? stageCard(st) : null;
  }
  return null;
}
