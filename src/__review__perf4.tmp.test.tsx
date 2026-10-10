import { describe, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});
import { useApp } from './app/store';
import { useSim } from './sim/store';
import { QualityPage } from './pages/QualityPage';
import { EventsPage } from './pages/EventsPage';
import { MonitoringPage } from './pages/MonitoringPage';
import { CommandCenterPage } from './pages/CommandCenterPage';
import { FleetPage } from './pages/FleetPage';
import { ProductionPage } from './pages/ProductionPage';
import { CopilotPage } from './pages/CopilotPage';
import { EnergyPage } from './pages/EnergyPage';
import { MachineHealthPage } from './pages/MachineHealthPage';
import { EventReportView } from './ui/report/EventReportView';

useSim.getState().pause();
const PAGES = { quality: QualityPage, events: EventsPage, monitoring: MonitoringPage, command: CommandCenterPage, fleet: FleetPage, production: ProductionPage, copilot: CopilotPage, energy: EnergyPage, health: MachineHealthPage } as const;

describe('page render cost', () => {
  it('renders', () => {
    const out: string[] = [];
    for (const period of ['shift', '24h', '7d'] as const) {
      for (const [ws, P] of Object.entries(PAGES)) {
        useApp.setState({ workspace: ws as never, period });
        Object.assign(useApp.getInitialState(), useApp.getState());
        Object.assign(useSim.getInitialState(), useSim.getState());
        let html = '';
        try { html = renderToStaticMarkup(<P />); } catch (e) { out.push(`${ws} ${period}: ERR ${(e as Error).message}`); continue; }
        const n = 5;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          // bump version so useSimValue memo is irrelevant (SSR has no memo persistence anyway)
          html = renderToStaticMarkup(<P />);
        }
        out.push(`${((performance.now() - t0) / n).toFixed(1).padStart(7)} ms  ${ws} ${period}  html=${(html.length / 1024).toFixed(0)} KB`);
      }
    }
    const s = useSim.getState().sim;
    const ids = s.events.slice(-3).map((e) => e.id);
    for (const id of ids) {
      const t0 = performance.now();
      for (let i = 0; i < 5; i++) renderToStaticMarkup(<EventReportView eventId={id} />);
      out.push(`${((performance.now() - t0) / 5).toFixed(1).padStart(7)} ms  EventReportView ${id}`);
    }
    console.log(out.join('\n'));
  }, 600_000);
});
