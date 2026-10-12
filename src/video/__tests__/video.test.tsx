import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The stores register browser listeners at import; a minimal window is enough for server rendering.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { MONITORED_STAGES } from '../../model/plant';
import { clipsFor, topicsFor } from '../ContextVideo';
import { VIDEOS } from '../registry';
import { EQUIPMENT_TOPICS, STAGE_TOPICS, TOPIC_LABEL } from '../topics';
import type { VideoRef } from '../types';
import { VideoPlayer } from '../VideoPlayer';

const clip = (over: Partial<VideoRef>): VideoRef => ({
  id: 'vid-test',
  title: 'Roller kiln exterior',
  description: 'Outside of a roller kiln.',
  topic: 'kiln-exterior',
  stages: ['KILN'],
  equipment: [],
  equipmentTypes: ['roller kiln'],
  useCase: 'equipment',
  provider: 'youtube',
  publisher: 'Example channel',
  sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
  embedUrl: 'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa',
  poster: 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg',
  sourceType: 'public-reference',
  licence: 'Standard YouTube licence — embedded with the YouTube player',
  embed: 'allowed',
  label: 'Illustrative equipment footage',
  verified: 'test',
  ...over,
});

describe('video topics', () => {
  it('map only to real equipment and cover every monitored stage', () => {
    for (const id of Object.keys(EQUIPMENT_TOPICS)) expect(EQUIPMENT_BY_ID[id], id).toBeDefined();
    for (const st of MONITORED_STAGES) expect(STAGE_TOPICS[st.id]?.length, st.id).toBeGreaterThan(0);
    for (const t of Object.values(EQUIPMENT_TOPICS).flat()) expect(TOPIC_LABEL[t]).toBeTruthy();
  });

  it('keeps the kiln phases distinct and the most specific context first', () => {
    expect(topicsFor({ equipmentId: 'H-KILN' })).toEqual(['kiln-camera', 'kiln-firing', 'kiln-infeed', 'kiln-exterior', 'kiln-discharge']);
    expect(topicsFor({ equipmentId: 'CV-KIN', stage: 'KILN' })).toEqual(['kiln-infeed']);
    expect(topicsFor({ topic: 'truck-loading', equipmentId: 'K-DOCK' })).toEqual(['truck-loading']);
    // A utility with no topic gets no video rather than an unrelated one.
    expect(topicsFor({ equipmentId: 'A-SUB', stage: 'KILN' })).toEqual([]);
    const vids = [clip({ id: 'ext', topic: 'kiln-exterior' }), clip({ id: 'fire', topic: 'kiln-firing' })];
    expect(clipsFor({ equipmentId: 'H-KILN' }, vids).map((c) => [c.topic, c.video.id])).toEqual([
      ['kiln-firing', 'fire'],
      ['kiln-exterior', 'ext'],
    ]);
  });
});

describe('video player', () => {
  it('renders a poster with its classification and loads nothing before play', () => {
    const html = renderToStaticMarkup(<VideoPlayer video={clip({})} />);
    expect(html).toContain('Reference video');
    expect(html).toContain('Illustrative equipment footage');
    expect(html).toContain('not a live view');
    expect(html).toContain('href="https://www.youtube.com/watch?v=aaaaaaaaaaa"');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<video');
  });

  it('offers a link out when a clip cannot be embedded', () => {
    const html = renderToStaticMarkup(<VideoPlayer video={clip({ embedUrl: null, embed: 'not-allowed' })} />);
    expect(html).toContain('can only be watched on YouTube');
    expect(html).not.toContain('<iframe');
  });
});

describe('video registry', () => {
  it('every entry is complete: public reference footage, or a client recording served from this app', () => {
    const ids = new Set<string>();
    for (const v of VIDEOS) {
      expect(ids.has(v.id), v.id).toBe(false);
      ids.add(v.id);
      if (v.sourceType === 'client-recording') {
        expect(v.label).toBe('Recorded camera footage');
        expect(v.provider).toBe('client');
        expect(v.embedUrl).toMatch(/^\/videos\/[\w-]+\.mp4$/);
        expect(v.sourceUrl).toBe(v.embedUrl);
        expect(v.recording).toBeDefined();
        expect(v.posterTime).toBeGreaterThanOrEqual(0);
      } else {
        expect(v.sourceType).toBe('public-reference');
        expect(['Process reference video', 'Illustrative equipment footage']).toContain(v.label);
        expect(v.sourceUrl).toMatch(/^https:\/\//);
        if (v.embedUrl) expect(v.embedUrl).toMatch(/^https:\/\/(www\.youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d+|videos\.pexels\.com\/.+\.(mp4|webm)|[^ ]+\.(mp4|webm))/);
      }
      if (v.embed === 'not-allowed') expect(v.embedUrl).toBeNull();
      expect(TOPIC_LABEL[v.topic]).toBeTruthy();
      for (const e of v.equipment) expect(EQUIPMENT_BY_ID[e], `${v.id} → ${e}`).toBeDefined();
      expect(v.licence.length).toBeGreaterThan(5);
      expect(v.verified.length).toBeGreaterThan(3);
    }
  });

  it('client recordings lead their topics and always say they are recordings, not live, not linked to the simulation', () => {
    expect(clipsFor({ equipmentId: 'H-KILN' })[0].video.id).toBe('vid-kiln-camera-1');
    expect(clipsFor({ stage: 'KILN' })[0].video.id).toBe('vid-kiln-camera-1');
    expect(clipsFor({ equipmentId: 'J-BOX' })[0].video.id).toBe('vid-packaging-camera-1');
    expect(clipsFor({ stage: 'PACK' })[0].video.id).toBe('vid-packaging-camera-1');
    expect(clipsFor({ topic: 'yard-movement' })[0].video.id).toBe('vid-yard-camera-1');
    // The public kiln phases stay available next to the recording.
    expect(clipsFor({ equipmentId: 'H-KILN' }).map((c) => c.topic)).toEqual(['kiln-camera', 'kiln-firing', 'kiln-infeed', 'kiln-exterior', 'kiln-discharge']);
    for (const id of ['vid-kiln-camera-1', 'vid-packaging-camera-1', 'vid-yard-camera-1']) {
      const v = VIDEOS.find((x) => x.id === id)!;
      const html = renderToStaticMarkup(<VideoPlayer video={v} compact />);
      expect(html, id).toContain('Recorded footage');
      expect(html, id).toContain('Recorded camera footage');
      expect(html, id).toContain('not a live feed');
      expect(html, id).toContain('not linked to this demo&#x27;s simulated data');
      expect(html, id).not.toContain('Reference video');
      expect(html, id).not.toMatch(/Ghani/i);
      // A still frame of the file, nothing played before the user presses play.
      expect(html, id).toContain('preload="metadata"');
      expect(html, id).not.toContain('autoPlay');
    }
  });
});

