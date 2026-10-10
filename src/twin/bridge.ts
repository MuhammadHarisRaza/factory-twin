/**
 * Bridge between the event / evidence system and the 3D twin renderer.
 *
 * The scene registers a renderer that draws the factory from a camera position (src/scene/cctv/*).
 * Simulated camera feeds and event snapshots use it; images are kept in an in-memory store keyed
 * by evidence id and cleared on Reset Demo. A snapshot is always labelled "rendered from the digital
 * twin" — it is never presented as a camera image.
 */
export type TwinRender = { dataUrl: string; width: number; height: number };
export type TwinRenderer = (cameraId: string, opts: { width: number; height: number }) => Promise<TwinRender | null>;

let renderer: TwinRenderer | null = null;

/** Called by the 3D scene once its renderer is ready; returns an unregister function. */
export function registerTwinRenderer(r: TwinRenderer) {
  renderer = r;
  return () => {
    if (renderer === r) renderer = null;
  };
}

export const twinRendererReady = () => renderer != null;

/** Renders a camera position of the twin (null if the scene is not ready or the camera is unknown). */
export function renderTwinCamera(cameraId: string, opts: { width: number; height: number } = { width: 640, height: 360 }) {
  return renderer ? renderer(cameraId, opts) : Promise.resolve(null);
}

// ── Image store ───────────────────────────────────────────────────────────────

const images = new Map<string, TwinRender>();

export const putImage = (key: string, img: TwinRender) => {
  images.set(key, img);
};
export const getImage = (key: string) => images.get(key) ?? null;
export const clearImages = () => images.clear();
