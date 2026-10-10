/**
 * Browser history of the app navigation (src/app/store.ts), against a minimal fake browser:
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
  const entries: Entry[] = [{ hash: '#/monitoring', state: null }];
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

import { openEvent, useApp } from '../../app/store';
import { useSim } from '../../sim/store';

useSim.getState().pause();

const app = () => useApp.getState();
const ids = () => {
  const ev = useSim.getState().sim.events;
  return { a: ev[ev.length - 1].id, b: ev[ev.length - 2].id, c: ev[0].id };
};

describe('browser history of the app navigation', () => {
  it('Back / Forward move between workspaces, stages and events (deep link #/monitoring)', () => {
    const { a, b } = ids();
    expect(app().workspace).toBe('monitoring');
    const start = browser.length;
    app().selectStage('KILN'); // stage card click
    expect(browser.hash).toBe('#/monitoring/KILN');
    openEvent(a); // event link in the stage view
    expect(browser.hash).toBe(`#/events/${a}`);
    app().selectEvent(b); // list click in Events & Reports
    expect(browser.hash).toBe(`#/events/${b}`);
    expect(browser.length).toBe(start + 3);

    browser.back();
    expect(app()).toMatchObject({ workspace: 'events', selectedEventId: a });
    browser.back();
    expect(app()).toMatchObject({ workspace: 'monitoring', monitoringStage: 'KILN' });
    browser.back();
    expect(app()).toMatchObject({ workspace: 'monitoring', monitoringStage: null });

    browser.forward();
    expect(app()).toMatchObject({ workspace: 'monitoring', monitoringStage: 'KILN' });
    browser.forward();
    browser.forward();
    expect(app()).toMatchObject({ workspace: 'events', selectedEventId: b });
    expect(browser.length).toBe(start + 3);
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

  it('a typed deep link still opens its event or stage', () => {
    const { c } = ids();
    browser.open(`#/events/${c}`);
    expect(app()).toMatchObject({ workspace: 'events', selectedEventId: c });
    browser.open('#/monitoring/PRESS');
    expect(app()).toMatchObject({ workspace: 'monitoring', monitoringStage: 'PRESS' });
  });

  it('Reset Demo from another workspace clears the selected event, so Events & Reports does not reopen its id', () => {
    const { a } = ids();
    openEvent(a);
    app().go('scenarios');
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
