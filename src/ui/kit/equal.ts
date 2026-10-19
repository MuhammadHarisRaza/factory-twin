/**
 * Structural equality for derived view models (fresh objects of primitives, rebuilt each simulated minute), so a
 * memoised section whose model did not change skips its render. Functions and class instances compare by reference;
 * so do two references to the same object — never pass mutable simulation records (events, vehicles) to a component
 * memoised with this, their content can change under the same reference.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }
  const pa = Object.getPrototypeOf(a);
  if (pa !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const ka = Object.keys(a as object);
  if (ka.length !== Object.keys(b as object).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** memo() comparator: props equal structurally (see deepEqual). */
export const sameProps = <P extends object>(a: P, b: P) => deepEqual(a, b);
