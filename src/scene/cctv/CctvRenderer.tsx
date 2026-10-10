/**
 * Twin renderer for the simulated camera feeds and event snapshots (src/twin/bridge.ts).
 *
 * Mounted inside the R3F Canvas. Each request renders the factory from the camera's CCTV pose
 * (./poses.ts) into an HDR render target, applies the same tone mapping and sRGB output as the
 * on-screen twin (three's OutputPass — no ambient occlusion or other post-processing), reads the
 * pixels back, flips them into a 2D canvas and burns in "SIMULATED VIEW · <camera> · <plant time>"
 * so a copied image stays labelled. Renders are queued: one at a time, ≤ 2 per second overall.
 *
 * While the Factory Twin workspace is hidden its Canvas has frameloop 'never'; before rendering, the
 * scene's per-frame callbacks are stepped once (what r3f's advance() does) so vehicles, beacons and
 * product flow show the current simulation — without drawing the hidden canvas and without feeding
 * drei's PerformanceMonitor (a sparse manual tick would read as a very low frame rate and make it
 * permanently drop the twin's render quality). Nothing the scene owns is changed: a private camera
 * is used, and the renderer's render target is restored after every render.
 */
import { useEffect } from 'react';
import { useThree, type RenderCallback, type RootState } from '@react-three/fiber';
import { HalfFloatType, PerspectiveCamera, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { registerTwinRenderer, type TwinRender } from '../../twin/bridge';
import { equipmentBounds } from '../../store';
import { simClock } from '../../sim/store';
import { drawStrip, simulatedStrip } from '../../ui/feeds/overlay';
import { tagFrameTime } from '../../ui/feeds/frames';
import { CCTV_FAR, CCTV_FOV, CCTV_NEAR, resolvePose } from './poses';
import { createRenderQueue } from './queue';
import { flipRowsInto, renderSize } from './pixels';

/** Minimum spacing between two renders (all feeds and captures together). */
const MIN_INTERVAL_MS = 500;
/** Largest per-callback time step when the scene is stepped manually (s). */
const MAX_STEP_S = 0.1;
const MAX_TARGET_SIZES = 3;

type Targets = { key: string; hdr: WebGLRenderTarget; ldr: WebGLRenderTarget; pixels: Uint8Array; used: number };

const samplerCheck = new WeakMap<RenderCallback, boolean>();
/** drei's PerformanceMonitor frame sampler (identified by the fields it keeps; property names survive minification). */
function isPerformanceSampler(fn: RenderCallback) {
  let v = samplerCheck.get(fn);
  if (v === undefined) {
    const src = Function.prototype.toString.call(fn);
    v = src.includes('refreshrate') && src.includes('averages');
    samplerCheck.set(fn, v);
  }
  return v;
}

function createCctv(get: () => RootState) {
  const camera = new PerspectiveCamera(CCTV_FOV, 16 / 9, CCTV_NEAR, CCTV_FAR);
  const output = new OutputPass();
  const targets = new Map<string, Targets>();
  const queue = createRenderQueue(MIN_INTERVAL_MS);
  const canvas = document.createElement('canvas');
  let warmed = false;
  let disposed = false;
  let lastStep = performance.now();

  const targetsFor = (w: number, h: number) => {
    const key = `${w}x${h}`;
    let t = targets.get(key);
    if (!t) {
      if (targets.size >= MAX_TARGET_SIZES) {
        const oldest = [...targets.values()].sort((a, b) => a.used - b.used)[0];
        oldest.hdr.dispose();
        oldest.ldr.dispose();
        targets.delete(oldest.key);
      }
      t = {
        key,
        hdr: new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 }),
        ldr: new WebGLRenderTarget(w, h, { depthBuffer: false }),
        pixels: new Uint8Array(w * h * 4),
        used: 0,
      };
      targets.set(key, t);
    }
    t.used = performance.now();
    return t;
  };

  /** One tick of the scene's per-frame callbacks (frameloop 'never' only). */
  const stepAnimations = (state: RootState) => {
    const now = performance.now();
    const delta = Math.min(MAX_STEP_S, Math.max(0.001, (now - lastStep) / 1000));
    lastStep = now;
    // The stopped clock of frameloop 'never' advances as with r3f's advance().
    state.clock.elapsedTime += delta;
    for (const sub of [...state.internal.subscribers]) {
      // Positive priorities take over rendering (the post-processing composer): they would draw the hidden canvas.
      if (sub.priority > 0) continue;
      const fn = sub.ref.current;
      if (!fn || isPerformanceSampler(fn)) continue;
      try {
        fn(sub.store.getState(), delta);
      } catch {
        // An animation callback failing must not stop the capture.
      }
    }
  };

  const readPixels = async (gl: WebGLRenderer, t: Targets, w: number, h: number) => {
    try {
      await gl.readRenderTargetPixelsAsync(t.ldr, 0, 0, w, h, t.pixels);
      return;
    } catch {
      // Fall back to the synchronous read (no PBO support).
    }
    gl.readRenderTargetPixels(t.ldr, 0, 0, w, h, t.pixels);
  };

  const compose = (pixels: Uint8Array, w: number, h: number, cameraId: string, plantMinute: number): TwinRender => {
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    const img = ctx.createImageData(w, h);
    flipRowsInto(pixels, w, h, img.data);
    ctx.putImageData(img, 0, 0);
    drawStrip(ctx, w, h, simulatedStrip(cameraId, plantMinute));
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.82), width: w, height: h };
  };

  const renderNow = async (cameraId: string, size: { width: number; height: number }): Promise<TwinRender | null> => {
    if (disposed) return null;
    const pose = resolvePose(cameraId, equipmentBounds);
    if (!pose) return null;
    const { width: w, height: h } = renderSize(size.width, size.height);
    camera.fov = pose.fov;
    camera.aspect = w / h;
    camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const t = targetsFor(w, h);

    let state = get();
    const gl = state.gl;
    if (!warmed) {
      // First render: compile the render-target shader variants without freezing the page, and make
      // sure the (on-demand) shadow map exists even if the twin has never been shown.
      warmed = true;
      const prev = gl.getRenderTarget();
      let compiling: Promise<unknown> | null = null;
      gl.setRenderTarget(t.hdr);
      try {
        compiling = gl.compileAsync(state.scene, camera);
      } catch {
        compiling = null;
      } finally {
        gl.setRenderTarget(prev);
      }
      if (compiling) await compiling.catch(() => undefined);
      if (disposed) return null;
      gl.shadowMap.needsUpdate = true;
      state = get();
    }

    if (state.frameloop === 'never') stepAnimations(state);
    const plantMinute = simClock.t;
    const prev = gl.getRenderTarget();
    try {
      gl.setRenderTarget(t.hdr);
      gl.clear();
      gl.render(state.scene, camera);
      output.render(gl, t.ldr, t.hdr, 0, false);
    } finally {
      gl.setRenderTarget(prev);
    }
    await readPixels(gl, t, w, h);
    if (disposed) return null;
    const frame = compose(t.pixels, w, h, cameraId, plantMinute);
    tagFrameTime(frame, plantMinute);
    return frame;
  };

  return {
    render: (cameraId: string, size: { width: number; height: number }) =>
      resolvePose(cameraId) ? queue.run(() => renderNow(cameraId, size)) : Promise.resolve(null),
    dispose: () => {
      disposed = true;
      for (const t of targets.values()) {
        t.hdr.dispose();
        t.ldr.dispose();
      }
      targets.clear();
      output.dispose();
    },
  };
}

/** Registers the twin renderer for the lifetime of the Canvas. */
export function CctvRenderer() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    const cctv = createCctv(get);
    const unregister = registerTwinRenderer(cctv.render);
    return () => {
      unregister();
      cctv.dispose();
    };
  }, [get]);
  return null;
}
