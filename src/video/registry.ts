/**
 * Videos shown in the product (contract: src/video/types.ts) and the context lookup.
 *
 * Only the three camera recordings provided by the client (kiln, packaging line, site entrance),
 * served from this app's own files in public/videos/ and labelled as recordings. No YouTube or other
 * third-party footage is used; a context without a matching recording shows no video.
 */
import type { VideoContext, VideoRef } from './types';

/** Where the client's recordings are served from (Vite copies public/ to the site root). */
const FILES = `${import.meta.env.BASE_URL}videos/`;

export const VIDEOS: VideoRef[] = [
  // ── Camera recordings provided by the client (played from this app's own files, public/videos/) ──
  // Recordings of real camera views with the recording
  // system's overlays — labelled as recordings, never as live feeds or as this demo's detections.
  {
    id: 'vid-kiln-camera-1',
    title: 'Tile-counting camera at a kiln roller line',
    description:
      'Screen recording of a camera view over the kiln rollers with a tile-counting overlay: tracked tiles (boxes with IDs), a counting line and an objects-detected counter.',
    topic: 'kiln-camera',
    stages: ['KILN'],
    equipment: ['H-KILN'],
    equipmentTypes: ['roller kiln'],
    useCase: 'equipment',
    provider: 'client',
    publisher: 'Provided by the client',
    sourceUrl: `${FILES}kiln-reference.mp4`,
    embedUrl: `${FILES}kiln-reference.mp4`,
    poster: null,
    posterTime: 22,
    sourceType: 'client-recording',
    licence: 'Provided by the client for use in this demonstration',
    embed: 'allowed',
    label: 'Recorded camera footage',
    recording: { camera: 'Unit 2 Camera 01 Kiln', recordedAt: '12 Oct 2026, 13:45', overlays: 'tile boxes, IDs and counts' },
    verified: 'File checked 2026-10-12: plays in the browser (1030×650, 55 s); camera name and time read from the recording',
  },
  {
    id: 'vid-packaging-camera-1',
    title: 'Counting camera over the packaging line',
    description:
      'Screen recording of a camera view over the packaging conveyor with a counting overlay: tracked items (boxes with IDs), a counting line and an objects-detected counter.',
    topic: 'packaging',
    stages: ['PACK'],
    equipment: ['J-BOX', 'J-CNT', 'CV-PACK'],
    equipmentTypes: ['packaging conveyor'],
    useCase: 'equipment',
    provider: 'client',
    publisher: 'Provided by the client',
    sourceUrl: `${FILES}packaging-reference.mp4`,
    embedUrl: `${FILES}packaging-reference.mp4`,
    poster: null,
    posterTime: 5,
    sourceType: 'client-recording',
    licence: 'Provided by the client for use in this demonstration',
    embed: 'allowed',
    label: 'Recorded camera footage',
    recording: { camera: 'Unit 2 Camera 01 Pack', recordedAt: '12 Oct 2026, 13:44', overlays: 'boxes, IDs and counts' },
    verified: 'File checked 2026-10-12: plays in the browser (1030×650, 36 s); camera name and time read from the recording',
  },
  {
    id: 'vid-yard-camera-1',
    title: 'Site entrance camera with vehicle detection',
    description:
      'Recording of a camera view over a site entrance: trucks, a wheel loader and people in high-visibility vests, with detection boxes drawn around the vehicles by the recording system.',
    topic: 'yard-movement',
    stages: [],
    equipment: ['A-GATE', 'A-HOLD'],
    equipmentTypes: ['truck', 'wheel loader'],
    useCase: 'vehicle',
    provider: 'client',
    publisher: 'Provided by the client',
    sourceUrl: `${FILES}vehicle-monitoring-reference.mp4`,
    embedUrl: `${FILES}vehicle-monitoring-reference.mp4`,
    poster: null,
    posterTime: 22,
    sourceType: 'client-recording',
    licence: 'Provided by the client for use in this demonstration',
    embed: 'allowed',
    label: 'Recorded camera footage',
    recording: { camera: null, recordedAt: null, overlays: 'vehicle boxes' },
    verified: 'File checked 2026-10-12: plays in the browser (1496×792, 84 s); the recording shows no camera name or time',
  },
];

export const VIDEO_BY_ID: Record<string, VideoRef> = Object.fromEntries(VIDEOS.map((v) => [v.id, v]));

/** Registry entries for a context, best match first (equipment, then topic, then stage). */
export function videosFor(ctx: VideoContext): VideoRef[] {
  const score = (v: VideoRef) =>
    (ctx.equipmentId && v.equipment.includes(ctx.equipmentId) ? 4 : 0) + (ctx.topic && v.topic === ctx.topic ? 2 : 0) + (ctx.stage && v.stages.includes(ctx.stage) ? 1 : 0);
  return VIDEOS.map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v);
}
