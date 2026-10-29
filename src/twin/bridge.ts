/**
 * Evidence image store. Event snapshots are frames grabbed from a configured camera stream that was
 * playing when the event was detected; nothing is rendered from the 3D twin as a stand-in image.
 * Images are kept in memory keyed by evidence id.
 *
 * The store is bounded: images are dropped when their evidence is pruned from the session history
 * (`retainImagesFor`, called with the live evidence array), all of them on Reset Demo (`clearImages`),
 * and the oldest first once the stored data URLs exceed MAX_IMAGE_CHARS. Views already show
 * "not kept in this browser session" for available evidence whose image is no longer held.
 */
/** A captured image (a JPEG / PNG data URL and its size). */
export type TwinRender = { dataUrl: string; width: number; height: number };

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
