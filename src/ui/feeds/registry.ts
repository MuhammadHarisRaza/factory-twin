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
  /** The camera's state: the best of what its mounted players report (absent = no player open for it). */
  byCamera: Record<string, LiveReport>;
  /**
   * What each mounted player of a camera reports, by player id — the equipment panel's feed and the
   * floating camera view can show the same camera at once; one closing never wipes the other's state.
   */
  byPlayer: Record<string, Record<string, LiveReport>>;
  /** A player's report (null: the player unmounted). `playerId` defaults to one shared slot. */
  report: (cameraId: string, r: LiveReport | null, playerId?: string) => void;
};

/** Which report wins when several players show one camera: the one closest to playing, then the newest. */
const RANK: Record<LiveState, number> = { live: 6, unverified: 5, stale: 4, loading: 3, error: 2, unavailable: 1 };
const best = (rs: LiveReport[]) => rs.reduce<LiveReport | null>((b, r) => (!b || RANK[r.state] > RANK[b.state] || (RANK[r.state] === RANK[b.state] && r.at > b.at) ? r : b), null);

/** Latest state reported by the mounted players of each camera (absent = no player open for it). */
export const useLiveStatus = create<LiveStatusStore>((set) => ({
  byCamera: {},
  byPlayer: {},
  report: (cameraId, r, playerId = 'default') =>
    set((s) => {
      const players = { ...(s.byPlayer[cameraId] ?? {}) };
      const cur = players[playerId];
      if (r && cur && cur.state === r.state && cur.detail === r.detail) return s;
      if (!r && !cur) return s;
      if (r) players[playerId] = r;
      else delete players[playerId];
      const byPlayer = { ...s.byPlayer };
      const byCamera = { ...s.byCamera };
      const top = best(Object.values(players));
      if (top) {
        byPlayer[cameraId] = players;
        byCamera[cameraId] = top;
      } else {
        delete byPlayer[cameraId];
        delete byCamera[cameraId];
      }
      return { byPlayer, byCamera };
    }),
}));
