/**
 * Per-minute memo shared by every caller: a derivation of the simulation state that several surfaces ask for in the
 * same simulated minute (the rule engine's plant, stage and equipment passes, the equipment panel's charts, tiles and
 * table, the stage panel…) is computed once per state, minute and version. Results are shared — treat them as
 * read-only. Every change to the state bumps `s.version` (the store's contract), which drops the entries.
 */
import type { SimState } from './engine';

type Entry<R> = { minute: number; version: number; map: Map<string, R> };

export function minuteMemo<A extends unknown[], R>(fn: (s: SimState, ...args: A) => R, keyOf: (...args: A) => string, max = 512): (s: SimState, ...args: A) => R {
  const cache = new WeakMap<SimState, Entry<R>>();
  return (s, ...args) => {
    let c = cache.get(s);
    if (!c || c.minute !== s.minute || c.version !== s.version) cache.set(s, (c = { minute: s.minute, version: s.version, map: new Map() }));
    const key = keyOf(...args);
    if (c.map.has(key)) return c.map.get(key)!;
    const value = fn(s, ...args);
    if (c.map.size >= max) c.map.delete(c.map.keys().next().value!);
    c.map.set(key, value);
    return value;
  };
}
