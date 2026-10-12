/**
 * Events tab of Events & Reports: a few counts that matter, a compact filterable list of the shared
 * event records and, beside it, the selected event read as an investigation (EventDetail). The raw
 * records the events are built from sit in a collapsed log underneath.
 *
 * Selecting a row deep-links #/events/<id> (a click adds a browser-history entry; the automatic
 * first selection and arrow-key moves rewrite it).
 */
import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Info, Search, X } from 'lucide-react';
import { useApp } from '../../app/store';
import { activeIssuesKpi } from '../../intel/kpis';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity } from '../../model/types';
import { EVENT_CATEGORY_LABEL, EVENT_STATUS_LABEL } from '../../sim/events';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { fmtInt } from '../../ui/kit/format';
import { Disclosure, EmptyState, KpiCard, KpiRow, kpiCardProps } from '../../ui/kit/Page';
import { SIGNIFICANT_LABEL } from '../../report/ops/select';
import { Segmented } from '../../ui/kit/Panel';
import { SEVERITY } from '../../ui/kit/Status';
import { EventDetail } from './EventDetail';
import {
  ALL_EVENTS_FILTERS,
  CATEGORY_ORDER,
  DEFAULT_FILTERS,
  PAGE_SIZE,
  SEVERITY_ORDER,
  SOURCE_LABEL,
  STAGE_ORDER,
  STATUS_ORDER,
  facetCounts,
  filterEvents,
  isDefault,
  pageBounds,
  pageOf,
  windowOptions,
  windowRange,
  type EventFilters,
} from './filters';
import { RecordLog } from './RecordLog';
import { useEventsView } from './state';

const sevLabel = (k: AlertSeverity) => SEVERITY[k].label;

export function EventsView() {
  const selectedId = useApp((s) => s.selectedEventId);
  const selectEvent = useApp((s) => s.selectEvent);
  const filters = useEventsView((s) => s.filters);
  const page = useEventsView((s) => s.page);
  const setPage = useEventsView((s) => s.setPage);
  // Set by 'Show all events': once the widened list holds the selected event, show its page.
  const reveal = useRef(false);
  const set = (p: Partial<EventFilters>, opts?: { reveal?: boolean }) => {
    useEventsView.getState().setFilters(p);
    reveal.current = opts?.reveal ?? false;
  };

  const data = useSimValue(
    (s) => {
      const ctx = { now: s.minute, vehicleLabel: (id: string) => s.logistics.vehicles[id]?.label };
      const rows = filterEvents(s.events, filters, ctx);
      const open = s.events.filter((e) => e.status !== 'resolved');
      return {
        now: s.minute,
        liveFrom: s.liveFrom,
        rows,
        facets: facetCounts(s.events, filters, ctx),
        window: windowRange(filters.window, s.minute),
        issues: activeIssuesKpi(s),
        active: s.events.filter((e) => e.end == null),
        unacknowledged: open.filter((e) => e.status === 'active').length,
        investigating: open.filter((e) => e.status === 'investigating').length,
        session: s.events.filter((e) => !e.historical),
        selectedExists: selectedId ? s.events.some((e) => e.id === selectedId) : false,
      };
    },
    [filters, selectedId],
  );

  // Nothing selected (first visit, after a reset): open the newest listed event. Automatic, so it
  // rewrites the current history entry instead of adding one.
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
  useEffect(() => {
    if (!reveal.current || indexOfSelected < 0) return;
    reveal.current = false;
    setPage(pageOf(indexOfSelected));
  }, [indexOfSelected, setPage]);

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
  const activeBySev = SEVERITY_ORDER.map((k) => [k, data.active.filter((e) => e.severity === k).length] as const).filter(([, n]) => n > 0);
  const I = data.issues;
  const onlyActive = filters.condition === 'active' && filters.window === 'all';
  const onlyUnack = filters.status === 'active' && filters.window === 'all';
  const onlySession = filters.sessionOnly && filters.window === 'all';

  return (
    <>
      <KpiRow label="Event counts">
        <KpiCard {...kpiCardProps(I)} />
        <KpiCard
          label="Conditions active now"
          value={fmtInt(data.active.length)}
          scope={`Now · ${formatClock(data.now)}`}
          status={data.active.length ? { tone: activeBySev[0]?.[0] === 'critical' ? 'critical' : 'warning', label: activeBySev.map(([k, n]) => `${n} ${sevLabel(k).toLowerCase()}`).join(' · ') } : { tone: 'good', label: 'No condition active' }}
          why="Events whose condition still persists, whatever their lifecycle status."
          onClick={() => set(onlyActive ? { condition: 'all', window: DEFAULT_FILTERS.window } : { ...DEFAULT_FILTERS, condition: 'active', window: 'all' })}
          actionLabel={onlyActive ? 'Show all events' : 'List them'}
          selected={onlyActive}
        />
        <KpiCard
          label="Not acknowledged"
          value={fmtInt(data.unacknowledged)}
          scope="Open events · any time"
          status={data.unacknowledged ? { tone: 'warning', label: `${data.investigating} under investigation` } : { tone: 'good', label: 'All seen' }}
          why="Open events nobody has acknowledged yet."
          onClick={() => set(onlyUnack ? { status: 'all', window: DEFAULT_FILTERS.window } : { ...DEFAULT_FILTERS, status: 'active', window: 'all' })}
          actionLabel={onlyUnack ? 'Show all events' : 'List them'}
          selected={onlyUnack}
        />
        <KpiCard
          label="Detected this session"
          value={fmtInt(data.session.length)}
          scope={`Since ${formatDateTime(data.liveFrom)}`}
          target={`${data.session.filter((e) => e.source === 'scenario').length} scenario-caused`}
          why="Events raised since this demo session started (the rest is pre-rolled history)."
          onClick={() => set(onlySession ? { sessionOnly: false, window: DEFAULT_FILTERS.window } : { ...DEFAULT_FILTERS, sessionOnly: true, window: 'all' })}
          actionLabel={onlySession ? 'Show all events' : 'List them'}
          selected={onlySession}
        />
      </KpiRow>

      <div className="evp-filters" role="search" aria-label="Filter events">
        <label className="evp-search">
          <Search size={14} aria-hidden />
          <input
            className="input"
            type="search"
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="Search id, rule, asset, vehicle, station…"
            aria-label="Search events by id, title, rule, asset, vehicle, station or zone"
          />
          {filters.query && (
            <button className="btn ghost sm icon" onClick={() => set({ query: '' })} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </label>
        <Segmented label="Time window" value={filters.window} options={windowOptions(filters.window)} onChange={(window) => set({ window })} />
        <select className="select" value={filters.severity} onChange={(e) => set({ severity: e.target.value as EventFilters['severity'] })} aria-label="Severity">
          <option value="all">All severities ({F.severity.all})</option>
          {SEVERITY_ORDER.map((k) => (
            <option key={k} value={k} disabled={!F.severity[k] && filters.severity !== k}>
              {sevLabel(k)} ({F.severity[k]})
            </option>
          ))}
        </select>
        <select className="select" value={filters.status} onChange={(e) => set({ status: e.target.value as EventFilters['status'] })} aria-label="Status">
          <option value="all">Any status ({F.status.all})</option>
          <option value="open">Open — not resolved ({F.status.open})</option>
          {STATUS_ORDER.map((st) => (
            <option key={st} value={st} disabled={!F.status[st] && filters.status !== st}>
              {st === 'active' ? 'Not acknowledged' : EVENT_STATUS_LABEL[st]} ({F.status[st]})
            </option>
          ))}
        </select>
        <select className="select" value={filters.category} onChange={(e) => set({ category: e.target.value as EventFilters['category'] })} aria-label="Category">
          <option value="all">All categories ({F.category.all})</option>
          {CATEGORY_ORDER.map((c) => (
            <option key={c} value={c} disabled={!F.category[c] && filters.category !== c}>
              {EVENT_CATEGORY_LABEL[c]} ({F.category[c]})
            </option>
          ))}
        </select>
        <select className="select" value={filters.stage} onChange={(e) => set({ stage: e.target.value as EventFilters['stage'] })} aria-label="Production stage">
          <option value="all">All stages ({F.stage.all})</option>
          {STAGE_ORDER.map((id) => (
            <option key={id} value={id} disabled={!F.stage[id] && filters.stage !== id}>
              {MONITORED_STAGE_BY_ID[id].name} ({F.stage[id]})
            </option>
          ))}
        </select>
        <select className="select" value={filters.source} onChange={(e) => set({ source: e.target.value as EventFilters['source'] })} aria-label="Source">
          <option value="all">Simulated & scenario ({F.source.all})</option>
          <option value="simulation">{SOURCE_LABEL.simulation} only ({F.source.simulation})</option>
          <option value="scenario">{SOURCE_LABEL.scenario} only ({F.source.scenario})</option>
        </select>
        <select className="select" value={filters.condition} onChange={(e) => set({ condition: e.target.value as EventFilters['condition'] })} aria-label="Condition">
          <option value="all">Any condition ({F.condition.all})</option>
          <option value="active">Condition ongoing ({F.condition.active})</option>
          <option value="cleared">Condition cleared ({F.condition.cleared})</option>
        </select>
        <label className="evp-check" title="Exclude the pre-rolled history: only events detected since this demo session started">
          <input type="checkbox" checked={filters.sessionOnly} onChange={(e) => set({ sessionOnly: e.target.checked })} />
          This session only
        </label>
        <label className="evp-check" title="Only root events (not the consequence of another event) of warning severity and above — the significant events the reports list">
          <input type="checkbox" checked={filters.significantOnly} onChange={(e) => set({ significantOnly: e.target.checked })} />
          {SIGNIFICANT_LABEL}
        </label>
        {filters.categories && (
          <span className="evp-chip" role="status">
            Categories: {filters.categories.map((c) => EVENT_CATEGORY_LABEL[c]).join(', ')}
            <button className="btn ghost sm icon" onClick={() => set({ categories: null })} aria-label="Remove the category group filter">
              <X size={12} />
            </button>
          </span>
        )}
        <button className="btn sm ghost" disabled={isDefault(filters)} onClick={() => useEventsView.getState().resetFilters()}>
          Clear filters
        </button>
      </div>

      <div className="evp-split">
        <section className="evp-list" aria-label="Event list">
          <header className="evp-list-h">
            <h3>
              {fmtInt(data.rows.length)} event{data.rows.length === 1 ? '' : 's'} <span className="muted">· newest first</span>
            </h3>
            <p>
              {data.window.label}
              {filters.sessionOnly ? ' · this session' : ''}
              {filters.significantOnly ? ` · ${SIGNIFICANT_LABEL.toLowerCase()}` : ''} · detection rules on simulated data
            </p>
          </header>
          {selectedId && indexOfSelected < 0 && data.rows.length > 0 && (
            <div className="evp-outside" role="status">
              <Info size={13} aria-hidden />
              {data.selectedExists ? (
                <span>
                  {selectedId} is outside the current filters.{' '}
                  <button className="row-link" onClick={() => set(ALL_EVENTS_FILTERS, { reveal: true })}>
                    Show all events
                  </button>
                </span>
              ) : (
                <span>
                  {selectedId} is not in the current demo state.{' '}
                  <button className="row-link" onClick={() => selectEvent(data.rows[0].id)}>
                    Open the newest event
                  </button>
                </span>
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
              <EmptyState
                title="No event matches the filters"
                action={
                  !isDefault(filters) ? (
                    <button className="btn sm" onClick={() => useEventsView.getState().resetFilters()}>
                      Clear filters
                    </button>
                  ) : undefined
                }
              >
                {isDefault(filters) ? 'Nothing was detected in this window.' : 'Widen the time window or clear the filters.'}
              </EmptyState>
            )}
          </div>
          {data.rows.length > PAGE_SIZE && (
            <footer className="evp-pager">
              <span className="num">
                {pb.from + 1}–{pb.to} of {fmtInt(data.rows.length)}
              </span>
              <div className="spacer" />
              <button className="btn sm icon" disabled={pb.page === 0} onClick={() => setPage(pb.page - 1)} aria-label="Previous page">
                <ChevronLeft size={14} />
              </button>
              <span className="num">
                {pb.page + 1} / {pb.pages}
              </span>
              <button className="btn sm icon" disabled={pb.page >= pb.pages - 1} onClick={() => setPage(pb.page + 1)} aria-label="Next page">
                <ChevronRight size={14} />
              </button>
            </footer>
          )}
        </section>

        <section className="evp-detail" aria-label="Selected event">
          {selectedId ? (
            <EventDetail key={selectedId} eventId={selectedId} />
          ) : (
            <EmptyState title="Select an event">The event, where it happened, its evidence, impact, recommended investigation and lifecycle appear here.</EmptyState>
          )}
        </section>
      </div>

      <Disclosure title="Underlying record log" meta="alerts, downtime, gate, dock, restricted-zone and scenario records">
        <RecordLog />
      </Disclosure>
    </>
  );
}
