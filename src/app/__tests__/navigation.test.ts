/**
 * Browser history of the app navigation (src/app/store.ts), against a minimal fake browser.
 * The landing address is a retired one (#/monitoring), which must redirect to Production. Then:
 * user steps add entries so Back / Forward move between workspaces, stages and events; automatic
 * selections rewrite the current entry; typed deep links still open; Reset Demo clears the selected
 * event (and its #/events/<id> hash) on every workspace, and an entry from before the reset does not
 * reopen its (now reused) event id.
 */
import { describe, expect, it, vi } from 'vitest';

const browser = vi.hoisted(() => {
  // The sim store starts its clock and background baseline builds when a window exists: keep them idle.
  vi.useFakeTimers();
  type Entry = { hash: string; state: unknown };
  const listeners = new Map<string, (() => void)[]>();
  const entries: Entry[] = [{ hash: '#/monitoring/KILN', state: null }];
  let index = 0;
  const clone = (v: unknown) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  const fire = (type: string) => listeners.get(type)?.forEach((fn) => fn());
  const g = globalThis as Record<string, unknown>;
  g.window = {
    addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener() {},
    innerWidth: 1920,
    innerHeight: 1080,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
  g.location = {
    get hash() {
      return entries[index].hash;
    },
  };
  g.history = {
    get state() {
      return clone(entries[index].state);
    },
    get length() {
      return entries.length;
    },
    pushState(state: unknown, _title: string, url?: string) {
      entries.splice(index + 1);
      entries.push({ hash: url ?? entries[index].hash, state: clone(state) });
      index++;
    },
    replaceState(state: unknown, _title: string, url?: string) {
      entries[index] = { hash: url ?? entries[index].hash, state: clone(state) };
    },
  };
  // Back / Forward: the browser fires popstate, then hashchange when the fragment differs.
  const traverse = (delta: number) => {
    const from = entries[index].hash;
    index = Math.min(entries.length - 1, Math.max(0, index + delta));
    fire('popstate');
    if (entries[index].hash !== from) fire('hashchange');
  };
  return {
    back: () => traverse(-1),
    forward: () => traverse(1),
    /** The user types (or follows) a hash: a new entry without state. */
    open: (hash: string) => {
      entries.splice(index + 1);
      entries.push({ hash, state: null });
      index++;
      fire('popstate');
      fire('hashchange');
    },
    get hash() {
      return entries[index].hash;
    },
    get length() {
      return entries.length;
    },
  };
});

import { openDefect, openEvent, openFleetVehicle, openStage, useApp } from '../store';
import { useSim } from '../../sim/store';

useSim.getState().pause();

const app = () => useApp.getState();
const ids = () => {
  const ev = useSim.getState().sim.events;
  return { a: ev[ev.length - 1].id, b: ev[ev.length - 2].id, c: ev[0].id };
};

describe('browser history of the app navigation', () => {
  it('a retired address redirects in place to its new home, keeping the stage', () => {
    expect(app()).toMatchObject({ workspace: 'production', productionStage: 'KILN' });
    expect(browser.hash).toBe('#/production/KILN');
    expect(browser.length).toBe(1);
  });

  it('Back / Forward move between workspaces, stages, tabs and events', () => {
    const { a, b } = ids();
    app().selectStage(null); // back to all stages
    const start = browser.length;
    app().selectStage('PRESS'); // stage click
    expect(browser.hash).toBe('#/production/PRESS');
    app().setTab('production', 'oee'); // OEE & losses tab
    expect(browser.hash).toBe('#/production/PRESS?tab=oee');
    openEvent(a); // event link
    expect(browser.hash).toBe(`#/events/${a}`);
    app().selectEvent(b); // list click in Events & Reports
    expect(browser.hash).toBe(`#/events/${b}`);
    expect(browser.length).toBe(start + 4);

    browser.back();
    expect(app()).toMatchObject({ workspace: 'events', selectedEventId: a });
    browser.back();
    expect(app()).toMatchObject({ workspace: 'production', productionStage: 'PRESS' });
    expect(app().tabs.production).toBe('oee');
    browser.back();
    expect(app()).toMatchObject({ workspace: 'production', productionStage: 'PRESS' });
    expect(app().tabs.production).toBeUndefined();
    browser.back();
    expect(app()).toMatchObject({ workspace: 'production', productionStage: null });

    browser.forward();
    browser.forward();
    browser.forward();
    browser.forward();
    expect(app()).toMatchObject({ workspace: 'events', selectedEventId: b });
    expect(browser.length).toBe(start + 4);
  });

  it('automatic selections and repeated workspace clicks add no history entry', () => {
    const { a } = ids();
    const n = browser.length;
    app().go('events'); // already open
    expect(browser.length).toBe(n);
    app().selectEvent(a, 'replace'); // newest event opened on arrival / arrow-key move
    expect(browser.hash).toBe(`#/events/${a}`);
    expect(browser.length).toBe(n);
    app().go('quality');
    app().go('quality');
    expect(browser.hash).toBe('#/quality');
    expect(browser.length).toBe(n + 1);
  });

  it('records open in their workspace: defects, vehicles, stages', () => {
    const { a } = ids();
    openDefect(a);
    expect(browser.hash).toBe(`#/quality/${a}`);
    expect(app().qualityEventId).toBe(a);
    openFleetVehicle('FL-02');
    expect(browser.hash).toBe('#/fleet/FL-02');
    openStage('GLAZE');
    expect(browser.hash).toBe('#/production/GLAZE');
    browser.back();
    expect(app()).toMatchObject({ workspace: 'fleet', fleetVehicleId: 'FL-02' });
    browser.back();
    expect(app()).toMatchObject({ workspace: 'quality', qualityEventId: a });
  });

  it('a typed deep link still opens its event or stage; retired links redirect', () => {
    const { c } = ids();
    browser.open(`#/events/${c}`);
    expect(app()).toMatchObject({ workspace: 'events', selectedEventId: c });
    browser.open('#/monitoring/PRESS');
    expect(app()).toMatchObject({ workspace: 'production', productionStage: 'PRESS' });
    expect(browser.hash).toBe('#/production/PRESS');
    browser.open('#/energy');
    expect(app().workspace).toBe('overview');
    expect(browser.hash).toBe('#/overview');
    browser.open('#/assets');
    expect(app().workspace).toBe('twin');
    browser.open('#/scenarios');
    expect(app()).toMatchObject({ workspace: 'overview', scenariosOpen: true });
    app().setScenariosOpen(false);
    browser.open('#/nowhere');
    expect(app().workspace).toBe('overview');
  });

  it('go() with a retired id lands on the new home', () => {
    app().go('monitoring');
    expect(app().workspace).toBe('production');
    app().go('scenarios');
    expect(app()).toMatchObject({ workspace: 'overview', scenariosOpen: true });
    app().setScenariosOpen(false);
  });

  it('Reset Demo from another workspace clears the selected event, so Events & Reports does not reopen its id', () => {
    const { a } = ids();
    openEvent(a);
    app().go('overview');
    useSim.getState().resetNow();
    expect(app().selectedEventId).toBeNull();
    app().go('events');
    expect(browser.hash).toBe('#/events');
  });

  it('Reset Demo on Events & Reports rewrites #/events/<id> in place', () => {
    const { a } = ids();
    openEvent(a);
    expect(browser.hash).toBe(`#/events/${a}`);
    const n = browser.length;
    useSim.getState().resetNow();
    expect(app().selectedEventId).toBeNull();
    expect(browser.hash).toBe('#/events');
    expect(browser.length).toBe(n);
  });

  it('Reset Demo clears an open defect too', () => {
    const { a } = ids();
    openDefect(a);
    useSim.getState().resetNow();
    expect(app().qualityEventId).toBeNull();
    expect(browser.hash).toBe('#/quality');
  });

  it('Back into an entry written before the reset does not reopen its event id', () => {
    const { a, c } = ids();
    openEvent(a);
    app().go('twin');
    useSim.getState().resetNow();
    app().go('events');
    app().selectEvent(c, 'replace'); // what Events & Reports does on arrival: the newest event
    browser.back();
    expect(app().workspace).toBe('twin');
    browser.back(); // #/events/<a> from the previous reset epoch
    expect(app()).toMatchObject({ workspace: 'events', selectedEventId: c });
    expect(browser.hash).toBe(`#/events/${c}`);
    // The current epoch's entry still opens normally.
    browser.forward();
    browser.forward();
    expect(app()).toMatchObject({ workspace: 'events', selectedEventId: c });
  });
});
