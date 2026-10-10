import { describe, expect, it } from 'vitest';
import { HALL, SITE, ZONE_BY_ID } from '../../data/layout';
import { CAMERAS, GEOFENCES } from '../../model/plant';
import { AIM_Y, CCTV_FOV, CCTV_POSES, FOCUS_MAX_SHIFT, resolvePose, type BoundsLike } from './poses';
import { createRenderQueue, type QueueClock } from './queue';
import { flipRowsInto, renderSize } from './pixels';

const inRect = (r: { x: [number, number]; z: [number, number] }, x: number, z: number, m = 0) => x >= r.x[0] - m && x <= r.x[1] + m && z >= r.z[0] - m && z <= r.z[1] + m;

/** Whether a ground point is inside the camera's field of view (16:9, vertical fov). */
function inView(cameraId: string, x: number, y: number, z: number) {
  const p = resolvePose(cameraId)!;
  const [px, py, pz] = p.position;
  const f = [p.target[0] - px, p.target[1] - py, p.target[2] - pz];
  const fl = Math.hypot(...f);
  const fw = f.map((v) => v / fl);
  // right = forward × up, up' = right × forward
  const r = [-fw[2], 0, fw[0]];
  const rl = Math.hypot(...r);
  const rn = r.map((v) => v / rl);
  const u = [rn[1] * fw[2] - rn[2] * fw[1], rn[2] * fw[0] - rn[0] * fw[2], rn[0] * fw[1] - rn[1] * fw[0]];
  const d = [x - px, y - py, z - pz];
  const depth = d[0] * fw[0] + d[1] * fw[1] + d[2] * fw[2];
  if (depth <= 0) return false;
  const half = Math.tan(((p.fov / 2) * Math.PI) / 180);
  const sx = (d[0] * rn[0] + d[1] * rn[1] + d[2] * rn[2]) / depth;
  const sy = (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / depth;
  return Math.abs(sy) <= half && Math.abs(sx) <= half * (16 / 9);
}

describe('CCTV poses', () => {
  it('defines exactly one pose per camera', () => {
    expect(Object.keys(CCTV_POSES).sort()).toEqual(CAMERAS.map((c) => c.id).sort());
  });

  it('mounts every camera high, inside the site, looking down at its own zone', () => {
    for (const cam of CAMERAS) {
      const p = CCTV_POSES[cam.id];
      const [x, y, z] = p.position;
      expect(inRect(SITE, x, z), cam.id).toBe(true);
      expect(y, cam.id).toBeGreaterThan(p.target[1] + 4);
      const horiz = Math.hypot(p.target[0] - x, p.target[2] - z);
      expect(horiz, cam.id).toBeGreaterThan(12);
      expect(horiz, cam.id).toBeLessThan(60);
      const pitch = (Math.atan2(y - p.target[1], horiz) * 180) / Math.PI;
      expect(pitch, cam.id).toBeGreaterThan(8);
      expect(pitch, cam.id).toBeLessThan(35);
      // The aim point lies in the camera's zone.
      expect(ZONE_BY_ID[cam.zone].rects.some((r) => inRect(r, p.target[0], p.target[2], 1)), cam.id).toBe(true);
      if (p.mount === 'pole') expect(y, cam.id).toBeGreaterThanOrEqual(10);
      else {
        // Indoors: inside the hall, under the cable trays (8.4 m) and the eave.
        expect(inRect(HALL.rect, x, z), cam.id).toBe(true);
        expect(y, cam.id).toBeLessThan(8.4);
        expect(y, cam.id).toBeLessThan(HALL.eave);
      }
      expect(resolvePose(cam.id)!.fov).toBe(CCTV_FOV);
    }
  });

  it('sees at least one geofence it covers', () => {
    for (const cam of CAMERAS) {
      const fences = GEOFENCES.filter((g) => cam.covers.includes(g.id));
      if (!fences.length) continue;
      const seen = fences.filter((g) => inView(cam.id, (g.rect.x[0] + g.rect.x[1]) / 2, 0, (g.rect.z[0] + g.rect.z[1]) / 2));
      expect(seen.length, cam.id).toBeGreaterThan(0);
    }
  });

  it('aims at the focus equipment bounds when they are plausible, else at the layout point', () => {
    const box = (x0: number, x1: number, y1: number, z0: number, z1: number): BoundsLike => ({ min: { x: x0, y: 0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
    const near = new Map<string, BoundsLike>([
      ['E-PRS1', box(-22, -18, 6, -24, -18)],
      ['E-PRS2', box(-16, -12, 6, -24, -18)],
    ]);
    const p = resolvePose('CAM-E1', near)!;
    expect(p.aimedAtBounds).toBe(true);
    expect(p.target[0]).toBeCloseTo(-17);
    expect(p.target[2]).toBeCloseTo(-21);
    expect(p.target[1]).toBeGreaterThanOrEqual(AIM_Y[0]);
    expect(p.target[1]).toBeLessThanOrEqual(AIM_Y[1]);
    expect(p.position).toEqual(CCTV_POSES['CAM-E1'].position);

    const far = new Map<string, BoundsLike>([['E-PRS1', box(60, 70, 4, 60, 70)]]);
    const q = resolvePose('CAM-E1', far)!;
    expect(q.aimedAtBounds).toBe(false);
    expect(q.target).toEqual(CCTV_POSES['CAM-E1'].target);
    expect(Math.hypot(70 - CCTV_POSES['CAM-E1'].target[0], 70 - CCTV_POSES['CAM-E1'].target[2])).toBeGreaterThan(FOCUS_MAX_SHIFT);

    // Tall equipment (the spray tower) is aimed at working height, not its middle.
    const tower = new Map<string, BoundsLike>([['D-TWR', box(-47, -25, 30, -57, -31)]]);
    expect(resolvePose('CAM-D1', tower)!.target[1]).toBe(AIM_Y[1]);
    expect(resolvePose('CAM-H1', tower)!.aimedAtBounds).toBe(false);
    expect(resolvePose('CAM-X9')).toBeNull();
  });
});

describe('render queue', () => {
  const fakeClock = () => {
    let t = 0;
    const waits: number[] = [];
    const clock: QueueClock = {
      now: () => t,
      wait: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    };
    return { clock, waits, advance: (ms: number) => (t += ms) };
  };

  it('runs one job at a time and spaces jobs by the minimum interval', async () => {
    const { clock, waits } = fakeClock();
    const q = createRenderQueue(500, clock);
    const order: string[] = [];
    let running = 0;
    const job = (name: string) => async () => {
      running++;
      expect(running).toBe(1);
      order.push(name);
      await Promise.resolve();
      running--;
      return name;
    };
    const results = await Promise.all([q.run(job('a')), q.run(job('b')), q.run(job('c'))]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'b', 'c']);
    // First job immediately, the next two after 500 ms each.
    expect(waits).toEqual([500, 500]);
    expect(q.size).toBe(0);
  });

  it('does not wait when the interval has already passed, and survives a failing job', async () => {
    const { clock, waits, advance } = fakeClock();
    const q = createRenderQueue(500, clock);
    await expect(q.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    advance(800);
    await expect(q.run(() => 42)).resolves.toBe(42);
    expect(waits).toEqual([]);
  });
});

describe('pixels', () => {
  it('flips rows bottom-up to top-down and makes pixels opaque', () => {
    // 2×2: WebGL order is bottom row first.
    const src = new Uint8Array([
      1, 1, 1, 0, 2, 2, 2, 10, // bottom row
      3, 3, 3, 20, 4, 4, 4, 255, // top row
    ]);
    const out = flipRowsInto(src, 2, 2, new Uint8ClampedArray(16));
    expect(Array.from(out)).toEqual([3, 3, 3, 255, 4, 4, 4, 255, 1, 1, 1, 255, 2, 2, 2, 255]);
  });

  it('keeps the requested aspect within the size limits', () => {
    expect(renderSize(640, 360)).toEqual({ width: 640, height: 360 });
    expect(renderSize(4000, 1000)).toEqual({ width: 1280, height: 320 });
    expect(renderSize(0, 0)).toEqual({ width: 640, height: 360 });
    const s = renderSize(333, 177);
    expect(s.width % 2).toBe(0);
    expect(s.height % 2).toBe(0);
  });
});
