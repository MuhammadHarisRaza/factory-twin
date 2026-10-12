/**
 * Copilot (#/copilot) — the rule-based operational assistant as a focused workspace: the
 * conversation with its question box and context chips (current shift, incident in context) as the
 * one work area; beside it the suggested questions, the incident picker (the issues requiring
 * attention, ranked as on the Overview) and the incident in context. The same engine and
 * conversation as the header drawer. Nothing here is a language model or an external service:
 * answers are assembled from the one simulation state.
 */
import { useEffect, useState } from 'react';
import { Box, ClipboardList, Crosshair, ListFilter, SlidersHorizontal, X } from 'lucide-react';
import { openEvent, openEventInTwin, useApp } from '../app/store';
import { INCIDENT_QUESTION, copilotEventReport } from '../intel/copilot';
import type { OpEvent } from '../model/types';
import { useSim, useSimValue } from '../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../sim/time';
import { CopilotPanel, QuestionGroups } from '../ui/copilot/CopilotPanel';
import { setCopilotContext, useCopilot, useCopilotContext } from '../ui/copilot/store';
import { EmptyState, Facts, PageHeader, ProvenanceBadge, Section } from '../ui/kit/Page';
import { EventStatusBadge, SeverityBadge } from '../ui/kit/Status';
import { copilotSummary, pickerEvents } from './copilot/derive';
import './copilot/copilot-page.css';

export function CopilotPage() {
  // The page starts fresh after Reset Demo (its events no longer exist).
  const resets = useSim((s) => s.resets);
  return <CopilotWorkspace key={resets} />;
}

function CopilotWorkspace() {
  const register = useCopilot((s) => s.registerDock);
  const ask = useCopilot((s) => s.ask);
  // While this page is open, the header Ask button asks here instead of opening the drawer.
  useEffect(() => register(), [register]);
  const sum = useSimValue((s) => copilotSummary(s));
  const minute = useSimValue((s) => s.minute);

  return (
    <div className="wp cpg">
      <PageHeader
        title="Copilot"
        context={
          <>
            <span>Rule-based assistant over the simulated plant state — no language model, no external service</span>
            <span className="num">
              Plant time {formatClock(minute)} · {sum.scope}
            </span>
          </>
        }
        summary={sum.sentence}
        provenance="simulated"
      />
      <div className="cpg-work">
        <div className="cpg-main">
          <CopilotPanel variant="page" suggestions={false} />
        </div>
        <aside className="cpg-side" aria-label="Questions and incidents">
          <Section title="Suggested questions" subtitle="Answered from the same KPIs and event records as the workspaces">
            <QuestionGroups onAsk={(q) => ask(q)} />
          </Section>
          <IncidentContext />
          <IncidentPicker />
        </aside>
      </div>
    </div>
  );
}

// ── Investigate an incident ───────────────────────────────────────────────────

const SHOWN = 6;

function IncidentPicker() {
  const ctx = useCopilotContext();
  const ask = useCopilot((s) => s.ask);
  const [all, setAll] = useState(false);
  const d = useSimValue((s) => ({
    now: s.minute,
    list: pickerEvents(s).map((e) => ({ e, asset: e.asset.vehicleId ? (s.logistics.vehicles[e.asset.vehicleId]?.label ?? e.asset.vehicleId) : (e.asset.equipmentId ?? e.asset.stationId ?? e.asset.dockId ?? e.asset.zone ?? null) })),
  }));
  const pick = (e: OpEvent) => {
    if (ctx.event?.id === e.id) return setCopilotContext(null);
    setCopilotContext(e.id);
    ask(INCIDENT_QUESTION, { eventId: e.id });
  };
  const shown = all ? d.list : d.list.slice(0, SHOWN);
  return (
    <Section
      title="Investigate an incident"
      subtitle="Issues requiring attention, ranked as on the Overview — pick one to ask what happened"
      actions={<span className="muted num">{d.list.length} open</span>}
      flush
    >
      {d.list.length === 0 ? (
        <EmptyState
          title="No issue requires attention"
          action={
            <button type="button" className="btn sm" onClick={() => useApp.getState().setScenariosOpen(true)}>
              <SlidersHorizontal size={13} aria-hidden />
              Open scenarios
            </button>
          }
        >
          Every warning-or-above event is resolved. A scenario (a breakdown, a conveyor stop, a truck delay) creates one to investigate.
        </EmptyState>
      ) : (
        <>
          <ul className="cpg-events" aria-label="Incidents">
            {shown.map(({ e, asset }) => {
              const on = ctx.event?.id === e.id;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    className={`cpg-ev ${on ? 'sel' : ''}`}
                    onClick={() => pick(e)}
                    title={on ? `Stop asking about ${e.id}` : `Ask what happened during ${e.id}`}
                  >
                    <span className="cpg-ev-top">
                      <SeverityBadge severity={e.severity} />
                      <b className="num">{e.id}</b>
                      {e.source === 'scenario' && <ProvenanceBadge kind="scenario" />}
                      <span className="spacer" />
                      <span className="muted num">{e.end == null ? formatDuration(d.now - e.start) : `cleared ${formatClock(e.end)}`}</span>
                    </span>
                    <span className="cpg-ev-title">{e.title}</span>
                    {asset && <span className="cpg-ev-sub muted">{asset}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {d.list.length > SHOWN && (
            <div className="cpg-more">
              <button type="button" className="btn ghost sm" onClick={() => setAll(!all)} aria-expanded={all}>
                <ListFilter size={13} aria-hidden />
                {all ? `Show the first ${SHOWN}` : `Show all ${d.list.length}`}
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ── Incident in context ───────────────────────────────────────────────────────

function IncidentContext() {
  const ctx = useCopilotContext();
  const ask = useCopilot((s) => s.ask);
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const id = ctx.event?.id ?? null;
  const rep = useSimValue((s) => (id ? copilotEventReport(s, id, finance, tariffs) : null), [id, finance, tariffs]);
  if (!id || !rep) return null;
  const ev = rep.event;
  const cause = rep.diagnosis.causes[0];
  const evidence = [...rep.visualEvidence, ...rep.supportingEvidence];
  const available = evidence.filter((x) => x.status === 'available').length;
  return (
    <Section
      title={`Incident in context · ${ev.id}`}
      subtitle="Questions about “this incident” are answered from its record"
      className="cpg-ctx"
      actions={
        <button type="button" className="btn ghost sm" onClick={() => setCopilotContext(null)} title="Remove the incident context — ask plant-wide">
          <X size={13} aria-hidden />
          Remove
        </button>
      }
    >
      <div className="cpg-ctx-title">{ev.title}</div>
      <div className="cpg-badges">
        <SeverityBadge severity={ev.severity} />
        <EventStatusBadge status={ev.status} />
        <span className="tag">{ev.end == null ? 'Condition active' : `Cleared ${formatClock(ev.end)}`}</span>
        <ProvenanceBadge kind={rep.summary.source === 'Scenario' ? 'scenario' : 'simulated'} />
      </div>
      <Facts
        rows={[
          { label: 'Asset', value: `${rep.asset.kind} ${rep.asset.id}${rep.asset.name !== rep.asset.id ? ` · ${rep.asset.name}` : ''}` },
          { label: 'Started', value: `${formatDateTime(ev.start)} · ${rep.summary.duration}` },
          { label: 'Detected by', value: `${rep.detection.rule} · ${rep.detection.ruleLabel}` },
          {
            label: 'Suspected cause',
            value: cause ? (
              <>
                <span className={`cp-conf cp-conf-${cause.confidence}`}>{cause.confidence.charAt(0).toUpperCase() + cause.confidence.slice(1)}</span>
                {cause.text}
              </>
            ) : (
              <span className="muted">None inferred yet</span>
            ),
          },
          { label: 'Evidence', value: `${available} available · ${rep.provenance.unavailable.length} unavailable or pending` },
        ]}
      />
      <div className="cpg-actions">
        <button type="button" className="btn sm primary" onClick={() => ask(INCIDENT_QUESTION, { eventId: ev.id })} title={`Ask what happened during ${ev.id}`}>
          <Crosshair size={12} aria-hidden />
          What happened?
        </button>
        <button type="button" className="btn sm" onClick={() => openEvent(ev.id)} title="Open the full event report in Events & Reports">
          <ClipboardList size={12} aria-hidden />
          Open report
        </button>
        <button type="button" className="btn sm" onClick={() => openEventInTwin(ev)} title="Show the affected asset, station, vehicle or zone in the Factory Twin">
          <Box size={12} aria-hidden />
          Show in twin
        </button>
      </div>
    </Section>
  );
}
