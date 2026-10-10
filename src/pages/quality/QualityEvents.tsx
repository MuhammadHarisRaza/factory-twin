/**
 * Quality events of the period — the same OpEvent records Events & Reports, the PDF and the copilot
 * use. Open events with status, rule and counts; the focused event with its evidence frames,
 * lifecycle quick actions, "Show in 3D", "Open report" and an in-page preview of the report.
 */
import { focusEventInTwin } from '../../scene/events/focus';
import { useState } from 'react';
import { Box, CircleCheck, CircleX, Eye, FileText, MessageSquareText, Search } from 'lucide-react';
import type { OpEvent } from '../../model/types';
import { openEvent, useApp } from '../../app/store';
import { EVENT_TYPE_LABEL, eventById, evidenceOf } from '../../sim/events';
import { useSim, useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { getImage } from '../../twin/bridge';
import { EventList } from '../../ui/events/EventList';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Empty, Panel } from '../../ui/kit/Panel';
import { EventStatusBadge, SeverityBadge, SourceTag } from '../../ui/kit/Status';
import { EventReportView } from '../../ui/report/EventReportView';
import { eventImpact } from '../../intel/report';
import { eventRule, fmtMoney, impactFigures } from './derive';
import { FrameThumb } from './FrameArt';
import { frameById } from './frames';

export type ImpactFigures = ReturnType<typeof impactFigures>;

type Props = {
  open: OpEvent[];
  resolved: OpEvent[];
  impacts: Map<string, ImpactFigures>;
  focusId: string | null;
  /** True when the focus follows the selected record / the top open event rather than a click. */
  focusAuto: boolean;
  periodLabel: string;
  onFocus: (id: string) => void;
  /** Pin an inspection record in the vision viewer (keeps the event in focus). */
  onPinRecord: (id: string) => void;
};

export function QualityEvents({ open, resolved, impacts, focusId, focusAuto, periodLabel, onFocus, onPinRecord }: Props) {
  const now = useSimValue((s) => s.minute);
  const cols: Column<OpEvent>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (e) => (
        <>
          <EventStatusBadge status={e.status} />
          <span className="sub">{e.end == null ? 'condition active' : `cleared ${formatClock(e.end)}`}</span>
        </>
      ),
      sort: (e) => e.status,
    },
    { key: 'sev', header: 'Severity', render: (e) => <SeverityBadge severity={e.severity} />, sort: (e) => ['info', 'warning', 'serious', 'critical'].indexOf(e.severity) },
    {
      key: 'event',
      header: 'Event',
      render: (e) => (
        <span className="q-ev-cell" title={e.summary}>
          <span className="mono">{e.id}</span> {e.title}
        </span>
      ),
      sort: (e) => e.id,
    },
    {
      key: 'rule',
      header: 'Rule',
      render: (e) => (
        <span title={EVENT_TYPE_LABEL[e.type]}>
          <span className="mono">{e.trigger.ruleId}</span>
          {e.trigger.threshold && <span className="sub">{`${e.trigger.threshold.value}${e.trigger.threshold.unit ? ` ${e.trigger.threshold.unit}` : ''}`}</span>}
        </span>
      ),
      sort: (e) => e.trigger.ruleId,
    },
    {
      key: 'counts',
      header: 'Rejected',
      numeric: true,
      title: 'Rejected tiles in the event window (category, if the rule is per category) and tiles inspected — same figures as the report',
      render: (e) => {
        const f = impacts.get(e.id);
        return (
          <>
            {f?.rejected ?? '—'}
            <span className="sub">of {f?.inspected ?? '—'}</span>
          </>
        );
      },
    },
    {
      key: 'since',
      header: 'Since',
      numeric: true,
      render: (e) => (
        <>
          {formatClock(e.start)}
          <span className="sub">{formatDuration((e.end ?? now) - e.start)}</span>
        </>
      ),
      sort: (e) => e.start,
    },
  ];

  return (
    <Panel
      title="Quality events"
      subtitle={`Open now and resolved in ${periodLabel.toLowerCase()} · the same records as Events & Reports`}
      flush
      footer={
        <div className="q-ev-resolved">
          <span className="q-ev-k">Resolved in the period</span>
          <EventList events={resolved} limit={6} hideAsset empty="No resolved quality events in this period" />
        </div>
      }
    >
      <DataTable
        columns={cols}
        rows={open}
        rowKey={(e) => e.id}
        onRowClick={(e) => onFocus(e.id)}
        selectedKey={focusId}
        maxHeight={260}
        empty="No open quality events — every quality rule is below its threshold"
      />
      {focusId ? <EventFocus key={focusId} id={focusId} auto={focusAuto} impact={impacts.get(focusId) ?? null} onPinRecord={onPinRecord} /> : null}
    </Panel>
  );
}

function EventFocus({ id, auto, impact: given, onPinRecord }: { id: string; auto: boolean; impact: ImpactFigures | null; onPinRecord: (id: string) => void }) {
  const openCopilot = useApp((s) => s.openCopilot);
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [report, setReport] = useState(false);
  const d = useSimValue(
    (s) => {
      const ev = eventById(s, id);
      if (!ev) return null;
      const evidence = evidenceOf(s, ev);
      const ids = [...new Set([...(ev.refs.inspectionIds ?? []), ...evidence.filter((x) => x.kind === 'inspection-image' && x.inspectionId).map((x) => x.inspectionId!)])];
      const frames = ids.map((rid) => ({ id: rid, frame: frameById(s, rid) }));
      const missing = evidence.filter((x) => x.kind === 'inspection-image' && x.status !== 'available');
      const snap = evidence.find((x) => x.kind === 'camera-snapshot') ?? null;
      return {
        ev,
        status: ev.status,
        end: ev.end,
        owner: ev.owner,
        now: s.minute,
        frames,
        missing,
        snap,
        snapImg: snap?.image ? getImage(snap.image.key) : null,
        rule: eventRule(s, ev),
        // Events outside the period lists (reached from an older record) get the same report figures.
        impact: given ?? impactFigures(eventImpact(s, ev, finance, tariffs)),
      };
    },
    [id, given, finance, tariffs],
  );
  if (!d) return <Empty title={`${id} is no longer in the retained history`} />;
  const { ev, rule, impact } = d;
  const canAck = d.status === 'active';
  const canInv = d.status === 'active' || d.status === 'acknowledged';
  const act = (kind: 'ack' | 'inv') => {
    const st = useSim.getState();
    const r = kind === 'ack' ? st.acknowledge(ev.id) : st.investigate(ev.id);
    setFeedback(r.ok ? { ok: true, text: `${kind === 'ack' ? 'Acknowledged' : 'Investigation started'} — the same record updates in Events & Reports and the report.` } : { ok: false, text: r.reason });
  };

  return (
    <div className="q-ev-focus" aria-label={`Event ${ev.id}`}>
      <div className="q-ev-head">
        <EventStatusBadge status={d.status} />
        <SeverityBadge severity={ev.severity} />
        <span className="mono">{ev.id}</span>
        <b>{ev.title}</b>
        <span className="spacer" />
        <SourceTag source={ev.source} />
        {auto && <span className="tag" title="Shown because it is linked to the selected record, or the top open event">Auto-selected</span>}
      </div>
      <p className="q-ev-sum">{ev.summary}</p>
      <dl className="dl">
        <dt>Rule</dt>
        <dd>
          <span className="mono">{rule.id}</span> {rule.label}
          {rule.threshold && <span className="muted"> · threshold at detection {rule.threshold}</span>}
          <div className="q-vd-sub">{ev.trigger.observed.map((o) => `${o.label} ${o.value}${o.unit ? ` ${o.unit}` : ''}`).join(' · ')}</div>
        </dd>
        <dt>Detected</dt>
        <dd>
          {formatDateTime(ev.start)} · {d.end == null ? `condition active for ${formatDuration(d.now - ev.start)}` : `condition cleared ${formatClock(d.end)}`}
        </dd>
        <dt>Counts</dt>
        <dd>
          {impact?.rejected ?? '—'} rejected of {impact?.inspected ?? '—'} inspected
          {impact?.excess && <div className="q-vd-sub">Excess over the 24 h reference: {impact.excess}</div>}
        </dd>
        <dt>Quality rate</dt>
        <dd>{impact?.rateEffect ?? <span className="muted">No reference rate — effect not estimated</span>}</dd>
        <dt>Scrap & rework</dt>
        <dd>
          {impact?.total != null ? fmtMoney(impact.currency ?? '', impact.total) : '—'} <span className="tag sim">estimate · assumptions shown</span>
        </dd>
        <dt>Owner</dt>
        <dd>{d.owner ?? <span className="muted">Unassigned</span>}</dd>
      </dl>

      <section className="q-ev-evd">
        <h3>Evidence frames</h3>
        {d.frames.length ? (
          <div className="q-ev-frames">
            {d.frames.map(({ id: rid, frame }) =>
              frame ? (
                <button key={rid} className="q-ev-frame" onClick={() => onPinRecord(rid)} title={`Pin ${rid} in the vision viewer`}>
                  <FrameThumb frame={frame} />
                  <span className="mono">{rid}</span>
                  <span className="dim num">{formatClock(frame.time)}</span>
                </button>
              ) : (
                <span key={rid} className="q-ev-frame gone" title="Record no longer in the retained history">
                  <span className="mono">{rid}</span>
                  <span className="dim">not retained</span>
                </span>
              ),
            )}
          </div>
        ) : (
          <p className="muted">{d.missing[0]?.unavailableReason ? `Unavailable — ${d.missing[0].unavailableReason}` : 'No inspection frame is linked to this event.'}</p>
        )}
        <p className="q-ev-note">Illustrative frames of simulated records · simulated classification — no vision model.</p>
        {d.snap && (
          <div className="q-ev-snap">
            {d.snap.status === 'available' && d.snapImg ? (
              <img src={d.snapImg.dataUrl} alt={`${d.snap.title} — rendered from the digital twin`} />
            ) : null}
            <span>
              <b>{d.snap.title}</b>
              <span className="dim">
                {d.snap.status === 'available'
                  ? d.snapImg
                    ? ' · Rendered from the digital twin — not a camera image'
                    : ' · Rendered view not in this browser session'
                  : d.snap.status === 'pending'
                    ? ' · Being captured'
                    : ` · Unavailable — ${d.snap.unavailableReason ?? 'no reason recorded'}`}
              </span>
            </span>
          </div>
        )}
      </section>

      <div className="q-actions">
        <button className="btn sm primary" onClick={() => openEvent(ev.id)}>
          <FileText size={13} /> Open report
        </button>
        <button className="btn sm" onClick={() => focusEventInTwin(ev)} title="Show the inspection station in the Factory Twin">
          <Box size={13} /> Show in 3D
        </button>
        <button className="btn sm" onClick={() => act('ack')} disabled={!canAck} title={canAck ? 'Acknowledge this event' : `Event is ${d.status}`}>
          <Eye size={13} /> Acknowledge
        </button>
        <button className="btn sm" onClick={() => act('inv')} disabled={!canInv} title={canInv ? 'Start the investigation' : `Event is ${d.status}`}>
          <Search size={13} /> Investigate
        </button>
        <button className="btn sm ghost" onClick={() => openCopilot(`Why did ${ev.id} happen?`, { eventId: ev.id })} title="Ask the rule-based copilot about this event">
          <MessageSquareText size={13} /> Ask copilot
        </button>
        <button className={`btn sm ghost ${report ? 'on' : ''}`} aria-expanded={report} onClick={() => setReport(!report)}>
          {report ? 'Hide report preview' : 'Report preview'}
        </button>
      </div>
      {feedback && (
        <p className={`q-ev-fb ${feedback.ok ? 'ok' : 'err'}`} role="status">
          {feedback.ok ? <CircleCheck size={13} aria-hidden /> : <CircleX size={13} aria-hidden />} {feedback.text}
        </p>
      )}
      {report && (
        <div className="q-ev-report">
          <EventReportView eventId={ev.id} compact />
        </div>
      )}
    </div>
  );
}
