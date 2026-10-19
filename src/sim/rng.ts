/**
 * Deterministic randomness. Each entity draws from its own stream derived from
 * (seed, key), so adding an event to one machine never shifts another machine's
 * sequence — scenarios stay reproducible and local in effect.
 */

/** FNV-1a state after `s`, continuing from state `h` (int32 arithmetic, so a prefix's state can be reused). */
function fnv(h: number, s: string) {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h;
}

/** 32-bit string hash (FNV-1a). */
export function hashString(s: string) {
  return fnv(2166136261, s) >>> 0;
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

/** The first value of mulberry32(seed) (no closure). */
function firstOf(seed: number) {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * The hash state of the key part `${seed}:${key}:` of a noise stream: hot callers (process values, condition
 * sensors) keep it per entity and draw with noiseAt / smoothNoiseAt instead of hashing the key on every draw.
 */
export const noiseKey = (seed: number, key: string) => fnv(2166136261, `${seed}:${key}:`);

/** noise01 of a stream from its key state (noiseKey). */
export const noiseAt = (keyState: number, index: number) => firstOf(fnv(keyState, String(index)) >>> 0);

/**
 * Stateless deterministic value in [0, 1) for (seed, key, index): mulberry32(hashString(`${seed}:${key}:${index}`))()
 * (same values, without building the whole string or a generator closure).
 */
export const noise01 = (seed: number, key: string, index: number) => noiseAt(noiseKey(seed, key), index);

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

/** Smooth bounded noise in [0, 1) for (seed, key) over time: smoothstep between knots every `period` minutes. */
export function smoothNoise(seed: number, key: string, t: number, period: number) {
  return smoothNoiseAt(noiseKey(seed, key), t, period);
}

/** smoothNoise of a stream from its key state (noiseKey). */
export function smoothNoiseAt(keyState: number, t: number, period: number) {
  const k = Math.floor(t / period);
  const f = (t - k * period) / period;
  const a = noiseAt(keyState, k);
  const b = noiseAt(keyState, k + 1);
  return a + (b - a) * (f * f * (3 - 2 * f));
}
