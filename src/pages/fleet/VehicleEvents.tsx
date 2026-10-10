/**
 * Vehicle events of the period — the same OpEvent records Events & Reports, the PDF and the copilot
 * use (truck waiting, dock overstay, yard congestion, turnaround, restricted-zone entry). The focused
 * event shows its rule and threshold, observed values, impact (estimate · assumptions shown),
 * suspected causes, the visit / movement timeline captured as evidence at detection, the camera
 * view status, lifecycle quick actions, Show in 3D and the report.
 */
import { useState } from 'react';
import { Box, CircleCheck, CircleX, Eye, FileText, MessageSquareText, Search } from 'lucide-react';
import { openEvent, useApp } from '../../app/store';
import { focusEventInTwin } from '../../scene/events/focus';
import { GEOFENCES } from '../../model/plant';
import type { Evidence, OpEvent } from '../../model/types';
import { eventImpact } from '../../intel/report';
import { EVENT_TYPE_LABEL, eventById, evidenceOf } from '../../sim/events';
import { useSim, useSimValue } from '../../sim/store';
import { formatDuration } from '../../sim/time';
import { getImage } from '../../twin/bridge';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Empty, Panel, Segmented } from '../../ui/kit/Panel';
import { EventStatusBadge, SeverityBadge, SourceTag } from '../../ui/kit/Status';
import { EventReportView } from '../../ui/report/EventReportView';
import { fmtMoney, type Clock } from './common';
import { DOCK_NAME } from './derive';
import { snapshotEvidence, timelineEvidence } from './pipeline';

const GF_NAME = Object.fromEntries(GEOFENCES.map((g) => [g.id, g.name]));
const RANK = { info: 0, warning: 1, serious: 2, critical: 3 } as const;

/** Where an event is, for the table (vehicle id or the place). */
const placeOf = (e: OpEvent) =>
  e.asset.dockId ? (DOCK_NAME[e.asset.dockId] ?? e.asset.dockId) : e.asset.geofenceId ? (GF_NAME[e.asset.geofenceId] ?? e.asset.geofenceId) : '—';

/**
 * Show an event in the 3D twin: follow the vehicle while it is on site, otherwise frame the dock /
 * geofence equipment or the zone (a departed truck can no longer be followed).
 */
export function showEventInTwin(ev: OpEvent, onSite: boolean) {
  // focusEventInTwin follows the vehicle while it is on site, otherwise frames the dock / geofence,
  // and adds the focus ring + pin.
  void onSite;
  focusEventInTwin(ev);
}

export function VehicleEvents({
  events,
  periodLabel,
  clock,
  onSelectVehicle,
}: {
  events: OpEvent[];
  periodLabel: string;
  clock: Clock;
  onSelectVehicle: (id: string) => void;
}) {
  const now = useSimValue((s) => s.minute);
  const [scope, setScope] = useState<'open' | 'all'>('open');
  const [picked, setPicked] = useState<string | null>(null);
  const rows = scope === 'open' ? events.filter((e) => e.status !== 'resolved') : events;
  const focusId = picked && events.some((e) => e.id === picked) ? picked : (rows[0]?.id ?? null);
  const auto = focusId != null && focusId !== picked;
  const activeN = events.filter((e) => e.end == null).length;

  const cols: Column<OpEvent>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (e) => (
        <>
          <EventStatusBadge status={e.status} />
          <span className="sub">{e.end == null ? 'condition active' : `cleared ${clock(e.end)}`}</span>
        </>
      ),
      sort: (e) => e.status,
    },
    { key: 'sev', header: 'Severity', render: (e) => <SeverityBadge severity={e.severity} />, sort: (e) => RANK[e.severity] },
    {
      key: 'event',
      header: 'Event',
      render: (e) => (
        <span title={e.summary}>
          <span className="mono">{e.id}</span> {EVENT_TYPE_LABEL[e.type]}
        </span>
      ),
      sort: (e) => e.id,
    },
    {
      key: 'veh',
      header: 'Vehicle / place',
      render: (e) =>
        e.asset.vehicleId ? (
          <button
            className="row-link mono"
            title="Select this vehicle on the page"
            onClick={(x) => {
              x.stopPropagation();
              onSelectVehicle(e.asset.vehicleId!);
            }}
          >
            {e.asset.vehicleId}
          </button>
        ) : (
          <span className="dim">{placeOf(e)}</span>
        ),
      sort: (e) => e.asset.vehicleId ?? placeOf(e),
    },
    {
      key: 'rule',
      header: 'Rule',
      render: (e) => (
        <>
          <span className="mono">{e.trigger.ruleId}</span>
          {e.trigger.threshold && <span className="sub">{`${e.trigger.threshold.value}${e.trigger.threshold.unit ? ` ${e.trigger.threshold.unit}` : ''}`}</span>}
        </>
      ),
      sort: (e) => e.trigger.ruleId,
    },
    {
      key: 'since',
      header: 'Since',
      numeric: true,
      render: (e) => (
        <>
          {clock(e.start)}
          <span className="sub">{formatDuration((e.end ?? now) - e.start)}</span>
        </>
      ),
      sort: (e) => e.start,
    },
  ];

  return (
    <Panel
      title="Vehicle events"
      subtitle={`${activeN} with the condition active · ${events.length} touching ${periodLabel} · the same records as Events & Reports`}
      actions={
        <Segmented
          label="Event scope"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'all', label: 'All in period' },
          ]}
        />
      }
      flush
    >
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(e) => e.id}
        onRowClick={(e) => setPicked(e.id)}
        selectedKey={focusId}
        maxHeight={250}
        empty={scope === 'open' ? 'No open vehicle events — every vehicle rule is within its threshold' : 'No vehicle events in this period'}
      />
      {focusId ? <EventFocus key={focusId} id={focusId} auto={auto} clock={clock} onSelectVehicle={onSelectVehicle} /> : null}
    </Panel>
  );
}

function EventFocus({ id, auto, clock, onSelectVehicle }: { id: string; auto: boolean; clock: Clock; onSelectVehicle: (id: string) => void }) {
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const openCopilot = useApp((s) => s.openCopilot);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [report, setReport] = useState(false);
  const d = useSimValue(
    (s) => {
      const ev = eventById(s, id);
      if (!ev) return null;
      const vid = ev.asset.vehicleId;
      const v = vid ? s.logistics.vehicles[vid] : undefined;
      const snap = snapshotEvidence(s, ev);
      return {
        ev,
        status: ev.status,
        end: ev.end,
        owner: ev.owner,
        now: s.minute,
        vehicle: v ? { id: v.id, label: v.label, external: v.class === 'external', onSite: s.logistics.active.includes(v.id) && v.spawned <= s.minute } : null,
        timeline: timelineEvidence(s, ev),
        others: evidenceOf(s, ev).filter((x) => x.kind !== 'vehicle-timeline' && x.kind !== 'camera-snapshot'),
        snap,
        snapImg: snap?.image ? getImage(snap.image.key) : null,
        impact: eventImpact(s, ev, finance, tariffs),
      };
    },
    [id, finance, tariffs],
  );
  if (!d) return <Empty title={`${id} is no longer in the retained history`} />;
  const { ev, impact } = d;
  const canAck = d.status === 'active';
  const canInv = d.status === 'active' || d.status === 'acknowledged';
  const act = (kind: 'ack' | 'inv') => {
    const st = useSim.getState();
    const r = kind === 'ack' ? st.acknowledge(ev.id) : st.investigate(ev.id);
    setFeedback(
      r.ok ? { ok: true, text: `${kind === 'ack' ? 'Acknowledged' : 'Investigation started'} — the same record updates in Events & Reports and the report.` } : { ok: false, text: r.reason },
    );
  };
  const est = impact.estimate;

  return (
    <div className="fv-ev-focus" aria-label={`Event ${ev.id}`}>
      <div className="fv-ev-head">
        <EventStatusBadge status={d.status} />
        <SeverityBadge severity={ev.severity} />
        <span className="mono">{ev.id}</span>
        <b>{ev.title}</b>
        <span className="spacer" />
        <SourceTag source={ev.source} />
        {auto && (
          <span className="tag" title="Shown because it is the top event of the list; click a row to pick another">
            Top of list
          </span>
        )}
      </div>
      <p className="fv-ev-sum">{ev.summary}</p>
      <dl className="dl">
        <dt>Rule</dt>
        <dd>
          <span className="mono">{ev.trigger.ruleId}</span> {ev.trigger.description}
          {ev.trigger.threshold && (
            <span className="dim">
              {' '}
              · {ev.trigger.threshold.label.toLowerCase()} at detection {ev.trigger.threshold.value}
              {ev.trigger.threshold.unit ? ` ${ev.trigger.threshold.unit}` : ''}
            </span>
          )}
          {ev.trigger.observed.length > 0 && <div className="fv-ev-sub">{ev.trigger.observed.map((o) => `${o.label} ${o.value}${o.unit ? ` ${o.unit}` : ''}`).join(' · ')}</div>}
        </dd>
        <dt>Detected</dt>
        <dd>
          {clock(ev.start)} · {d.end == null ? `condition active for ${formatDuration(d.now - ev.start)}` : `condition cleared ${clock(d.end)} after ${formatDuration(d.end - ev.start)}`}
        </dd>
        <dt>Vehicle</dt>
        <dd>
          {d.vehicle ? (
            <button className="row-link" onClick={() => onSelectVehicle(d.vehicle!.id)} title="Select on this page">
              <span className="mono">{d.vehicle.id}</span>
            </button>
          ) : (
            <span className="dim">No single vehicle</span>
          )}
          <span className="dim">
            {' '}
            · {placeOf(ev)}
            {d.vehicle && !d.vehicle.onSite ? ' · vehicle has left the site' : ''}
          </span>
        </dd>
        <dt>Owner</dt>
        <dd>{d.owner ?? <span className="muted">Unassigned</span>}</dd>
        {impact.rows.map((r) => (
          <ImpactRow key={r.label} label={r.label} value={r.value} basis={r.basis} />
        ))}
        {est && est.total > 0 && (
          <>
            <dt>Estimated cost</dt>
            <dd>
              {fmtMoney(est.currency, est.total)} <span className="tag sim">estimate · assumptions shown</span>
              {est.lines.map((l) => (
                <div key={l.label} className="fv-ev-sub">
                  {l.label}: {fmtMoney(est.currency, l.amount)} — {l.basis}
                </div>
              ))}
              <details className="fv-ev-assume">
                <summary>Assumptions</summary>
                <ul>
                  {est.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </details>
            </dd>
          </>
        )}
        {impact.notes.map((n) => (
          <ImpactRow key={n} label="Note" value={n} />
        ))}
      </dl>

      {ev.causes.length > 0 && (
        <section className="fv-ev-sec">
          <h3>Suspected causes</h3>
          <ul className="fv-causes">
            {ev.causes.map((c) => (
              <li key={c.text}>
                <span className={`fv-conf ${c.confidence}`}>{c.confidence}</span>
                <span>
                  {c.text}
                  <span className="dim"> — {c.basis}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="fv-ev-sec">
        <h3>Timeline evidence</h3>
        {d.timeline.length ? (
          d.timeline.map((x) => <TimelineEvidence key={x.id} x={x} clock={clock} horizontal={!!d.vehicle?.external} />)
        ) : (
          <p className="fv-muted">No vehicle timeline is attached to this event (it is not about a single vehicle).</p>
        )}
        {d.others.map((x) => (
          <p key={x.id} className="fv-muted">
            {x.title} · {x.status === 'available' ? x.provenance.label : x.status === 'pending' ? 'being captured' : `unavailable — ${x.unavailableReason ?? 'no reason recorded'}`}
          </p>
        ))}
        {d.snap && (
          <div className="fv-ev-snap">
            {d.snap.status === 'available' && d.snapImg ? <img src={d.snapImg.dataUrl} alt={`${d.snap.title} — rendered from the digital twin`} /> : null}
            <span>
              <b>{d.snap.title}</b>
              <span className="dim">
                {d.snap.status === 'available'
                  ? d.snapImg
                    ? d.snap.provenance.origin === 'live-camera'
                      ? ` · ${d.snap.provenance.label}`
                      : ' · Simulated feed · rendered from the digital twin — not a camera image'
                    : ' · Rendered view not kept in this browser session'
                  : d.snap.status === 'pending'
                    ? ' · Being captured'
                    : ` · Unavailable — ${d.snap.unavailableReason ?? 'no reason recorded'}`}
              </span>
            </span>
          </div>
        )}
      </section>

      <div className="fv-ev-actions">
        <button className="btn sm primary" onClick={() => openEvent(ev.id)}>
          <FileText size={13} aria-hidden /> Open report
        </button>
        <button
          className="btn sm"
          onClick={() => showEventInTwin(ev, !!d.vehicle?.onSite)}
          title={d.vehicle ? (d.vehicle.onSite ? 'Follow the vehicle in the Factory Twin' : 'The vehicle has left — shows the place in the Factory Twin') : 'Show the place in the Factory Twin'}
        >
          <Box size={13} aria-hidden /> Show in 3D
        </button>
        <button className="btn sm" onClick={() => act('ack')} disabled={!canAck} title={canAck ? 'Acknowledge this event' : `Event is ${d.status}`}>
          <Eye size={13} aria-hidden /> Acknowledge
        </button>
        <button className="btn sm" onClick={() => act('inv')} disabled={!canInv} title={canInv ? 'Start the investigation' : `Event is ${d.status}`}>
          <Search size={13} aria-hidden /> Investigate
        </button>
        <button className="btn sm ghost" onClick={() => openCopilot(`Why did ${ev.id} happen?`, { eventId: ev.id })} title="Ask the rule-based copilot about this event">
          <MessageSquareText size={13} aria-hidden /> Ask copilot
        </button>
        <button className={`btn sm ghost ${report ? 'on' : ''}`} aria-expanded={report} onClick={() => setReport(!report)}>
          {report ? 'Hide report preview' : 'Report preview'}
        </button>
      </div>
      {feedback && (
        <p className={`fv-ev-fb ${feedback.ok ? 'ok' : 'err'}`} role="status">
          {feedback.ok ? <CircleCheck size={13} aria-hidden /> : <CircleX size={13} aria-hidden />} {feedback.text}
        </p>
      )}
      {report && (
        <div className="fv-ev-report">
          <EventReportView eventId={ev.id} compact />
        </div>
      )}
    </div>
  );
}

function ImpactRow({ label, value, basis }: { label: string; value: string; basis?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value}
        {basis && <div className="fv-ev-sub">{basis}</div>}
      </dd>
    </>
  );
}

/** A vehicle-timeline evidence record: milestones frozen when the event was detected. */
function TimelineEvidence({ x, clock, horizontal }: { x: Evidence; clock: Clock; horizontal: boolean }) {
  const ms = x.milestones ?? [];
  return (
    <div className="fv-evd">
      <div className="fv-evd-h">
        <b>{x.title}</b>
        <span className="dim">
          captured {clock(x.capturedAt)} · {x.provenance.label}
        </span>
      </div>
      {x.status !== 'available' ? (
        <p className="fv-muted">Unavailable — {x.unavailableReason ?? 'no reason recorded'}</p>
      ) : horizontal ? (
        <ol className="fv-steps">
          {ms.map((m) => (
            <li key={m.label} className={m.t == null ? 'pending' : ''}>
              <i aria-hidden />
              <span className="l">{m.label}</span>
              <span className="t">{m.t != null ? clock(m.t) : 'not yet'}</span>
              {m.note && <span className="n">{DOCK_NAME[m.note] ?? m.note}</span>}
            </li>
          ))}
        </ol>
      ) : (
        <ul className="fv-list">
          {ms.map((m, i) => (
            <li key={`${m.t}-${i}`}>
              <span className="t">{m.t != null ? clock(m.t) : '—'}</span>
              <span className="a">
                {m.label.replace(/ · (GF-[A-Z]+)$/, (_, g: string) => ` · ${GF_NAME[g] ?? g}`)}
                {m.note && <span className="dim"> · {m.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
