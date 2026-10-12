import { beforeAll, describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import { REPORT_PERIODS, REPORT_TYPES, buildOpsReport, type OpsReportType } from '../../report/ops';
import { isSignificant } from '../../report/ops/select';
import { eventInMonitoredStage } from '../../sim/events';
import { resolvePeriod } from '../../sim/metrics';
import {
  ALL_EVENTS_FILTERS,
  CATEGORY_ORDER,
  DEFAULT_FILTERS,
  PAGE_SIZE,
  WINDOW_OPTIONS,
  facetCounts,
  filterEvents,
  inWindow,
  isDefault,
  matchesQuery,
  pageBounds,
  pageOf,
  reportFilters,
  searchText,
  windowOptions,
  windowRange,
  type EventFilters,
} from './filters';

let s: SimState;
const ctx = () => ({ now: s.minute, vehicleLabel: (id: string) => s.logistics.vehicles[id]?.label });
const f = (p: Partial<EventFilters>): EventFilters => ({ ...DEFAULT_FILTERS, ...p });

beforeAll(() => {
  s = createSim(51, 2 * 1440 + 240);
  s.liveFrom = s.minute;
  const t0 = s.minute;
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 20, label: 'Kiln infeed stop' });
  activateScenario(s, { kind: 'machine-stop', equipmentId: 'E-PRS1', end: null, label: 'Press stop' });
  advance(s, t0 + 30);
}, 120_000);

describe('event filters', () => {
  it('lists newest first and respects the time window', () => {
    const all = filterEvents(s.events, f({ window: 'all' }), ctx());
    expect(all.length).toBe(s.events.length);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].start).toBeGreaterThanOrEqual(all[i].start);
    const w4 = filterEvents(s.events, f({ window: '4h' }), ctx());
    const r = windowRange('4h', s.minute);
    expect(w4.every((e) => (e.end ?? s.minute) >= r.from)).toBe(true);
    expect(w4.length).toBeLessThan(all.length);
    // An active event always overlaps any window.
    const active = s.events.find((e) => e.end == null)!;
    expect(inWindow(active, windowRange('4h', s.minute + 10_000), s.minute + 10_000)).toBe(true);
  });

  it('separates this session from the pre-rolled history', () => {
    const session = filterEvents(s.events, f({ window: 'all', sessionOnly: true }), ctx());
    expect(session.length).toBeGreaterThan(0);
    expect(session.every((e) => !e.historical)).toBe(true);
    expect(session.some((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-KIN')).toBe(true);
  });

  it('filters by category, status, severity and condition', () => {
    const c = ctx();
    const prod = filterEvents(s.events, f({ window: 'all', category: 'production' }), c);
    expect(prod.length).toBeGreaterThan(0);
    expect(prod.every((e) => e.category === 'production')).toBe(true);
    expect(filterEvents(s.events, f({ window: 'all', status: 'open' }), c).every((e) => e.status !== 'resolved')).toBe(true);
    expect(filterEvents(s.events, f({ window: 'all', status: 'resolved' }), c).every((e) => e.status === 'resolved')).toBe(true);
    expect(filterEvents(s.events, f({ window: 'all', condition: 'active' }), c).every((e) => e.end == null)).toBe(true);
    expect(filterEvents(s.events, f({ window: 'all', condition: 'cleared' }), c).every((e) => e.end != null)).toBe(true);
    const sev = s.events[0].severity;
    expect(filterEvents(s.events, f({ window: 'all', severity: sev }), c).every((e) => e.severity === sev)).toBe(true);
  });

  it('searches ids, asset names and vehicle labels', () => {
    const c = ctx();
    const ev = s.events.find((e) => e.asset.equipmentId === 'CV-KIN' && !e.historical)!;
    expect(filterEvents(s.events, f({ window: 'all', query: ev.id.toLowerCase() }), c).map((e) => e.id)).toEqual([ev.id]);
    expect(filterEvents(s.events, f({ window: 'all', query: 'kiln infeed' }), c).some((e) => e.id === ev.id)).toBe(true);
    const veh = s.events.find((e) => e.asset.vehicleId);
    if (veh) {
      const label = s.logistics.vehicles[veh.asset.vehicleId!]?.label;
      if (label) expect(searchText(veh, c.vehicleLabel)).toContain(label.toLowerCase());
    }
    expect(matchesQuery('ev-00012 kiln stop', 'stop KILN')).toBe(true);
    expect(matchesQuery('ev-00012 kiln stop', 'press')).toBe(false);
  });

  it('counts facets without their own filter', () => {
    const c = ctx();
    const filters = f({ window: 'all', category: 'production' });
    const fc = facetCounts(s.events, filters, c);
    // Category counts ignore the category filter; status counts honour it.
    expect(fc.category.all).toBe(s.events.length);
    expect(fc.category.production).toBe(s.events.filter((e) => e.category === 'production').length);
    expect(fc.status.all).toBe(filterEvents(s.events, filters, c).length);
    expect(fc.status.active + fc.status.acknowledged + fc.status.investigating + fc.status.resolved).toBe(fc.status.all);
    expect(fc.status.open).toBe(fc.status.all - fc.status.resolved);
    expect(fc.condition.active + fc.condition.cleared).toBe(fc.condition.all);
  });

  it('filters by production stage (the Production rule) and by source, and offers no energy category', () => {
    const c = ctx();
    const kiln = filterEvents(s.events, f({ window: 'all', stage: 'KILN' }), c);
    expect(kiln.length).toBeGreaterThan(0);
    expect(kiln.every((e) => eventInMonitoredStage(MONITORED_STAGE_BY_ID.KILN, e))).toBe(true);
    expect(kiln.some((e) => e.asset.equipmentId === 'CV-KIN')).toBe(true);
    const press = filterEvents(s.events, f({ window: 'all', stage: 'PRESS' }), c);
    expect(press.some((e) => e.asset.equipmentId === 'E-PRS1')).toBe(true);
    const scen = filterEvents(s.events, f({ window: 'all', source: 'scenario' }), c);
    expect(scen.length).toBeGreaterThan(0);
    expect(scen.every((e) => e.source === 'scenario')).toBe(true);
    expect(filterEvents(s.events, f({ window: 'all', source: 'simulation' }), c).every((e) => e.source === 'simulation')).toBe(true);
    const fc = facetCounts(s.events, f({ window: 'all', stage: 'KILN' }), c);
    // Stage counts ignore the stage filter; source counts honour it.
    expect(fc.stage.KILN).toBe(kiln.length);
    expect(fc.stage.all).toBe(s.events.length);
    expect(fc.source.simulation + fc.source.scenario).toBe(fc.source.all);
    expect(fc.source.all).toBe(kiln.length);
    expect(CATEGORY_ORDER).not.toContain('energy');
    // Rule ids are searchable (the rules tab lists a rule's events this way).
    const conv = s.events.find((e) => e.trigger.ruleId === 'R-CONV')!;
    expect(filterEvents(s.events, f({ window: 'all', query: 'R-CONV' }), c).map((e) => e.id)).toContain(conv.id);
  });

  it('paginates', () => {
    expect(pageBounds(0, 0)).toEqual({ page: 0, pages: 1, from: 0, to: 0 });
    expect(pageBounds(95, 1, 40)).toEqual({ page: 1, pages: 3, from: 40, to: 80 });
    expect(pageBounds(95, 9, 40)).toEqual({ page: 2, pages: 3, from: 80, to: 95 });
    expect(pageBounds(95, -3, 40).page).toBe(0);
    expect(pageOf(0, 40)).toBe(0);
    expect(pageOf(79, 40)).toBe(1);
    expect(pageOf(-1, 40)).toBe(0);
    expect(isDefault(DEFAULT_FILTERS)).toBe(true);
    expect(isDefault(f({ query: 'x' }))).toBe(false);
  });

  it("'Show all events' lists an open report older than 24 h, on a page after the first", () => {
    // The deep-linked / related event the page reveals after widening (EventsPage: reveal → pageOf(index)).
    const c = ctx();
    const listed = new Set(filterEvents(s.events, DEFAULT_FILTERS, c).map((e) => e.id));
    const all = filterEvents(s.events, ALL_EVENTS_FILTERS, c);
    expect(all.length).toBe(s.events.length);
    expect(all.length).toBeGreaterThan(PAGE_SIZE);
    const i = all.findIndex((e) => !listed.has(e.id));
    expect(i).toBeGreaterThanOrEqual(0);
    const oldest = all.length - 1;
    expect(listed.has(all[oldest].id)).toBe(false);
    for (const idx of [i, oldest]) {
      const pb = pageBounds(all.length, pageOf(idx));
      expect(all.slice(pb.from, pb.to).map((e) => e.id)).toContain(all[idx].id);
    }
    expect(pageOf(oldest)).toBeGreaterThan(0);
  });
});

describe("a report's events in the Events tab (#0, #23)", () => {
  it('the report filters list exactly the events of every report type, period and scope', () => {
    const c = ctx();
    for (const def of REPORT_TYPES) {
      if (def.id === 'incident') continue;
      // The whole line and two stage scopes (stage membership is the same rule for every stage).
      const scopes = def.scopes.length ? [def.scopes[0], ...def.scopes.slice(1).filter((x) => x === 'KILN' || x === 'GLAZE')] : (['line'] as const);
      for (const period of REPORT_PERIODS)
        for (const scope of scopes) {
          const r = buildOpsReport(s, def.id as OpsReportType, { period, scope });
          const listed = filterEvents(s.events, reportFilters(r.eventQuery), c).map((e) => e.id);
          expect(new Set(listed), `${def.id} · ${period} · ${scope}`).toEqual(new Set(r.events.map((e) => e.id)));
          expect(listed.length).toBe(r.events.length);
        }
    }
  });

  it('sets the window, the significance rule, the categories and the stage, and clears the rest', () => {
    const shift = reportFilters({ period: '7d', categories: ['production', 'equipment', 'data'], stage: null });
    expect(shift).toMatchObject({ window: '7d', significantOnly: true, category: 'all', categories: ['production', 'equipment', 'data'], stage: 'all', status: 'all', query: '', sessionOnly: false });
    expect(reportFilters({ period: 'prev-shift', categories: ['quality'], stage: 'GLAZE' })).toMatchObject({ window: 'prev-shift', category: 'quality', categories: null, stage: 'GLAZE' });
    expect(reportFilters({ period: 'shift', categories: null, stage: 'KILN' })).toMatchObject({ category: 'all', categories: null, stage: 'KILN' });
    expect(isDefault(shift)).toBe(false);
  });

  it('"root events, warning and above" keeps only root events of warning severity or more', () => {
    const c = ctx();
    const sig = filterEvents(s.events, f({ window: 'all', significantOnly: true }), c);
    expect(sig.length).toBeGreaterThan(0);
    expect(sig.every((e) => !e.consequenceOf && e.severity !== 'info')).toBe(true);
    expect(sig.length).toBe(s.events.filter((e) => isSignificant(e)).length);
    // A category group keeps its categories only; the category facet counts inside the group.
    const grp = f({ window: 'all', categories: ['production', 'equipment'] });
    expect(filterEvents(s.events, grp, c).every((e) => e.category === 'production' || e.category === 'equipment')).toBe(true);
    expect(facetCounts(s.events, grp, c).category.quality).toBe(0);
  });

  it('windows named like the header periods are those periods; the previous shift ends at its end', () => {
    const now = s.minute;
    for (const k of ['shift', 'today', '24h', '7d'] as const) {
      const w = windowRange(k, now);
      expect(w.from, k).toBe(resolvePeriod(k, now).from);
      expect(w.to).toBe(now);
    }
    const prev = resolvePeriod('prev-shift', now);
    expect(windowRange('prev-shift', now)).toMatchObject({ from: prev.from, to: prev.to });
    // An event that started exactly when the previous shift ended belongs to the current one.
    expect(inWindow({ start: prev.to, end: prev.to + 5 } as never, windowRange('prev-shift', now), now)).toBe(false);
    expect(inWindow({ start: prev.to - 1, end: prev.to + 5 } as never, windowRange('prev-shift', now), now)).toBe(true);
    // The extra windows are offered while selected.
    expect(windowOptions('24h')).toBe(WINDOW_OPTIONS);
    expect(windowOptions('prev-shift').map((o) => o.value)).toEqual(['4h', 'shift', 'prev-shift', '24h', '7d', 'all']);
  });
});
