import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The stores register browser listeners at import; a minimal window is enough for server rendering.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { MONITORED_STAGES } from '../../model/plant';
import { ContextVideo, clipsFor, topicsFor } from '../ContextVideo';
import { VIDEOS } from '../registry';
import { EQUIPMENT_TOPICS, STAGE_TOPICS, TOPIC_LABEL } from '../topics';
import type { VideoRef } from '../types';
import { VideoPlayer, autoplayAllowed, embedSrc, youTubeSrc } from '../VideoPlayer';

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
  it('renders a poster with its classification and loads nothing before the player is on screen', () => {
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

  it('bare mode: the frame only — poster and play, no caption, nothing loaded yet (the host shows the source)', () => {
    const html = renderToStaticMarkup(<VideoPlayer video={clip({})} bare />);
    expect(html).not.toContain('<figcaption');
    expect(html).not.toContain('Illustrative equipment footage');
    expect(html).not.toContain('not a live view');
    expect(html).toContain('class="vp-poster"');
    expect(html).toContain('aria-label="Play illustrative equipment footage: Roller kiln exterior"');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<video');
    // The fallback for a clip that cannot be embedded stays.
    expect(renderToStaticMarkup(<VideoPlayer video={clip({ embedUrl: null, embed: 'not-allowed' })} bare />)).toContain('can only be watched on YouTube');
  });

  it('bare context video: one clip, no topic tabs, even where several topics apply (the kiln)', () => {
    const tabs = renderToStaticMarkup(<ContextVideo context={{ equipmentId: 'H-KILN' }} compact />);
    expect(tabs).toContain('role="tablist"');
    const bare = renderToStaticMarkup(<ContextVideo context={{ equipmentId: 'H-KILN' }} bare />);
    expect(bare).not.toContain('role="tablist"');
    expect(bare).not.toContain('<figcaption');
    expect(bare.match(/class="vp-poster"/g)).toHaveLength(1);
  });
});

describe('video autoplay and controls', () => {
  it('the YouTube embed starts by itself without player controls; muted and looping when it started by itself', () => {
    const auto = new URL(youTubeSrc(clip({}), true));
    expect(auto.searchParams.get('autoplay')).toBe('1');
    expect(auto.searchParams.get('mute')).toBe('1');
    expect(auto.searchParams.get('controls')).toBe('0');
    expect(auto.searchParams.get('disablekb')).toBe('1');
    expect(auto.searchParams.get('fs')).toBe('0');
    expect(auto.searchParams.get('loop')).toBe('1');
    // A single clip loops only as a playlist of itself.
    expect(auto.searchParams.get('playlist')).toBe('aaaaaaaaaaa');
    expect(auto.searchParams.get('enablejsapi')).toBe('1');
    // Started from the poster by the viewer: with sound.
    expect(new URL(youTubeSrc(clip({}), false)).searchParams.get('mute')).toBeNull();
    // A clip cut to a segment plays the segment and stops (no loop back to the whole video).
    const seg = new URL(youTubeSrc(clip({ segment: { start: 30, end: 75 } }), true));
    expect([seg.searchParams.get('start'), seg.searchParams.get('end'), seg.searchParams.get('loop')]).toEqual(['30', '75', null]);
  });

  it('a Vimeo embed autoplays and loops without controls; other embeds are left as they are', () => {
    const v = new URL(embedSrc(clip({ provider: 'vimeo', embedUrl: 'https://player.vimeo.com/video/123456' }), true));
    expect([v.searchParams.get('autoplay'), v.searchParams.get('loop'), v.searchParams.get('controls'), v.searchParams.get('muted')]).toEqual(['1', '1', '0', '1']);
    expect(embedSrc(clip({ provider: 'other', embedUrl: 'https://example.org/embed/1' }), true)).toBe('https://example.org/embed/1');
  });

  it('autoplay is off where the viewer asked for reduced motion or data saving', () => {
    const g = globalThis as unknown as { window: Record<string, unknown>; navigator?: unknown };
    const saved = { matchMedia: g.window.matchMedia, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
    try {
      g.window.matchMedia = () => ({ matches: false });
      Object.defineProperty(globalThis, 'navigator', { value: { connection: { saveData: false } }, configurable: true });
      expect(autoplayAllowed()).toBe(true);
      g.window.matchMedia = (q: string) => ({ matches: q.includes('reduced-motion') });
      expect(autoplayAllowed()).toBe(false);
      g.window.matchMedia = () => ({ matches: false });
      Object.defineProperty(globalThis, 'navigator', { value: { connection: { saveData: true } }, configurable: true });
      expect(autoplayAllowed()).toBe(false);
    } finally {
      g.window.matchMedia = saved.matchMedia;
      if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
    }
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
      // A still frame of the file until the player is on screen (it then starts muted, from code — no autoplay attribute, no controls).
      expect(html, id).toContain('preload="metadata"');
      expect(html, id).not.toContain('autoPlay');
      expect(html, id).not.toMatch(/\scontrols[\s=>]/);
    }
  });
});

