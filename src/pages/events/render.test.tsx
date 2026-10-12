/**
 * Server-rendered smoke tests of Events & Reports: the three tabs, the event detail in the §13
 * investigation order (with its provenance and the reference-footage-is-not-evidence label), the
 * report builder (five types, live preview of the same model, the legend), and the detection rules
 * (moved from the retired Assets page).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The stores register browser listeners at import; a minimal window is enough for server rendering.
vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { productionKpis } from '../../intel/kpis';
import { REPORT_TYPES, buildOpsReport } from '../../report/ops';
import { reportPeriod } from '../../report/ops/common';
import { activateScenario, advance } from '../../sim/engine';
import { EVENT_RULE_DEFS } from '../../sim/events';
import { resolvePeriod } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { OpsReportView } from '../../ui/report/OpsReportView';
import { EventsPage } from '../EventsPage';
import { EventDetail, associatedKpis, monitoredStageOf, videoContextOf } from './EventDetail';
import { DEFAULT_FILTERS, filterEvents, reportFilters } from './filters';
import { openIncidentReport, openReportEvents, useEventsView, useReportBuilder } from './state';
import { EQUIPMENT_TOPICS } from '../../video/topics';

useSim.getState().pause();

/** Server rendering reads zustand's initial state, so mirror the current state into it first. */
const render = (node: React.ReactNode) => {
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useEventsView.getInitialState(), useEventsView.getState());
  Object.assign(useReportBuilder.getInitialState(), useReportBuilder.getState());
  return renderToStaticMarkup(node);
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const sim = () => useSim.getState().sim;

beforeAll(() => {
  const s = sim();
  const t0 = s.minute;
  activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: t0 + 20, label: 'Kiln infeed stop' });
  activateScenario(s, { kind: 'quality-deterioration', stage: 'GLAZE', factor: 6, end: null, label: 'Glaze defects' });
  activateScenario(s, { kind: 'yard-congestion', count: 8, end: null, label: 'Yard' });
  advance(s, t0 + 60);
  useSim.setState({ version: s.version });
}, 120_000);

describe('Events tab', () => {
  it('renders the counts, the filters, the list and the selected event', () => {
    const ev = sim().events.find((e) => e.type === 'conveyor-stop' && !e.historical)!;
    useApp.setState({ workspace: 'events', selectedEventId: ev.id, tabs: {} });
    useEventsView.setState({ filters: DEFAULT_FILTERS, page: 0 });
    const t = text(render(<EventsPage />));
    for (const label of ['Events & Reports', 'Issues requiring attention', 'Conditions active now', 'Not acknowledged', 'Detected this session', 'All severities', 'Any status', 'All categories', 'All stages', 'Simulated & scenario', 'This session only', 'newest first', 'Underlying record log'])
      expect(t, label).toContain(label);
    // No energy remnants and no links to retired workspaces.
    expect(t).not.toMatch(/Energy|Assets & Data|Machine Health|Command Center/);
    expect(t).toContain(ev.id);
    // The tabs.
    for (const label of ['Events', 'Reports', 'Detection rules']) expect(t).toContain(label);
  });

  it('reads the selected event in the investigation order of §13', () => {
    for (const cat of ['production', 'quality', 'logistics'] as const) {
      const ev = [...sim().events].reverse().find((e) => e.category === cat && !e.historical)!;
      expect(ev, cat).toBeDefined();
      const t = text(render(<EventDetail eventId={ev.id} />));
      let last = -1;
      for (const step of ['What happened', 'Affected equipment & stage', 'Evidence', 'Associated KPIs', 'Impact', 'Recommended investigation', 'Related events & views', 'History, lifecycle & resolution']) {
        const i = t.indexOf(` ${step} `, last + 1);
        expect(i, `${ev.id} step "${step}"`).toBeGreaterThan(last);
        last = i;
      }
      for (const label of ['Show in 3D', 'Ask Copilot', 'Incident report', 'Download PDF', 'Reference footage — not evidence', 'not evidence that it happened', 'Acknowledge', 'Resolve']) expect(t, `${ev.id} ${label}`).toContain(label);
      // Simulated vs scenario-caused is stated.
      expect(t).toMatch(ev.source === 'scenario' ? /Scenario-caused/ : /Simulated — raised by rule/);
      if (cat === 'quality') expect(t).toContain('Open in Quality & Defects');
      if (cat === 'production') expect(t).toMatch(/in Production/);
    }
  });

  it('associates the KPIs of kpis.ts, a monitored stage and the most specific video context', () => {
    const s = sim();
    const conv = s.events.find((e) => e.type === 'conveyor-stop' && e.asset.equipmentId === 'CV-KIN')!;
    expect(monitoredStageOf(conv)).toBe('KILN');
    const kpis = associatedKpis(s, conv);
    const p = resolvePeriod('shift', s.minute);
    const ref = productionKpis(s, p);
    expect(kpis.find((k) => k.id === 'good-output')).toEqual(ref.find((k) => k.id === 'good-output'));
    // Equipment footage when the registry maps the asset, otherwise the stage's reference video.
    expect(videoContextOf(conv, 'KILN')).toEqual(EQUIPMENT_TOPICS['CV-KIN'] ? { equipmentId: 'CV-KIN', stage: 'KILN' } : { stage: 'KILN' });
    const glazeBelt = { ...conv, asset: { equipmentId: 'NOT-MAPPED', stage: 'GLAZE' as const } };
    expect(videoContextOf(glazeBelt, 'GLAZE')).toEqual({ stage: 'GLAZE' });
    const q = s.events.find((e) => e.category === 'quality' && e.refs.defect)!;
    expect(videoContextOf(q, monitoredStageOf(q)).topic).toMatch(/inspection$/);
    const yard = s.events.find((e) => e.type === 'yard-congestion')!;
    const yardEq = yard.asset.equipmentId;
    expect(videoContextOf(yard, null)).toEqual(yardEq && EQUIPMENT_TOPICS[yardEq] ? { equipmentId: yardEq, stage: null } : { topic: 'yard-movement' });
    expect(videoContextOf({ ...yard, asset: {} }, null)).toEqual({ topic: 'yard-movement' });
  });

  it('explains a missing event', () => {
    expect(text(render(<EventDetail eventId="EV-99999" />))).toContain('not in the current demo state');
  });
});

describe('Reports tab', () => {
  it('lands on the builder with five report types, the preview and the legend', () => {
    useApp.setState({ workspace: 'events', tabs: { events: 'reports' } });
    useReportBuilder.setState({ type: 'shift', period: 'shift', scope: 'line', eventId: null });
    const t = text(render(<EventsPage />));
    for (const d of REPORT_TYPES) expect(t).toContain(d.label);
    for (const label of ['Reporting period', 'Current shift', 'Previous shift', 'Today', 'Last 24 h', 'Last 7 days', 'Scope', 'Whole line', 'Download PDF', 'Preview', 'Headline KPIs', 'Significant events', 'Actions & recommendations', 'How to read this report'])
      expect(t, label).toContain(label);
    for (const label of ['Measured in simulation', 'Simulated', 'Estimated', 'Illustrative']) expect(t).toContain(label);
    // The preview shows the KPI values of kpis.ts for the period.
    const s = sim();
    for (const k of productionKpis(s, resolvePeriod('shift', s.minute))) if (!k.unavailable) expect(t).toContain(k.display);
  });

  it('previews every operational report type and the incident investigation', () => {
    for (const type of ['oee', 'quality', 'fleet'] as const) {
      useReportBuilder.setState({ type, period: '24h', scope: 'line' });
      const t = text(render(<EventsPage />));
      expect(t).toContain(REPORT_TYPES.find((d) => d.id === type)!.label);
      expect(t).toContain('Last 24 hours');
    }
    const ev = sim().events.find((e) => e.type === 'conveyor-stop' && !e.historical)!;
    useReportBuilder.setState({ type: 'incident', eventId: ev.id });
    const t = text(render(<EventsPage />));
    expect(t).toContain(ev.id);
    expect(t).toContain('Data provenance & limitations');
    expect(t).toContain('Measured in simulation');
    expect(t).not.toContain('Reporting period');
  });

  it('opens an event as an incident report from the Events tab', () => {
    const ev = sim().events.find((e) => e.category === 'quality' && !e.historical)!;
    useApp.setState({ workspace: 'events', selectedEventId: ev.id, tabs: {} });
    openIncidentReport(ev.id);
    expect(useApp.getState().tabs.events).toBe('reports');
    expect(useReportBuilder.getState()).toMatchObject({ type: 'incident', eventId: ev.id });
    const t = text(render(<EventsPage />));
    expect(t).toContain(`${ev.id} · ${ev.title}`);
    expect(t).toContain('The PDF freezes the event record');
  });

  it('states that the PDF is the previewed model', () => {
    useReportBuilder.setState({ type: 'oee', period: 'shift', scope: 'KILN', eventId: null });
    useApp.setState({ workspace: 'events', tabs: { events: 'reports' } });
    const t = text(render(<EventsPage />));
    expect(t).toContain('The PDF contains exactly the preview below');
    expect(t).toContain('Kiln firing & cooling (KILN)');
  });

  it('renders a report model section by section, with links on event ids', () => {
    const r = buildOpsReport(sim(), 'quality', { period: 'shift' });
    const html = render(<OpsReportView report={r} />);
    const t = text(html);
    for (const sec of r.sections) expect(t).toContain(sec.title);
    for (const row of r.events.slice(0, 3)) expect(html).toContain(`>${row.id}</button>`);
    expect(t).toContain(r.period.text);
  });
});

describe('Reports tab: long event lists and the Events tab (#0, #23, #1)', () => {
  it('previews the first 12 events with "Show all N" and offers the same list in the Events tab', () => {
    useApp.setState({ workspace: 'events', tabs: { events: 'reports' } });
    useReportBuilder.setState({ type: 'shift', period: '7d', scope: 'line', eventId: null });
    const r = buildOpsReport(sim(), 'shift', { period: '7d' });
    expect(r.events.length).toBeGreaterThan(12);
    const html = render(<EventsPage />);
    const t = text(html);
    expect(t).toContain(`Show all ${r.events.length}`);
    expect(t).toContain(`12 of ${r.events.length} rows shown — the PDF lists all ${r.events.length}`);
    expect(t).toContain(`Open these ${r.events.length} events in the Events tab`);
    expect(t).not.toContain('listed in Events & Reports');
    // Exactly the first 12 event ids are drawn before "Show all".
    const shown = r.events.filter((e) => html.includes(`>${e.id}</button>`)).length;
    expect(shown).toBe(12);
    // Without an Events-tab handler there is no dead button.
    expect(text(render(<OpsReportView report={r} />))).not.toContain('in the Events tab');
  });

  it('opens the Events tab listing exactly the report events, with the report window', () => {
    const r = buildOpsReport(sim(), 'oee', { period: '7d', scope: 'KILN' });
    expect(r.events.length).toBeGreaterThan(0);
    useApp.setState({ workspace: 'events', tabs: { events: 'reports' }, selectedEventId: null });
    openReportEvents(r.eventQuery, r.events.map((e) => e.id));
    expect(useApp.getState().tabs.events).toBeUndefined();
    expect(useApp.getState().selectedEventId).toBe(r.events[0].id);
    const f = useEventsView.getState().filters;
    expect(f).toEqual(reportFilters(r.eventQuery));
    const s = sim();
    expect(new Set(filterEvents(s.events, f, { now: s.minute }).map((e) => e.id))).toEqual(new Set(r.events.map((e) => e.id)));
    const t = text(render(<EventsPage />));
    expect(t).toContain(`${r.events.length} event${r.events.length === 1 ? '' : 's'}`);
    expect(t).toContain('last 7 days');
    expect(t).toContain('root events, warning and above');
    expect(t).toContain('Categories: ');
  });

  it('starts from the header period when arriving from Production, Quality or Fleet', () => {
    useReportBuilder.setState({ type: 'shift', period: 'shift', scope: 'line', eventId: null });
    for (const [from, period] of [['production', 'prev-shift'], ['quality', '7d'], ['fleet', 'today']] as const) {
      useApp.setState({ workspace: from, period });
      useApp.getState().go('events');
      expect(useReportBuilder.getState().period, from).toBe(period);
    }
    // Arriving from a workspace without the period selector keeps the builder's choice.
    useReportBuilder.setState({ period: '24h' });
    useApp.setState({ workspace: 'overview', period: '7d' });
    useApp.getState().go('events');
    expect(useReportBuilder.getState().period).toBe('24h');
  });

  it('previews the previous shift as a completed period', () => {
    useApp.setState({ workspace: 'events', tabs: { events: 'reports' } });
    useReportBuilder.setState({ type: 'shift', period: 'prev-shift', scope: 'line', eventId: null });
    const t = text(render(<EventsPage />));
    expect(t).toContain('Previous shift · Shift');
    const per = reportPeriod('prev-shift', sim().minute);
    expect(per.text).not.toContain('to date');
    expect(t).toContain(`${per.label} · ${per.text}`);
  });
});

describe('Detection rules tab', () => {
  it('lists the rules with editable thresholds and the unavailable rules with their reason', () => {
    useApp.setState({ workspace: 'events', tabs: { events: 'rules' } });
    const html = render(<EventsPage />);
    const t = text(html);
    for (const d of EVENT_RULE_DEFS) expect(t).toContain(d.id);
    for (const d of EVENT_RULE_DEFS.filter((x) => !x.available)) expect(t).toContain(d.unavailableReason!);
    expect(t).toContain('Reset all to defaults');
    expect(t).toContain('% of ideal');
    expect(t).toContain('Not available in this release');
    expect(t).not.toMatch(/Energy/);
  });
});
