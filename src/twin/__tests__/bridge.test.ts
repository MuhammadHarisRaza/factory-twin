/**
 * The evidence image store (src/twin/bridge.ts) is bounded: images whose evidence the engine pruned
 * from the session history are dropped (`retainImagesFor`), Reset Demo clears all of them, and the
 * oldest go first once the stored data URLs exceed the memory budget.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { advance, createSim, DEFAULT_SEED } from '../../sim/engine';
import { DEFAULT_START, MIN_PER_DAY } from '../../sim/time';
import {
  clearImages,
  getImage,
  imageStoreStats,
  MAX_IMAGE_CHARS,
  putImage,
  retainImages,
  retainImagesFor,
  setImageBudgetForTests,
  type TwinRender,
} from '../bridge';

const img = (chars: number, tag = 'x'): TwinRender => ({ dataUrl: `data:image/jpeg;base64,${tag.repeat(Math.max(0, chars - 23))}`, width: 2, height: 2 });

afterEach(() => {
  setImageBudgetForTests(null);
  clearImages();
});

describe('evidence image store', () => {
  it('stores, replaces and clears images, tracking their size', () => {
    putImage('EVD-1', img(100));
    putImage('EVD-2', img(200));
    expect(getImage('EVD-1')?.dataUrl.length).toBe(100);
    expect(imageStoreStats()).toMatchObject({ count: 2, chars: 300, budget: MAX_IMAGE_CHARS });
    putImage('EVD-1', img(50)); // replace: size is not counted twice
    expect(imageStoreStats()).toMatchObject({ count: 2, chars: 250 });
    clearImages();
    expect(getImage('EVD-2')).toBeNull();
    expect(imageStoreStats()).toMatchObject({ count: 0, chars: 0 });
  });

  it('retainImages drops the keys that fail the predicate', () => {
    for (const k of ['A', 'B', 'C']) putImage(k, img(40));
    retainImages((k) => k !== 'B');
    expect(getImage('B')).toBeNull();
    expect(getImage('A')).not.toBeNull();
    expect(imageStoreStats()).toMatchObject({ count: 2, chars: 80 });
  });

  it('retainImagesFor keeps only images of evidence still in the array, and skips an unchanged array', () => {
    const evidence = [{ id: 'EVD-1' }, { id: 'EVD-2' }];
    putImage('EVD-1', img(40));
    putImage('EVD-2', img(40));
    retainImagesFor(evidence);
    expect(imageStoreStats().count).toBe(2);
    // Evidence is appended in place between prunes: the same array is a no-op (no per-minute sweep).
    evidence.push({ id: 'EVD-3' });
    putImage('EVD-3', img(40));
    retainImagesFor(evidence);
    expect(imageStoreStats().count).toBe(3);
    // A prune reassigns the array: images of the dropped evidence go.
    retainImagesFor(evidence.filter((x) => x.id !== 'EVD-1'));
    expect(getImage('EVD-1')).toBeNull();
    expect(getImage('EVD-2')).not.toBeNull();
    expect(getImage('EVD-3')).not.toBeNull();
    expect(imageStoreStats()).toMatchObject({ count: 2, chars: 80 });
  });

  it('evicts the oldest images once over the memory budget (the newest always stays)', () => {
    setImageBudgetForTests(250);
    putImage('EVD-1', img(100));
    putImage('EVD-2', img(100));
    putImage('EVD-1', img(100)); // re-put: EVD-1 becomes the newest
    putImage('EVD-3', img(100)); // 300 > 250 → the oldest (EVD-2) goes
    expect(getImage('EVD-2')).toBeNull();
    expect(getImage('EVD-1')).not.toBeNull();
    expect(getImage('EVD-3')).not.toBeNull();
    expect(imageStoreStats()).toMatchObject({ count: 2, chars: 200 });
    putImage('EVD-4', img(400)); // larger than the whole budget: kept alone
    expect(imageStoreStats()).toMatchObject({ count: 1, chars: 400 });
    expect(getImage('EVD-4')).not.toBeNull();
  });

  it('regression: images of evidence pruned by the engine are released (no growth with session length)', () => {
    const s = createSim(DEFAULT_SEED, DEFAULT_START);
    const put = () => {
      for (const x of s.evidence) if (!getImage(x.id)) putImage(x.id, img(64, x.id.slice(-1)));
    };
    put();
    const before = new Set(s.evidence.map((x) => x.id));
    expect(before.size).toBeGreaterThan(0);
    retainImagesFor(s.evidence);
    // Run two more simulated days (past the eight-day retention of the first records), storing an image
    // for every new evidence item each simulated hour as the capturer would, and syncing the store
    // after every step (as the live clock would).
    const end = s.minute + 2 * MIN_PER_DAY;
    let pruned = 0;
    while (s.minute < end) {
      const ev0 = s.evidence;
      advance(s, s.minute + 60);
      if (s.evidence !== ev0) pruned++;
      retainImagesFor(s.evidence);
      put();
    }
    expect(pruned).toBeGreaterThan(0);
    const live = new Set(s.evidence.map((x) => x.id));
    const dropped = [...before].filter((id) => !live.has(id));
    expect(dropped.length).toBeGreaterThan(0);
    for (const id of dropped) expect(getImage(id)).toBeNull();
    // Exactly the live evidence is held — nothing of the pruned history.
    expect(imageStoreStats().count).toBe(live.size);
    for (const id of live) expect(getImage(id)).not.toBeNull();
  });

  it('Reset Demo (clearImages) also forgets the last evidence array, so the next sync sweeps', () => {
    const evidence = [{ id: 'EVD-1' }];
    retainImagesFor(evidence);
    clearImages();
    putImage('EVD-9', img(40)); // e.g. a stray image put for an id the new simulation does not have
    retainImagesFor(evidence);
    expect(getImage('EVD-9')).toBeNull();
  });
});
