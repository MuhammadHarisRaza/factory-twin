/**
 * Smoke test: the event report and the shared event list render (server-side) for every kind of
 * event, with all 12 sections in order and the honesty labels. The Events & Reports workspace has its
 * own render test (src/pages/events/render.test.tsx).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The stores register browser listeners at import; a minimal window is enough for server rendering.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { EVENT_SECTION_TITLES } from '../../report/model';
import { buildOpsReport } from '../../report/ops';
import { reportEvidence } from '../../report/ops/common';
import { activateScenario, advance } from '../../sim/engine';
import { attachEvidenceImage, evidenceOf } from '../../sim/events';
import { useSim } from '../../sim/store';
import { putImage } from '../../twin/bridge';
import { EventList } from '../events/EventList';
import { EventReportView } from './EventReportView';
import { OpsReportView } from './OpsReportView';

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
}, 120_000);

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

describe('event list and report legend', () => {
  it('renders the shared list with limit and empty state', () => {
    const sim = useSim.getState().sim;
    const evs = sim.events.slice(-8).reverse();
    const t = text(render(<EventList events={evs} limit={5} />));
    expect(t).toContain(evs[0].id);
    expect(t).toContain('3 more');
    expect(text(render(<EventList events={[]} empty="Nothing here" />))).toContain('Nothing here');
  });

  it('renders the legend of the four kinds of information in the full report only', () => {
    const sim = useSim.getState().sim;
    const ev = sim.events.find((e) => e.type === 'conveyor-stop' && !e.historical)!;
    const full = text(render(<EventReportView eventId={ev.id} />));
    for (const label of ['How to read this report', 'Measured in simulation', 'Simulated', 'Estimated', 'Illustrative']) expect(full).toContain(label);
    expect(text(render(<EventReportView eventId={ev.id} compact />))).not.toContain('How to read this report');
  });
});

// Runs last: it gives the session's kiln-infeed stop a captured frame (the tests above expect it pending).
describe('operational report preview: camera evidence wording follows its provenance (#2, #5)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  it('a frame of a configured stream is described as a camera frame, a twin render as a render', () => {
    const sim = useSim.getState().sim;
    const stop = sim.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-KIN' && !e.historical)!;
    const snap = evidenceOf(sim, stop).find((x) => x.kind === 'camera-snapshot')!;
    putImage(snap.id, { dataUrl: PNG, width: 1, height: 1 });
    attachEvidenceImage(sim, snap.id, { key: snap.id, width: 1, height: 1, frameTime: sim.minute }, { origin: 'live-camera', sourceId: snap.cameraId ?? 'CAM-H1', label: 'Frame from the configured camera stream' });
    useSim.setState({ version: sim.version });
    const live = buildOpsReport(sim, 'shift', { period: 'shift' });
    expect(reportEvidence(live.sections).some((x) => x.evidenceId === snap.id)).toBe(true);
    const html = render(<OpsReportView report={live} />);
    expect(html).toContain(`alt="Camera frame from the configured camera stream, captured with ${stop.id}"`);
    expect(html).not.toContain(`alt="Digital-twin render captured with ${stop.id}"`);
    expect(text(html)).toContain('camera evidence includes a frame from a configured camera stream');

    attachEvidenceImage(sim, snap.id, { key: snap.id, width: 1, height: 1, frameTime: sim.minute }, { origin: 'digital-twin-render', sourceId: snap.cameraId ?? 'CAM-H1', label: 'Rendered from the digital twin' });
    useSim.setState({ version: sim.version });
    const twin = buildOpsReport(sim, 'shift', { period: 'shift' });
    const html2 = render(<OpsReportView report={twin} />);
    expect(html2).toContain(`alt="Digital-twin render captured with ${stop.id}"`);
    expect(text(html2)).toContain('camera views are digital-twin renders');
  });
});
