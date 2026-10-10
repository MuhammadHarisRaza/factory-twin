/**
 * Smoke test: AI Defect Monitoring renders (server-side) in the default state and while a quality
 * scenario raises events, with its workflow, event, root-cause, impact and record-detail parts, and
 * keeps its honesty labels (simulated inference, no vision model, simulated confidence).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});
// Shared components owned (and tested) by the events builder: stubbed so this test covers this page only.
vi.mock('../../ui/report/EventReportView', () => ({ EventReportView: ({ eventId }: { eventId: string }) => `report ${eventId}` }));
vi.mock('../../ui/events/EventList', () => ({ EventList: ({ events }: { events: { id: string }[] }) => events.map((e) => e.id).join(' ') }));

import { useApp } from '../../app/store';
import { activateScenario, advance } from '../../sim/engine';
import { useSim } from '../../sim/store';
import { QualityPage } from '../QualityPage';
import { contextStates, eventsOfRecord, inspectionEventLinks, ruleChecks } from './derive';
import { frameById } from './frames';
import { QualityEvents } from './QualityEvents';
import { RecordDetail } from './RecordDetail';
import { RootCause } from './RootCause';
import { WorkflowStrip } from './WorkflowStrip';

useSim.getState().pause();

const sync = () => {
  useApp.setState({ workspace: 'quality', period: '24h' });
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
};
const esc = (t: string) => t.replace(/&/g, '&amp;');

describe('AI defect monitoring render', () => {
  it('renders the page with the workflow, events, root cause, impact and honesty labels', () => {
    sync();
    const html = renderToStaticMarkup(<QualityPage />);
    for (const text of [
      'Simulated inference — no vision model.',
      'SIM-CV v0 (simulated)',
      'Real vision inference would come from a configured model (VISION data source — not connected).',
      'Inspection workflow',
      'Capture',
      'Inference',
      'Classify &amp; localise',
      'Associate',
      'Counts &amp; OEE',
      'Quality events',
      'Root-cause hypotheses',
      'Scrap &amp; rework impact',
      'estimate · assumptions shown',
      'Defect classes',
      'Gauge measurements · non-vision',
      'Inspection records',
    ])
      expect(html, text).toContain(text);
    expect(html).not.toMatch(/>Live</);
    expect(html).not.toMatch(/caused by/i);
  });

  it('renders the record detail, the focused event and its hypotheses during a quality scenario', () => {
    const s = useSim.getState().sim;
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze deterioration (render test)' });
    advance(s, s.minute + 90);
    useSim.setState({ version: s.version });
    sync();
    expect(renderToStaticMarkup(<QualityPage />)).toContain('Glaze deterioration (render test)');

    const links = inspectionEventLinks(s);
    const recId = [...links.keys()].find((id) => s.inspections.some((r) => r.id === id && r.stationId === 'ST-VIS'))!;
    const rec = s.inspections.find((r) => r.id === recId)!;
    const events = eventsOfRecord(s, links, rec.id);
    expect(events.length).toBeGreaterThan(0);

    const detail = renderToStaticMarkup(
      <RecordDetail
        rec={rec}
        batch={s.batches.find((b) => b.id === rec.batchId) ?? null}
        frame={frameById(s, rec.id)}
        scenario={null}
        states={contextStates(s, rec)}
        events={events}
        periodInspected={1000}
        periodLabel="Last 24 hours"
        onShowFrame={() => {}}
        onShowEvent={() => {}}
        onClose={() => {}}
      />,
    );
    for (const text of ['Original', 'Annotated · defect crop', 'Illustrative frame · simulated classification — no vision model', 'simulated confidence', 'SIM-CV v0 (simulated)', 'Count impact', 'Show event &amp; evidence', events[0].id])
      expect(detail, text).toContain(text);

    const ev = events[0];
    const focus = renderToStaticMarkup(
      <QualityEvents open={[ev]} resolved={[]} impacts={new Map()} focusId={ev.id} focusAuto={false} periodLabel="Last 24 hours" onFocus={() => {}} onPinRecord={() => {}} />,
    );
    for (const text of ['Open report', 'Show in 3D', 'Acknowledge', 'Investigate', 'Evidence frames']) expect(focus, text).toContain(text);

    const rc = renderToStaticMarkup(<RootCause eventId={ev.id} onFocus={() => {}} />);
    expect(rc).toContain('Suspected causes');
    expect(rc).toContain('Correlation evidence');
    expect(rc).toContain('Confirmed');
    expect(rc).toMatch(/Hypothesis: /);
    expect(rc).not.toMatch(/caused by/i);

    const flow = renderToStaticMarkup(
      <WorkflowStrip
        subject={{ rec, frame: frameById(s, rec.id), time: rec.time, stationId: rec.stationId, batchId: rec.batchId, batch: null, pinned: true, rules: ruleChecks(s, { time: rec.time, rec }), events }}
        counts={{ label: 'Last 24 hours', inspected: 1000, accepted: 950, rejected: 50, quality: { value: 0.95, status: 'ok' }, oee: { value: 0.8, status: 'ok' } }}
        onShowEvent={() => {}}
      />,
    );
    expect(flow).toContain('Simulated inference · deterministic rules, no vision model');
    expect(flow).toContain(esc(ev.id));
    expect(flow).toContain('Q-RATE');
  });
});
