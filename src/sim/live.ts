/**
 * Throttle of the live views' expensive derivations (rule findings, history charts): a live view takes the last
 * result while it is fresh enough (the caller decides: a few simulated minutes, the same hour…) and nothing material
 * changed since — no scenario started or ended, no event was recorded, no stop began or ended, no data feed changed
 * state and no event rule was edited; otherwise it is computed again at once. The views say when such a result was
 * made ("evaluated hh:mm", "checked hh:mm", "to hh:mm"). Direct callers (reports, tests, Copilot) compute it now.
 */
import type { SimState } from './engine';

const ids = new WeakMap<object, number>();
let seq = 0;
const idOf = (o: object) => {
  let n = ids.get(o);
  if (n == null) ids.set(o, (n = ++seq));
  return n;
};

/** What would make a live result out of date at once (anything else only ages it). */
export function materialKey(s: SimState): string {
  const parts: (string | number)[] = [idOf(s.rules), s.events.length, s.scenarios.length];
  for (const sc of s.scenarios) parts.push(`${sc.id}:${sc.end ?? ''}`);
  for (const id in s.machines) parts.push(s.machines[id].activeDowntimeId ?? '');
  for (const id in s.feeds) parts.push(s.feeds[id].status);
  return parts.join('|');
}

export type Live<T> = { value: T; /** Plant minute the value was computed at. */ at: number };

const cache = new WeakMap<SimState, Map<string, { at: number; key: string; value: unknown }>>();

/**
 * `compute()` for a live view, reused while `fresh(at, now, value)` holds for the minute it was computed at and the
 * material key (plus the caller's `key`) is unchanged.
 */
export function liveValue<T>(s: SimState, name: string, key: string, fresh: (at: number, now: number, value: T) => boolean, compute: () => T): Live<T> {
  let byName = cache.get(s);
  if (!byName) cache.set(s, (byName = new Map()));
  const k = `${key}|${materialKey(s)}`;
  const hit = byName.get(name);
  if (hit && hit.key === k && s.minute >= hit.at && (hit.at === s.minute || fresh(hit.at, s.minute, hit.value as T))) return { value: hit.value as T, at: hit.at };

  const value = compute();
  byName.set(name, { at: s.minute, key: k, value });
  return { value, at: s.minute };
}
