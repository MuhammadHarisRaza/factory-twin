import { beforeAll, describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim, type SimState } from '../../sim/engine';
import { DEFAULT_FILTERS, facetCounts, filterEvents, inWindow, isDefault, matchesQuery, pageBounds, pageOf, searchText, windowRange, type EventFilters } from './filters';

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
});

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
});

