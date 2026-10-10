/**
 * Shift summary of one monitored stage, as a PDF document model in the same style as the event
 * report. Everything comes from the shared state: stage I/O from its counting points (stageIO),
 * equipment states (operationalState + machine / conveyor metrics for the shift), the stage's events
 * of the shift (the same OpEvent records, by id) and their impact (eventImpact — consequence events
 * report their loss under the root event, so nothing is counted twice).
 */
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { eventImpact } from '../intel/report';
import { CAMERA_BY_ID, CONVEYOR_BY_ID, M2_PER_TILE, MONITORED_STAGE_BY_ID, PROCESS_MACHINES, REASON_BY_CODE } from '../model/plant';
import type { MonitoredStageId, OpEvent, StageId } from '../model/types';
import type { SimState } from '../sim/engine';
import { DEFAULT_TARIFFS, type Tariffs } from '../sim/energy';
import { EVENT_STATUS_LABEL, EVENT_TYPE_LABEL } from '../sim/events';
import { DEFAULT_FINANCE, assumptionList, type FinanceAssumptions } from '../sim/finance';
import { OPERATIONAL_STATE_LABEL, clippedDuration, conveyorMetrics, machineMetrics, operationalState, resolvePeriod, stageIO, type Period } from '../sim/metrics';
import type { Metric } from '../sim/oee';
import { formatDate, formatDateTime, formatDuration, shiftAt } from '../sim/time';
import { LABELS, fmtMoney, plantClock, plantTime, wallClock } from './format';
import { FOOTER_DISCLAIMER, type PdfBlock, type PdfDocModel, type PdfSection } from './model';
import { fileSafe, sanitizeDeep } from './text';

/** Process stages folded into a monitored stage (GLAZE = glazing + decoration, PACK = packing + palletising). */
export const STAGE_PARTS: Record<MonitoredStageId, StageId[]> = {
  PREP: ['PREP'],
  SPRAY: ['SPRAY'],
  PRESS: ['PRESS'],
  DRY: ['DRY'],
  GLAZE: ['GLAZE', 'DECOR'],
  DECOR: ['DECOR'],
  KILN: ['KILN'],
  SORT: ['SORT'],
  PACK: ['PACK', 'PAL'],
  PAL: ['PAL'],
  WH: [],
};

/** Whether an event belongs to a monitored stage (by its stage or by an asset of the stage). */
export function eventInStage(ev: OpEvent, stageId: MonitoredStageId) {
  const st = MONITORED_STAGE_BY_ID[stageId];
  if (!st) return false;
  if (ev.asset.stage && (ev.asset.stage === stageId || STAGE_PARTS[stageId]?.includes(ev.asset.stage as StageId))) return true;
  const id = ev.asset.equipmentId;
  return !!id && (st.equipment.includes(id) || st.conveyors.includes(id));
}

/** Events of a stage overlapping a period, newest first. */
export function stageEvents(s: SimState, stageId: MonitoredStageId, p: Period) {
  return s.events
    .filter((e) => eventInStage(e, stageId) && e.start < p.to && (e.end ?? s.minute) >= p.from)
    .sort((a, b) => b.start - a.start || b.id.localeCompare(a.id));
}

const pct = (m: Metric) => (m.status === 'ok' ? `${(m.value! * 100).toFixed(1)} %` : m.status === 'invalid' ? 'Invalid' : '—');
const n0 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-GB'));
const n1 = (v: number) => v.toLocaleString('en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function stageShiftModel(
  s: SimState,
  stageId: MonitoredStageId,
  opts: { finance?: FinanceAssumptions; tariffs?: Tariffs; generatedAt?: string } = {},
): PdfDocModel | null {
  const st = MONITORED_STAGE_BY_ID[stageId];
  if (!st) return null;
  const finance = opts.finance ?? DEFAULT_FINANCE;
  const tariffs = opts.tariffs ?? DEFAULT_TARIFFS;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const p = resolvePeriod('shift', s.minute);
  const io = stageIO(s, stageId, p);
  const unit = io.unit;
  const hrs = Math.max(1 / 60, (p.to - p.from) / 60);
  const events = stageEvents(s, stageId, p);
  const active = events.filter((e) => e.end == null);
  const sections: PdfSection[] = [];
  let num = 0;
  const sec = (title: string, blocks: PdfBlock[], tag?: string) => sections.push({ num: ++num, title, blocks, tag });

  // 1 Summary
  const expected = io.expectedPerHour != null ? io.expectedPerHour * hrs : null;
  const attainment = expected && io.output != null ? io.output / expected : null;
  sec('Summary', [
    {
      kind: 'kv',
      columns: 4,
      rows: [
        ['Stage', `${st.id} · ${st.name}`],
        ['Process step', String(st.step)],
        ['Zone', st.zone],
        ['Shift', p.label],
        ['Period', `${formatDateTime(p.from)} - ${plantClock(p.to)} (shift to date)`],
        ['Elapsed', formatDuration(p.to - p.from)],
        ['Counting unit', unit],
        ['Cameras', st.cameras.map((c) => `${c} ${CAMERA_BY_ID[c]?.name ?? ''}`.trim()).join(', ') || 'None'],
      ],
    },
    {
      kind: 'text',
      text: `Output ${n0(io.output)} ${unit}${expected != null ? ` vs ${n0(expected)} expected at the ideal rate in planned time (${attainment != null ? `${(attainment * 100).toFixed(1)} %` : '—'})` : ''}. ${events.length} event${events.length === 1 ? '' : 's'} in the shift, ${active.length} with the condition still active.`,
    },
  ]);

  // 2 Stage input / output
  const cpRow = (label: string, cp: typeof st.input | null, qty: number | null): string[] => [
    label,
    cp ? cp.label : '—',
    cp && cp.measured && qty != null ? `${n0(qty)} ${unit}` : 'Not measured',
    cp?.signalId ?? 'No counting point',
    cp?.note ?? '',
  ];
  sec('Stage input / output', [
    {
      kind: 'table',
      head: ['Quantity', 'Counting point', 'Shift to date', 'Signal', 'Note'],
      rows: [
        cpRow('Input', st.input, io.input),
        cpRow('Output', st.output, io.output),
        cpRow('Good', st.good, io.good),
        cpRow('Rejected', st.rejected, io.rejected),
      ],
      widths: [20, 44, 28, 34, 'auto'],
    },
    {
      kind: 'kv',
      columns: 4,
      rows: [
        ['WIP at input', io.wip != null ? `${n0(io.wip)} ${unit}${io.wipCapacity ? ` (${Math.round((io.wip / io.wipCapacity) * 100)} % of ${n0(io.wipCapacity)})` : ''}` : 'Not measured'],
        ['Rate', io.ratePerHour != null ? `${n0(io.ratePerHour)} ${unit}/h` : '—'],
        ['Expected rate', io.expectedPerHour != null ? `${n0(io.expectedPerHour)} ${unit}/h` : 'Not defined for this stage'],
        ['Down / starved / blocked', `${n0(io.downMin)} / ${n0(io.starvedMin)} / ${n0(io.blockedMin)} min`],
      ],
    },
  ]);

  // 3 Equipment states
  const assets = [...st.equipment, ...st.conveyors.filter((c) => !st.equipment.includes(c))];
  sec('Equipment states', [
    {
      kind: 'table',
      head: ['Asset', 'Name', 'State now', 'Since', 'Data feed', 'Shift figures'],
      rows: assets.map((id) => {
        const m = s.machines[id];
        const name = CONVEYOR_BY_ID[id]?.name ?? EQUIPMENT_BY_ID[id]?.name ?? id;
        if (!m) return [id, name, 'Not monitored as a machine', '—', '—', 'Tracked through logistics records'];
        const state = OPERATIONAL_STATE_LABEL[operationalState(s, id)];
        const feed = s.feeds[id]?.status === 'stale' ? `Stale since ${plantClock(s.feeds[id].since)}` : 'Simulated · updating';
        let figures = '—';
        if (CONVEYOR_BY_ID[id]) {
          const c = conveyorMetrics(s, id, p);
          figures = `Running ${c.availability != null ? `${(c.availability * 100).toFixed(1)} %` : '—'} · utilisation ${c.utilisation != null ? `${(c.utilisation * 100).toFixed(1)} %` : '—'} · ${c.stops} stop${c.stops === 1 ? '' : 's'} (${n0(c.downMin)} min)`;
        } else if (PROCESS_MACHINES.includes(id)) {
          const mm = machineMetrics(s, id, p);
          figures = `OEE ${pct(mm.oee.oee)} (A ${pct(mm.oee.availability)} · P ${pct(mm.oee.performance)} · Q ${pct(mm.oee.quality)}) · ${n0(mm.totals.count)} tiles`;
        }
        return [id, name, state, plantClock(m.since), feed, figures];
      }),
      widths: [18, 36, 26, 14, 26, 'auto'],
    },
  ]);

  // 4 Events in the shift
  sec('Events in the shift', [
    {
      kind: 'table',
      head: ['Event', 'Start', 'Type', 'Severity', 'Status', 'Condition', 'Duration', 'Title'],
      rows: events.map((e) => [
        e.id,
        plantClock(e.start),
        EVENT_TYPE_LABEL[e.type],
        e.severity.charAt(0).toUpperCase() + e.severity.slice(1),
        EVENT_STATUS_LABEL[e.status],
        e.end == null ? 'Active' : `Cleared ${plantClock(e.end)}`,
        formatDuration((e.end ?? s.minute) - e.start),
        e.title,
      ]),
      widths: [19, 12, 28, 16, 20, 20, 16, 'auto'],
      empty: 'No events at this stage in the shift',
    },
    { kind: 'text', text: 'Each event id refers to the same record as the in-app event report and its PDF (Events & Reports).', tone: 'muted' },
  ]);

  // 5 Losses
  const downtime = s.downtime.filter((d) => assets.includes(d.equipmentId) && d.start < p.to && (d.end ?? s.minute) > p.from);
  const byReason = new Map<string, { asset: string; reason: string; minutes: number; n: number }>();
  for (const d of downtime) {
    const k = `${d.equipmentId}|${d.reasonCode}`;
    const r = byReason.get(k) ?? { asset: d.equipmentId, reason: REASON_BY_CODE[d.reasonCode]?.label ?? d.reasonCode, minutes: 0, n: 0 };
    r.minutes += clippedDuration(d, p, s.minute);
    r.n++;
    byReason.set(k, r);
  }
  const roots = events.filter((e) => !e.consequenceOf);
  const impacts = roots.map((e) => ({ e, imp: eventImpact(s, e, finance, tariffs) }));
  const total = impacts.reduce((a, x) => a + (x.imp.estimate?.total ?? 0), 0);
  const kilnMin = roots.reduce((a, e) => a + (e.category === 'production' ? e.acc.constraintMin : 0), 0);
  const gap = expected != null && io.output != null ? Math.max(0, expected - io.output) : null;
  sec(
    'Losses',
    [
      {
        kind: 'table',
        head: ['Measure', 'Value', 'Basis'],
        rows: [
          ['Output below expected', gap != null ? `${n0(gap)} ${unit}${unit === 'tiles' ? ` (${n1(gap * M2_PER_TILE)} m²)` : ''}` : 'Not defined', 'Ideal rate × planned time − actual output, at this stage — a line loss only if it held up the kiln'],
          ['Stage down / starved / blocked', `${n0(io.downMin)} / ${n0(io.starvedMin)} / ${n0(io.blockedMin)} min`, 'Average over the stage machines, shift to date'],
          ['Kiln held up by root events of the stage', `${n0(kilnMin)} min`, 'Minutes the line constraint was down, starved or blocked with these events as the cause'],
          ['Estimated cost of root events', fmtMoney(finance.currency, total), `${roots.length} root event${roots.length === 1 ? '' : 's'}; consequence events are valued under their root, never twice`],
        ],
        widths: [52, 38, 'auto'],
      },
      { kind: 'subhead', text: 'Downtime by asset and reason (shift to date)' },
      {
        kind: 'table',
        head: ['Asset', 'Reason', 'Minutes', 'Records'],
        rows: [...byReason.values()].sort((a, b) => b.minutes - a.minutes).map((r) => [r.asset, r.reason, n0(r.minutes), String(r.n)]),
        widths: [24, 'auto', 22, 20],
        empty: 'No downtime recorded at this stage in the shift',
      },
      ...(impacts.some((x) => (x.imp.estimate?.total ?? 0) > 0)
        ? ([
            { kind: 'subhead', text: 'Estimated cost by event' },
            {
              kind: 'table',
              head: ['Event', 'Title', 'Estimate'],
              rows: impacts.filter((x) => (x.imp.estimate?.total ?? 0) > 0).map((x) => [x.e.id, x.e.title, fmtMoney(finance.currency, x.imp.estimate!.total)]),
              widths: [22, 'auto', 32],
            },
          ] as PdfBlock[])
        : []),
      { kind: 'subhead', text: 'Assumptions' },
      { kind: 'list', items: [...assumptionList(finance), 'Event estimates cover each event’s whole duration, which may begin before the shift.'] },
    ],
    LABELS.estimate,
  );

  // 6 Data provenance & limitations
  sec('Data provenance & limitations', [
    {
      kind: 'list',
      items: [
        'All values are simulated by the deterministic simulation of a representative plant — no PLC, SCADA, MES or camera is connected.',
        'Quantities without a counting point at this stage are shown as not measured rather than inferred.',
        'Financial figures are estimates from the stated assumptions, not verified business losses.',
      ],
    },
    { kind: 'text', text: `Summary generated ${wallClock(generatedAt)} (wall clock) · ${plantTime(s.minute)} (plant time).`, tone: 'muted' },
  ]);

  return sanitizeDeep<PdfDocModel>({
    docType: 'Stage shift summary',
    docId: st.id,
    title: `${st.name} — ${p.label}`,
    lead: `Shift to date at ${plantTime(s.minute)} (plant time). Stage ${st.step} of the line, zone ${st.zone}.`,
    facts: [`Stage: ${st.id}`, `Shift: ${p.label}`, `Events: ${events.length}`, `Active: ${active.length}`],
    generatedAt: wallClock(generatedAt),
    generatedAtPlant: `${formatDateTime(s.minute)} (plant time)`,
    sections,
    fileName: `wAI-stage-${fileSafe(st.id)}-shift-${shiftAt(p.from).id}-${formatDate(p.from)}.pdf`,
    disclaimer: FOOTER_DISCLAIMER,
  });
}
