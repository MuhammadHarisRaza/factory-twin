import { Box, Check, ClipboardList, MessageSquareText, Pause, Play, SkipForward, type LucideIcon } from 'lucide-react';
import { useApp } from '../../app/store';
import { SPEEDS, useSim, useSimValue } from '../../sim/store';
import { Segmented } from '../../ui/kit/Panel';
import { resolveValues, type ShowTarget, type Values } from './catalogue';
import { DEMO_BY_ID, demoKey, demoView, type DemoId } from './demos';
import { currentRun, openOverview, openWholeTwin, setupDemo, showTarget, useDemoRuns, useScenarioParams } from './actions';
import { useScenarioDrawer } from './drawerState';

type Action = { label: string; icon?: LucideIcon; run: () => void; disabled?: string | null; primary?: boolean };
type Step = { key: string; title: string; text: string; done: boolean; actions: Action[] };

/**
 * Suggested demo path through the connected use cases, in the seven workspaces. Each step sets up
 * its demonstration (the same inputs and labels as the guided-demo cards, unless it is already
 * running) and navigates in one click; secondary buttons open the event report the step produced.
 * `onNavigate` runs before a step leaves the panel (the drawer closes); `onGoToReset` shows card E.
 */
export function PresenterGuide({ onNavigate, onGoToReset }: { onNavigate?: () => void; onGoToReset: () => void }) {
  const visited = useScenarioDrawer((s) => s.visited);
  const visit = useScenarioDrawer((s) => s.visit);
  const running = useSim((s) => s.running);
  const speed = useSim((s) => s.speed);
  const resetting = useSim((s) => s.resetting);
  const setSpeed = useSim((s) => s.setSpeed);
  const play = useSim((s) => s.play);
  const pause = useSim((s) => s.pause);
  const runs = useDemoRuns((s) => s.runs);
  const resets = useSim((s) => s.resets);
  const values = useScenarioParams((s) => s.values);

  const views = useSimValue(
    (s) =>
      Object.fromEntries(
        (['A', 'B', 'C', 'D'] as DemoId[]).map((id) => {
          const def = DEMO_BY_ID[id];
          const v = resolveValues(def, values[demoKey(id)], s);
          return [id, { v, view: demoView(s, def, v, currentRun(runs, id, resets)) }];
        }),
      ) as Record<DemoId, { v: Values; view: ReturnType<typeof demoView> }>,
    [values, runs, resets],
  );

  const go = (fn: () => void) => {
    onNavigate?.();
    fn();
  };
  /** Sets the demonstration up unless it is already running, then goes to `target`. */
  const ensure = (id: DemoId, target: ShowTarget) => {
    if (!views[id].view.active) setupDemo(id, views[id].v);
    go(() => showTarget(target));
  };
  const eventAction = (id: DemoId, label: string): Action => {
    const ev = views[id].view.primary;
    return {
      label,
      icon: ClipboardList,
      disabled: ev ? null : views[id].view.run ? 'The event appears once its rule fires' : 'Set up first',
      run: () => (ev ? go(() => showTarget({ type: 'event', id: ev.id })) : undefined),
    };
  };
  const a = views.A.view;
  const conveyor = a.scenarios[0]?.sc.equipmentId ?? String(views.A.v.conveyor);
  const stopEvent = a.primary;
  const machineB = views.B.view.scenarios[0]?.sc.equipmentId ?? String(views.B.v.machine);

  const steps: Step[] = [
    {
      key: 'overview',
      title: 'Overview',
      text: 'One simulated plant state: five KPIs, the 3D factory and the issues requiring attention. The Factory Twin shows zones, machine and conveyor states, material flow and vehicles.',
      done: !!visited.overview,
      actions: [
        { label: 'Open Overview', primary: true, run: () => (visit('overview'), go(openOverview)) },
        { label: 'Factory Twin', icon: Box, run: () => (visit('overview'), go(openWholeTwin)) },
      ],
    },
    {
      key: 'A',
      title: '1 · Production — conveyor stoppage',
      text: `${conveyor} stops: the stop is raised as an event with its state transition, counters and a twin snapshot; the receiving stage starves once its buffer runs out.`,
      done: !!a.run,
      actions: [
        { label: a.active ? `Show ${conveyor}` : `Stop ${conveyor} · Factory Twin`, primary: true, run: () => ensure('A', { type: 'equipment', id: conveyor }) },
        eventAction('A', 'Event report'),
      ],
    },
    {
      key: 'copilot',
      title: 'Copilot on the same event',
      text: 'Ask what happened, why and the impact: the answer is built from the event record — confirmed facts, simulated records, inferred causes and estimates kept apart (rule-based, no language model).',
      done: !!visited.copilot,
      actions: [
        {
          label: 'Ask about the stop',
          icon: MessageSquareText,
          primary: true,
          disabled: stopEvent ? null : 'Set up step 1 first — the copilot answers about its event',
          run: () => {
            if (!stopEvent) return;
            visit('copilot');
            go(() => useApp.getState().openCopilot(`What happened at ${conveyor}, why, and what is the impact?`, { eventId: stopEvent.id }));
          },
        },
      ],
    },
    {
      key: 'B',
      title: '2 · OEE & losses — reduced rate or downtime',
      text: `${machineB} loses performance (or availability): OEE, the capacity gap at the constraint and its estimated value (assumptions shown) move in Production.`,
      done: !!views.B.view.run,
      actions: [
        { label: views.B.view.active ? 'Open Production' : 'Set up · Production', primary: true, run: () => ensure('B', { type: 'workspace', id: 'production' }) },
        eventAction('B', 'Event report'),
      ],
    },
    {
      key: 'C',
      title: '3 · Quality & Defects — defect deterioration',
      text: 'Defects of one origin rise: inspection records (illustrative frames, simulated classification), the defect Pareto and a quality event with the frames as evidence.',
      done: !!views.C.view.run,
      actions: [
        { label: views.C.view.active ? 'Open Quality & Defects' : 'Set up · Quality & Defects', primary: true, run: () => ensure('C', { type: 'workspace', id: 'quality' }) },
        eventAction('C', 'Quality event'),
      ],
    },
    {
      key: 'D',
      title: '4 · Fleet & Movement — truck delay',
      text: 'An extra truck goes gate → check-in → holding → dock; when it docks a documentation hold is added automatically and the dock-stay rule raises a dock event with the visit timeline.',
      done: !!views.D.view.run,
      actions: [
        { label: views.D.view.active ? 'Open Fleet & Movement' : 'Set up · Fleet & Movement', primary: true, run: () => ensure('D', { type: 'workspace', id: 'fleet' }) },
        eventAction('D', 'Dock event'),
      ],
    },
    {
      key: 'events',
      title: 'Events & Reports',
      text: 'Every event of the session on one list: acknowledge, investigate and resolve it, and export its report as PDF — the same record the twin, the workspaces and the copilot use.',
      done: !!visited.events,
      actions: [{ label: 'Open Events & Reports', primary: true, run: () => (visit('events'), go(() => showTarget({ type: 'workspace', id: 'events' }))) }],
    },
    {
      key: 'reset',
      title: 'Reset',
      text: 'Back to the seeded start between meetings (card E, with confirmation); the check list confirms no scenario, no session events and counters on the baseline.',
      done: false,
      actions: [{ label: 'Go to Reset (E)', primary: true, disabled: resetting ? 'Resetting…' : null, run: onGoToReset }],
    },
  ];
  const next = steps.findIndex((s) => !s.done);

  return (
    <div className="scnp-guide">
      <ol className="scnp-steps">
        {steps.map((s, i) => (
          <li key={s.key} className={`${s.done ? 'done' : ''} ${i === next ? 'next' : ''}`}>
            <span className="scnp-step-n" aria-label={s.done ? `Step ${i + 1}, done` : `Step ${i + 1}`}>
              {s.done ? <Check size={12} strokeWidth={2.6} aria-hidden /> : i + 1}
            </span>
            <div className="scnp-step-b">
              <b>{s.title}</b>
              <p>{s.text}</p>
              <div className="scnp-step-a">
                {s.actions.map((act) => {
                  const Icon = act.icon;
                  return (
                    <button
                      key={act.label}
                      type="button"
                      className={`btn sm ${act.primary && i === next ? 'primary' : ''}`}
                      disabled={!!act.disabled || (resetting && act.primary)}
                      title={act.disabled ?? undefined}
                      onClick={act.run}
                    >
                      {Icon && <Icon size={13} aria-hidden />}
                      {act.label}
                    </button>
                  );
                })}
                {s.actions.some((x) => x.disabled) && <span className="scnp-step-why">{s.actions.find((x) => x.disabled)!.disabled}</span>}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="scnp-guide-f" role="group" aria-label="Simulation clock">
        <button type="button" className="btn sm icon" onClick={running ? pause : play} title={running ? 'Pause simulation' : 'Run simulation'} aria-label={running ? 'Pause simulation' : 'Run simulation'}>
          {running ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <Segmented label="Simulation speed" value={String(speed)} options={SPEEDS.map((x) => ({ value: String(x.value), label: x.label }))} onChange={(v) => setSpeed(Number(v))} />
        <div className="spacer" />
        <button type="button" className="btn sm" disabled={resetting} onClick={() => useSim.getState().skip(15)} title="Simulate the next 15 minutes at once (the clock jumps; nothing else changes)">
          <SkipForward size={13} aria-hidden />
          Skip 15 min
        </button>
      </div>
    </div>
  );
}
