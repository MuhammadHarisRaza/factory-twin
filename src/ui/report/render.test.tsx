/**
 * Smoke test: the event report, the event list and the Events & Reports workspace render
 * (server-side) for every kind of event, with all 12 sections in order and the honesty labels.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The stores register browser listeners at import; a minimal window is enough for server rendering.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { EventsPage } from '../../pages/EventsPage';
import { EVENT_SECTION_TITLES } from '../../report/model';
import { activateScenario, advance } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { EventList } from '../events/EventList';
import { EventReportView } from './EventReportView';

useSim.getState().pause();

/** Server rendering reads zustand's initial state, so mirror the current state into it first. */
const render = (node: React.ReactNode) => {
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useApp.getInitialState(), useApp.getState());
  return renderToStaticMarkup(node);
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

beforeAll(() => {
  const sim = useSim.getState().sim;
  const t0 = sim.minute;
  activateScenario(sim, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 20, label: 'Kiln infeed stop' });
  activateScenario(sim, { kind: 'degradation', equipmentId: 'C-BM2', end: null, label: 'Developing fault' });
  activateScenario(sim, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 6, end: null, label: 'Glaze defects' });
  activateScenario(sim, { kind: 'yard-congestion', count: 8, end: null, label: 'Yard' });
  advance(sim, t0 + 60);
  useSim.setState({ version: sim.version });
});

describe('event report view', () => {
  it('renders every section in order for each kind of event', () => {
    const sim = useSim.getState().sim;
    const kinds = ['production', 'quality', 'logistics', 'equipment'] as const;
    for (const cat of kinds) {
      const ev = [...sim.events].reverse().find((e) => e.category === cat);
      if (!ev) continue;
      const html = render(<EventReportView eventId={ev.id} />);
      const t = text(html);
      expect(t).toContain(ev.id);
      let last = -1;
      for (const title of EVENT_SECTION_TITLES) {
        const i = t.indexOf(` ${title} `, last + 1);
        expect(i, `${ev.id} section "${title}"`).toBeGreaterThan(last);
        last = i;
      }
      for (const label of ['Show in 3D', 'Ask the copilot about this event', 'Download PDF', 'estimate · assumptions shown', 'Report generated']) expect(t).toContain(label);
      // Lifecycle controls.
      for (const label of ['Acknowledge', 'Start investigation', 'Assign owner', 'Add note', 'Resolve']) expect(t).toContain(label);
      if (cat === 'quality' && ev.evidence.length) expect(t).toMatch(/Illustrative frame · simulated classification — no vision model|No individual reject record/);
    }
  });

  it('explains pending and missing visual evidence', () => {
    const sim = useSim.getState().sim;
    const live = sim.events.find((e) => e.type === 'conveyor-stop' && !e.historical)!;
    const t = text(render(<EventReportView eventId={live.id} />));
    expect(t).toContain('Capturing…');
    expect(t).toContain('Simulated feed · rendered from the digital twin');
    expect(t).toContain('Not available — No video recording (NVR) is integrated');
    const hist = sim.events.find((e) => e.historical && e.category === 'production')!;
    expect(text(render(<EventReportView eventId={hist.id} />))).toContain('Occurred before this demo session');
  });

  it('disables resolving while the condition is active and shows the reason', () => {
    const sim = useSim.getState().sim;
    const active = sim.events.find((e) => e.end == null)!;
    const html = render(<EventReportView eventId={active.id} />);
    expect(text(html)).toContain('The condition is still active');
    expect(html).toMatch(/<button class="btn sm primary" type="submit" disabled=""/);
  });

  it('renders a compact read-only preview and a missing event', () => {
    const sim = useSim.getState().sim;
    const ev = sim.events[sim.events.length - 1];
    const t = text(render(<EventReportView eventId={ev.id} compact />));
    expect(t).toContain('Open full report');
    expect(t).not.toContain('Start investigation');
    expect(text(render(<EventReportView eventId="EV-99999" />))).toContain('not in the current demo state');
  });
});

describe('event list and workspace', () => {
  it('renders the shared list with limit and empty state', () => {
    const sim = useSim.getState().sim;
    const evs = sim.events.slice(-8).reverse();
    const t = text(render(<EventList events={evs} limit={5} />));
    expect(t).toContain(evs[0].id);
    expect(t).toContain('3 more');
    expect(text(render(<EventList events={[]} empty="Nothing here" />))).toContain('Nothing here');
  });

  it('renders Events & Reports with filters, counts and the selected report', () => {
    const sim = useSim.getState().sim;
    const ev = sim.events.find((e) => e.type === 'conveyor-stop' && !e.historical)!;
    useApp.setState({ workspace: 'events', selectedEventId: ev.id });
    const t = text(render(<EventsPage />));
    for (const label of ['Conditions active now', 'Open events', 'Detected this session', 'This session only', 'Category', 'Status', 'Stage shift PDF', 'newest first'])
      expect(t).toContain(label);
    expect(t).toContain(ev.id);
    expect(t).toContain('Acknowledgement & resolution');
  });
});
