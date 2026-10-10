/**
 * Factory Copilot (#/copilot) — the rule-based copilot as a workspace: a full-height conversation
 * (the same conversation store as the header drawer and the Command Center dock), suggested
 * questions grouped by use case, and a context panel with the situation now, the event being
 * investigated and a picker of active events that sets that context.
 * Nothing here is a language model: answers are assembled from the one simulation state.
 */
import { focusEventInTwin } from '../scene/events/focus';
import { useEffect, useState } from 'react';
import { Box, CircleCheck, ClipboardList, Clock, Crosshair, FlaskConical, OctagonX, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { openEquipment, openEvent, openStage, useApp } from '../app/store';
import { TARGET, MONITORED_STAGE_BY_ID } from '../model/plant';
import type { EventCategory, OpEvent } from '../model/types';
import { copilotEventReport, monitoredStage } from '../intel/copilot';
import { EVENT_CATEGORY_LABEL } from '../sim/events';
import { TARGET_STATUS_LABEL, type TargetStatus } from '../sim/metrics';
import { useSim, useSimValue } from '../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../sim/time';
import { CopilotPanel, QuestionGroups } from '../ui/copilot/CopilotPanel';
import { setCopilotContext, useCopilot } from '../ui/copilot/store';
import { Empty, Panel } from '../ui/kit/Panel';
import { EventStatusBadge, MetricText, OperationalStatus, SeverityBadge, StatusBadge, type Tone } from '../ui/kit/Status';
import { fmtInt, fmtPct } from '../ui/kit/format';
import { pickerEvents, situationNow } from './copilot/derive';
import './copilot.css';

/** From this width the suggested questions get their own column beside the conversation. */
const WIDE_QUERY = '(min-width: 1440px)';

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

export function CopilotPage() {
  // The picker filter starts fresh after Reset Demo (its events no longer exist).
  const resets = useSim((s) => s.resets);
  return <CopilotWorkspace key={resets} />;
}

function CopilotWorkspace() {
  const wide = useMediaQuery(WIDE_QUERY);
  const register = useCopilot((s) => s.registerDock);
  const ask = useCopilot((s) => s.ask);
  const [category, setCategory] = useState<EventCategory | null>(null);
  // While this page is open, the header Copilot button asks here instead of opening the drawer.
  useEffect(() => register(), [register]);

  return (
    <div className={`cpg ${wide ? 'wide' : ''}`}>
      {wide && (
        <aside className="cpg-col cpg-questions" aria-label="Suggested questions">
          <Panel title="Suggested questions" subtitle="Grouped by use case" className="cpg-panel">
            <QuestionGroups onAsk={(q) => ask(q)} />
          </Panel>
        </aside>
      )}
      <div className="cpg-conv">
        <CopilotPanel variant="page" suggestions={!wide} />
      </div>
      <aside className="cpg-col cpg-side" aria-label="Copilot context">
        <SituationPanel category={category} onCategory={setCategory} />
        <EventContextPanel />
        <PickerPanel category={category} onCategory={setCategory} />
      </aside>
    </div>
  );
}

// ── Situation now ─────────────────────────────────────────────────────────────

const TARGET_TONE: Record<TargetStatus, { tone: Tone; icon: LucideIcon }> = {
  none: { tone: 'neutral', icon: Clock },
  ahead: { tone: 'good', icon: CircleCheck },
  'on-track': { tone: 'good', icon: CircleCheck },
  behind: { tone: 'warning', icon: TriangleAlert },
  'well-behind': { tone: 'critical', icon: OctagonX },
};

function SituationPanel({ category, onCategory }: { category: EventCategory | null; onCategory: (c: EventCategory | null) => void }) {
  const st = useSimValue((s) => situationNow(s));
  const stage = monitoredStage(st.bottleneck.stage);
  return (
    <Panel
      title="Situation now"
      subtitle={`Plant time ${formatClock(st.minute)} · ${st.shiftLabel} · ${formatDuration(st.shiftElapsed)} elapsed`}
      actions={
        <span className="tag sim">
          <FlaskConical size={11} aria-hidden />
          Simulated
        </span>
      }
      className="cpg-panel"
    >
      <dl className="dl cpg-dl">
        <dt>Output vs plan</dt>
        <dd>
          <span className="num">
            {fmtInt(st.outputM2)} / {fmtInt(st.targetM2)} m²
          </span>
          {st.attainment != null && <span className="muted num"> · {fmtPct(st.attainment, 0)}</span>}
          <div>
            <StatusBadge {...TARGET_TONE[st.status]} label={TARGET_STATUS_LABEL[st.status]} />
          </div>
        </dd>
        <dt>Line OEE</dt>
        <dd>
          <MetricText m={st.oee} /> <span className="muted">· plan {fmtPct(TARGET.oeeTarget, 0)}</span>
        </dd>
        <dt>Bottleneck</dt>
        <dd>
          {stage ? (
            <button type="button" className="row-link" onClick={() => openStage(stage)} title={`Open ${MONITORED_STAGE_BY_ID[stage].name} in Production Monitoring`}>
              {st.bottleneck.name}
            </button>
          ) : (
            st.bottleneck.name
          )}
          <div className="muted">
            {st.bottleneck.shifted ? (st.bottleneck.cause === 'blocking' ? 'Blocking the kiln' : 'Starving the kiln') : 'Kiln, as designed'} · {st.bottleneck.windowLabel.toLowerCase()}
          </div>
        </dd>
        <dt>Stopped now</dt>
        <dd>
          {st.stopped.length === 0 ? (
            <span className="muted">No machine or conveyor stopped</span>
          ) : (
            <ul className="cpg-stopped">
              {st.stopped.slice(0, 5).map((x) => (
                <li key={x.id}>
                  <button type="button" className="row-link num" onClick={() => openEquipment(x.id)} title={`Locate ${x.name} in the Factory Twin`}>
                    {x.id}
                  </button>
                  <OperationalStatus state={x.state} />
                  <span className="muted num">since {formatClock(x.since)}</span>
                </li>
              ))}
              {st.stopped.length > 5 && <li className="muted">+{st.stopped.length - 5} more</li>}
            </ul>
          )}
        </dd>
        <dt>Trucks</dt>
        <dd className="num">
          {st.trucksOnSite} on site · {st.trucksWaiting} waiting for a dock
        </dd>
      </dl>

      <div className="cpg-sub-h">Active events by category</div>
      <table className="table cpg-cats">
        <thead>
          <tr>
            <th>Category</th>
            <th className="n">Active</th>
            <th>Highest</th>
          </tr>
        </thead>
        <tbody>
          {st.categories.map((r) => (
            <tr
              key={r.category}
              className={`${r.active ? 'clickable' : ''} ${category === r.category ? 'sel' : ''}`}
              onClick={r.active ? () => onCategory(category === r.category ? null : r.category) : undefined}
              onKeyDown={
                r.active
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onCategory(category === r.category ? null : r.category);
                      }
                    }
                  : undefined
              }
              tabIndex={r.active ? 0 : undefined}
              aria-selected={r.active ? category === r.category : undefined}
              title={r.active ? (category === r.category ? 'Show all active events in the picker' : `Show only ${r.label.toLowerCase()} events in the picker`) : undefined}
            >
              <td>{r.label}</td>
              <td className="n">{r.active || <span className="muted">0</span>}</td>
              <td>{r.worst ? <SeverityBadge severity={r.worst} /> : <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

// ── Event in context ──────────────────────────────────────────────────────────

function EventContextPanel() {
  const id = useApp((s) => s.copilotEventId);
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const ask = useCopilot((s) => s.ask);
  const rep = useSimValue((s) => (id ? copilotEventReport(s, id, finance, tariffs) : null), [id, finance, tariffs]);
  if (!id || !rep) return null;
  const ev = rep.event;
  const cause = rep.diagnosis.causes[0];
  const est = rep.impact.estimate;
  const valued = est && est.total > 0.005 ? est : null;
  const evidence = [...rep.visualEvidence, ...rep.supportingEvidence];
  const available = evidence.filter((x) => x.status === 'available').length;
  return (
    <Panel
      title={`Investigating ${ev.id}`}
      subtitle="Questions about “this event” are answered from its record"
      actions={
        <button type="button" className="btn ghost sm" onClick={() => setCopilotContext(null)} title="Clear the event context — ask plant-wide">
          <X size={13} aria-hidden />
          Clear
        </button>
      }
      className="cpg-panel cpg-ctx"
    >
      <div className="cpg-ctx-title">{ev.title}</div>
      <div className="cpg-badges">
        <SeverityBadge severity={ev.severity} />
        <EventStatusBadge status={ev.status} />
        <span className="tag">{ev.end == null ? 'Condition active' : `Cleared ${formatClock(ev.end)}`}</span>
        <span className="tag sim">{rep.summary.source === 'Scenario' ? 'Scenario' : 'Simulated'}</span>
      </div>
      <dl className="dl cpg-dl">
        <dt>Asset</dt>
        <dd>
          {rep.asset.kind} {rep.asset.id}
          {rep.asset.name !== rep.asset.id && <span className="muted"> · {rep.asset.name}</span>}
        </dd>
        <dt>Started</dt>
        <dd className="num">
          {formatDateTime(ev.start)} · {rep.summary.duration}
        </dd>
        <dt>Rule</dt>
        <dd>
          {rep.detection.rule} · {rep.detection.ruleLabel}
        </dd>
        <dt>Suspected cause</dt>
        <dd>
          {cause ? (
            <>
              <span className={`cp-conf cp-conf-${cause.confidence}`}>{cause.confidence.charAt(0).toUpperCase() + cause.confidence.slice(1)}</span>
              {cause.text}
            </>
          ) : (
            <span className="muted">None inferred yet</span>
          )}
        </dd>
        {ev.category === 'production' && (
          <>
            <dt>Kiln held up</dt>
            <dd className="num">{fmtInt(ev.acc.constraintMin)} min</dd>
          </>
        )}
        <dt>Impact</dt>
        <dd>
          {valued ? (
            <>
              <span className="num">
                ≈ {valued.currency} {fmtInt(valued.total)}
              </span>
              {ev.end == null && <span className="muted"> so far</span>}
              <div className="muted">Estimate · assumptions shown in the answer</div>
            </>
          ) : (
            <span className="muted">{ev.consequenceOf ? `Counted under ${ev.consequenceOf}` : 'No money estimate'}</span>
          )}
        </dd>
        <dt>Evidence</dt>
        <dd className="num">
          {available} available · {rep.provenance.unavailable.length} unavailable or pending
        </dd>
      </dl>
      <div className="cpg-actions">
        <button type="button" className="btn sm primary" onClick={() => ask('What happened?', { eventId: ev.id })} title={`Ask what happened in ${ev.id}`}>
          <Crosshair size={12} aria-hidden />
          Ask what happened
        </button>
        <button type="button" className="btn sm" onClick={() => openEvent(ev.id)} title="Open the full event report in Events & Reports">
          <ClipboardList size={12} aria-hidden />
          Open report
        </button>
        <button type="button" className="btn sm" onClick={() => focusEventInTwin(ev)} title="Show the affected asset, station, vehicle or zone in the Factory Twin">
          <Box size={12} aria-hidden />
          Show in twin
        </button>
      </div>
    </Panel>
  );
}

// ── Investigate an event ──────────────────────────────────────────────────────

function PickerPanel({ category, onCategory }: { category: EventCategory | null; onCategory: (c: EventCategory | null) => void }) {
  const selected = useApp((s) => s.copilotEventId);
  const events = useSimValue((s) => pickerEvents(s, category), [category]);
  const all = useSimValue((s) => pickerEvents(s, null));
  const minute = useSimValue((s) => s.minute);
  const counts = new Map<EventCategory, number>();
  for (const e of all) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const pick = (e: OpEvent) => {
    setCopilotContext(selected === e.id ? null : e.id);
    if (selected !== e.id) useCopilot.getState().focusDock();
  };
  return (
    <Panel
      title="Investigate an event"
      subtitle="Active events, most urgent first — pick one to ask about it"
      actions={
        <select
          className="select"
          value={category ?? ''}
          onChange={(e) => onCategory((e.target.value || null) as EventCategory | null)}
          aria-label="Filter active events by category"
        >
          <option value="">All categories ({all.length})</option>
          {[...counts.entries()].map(([c, n]) => (
            <option key={c} value={c}>
              {EVENT_CATEGORY_LABEL[c]} ({n})
            </option>
          ))}
          {category && !counts.has(category) && <option value={category}>{EVENT_CATEGORY_LABEL[category]} (0)</option>}
        </select>
      }
      className="cpg-panel"
      flush
    >
      {events.length === 0 ? (
        <Empty title={category ? `No active ${EVENT_CATEGORY_LABEL[category].toLowerCase()} event` : 'No active event'}>
          {category ? 'Choose another category or all categories.' : 'Every condition has cleared. Trigger a scenario to create one.'}
        </Empty>
      ) : (
        <ul className="cpg-events" aria-label="Active events">
          {events.map((e) => (
            <li key={e.id}>
              <button type="button" aria-pressed={selected === e.id} className={`cpg-ev ${selected === e.id ? 'sel' : ''}`} onClick={() => pick(e)}>
                <span className="cpg-ev-top">
                  <SeverityBadge severity={e.severity} />
                  <b className="num">{e.id}</b>
                  <span className="spacer" />
                  <span className="muted num">{formatDuration(minute - e.start)}</span>
                </span>
                <span className="cpg-ev-title">{e.title}</span>
                <span className="cpg-ev-sub muted">
                  {EVENT_CATEGORY_LABEL[e.category]}
                  {e.asset.equipmentId || e.asset.vehicleId || e.asset.stationId ? ` · ${e.asset.equipmentId ?? e.asset.vehicleId ?? e.asset.stationId}` : ''}
                  {e.consequenceOf ? ` · consequence of ${e.consequenceOf}` : ''}
                  {e.acc.constraintMin > 0 ? ` · kiln held up ${fmtInt(e.acc.constraintMin)} min` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
