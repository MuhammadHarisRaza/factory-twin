/**
 * Videos shown in the product (contract: src/video/types.ts) and the context lookup.
 *
 * Only videos provided by the client, served from this app's own files in public/videos/: three
 * camera recordings (kiln, packaging line, site entrance), labelled as recordings, and four clips of
 * comparable processes (raw-material preparation, spray drying, pressing, glazing), labelled as
 * reference footage — not this plant, not live. No YouTube or other third-party hosting is used; a
 * context without a matching video shows none.
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
  // ── Process reference footage provided by the client (this app's own files, public/videos/) ──
  // Footage of comparable processes, not of this (representative) plant and not live.
  {
    id: 'vid-raw-materials-client-1',
    title: 'Raw-material preparation area',
    description:
      'Footage of a raw-material preparation area: a ball mill and the clay and slip handling around it.',
    topic: 'raw-materials',
    stages: ['PREP'],
    equipment: ['B-BAYS', 'B-FEED', 'B-LOAD'],
    equipmentTypes: ['ball mill'],
    useCase: 'process',
    provider: 'client',
    publisher: 'Provided by the client',
    sourceUrl: `${FILES}raw-material-preparation.mp4`,
    embedUrl: `${FILES}raw-material-preparation.mp4`,
    poster: null,
    posterTime: 2,
    sourceType: 'public-reference',
    licence: 'Provided by the client for use in this demonstration',
    embed: 'allowed',
    label: 'Process reference video',
    verified: 'File checked 2026-10-29: plays in the browser (360×640, 25 s); frames show a ball mill and raw-material handling',
  },
  {
    id: 'vid-spray-drying-client-1',
    title: 'Spray drying (as supplied)',
    description:
      'Footage supplied as spray-drying footage; the frames show large tiles moving on a belt conveyor rather than the spray dryer itself.',
    topic: 'spray-drying',
    stages: ['SPRAY'],
    equipment: ['D-TWR', 'D-HAG'],
    equipmentTypes: [],
    useCase: 'process',
    provider: 'client',
    publisher: 'Provided by the client',
    sourceUrl: `${FILES}spray-drying.mp4`,
    embedUrl: `${FILES}spray-drying.mp4`,
    poster: null,
    posterTime: 3,
    sourceType: 'public-reference',
    licence: 'Provided by the client for use in this demonstration',
    embed: 'allowed',
    label: 'Process reference video',
    verified: 'File checked 2026-10-29: plays in the browser (360×640, 14 s); frames show tiles on a belt conveyor, not the dryer tower',
  },
  {
    id: 'vid-pressing-client-1',
    title: 'Hydraulic tile press',
    description:
      'Footage of a hydraulic tile press with pressed tiles leaving it on a roller conveyor.',
    topic: 'pressing',
    stages: ['PRESS'],
    equipment: ['E-PRS1', 'E-PRS2', 'E-PRS3'],
    equipmentTypes: ['hydraulic press'],
    useCase: 'equipment',
    provider: 'client',
    publisher: 'Provided by the client',
    sourceUrl: `${FILES}press-machine.mp4`,
    embedUrl: `${FILES}press-machine.mp4`,
    poster: null,
    posterTime: 4,
    sourceType: 'public-reference',
    licence: 'Provided by the client for use in this demonstration',
    embed: 'allowed',
    label: 'Illustrative equipment footage',
    verified: 'File checked 2026-10-29: plays in the browser (720×1280, 15 s); frames show a tile press and its outfeed rollers',
  },
  {
    id: 'vid-glazing-client-1',
    title: 'Glaze line',
    description:
      'Footage of a glaze line: tiles travelling on belt conveyors through the glazing stations, with operators at the line.',
    topic: 'glazing',
    stages: ['GLAZE'],
    equipment: ['G-LINE', 'G-PREP', 'CV-GLZ'],
    equipmentTypes: ['glaze line'],
    useCase: 'process',
    provider: 'client',
    publisher: 'Provided by the client',
    sourceUrl: `${FILES}glaze-line.mp4`,
    embedUrl: `${FILES}glaze-line.mp4`,
    poster: null,
    posterTime: 1,
    sourceType: 'public-reference',
    licence: 'Provided by the client for use in this demonstration',
    embed: 'allowed',
    label: 'Process reference video',
    verified: 'File checked 2026-10-29: plays in the browser (720×1280, 15 s); frames show a glaze line with tiles on conveyors',
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
