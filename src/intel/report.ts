/**
 * Event report model — the single source for the in-app report, the PDF export and the copilot's
 * event investigation. Everything here is derived from one OpEvent record, its evidence and the
 * shared simulation state; nothing is invented. Missing evidence is listed as missing.
 *
 * Impact avoids double counting: line output is lost only while the kiln (line constraint) is held
 * up, and a consequence event (e.g. kiln starved because a conveyor stopped) reports its loss under
 * the root event instead of adding it again.
 */
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { CAMERA_BY_ID, CONVEYOR_BY_ID, DEFECTS, GEOFENCES, INSPECTION_STATIONS, M2_PER_TILE, MONITORED_STAGE_BY_ID, STAGE_BY_ID, cameraFor } from '../model/plant';
import type { EventValue, Evidence, OpEvent } from '../model/types';
import type { SimState } from '../sim/engine';
import { CONSUMER_BY_ID, DEFAULT_TARIFFS, type Tariffs } from '../sim/energy';
import {
  EVENT_CATEGORY_LABEL,
  EVENT_RULE_DEFS,
  EVENT_STATUS_LABEL,
  EVENT_TYPE_LABEL,
  eventById,
  evidenceOf,
} from '../sim/events';
import { DEFAULT_FINANCE, assumptionList, lostOutputValue, rejectCost, waitingCost, type Estimate, type FinanceAssumptions } from '../sim/finance';
import { HEALTH_BY_ID, assess } from '../sim/health';
import { energyIn, lineMetrics, qualityIn, resolvePeriod } from '../sim/metrics';
import { formatClock, formatDateTime, formatDuration, shiftAt, toIso } from '../sim/time';

export type ImpactRow = { label: string; value: string; basis: string };
export type EventImpact = { rows: ImpactRow[]; estimate: Estimate | null; notes: string[] };

const fmtN = (v: number, d = 0) => v.toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d });
const m2 = (tiles: number) => tiles * M2_PER_TILE;

/** First-pass yield over the 24 h before a minute (to convert kiln tiles into good tiles). */
export function fpyBefore(s: SimState, t: number) {
  const q = qualityIn(s, { from: Math.max(0, t - 1440), to: Math.max(1, t), label: '' });
  return q.inspected > 0 ? 1 - q.rejected / q.inspected : 0.976;
}

/**
 * Line good output (tiles) an event has cost: the kiln tiles it held up × the first-pass yield of
 * the 24 h before the event. The one figure the report, the insights and the monitoring views show.
 */
export const lineGoodLostTiles = (s: SimState, ev: OpEvent) => ev.acc.constraintLostTiles * fpyBefore(s, ev.start);

/** Impact of one event, from its accumulated quantities and the shared state. */
export function eventImpact(s: SimState, ev: OpEvent, finance: FinanceAssumptions = DEFAULT_FINANCE, tariffs: Tariffs = DEFAULT_TARIFFS): EventImpact {
  const rows: ImpactRow[] = [];
  const notes: string[] = [];
  const end = ev.end ?? s.minute;
  const dur = Math.max(0, end - ev.start);
  rows.push({ label: ev.end == null ? 'Duration so far' : 'Final duration', value: formatDuration(dur), basis: `${formatClock(ev.start)} → ${ev.end == null ? `now (${formatClock(s.minute)})` : formatClock(ev.end)}` });
  const lines: Estimate['lines'] = [];
  const missing: string[] = [];
  const limitations: string[] = ['Simulated data — the figures illustrate the method, they are not plant results.'];
  const root = ev.consequenceOf ? eventById(s, ev.consequenceOf) : undefined;

  if (ev.category === 'production') {
    const a = ev.acc;
    if (a.assetLostTiles > 0.5)
      rows.push({
        label: CONVEYOR_BY_ID[ev.asset.equipmentId ?? ''] ? 'Tiles not transported' : 'Output not made at the asset',
        value: `${fmtN(a.assetLostTiles)} tiles (${fmtN(m2(a.assetLostTiles), 1)} m²)`,
        basis: 'Typical rate × active minutes − actual output (per minute)',
      });
    const fpy = fpyBefore(s, ev.start);
    const lineGoodTiles = lineGoodLostTiles(s, ev);
    rows.push({
      label: 'Kiln (line constraint) held up or slowed by this event',
      value: `${fmtN(a.constraintMin)} min`,
      basis:
        ev.asset.equipmentId === 'H-KILN'
          ? 'Minutes the kiln was down, starved, blocked or running below its typical rate during this condition (observed)'
          : 'Minutes the kiln was down, starved, blocked or running below its typical rate, attributed to this event (inferred from states and buffers)',
    });
    if (a.constraintMin === 0) {
      notes.push(
        ev.end == null
          ? 'No line output lost so far — buffers between this asset and the kiln are absorbing it.'
          : 'No line output was lost — buffers absorbed the event; the asset-level loss may have been recovered later.',
      );
    }
    rows.push({
      label: 'Line good output lost',
      value: `${fmtN(m2(lineGoodTiles), 1)} m²`,
      basis: `${fmtN(a.constraintLostTiles)} kiln tiles vs its typical ${fmtN(a.kilnTypicalRate * 60)} tiles/h × first-pass yield ${(fpy * 100).toFixed(1)} %`,
    });
    if (root) {
      notes.push(`Consequence of ${root.id} (${root.title}) — its line loss is counted there, not added again here.`);
    } else if (lineGoodTiles > 0) {
      lines.push(lostOutputValue(finance, lineGoodTiles));
    }
    if (ev.asset.equipmentId === 'H-KILN' && a.constraintMin > 0 && !root && ev.type !== 'below-rate') {
      const c = CONSUMER_BY_ID['H-KILN'];
      const kw = ((c.thermal?.[0] ?? 0) + c.elec[0]) * (c.stoppedFactor ?? 1);
      const kwh = (kw * a.constraintMin) / 60;
      const cost = (((c.thermal?.[0] ?? 0) * (c.stoppedFactor ?? 1) * tariffs.gas + c.elec[0] * (c.stoppedFactor ?? 1) * tariffs.electricity) * a.constraintMin) / 60;
      rows.push({ label: 'Kiln energy without output', value: `${fmtN(kwh)} kWh`, basis: 'Idle burn of the illustrative energy model while the kiln was not firing tiles' });
      lines.push({ label: 'Energy burnt without output', amount: cost, basis: `${fmtN(kwh)} kWh at the configured gas / electricity tariffs` });
    }
    limitations.push('Line loss is valued only while the kiln was held up; time lost elsewhere is recoverable while buffers cover it.');
  } else if (ev.category === 'quality') {
    // Counts accumulated per minute over the event window (backfilled from the condition start at
    // detection): a cleared event's figures are final, whenever the report is built.
    const a = ev.acc;
    const ref = a.referenceRejectRate;
    const inspected = a.inspected;
    const rejects = a.rejects;
    rows.push({ label: 'Inspected in the event window', value: `${fmtN(inspected)} tiles`, basis: 'Gauge + vision counters, per minute' });
    rows.push({ label: ev.refs.defect ? `Rejected — ${DEFECTS[ev.refs.defect].label}` : 'Rejected', value: `${fmtN(rejects)} tiles`, basis: 'Reject counters in the window' });
    if (ref != null && inspected > 0) {
      const excess = Math.max(0, rejects - inspected * ref);
      rows.push({
        label: 'Rate vs 24 h reference',
        value: `${((rejects / inspected) * 100).toFixed(2)} % vs ${(ref * 100).toFixed(2)} %`,
        basis: `Reference = ${ev.refs.defect ? `${DEFECTS[ev.refs.defect].label.toLowerCase()} rate` : 'reject rate'} over the 24 h ending 2 h before detection (the detection rules' reference)`,
      });
      rows.push({ label: 'Excess rejects', value: `${fmtN(excess)} tiles (${fmtN(m2(excess), 1)} m²)`, basis: 'Rejects above the reference rate for the tiles inspected' });
      rows.push({ label: 'Effect on quality rate', value: `−${((excess / inspected) * 100).toFixed(2)} pts`, basis: 'Excess rejects ÷ inspected — lowers line OEE by about the same share' });
      lines.push(...rejectCost(finance, excess));
    } else missing.push('No reference reject rate for the 24 h before detection.');
    if (!ev.causes.some((c) => c.confidence === 'confirmed')) limitations.push('Root cause not confirmed — the suspected causes are hypotheses to check.');
  } else if (ev.category === 'logistics') {
    if (ev.type === 'truck-waiting' || ev.type === 'dock-overstay' || ev.type === 'turnaround-exceeded') {
      // The threshold the event was detected with (rules can be changed afterwards).
      const th = ev.trigger.threshold;
      rows.push({ label: 'Minutes beyond the threshold', value: `${fmtN(ev.acc.waitMin)} min`, basis: `Counted from detection (threshold ${th ? `${th.value}${th.unit ? ` ${th.unit}` : ''}` : '—'})` });
      if (ev.type === 'truck-waiting') lines.push(waitingCost(finance, ev.acc.waitMin));
      else if (ev.type === 'dock-overstay') notes.push('The dock was unavailable to other trucks for this time; any resulting waiting is costed on those trucks’ waiting events.');
      else notes.push('Turnaround is reported for service-level tracking; its waiting part is costed on the waiting event.');
    }
    if (ev.type === 'yard-congestion') rows.push({ label: 'Trucks waiting at detection', value: String(ev.trigger.observed[0]?.value ?? '—'), basis: 'Queue length' });
    if (ev.type === 'restricted-entry') {
      rows.push({ label: 'Safety exposure', value: 'Vehicle inside a no-entry zone', basis: 'Geofence rule on simulated positions' });
      missing.push('No cost model for safety events; no pedestrian-proximity sensing to assess near-misses.');
    }
    limitations.push('Vehicle positions are simulated — no GPS, indoor positioning or camera analytics is connected.');
  } else if (ev.category === 'energy') {
    const id = ev.asset.equipmentId!;
    const p = { from: ev.start, to: Math.min(end, s.minute), label: '' };
    const row = energyIn(s, p, tariffs).rows.find((r) => r.id === id);
    if (row) {
      const excess = row.total - row.expected;
      rows.push({ label: 'Energy vs model', value: `${fmtN(row.total)} vs ${fmtN(row.expected)} kWh`, basis: 'Hourly buckets of the illustrative energy model in the event window' });
      rows.push({ label: 'Excess energy', value: `${fmtN(Math.max(0, excess))} kWh`, basis: 'Actual − model' });
      lines.push({ label: 'Excess energy cost', amount: Math.max(0, row.cost - row.expectedCost), basis: `At the configured tariffs (${tariffs.currency})` });
      rows.push({ label: 'Excess CO₂e', value: `${fmtN(Math.max(0, excess) * (CONSUMER_BY_ID[id]?.thermal ? tariffs.co2Gas : tariffs.co2Electricity))} kg`, basis: 'Configured emission factor' });
    }
    limitations.push('Illustrative energy model; tariffs and emission factors are assumptions.');
  } else if (ev.category === 'equipment') {
    const a = ev.asset.equipmentId ? HEALTH_BY_ID[ev.asset.equipmentId] : undefined;
    if (a) {
      const h = assess(s, a.id);
      rows.push({ label: 'Health now', value: h.level === 'offline' ? 'Not assessed (not running)' : `${h.score}/100 · ${h.level}`, basis: 'Rule-based assessment of simulated signals' });
      if (h.etaTripH != null) rows.push({ label: 'Projected time to trip', value: `${h.etaTripH.toFixed(1)} h`, basis: 'Linear extrapolation of the 3-h vibration trend' });
      rows.push({ label: 'Downtime if it fails', value: `${(a.repair[0] / 60).toFixed(1)}–${(a.repair[1] / 60).toFixed(1)} h`, basis: `Typical repair time of a ${a.component} failure (illustrative)` });
      missing.push('Whether a failure would cost line output depends on the buffers at the time — not estimated in advance.');
    }
  } else if (ev.category === 'data') {
    rows.push({ label: 'Data gap', value: formatDuration(dur), basis: 'Time without updates from the asset' });
    notes.push('Line output is still counted at sorting; the asset’s own counters and OEE are incomplete for the gap.');
  }

  const estimate: Estimate | null = lines.length
    ? {
        currency: finance.currency,
        total: lines.reduce((x, l) => x + l.amount, 0),
        lines,
        assumptions: assumptionList(finance),
        missing,
        limitations,
      }
    : missing.length || limitations.length
      ? { currency: finance.currency, total: 0, lines: [], assumptions: assumptionList(finance), missing, limitations }
      : null;
  return { rows, estimate, notes };
}

// ── Report model ──────────────────────────────────────────────────────────────

export type ReportAsset = { kind: string; id: string; name: string; stage: string | null; zone: string | null; camera: string | null };
export type ReportEvidence = Evidence & { originLabel: string };

export type EventReport = {
  generatedAt: string;
  generatedAtPlant: string;
  event: OpEvent;
  summary: {
    id: string;
    title: string;
    text: string;
    type: string;
    category: string;
    severity: string;
    status: string;
    condition: 'Active' | 'Cleared';
    start: string;
    end: string | null;
    duration: string;
    source: 'Simulation' | 'Scenario';
    historical: boolean;
  };
  asset: ReportAsset;
  detection: { kind: string; rule: string; ruleLabel: string; description: string; signalId: string | null; observed: EventValue[]; threshold: EventValue | null };
  visualEvidence: ReportEvidence[];
  supportingEvidence: ReportEvidence[];
  context: { shift: string; atDetection: EventValue[]; related: { id: string; title: string; relation: string; status: string }[]; lineNow: EventValue[] };
  impact: EventImpact;
  diagnosis: { facts: string[]; causes: OpEvent['causes']; uncertainty: string[] };
  recommendations: string[];
  resolution: { status: string; owner: string | null; notes: OpEvent['notes']; resolution: OpEvent['resolution']; history: OpEvent['history']; reports: OpEvent['reports'] };
  provenance: {
    origin: string;
    sources: string[];
    unavailable: { title: string; reason: string }[];
    disclaimers: string[];
    /** The camera evidence includes a frame grabbed from a configured camera stream (not a twin render). */
    liveCamera: boolean;
  };
};

const TRIGGER_KIND: Record<OpEvent['trigger']['kind'], string> = {
  signal: 'Signal (simulated PLC)',
  rule: 'Rule on simulated data',
  model: 'Classification (simulated — no vision model)',
  scenario: 'Scenario input (simulation)',
};

const ORIGIN_LABEL: Record<Evidence['provenance']['origin'], string> = {
  simulation: 'Simulated',
  scenario: 'Simulated (scenario)',
  'digital-twin-render': 'Digital-twin render (simulated view)',
  'live-camera': 'Live camera',
  user: 'User',
};

function assetOf(ev: OpEvent): ReportAsset {
  const a = ev.asset;
  const stage = a.stage ? (MONITORED_STAGE_BY_ID[a.stage]?.name ?? STAGE_BY_ID[a.stage as keyof typeof STAGE_BY_ID]?.name ?? a.stage) : null;
  const camera = cameraFor(a.equipmentId) ?? cameraFor(a.geofenceId);
  if (a.vehicleId) return { kind: 'Vehicle', id: a.vehicleId, name: a.vehicleId, stage: null, zone: a.zone ?? null, camera: camera?.id ?? null };
  if (a.stationId) {
    const st = INSPECTION_STATIONS.find((x) => x.id === a.stationId);
    return { kind: 'Inspection station', id: a.stationId, name: st?.name ?? a.stationId, stage, zone: a.zone ?? null, camera: camera?.id ?? null };
  }
  if (a.equipmentId && CONVEYOR_BY_ID[a.equipmentId]) return { kind: 'Conveyor', id: a.equipmentId, name: CONVEYOR_BY_ID[a.equipmentId].name, stage, zone: a.zone ?? null, camera: camera?.id ?? null };
  if (ev.category === 'energy' && a.equipmentId) return { kind: 'Energy consumer', id: a.equipmentId, name: CONSUMER_BY_ID[a.equipmentId]?.label ?? a.equipmentId, stage, zone: a.zone ?? null, camera: camera?.id ?? null };
  if (a.equipmentId) return { kind: 'Machine', id: a.equipmentId, name: EQUIPMENT_BY_ID[a.equipmentId]?.name ?? a.equipmentId, stage, zone: a.zone ?? null, camera: camera?.id ?? null };
  if (a.geofenceId) {
    const g = GEOFENCES.find((x) => x.id === a.geofenceId);
    return { kind: 'Zone', id: a.geofenceId, name: g?.name ?? a.geofenceId, stage: null, zone: a.zone ?? null, camera: camera?.id ?? null };
  }
  return { kind: 'Plant', id: '—', name: 'Plant', stage, zone: a.zone ?? null, camera: null };
}

/** Builds the full report for one event record (null if the event no longer exists). */
export function buildEventReport(
  s: SimState,
  eventId: string,
  opts: { finance?: FinanceAssumptions; tariffs?: Tariffs; generatedAt?: string } = {},
): EventReport | null {
  const ev = eventById(s, eventId);
  if (!ev) return null;
  const finance = opts.finance ?? DEFAULT_FINANCE;
  const tariffs = opts.tariffs ?? DEFAULT_TARIFFS;
  const evidence = evidenceOf(s, ev).map((x) => ({ ...x, originLabel: ORIGIN_LABEL[x.provenance.origin] }));
  const visual = evidence.filter((x) => x.kind === 'camera-snapshot' || x.kind === 'inspection-image' || x.kind === 'video-ref');
  const supporting = evidence.filter((x) => !visual.includes(x));
  const end = ev.end ?? s.minute;
  const rule = EVENT_RULE_DEFS.find((r) => r.id === ev.trigger.ruleId);
  const ctxMetrics = supporting.find((x) => x.kind === 'metrics')?.metrics ?? [];
  const sh = shiftAt(ev.start);
  const lm = lineMetrics(s, resolvePeriod('shift', s.minute));
  const related = ev.related
    .map((id) => eventById(s, id))
    .filter((x): x is OpEvent => !!x)
    .map((r) => ({
      id: r.id,
      title: r.title,
      relation: ev.consequenceOf === r.id ? 'Cause of this event (inferred)' : r.consequenceOf === ev.id ? 'Consequence of this event' : 'Related',
      status: EVENT_STATUS_LABEL[r.status],
    }));
  const uncertainty: string[] = [];
  if (!ev.causes.some((c) => c.confidence === 'confirmed')) uncertainty.push('No cause is confirmed yet — the suspected causes are inferences from correlated signals and records.');
  if (ev.category === 'quality') uncertainty.push('Classifications are simulated; with a real vision system the model version and per-class accuracy would bound the confidence.');
  if (ev.category === 'logistics') uncertainty.push('Vehicle positions are simulated at zone level; precise location needs a tracking integration.');
  if (visual.some((x) => x.status !== 'available')) uncertainty.push('Some visual evidence is unavailable (see Data provenance).');
  if (ev.category === 'production' && ev.type !== 'conveyor-stop' && ev.trigger.kind === 'signal') uncertainty.push('The alarm code tells what tripped, not why — confirm with the maintenance inspection.');

  const sources = new Set<string>();
  if (ev.trigger.signalId) sources.add(ev.trigger.signalId);
  for (const x of supporting) x.series?.forEach((sr) => sources.add(sr.id));
  const unavailable = evidence.filter((x) => x.status !== 'available').map((x) => ({ title: x.title, reason: x.status === 'pending' ? 'Being captured' : (x.unavailableReason ?? 'Unavailable') }));
  if (!visual.some((x) => x.kind === 'video-ref')) unavailable.push({ title: 'Video segment', reason: 'No video recording (NVR) is integrated — simulated feeds are rendered live, not recorded' });
  // A frame grabbed from a configured camera stream must not be described as a twin render.
  const liveCamera = visual.some((x) => x.kind === 'camera-snapshot' && x.provenance.origin === 'live-camera');

  return {
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    generatedAtPlant: `${formatDateTime(s.minute)} (plant time)`,
    event: ev,
    summary: {
      id: ev.id,
      title: ev.title,
      text: ev.summary,
      type: EVENT_TYPE_LABEL[ev.type],
      category: EVENT_CATEGORY_LABEL[ev.category],
      severity: ev.severity.charAt(0).toUpperCase() + ev.severity.slice(1),
      status: EVENT_STATUS_LABEL[ev.status],
      condition: ev.end == null ? 'Active' : 'Cleared',
      start: `${formatDateTime(ev.start)} (${toIso(ev.start)})`,
      end: ev.end != null ? `${formatDateTime(ev.end)}` : null,
      duration: formatDuration(end - ev.start),
      source: ev.source === 'scenario' ? 'Scenario' : 'Simulation',
      historical: ev.historical,
    },
    asset: assetOf(ev),
    detection: {
      kind: TRIGGER_KIND[ev.trigger.kind],
      rule: ev.trigger.ruleId,
      ruleLabel: rule?.label ?? ev.trigger.ruleId,
      description: ev.trigger.description,
      signalId: ev.trigger.signalId ?? null,
      observed: ev.trigger.observed,
      threshold: ev.trigger.threshold ?? null,
    },
    visualEvidence: visual,
    supportingEvidence: supporting,
    context: {
      shift: sh.label,
      atDetection: ctxMetrics,
      related,
      lineNow: [
        { label: 'Line OEE (shift to date)', value: lm.oee.oee.status === 'ok' ? `${(lm.oee.oee.value! * 100).toFixed(1)} %` : '—' },
        { label: 'Output vs target (shift)', value: `${fmtN(lm.outputM2)} / ${fmtN(lm.targetM2)} m²` },
        { label: 'Plant time now', value: formatDateTime(s.minute) },
      ],
    },
    impact: eventImpact(s, ev, finance, tariffs),
    diagnosis: { facts: ev.facts, causes: ev.causes, uncertainty },
    recommendations: ev.recommendations,
    resolution: { status: EVENT_STATUS_LABEL[ev.status], owner: ev.owner, notes: ev.notes, resolution: ev.resolution, history: ev.history, reports: ev.reports },
    provenance: {
      origin: ev.source === 'scenario' ? 'Simulated — triggered by a demo scenario' : 'Simulated — deterministic simulation of a representative plant',
      sources: [...sources],
      unavailable,
      disclaimers: liveCamera
        ? [
            'wAI Manufacturing Digital Twin — demonstration. No PLC, SCADA, sensor, vehicle tracking or language model is connected.',
            'Camera evidence includes a frame from a configured stream (labelled on the image); other camera views are digital-twin renders. Inspection frames are illustrations of simulated records.',
            'Financial figures are estimates from the stated assumptions, not verified business losses.',
          ]
        : [
            'wAI Manufacturing Digital Twin — demonstration. No PLC, SCADA, camera, sensor, vehicle tracking or language model is connected.',
            'Camera views are rendered from the digital twin and labelled as such; inspection frames are illustrations of simulated records.',
            'Financial figures are estimates from the stated assumptions, not verified business losses.',
          ],
      liveCamera,
    },
  };
}

export const cameraName = (id: string | null) => (id ? (CAMERA_BY_ID[id]?.name ?? id) : '—');
