/**
 * Reports tab of Events & Reports — the report builder. Pick one of five report types, the period
 * (the same periods as the header selector, resolved with resolvePeriod) and the scope where it
 * applies; the preview renders the report model live and "Download PDF" exports that very model
 * (src/report/ops — the PDF arranges the same object, it never recomputes or hard-codes figures).
 * The incident investigation is the per-event report (src/intel/report.ts buildEventReport) and its PDF.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ClipboardList, Factory, FileDown, Gauge, LoaderCircle, ShieldCheck, Truck, type LucideIcon } from 'lucide-react';
import { useApp } from '../../app/store';
import { attentionEvents } from '../../intel/kpis';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import { exportEventPdf, exportOpsPdf } from '../../report/pdf';
import { REPORT_PERIODS, REPORT_TYPES, REPORT_TYPE_BY_ID, buildOpsReport, effectiveScope, type OpsReport, type ReportScope, type ReportType } from '../../report/ops';
import { reportPeriod } from '../../report/ops/common';
import type { SimState } from '../../sim/engine';
import { PERIOD_LABELS } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { formatClock, formatDateTime } from '../../sim/time';
import { EmptyState, Section } from '../../ui/kit/Page';
import { Segmented } from '../../ui/kit/Panel';
import { EventReportView } from '../../ui/report/EventReportView';
import { OpsReportView, ReportLegend } from '../../ui/report/OpsReportView';
import { openReportEvents, useReportBuilder } from './state';

const TYPE_ICON: Record<ReportType, LucideIcon> = { shift: Factory, oee: Gauge, quality: ShieldCheck, fleet: Truck, incident: ClipboardList };
const PERIOD_SHORT: Record<(typeof REPORT_PERIODS)[number], string> = { shift: 'Current shift', 'prev-shift': 'Previous shift', today: 'Today', '24h': 'Last 24 h', '7d': 'Last 7 days' };

/** Minimum wall-clock interval between preview rebuilds while the simulation runs (ms). */
const PREVIEW_INTERVAL = 800;

/**
 * The simulation state version the preview is built at: follows the live version, but at most every
 * PREVIEW_INTERVAL ms, so a 7-day report is not rebuilt for every simulated minute at high speed.
 */
function useThrottledVersion() {
  const version = useSim((s) => s.version);
  const [shown, setShown] = useState(version);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (version === shown || pending.current != null) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      setShown(useSim.getState().version);
    }, PREVIEW_INTERVAL);
  }, [version, shown]);
  useEffect(
    () => () => {
      // Also reset the marker: StrictMode re-mounts the component and the throttle must start again.
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    },
    [],
  );
  return shown;
}

/** Events offered for an incident investigation: the ones needing attention, then the most recent. */
function incidentChoices(s: SimState, current: string | null) {
  const out = new Map<string, { id: string; label: string }>();
  const add = (e: SimState['events'][number]) => out.set(e.id, { id: e.id, label: `${e.id} · ${e.title}${e.end == null ? ' (ongoing)' : ''}` });
  for (const e of attentionEvents(s).slice(0, 15)) add(e);
  for (const e of [...s.events].sort((a, b) => b.start - a.start).slice(0, 40)) if (!out.has(e.id)) add(e);
  if (current && !out.has(current)) {
    const e = s.events.find((x) => x.id === current);
    if (e) add(e);
  }
  return [...out.values()];
}

function ExportButton({ run, label = 'Download PDF', title }: { run: () => Promise<string>; label?: string; title: string }) {
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: string | null }>({ busy: false, error: null, saved: null });
  return (
    <div className="rb-export">
      <button
        className="btn primary"
        disabled={state.busy}
        onClick={() => {
          setState({ busy: true, error: null, saved: null });
          run()
            .then((saved) => setState({ busy: false, error: null, saved }))
            .catch((e: unknown) => setState({ busy: false, error: e instanceof Error ? e.message : 'The PDF could not be created', saved: null }));
        }}
        title={title}
      >
        {state.busy ? <LoaderCircle size={14} className="spin" aria-hidden /> : <FileDown size={14} aria-hidden />}
        {state.busy ? 'Preparing PDF…' : label}
      </button>
      {state.error && (
        <span className="rb-err" role="alert">
          {state.error}
        </span>
      )}
      {state.saved && (
        <span className="rb-saved" role="status">
          Saved {state.saved}
        </span>
      )}
    </div>
  );
}

export function ReportsView() {
  const { type, period, scope, eventId } = useReportBuilder();
  const setB = useReportBuilder((s) => s.set);
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  const selectedEventId = useApp((s) => s.selectedEventId);
  const sim = useSim((s) => s.sim);
  const resetting = useSim((s) => s.resetting);
  const version = useThrottledVersion();
  const def = REPORT_TYPE_BY_ID[type];
  const sc: ReportScope = effectiveScope(type, scope);

  const model = useMemo<OpsReport | null>(
    () => (type === 'incident' ? null : buildOpsReport(sim, type, { period, scope: sc, finance, tariffs })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sim, version, type, period, sc, finance, tariffs],
  );
  const choices = useMemo(() => (type === 'incident' ? incidentChoices(sim, eventId ?? selectedEventId) : []), [sim, version, type, eventId, selectedEventId]);
  const incidentId = type === 'incident' ? (eventId && choices.some((c) => c.id === eventId) ? eventId : selectedEventId && choices.some((c) => c.id === selectedEventId) ? selectedEventId : (choices[0]?.id ?? null)) : null;
  const periodPreview = reportPeriod(period, sim.minute);

  // One history step: Back returns to this report.
  const openEventTab = (id: string) => {
    useApp.setState((st) => {
      const tabs = { ...st.tabs };
      delete tabs.events;
      return { tabs };
    });
    useApp.getState().selectEvent(id);
  };

  return (
    <div className="rb">
      <aside className="rb-controls" aria-label="Report builder">
        <Section title="Build a report" subtitle="Choose what, when and where — the preview updates as you go.">
          <fieldset className="rb-field">
            <legend>Report</legend>
            <div className="rb-types" role="radiogroup" aria-label="Report type">
              {REPORT_TYPES.map((t) => {
                const Icon = TYPE_ICON[t.id];
                const on = t.id === type;
                return (
                  <button key={t.id} type="button" role="radio" aria-checked={on} className={`rb-type ${on ? 'on' : ''}`} onClick={() => setB({ type: t.id })}>
                    <Icon size={16} aria-hidden />
                    <span>
                      <b>{t.label}</b>
                      <small>{t.question}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {def.period ? (
            <fieldset className="rb-field">
              <legend>Reporting period</legend>
              <Segmented label="Reporting period" value={period} options={REPORT_PERIODS.map((p) => ({ value: p, label: PERIOD_SHORT[p] }))} onChange={(p) => setB({ period: p })} />
              <p className="rb-hint" title={PERIOD_LABELS[period]}>
                {periodPreview.text}
              </p>
            </fieldset>
          ) : null}

          <fieldset className="rb-field">
            <legend>Scope</legend>
            {type === 'incident' ? (
              choices.length ? (
                <>
                  <select className="select rb-wide" value={incidentId ?? ''} onChange={(e) => setB({ eventId: e.target.value })} aria-label="Event to investigate">
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <p className="rb-hint">Open issues first, then the most recent events. Any event can be opened from the Events tab with “Incident report”.</p>
                </>
              ) : (
                <p className="rb-hint">No event recorded yet.</p>
              )
            ) : def.scopes.length ? (
              <>
                <select className="select rb-wide" value={sc} onChange={(e) => setB({ scope: e.target.value as ReportScope })} aria-label="Report scope">
                  {def.scopes.map((x) => (
                    <option key={x} value={x}>
                      {x === 'line' ? 'Whole line' : MONITORED_STAGE_BY_ID[x].name}
                    </option>
                  ))}
                </select>
                <p className="rb-hint">
                  {type === 'quality'
                    ? 'A stage scope lists the defects whose modelled origin is that stage (a hypothesis, not a confirmed cause).'
                    : type === 'oee'
                      ? 'Line OEE is always measured at the kiln; a stage scope narrows the machines, stops and events.'
                      : 'A stage scope narrows the flow, stops, equipment and events; line KPIs stay as context.'}
                </p>
              </>
            ) : (
              <p className="rb-hint">{type === 'fleet' ? 'Whole site — gate, yard, docks and the internal fleet. Positions are simulated at zone level.' : '—'}</p>
            )}
          </fieldset>

          <div className="rb-field">
            {type === 'incident' ? (
              incidentId ? (
                <ExportButton
                  key={`incident-${incidentId}`}
                  title="A4 PDF of the incident report — the same record, evidence and estimate as the preview"
                  run={() => exportEventPdf(incidentId)}
                />
              ) : null
            ) : model ? (
              <ExportButton key={`${type}-${period}-${sc}`} title="A4 PDF of exactly this preview: the same model, figures and events" run={() => exportOpsPdf(model)} />
            ) : null}
            <p className="rb-hint">
              {type === 'incident'
                ? 'The PDF freezes the event record at the moment you press the button; the export is logged on the event.'
                : model
                  ? `The PDF contains exactly the preview below — built at ${formatClock(model.minute)} plant time (${formatDateTime(model.minute)}).`
                  : ''}
            </p>
          </div>
        </Section>
      </aside>

      <section className="rb-preview" aria-label="Report preview">
        <div className="rb-preview-h">
          <span className="rb-preview-t">Preview</span>
          <span className="muted">{def.contents}</span>
        </div>
        {resetting ? (
          <EmptyState title="Rebuilding the demo state…">Reset Demo is rebuilding the seeded history; the report refreshes when it completes.</EmptyState>
        ) : type === 'incident' ? (
          incidentId ? (
            <div className="rb-incident">
              <ReportLegend compact />
              <EventReportView key={incidentId} eventId={incidentId} />
            </div>
          ) : (
            <EmptyState title="No event to investigate">Events appear here once the simulation records one.</EmptyState>
          )
        ) : model ? (
          <OpsReportView report={model} links={{ onEvent: openEventTab, onEvents: (q) => openReportEvents(q, model.events.map((e) => e.id)) }} />
        ) : null}
      </section>
    </div>
  );
}
