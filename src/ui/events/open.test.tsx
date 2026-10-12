/**
 * "Events of this asset / stage / vehicle" links (finding: the equipment workspace's "All N events of
 * this asset" opened the unfiltered list). openEventsFor lands on the Events tab with the subject's
 * filters for all recorded time, and the count a link shows is the count of the list it opens.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The stores register browser listeners at import; a minimal window is enough for server rendering.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import type { ReactElement } from 'react';
import { useApp } from '../../app/store';
import { eventsFor } from '../../sim/events';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { EventsPage } from '../../pages/EventsPage';
import { DEFAULT_FILTERS, filterEvents } from '../../pages/events/filters';
import { useEventsView, useReportBuilder } from '../../pages/events/state';
import { EquipmentWorkspace } from '../equipment/EquipmentWorkspace';
import { useTwinUi } from '../twin/uiStore';
import { StagePanel } from '../twin/StagePanel';
import { eventFiltersFor, eventsForSubject, openEventsFor } from './open';

useSim.getState().pause();

const html = (el: ReactElement) => {
  for (const st of [useSim, useApp, useTwin, useTwinUi, useEventsView, useReportBuilder] as { getInitialState: () => object; getState: () => object }[])
    Object.assign(st.getInitialState(), st.getState());
  return renderToStaticMarkup(el);
};
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const sim = () => useSim.getState().sim;
const ctx = () => ({ now: sim().minute, vehicleLabel: (id: string) => sim().logistics.vehicles[id]?.label });

/** Leaves Events & Reports on another tab with narrow filters, as a user might have. */
const dirty = () => {
  useApp.setState({ workspace: 'twin', tabs: { events: 'reports' }, selectedEventId: null });
  useEventsView.setState({ filters: { ...DEFAULT_FILTERS, severity: 'critical', window: '4h', query: 'nothing matches this' }, page: 3 });
};

describe('openEventsFor', () => {
  it('opens the Events tab listing exactly an asset’s events, all recorded time, the newest selected', () => {
    // An asset with more events than the workspace's three recent rows.
    const counts = new Map<string, number>();
    for (const e of sim().events) if (e.asset.equipmentId) counts.set(e.asset.equipmentId, (counts.get(e.asset.equipmentId) ?? 0) + 1);
    const id = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const rows = eventsForSubject(sim(), { equipmentId: id });
    expect(rows.length).toBeGreaterThan(3);
    // Every event recorded on the asset is listed (the search matches its id).
    const own = eventsFor(sim(), { equipmentId: id }).map((e) => e.id);
    for (const e of own) expect(rows.some((r) => r.id === e)).toBe(true);

    dirty();
    openEventsFor({ equipmentId: id });
    const app = useApp.getState();
    expect(app.workspace).toBe('events');
    expect(app.tabs.events).toBeUndefined();
    expect(useEventsView.getState().filters).toEqual({ ...DEFAULT_FILTERS, window: 'all', query: id });
    expect(useEventsView.getState().page).toBe(0);
    expect(app.selectedEventId).toBe(rows[0].id);
    // The Events list shows that many rows.
    expect(filterEvents(sim().events, useEventsView.getState().filters, ctx()).map((e) => e.id)).toEqual(rows.map((e) => e.id));
    expect(text(html(<EventsPage />))).toContain(`${rows.length.toLocaleString('en-GB')} events · newest first`);

    // The equipment workspace link promises the same count.
    useApp.setState({ workspace: 'twin' });
    expect(text(html(<EquipmentWorkspace id={id} />))).toContain(`All ${rows.length} events of this asset in Events & Reports`);
  });

  it('keeps the selected event when the list holds it', () => {
    const id = sim().events.find((e) => e.asset.equipmentId)!.asset.equipmentId!;
    const rows = eventsForSubject(sim(), { equipmentId: id });
    const keep = rows[rows.length - 1].id;
    useApp.setState({ workspace: 'twin', selectedEventId: keep });
    openEventsFor({ equipmentId: id });
    expect(useApp.getState().selectedEventId).toBe(keep);
  });

  it('filters a stage with the stage filter and a vehicle with its id', () => {
    dirty();
    openEventsFor({ stage: 'KILN' });
    expect(useEventsView.getState().filters).toEqual({ ...DEFAULT_FILTERS, window: 'all', stage: 'KILN' });
    expect(useApp.getState().tabs.events).toBeUndefined();
    const stageRows = eventsForSubject(sim(), { stage: 'KILN' });
    expect(text(html(<EventsPage />))).toContain(`${stageRows.length.toLocaleString('en-GB')} event${stageRows.length === 1 ? '' : 's'} · newest first`);
    // The stage panel's link shows that count.
    useApp.setState({ workspace: 'twin' });
    if (stageRows.length) expect(text(html(<StagePanel id="KILN" />))).toContain(`All ${stageRows.length} event${stageRows.length === 1 ? '' : 's'} of this stage in Events & Reports`);

    const v = sim().events.find((e) => e.asset.vehicleId)?.asset.vehicleId;
    if (v) {
      dirty();
      openEventsFor({ vehicleId: v });
      expect(useEventsView.getState().filters).toEqual(eventFiltersFor({ vehicleId: v }));
      expect(useEventsView.getState().filters.query).toBe(v);
      const vr = eventsForSubject(sim(), { vehicleId: v });
      expect(vr.length).toBeGreaterThan(0);
      for (const e of sim().events.filter((x) => x.asset.vehicleId === v)) expect(vr.some((r) => r.id === e.id), e.id).toBe(true);
      expect(useApp.getState().selectedEventId).toBe(vr[0].id);
    }
  });
});
