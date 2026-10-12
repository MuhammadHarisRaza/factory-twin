/**
 * Quality & defect trends — inspection results at sorting (qualityKpis, the same KPIs as Quality &
 * Defects), defects by category with their modelled origin stage (a hypothesis, not a confirmed
 * cause), the reject rate over time against the alert limit, the inspection stations, the significant
 * quality events with the inspection frames they carry (illustrations of simulated records) and the
 * actions. Whole line, or the defects whose modelled origin is one stage.
 */
import { qualityKpis } from '../../intel/kpis';
import { DEFECTS, DEFECT_ORDER, INSPECTION_STATIONS, M2_PER_TILE, MONITORED_STAGE_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { DefectCategory } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { DEFAULT_FINANCE } from '../../sim/finance';
import { qualityIn } from '../../sim/metrics';
import { formatDateTime } from '../../sim/time';
import { wallClock } from '../format';
import { STAGE_PARTS } from '../stageShift';
import {
  REPORT_TYPE_LABEL,
  chartBuckets,
  eventActions,
  eventQuery,
  eventRow,
  eventsTable,
  evidenceItems,
  int,
  opsDisclaimer,
  recurringPatterns,
  reportFileName,
  reportPeriod,
  scopeLabel,
  significantEvents,
  withBasis,
} from './common';
import { LEGEND, type OpsReport, type OpsReportOptions, type ReportBlock, type ReportScope, type ReportSection } from './types';

const pct2 = (f: number | null) => (f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(2)} %`);

/** Defect categories whose modelled origin lies in a scope. */
export function defectsInScope(scope: ReportScope): DefectCategory[] {
  if (scope === 'line') return DEFECT_ORDER;
  const parts = STAGE_PARTS[scope] ?? [];
  return DEFECT_ORDER.filter((d) => parts.includes(DEFECTS[d].origin));
}

/** Stages a quality report can be scoped to: those that are the modelled origin of at least one defect. */
export const QUALITY_SCOPES: ReportScope[] = ['line', ...Object.values(MONITORED_STAGE_BY_ID).filter((st) => defectsInScope(st.id).length > 0).map((st) => st.id)];

export function buildQualityReport(s: SimState, opts: OpsReportOptions): OpsReport {
  const finance = opts.finance ?? DEFAULT_FINANCE;
  const tariffs = opts.tariffs ?? DEFAULT_TARIFFS;
  const scope: ReportScope = opts.scope && QUALITY_SCOPES.includes(opts.scope) ? opts.scope : 'line';
  const stage = scope === 'line' ? null : MONITORED_STAGE_BY_ID[scope];
  const per = reportPeriod(opts.period, s.minute);
  const p = per.period;
  const q = qualityIn(s, p);
  const limit = s.rules.rejectRateMax;
  const cats = defectsInScope(scope);
  const kpis = qualityKpis(s, p).map((k) => withBasis(k, 'measured'));
  const sections: ReportSection[] = [];

  sections.push({
    id: 'kpis',
    title: stage ? 'Line quality KPIs (context for the stage)' : 'Headline KPIs',
    basis: 'measured',
    tag: 'Measured in simulation · classification simulated',
    blocks: [
      {
        kind: 'kpis',
        items: kpis,
        note: 'The same KPIs as Quality & Defects. Every tile passes the dimensional gauge and the vision tunnel at sorting; defect classes come from SIM-CV v0 (simulated) — no vision model is connected.',
      },
    ],
  });

  // Defects by category
  const scopeRejects = cats.reduce((a, d) => a + (q.byDefect[d] ?? 0), 0);
  const ranked = cats.map((d) => ({ d, n: q.byDefect[d] ?? 0 })).sort((a, b) => b.n - a.n);
  sections.push({
    id: 'defects',
    title: stage ? `Defects with modelled origin at ${stage.name}` : 'Defects by category',
    basis: 'simulated',
    tag: 'Simulated classification',
    blocks: [
      {
        kind: 'bars',
        title: 'Rejected tiles by defect',
        unit: 'tiles',
        rows: ranked.filter((r) => r.n > 0).map((r) => ({ label: DEFECTS[r.d].label, value: r.n, display: `${int(r.n)} tiles`, note: `${q.rejected > 0 ? Math.round((r.n / q.rejected) * 100) : 0} % of rejects` })),
        empty: 'No rejected tile of these categories in the period.',
      },
      {
        kind: 'table',
        head: ['Defect', 'Rejected', 'm²', 'Share of rejects', 'Rate of inspected', 'Detected at', 'Modelled origin'],
        rows: ranked.map((r) => [
          DEFECTS[r.d].label,
          int(r.n),
          int(r.n * M2_PER_TILE),
          q.rejected > 0 ? `${Math.round((r.n / q.rejected) * 100)} %` : '—',
          q.inspected > 0 ? pct2(r.n / q.inspected) : '—',
          INSPECTION_STATIONS.find((st) => st.id === DEFECTS[r.d].station)?.name ?? DEFECTS[r.d].station,
          STAGE_BY_ID[DEFECTS[r.d].origin].name,
        ]),
        align: ['l', 'r', 'r', 'r', 'r', 'l', 'l'],
        widths: ['auto', 18, 14, 22, 24, 30, 30],
        foot: stage ? undefined : ['All defects', int(q.rejected), int(q.rejected * M2_PER_TILE), '100 %', pct2(q.inspected > 0 ? q.rejected / q.inspected : null), '', ''],
      },
      { kind: 'text', text: 'The origin stage is the stage where this defect class usually arises in the model — a hypothesis to check, not a confirmed cause of these rejects.', tone: 'muted' },
    ],
  });

  // Trend
  const buckets = chartBuckets(p, per.key, s.minute);
  const trend = buckets.map((b) => {
    const x = qualityIn(s, { from: b.from, to: b.to, label: '' });
    const rej = stage ? cats.reduce((a, d) => a + (x.byDefect[d] ?? 0), 0) : x.rejected;
    return { label: b.label, rate: x.inspected > 0 ? (rej / x.inspected) * 100 : null, inspected: x.inspected };
  });
  const over = trend.filter((t) => t.rate != null && t.rate > limit * 100).length;
  sections.push({
    id: 'trend',
    title: 'Reject rate over time',
    basis: 'measured',
    blocks: [
      {
        kind: 'chart',
        chart: {
          title: stage ? `Rejects of these defects per ${per.key === '7d' ? 'shift' : 'hour'}` : `Reject rate per ${per.key === '7d' ? 'shift' : 'hour'}`,
          question: stage ? 'Are the defects from this stage rising?' : 'Is the reject rate rising towards the alert limit?',
          unit: '%',
          labels: trend.map((t) => t.label),
          series: [{ label: stage ? 'Rate of these defects' : 'Reject rate', values: trend.map((t) => t.rate) }],
          limit: stage ? undefined : { label: `Alert limit ${(limit * 100).toFixed(0)} %`, value: limit * 100 },
        },
      },
      {
        kind: 'text',
        text: stage
          ? `Share of inspected tiles rejected for ${cats.map((d) => DEFECTS[d].label.toLowerCase()).join(', ')}.`
          : `${over} of ${trend.filter((t) => t.rate != null).length} ${per.key === '7d' ? 'shifts' : 'hours'} above the ${(limit * 100).toFixed(0)} % alert limit (event rule Q-RATE).`,
        tone: 'muted',
      },
    ],
  });

  // Stations
  sections.push({
    id: 'stations',
    title: 'Inspection stations',
    basis: 'measured',
    blocks: [
      {
        kind: 'table',
        head: ['Station', 'Inspected', 'Rejected', 'Reject rate'],
        rows: INSPECTION_STATIONS.map((st) => {
          const b = q.byStation[st.id] ?? { inspected: 0, rejected: 0 };
          return [`${st.id} · ${st.name}`, int(b.inspected), int(b.rejected), b.inspected > 0 ? pct2(b.rejected / b.inspected) : '—'];
        }),
        align: ['l', 'r', 'r', 'r'],
        widths: ['auto', 28, 28, 28],
      },
    ],
  });

  // Events + evidence
  const query = eventQuery(per.key, ['quality'], scope);
  const evs = significantEvents(s, p, query);
  const rows = evs.map((e) => eventRow(s, e, finance, tariffs));
  const frames = evidenceItems(s, evs, ['inspection-image'], 4);
  const evBlocks: ReportBlock[] = [...eventsTable(rows, finance.currency, 'No significant quality event in the period.', s.minute, query)];
  if (rows.some((r) => r.estimate != null))
    evBlocks.push({ kind: 'text', text: 'Quality event estimates are per event and are not added up: several rules (reject rate, defect count, deterioration) can describe the same rejected tiles.', tone: 'muted' });
  if (frames.length) evBlocks.push({ kind: 'subhead', text: 'Inspection frames of these events' }, { kind: 'evidence', items: frames });
  else if (evs.length) evBlocks.push({ kind: 'missing', title: 'Inspection frames', reason: 'None of these events carries an inspection record that is still retained' });
  sections.push({ id: 'events', title: 'Significant quality events', basis: 'simulated', tag: 'Simulated events · illustrative frames', blocks: evBlocks });

  // Actions
  const top = ranked[0];
  const derived: string[] = [...recurringPatterns(s, evs)];
  if (top && top.n > 0) derived.push(`Most frequent defect: ${DEFECTS[top.d].label} (${int(top.n)} tiles). Check its modelled origin stage first — ${STAGE_BY_ID[DEFECTS[top.d].origin].name} — as a hypothesis, then confirm with the inspection records.`);
  if (!stage && q.inspected > 0 && q.rejected / q.inspected > limit) derived.push(`The reject rate (${pct2(q.rejected / q.inspected)}) is above the ${(limit * 100).toFixed(0)} % limit for the period: hold or re-sort suspect batches.`);
  const actions = eventActions(evs);
  sections.push({
    id: 'actions',
    title: 'Actions & recommendations',
    blocks: [
      ...(actions.length ? ([{ kind: 'subhead', text: 'Open quality events' }, { kind: 'list', items: actions, numbered: true }] as ReportBlock[]) : []),
      ...(derived.length ? ([{ kind: 'subhead', text: 'From the figures and patterns in this report' }, { kind: 'list', items: derived }] as ReportBlock[]) : []),
      ...(!actions.length && !derived.length ? ([{ kind: 'text', text: 'No quality action is indicated by the data of this period.', tone: 'muted' }] as ReportBlock[]) : []),
    ],
  });

  const rate = q.inspected > 0 ? q.rejected / q.inspected : null;
  const summary =
    q.inspected <= 0
      ? 'No tiles have been inspected in this period yet.'
      : stage
        ? `${int(scopeRejects)} rejected tiles with modelled origin at ${stage.name} (${pct2(scopeRejects / q.inspected)} of ${int(q.inspected)} inspected); ${rows.length} significant quality event${rows.length === 1 ? '' : 's'}.`
        : `${pct2(rate)} of ${int(q.inspected)} inspected tiles rejected (limit ${(limit * 100).toFixed(0)} %)${top && top.n > 0 ? `; most frequent defect: ${DEFECTS[top.d].label} (${Math.round((top.n / Math.max(1, q.rejected)) * 100)} % of rejects)` : ''}. ${rows.length} significant quality event${rows.length === 1 ? '' : 's'}.`;

  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  return {
    type: 'quality',
    typeLabel: REPORT_TYPE_LABEL.quality,
    title: `${REPORT_TYPE_LABEL.quality} — ${scopeLabel(scope)}`,
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
    fileName: reportFileName('quality', scope, per),
    disclaimer: opsDisclaimer(sections),
    currency: finance.currency,
  };
}
