/**
 * Deterministic randomness. Each entity draws from its own stream derived from
 * (seed, key), so adding an event to one machine never shifts another machine's
 * sequence — scenarios stay reproducible and local in effect.
 */

/** 32-bit string hash (FNV-1a). */
export function hashString(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: returns floats in [0, 1). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = ReturnType<typeof mulberry32>;

export const streamFor = (seed: number, key: string): Rng => mulberry32(hashString(`${seed}:${key}`));

/** Stateless deterministic value in [0, 1) for (seed, key, index). */
export const noise01 = (seed: number, key: string, index: number) => mulberry32(hashString(`${seed}:${key}:${index}`))();

export const lerpRange = (rand: number, min: number, max: number) => min + (max - min) * rand;

/** Exponential draw with mean `mean`, truncated to [min, max]. */
export const expBounded = (rand: number, mean: number, min: number, max: number) =>
  Math.min(max, Math.max(min, -Math.log(1 - rand) * mean));

/** Weighted pick from [item, weight] pairs. */
export function weighted<T>(rand: number, items: [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = rand * total;
  for (const [item, w] of items) {
    x -= w;
    if (x < 0) return item;
  }
  return items[items.length - 1][0];
}
