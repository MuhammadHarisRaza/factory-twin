import { useState } from 'react';
import { Check, MessageSquareText, Pause, Play, SkipForward, type LucideIcon } from 'lucide-react';
import { useApp } from '../../app/store';
import type { ScenarioActivation, ScenarioKind } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { HEALTH_BY_ID } from '../../sim/health';
import { SPEEDS, useSim, useSimValue } from '../../sim/store';
import { Panel, Segmented } from '../../ui/kit/Panel';
import { ENTRY_BY_ID, maintenanceDef, sameTarget, scenarioStatus, type ScenarioDef, type ShowTarget } from './catalogue';
import { openOverview, runScenario, showTarget } from './actions';

const FAULT_ASSET = 'E-PRS2';
const CBM_MIN = 45;
const COPILOT_QUESTION = 'What should the shift supervisor do next?';

/** Guide scenarios use the catalogue builders so labels match the cards exactly. */
const guideDef = {
  breakdown: (now: number) => ENTRY_BY_ID.B.build({ machine: 'H-KILN', duration: 30 }, now),
  bottleneck: (now: number) => ENTRY_BY_ID.A.build({ stage: 'GLAZE', factor: 0.45 }, now),
  quality: (now: number) => ENTRY_BY_ID.C.build({ stage: 'GLAZE', factor: 4 }, now),
  energy: (now: number) => ENTRY_BY_ID.D.build({ consumer: 'H-KILN', factor: 1.2 }, now),
  fault: (now: number) => ENTRY_BY_ID.E.build({ asset: FAULT_ASSET, progression: 'typical' }, now),
};

const isRunning = (s: SimState, def: ScenarioDef) => s.scenarios.some((sc) => sameTarget(sc, def) && scenarioStatus(s, sc).key === 'active');

/** Activates the step's scenario unless the same one is already running, then navigates. */
function ensureThen(build: (now: number) => ScenarioDef, target: ShowTarget) {
  const { sim } = useSim.getState();
  const def = build(sim.minute);
  if (!isRunning(sim, def)) runScenario(def, 'guide');
  showTarget(target);
}

type Action = { label: string; icon?: LucideIcon; run: () => void; disabled?: string | null; primary?: boolean };
type Step = { key: string; title: string; text: string; done: boolean; actions: Action[] };

const repairText = (id: string) => {
  const r = HEALTH_BY_ID[id]?.repair;
  return r ? `${(r[0] / 60).toFixed(1)}–${(r[1] / 60).toFixed(1)} h` : 'several hours';
};

/** Suggested demo path. Each step performs its activation and navigation in one click. */
export function PresenterGuide() {
  const [visited, setVisited] = useState<Record<string, boolean>>({});
  const running = useSim((s) => s.running);
  const speed = useSim((s) => s.speed);
  const setSpeed = useSim((s) => s.setSpeed);
  const play = useSim((s) => s.play);
  const pause = useSim((s) => s.pause);
  const visit = (key: string) => setVisited((v) => ({ ...v, [key]: true }));

  const st = useSimValue((s) => {
    const had = (kind: ScenarioKind) => s.scenarios.some((sc) => sc.kind === kind);
    const now = s.minute;
    const fault = [...s.scenarios].reverse().find((sc: ScenarioActivation) => sc.kind === 'degradation' && scenarioStatus(s, sc).key === 'active') ?? null;
    const faultAsset = fault?.equipmentId ?? FAULT_ASSET;
    return {
      had: {
        breakdown: had('machine-stop'),
        bottleneck: had('bottleneck'),
        quality: had('quality-deterioration'),
        energy: had('energy-anomaly'),
        fault: had('degradation'),
        maintenance: had('maintenance'),
      },
      running: {
        breakdown: isRunning(s, guideDef.breakdown(now)),
        bottleneck: isRunning(s, guideDef.bottleneck(now)),
        quality: isRunning(s, guideDef.quality(now)),
        energy: isRunning(s, guideDef.energy(now)),
        fault: isRunning(s, guideDef.fault(now)),
      },
      fault: !!fault,
      faultAsset,
      maintRunning: s.scenarios.some((m) => m.kind === 'maintenance' && m.equipmentId === faultAsset && (m.end ?? now) > now),
    };
  });

  const steps: Step[] = [
    {
      key: 'overview',
      title: 'Factory overview',
      text: 'Start on the 3D twin: zones, machine states, material flow and vehicles all come from one simulated plant state.',
      done: !!visited.overview,
      actions: [{ label: 'Open overview', primary: true, run: () => (visit('overview'), openOverview()) }],
    },
    {
      key: 'breakdown',
      title: 'Kiln breakdown',
      text: 'A 30-min stop at the line constraint: output drops at once, upstream machines block and the event lands in Production & OEE.',
      done: st.had.breakdown,
      actions: [
        { label: st.running.breakdown ? 'Show H-KILN' : 'Break down H-KILN', primary: true, run: () => ensureThen(guideDef.breakdown, { type: 'equipment', id: 'H-KILN' }) },
        { label: 'Production', run: () => showTarget({ type: 'workspace', id: 'production' }) },
      ],
    },
    {
      key: 'bottleneck',
      title: 'Glazing bottleneck',
      text: 'Glazing at 45 % capacity: the small buffers to the kiln drain within minutes and the constraint shifts from the kiln to glazing.',
      done: st.had.bottleneck,
      actions: [
        { label: st.running.bottleneck ? 'Open Production' : 'Activate · Production', primary: true, run: () => ensureThen(guideDef.bottleneck, { type: 'workspace', id: 'production' }) },
        { label: 'Twin · G-LINE', run: () => showTarget({ type: 'equipment', id: 'G-LINE' }) },
      ],
    },
    {
      key: 'quality',
      title: 'Glaze quality deterioration',
      text: 'Glaze-origin defects ×4: rejects rise at the optical inspection tunnel; quality rate and OEE fall.',
      done: st.had.quality,
      actions: [
        { label: st.running.quality ? 'Open Quality' : 'Activate · Quality', primary: true, run: () => ensureThen(guideDef.quality, { type: 'workspace', id: 'quality' }) },
        { label: 'Twin · I-VIS', run: () => showTarget({ type: 'equipment', id: 'I-VIS' }) },
      ],
    },
    {
      key: 'energy',
      title: 'Kiln energy anomaly',
      text: 'Kiln gas 20 % above the energy model for its load: cost and kWh per m² rise and an energy alert is raised (illustrative tariffs).',
      done: st.had.energy,
      actions: [{ label: st.running.energy ? 'Open Energy' : 'Activate · Energy', primary: true, run: () => ensureThen(guideDef.energy, { type: 'workspace', id: 'energy' }) }],
    },
    {
      key: 'fault',
      title: `Developing fault on ${FAULT_ASSET}`,
      text: 'A hydraulic-pump fault develops. Rule-based detection on the simulated vibration and temperature flags it before failure, typically within 10–30 simulated minutes.',
      done: st.had.fault,
      actions: [
        { label: st.running.fault ? 'Open Machine Health' : 'Start fault · Machine Health', primary: true, run: () => ensureThen(guideDef.fault, { type: 'workspace', id: 'health' }) },
        { label: `Twin · ${FAULT_ASSET}`, run: () => showTarget({ type: 'equipment', id: FAULT_ASSET }) },
      ],
    },
    {
      key: 'maintenance',
      title: 'Condition-based maintenance',
      text: `Schedule a ${CBM_MIN}-min planned stop on ${st.faultAsset} now instead of an unplanned ${repairText(st.faultAsset)} repair later; the impact band shows the difference.`,
      done: st.had.maintenance,
      actions: [
        {
          label: 'Schedule · Machine Health',
          primary: true,
          disabled: st.maintRunning ? 'Maintenance is already in progress' : !st.fault ? 'Start the developing fault first (step 6)' : null,
          run: () => {
            runScenario(maintenanceDef(st.faultAsset, CBM_MIN), 'guide');
            showTarget({ type: 'workspace', id: 'health' });
          },
        },
      ],
    },
    {
      key: 'command',
      title: 'Command Center & copilot',
      text: 'Close on prioritised issues and recommendations; the copilot answers from the current demo state (rule-based, no language model connected).',
      done: !!visited.command,
      actions: [
        { label: 'Command Center', primary: true, run: () => (visit('command'), showTarget({ type: 'workspace', id: 'command' })) },
        { label: 'Ask the copilot', icon: MessageSquareText, run: () => (visit('command'), useApp.getState().openCopilot(COPILOT_QUESTION)) },
      ],
    },
  ];
  const next = steps.findIndex((s) => !s.done);

  return (
    <Panel
      title="Presenter guide"
      subtitle="Suggested demo path · each button activates and navigates"
      footer={
        <div className="scnp-guide-f">
          <button className="btn sm icon" onClick={running ? pause : play} title={running ? 'Pause simulation' : 'Run simulation'} aria-label={running ? 'Pause simulation' : 'Run simulation'}>
            {running ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <Segmented label="Simulation speed" value={String(speed)} options={SPEEDS.map((x) => ({ value: String(x.value), label: x.label }))} onChange={(v) => setSpeed(Number(v))} />
          <div className="spacer" />
          <button className="btn sm" onClick={() => useSim.getState().skip(15)} title="Simulate the next 15 minutes at once">
            <SkipForward size={13} aria-hidden />
            Skip 15 min
          </button>
        </div>
      }
    >
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
                {s.actions.map((a) => {
                  const Icon = a.icon;
                  return (
                    <button
                      key={a.label}
                      className={`btn sm ${a.primary && i === next ? 'primary' : ''}`}
                      disabled={!!a.disabled}
                      title={a.disabled ?? undefined}
                      onClick={a.run}
                    >
                      {Icon && <Icon size={13} aria-hidden />}
                      {a.label}
                    </button>
                  );
                })}
                {s.actions.some((a) => a.disabled) && <span className="scnp-step-why">{s.actions.find((a) => a.disabled)!.disabled}</span>}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
