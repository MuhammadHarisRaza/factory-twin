/**
 * OEE & production losses — line OEE at the kiln (the designed constraint) with its components, the
 * path from theoretical capacity to good output (capacityBreakdown — each lost unit counted once, at
 * the constraint), downtime by reason, machine OEE and the loss events. Whole line or one stage
 * (machines and stops of the stage; the line OEE stays the line's).
 */
import { constraintDowntimeKpi, factoryOeeKpi, firstPassQualityKpi, goodOutputKpi, targetAttainmentKpi } from '../../intel/kpis';
import { MONITORED_STAGE_BY_ID, PROCESS_MACHINES, TARGET } from '../../model/plant';
import type { SimState } from '../../sim/engine';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { DEFAULT_FINANCE, assumptionList } from '../../sim/finance';
import { capacityBreakdown, lineMetrics, machineMetrics } from '../../sim/metrics';
import type { Metric } from '../../sim/oee';
import { formatDateTime } from '../../sim/time';
import { fmtMoney, wallClock } from '../format';
import { isAddedToStageTotal } from '../stageShift';
import {
  REPORT_TYPE_LABEL,
  downtimeByReason,
  eventActions,
  eventQuery,
  eventRow,
  eventsTable,
  evidenceBlocks,
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
  withBasis,
} from './common';
import { BASIS_LABEL, LEGEND, type OpsReport, type OpsReportOptions, type ReportBlock, type ReportScope, type ReportSection } from './types';

const metric = (m: Metric) => (m.status === 'ok' ? pct1(m.value) : m.status === 'invalid' ? `Invalid — ${m.issue ?? 'inconsistent inputs'}` : `Unavailable — ${m.issue ?? 'no data'}`);

/** One note per stale feed, under the figures it marks. */
const staleNotes = (notes: (string | false | null)[]): ReportBlock[] => notes.filter((x): x is string => !!x).map((text) => ({ kind: 'text', text }));

/** Stages for which an OEE report scope applies (stages with process machines). */
export const OEE_SCOPES: ReportScope[] = ['line', ...Object.values(MONITORED_STAGE_BY_ID).filter((st) => st.oeeMeaningful && st.equipment.some((id) => PROCESS_MACHINES.includes(id))).map((st) => st.id)];

export function buildOeeReport(s: SimState, opts: OpsReportOptions): OpsReport {
  const finance = opts.finance ?? DEFAULT_FINANCE;
  const tariffs = opts.tariffs ?? DEFAULT_TARIFFS;
  const scope: ReportScope = opts.scope && OEE_SCOPES.includes(opts.scope) ? opts.scope : 'line';
  const stage = scope === 'line' ? null : MONITORED_STAGE_BY_ID[scope];
  const per = reportPeriod(opts.period, s.minute);
  const p = per.period;
  const lm = lineMetrics(s, p);
  const kpis = [factoryOeeKpi(s, p, lm), constraintDowntimeKpi(s, p, lm), firstPassQualityKpi(s, p), targetAttainmentKpi(s, p, lm), goodOutputKpi(s, p, lm)].map((k) => withBasis(k, 'measured'));
  const sections: ReportSection[] = [];
  // Stale feeds, from the KPI models: the kiln feed (availability, performance, kiln minutes — the Downtime
  // card), the sorting feed (quality, good output — the Good output card); Line OEE names whichever applies.
  const [oeeK, downK, , , goodK] = kpis;
  const oeeStale = staleStatus(oeeK);
  const kilnStale = staleStatus(downK);
  const sortStale = staleStatus(goodK);
  const staleTag = `${BASIS_LABEL.measured} · not confirmed (data stale)`;

  sections.push({
    id: 'kpis',
    title: stage ? 'Line KPIs (context for the stage)' : 'Headline KPIs',
    basis: 'measured',
    blocks: [{ kind: 'kpis', items: kpis, note: 'Line OEE = availability × performance at the kiln (the line constraint) × first-pass quality at sorting — the same figure as Overview and Production.' }],
  });

  // OEE components
  const o = lm.oee;
  const k = lm.constraint;
  sections.push({
    id: 'components',
    title: 'Line OEE and its components',
    basis: 'measured',
    ...(oeeStale ? { tag: staleTag } : {}),
    blocks: [
      {
        kind: 'table',
        head: ['Component', 'Value', 'Measured at', 'How it is calculated'],
        rows: [
          ['Availability', notConfirmedCell(metric(o.availability), kilnStale), 'Kiln H-KILN', `Operating ${int(k.totals.operating)} min ÷ planned ${int(k.totals.planned)} min (stops, starvation and blocking reduce it)`],
          ['Performance', notConfirmedCell(metric(o.performance), kilnStale), 'Kiln H-KILN', `${int(k.totals.count)} tiles fired ÷ (${int(k.idealRatePerHour)} tiles/h ideal × operating time)`],
          ['Quality', notConfirmedCell(metric(o.quality), sortStale), 'Sorting (gauge + vision)', `${int(lm.good)} accepted ÷ ${int(lm.inspected)} inspected (first pass)`],
          ['OEE', notConfirmedCell(metric(o.oee), oeeStale), 'Line', `Availability × performance × quality · target ${Math.round(TARGET.oeeTarget * 100)} %`],
        ],
        align: ['l', 'r', 'l', 'l'],
        widths: [24, 30, 34, 'auto'],
      },
      ...staleNotes([
        kilnStale && `${kilnStale}: availability and performance include kiln minutes and tiles fired that the stale feed has not confirmed — the simulation's running accounting, the same figures and mark as the Line OEE card.`,
        sortStale && `${sortStale}: quality includes inspection counts that the stale feed has not confirmed — the simulation's running accounting, the same figures and mark as the KPI cards.`,
      ]),
      ...(o.issues.length ? ([{ kind: 'list', items: o.issues.map((x) => `Integrity check: ${x}`) }] as ReportBlock[]) : []),
    ],
  });

  // Capacity to good output
  const cb = capacityBreakdown(s, p);
  const losses = cb.losses.filter((l) => l.kind === 'loss');
  const transit = cb.losses.find((l) => l.kind === 'transit');
  sections.push({
    id: 'capacity',
    title: 'From capacity to good output',
    basis: 'estimated',
    tag: kilnStale || sortStale ? 'Estimated · lost time × design rate · not confirmed (data stale)' : 'Estimated · lost time × design rate',
    blocks: [
      ...staleNotes([
        kilnStale && `${kilnStale}: the losses at the kiln include kiln minutes the stale feed has not confirmed.`,
        sortStale && `${sortStale}: good output and the quality loss include counts the stale feed has not confirmed.`,
      ]),
      {
        kind: 'bars',
        title: 'Where capacity was lost at the kiln',
        unit: 'm²',
        rows: losses.map((l) => ({ label: l.label, value: Math.max(0, l.m2), display: `${int(l.m2)} m²`, note: l.basis })),
        empty: 'No capacity lost in the period.',
      },
      {
        kind: 'table',
        head: ['Step', 'm²', 'Basis'],
        rows: [
          ['Theoretical capacity', int(cb.theoreticalM2), `Design rate × ${int(cb.calendarMin)} calendar minutes`],
          ...losses.map((l) => [`− ${l.label}`, int(l.m2), l.basis]),
          ...(transit ? [[`${transit.m2 >= 0 ? '−' : '+'} ${transit.label}`, int(Math.abs(transit.m2)), transit.basis]] : []),
          ['Good output', int(cb.goodM2), 'First-quality tiles accepted at sorting (measured)'],
          ['Plan for the period', int(cb.plannedM2), `Gap to plan ${int(cb.planGapM2)} m²`],
        ],
        align: ['l', 'r', 'l'],
        widths: [50, 22, 'auto'],
      },
      { kind: 'list', items: cb.assumptions },
    ],
  });

  // Downtime
  const assets = stage ? [...stage.equipment, ...stage.conveyors] : undefined;
  const dt = downtimeByReason(s, p, assets).slice(0, 8);
  const dtTotal = dt.reduce((a, r) => a + r.minutes, 0);
  sections.push({
    id: 'downtime',
    title: 'Downtime by reason',
    basis: 'measured',
    blocks: [
      {
        kind: 'bars',
        title: stage ? `Stops at ${stage.name}` : 'Stops on the line',
        unit: 'min',
        rows: dt.map((r) => ({ label: r.label, value: r.minutes, display: `${int(r.minutes)} min`, note: `${r.n} stop${r.n === 1 ? '' : 's'} · ${dtTotal > 0 ? Math.round((r.minutes / dtTotal) * 100) : 0} % · ${r.category}` })),
        empty: 'No unplanned stop in the period.',
      },
      {
        kind: 'kv',
        rows: [
          ['Kiln stopped (own downtime)', notConfirmedCell(`${int(k.totals.down)} min`, kilnStale)],
          ['Kiln starved (no tiles in)', notConfirmedCell(`${int(k.totals.starved)} min`, kilnStale)],
          ['Kiln blocked (no room out)', notConfirmedCell(`${int(k.totals.blocked)} min`, kilnStale)],
          ['Kiln planned stops', `${int(k.totals.plannedStop)} min`],
        ],
      },
      ...staleNotes([kilnStale && `${kilnStale}: the kiln minutes above include time the stale feed has not confirmed — the simulation's running accounting, the same figures and mark as the Downtime affecting output card.`]),
    ],
  });

  // Machine OEE
  const machines = (stage ? stage.equipment : PROCESS_MACHINES).filter((id) => PROCESS_MACHINES.includes(id));
  // A machine whose feed went stale in the period: its row is the simulation's running accounting, marked.
  const machineStale = machines.map((id) => feedStaleMark(s, id, p));
  sections.push({
    id: 'machines',
    title: 'Machine OEE',
    basis: 'measured',
    ...(machineStale.some(Boolean) ? { tag: staleTag } : {}),
    blocks: [
      {
        kind: 'table',
        head: ['Machine', 'Availability', 'Performance', 'Quality', 'OEE', 'Tiles', 'Down'],
        rows: machines.map((id, i) => {
          const m = machineMetrics(s, id, p);
          const short = (x: Metric) => (x.status === 'ok' ? pct1(x.value) : x.status === 'invalid' ? 'Invalid' : '—');
          return [`${id} · ${m.name}`, short(m.oee.availability), short(m.oee.performance), short(m.oee.quality), notConfirmedCell(short(m.oee.oee), machineStale[i]), int(m.totals.count), `${int(m.totals.down)} min`];
        }),
        align: ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
        widths: ['auto', 22, 22, 18, 18, 20, 18],
      },
      ...staleNotes(machineStale.map((x, i) => x && `${machines[i]} — ${x}: its figures include time the stale feed has not confirmed.`)),
      { kind: 'text', text: "Each machine's OEE uses its own counts and time; the line OEE is measured at the kiln. Machine figures are not averaged into the line figure. '—' = not calculable (no production time).", tone: 'muted' },
    ],
  });

  // Loss events
  const query = eventQuery(per.key, ['production', 'equipment'], scope);
  const evs = significantEvents(s, p, query);
  const rows = evs.map((e) => eventRow(s, e, finance, tariffs));
  const total = evs.filter(isAddedToStageTotal).reduce((a, e) => a + (rows.find((r) => r.id === e.id)?.estimate ?? 0), 0);
  const kilnMin = evs.reduce((a, e) => a + (e.category === 'production' ? e.acc.constraintMin : 0), 0);
  sections.push({
    id: 'events',
    title: 'Loss events',
    basis: 'simulated',
    tag: 'Simulated events · estimates',
    blocks: [
      ...eventsTable(rows, finance.currency, 'No significant production or equipment event in the period.', s.minute, query),
      { kind: 'kv', rows: [['Kiln held up by these events', `${int(kilnMin)} min`], ['Events with a cost estimate', `${rows.filter((r) => r.estimate != null).length} of ${rows.length}`]] },
      ...(rows.some((r) => r.estimate != null)
        ? ([
            {
              kind: 'total',
              label: 'Estimated value of the output lost in these events',
              value: fmtMoney(finance.currency, total),
              note: `Sum of the Estimate column of the ${listedCount(rows.length)}. Lost good output at contribution margin (and kiln idle energy where applicable), from the financial assumptions — not a verified loss.`,
            },
            { kind: 'subhead', text: 'Financial assumptions' },
            { kind: 'list', items: assumptionList(finance) },
          ] as ReportBlock[])
        : []),
      ...evidenceBlocks(evidenceItems(s, evs, ['camera-snapshot'], 2), 'Evidence captured with these events'),
    ],
  });

  // Actions
  const top = [...losses].sort((a, b) => b.m2 - a.m2)[0];
  const derived: string[] = [...recurringPatterns(s, evs)];
  if (top && top.m2 > 0) derived.push(`Largest capacity loss: ${top.label.toLowerCase()} — ${int(top.m2)} m² (${top.basis.toLowerCase()}).`);
  if (dt[0]) derived.push(`Top stop reason: ${dt[0].label} (${int(dt[0].minutes)} min, ${dt[0].n} stop${dt[0].n === 1 ? '' : 's'}).`);
  if (k.totals.starved > k.totals.down && k.totals.starved > 15)
    derived.push(`The kiln waited ${int(k.totals.starved)} min for tiles${kilnStale ? ` (not confirmed — ${staleReason(kilnStale)})` : ''} — look upstream (glazing, drying, pressing) for the stage that starved it.`);
  const actions = eventActions(evs);
  sections.push({
    id: 'actions',
    title: 'Actions & recommendations',
    blocks: [
      ...(derived.length ? ([{ kind: 'subhead', text: 'From the losses above' }, { kind: 'list', items: derived }] as ReportBlock[]) : []),
      ...(actions.length ? ([{ kind: 'subhead', text: 'Open loss events' }, { kind: 'list', items: actions, numbered: true }] as ReportBlock[]) : []),
      ...(!actions.length && !derived.length ? ([{ kind: 'text', text: 'No loss large enough to act on in this period.', tone: 'muted' }] as ReportBlock[]) : []),
    ],
  });

  const equation = `availability ${pct1(o.availability.value)} × performance ${pct1(o.performance.value)} × quality ${pct1(o.quality.value)}`;
  const target = `${Math.round(TARGET.oeeTarget * 100)} % target`;
  // A figure on a stale feed is never stated as a fact: it is the simulation's running figure, not confirmed.
  const oeeSentence = oeeStale
    ? `Line OEE not confirmed — ${staleReason(oeeStale)} (simulated running figure ${pct1(o.oee.value)} against a ${target}: ${equation}).`
    : `Line OEE ${pct1(o.oee.value)} against a ${target}: ${equation}.`;
  const summary =
    o.oee.status === 'ok'
      ? `${oeeSentence}${top && top.m2 > 0 ? ` Largest loss: ${top.label.toLowerCase()} (${int(top.m2)} m²${kilnStale || sortStale ? ', not confirmed' : ''}).` : ''}${dt[0] ? ` Top stop reason: ${dt[0].label} (${int(dt[0].minutes)} min).` : ''}`
      : `Line OEE cannot be calculated for this period — ${o.oee.issue ?? 'no planned production time'}.`;

  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  return {
    type: 'oee',
    typeLabel: REPORT_TYPE_LABEL.oee,
    title: `${REPORT_TYPE_LABEL.oee} — ${scopeLabel(scope)}`,
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
    fileName: reportFileName('oee', scope, per),
    disclaimer: opsDisclaimer(sections),
    currency: finance.currency,
  };
}

