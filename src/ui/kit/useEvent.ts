import { useCallback, useRef } from 'react';

/**
 * A callback with a stable identity that always runs the latest `fn` (its closure sees the latest props), so a
 * handler passed down does not defeat the children's memoisation each simulated minute. The latest `fn` is taken at
 * render, so children may also call it while rendering (e.g. "has this signal a row?").
 */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
