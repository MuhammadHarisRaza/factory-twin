/** The insight feed's empty state: honest about what was (not) evaluated — never "everything is fine". */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { InsightFeed } from './findings';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
});

vi.mock('./findings', async (orig) => {
  const real = await orig<typeof import('./findings')>();
  const empty: InsightFeed = { filter: 'all', rows: [], fired: 0, bySeverity: [], byFamily: [], firedTotal: 0, evaluated: 41, notEvaluated: 7, at: 600 };
  return { ...real, insightFeed: () => empty };
});

import { InsightsPanel } from './Insights';

describe('Overview insights empty state', () => {
  it('says no finding needs attention, with the evaluated / not-evaluated counts', () => {
    const html = renderToStaticMarkup(<InsightsPanel />);
    expect(html).toContain('No rule finding needs attention');
    expect(html).toContain('41 checks evaluated');
    expect(html).toContain('7 not evaluated for lack of data');
    expect(html).toContain('not proof that no fault exists');
    expect(html).not.toMatch(/everything is (fine|ok)|all good|no problems/i);
  });
});
