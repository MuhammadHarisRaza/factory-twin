/**
 * Serialises twin renders and spaces them out: one render at a time, and at least `minIntervalMs`
 * between the end of one and the start of the next (500 ms → at most 2 renders per second for all
 * camera feeds and evidence captures together). A failing job does not stall the queue.
 */
export type QueueClock = { now: () => number; wait: (ms: number) => Promise<void> };

const realClock: QueueClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export function createRenderQueue(minIntervalMs: number, clock: QueueClock = realClock) {
  let tail: Promise<unknown> = Promise.resolve();
  let last = -Infinity;
  let waiting = 0;
  return {
    run<T>(job: () => Promise<T> | T): Promise<T> {
      waiting++;
      const p = tail.then(async () => {
        const gap = last + minIntervalMs - clock.now();
        if (gap > 0) await clock.wait(gap);
        try {
          return await job();
        } finally {
          last = clock.now();
          waiting--;
        }
      });
      tail = p.catch(() => undefined);
      return p;
    },
    /** Jobs queued or running. */
    get size() {
      return waiting;
    },
  };
}
