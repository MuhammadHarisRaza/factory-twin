/**
 * src/store.ts (the twin UI store) is imported by the shell, so it must not pull three.js into the
 * initial chunks: the asset framing maths uses plain numbers. These tests pin that it frames exactly as
 * the former THREE.Vector3 implementation did, and that the module has no runtime 'three' import.
 */
import { describe, expect, it, vi } from 'vitest';
import { Box3, Vector3 } from 'three';

// The store registers a dev handle on window at import; a minimal window is enough.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { CAMERA_FOV, equipmentBounds, focusPose, lastFocusPose, minimapCamera, useTwin } from '../store';
import { HALL } from '../data/layout';
import type { Vec3 } from '../data/types';
// The module's source text (Vite raw import), to check its imports.
import storeSource from '../store.ts?raw';

type Cam = { x: number; z: number; tx: number; tz: number };

/** The previous three.js implementation of focusEquipment, verbatim (reference). */
function reference(box: Box3, cam: Cam): { pos: Vec3; target: Vec3 } {
  const center = box.getCenter(new Vector3());
  const radius = Math.max(2.5, box.getSize(new Vector3()).length() / 2);
  const distance = Math.max(11, (radius / Math.sin((CAMERA_FOV * Math.PI) / 360)) * 0.95);
  const dir = new Vector3(cam.x - cam.tx, 0, cam.z - cam.tz);
  if (dir.lengthSq() < 1e-6) dir.set(0.45, 0, 0.9);
  dir.normalize();
  const inside = (r: { x: [number, number]; z: [number, number] }) =>
    center.x > r.x[0] && center.x < r.x[1] && center.z > r.z[0] && center.z < r.z[1];
  if (center.x < -76 || inside(HALL.rect)) {
    if (dir.z < 0.55) dir.z = 0.55;
    dir.normalize();
  }
  const elevation = (34 * Math.PI) / 180;
  const target = new Vector3(center.x, center.y * 0.55, center.z);
  const right = new Vector3(dir.z, 0, -dir.x).multiplyScalar(distance * 0.1);
  target.add(right);
  const pos = target
    .clone()
    .addScaledVector(dir, Math.cos(elevation) * distance)
    .add(new Vector3(0, Math.sin(elevation) * distance, 0));
  pos.y = Math.max(3, pos.y);
  return { pos: pos.toArray() as Vec3, target: target.toArray() as Vec3 };
}

const box = (min: Vec3, max: Vec3) => new Box3(new Vector3(...min), new Vector3(...max));
const hallMid = (i: 0 | 1, r: [number, number]) => (r[0] + r[1]) / 2 + i;

const BOXES: Box3[] = [
  box([85, 0, 40], [89, 3, 42]), // small asset in the open (outside every building)
  box([10, 0, 10], [14, 3, 12]), // small asset in the hall
  box([-90, 0, -5], [-80, 6, 5]), // west of x = -76 (looked into from the south)
  box([hallMid(0, HALL.rect.x) - 3, 0, hallMid(1, HALL.rect.z) - 2], [hallMid(0, HALL.rect.x) + 3, 4, hallMid(1, HALL.rect.z) + 2]), // inside the hall
  box([-20, 0, 30], [40, 12, 50]), // large (radius above the 2.5 floor and 11 distance floor)
  box([0, 0, 0], [0.2, 0.2, 0.2]), // tiny (radius floor)
  new Box3(), // empty box: centre and size zero, as THREE.Box3 reports them
];
const CAMS: Cam[] = [
  { x: 0, z: 0, tx: 0, tz: 0 }, // degenerate direction → default compass
  { x: 120, z: 80, tx: 0, tz: 0 },
  { x: -60, z: -140, tx: 10, tz: 5 }, // looking from the north (z clamped inside buildings)
  { x: 30, z: 5, tx: 30, tz: 4.9995 }, // just under the 1e-6 threshold
];

describe('focusPose (plain-number asset framing)', () => {
  it('matches the former THREE.Vector3 implementation for every box and camera direction', () => {
    for (const b of BOXES)
      for (const c of CAMS) {
        const got = focusPose(b, c);
        const want = reference(b, c);
        for (let i = 0; i < 3; i++) {
          expect(got.pos[i]).toBeCloseTo(want.pos[i], 9);
          expect(got.target[i]).toBeCloseTo(want.target[i], 9);
        }
        expect(got.pos[1]).toBeGreaterThanOrEqual(3);
        for (const v of [...got.pos, ...got.target]) expect(Number.isFinite(v)).toBe(true);
      }
  });

  it('focusEquipment flies the camera to that pose from the registered bounds', () => {
    const b = box([10, 0, 10], [14, 3, 12]);
    equipmentBounds.set('TEST-ASSET', b);
    Object.assign(minimapCamera, { x: 120, z: 80, tx: 0, tz: 0 });
    const nonce = useTwin.getState().camera.nonce;
    useTwin.getState().focusEquipment('TEST-ASSET');
    const cam = useTwin.getState().camera;
    expect(cam.nonce).toBe(nonce + 1);
    const want = reference(b, minimapCamera);
    cam.pos.forEach((v, i) => expect(v).toBeCloseTo(want.pos[i], 9));
    cam.target.forEach((v, i) => expect(v).toBeCloseTo(want.target[i], 9));
    // The framing is recorded with its shift (the twin re-frames a compact-shift pose once its panel is wide).
    expect(lastFocusPose()).toEqual({ id: 'TEST-ASSET', shift: 0.1, nonce: cam.nonce });
    // Unknown asset: no flight.
    useTwin.getState().focusEquipment('NO-SUCH-ASSET');
    expect(useTwin.getState().camera.nonce).toBe(nonce + 1);
    equipmentBounds.delete('TEST-ASSET');
  });

  it("has no runtime import from 'three' (it is in the shell's initial chunk)", () => {
    const src = storeSource;
    const imports = src.match(/^\s*import\s[^;]*?from\s+['"]three(?:\/[^'"]*)?['"]/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0); // the Box3 type is still imported…
    for (const line of imports) expect(line).toMatch(/^\s*import\s+type\s/); // …but type-only (erased)
    expect(src).not.toMatch(/import\(\s*['"]three/);
  });
});
