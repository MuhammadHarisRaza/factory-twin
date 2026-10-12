/**
 * Review findings #28 / #29: embedded in the Overview, the wheel scrolls the page (the model zooms
 * only with Ctrl / ⌘ + wheel) and the in-scene label buttons leave the tab order; in the full
 * Factory Twin nothing changes. A faded-out label never takes clicks or keyboard focus.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../app/store';
import { useTwinHost } from '../app/twinHost';
import { isEmbedded, sceneEmbedded, sceneTabIndex, useSceneTabIndex, wheelAction } from './embedded';
import { PIN_HIDDEN_BELOW, setPinOpacity } from './status/pins';

const slot = {} as HTMLElement;
const setMode = (workspace: 'overview' | 'twin', hosted: boolean) => {
  useApp.setState({ workspace });
  useTwinHost.setState({ slot: hosted ? slot : null });
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useTwinHost.getInitialState(), useTwinHost.getState());
};

function SceneButton() {
  return (
    <button type="button" tabIndex={useSceneTabIndex()}>
      Zone H
    </button>
  );
}

describe('embedded scene', () => {
  it('is embedded only while a page other than the Factory Twin hosts it', () => {
    expect(isEmbedded('overview', slot)).toBe(true);
    expect(isEmbedded('twin', slot)).toBe(false);
    expect(isEmbedded('overview', null)).toBe(false);
    setMode('overview', true);
    expect(sceneEmbedded()).toBe(true);
    setMode('twin', true);
    expect(sceneEmbedded()).toBe(false);
  });

  it('lets the wheel scroll the page when embedded and zooms only with Ctrl / ⌘ (#28)', () => {
    const wheel = (deltaY: number, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({ deltaY, ctrlKey: false, metaKey: false, ...mods });
    // Full twin: the orbit controls keep their own wheel zoom.
    expect(wheelAction(false, wheel(120))).toBe('controls');
    expect(wheelAction(false, wheel(-120, { ctrlKey: true }))).toBe('controls');
    // Embedded: a plain wheel is the page's.
    expect(wheelAction(true, wheel(120))).toBe('page');
    expect(wheelAction(true, wheel(-120))).toBe('page');
    // Ctrl / ⌘ + wheel (and a trackpad pinch, sent as Ctrl + wheel) zooms the model.
    expect(wheelAction(true, wheel(-120, { ctrlKey: true }))).toBe('zoom-in');
    expect(wheelAction(true, wheel(120, { metaKey: true }))).toBe('zoom-out');
    expect(wheelAction(true, wheel(0, { ctrlKey: true }))).toBe('none');
  });

  it('takes in-scene buttons out of the tab order only while embedded (#29)', () => {
    expect(sceneTabIndex(true)).toBe(-1);
    expect(sceneTabIndex(false)).toBeUndefined();
    setMode('overview', true);
    expect(renderToStaticMarkup(<SceneButton />)).toContain('tabindex="-1"');
    setMode('twin', true);
    expect(renderToStaticMarkup(<SceneButton />)).not.toContain('tabindex');
    // Another page without the embedded model: the scene is hidden (and aria-hidden) anyway.
    setMode('overview', false);
    expect(renderToStaticMarkup(<SceneButton />)).not.toContain('tabindex');
  });

  it('makes a faded-out label inert — no clicks, no keyboard focus — and restores it when it shows again (#29)', () => {
    const el = { style: {} as Record<string, string>, inert: false } as unknown as HTMLElement;
    setPinOpacity(el, PIN_HIDDEN_BELOW - 0.1);
    expect(el.inert).toBe(true);
    expect(el.style.pointerEvents).toBe('none');
    setPinOpacity(el, 0);
    expect(el.inert).toBe(true);
    expect(el.style.visibility).toBe('hidden');
    setPinOpacity(el, 1);
    expect(el.inert).toBe(false);
    expect(el.style.pointerEvents).toBe('');
    expect(el.style.visibility).toBe('');
  });
});
