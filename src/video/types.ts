/**
 * Video registry contract. Every video shown in the product is a registry entry (src/video/registry.ts)
 * picked by context (equipment, stage, topic) through `videosFor` — pages never hard-code embeds.
 *
 * Public reference footage illustrates a process or an equipment type. It is never evidence that an
 * event happened, never a view of this (representative) plant, and never a live feed: it is labelled
 * "Process reference video" or "Illustrative equipment footage" with its provider, licence and
 * attribution. Detections, boxes and confidences are never drawn on reference footage.
 *
 * Recorded camera footage provided by the client (sourceType 'client-recording') is a recording of a
 * real camera view, sometimes with the recording system's own overlays (boxes, IDs, counters). It is
 * labelled "Recorded camera footage" with its camera and recording time: a recording, not a live feed,
 * and its overlays are the recording system's — never linked to this demo's simulated counts or events.
 */
import type { MonitoredStageId } from '../model/types';

/**
 * What a clip shows. Kiln phases are distinct topics so infeed, exterior, firing and discharge
 * footage is never shown for another phase (an exterior clip is not a kiln interior or thermal view).
 */
export type VideoTopic =
  | 'raw-materials'
  | 'milling'
  | 'spray-drying'
  | 'pressing'
  | 'drying'
  | 'glazing'
  | 'decoration'
  | 'kiln-camera'
  | 'kiln-infeed'
  | 'kiln-exterior'
  | 'kiln-firing'
  | 'kiln-discharge'
  | 'tile-factory-overview'
  | 'sorting'
  | 'surface-inspection'
  | 'crack-chip-inspection'
  | 'glaze-defect-inspection'
  | 'dimensional-inspection'
  | 'packaging'
  | 'palletising'
  | 'warehouse-forklift'
  | 'internal-transport'
  | 'truck-loading'
  | 'yard-movement'
  | 'dock-operations';

/**
 * public-reference: footage of a comparable process (not this plant) · client-recording: a camera recording provided by the
 * client (played from this app's own files) · simulated: rendered by this demo · connected: a configured live camera.
 */
export type VideoSourceType = 'public-reference' | 'client-recording' | 'simulated' | 'connected';

export type VideoProvider = 'vimeo' | 'pexels' | 'pixabay' | 'wikimedia' | 'client' | 'other';

/** How the clip may be used here: embedding allowed by the provider (and not disabled by the owner), unknown, or not allowed (link out only). */
export type EmbedPermission = 'allowed' | 'unknown' | 'not-allowed';

export type VideoUseCase = 'process' | 'equipment' | 'inspection' | 'vehicle' | 'overview';

/** Label shown on the player: public footage, or a client-provided camera recording. */
export type ReferenceLabel = 'Process reference video' | 'Illustrative equipment footage' | 'Recorded camera footage';

export type VideoRef = {
  /** Stable id, e.g. "vid-kiln-discharge-1". */
  id: string;
  title: string;
  /** One or two sentences: what the clip shows and how it relates to the stage. */
  description: string;
  topic: VideoTopic;
  /** Monitored stages it applies to (empty = none in particular, e.g. yard footage). */
  stages: MonitoredStageId[];
  /** Equipment ids (src/data/equipment.ts) it is the best match for, if any. */
  equipment: string[];
  /** Equipment types it illustrates (free text, e.g. "roller kiln", "forklift"). */
  equipmentTypes: string[];
  useCase: VideoUseCase;
  provider: VideoProvider;
  /** Channel / author / organisation that published it. */
  publisher: string;
  /** Title as published by the provider (the display title above is ours, in plain English). */
  originalTitle?: string;
  /** Original page of the clip (always offered as "Open source"). */
  sourceUrl: string;
  /** Playback URL: an embeddable player URL or a direct MP4 file. Null = link out only. */
  embedUrl: string | null;
  /** Poster image. Null = a neutral poster is drawn. */
  poster: string | null;
  sourceType: VideoSourceType;
  /** Licence or usage basis, e.g. "Provided by the client for use in this demonstration". */
  licence: string;
  embed: EmbedPermission;
  /** Seconds into the clip where the relevant part starts / ends (optional). */
  segment?: { start: number; end?: number };
  /** Attribution line where required. */
  attribution?: string;
  /** Client recordings: the camera named in the recording and when it was recorded (from its on-screen clock). */
  recording?: { camera: string | null; recordedAt: string | null; overlays: string | null };
  /** Seconds into a direct file to show as the still before play when there is no poster image. */
  posterTime?: number;
  label: ReferenceLabel;
  /** How and when the entry was checked (e.g. "embed loaded in browser 2026-10-11"). */
  verified: string;
};

/** Context the player is asked to illustrate. The registry picks the best entry (or none). */
export type VideoContext = { equipmentId?: string | null; stage?: MonitoredStageId | null; topic?: VideoTopic | null };

/** Player load state: idle (poster, nothing loaded) → loading → playing; or failed with a reason. */
export type VideoLoadState = 'idle' | 'loading' | 'ready' | 'failed';
