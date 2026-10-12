/**
 * Links into Events & Reports that land on the Events tab, whatever tab the workspace showed last.
 * `openEvent` (src/app/store.ts) keeps the workspace's last tab, so an event link followed after the
 * Reports or Detection rules tab was open would land there; these helpers clear the tab first.
 *
 *  - `openEventRecord(id)` opens one event record.
 *  - `openEventsFor({ stage | equipmentId | vehicleId })` opens the event list filtered to a subject
 *    for all recorded time: a production stage through the stage filter (the Production stage views'
 *    membership rule), an asset or a vehicle through the free-text search, which matches asset and
 *    vehicle ids. `eventsForSubject` is that same list, so a link can show the count the list shows.
 */
import { openEvent, useApp } from '../../app/store';
import type { MonitoredStageId, OpEvent } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { DEFAULT_FILTERS, filterEvents, type EventFilters } from '../../pages/events/filters';
import { useEventsView } from '../../pages/events/state';

export function openEventRecord(id: string) {
  useApp.setState((s) => {
    if (!s.tabs.events) return {};
    const tabs = { ...s.tabs };
    delete tabs.events;
    return { tabs };
  });
  openEvent(id);
}

/** The subject of an event-list link: a production stage, an asset or a vehicle. */
export type EventSubject = { stage?: MonitoredStageId; equipmentId?: string; vehicleId?: string };

/** The Events view filters listing a subject's events: every filter cleared, all recorded time. */
export function eventFiltersFor(f: EventSubject): EventFilters {
  return { ...DEFAULT_FILTERS, window: 'all', stage: f.stage ?? 'all', query: [f.equipmentId, f.vehicleId].filter(Boolean).join(' ') };
}

/** Exactly the rows the Events list shows for the subject (same filters, same search context, newest first). */
export function eventsForSubject(s: SimState, f: EventSubject): OpEvent[] {
  return filterEvents(s.events, eventFiltersFor(f), { now: s.minute, vehicleLabel: (id) => s.logistics.vehicles[id]?.label });
}

/**
 * Opens the Events tab of Events & Reports listing the subject's events (filters as above, first
 * page), with the selected event kept when the list holds it, else the newest listed one. One
 * history step: Back returns to where the link was.
 */
export function openEventsFor(f: EventSubject) {
  const rows = eventsForSubject(useSim.getState().sim, f);
  useEventsView.setState({ filters: eventFiltersFor(f), page: 0 });
  const app = useApp.getState();
  const keep = app.selectedEventId != null && rows.some((e) => e.id === app.selectedEventId);
  const id = keep ? app.selectedEventId : (rows[0]?.id ?? null);
  useApp.setState((s) => {
    const tabs = { ...s.tabs };
    delete tabs.events;
    return { tabs };
  });
  if (app.workspace === 'events') app.selectEvent(id);
  else {
    useApp.setState({ selectedEventId: id });
    useApp.getState().go('events');
  }
}
