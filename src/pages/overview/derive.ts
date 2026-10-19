/**
 * Overview derivations — pure functions over the one simulation state:
 *  - the issues requiring attention (attentionEvents) shaped as what / where / when / impact /
 *    next step, the impact read from the event report model (eventImpact) and labelled as an
 *    estimate where it is one;
 *  - the compact selection card of the embedded 3D model (equipment, vehicle or stage).
 * Nothing here creates an incident or a value the simulation does not hold. An equipment-condition
 * issue shows the measured condition only (reading vs its limit, and for how long) — never a health
 * score or a projected time to trip. Slip / powder flows are shown in t/h from the simulated mass-flow
 * signals (or the disclosed tile-equivalent conversion), never in tiles/h; silo and tank levels in %
 * only (no mass without a level-to-mass calibration).
 */
import { tilesToMassT } from '../../calc';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { KG_PER_TILE, catalogFor, definitionOf, stageOfEquipment } from '../../model/catalog';
import { CONVEYOR_BY_ID, DOCKS, GEOFENCES, INSPECTION_STATIONS, LINE, OPS_BY_ID, REASON_BY_CODE } from '../../model/plant';
import type { TelemetrySample } from '../../model/telemetry';
import type { AlertSeverity, MonitoredStageId, OpEvent, OperationalState, Vehicle, VehicleType } from '../../model/types';
import { attentionEvents } from '../../intel/kpis';
import { eventImpact } from '../../intel/report';
import { findDowntime, type SimState } from '../../sim/engine';
import { assess, HEALTH_BY_ID } from '../../sim/health';
import { phaseLabel } from '../../sim/logistics';
import { internalActivity, operationalState, type Period } from '../../sim/metrics';
import { readSignal, seriesOf } from '../../sim/telemetry';
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
  gap: 'Data gap',
} as const;

// ── Measured equipment condition (no health score, no projection) ─────────────

/** Condition signals of a condition-monitored asset, in the order they are reported. */
const CONDITION_SIGNALS = [
  { name: 'vibration', label: 'Vibration', digits: 1 },
  { name: 'temperature', label: 'Bearing / oil temperature', digits: 0 },
  { name: 'motor_current', label: 'Motor current', digits: 0 },
] as const;

/** Minutes of history searched back for the start of an exceedance (the minute history, 8 h). */
const CONDITION_LOOKBACK_MIN = 480;

type ConditionLevel = 'alarm' | 'warning' | 'rated';
const LEVEL_RANK: Record<ConditionLevel, number> = { rated: 1, warning: 2, alarm: 3 };
const LEVEL_WORD: Record<ConditionLevel, string> = { alarm: 'alarm', warning: 'warning', rated: 'rated' };

/** Why a reading cannot be used as a current value (null when it can). */
export function readingProblem(r: TelemetrySample): string | null {
  if (r.quality === 'stale') return r.timestamp != null ? `reading stale since ${formatClock(r.timestamp + 1)}` : 'reading stale';
  if (r.quality === 'bad') return 'reading flagged bad — not used';
  if (r.quality === 'missing' || typeof r.value !== 'number') return 'no reading';
  return null;
}

/** Consecutive minutes (ending now) a signal's minute history has been above `limit`; `whole` = the full look-back. */
function minutesAbove(s: SimState, signalId: string, limit: number): { minutes: number; whole: boolean } | null {
  const to = s.minute;
  const from = Math.max(0, to - CONDITION_LOOKBACK_MIN);
  const ser = seriesOf(s, signalId, { from, to, stepMin: 1 });
  if (!ser || !ser.v.length) return null;
  let n = 0;
  for (let i = ser.v.length - 1; i >= 0; i--) {
    const v = ser.v[i];
    if (v == null || v <= limit) break;
    n++;
  }
  return { minutes: n, whole: n === ser.v.length && from > 0 };
}

/**
 * The measured condition of a condition-monitored asset in one line, from its simulated condition signals
 * (telemetry) against the catalogue limits: the reading most beyond its limit and for how long it has been
 * beyond it ("Vibration 7.1 mm/s RMS, above alarm 6.3 for 25 min"). Within all limits it states the reading
 * with its limits and how it compares with the level expected at the current load (what the condition rule
 * flagged). A stale, bad or missing reading says so. Never a health score, a trend projection or a time to trip.
 */
export function conditionLine(s: SimState, equipmentId: string): ImpactLine | null {
  const basis = 'Simulated condition signals (telemetry) against the catalogue limits — a measured condition, not a failure prediction';
  type Reading = { label: string; value: number; unit: string; digits: number; signalId: string; level: ConditionLevel | null; limit: number | null };
  const readings: Reading[] = [];
  let primaryProblem: string | null = null;
  for (const c of CONDITION_SIGNALS) {
    const signalId = `${equipmentId}.${c.name}`;
    const def = definitionOf(signalId);
    if (!def || def.availabilityStatus !== 'simulated') continue;
    const r = readSignal(s, signalId);
    const problem = readingProblem(r);
    if (problem) {
      if (c.name === 'vibration') primaryProblem = `${c.label} ${problem}`;
      continue;
    }
    const value = r.value as number;
    const rated = typeof def.metadata?.ratedCurrentA === 'number' ? def.metadata.ratedCurrentA : null;
    let level: ConditionLevel | null = null;
    let limit: number | null = null;
    if (def.alarmHigh != null && value >= def.alarmHigh) [level, limit] = ['alarm', def.alarmHigh];
    else if (def.warningHigh != null && value >= def.warningHigh) [level, limit] = ['warning', def.warningHigh];
    else if (rated != null && value > rated) [level, limit] = ['rated', rated];
    readings.push({ label: c.label, value, unit: r.unit ?? def.unit ?? '', digits: c.digits, signalId, level, limit });
  }
  if (!readings.length) return primaryProblem ? { text: `Condition not confirmed — ${primaryProblem}`, estimate: false, basis } : null;
  const fmt = (x: number, d: number) => x.toFixed(d);
  const worst = readings.filter((x) => x.level).sort((a, b) => LEVEL_RANK[b.level!] - LEVEL_RANK[a.level!])[0];
  if (worst) {
    const run = minutesAbove(s, worst.signalId, worst.limit!);
    const span = !run || run.minutes < 1 ? ' (this minute)' : run.whole ? ` for ${formatDuration(run.minutes)} or more` : ` for ${formatDuration(run.minutes)}`;
    return {
      text: `${worst.label} ${fmt(worst.value, worst.digits)} ${worst.unit}, above ${LEVEL_WORD[worst.level!]} ${fmt(worst.limit!, worst.digits === 0 ? 0 : 1)}${span}`,
      estimate: false,
      basis,
    };
  }
  // Within its limits: the reading, its limits and the comparison with the level expected at load.
  const vib = readings.find((x) => x.signalId.endsWith('.vibration')) ?? readings[0];
  const def = definitionOf(vib.signalId)!;
  const limits = [def.warningHigh != null ? `warning ${fmt(def.warningHigh, 1)}` : null, def.alarmHigh != null ? `alarm ${fmt(def.alarmHigh, 1)}` : null].filter(Boolean).join(', ');
  const ratio = HEALTH_BY_ID[equipmentId] && vib.signalId.endsWith('.vibration') ? assess(s, equipmentId).vibrationRatio : null;
  return {
    text: `${vib.label} ${fmt(vib.value, vib.digits)} ${vib.unit}${limits ? ` (${limits})` : ''}${ratio != null && ratio >= 1.05 ? ` · ${ratio.toFixed(1)}× the level expected at this load` : ''}`,
    estimate: false,
    basis,
  };
}

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
      // The measured condition only — the report's health score and trend extrapolation stay out of the Overview.
      const cond = ev.asset.equipmentId ? conditionLine(s, ev.asset.equipmentId) : null;
      if (cond) return cond;
      const r = imp.rows.find((x) => !/duration|health|trip|fails/i.test(x.label));
      return r ? { text: `${r.label}: ${r.value}`, estimate: false, basis: r.basis } : { text: 'Condition not assessed for this event', estimate: false, basis: '' };
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
  /** A visible disclosure under the facts (e.g. a simulated unit conversion behind a t/h figure). */
  note?: string;
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

/** Disclosure of the simulated tile-equivalent → mass conversion behind every stage 1–2 t/h figure. */
export const MASS_FLOW_NOTE = `t/h is a simulated conversion: tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg per tile (assumed dry-body mass) — a real line needs a weigher or flow meter.`;
/** Silo / tank level: a percentage, never a mass. */
export const LEVEL_NOTE = 'Level in % only — no level-to-mass calibration is configured, so no mass is shown.';

/** Stages 1–2 (slip and powder): their flows are mass flows, never tiles. */
const isMaterialStage = (id: string) => {
  const no = stageOfEquipment(id);
  return no === 1 || no === 2;
};

/** A reading as a card value (with its unit), or why it is not shown as current. */
function readingValue(r: TelemetrySample, unit: string, digits: number): string {
  if (r.quality === 'stale' && typeof r.value === 'number')
    return `Last ${r.value.toFixed(digits)} ${unit}${r.timestamp != null ? ` at ${formatClock(r.timestamp)}` : ''} — not current`;
  const problem = readingProblem(r);
  if (problem) return problem.charAt(0).toUpperCase() + problem.slice(1);
  return `${(r.value as number).toFixed(digits)} ${unit}`;
}

/**
 * Output rate of a running slip / powder asset (stages 1–2) in t/h: the simulated mass-flow signal where the
 * catalogue has one (C-BMn.slip_flow, D-TWR.powder_flow), else the tile-equivalent rate converted with the same
 * disclosed factor (D-BELT). Never tiles/h.
 */
function massFlowFact(s: SimState, id: string, ratePerHour: number, design: number | null): SelectionCardModel['facts'][number] {
  const share = design ? ` · ${pct(ratePerHour / design)} of ${CONVEYOR_BY_ID[id] ? 'capacity' : 'design rate'}` : '';
  const sig = catalogFor(id).find((d) => d.unit === 't/h' && d.availabilityStatus === 'simulated');
  if (sig) {
    const r = readSignal(s, sig.signalId);
    const label = sig.signalId.endsWith('.powder_flow') ? 'Powder output now' : sig.signalId.endsWith('.slip_flow') ? 'Slip output now' : 'Output now';
    return { label, value: `${readingValue(r, 't/h', 1)}${readingProblem(r) == null ? share : ''}`, hint: `${sig.signalId} · ${sig.name} (simulated)` };
  }
  const t = tilesToMassT(ratePerHour, KG_PER_TILE);
  return {
    label: CONVEYOR_BY_ID[id] ? 'Powder transport now' : 'Material flow now',
    value: t.status === 'ok' ? `${t.value.toFixed(1)} t/h${share}` : t.reason,
    hint: 'Tile-equivalent transport rate converted to mass (simulated)',
  };
}

/** Level of an asset that holds a buffer (silo, tank, tile storage), as its simulated % reading. */
function levelFact(s: SimState, id: string): SelectionCardModel['facts'][number] | null {
  const def = definitionOf(`${id}.level`);
  if (!def || def.availabilityStatus !== 'simulated') return null;
  return { label: 'Level now', value: readingValue(readSignal(s, def.signalId), '%', 0), hint: `${def.signalId} · ${def.name} (simulated)` };
}

function equipmentCard(s: SimState, id: string): SelectionCardModel | null {
  const eq = EQUIPMENT_BY_ID[id];
  if (!eq) return null;
  const now = s.minute;
  const stageId = assetStage(id);
  const zone = ZONE_BY_ID[eq.zone];
  const subtitle = `${id} · ${stageId ? stageName(stageId) : zone ? zone.name : `Zone ${eq.zone}`}`;
  const facts: SelectionCardModel['facts'] = [];
  let note: string | undefined;
  const m = s.machines[id];
  let status: CardStatus = null;
  if (m) {
    const op = operationalState(s, id);
    status = { kind: 'op', op };
    const f = s.feeds[id];
    if (op === 'unknown' && f?.status === 'stale') facts.push({ label: 'Data feed', value: `Stale since ${formatClock(f.since)} — values frozen` });
    else if (op === 'stopped' || op === 'fault' || op === 'planned' || op === 'changeover') {
      const d = m.activeDowntimeId ? findDowntime(s, m.activeDowntimeId) : undefined;
      const reason = d ? REASON_BY_CODE[d.reasonCode]?.label : undefined;
      facts.push({ label: reason ? 'Reason' : 'Since', value: reason ? `${reason} · since ${formatClock(d!.start)}` : formatClock(m.since) });
    } else if (op === 'running' || op === 'reduced') {
      const design = CONVEYOR_BY_ID[id]?.capacityPerHour ?? OPS_BY_ID[id]?.idealRatePerHour ?? null;
      if (isMaterialStage(id)) {
        // Slip / powder: a mass flow (simulated, disclosed), never tiles/h.
        facts.push(massFlowFact(s, id, m.ratePerHour, design));
        note = MASS_FLOW_NOTE;
      } else
        facts.push({
          label: 'Rate now',
          value: `${int(m.ratePerHour)} tiles/h${design ? ` · ${pct(m.ratePerHour / design)} of ${CONVEYOR_BY_ID[id] ? 'capacity' : 'design rate'}` : ''}`,
        });
    } else facts.push({ label: 'Since', value: `${formatClock(m.since)} · ${formatDuration(now - m.since)}` });
  } else {
    // No state signal: a silo, tank or tile store shows its level (%, simulated) instead.
    const level = levelFact(s, id);
    if (level) {
      facts.push(level);
      if (isMaterialStage(id)) note = LEVEL_NOTE;
    } else facts.push({ label: 'Area', value: eq.stage, hint: 'No state signal is modelled for this asset' });
  }
  facts.push(openEventsFact(s.events.filter((e) => e.asset.equipmentId === id)));
  const f = s.feeds[id];
  const stale = m && f?.status === 'stale' ? { since: f.since, note: `Data feed stale since ${formatClock(f.since)}: state unknown, counters frozen at the last value received.` } : null;
  return { kind: 'equipment', id, title: eq.name, subtitle, status, facts, ...(note ? { note } : {}), stageId, stale };
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
