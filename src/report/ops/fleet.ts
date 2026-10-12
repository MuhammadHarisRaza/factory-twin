/**
 * Vehicle movement & delays — truck visits of the period (fleetMetrics / fleetKpis, the same as
 * Fleet & Movement), the trucks past a limit now (delayedTrucks), dock occupancy, the movement and
 * delay events with their detention estimate, and the actions. Whole site only: vehicle positions
 * are simulated at zone level (no GPS, indoor positioning or camera analytics is connected).
 */
import { delayedTrucks, fleetKpis } from '../../intel/kpis';
import { DOCKS } from '../../model/plant';
import type { SimState } from '../../sim/engine';
import { DEFAULT_TARIFFS } from '../../sim/energy';
import { DEFAULT_FINANCE } from '../../sim/finance';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { fleetMetrics } from '../../sim/metrics';
import { formatDateTime } from '../../sim/time';
import { ASSUMPTIONS_LOCATION, fmtMoney, wallClock } from '../format';
import {
  REPORT_TYPE_LABEL,
  eventActions,
  eventQuery,
  eventRow,
  eventsTable,
  evidenceBlocks,
  evidenceItems,
  int,
  listedCount,
  opsDisclaimer,
  pct1,
  recurringPatterns,
  reportFileName,
  reportPeriod,
  significantEvents,
  withBasis,
} from './common';
import { LEGEND, type OpsReport, type OpsReportOptions, type ReportBlock, type ReportSection } from './types';

const mins = (v: number | null) => (v == null ? 'No completed visit' : `${int(v)} min`);

export function buildFleetReport(s: SimState, opts: OpsReportOptions): OpsReport {
  const finance = opts.finance ?? DEFAULT_FINANCE;
  const tariffs = opts.tariffs ?? DEFAULT_TARIFFS;
  const per = reportPeriod(opts.period, s.minute);
  const p = per.period;
  const fm = fleetMetrics(s, p);
  const kpis = fleetKpis(s, p).map((k) => withBasis(k, 'simulated'));
  const R = s.rules;
  const sections: ReportSection[] = [];

  sections.push({
    id: 'kpis',
    title: 'Headline KPIs',
    basis: 'simulated',
    tag: 'Simulated vehicle movements',
    blocks: [{ kind: 'kpis', items: kpis, note: 'The same KPIs as Fleet & Movement. "Vehicles on site" and "Waiting or delayed" are the situation now; dwell and visits cover the period.' }],
  });

  sections.push({
    id: 'visits',
    title: 'Truck visits in the period',
    basis: 'simulated',
    blocks: [
      {
        kind: 'kv',
        rows: [
          ['Completed visits (gate-out)', int(fm.completedVisits)],
          ['Gate-ins / gate-outs', `${int(fm.gateIn)} / ${int(fm.gateOut)}`],
          ['Average time on site (dwell)', mins(fm.avgTurnaround)],
          ['Average wait for a dock (outbound)', mins(fm.avgWaiting)],
          ['Average gate to dock (outbound)', mins(fm.avgGateToDock)],
          ['Average time at the dock (outbound)', mins(fm.avgDockTime)],
          ['Dock occupancy', pct1(fm.dockUtilisation)],
          ['Pallets in stock now', int(fm.stockPallets)],
        ],
      },
      { kind: 'text', text: `Limits (event rules): waiting > ${R.truckWaitMax} min, at the dock > ${R.dockStayMax} min, on site > ${R.turnaroundMax} min, ${R.yardQueueMax}+ trucks in the queue.`, tone: 'muted' },
    ],
  });

  // Dock occupancy by dock
  const hours: number[] = [];
  for (let h = Math.floor(p.from / 60); h * 60 < p.to; h++) hours.push(h);
  const minutes = Math.max(1, p.to - p.from);
  const docks = DOCKS.map((d) => {
    const busy = hours.reduce((a, h) => a + (s.logistics.dockBusy[d.id]?.get(h) ?? 0), 0);
    return { d, busy, share: busy / minutes };
  });
  sections.push({
    id: 'docks',
    title: 'Dock occupancy',
    basis: 'simulated',
    blocks: [
      {
        kind: 'bars',
        title: 'Occupied minutes per dock',
        unit: 'min',
        rows: docks.map((x) => ({ label: x.d.name, value: x.busy, display: `${int(x.busy)} min`, note: `${pct1(x.share)} of the period` })),
      },
    ],
  });

  // Delayed now
  const delayed = delayedTrucks(s);
  sections.push({
    id: 'delayed',
    title: 'Trucks past a limit now',
    basis: 'simulated',
    blocks: [
      {
        kind: 'table',
        head: ['Truck', 'Where', 'Minutes', 'Limit', 'Over by'],
        rows: delayed.map((d) => [{ text: d.label, vehicleId: d.id }, d.reason, `${int(d.minutes)} min`, `${d.limit} min`, `${int(d.minutes - d.limit)} min`]),
        align: ['l', 'l', 'r', 'r', 'r'],
        widths: ['auto', 40, 24, 22, 24],
        empty: 'No truck is past the waiting, dock or turnaround limit now.',
      },
    ],
  });

  // Events
  const query = eventQuery(per.key, ['logistics'], 'line');
  const evs = significantEvents(s, p, query);
  const rows = evs.map((e) => eventRow(s, e, finance, tariffs));
  const waiting = evs.filter((e) => e.type === 'truck-waiting');
  const detention = waiting.reduce((a, e) => a + (rows.find((r) => r.id === e.id)?.estimate ?? 0), 0);
  const byType = new Map<string, number>();
  for (const e of evs) byType.set(EVENT_TYPE_LABEL[e.type], (byType.get(EVENT_TYPE_LABEL[e.type]) ?? 0) + 1);
  sections.push({
    id: 'events',
    title: 'Movement & delay events',
    basis: 'simulated',
    tag: 'Simulated events · estimates',
    blocks: [
      ...(byType.size ? ([{ kind: 'kv', rows: [...byType.entries()].map(([k, n]) => [k, `${n} event${n === 1 ? '' : 's'}`] as [string, string]) }] as ReportBlock[]) : []),
      ...eventsTable(rows, finance.currency, 'No significant vehicle or logistics event in the period.', s.minute, query),
      ...(waiting.length
        ? ([
            {
              kind: 'total',
              label: 'Estimated truck detention cost',
              value: fmtMoney(finance.currency, detention),
              note: `Sum over the ${waiting.length} truck-waiting event${waiting.length === 1 ? '' : 's'} among the ${listedCount(rows.length)}: minutes beyond the ${R.truckWaitMax}-min waiting threshold × ${fmtMoney(finance.currency, finance.truckWaitCostPerHour)}/h (assumption, editable in ${ASSUMPTIONS_LOCATION}). Dock overstays and turnaround are tracked, not costed again.`,
            },
          ] as ReportBlock[])
        : []),
      ...evidenceBlocks(evidenceItems(s, evs, ['camera-snapshot'], 2), 'Evidence captured with these events'),
    ],
  });

  // Actions
  const derived: string[] = [...recurringPatterns(s, evs)];
  if (delayed[0]) derived.push(`${delayed[0].label} is ${int(delayed[0].minutes - delayed[0].limit)} min past the ${delayed[0].reason.toLowerCase()} limit — check the dock plan and the loading order.`);
  if (fm.waiting >= R.yardQueueMax) derived.push(`${fm.waiting} trucks are queuing for a dock (alert at ${R.yardQueueMax}) — free a dock or re-sequence arrivals.`);
  if (fm.avgTurnaround != null && fm.avgTurnaround > R.turnaroundMax) derived.push(`Average dwell (${int(fm.avgTurnaround)} min) is above the ${R.turnaroundMax}-min turnaround limit for the period.`);
  const actions = eventActions(evs);
  sections.push({
    id: 'actions',
    title: 'Actions & recommendations',
    blocks: [
      ...(derived.length ? ([{ kind: 'subhead', text: 'From the situation now and the period' }, { kind: 'list', items: derived }] as ReportBlock[]) : []),
      ...(actions.length ? ([{ kind: 'subhead', text: 'Open events' }, { kind: 'list', items: actions, numbered: true }] as ReportBlock[]) : []),
      ...(!actions.length && !derived.length ? ([{ kind: 'text', text: 'No movement or delay issue indicated by the data of this period.', tone: 'muted' }] as ReportBlock[]) : []),
      { kind: 'text', text: 'Vehicle positions are simulated at zone level — no GPS, indoor positioning or camera analytics is connected, so route deviation and pedestrian proximity cannot be assessed.', tone: 'muted' },
    ],
  });

  const nDelayed = new Set(delayed.map((d) => d.id)).size;
  const summary = `${int(fm.completedVisits)} truck visit${fm.completedVisits === 1 ? '' : 's'} completed${fm.avgTurnaround != null ? `, average dwell ${int(fm.avgTurnaround)} min (limit ${R.turnaroundMax})` : ''}. ${nDelayed ? `${nDelayed} truck${nDelayed === 1 ? '' : 's'} past a limit now` : 'No truck past a limit now'}; ${rows.length} movement or delay event${rows.length === 1 ? '' : 's'} in the period.`;

  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  return {
    type: 'fleet',
    typeLabel: REPORT_TYPE_LABEL.fleet,
    title: `${REPORT_TYPE_LABEL.fleet} — Whole site`,
    summary,
    period: { key: per.key, label: per.label, from: per.from, to: per.to, text: per.text },
    scope: { id: 'line', label: 'Whole site' },
    generatedAt: wallClock(generatedAt),
    generatedAtPlant: `${formatDateTime(s.minute)} (plant time)`,
    minute: s.minute,
    kpis,
    sections,
    events: rows,
    eventQuery: query,
    legend: LEGEND,
    fileName: reportFileName('fleet', 'line', per),
    disclaimer: opsDisclaimer(sections),
    currency: finance.currency,
  };
}
