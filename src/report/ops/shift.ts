/**
 * Shift production performance — output against plan, the production flow by stage, the count
 * reconciliation, downtime, the significant events and what to do next. Whole line or one stage.
 * KPIs are productionKpis (src/intel/kpis.ts) for the chosen period, exactly as Production shows them.
 */
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { factoryOeeKpi, productionKpis } from '../../intel/kpis';
import { CONVEYOR_BY_ID, M2_PER_TILE, MONITORED_STAGES, MONITORED_STAGE_BY_ID, PROCESS_MACHINES } from '../../model/plant';
import type { EventCategory, MonitoredStageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { DEFAULT_FINANCE, assumptionList } from '../../sim/finance';
import { OPERATIONAL_STATE_LABEL, conveyorMetrics, countReconciliation, hourlyTrend, lineMetrics, machineMetrics, operationalState, stageIO, type Period } from '../../sim/metrics';
import { formatDateTime } from '../../sim/time';
import { fmtMoney, wallClock } from '../format';
import { isAddedToStageTotal } from '../stageShift';
import {
  REPORT_TYPE_LABEL,
  chartBuckets,
  dec1,
  downtimeByReason,
  eventActions,
  eventQuery,
  eventRow,
  eventsTable,
  evidenceItems,
  feedStaleMark,
  int,
  listedCount,
  notConfirmedCell,
  opsDisclaimer,
  pct1,
  recurringPatterns,
  reportFileName,
  reportPeriod,
  scopeLabel,
  significantEvents,
  staleReason,
  staleStatus,
  whenLabel,
  withBasis,
} from './common';
import { LEGEND, type OpsReport, type OpsReportOptions, type ReportBlock, type ReportSection } from './types';

const low1 = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

/** Categories of the whole-line shift report (a stage scope lists every event of the stage). */
const PRODUCTION_CATEGORIES: EventCategory[] = ['production', 'equipment', 'data'];

/** Stale marks of the assets of a stage in the period (its figures rest on those feeds). */
const stageStaleMarks = (s: SimState, stageId: MonitoredStageId, p: Period) =>
  MONITORED_STAGE_BY_ID[stageId].equipment.map((id) => feedStaleMark(s, id, p)).filter((x): x is string => !!x);

/**
 * Equipment of a stage now: operational state, since when (with the date when it is another plant day),
 * and the period's figures. A stale feed's state is unknown since the feed went stale, and its figures are
 * the simulation's running accounting, marked not confirmed.
 */
export function equipmentRows(s: SimState, stageId: MonitoredStageId, p: Period): string[][] {
  const st = MONITORED_STAGE_BY_ID[stageId];
  const assets = [...st.equipment, ...st.conveyors.filter((c) => !st.equipment.includes(c))];
  return assets.map((id) => {
    const m = s.machines[id];
    const name = CONVEYOR_BY_ID[id]?.name ?? EQUIPMENT_BY_ID[id]?.name ?? id;
    if (!m) return [id, name, 'Not monitored as a machine', '—', 'Tracked through logistics records'];
    // OPERATIONAL_STATE_LABEL already says "Unknown (data stale)" for a stale feed.
    const state = OPERATIONAL_STATE_LABEL[operationalState(s, id)];
    const feed = s.feeds[id]?.status === 'stale' ? s.feeds[id] : null;
    let figures = '—';
    if (CONVEYOR_BY_ID[id]) {
      const c = conveyorMetrics(s, id, p);
      figures = `Running ${pct1(c.availability)} · ${c.stops} stop${c.stops === 1 ? '' : 's'} (${int(c.downMin)} min)`;
    } else if (PROCESS_MACHINES.includes(id)) {
      const mm = machineMetrics(s, id, p);
      const oee = mm.oee.oee;
      figures = `OEE ${oee.status === 'ok' ? pct1(oee.value) : 'unavailable'} · ${int(mm.totals.count)} tiles · down ${int(mm.totals.down)} min`;
    }
    return [id, name, state, whenLabel(feed ? feed.since : m.since, s.minute), figures === '—' ? figures : notConfirmedCell(figures, feedStaleMark(s, id, p))];
  });
}

export function buildShiftReport(s: SimState, opts: OpsReportOptions): OpsReport {
  const finance = opts.finance ?? DEFAULT_FINANCE;
  const tariffs = opts.tariffs ?? DEFAULT_TARIFFS;
  const scope = opts.scope && opts.scope !== 'line' && MONITORED_STAGE_BY_ID[opts.scope] ? opts.scope : 'line';
  const per = reportPeriod(opts.period, s.minute);
  const p = per.period;
  const lm = lineMetrics(s, p);
  const kpis = productionKpis(s, p).map((k) => withBasis(k, 'measured'));
  const sections: ReportSection[] = [];
  const stage = scope === 'line' ? null : MONITORED_STAGE_BY_ID[scope];
  // Stale feeds, from the KPI models: sorting (good output and plan attainment) and the line OEE.
  const sortStale = staleStatus(kpis.find((k) => k.id === 'good-output')!);
  const oeeStale = staleStatus(factoryOeeKpi(s, p, lm));
  const toDate = p.to >= s.minute;
  // Output against plan in words: a figure on a stale feed is the simulation's running total, never a stated fact.
  const outputVsPlan = sortStale
    ? `Output vs plan not confirmed — ${staleReason(sortStale)} (simulated running total ${int(lm.outputM2)} m² of ${int(lm.targetM2)} m² planned${toDate ? ' to date' : ''})`
    : `Good output ${int(lm.outputM2)} m² against a plan of ${int(lm.targetM2)} m² (${pct1(lm.attainment)})`;

  // 1 KPIs
  sections.push({
    id: 'kpis',
    title: stage ? 'Line KPIs (context for the stage)' : 'Headline KPIs',
    basis: 'measured',
    blocks: [
      { kind: 'kpis', items: kpis, note: 'The same KPI definitions and figures as the Production workspace. Production rate always covers the last complete hour.' },
    ],
  });

  // 2 Output against plan
  const buckets = chartBuckets(p, per.key, s.minute);
  if (!stage) {
    const pts = per.key === '7d' ? null : hourlyTrend(s, p);
    const rows = buckets.map((b, i) => {
      if (pts) return { label: b.label, output: pts[i]?.output ?? 0, target: pts[i]?.target ?? 0 };
      const m = lineMetrics(s, { from: b.from, to: b.to, label: '' });
      return { label: b.label, output: m.output, target: m.target };
    });
    const atPlan = rows.filter((r) => r.target > 0 && r.output >= r.target * 0.97).length;
    const withPlan = rows.filter((r) => r.target > 0).length;
    sections.push({
      id: 'output',
      title: 'Output against plan',
      basis: 'measured',
      blocks: [
        {
          kind: 'chart',
          chart: {
            title: `Good output per ${per.key === '7d' ? 'shift' : 'hour'}`,
            question: 'Did the line make its plan in each part of the period?',
            unit: 'm²',
            labels: rows.map((r) => r.label),
            series: [
              { label: 'Good output', values: rows.map((r) => r.output * M2_PER_TILE) },
              { label: 'Plan', values: rows.map((r) => r.target * M2_PER_TILE), dashed: true },
            ],
          },
        },
        {
          kind: 'text',
          text: withPlan
            ? `${atPlan} of ${withPlan} ${per.key === '7d' ? 'shifts' : 'hours'} at or above 97 % of plan${sortStale ? ' in the simulated running counts' : ''}. Period total: ${sortStale ? low1(outputVsPlan) : `${int(lm.outputM2)} m² good output against a plan of ${int(lm.targetM2)} m² (${pct1(lm.attainment)})`}.${p.to >= s.minute ? ' The last bucket may be incomplete.' : ''}`
            : 'No planned production time in the period yet.',
          tone: 'muted',
        },
      ],
    });
  } else {
    const rows = buckets.map((b) => {
      const io = stageIO(s, stage.id, { from: b.from, to: b.to, label: '' });
      const hrs = (b.to - b.from) / 60;
      return { label: b.label, output: io.output ?? 0, expected: io.expectedPerHour != null ? io.expectedPerHour * hrs : null };
    });
    sections.push({
      id: 'output',
      title: `Stage output per ${per.key === '7d' ? 'shift' : 'hour'}`,
      basis: 'measured',
      blocks: [
        {
          kind: 'chart',
          chart: {
            title: `${stage.name} output`,
            question: 'Did the stage run at its expected rate through the period?',
            unit: stage.unit,
            labels: rows.map((r) => r.label),
            series: [
              { label: 'Output', values: rows.map((r) => r.output) },
              ...(rows.some((r) => r.expected != null) ? [{ label: 'Expected at ideal rate', values: rows.map((r) => r.expected), dashed: true }] : []),
            ],
          },
        },
        {
          kind: 'text',
          text: rows.some((r) => r.expected != null)
            ? 'Expected = the ideal rate of the stage over its planned time. A shortfall at a stage costs line output only when it holds up the kiln (the line constraint).'
            : 'No expected rate is defined for this stage, so only its output is shown.',
          tone: 'muted',
        },
      ],
    });
  }

  // 3 Production flow / stage input-output
  if (!stage) {
    const ordered = [...MONITORED_STAGES].sort((a, b) => a.step - b.step);
    // A stage whose machines' feeds went stale: its output is the simulation's running count, marked not confirmed.
    const marks = ordered.map((st) => stageStaleMarks(s, st.id, p));
    sections.push({
      id: 'flow',
      title: 'Production flow by stage',
      basis: 'measured',
      ...(marks.some((m) => m.length) ? { tag: 'Measured in simulation · not confirmed (data stale)' } : {}),
      blocks: [
        {
          kind: 'table',
          head: ['Stage', 'Output', 'Rate', 'Expected rate', 'Down', 'Starved', 'Blocked'],
          rows: ordered.map((st, i) => {
            const io = stageIO(s, st.id, p);
            const mark = marks[i][0] ?? null;
            return [
              { text: st.name, stage: st.id },
              io.output != null ? notConfirmedCell(`${int(io.output)} ${io.unit}`, mark) : 'Not measured',
              io.ratePerHour != null ? notConfirmedCell(`${int(io.ratePerHour)} /h`, mark) : '—',
              io.expectedPerHour != null ? `${int(io.expectedPerHour)} /h` : 'Not defined',
              `${int(io.downMin)} min`,
              `${int(io.starvedMin)} min`,
              `${int(io.blockedMin)} min`,
            ];
          }),
          align: ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
          widths: ['auto', 28, 20, 26, 18, 18, 18],
        },
        ...ordered.flatMap((st, i): ReportBlock[] =>
          marks[i].length ? [{ kind: 'text', text: `${st.name}: ${marks[i].join('; ')} — its output, rate and minutes include time the stale feed has not confirmed (the simulation's running count, the same figure as the app's stage views).` }] : [],
        ),
        { kind: 'text', text: 'Minutes are the average over the stage machines. Upstream of a bottleneck stages block, downstream they starve.', tone: 'muted' },
      ],
    });
    const rc = countReconciliation(s, p);
    const wip = (v: number | null) => (v == null ? 'Not recorded' : `${v >= 0 ? '+' : ''}${int(v)} tiles`);
    sections.push({
      id: 'reconciliation',
      title: 'Count reconciliation (kiln to pallet)',
      basis: 'measured',
      blocks: [
        {
          kind: 'table',
          head: ['Counting point', 'Tiles', 'Difference explained by'],
          rows: [
            ['Fired (kiln)', int(rc.fired), `Kiln outfeed buffer change ${wip(rc.wip.kilnOutfeed)}`],
            ['Sorted', int(rc.sorted), 'Every sorted tile is inspected'],
            ['Inspected', int(rc.inspected), `${int(rc.rejected)} rejected at the gauge and vision tunnel`],
            ['Good (accepted)', int(rc.good), `Accumulation buffer change ${wip(rc.wip.accumulation)}`],
            ['Packed', int(rc.packed), `Carton transfer change ${wip(rc.wip.cartonTransfer)}`],
            ['Palletised', `${int(rc.palletised)} (${dec1(rc.pallets)} pallets)`, 'Only accepted tiles are packed'],
          ],
          align: ['l', 'r', 'l'],
          widths: [40, 34, 'auto'],
        },
        {
          kind: 'text',
          text:
            [rc.residuals.firedVsSorted, rc.residuals.goodVsPacked, rc.residuals.packedVsPalletised].every((r) => r == null || Math.abs(r) < 1)
              ? 'Counts reconcile: every difference between counting points is explained by a buffer change.'
              : `Unexplained differences (counting residuals): fired vs sorted ${int(rc.residuals.firedVsSorted)}, good vs packed ${int(rc.residuals.goodVsPacked)}, packed vs palletised ${int(rc.residuals.packedVsPalletised)} tiles.`,
          tone: 'muted',
        },
      ],
    });
  } else {
    const io = stageIO(s, stage.id, p);
    const marks = stageStaleMarks(s, stage.id, p);
    const mark = marks[0] ?? null;
    const cp = (label: string, c: typeof stage.input | null, q: number | null): string[] => [
      label,
      c ? c.label : '—',
      c && c.measured && q != null ? notConfirmedCell(`${int(q)} ${io.unit}`, mark) : 'Not measured',
      c?.signalId ?? 'No counting point',
    ];
    sections.push({
      id: 'flow',
      title: 'Stage input / output',
      basis: 'measured',
      ...(mark ? { tag: 'Measured in simulation · not confirmed (data stale)' } : {}),
      blocks: [
        ...(marks.length
          ? ([{ kind: 'text', text: `${marks.join('; ')} — the stage figures include time the stale feed has not confirmed (the simulation's running count, the same figure as the app's stage views).` }] as ReportBlock[])
          : []),
        {
          kind: 'table',
          head: ['Quantity', 'Counting point', 'In the period', 'Signal'],
          rows: [cp('Input', stage.input, io.input), cp('Output', stage.output, io.output), cp('Good', stage.good, io.good), cp('Rejected', stage.rejected, io.rejected)],
          align: ['l', 'l', 'r', 'l'],
          widths: [22, 'auto', 30, 40],
        },
        {
          kind: 'kv',
          rows: [
            ['Work in progress at input (now)', io.wip != null ? `${int(io.wip)} ${io.unit}${io.wipCapacity ? ` (${Math.round((io.wip / io.wipCapacity) * 100)} % of ${int(io.wipCapacity)})` : ''}` : 'Not measured'],
            ['Rate', io.ratePerHour != null ? notConfirmedCell(`${int(io.ratePerHour)} ${io.unit}/h`, mark) : '—'],
            ['Expected rate', io.expectedPerHour != null ? `${int(io.expectedPerHour)} ${io.unit}/h` : 'Not defined for this stage'],
            ['Down / starved / blocked', `${int(io.downMin)} / ${int(io.starvedMin)} / ${int(io.blockedMin)} min`],
          ],
        },
        { kind: 'subhead', text: 'Equipment now' },
        {
          kind: 'table',
          head: ['Asset', 'Name', 'State now', 'Since', 'In the period'],
          rows: equipmentRows(s, stage.id, p),
          widths: [18, 'auto', 30, 14, 56],
        },
      ],
    });
  }

  // 4 Downtime
  const assets = stage ? [...stage.equipment, ...stage.conveyors] : undefined;
  const dt = downtimeByReason(s, p, assets).slice(0, 8);
  sections.push({
    id: 'downtime',
    title: 'Downtime by reason',
    basis: 'measured',
    blocks: [
      {
        kind: 'bars',
        title: stage ? `Stops at ${stage.name}` : 'Stops anywhere on the line',
        unit: 'min',
        rows: dt.map((r) => ({ label: r.label, value: r.minutes, display: `${int(r.minutes)} min`, note: `${r.n} stop${r.n === 1 ? '' : 's'} · ${r.category}` })),
        empty: 'No unplanned stop in the period.',
      },
      { kind: 'text', text: 'Stops by alarm reason, clipped to the period. Changeovers count as stops (lost availability); planned maintenance stops and starved / blocked time are excluded. A stop costs line output only while it holds up the kiln.', tone: 'muted' },
    ],
  });

  // 5 Significant events
  const query = eventQuery(per.key, stage ? null : PRODUCTION_CATEGORIES, scope);
  const evs = significantEvents(s, p, query);
  const rows = evs.map((e) => eventRow(s, e, finance, tariffs));
  const added = evs.filter(isAddedToStageTotal);
  const addedPriced = added.filter((e) => rows.find((r) => r.id === e.id)?.estimate != null).length;
  const total = added.reduce((a, e) => a + (rows.find((r) => r.id === e.id)?.estimate ?? 0), 0);
  const evBlocks: ReportBlock[] = [...eventsTable(rows, finance.currency, stage ? 'No significant event at this stage in the period.' : 'No significant production event in the period.', s.minute, query)];
  if (rows.some((r) => r.estimate != null))
    evBlocks.push({
      kind: 'total',
      label: 'Estimated cost of these events',
      value: fmtMoney(finance.currency, total),
      note: `Sum of the ${addedPriced} estimate${addedPriced === 1 ? '' : 's'} in the Estimate column of the ${listedCount(rows.length)}. Root production events valued once (consequences under their root${stage ? '; quality events listed but not added' : ''}). Estimates cover each event's whole duration.`,
    });
  if (rows.some((r) => r.estimate != null)) evBlocks.push({ kind: 'subhead', text: 'Financial assumptions' }, { kind: 'list', items: assumptionList(finance) });
  const evidence = evidenceItems(s, evs, ['camera-snapshot'], 2);
  if (evidence.length) evBlocks.push({ kind: 'subhead', text: 'Evidence captured with these events' }, { kind: 'evidence', items: evidence });
  sections.push({ id: 'events', title: 'Significant events', basis: 'simulated', tag: 'Simulated events · estimates', blocks: evBlocks });

  // 6 Actions
  const actions = eventActions(evs);
  const derived: string[] = [...recurringPatterns(s, evs)];
  if (dt[0]) derived.push(`Largest stop reason: ${dt[0].label} — ${int(dt[0].minutes)} min over ${dt[0].n} stop${dt[0].n === 1 ? '' : 's'}${stage ? ` at ${stage.name}` : ''}; the first place to look for recoverable time.`);
  if (!stage && lm.attainment != null && lm.attainment < 0.97)
    derived.push(
      sortStale
        ? `${outputVsPlan}: check the I-SORT data feed in the Factory Twin before acting on the shortfall.`
        : `Output is ${pct1(lm.attainment)} of plan (${int(lm.targetM2 - lm.outputM2)} m² short): check the kiln's time lost to stops, starvation and blocking in Production.`,
    );
  sections.push({
    id: 'actions',
    title: 'Actions & recommendations',
    blocks: [
      ...(actions.length ? ([{ kind: 'subhead', text: 'Open significant events' }, { kind: 'list', items: actions, numbered: true }] as ReportBlock[]) : []),
      ...(derived.length ? ([{ kind: 'subhead', text: 'From the figures and patterns in this report' }, { kind: 'list', items: derived }] as ReportBlock[]) : []),
      ...(!actions.length && !derived.length ? ([{ kind: 'text', text: 'No action is indicated by the data of this period.', tone: 'muted' }] as ReportBlock[]) : []),
    ],
  });

  const top = rows[0];
  const stageMark = stage ? (stageStaleMarks(s, stage.id, p)[0] ?? null) : null;
  const oeeText =
    lm.oee.oee.status !== 'ok' ? 'unavailable' : oeeStale ? `not confirmed — ${staleReason(oeeStale)} (simulated running figure ${pct1(lm.oee.oee.value)})` : pct1(lm.oee.oee.value);
  const summary = stage
    ? `${stage.name}: ${int(stageIO(s, stage.id, p).output)} ${stage.unit} out in the period${stageMark ? ` (not confirmed — ${staleReason(stageMark)})` : ''}; ${rows.length} significant event${rows.length === 1 ? '' : 's'}${top ? `, the most severe ${top.id} (${top.title})` : ''}. ${
        sortStale ? `Line ${low1(outputVsPlan)}` : `Line good output ${int(lm.outputM2)} m² against a plan of ${int(lm.targetM2)} m²`
      }.`
    : `${outputVsPlan}; line OEE ${oeeText}. ${rows.length} significant event${rows.length === 1 ? '' : 's'}${top ? `, the most severe ${top.id} (${top.title})` : ''}.`;

  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  return {
    type: 'shift',
    typeLabel: REPORT_TYPE_LABEL.shift,
    title: `${REPORT_TYPE_LABEL.shift} — ${scopeLabel(scope)}`,
    summary,
    period: { key: per.key, label: per.label, from: per.from, to: per.to, text: per.text },
    scope: { id: scope, label: scopeLabel(scope) },
    generatedAt: wallClock(generatedAt),
    generatedAtPlant: `${formatDateTime(s.minute)} (plant time)`,
    minute: s.minute,
    kpis,
    sections,
    events: rows,
    eventQuery: query,
    legend: LEGEND,
    fileName: reportFileName('shift', scope, per),
    disclaimer: opsDisclaimer(sections),
    currency: finance.currency,
  };
}
