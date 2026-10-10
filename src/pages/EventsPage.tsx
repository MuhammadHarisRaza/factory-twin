/**
 * Events & Reports — the unified event timeline of all four use cases (production, quality,
 * vehicles, equipment / energy / data) and the full report of the selected event.
 *
 * Answers: what is happening now, what happened in the window, and — for one event — what, where,
 * why (with confidence), what it cost (estimate) and who is handling it. Every row is the same
 * OpEvent record the report, the PDF and the copilot use; selecting one deep-links #/events/<id>
 * (a click adds a browser-history entry; automatic selections and arrow-key moves do not).
 * Reset Demo clears the selection in the app store (src/app/store.ts), so the newest event opens.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileDown, Info, LoaderCircle, Search, X } from 'lucide-react';
import { useApp } from '../app/store';
import { MONITORED_STAGES } from '../model/plant';
import type { AlertSeverity, MonitoredStageId } from '../model/types';
import { exportStageShiftPdf } from '../report/pdf';
import { EVENT_CATEGORY_LABEL, EVENT_STATUS_LABEL } from '../sim/events';
import { useSim, useSimValue } from '../sim/store';
import { formatDateTime } from '../sim/time';
import { EventList } from '../ui/events/EventList';
import { fmtInt } from '../ui/kit/format';
import { Empty, Segmented } from '../ui/kit/Panel';
import { SEVERITY } from '../ui/kit/Status';
import { EventReportView } from '../ui/report/EventReportView';
import {
  ALL_EVENTS_FILTERS,
  CATEGORY_ORDER,
  DEFAULT_FILTERS,
  PAGE_SIZE,
  SEVERITY_ORDER,
  STATUS_ORDER,
  WINDOW_OPTIONS,
  facetCounts,
  filterEvents,
  isDefault,
  pageBounds,
  pageOf,
  windowRange,
  type ConditionFilter,
  type EventFilters,
  type StatusFilter,
} from './events/filters';
import './events.css';

export function EventsPage() {
  const selectedId = useApp((s) => s.selectedEventId);
  const selectEvent = useApp((s) => s.selectEvent);
  const resetting = useSim((s) => s.resetting);
  const [filters, setFilters] = useState<EventFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(0);
  // Set by 'Show all events': once the widened list holds the open report, show its page.
  const reveal = useRef(false);
  const set = (p: Partial<EventFilters>, opts?: { reveal?: boolean }) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(0);
    reveal.current = opts?.reveal ?? false;
  };

  const data = useSimValue(
    (s) => {
      const ctx = { now: s.minute, vehicleLabel: (id: string) => s.logistics.vehicles[id]?.label };
      const rows = filterEvents(s.events, filters, ctx);
      const facets = facetCounts(s.events, filters, ctx);
      const active = s.events.filter((e) => e.end == null);
      const open = s.events.filter((e) => e.status !== 'resolved');
      return {
        now: s.minute,
        liveFrom: s.liveFrom,
        rows,
        facets,
        window: windowRange(filters.window, s.minute),
        active: active.length,
        activeBySeverity: SEVERITY_ORDER.map((k) => [k, active.filter((e) => e.severity === k).length] as const).filter(([, n]) => n > 0),
        open: open.length,
        unacknowledged: open.filter((e) => e.status === 'active').length,
        investigating: open.filter((e) => e.status === 'investigating').length,
        session: s.events.filter((e) => !e.historical).length,
        resolvedInWindow: rows.filter((e) => e.status === 'resolved').length,
        resolvedByUser: rows.filter((e) => e.resolution?.by === 'user').length,
        reports: s.events.reduce((a, e) => a + e.reports.length, 0),
        reportedEvents: s.events.filter((e) => e.reports.length > 0).length,
        selectedExists: selectedId ? s.events.some((e) => e.id === selectedId) : false,
      };
    },
    [filters, selectedId],
  );

  // Nothing selected (first visit, after a reset): open the newest event of the list. Automatic,
  // so it rewrites the current history entry instead of adding one.
  const newest = data.rows[0]?.id;
  useEffect(() => {
    if (!selectedId && newest) selectEvent(newest, 'replace');
  }, [selectedId, newest, selectEvent]);

  // Deep link / related-event link: show the page that holds the selected event.
  const indexOfSelected = selectedId ? data.rows.findIndex((e) => e.id === selectedId) : -1;
  useEffect(() => {
    if (indexOfSelected >= 0) setPage(pageOf(indexOfSelected));
    // Only when the selection changes — paging away by hand must stay possible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  // 'Show all events' widened the filters: jump to the page that now holds the open report.
  useEffect(() => {
    if (!reveal.current || indexOfSelected < 0) return;
    reveal.current = false;
    setPage(pageOf(indexOfSelected));
  }, [indexOfSelected]);

  const pb = pageBounds(data.rows.length, page);
  const pageRows = data.rows.slice(pb.from, pb.to);

  const move = (delta: number) => {
    const i = indexOfSelected < 0 ? 0 : Math.min(data.rows.length - 1, Math.max(0, indexOfSelected + delta));
    const ev = data.rows[i];
    if (!ev) return;
    // Arrow-key stepping rewrites the current history entry: Back leaves the list, not each row.
    selectEvent(ev.id, 'replace');
    setPage(pageOf(i));
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.evp-list [data-ev="${ev.id}"]`)?.focus());
  };

  const F = data.facets;
  const sevLabel = (k: AlertSeverity) => SEVERITY[k].label;

  return (
    <div className="page evp">
      {resetting && (
        <div className="notice col-12" role="status">
          <LoaderCircle size={15} className="spin" aria-hidden />
          <span>
            <b>Reset Demo is rebuilding the seeded history.</b> The event list and reports refresh when it completes.
          </span>
        </div>
      )}

      <section className="summary" aria-label="Event summary">
        <div>
          <span className="kpi-label">Conditions active now</span>
          <div className="kpi-value">{fmtInt(data.active)}</div>
          <div className="kpi-sub">
            {data.activeBySeverity.length ? data.activeBySeverity.map(([k, n]) => <span key={k}>{`${n} ${sevLabel(k).toLowerCase()}`}</span>) : <span>No condition active</span>}
          </div>
        </div>
        <div>
          <span className="kpi-label">Open events</span>
          <div className="kpi-value">{fmtInt(data.open)}</div>
          <div className="kpi-sub">
            <span>{data.unacknowledged} not acknowledged</span>
            <span>{data.investigating} investigating</span>
          </div>
        </div>
        <div>
          <span className="kpi-label">Detected this session</span>
          <div className="kpi-value">{fmtInt(data.session)}</div>
          <div className="kpi-sub">since {formatDateTime(data.liveFrom)}</div>
        </div>
        <div>
          <span className="kpi-label">Listed</span>
          <div className="kpi-value">{fmtInt(data.rows.length)}</div>
          <div className="kpi-sub">{data.window.label} · current filters</div>
        </div>
        <div>
          <span className="kpi-label">Resolved (listed)</span>
          <div className="kpi-value">{fmtInt(data.resolvedInWindow)}</div>
          <div className="kpi-sub">
            {data.resolvedByUser} by a user · {data.resolvedInWindow - data.resolvedByUser} auto-resolved
          </div>
        </div>
        <div>
          <span className="kpi-label">PDF reports exported</span>
          <div className="kpi-value">{fmtInt(data.reports)}</div>
          <div className="kpi-sub">from {data.reportedEvents} event record{data.reportedEvents === 1 ? '' : 's'}</div>
        </div>
      </section>

      <div className="toolbar-row evp-filters">
        <label className="evp-search">
          <Search size={14} aria-hidden />
          <input
            className="input"
            type="search"
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="Search id, asset, vehicle, station…"
            aria-label="Search events by id, title, asset, vehicle, station or zone"
          />
          {filters.query && (
            <button className="btn ghost sm icon" onClick={() => set({ query: '' })} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </label>
        <Segmented label="Time window" value={filters.window} options={WINDOW_OPTIONS} onChange={(window) => set({ window })} />
        <Segmented<ConditionFilter>
          label="Condition"
          value={filters.condition}
          options={[
            { value: 'all', label: 'Any condition' },
            { value: 'active', label: `Active ${F.condition.active}` },
            { value: 'cleared', label: `Cleared ${F.condition.cleared}` },
          ]}
          onChange={(condition) => set({ condition })}
        />
        <select className="select" value={filters.severity} onChange={(e) => set({ severity: e.target.value as EventFilters['severity'] })} aria-label="Severity">
          <option value="all">All severities ({F.severity.all})</option>
          {SEVERITY_ORDER.map((k) => (
            <option key={k} value={k}>
              {sevLabel(k)} ({F.severity[k]})
            </option>
          ))}
        </select>
        <label className="evp-check" title="Exclude the pre-rolled history: only events detected since this demo session started">
          <input type="checkbox" checked={filters.sessionOnly} onChange={(e) => set({ sessionOnly: e.target.checked })} />
          This session only
        </label>
        <button className="btn sm ghost" disabled={isDefault(filters)} onClick={() => set(DEFAULT_FILTERS)}>
          Clear filters
        </button>
        <div className="spacer" />
        <StageShiftExport />
      </div>

      <div className="col-12 evp-facets">
        <div className="evp-facet" role="group" aria-label="Category">
          <span className="evp-facet-l">Category</span>
          <Chip on={filters.category === 'all'} label="All" n={F.category.all} onClick={() => set({ category: 'all' })} />
          {CATEGORY_ORDER.map((c) => (
            <Chip key={c} on={filters.category === c} label={EVENT_CATEGORY_LABEL[c]} n={F.category[c]} onClick={() => set({ category: filters.category === c ? 'all' : c })} />
          ))}
        </div>
        <div className="evp-facet" role="group" aria-label="Status">
          <span className="evp-facet-l">Status</span>
          <Chip on={filters.status === 'all'} label="All" n={F.status.all} onClick={() => set({ status: 'all' })} />
          <Chip on={filters.status === 'open'} label="Open" n={F.status.open} onClick={() => set({ status: filters.status === 'open' ? 'all' : 'open' })} title="Not resolved yet" />
          {STATUS_ORDER.map((st) => (
            <Chip key={st} on={filters.status === st} label={EVENT_STATUS_LABEL[st]} n={F.status[st]} onClick={() => set({ status: (filters.status === st ? 'all' : st) as StatusFilter })} />
          ))}
        </div>
      </div>

      <div className="evp-split">
        <section className="panel evp-list" aria-label="Event list">
          <header className="panel-h">
            <div className="titles">
              <h2>
                {fmtInt(data.rows.length)} event{data.rows.length === 1 ? '' : 's'} <span className="muted">· newest first</span>
              </h2>
              <p>
                {data.window.label}
                {filters.sessionOnly ? ' · this session' : ''} · <span className="tag sim">Simulated</span> detection rules on simulated data
              </p>
            </div>
          </header>
          {selectedId && indexOfSelected < 0 && data.rows.length > 0 && (
            <div className="evp-outside">
              <Info size={13} aria-hidden />
              {data.selectedExists ? (
                <>
                  The open report ({selectedId}) is outside the current filters.
                  <button className="row-link" onClick={() => set(ALL_EVENTS_FILTERS, { reveal: true })}>
                    Show all events
                  </button>
                </>
              ) : (
                <>
                  {selectedId} is not in the current demo state.
                  <button className="row-link" onClick={() => selectEvent(data.rows[0].id)}>
                    Open the newest event
                  </button>
                </>
              )}
            </div>
          )}
          <div
            className="evp-list-b"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(e.key === 'ArrowDown' ? 1 : -1);
              }
            }}
          >
            {data.rows.length ? (
              <EventList events={pageRows} selectedId={selectedId} onSelect={(ev) => selectEvent(ev.id)} />
            ) : (
              <Empty title="No event matches the filters">
                {isDefault(filters) ? 'Nothing was detected in this window.' : 'Widen the time window or clear the filters.'}
                {!isDefault(filters) && (
                  <button className="btn sm" onClick={() => set(DEFAULT_FILTERS)}>
                    Clear filters
                  </button>
                )}
              </Empty>
            )}
          </div>
          {data.rows.length > PAGE_SIZE && (
            <footer className="panel-f evp-pager">
              <span className="num">
                {pb.from + 1}–{pb.to} of {fmtInt(data.rows.length)}
              </span>
              <div className="spacer" />
              <button className="btn sm icon" disabled={pb.page === 0} onClick={() => setPage(pb.page - 1)} aria-label="Previous page">
                <ChevronLeft size={14} />
              </button>
              <span className="num">
                Page {pb.page + 1} / {pb.pages}
              </span>
              <button className="btn sm icon" disabled={pb.page >= pb.pages - 1} onClick={() => setPage(pb.page + 1)} aria-label="Next page">
                <ChevronRight size={14} />
              </button>
            </footer>
          )}
        </section>

        <section className="panel evp-report" aria-label="Event report">
          <div className="panel-b">
            {selectedId ? (
              <EventReportView key={selectedId} eventId={selectedId} />
            ) : (
              <Empty title="Select an event to open its report">Each report shows the event, its evidence, impact, estimate, diagnosis and lifecycle — and downloads as a PDF.</Empty>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Chip({ on, label, n, onClick, title }: { on: boolean; label: string; n: number; onClick: () => void; title?: string }) {
  return (
    <button className={`evp-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick} title={title} disabled={!on && n === 0}>
      {label} <span className="num">{n}</span>
    </button>
  );
}

/** Shift summary PDF of a monitored stage (stage I/O, equipment states, its events by id, losses). */
function StageShiftExport() {
  const [stage, setStage] = useState<MonitoredStageId>('KILN');
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: string | null }>({ busy: false, error: null, saved: null });
  const stages = useMemo(() => [...MONITORED_STAGES].sort((a, b) => a.step - b.step), []);
  return (
    <div className="evp-stage">
      <select className="select" value={stage} onChange={(e) => setStage(e.target.value as MonitoredStageId)} aria-label="Stage for the shift summary">
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button
        className="btn sm"
        disabled={state.busy}
        onClick={() => {
          setState({ busy: true, error: null, saved: null });
          exportStageShiftPdf(stage)
            .then((saved) => setState({ busy: false, error: null, saved }))
            .catch((e: unknown) => setState({ busy: false, error: e instanceof Error ? e.message : 'The PDF could not be created', saved: null }));
        }}
        title="A4 shift summary of the stage: input / output, equipment states, its events of the shift (by id) and losses"
      >
        {state.busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : <FileDown size={13} aria-hidden />}
        Stage shift PDF
      </button>
      {state.error && (
        <span className="evp-err" role="alert">
          {state.error}
        </span>
      )}
      {state.saved && (
        <span className="evp-saved" role="status">
          Saved {state.saved}
        </span>
      )}
    </div>
  );
}
