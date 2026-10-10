/**
 * Bridge between the event / evidence system and the 3D twin renderer.
 *
 * The scene registers a renderer that draws the factory from a camera position (src/scene/cctv/*).
 * Simulated camera feeds and event snapshots use it; images are kept in an in-memory store keyed
 * by evidence id. A snapshot is always labelled "rendered from the digital twin" — it is never
 * presented as a camera image (a frame grabbed from a configured stream carries its own provenance).
 *
 * The store is bounded: images are dropped when their evidence is pruned from the session history
 * (`retainImagesFor`, called with the live evidence array), all of them on Reset Demo (`clearImages`),
 * and the oldest first once the stored data URLs exceed MAX_IMAGE_CHARS. Views already show
 * "not kept in this browser session" for available evidence whose image is no longer held.
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

/**
 * Memory budget of the store, in data-URL characters (≈ bytes: base64 is one byte per character).
 * About 480 evidence snapshots at 960×540 JPEG (~0.1 MB each) — more than the eight days of evidence
 * the simulation keeps at a typical event rate, so it only bites when evidence piles up.
 */
export const MAX_IMAGE_CHARS = 48 * 1024 * 1024;

/** Insertion-ordered: the first entry is the oldest image (evicted first when over budget). */
const images = new Map<string, TwinRender>();
let totalChars = 0;
let budget = MAX_IMAGE_CHARS;
/** Evidence array last passed to retainImagesFor (its identity changes only when history is pruned). */
let lastEvidence: readonly { id: string }[] | null = null;

const sizeOf = (img: TwinRender) => img.dataUrl.length;

function drop(key: string) {
  const img = images.get(key);
  if (!img) return;
  totalChars -= sizeOf(img);
  images.delete(key);
}

/** Drops the oldest images until the store fits its budget (the newest image is always kept). */
function enforceBudget() {
  for (const key of images.keys()) {
    if (totalChars <= budget || images.size <= 1) break;
    drop(key);
  }
}

export const putImage = (key: string, img: TwinRender) => {
  drop(key); // a re-put replaces the image and makes it the newest
  images.set(key, img);
  totalChars += sizeOf(img);
  enforceBudget();
};
export const getImage = (key: string) => images.get(key) ?? null;
export const clearImages = () => {
  images.clear();
  totalChars = 0;
  lastEvidence = null;
};

/** Drops every stored image whose key fails `keep`. */
export function retainImages(keep: (key: string) => boolean) {
  for (const key of [...images.keys()]) if (!keep(key)) drop(key);
}

/**
 * Keeps only the images of evidence still in `evidence` (the live `sim.evidence`). Cheap to call every
 * simulated minute: the engine appends evidence in place and reassigns the array only when it prunes
 * history (or a new simulation replaces it), so an unchanged array is a no-op.
 */
export function retainImagesFor(evidence: readonly { id: string }[]) {
  if (evidence === lastEvidence) return;
  lastEvidence = evidence;
  if (!images.size) return;
  const ids = new Set(evidence.map((x) => x.id));
  retainImages((key) => ids.has(key));
}

/** Count and size of the stored images (diagnostics and tests). */
export const imageStoreStats = () => ({ count: images.size, chars: totalChars, budget });

/** Test hook: changes the memory budget (null restores MAX_IMAGE_CHARS) and applies it at once. */
export function setImageBudgetForTests(chars: number | null) {
  budget = chars ?? MAX_IMAGE_CHARS;
  enforceBudget();
}
