/**
 * Smoke test: the Copilot workspace and the copilot drawer render (server-side) with the same engine,
 * the suggested questions, the context chips (current shift / header period, incident) and answers in
 * labelled sections; the drawer asks in the context of the workspace it is opened from.
 */
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1920,
    innerHeight: 1080,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
});

import { CopilotDrawer } from '../../app/CopilotDrawer';
import { WORKSPACES, useApp } from '../../app/store';
import { SUGGESTED_QUESTIONS, WORKSPACE_TITLE } from '../../intel/copilot';
import { attentionEvents } from '../../intel/kpis';
import { activateScenario, advance } from '../../sim/engine';
import { resolvePeriod } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { useCopilot } from '../../ui/copilot/store';
import { CopilotPage } from '../CopilotPage';
import { copilotSummary } from './derive';

useSim.getState().pause();

const sync = () => {
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useCopilot.getInitialState(), useCopilot.getState());
  Object.assign(useTwin.getInitialState(), useTwin.getState());
};
const render = (el: ReactElement) => {
  sync();
  return renderToStaticMarkup(el);
};
const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const CORE_LABELS = ['Confirmed facts', 'Simulated events', 'Inferred explanation', 'Unverified hypotheses', 'Recommended actions'];

describe('Copilot workspace and drawer', () => {
  it('names the seven workspaces as the navigation does', () => {
    expect(WORKSPACES.map((w) => [w.id, w.title])).toEqual(Object.entries(WORKSPACE_TITLE));
  });

  it('the drawer is closed until opened, then offers the suggested questions in the current shift', () => {
    useApp.setState({ copilotOpen: false });
    expect(render(<CopilotDrawer />)).toBe('');
    useApp.setState({ copilotOpen: true, workspace: 'overview' });
    const html = render(<CopilotDrawer />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('no language model, no external service');
    for (const q of SUGGESTED_QUESTIONS) expect(html, q).toContain(esc(q));
    expect(html).toContain('Current shift');
    expect(html).toContain(esc(resolvePeriod('shift', useSim.getState().sim.minute).label));
    expect(html).not.toMatch(/energy/i);
  });

  it('answers in labelled sections, in the context of the workspace it is opened from', () => {
    const s = useSim.getState().sim;
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-KIN', end: null, label: 'Kiln infeed conveyor stop' });
    advance(s, s.minute + 30);
    useSim.setState({ version: s.version });

    // Production with the header period on the last 7 days: the answer uses that period.
    useApp.setState({ copilotOpen: true, workspace: 'production', period: '7d', productionStage: 'GLAZE' });
    let html = render(<CopilotDrawer />);
    expect(html).toContain('Period');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('Glazing &amp; decoration');
    useCopilot.getState().ask('Why is production below target?');
    const turn = useCopilot.getState().turns.at(-1)!;
    expect(turn.answer.periodLabel).toBe('Last 7 days');
    expect(turn.context.stageId).toBe('GLAZE');
    html = render(<CopilotDrawer />);
    for (const label of CORE_LABELS) expect(html, label).toContain(label);
    expect(html).toContain('Figures used');
    expect(html).toContain('Open Production');

    // Events & Reports with an event open: "this incident" is that event.
    const ev = attentionEvents(s)[0];
    useApp.setState({ workspace: 'events', selectedEventId: ev.id, copilotEventId: null });
    html = render(<CopilotDrawer />);
    expect(html).toContain('Incident');
    expect(html).toContain(ev.id);
    useCopilot.getState().ask('What happened during this incident?');
    const t2 = useCopilot.getState().turns.at(-1)!;
    expect(t2.answer.intent).toBe('event-what');
    expect(t2.answer.eventId).toBe(ev.id);
    // Removing the chip asks plant-wide (it stays removed for that record).
    useCopilot.getState().dismiss('event');
    useCopilot.getState().ask('What happened during this incident?');
    expect(useCopilot.getState().turns.at(-1)!.answer.intent).toBe('event-missing');
    html = render(<CopilotDrawer />);
    expect(html).toContain('Cannot be established');
  });

  it('the workspace shows the conversation, the suggested questions, the incident picker and the shift summary', () => {
    useApp.setState({ copilotOpen: false, workspace: 'copilot', copilotEventId: null });
    const s = useSim.getState().sim;
    const html = render(<CopilotPage />);
    for (const text of ['Copilot', 'Conversation', 'Suggested questions', 'Investigate an incident', 'no language model, no external service', 'Current shift'])
      expect(html, text).toContain(text);
    expect(html).toContain(esc(copilotSummary(s).sentence));
    for (const e of attentionEvents(s).slice(0, 3)) expect(html).toContain(e.id);
    expect(html).not.toMatch(/Command Center|Machine Health|Energy Intelligence|Scenario Simulator|>Live</);

    // An incident chosen for the copilot is shown with its record.
    const ev = attentionEvents(s)[0];
    useApp.setState({ copilotEventId: ev.id });
    const withCtx = render(<CopilotPage />);
    expect(withCtx).toContain(`Incident in context · ${ev.id}`);
    expect(withCtx).toContain('Open report');
    expect(withCtx).toContain('Show in twin');
  });
});
