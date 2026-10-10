/**
 * Live-stream registry: the media elements of configured camera streams that are mounted right now,
 * and the state each one reports. Event evidence capture (src/app/EvidenceCapture.tsx) grabs its
 * frame from a registered element only while that element is actually live; Assets & Data shows the
 * reported state per camera. Nothing here is persisted.
 */
import { create } from 'zustand';
import type { LiveState } from './live';

type LiveEntry = { cameraId: string; el: HTMLVideoElement | HTMLImageElement; isLive: () => boolean };

const entries = new Set<LiveEntry>();

/** Registers a mounted live element; returns the unregister function. */
export function registerLive(entry: LiveEntry) {
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}

/** A mounted element of this camera's stream that is playing and not stale, or null. */
export function liveElement(cameraId: string) {
  for (const e of entries) if (e.cameraId === cameraId && e.isLive()) return e.el;
  return null;
}

export type LiveReport = { state: LiveState; at: number; detail?: string };

type LiveStatusStore = {
  byCamera: Record<string, LiveReport>;
  report: (cameraId: string, r: LiveReport | null) => void;
};

/** Latest state reported by a mounted player per camera (absent = no player open for it). */
export const useLiveStatus = create<LiveStatusStore>((set) => ({
  byCamera: {},
  report: (cameraId, r) =>
    set((s) => {
      const cur = s.byCamera[cameraId];
      if (r && cur && cur.state === r.state && cur.detail === r.detail) return s;
      const next = { ...s.byCamera };
      if (r) next[cameraId] = r;
      else delete next[cameraId];
      return { byCamera: next };
    }),
}));
