/**
 * Reliability tab of Events & Reports (?tab=reliability, brief §8 E): over one window, the own stops of the
 * line's machines and conveyors as a downtime Pareto (unplanned, changeover and planned kept apart), the
 * longest stops (linked to the asset and its event record), fault codes that recur on one asset, MTBF / MTTR
 * per asset ('Unavailable' with the reason when there is no failure or no repair), the equipment-state
 * timelines, the reliability rule findings and the communication / data-quality issues. Derivations:
 * ./reliability.ts (pure, tested).
 */
import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { openEquipment, openEvent, useApp } from '../../app/store';
import { useRuleThresholds } from '../../intel/rules';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { RankedBars, StateTimeline, type StateLegendItem } from '../../ui/kit/charts';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmt1, fmtInt } from '../../ui/kit/format';
import { EmptyState, Section, Unavailable } from '../../ui/kit/Page';
import { Segmented } from '../../ui/kit/Panel';
import { OPERATIONAL_STATE, SourceTag } from '../../ui/kit/Status';
import { FindingList } from './FindingList';
import {
  RELIABILITY_WINDOWS,
  STOP_CLASSES,
  STOP_CLASS_LABEL,
  downtimePareto,
  longestStoppages,
  reliabilityModel,
  type LongStop,
  type MtbfRow,
  type ParetoBy,
  type RecurringRow,
  type ReliabilityWindowKey,
} from './reliability';
import { useReliabilityView } from './state';

/** Operational states in the timeline legend (tones from the product's state scheme; patterns keep look-alikes apart). */
const STATE_LEGEND: StateLegendItem[] = [
  { state: 'running', label: OPERATIONAL_STATE.running.label, tone: 'good' },
  { state: 'reduced', label: OPERATIONAL_STATE.reduced.label, tone: 'warning', pattern: 'solid' },
  { state: 'starved', label: OPERATIONAL_STATE.starved.label, tone: 'warning', pattern: 'hatch' },
  { state: 'blocked', label: OPERATIONAL_STATE.blocked.label, tone: 'warning', pattern: 'dots' },
  { state: 'idle', label: OPERATIONAL_STATE.idle.label, tone: 'warning', pattern: 'hatch' },
  { state: 'fault', label: OPERATIONAL_STATE.fault.label, tone: 'critical', pattern: 'dots' },
  { state: 'stopped', label: OPERATIONAL_STATE.stopped.label, tone: 'critical', pattern: 'solid' },
  { state: 'changeover', label: OPERATIONAL_STATE.changeover.label, tone: 'planned', pattern: 'hatch' },
  { state: 'planned', label: OPERATIONAL_STATE.planned.label, tone: 'planned', pattern: 'solid' },
  { state: 'unknown', label: OPERATIONAL_STATE.unknown.label, tone: 'unknown', pattern: 'dots' },
  { state: 'disconnected', label: OPERATIONAL_STATE.disconnected.label, tone: 'unknown', pattern: 'hatch' },
];

const PARETO_BY: { value: ParetoBy; label: string }[] = [
  { value: 'reason', label: 'By reason' },
  { value: 'equipment', label: 'By equipment' },
];
const LANE_OPTIONS = [
  { value: 'machines' as const, label: 'Process machines' },
  { value: 'conveyors' as const, label: 'Conveyors' },
];

const calcText = (c: MtbfRow['mtbfH'], fmt: (v: number) => string) =>
  c.status === 'ok' ? <span className="num">{fmt(c.value)}</span> : <Unavailable reason={c.reason}>{c.status === 'invalid' ? 'Invalid' : 'Unavailable'}</Unavailable>;

export function ReliabilityView() {
  const v = useReliabilityView();
  const thresholds = useRuleThresholds((t) => t.version);
  const m = useSimValue((s) => reliabilityModel(s, v.window), [v.window, thresholds]);
  // A Pareto row narrows the longest-stops table to that reason / asset (cleared when the selection changes).
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => setFocus(null), [v.window, v.cls, v.by]);

  const pareto = useMemo(() => downtimePareto(m.stops, m.window, v.cls, v.by), [m, v.cls, v.by]);
  const longest = useMemo(
    () => longestStoppages(focus ? m.stops.filter((x) => (v.by === 'reason' ? x.reasonCode : x.equipmentId) === focus) : m.stops, m.window, v.cls, 8),
    [m, v.cls, v.by, focus],
  );
  const span = m.window.to - m.window.from;
  const at = (t: number) => (span > 1440 ? formatDateTime(t) : formatClock(t));
  const cls = STOP_CLASS_LABEL[v.cls].toLowerCase();
  const focusLabel = focus ? (pareto.find((r) => r.key === focus)?.label ?? focus) : null;

  const longColumns: Column<LongStop>[] = [
    {
      key: 'asset',
      header: 'Equipment',
      render: (x) => (
        <button className="row-link" onClick={() => openEquipment(x.equipmentId)} title="Open the equipment panel in the Factory Twin">
          {x.equipmentId} · {x.name}
        </button>
      ),
      sort: (x) => x.equipmentId,
    },
    { key: 'reason', header: 'Reason', render: (x) => <span title={x.reasonCode}>{x.reasonLabel}</span>, sort: (x) => x.reasonLabel ?? x.reasonCode },
    { key: 'start', header: 'Start', render: (x) => at(x.start), sort: (x) => x.start },
    {
      key: 'min',
      header: 'In window',
      numeric: true,
      title: 'Minutes inside the window; an open stop runs to now',
      render: (x) => (
        <span className="num">
          {formatDuration(x.minutes)}
          {x.ongoing && <span className="sub"> ongoing</span>}
        </span>
      ),
      sort: (x) => x.minutes,
    },
    {
      key: 'event',
      header: 'Event',
      render: (x) =>
        x.eventId ? (
          <button className="row-link" onClick={() => openEvent(x.eventId!)} title="Open the event record">
            {x.eventId}
          </button>
        ) : (
          <span className="muted" title="No event was raised for this stop (planned stops and changeovers raise none)">
            —
          </span>
        ),
    },
    { key: 'src', header: 'Source', render: (x) => <SourceTag source={x.source} /> },
  ];

  const recurColumns: Column<RecurringRow>[] = [
    {
      key: 'asset',
      header: 'Equipment',
      render: (r) => (
        <button className="row-link" onClick={() => openEquipment(r.equipmentId)} title="Open the equipment panel in the Factory Twin">
          {r.equipmentId} · {r.name}
        </button>
      ),
      sort: (r) => r.equipmentId,
    },
    { key: 'code', header: 'Fault code', render: (r) => <span title={r.reasonCode}>{r.label}</span>, sort: (r) => r.label },
    { key: 'n', header: 'Stops', numeric: true, render: (r) => fmtInt(r.count), sort: (r) => r.count },
    { key: 'total', header: 'Minutes', numeric: true, title: 'Minutes of these stops inside the window', render: (r) => formatDuration(r.totalMin), sort: (r) => r.totalMin },
    { key: 'mean', header: 'Mean', numeric: true, render: (r) => formatDuration(r.meanMin), sort: (r) => r.meanMin },
    { key: 'last', header: 'Last', render: (r) => at(r.lastAt), sort: (r) => r.lastAt },
  ];

  const mtbfColumns: Column<MtbfRow>[] = [
    {
      key: 'asset',
      header: 'Equipment',
      render: (r) => (
        <button className="row-link" onClick={() => openEquipment(r.equipmentId)} title="Open the equipment panel in the Factory Twin">
          {r.equipmentId} · {r.name}
        </button>
      ),
      sort: (r) => r.equipmentId,
    },
    { key: 'f', header: 'Failures', numeric: true, title: 'Unplanned stops starting in the window', render: (r) => fmtInt(r.failures), sort: (r) => r.failures },
    {
      key: 'op',
      header: 'Operating',
      numeric: true,
      title: 'Time the state timeline shows the asset available (running, below rate, idle, starved, blocked)',
      render: (r) =>
        r.operating.operatingMin == null ? (
          <Unavailable reason="No state history for this window" />
        ) : (
          <span className="num" title={r.operating.unknownMin ? `${formatDuration(r.operating.unknownMin)} in an unknown state (stale feed) not counted` : undefined}>
            {fmt1(r.operating.operatingMin / 60)} h{r.operating.unknownMin > 0 && <span className="sub"> +{formatDuration(r.operating.unknownMin)} unknown</span>}
          </span>
        ),
      sort: (r) => r.operating.operatingMin,
    },
    { key: 'mtbf', header: 'MTBF', numeric: true, title: 'Operating hours ÷ failures', render: (r) => calcText(r.mtbfH, (h) => `${fmt1(h)} h`), sort: (r) => r.mtbfH.value },
    { key: 'mttr', header: 'MTTR', numeric: true, title: 'Mean duration of the failures that have ended', render: (r) => calcText(r.mttrMin, formatDuration), sort: (r) => r.mttrMin.value },
  ];

  const rf = m.reliabilityFindings;
  const df = m.dataFindings;
  const lanes = m.lanes[v.lanes];

  return (
    <div className="rel">
      <div className="rel-bar" role="group" aria-label="Reliability window and stop class">
        <Segmented<ReliabilityWindowKey> label="Time window" value={v.window} options={RELIABILITY_WINDOWS as { value: ReliabilityWindowKey; label: string }[]} onChange={(window) => v.set({ window })} />
        <span className="rel-range">
          {formatDateTime(m.window.from)} – {formatClock(m.window.to)} · own stops from the simulated stop records
        </span>
      </div>

      <div className="rel-classes" role="radiogroup" aria-label="Stop class shown in the Pareto and the longest stops">
        {STOP_CLASSES.map((c) => {
          const t = m.totals[c];
          return (
            <button key={c} type="button" role="radio" aria-checked={v.cls === c} className={`rel-class ${v.cls === c ? 'on' : ''}`} onClick={() => v.set({ cls: c })}>
              <span className="rel-class-l">{STOP_CLASS_LABEL[c]} stops</span>
              <b className="num">{formatDuration(t.minutes)}</b>
              <span className="rel-class-s">
                {t.stops} stop{t.stops === 1 ? '' : 's'}
                {t.open ? ` · ${t.open} open` : ''}
              </span>
            </button>
          );
        })}
        <p className="rel-note">Each stop counts in one class only. Waits on a neighbour (starved / blocked) are not stops of the machine and are not counted.</p>
      </div>

      <div className="rel-grid">
        <Section
          title={`Downtime Pareto — ${cls} stops`}
          subtitle="Minutes in the window (an open stop runs to now), per asset counted once · cumulative share of the class total · select a row to list its longest stops"
          actions={<Segmented<ParetoBy> label="Group the Pareto" value={v.by} options={PARETO_BY} onChange={(by) => v.set({ by })} />}
        >
          {pareto.length ? (
            <RankedBars
              rows={pareto.map((r) => ({ key: r.key, label: `${r.label} · ${r.stops} stop${r.stops === 1 ? '' : 's'}`, value: r.minutes, share: r.share, cumulative: r.cumulative }))}
              format={formatDuration}
              valueHeader="Minutes"
              labelHeader={v.by === 'reason' ? 'Reason' : 'Equipment'}
              selectedKey={focus}
              onSelect={(r) => setFocus(focus === r.key ? null : r.key)}
            />
          ) : (
            <EmptyState title={`No ${cls} stop in the ${m.window.label}`}>The stop records hold none for this window — not a measured zero for assets without a feed.</EmptyState>
          )}
        </Section>

        <Section
          title={`Longest ${cls} stops`}
          subtitle={focusLabel ? `Only ${focusLabel}` : `The ${longest.length || ''} longest by minutes inside the window`.replace('  ', ' ')}
          flush
          actions={
            focus ? (
              <button className="btn ghost sm" onClick={() => setFocus(null)} aria-label="Show the longest stops of every reason and asset">
                <X size={12} aria-hidden /> All
              </button>
            ) : undefined
          }
        >
          <DataTable columns={longColumns} rows={longest} rowKey={(x) => x.id} maxHeight={360} empty={`No ${cls} stop in the ${m.window.label}`} />
        </Section>

        <Section title="Recurring fault codes" subtitle="The same reason on the same asset at least twice — unplanned stops starting in the window" flush>
          <DataTable
            columns={recurColumns}
            rows={m.recurring}
            rowKey={(r) => r.key}
            maxHeight={320}
            initialSort={{ key: 'n', dir: 'desc' }}
            empty={`No fault code occurred more than once on one asset in the ${m.window.label}`}
          />
        </Section>

        <Section title="MTBF / MTTR per asset" subtitle="Failures = unplanned stops starting in the window; changeovers and planned stops are not failures · no failure → MTBF unavailable, not infinite" flush>
          <DataTable columns={mtbfColumns} rows={m.mtbf} rowKey={(r) => r.equipmentId} maxHeight={320} initialSort={{ key: 'f', dir: 'desc' }} />
        </Section>
      </div>

      <Section
        title="Equipment states"
        subtitle={`State timeline of each tracked asset over the ${m.window.label} — from the state signal and the stop records; time without a record is shown as such`}
        actions={<Segmented label="Lanes" value={v.lanes} options={LANE_OPTIONS} onChange={(lanes) => v.set({ lanes })} />}
      >
        <StateTimeline label={`Equipment states, ${m.window.label}`} from={m.window.from} to={m.window.to} lanes={lanes} legend={STATE_LEGEND} laneHeight={16} />
      </Section>

      <div className="rel-grid">
        <Section
          title="Reliability rule findings"
          subtitle={`${rf.fired} detected · ${rf.insufficient} not evaluated · ${rf.clear} clear — evaluated now over each rule's own window, on simulated data`}
        >
          <FindingList findings={rf.shown} empty="No reliability rule has detected anything now" limit={8} />
        </Section>

        <Section
          title="Communication & data-quality issues"
          subtitle={`Data-feed events in the ${m.window.label} · ${df.fired} data-quality finding${df.fired === 1 ? '' : 's'} detected now`}
          actions={
            <button className="btn ghost sm" onClick={() => useApp.getState().setTab('events', 'data')}>
              Data & connectivity
            </button>
          }
        >
          <EventList events={m.communication} limit={6} empty={`No data-feed event in the ${m.window.label}`} />
          {df.shown.length > 0 && (
            <ul className="rel-dq" aria-label="Data-quality findings now">
              {df.shown.slice(0, 5).map((f) => (
                <li key={f.key}>
                  <b>{f.title}</b>
                  {f.firstSeen != null && <span className="muted"> · since {at(f.firstSeen)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
