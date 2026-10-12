/**
 * Quality & Defects renders (server-side): header, summary and the four quality KPIs; the defect
 * investigation with the selected event's evidence (route #/quality/<id>, or the newest relevant
 * event when the address names none); the secondary tabs; and its honesty rules — simulated
 * labels, hypotheses worded as such, and no confidence without a simulated inference record.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});
// Shared components owned (and tested) by other builders: stubbed so this test covers this page only.
vi.mock('../../video/ContextVideo', () => ({ ContextVideo: ({ context }: { context: { topic?: string | null } }) => `[video topic=${context.topic ?? 'none'}]` }));
vi.mock('../../ui/report/Lifecycle', () => ({ Lifecycle: ({ r }: { r: { event: { id: string } } }) => `[lifecycle ${r.event.id}]` }));

import { useApp } from '../../app/store';
import { DEFECT_ACTIONS } from '../../model/actions';
import type { OpEvent } from '../../model/types';
import { activateScenario, advance } from '../../sim/engine';
import { qualityEventsIn } from './derive';
import { qualityKpis } from '../../intel/kpis';
import { resolvePeriod } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { QualityPage } from '../QualityPage';
import { DefectEvidence } from './DefectEvidence';
import { defaultSelection } from './investigate';

useSim.getState().pause();

const sync = (over: Partial<ReturnType<typeof useApp.getState>> = {}) => {
  useApp.setState({ workspace: 'quality', period: '24h', tabs: {}, qualityEventId: null, ...over });
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
};
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const page = () => renderToStaticMarkup(<QualityPage />);
const evidence = (id: string) => {
  const s = useSim.getState().sim;
  const fpy = qualityKpis(s, resolvePeriod('24h', s.minute)).find((k) => k.id === 'first-pass-quality')!;
  return renderToStaticMarkup(<DefectEvidence id={id} fpy={fpy} fallbackId={null} onSelect={() => {}} />);
};
/** The evidence section only (the page also lists other items). */
const evidenceOf = (html: string) => html.slice(html.indexOf('class="qd-ev"'));
/** Visible text (tooltips such as the kit's provenance definitions are not claims on the page). */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

describe('Quality & Defects page', () => {
  it('renders the header, the data-driven summary, the four quality KPIs and the newest relevant item', () => {
    sync();
    const s = useSim.getState().sim;
    const html = page();
    for (const text of [
      'Quality &amp; Defects',
      'Simulated inspection records — no camera or vision model connected',
      'Reject rate ',
      'alert limit',
      'Tiles inspected',
      'Defective tiles',
      'First-pass quality',
      'Most frequent defect',
      'Defect investigation',
      'Inspection records',
      'Stations, batches &amp; cost',
      'Quality events',
      'Defect records outside an event',
      'Reject rate per hour',
      'Alert limit',
    ])
      expect(html, text).toContain(text);
    expect(html.match(/class="kc[ "]/g)?.length).toBe(4);
    // Arriving without a selection: the newest relevant event is shown (and becomes the route on mount).
    const fallback = defaultSelection(s, resolvePeriod('24h', s.minute))!;
    expect(fallback).toBeTruthy();
    expect(html).toContain(`aria-label="Evidence for ${fallback}"`);
    expect(html).toMatch(new RegExp(`data-id="${fallback}" aria-current="true"`));
    expect(html).not.toMatch(/>Live</);
    expect(text(html)).not.toMatch(/caused by/i);
    expect(html).not.toMatch(/AI model detected|real-time telemetry/i);
  });

  it('shows the selected defect event with its evidence, metrics, reference video, action and hypotheses', () => {
    const s = useSim.getState().sim;
    activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 5, end: null, label: 'Glaze deterioration (render test)' });
    advance(s, s.minute + 90);
    useSim.setState({ version: s.version });
    const { open } = qualityEventsIn(s, resolvePeriod('24h', s.minute));
    const ev = open.find((e) => e.refs.defect === 'glaze' && (e.refs.inspectionIds?.length ?? 0) > 1) as OpEvent;
    expect(ev).toBeTruthy();
    sync({ qualityEventId: ev.id });
    const html = page();
    expect(html).toContain(`aria-label="Evidence for ${ev.id}"`);
    expect(html).toMatch(new RegExp(`data-id="${ev.id}" aria-current="true"`));
    expect(html).toContain('Glaze deterioration (render test)');
    const ev$ = evidenceOf(html);
    for (const text of [
      esc(ev.title),
      'Open report',
      'Show station in 3D',
      'Modeled origin: Glazing',
      'Inspection image view',
      'Drawing the simulated inspection frame',
      'Illustrative frame of simulated record',
      'Records in this event',
      'Inspection metrics',
      'Event window',
      'Excess rejects',
      'First-pass quality',
      '[video topic=glaze-defect-inspection]',
      'not evidence of this defect',
      'Recommended quality action',
      esc(DEFECT_ACTIONS.glaze),
      'Suspected causes',
      'Confirmed',
      'Possible',
      'Hypothesis: ',
      'Actions &amp; history',
      `[lifecycle ${ev.id}]`,
      'Correlation evidence',
    ])
      expect(ev$, text).toContain(text);
    // The vision tunnel record is a simulated inference record: its confidence is shown, labelled simulated.
    expect(ev$).toContain('Simulated confidence');
    expect(ev$).toContain('SIM-CV v0 (simulated)');
    expect(text(ev$)).not.toMatch(/caused by|root cause is/i);
  });

  it('shows no confidence without a simulated inference record (gauge, lab sample, event without records)', () => {
    const s = useSim.getState().sim;
    sync();
    const gauge = [...s.inspections].reverse().find((r) => r.stationId === 'ST-GAUGE' && r.result === 'reject')!;
    const g = evidence(gauge.id);
    expect(g).toContain(`aria-label="Evidence for ${gauge.id}"`);
    expect(g).toContain('Gauge tolerance rule');
    expect(g).toContain('no classification confidence');
    expect(g).toContain('[video topic=dimensional-inspection]');
    expect(g).not.toMatch(/confidence<|simulated confidence|Simulated confidence/);

    const lab = [...s.inspections].reverse().find((r) => r.stationId === 'ST-QC')!;
    const l = evidence(lab.id);
    expect(l).toContain('No inspection image');
    expect(l).toContain('not imaged');
    expect(l).toContain('[video topic=none]');
    expect(l).not.toMatch(/simulated confidence|Simulated confidence/i);

    // An event whose inspection records are not available: no image, no box, no confidence.
    const ev = s.events.find((e) => e.category === 'quality' && e.refs.defect && e.trigger.ruleId !== 'Q-CRIT')!;
    const keep = { ids: ev.refs.inspectionIds, evidence: ev.evidence };
    ev.refs.inspectionIds = [];
    ev.evidence = ev.evidence.filter((id) => s.evidence.find((x) => x.id === id)?.kind !== 'inspection-image');
    try {
      const e = evidence(ev.id);
      expect(e).toContain(`aria-label="Evidence for ${ev.id}"`);
      expect(e).toContain('No inspection image');
      expect(e).not.toMatch(/simulated confidence|Simulated confidence/i);
      expect(e).not.toContain('Inspection image view');
    } finally {
      ev.refs.inspectionIds = keep.ids;
      ev.evidence = keep.evidence;
    }

    // A vision record does carry its simulated confidence.
    const vis = [...s.inspections].reverse().find((r) => r.stationId === 'ST-VIS' && r.result === 'reject' && r.confidence != null)!;
    const v = evidence(vis.id);
    expect(v).toContain('Simulated confidence');
    expect(v).toContain('simulated confidence');
  });

  it('explains a selection that is not retained and offers the newest event', () => {
    sync({ qualityEventId: 'EV-99999' });
    const html = page();
    expect(html).toContain('EV-99999 is not in the retained history');
    expect(html).toContain('Show the newest quality event');
  });

  it('keeps the raw records and the station, batch and cost tables in secondary tabs', () => {
    sync({ tabs: { quality: 'records' } });
    const rec = page();
    expect(rec).toContain('select a record to open its evidence');
    expect(rec).toContain('Sim. conf.');
    expect(rec).not.toContain('Defect records outside an event');

    sync({ tabs: { quality: 'stations' } });
    const st = page();
    for (const text of ['Rejects by defect category', 'Production batches', 'Inspection stations', 'Scrap &amp; rework impact', 'estimate · assumptions shown', 'modeled origin'])
      expect(st, text).toContain(text);
  });
});
