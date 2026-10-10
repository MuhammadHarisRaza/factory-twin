import { describe, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { writeFileSync } from 'node:fs';
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});
import { useApp } from './app/store';
import { useSim } from './sim/store';
import { QualityPage } from './pages/QualityPage';
import { FleetPage } from './pages/FleetPage';

useSim.getState().pause();
describe('quality html', () => {
  it('dumps', () => {
    for (const [name, P, period] of [['quality', QualityPage, '7d'], ['quality24', QualityPage, '24h'], ['fleet', FleetPage, '7d']] as const) {
      useApp.setState({ workspace: name.startsWith('quality') ? 'quality' : 'fleet', period });
      Object.assign(useApp.getInitialState(), useApp.getState());
      Object.assign(useSim.getInitialState(), useSim.getState());
      for (let i = 0; i < 3; i++) renderToStaticMarkup(<P />);
      const t0 = performance.now();
      const html = renderToStaticMarkup(<P />);
      console.log(name, period, (performance.now() - t0).toFixed(1), 'ms', html.length);
      writeFileSync(`C:/Users/haris/AppData/Local/Temp/claude/C--Users-haris/c09ae4f6-aabe-4faf-8103-01f8f13e7882/scratchpad/${name}.html`, html);
    }
  }, 600_000);
});
