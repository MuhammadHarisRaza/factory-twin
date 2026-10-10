import { useState, type ReactNode } from 'react';
import { RotateCcw, X } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { DOCKS, PROCESS_MACHINES, STAGES } from '../model/plant';
import type { ScenarioActivation, ScenarioKind, StageId } from '../model/types';
import { scenariosActive } from '../sim/engine';
import { useSim, useSimValue } from '../sim/store';
import { formatClock } from '../sim/time';
import { useApp } from './store';

const machineName = (id: string) => `${id} · ${EQUIPMENT_BY_ID[id].name}`;
const stageName = (id: StageId) => STAGES.find((s) => s.id === id)!.name;

const DURATIONS = [
  { value: 0, label: 'Until cleared' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '60 min' },
  { value: 120, label: '2 h' },
];

function Card({ kind, title, description, children, onActivate }: { kind: ScenarioKind; title: string; description: string; children?: ReactNode; onActivate: () => void }) {
  const active = useSimValue((s) => scenariosActive(s).filter((sc) => sc.kind === kind).length);
  return (
    <div className={`scn ${active ? 'active' : ''}`}>
      <div>
        <h3>
          {title}
          {active ? <span className="tag scenario" style={{ marginLeft: 8 }}>{active} active</span> : null}
        </h3>
        <p>{description}</p>
      </div>
      <div className="row">
        {children}
        <div className="spacer" />
        <button className="btn primary" onClick={onActivate}>
          Activate
        </button>
      </div>
    </div>
  );
}

function Select<T extends string | number>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <label className="field">
      {label}
      <select
        className="select"
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value)!;
          onChange(o.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Deterministic scenario inputs, activation status and reset. */
export function ScenarioDrawer() {
  const open = useApp((s) => s.scenariosOpen);
  const setOpen = useApp((s) => s.setScenariosOpen);
  const activate = useSim((s) => s.activate);
  const clear = useSim((s) => s.clear);
  const clearAll = useSim((s) => s.clearAll);
  const reset = useSim((s) => s.reset);
  const minute = useSimValue((s) => s.minute);
  const active = useSimValue((s) => scenariosActive(s));
  const occupiedDocks = useSimValue((s) => DOCKS.filter((d) => s.logistics.docks[d.id].vehicleId || s.logistics.docks[d.id].reservedBy).map((d) => d.id));

  const [stopMachine, setStopMachine] = useState('E-PRS2');
  const [stopFor, setStopFor] = useState(30);
  const [slowMachine, setSlowMachine] = useState('H-KILN');
  const [slowFactor, setSlowFactor] = useState(0.6);
  const [bnStage, setBnStage] = useState<StageId>('DRY');
  const [bnFactor, setBnFactor] = useState(0.45);
  const [qStage, setQStage] = useState<StageId>('GLAZE');
  const [qFactor, setQFactor] = useState(4);
  const [congestion, setCongestion] = useState(10);
  const [dock, setDock] = useState<string>('auto');
  const [hold, setHold] = useState(75);
  const [confirmReset, setConfirmReset] = useState(false);

  if (!open) return null;
  const end = (d: number) => (d > 0 ? minute + d : null);
  const go = (def: Omit<ScenarioActivation, 'id' | 'start'>) => activate(def);

  const machineOptions = PROCESS_MACHINES.map((id) => ({ value: id, label: machineName(id) }));
  const stageOptions = STAGES.map((s) => ({ value: s.id, label: s.name }));

  return (
    <>
      <div className="drawer-scrim" onClick={() => setOpen(false)} />
      <aside className="drawer" role="dialog" aria-label="Scenarios">
        <div className="drawer-h">
          <h2>Scenarios</h2>
          <span className="tag sim">Simulated inputs</span>
          <div className="spacer" />
          <button className="btn ghost icon" onClick={() => setOpen(false)} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-b">
          <div className="notice">
            <span>
              Scenarios change the <b>simulation only</b> and start at the current plant time ({formatClock(minute)}). Nothing is sent to equipment. Every
              affected metric, event and 3D state derives from the same simulated state.
            </span>
          </div>

          {active.length > 0 && (
            <div className="scn active">
              <h3>Active scenarios</h3>
              {active.map((sc) => (
                <div key={sc.id} className="row" style={{ justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 12 }}>
                    {sc.label}
                    <span className="muted"> · since {formatClock(sc.start)}{sc.end ? ` · until ${formatClock(sc.end)}` : ''}</span>
                  </span>
                  <button className="btn sm" onClick={() => clear(sc.id)}>
                    Clear
                  </button>
                </div>
              ))}
              <div className="row">
                <button className="btn sm" onClick={clearAll}>
                  Clear all
                </button>
              </div>
            </div>
          )}

          <Card
            kind="machine-stop"
            title="Machine stoppage"
            description="Stops the machine and opens a downtime event; availability and OEE fall, and buffers absorb or pass on the loss."
            onActivate={() => go({ kind: 'machine-stop', equipmentId: stopMachine, end: end(stopFor), label: `Stop ${machineName(stopMachine)}` })}
          >
            <Select label="Machine" value={stopMachine} onChange={setStopMachine} options={machineOptions} />
            <Select label="Duration" value={stopFor} onChange={setStopFor} options={DURATIONS} />
          </Card>

          <Card
            kind="reduced-rate"
            title="Reduced production rate"
            description="Runs the machine below its ideal rate; performance and output fall while it stays available."
            onActivate={() =>
              go({ kind: 'reduced-rate', equipmentId: slowMachine, factor: slowFactor, end: null, label: `${machineName(slowMachine)} at ${Math.round(slowFactor * 100)} % rate` })
            }
          >
            <Select label="Machine" value={slowMachine} onChange={setSlowMachine} options={machineOptions} />
            <Select
              label="Rate"
              value={slowFactor}
              onChange={setSlowFactor}
              options={[0.8, 0.6, 0.4].map((f) => ({ value: f, label: `${f * 100} % of ideal` }))}
            />
          </Card>

          <Card
            kind="bottleneck"
            title="Production bottleneck"
            description="Cuts capacity at one stage. Downstream stages starve only once the buffer between them drains — watch the delay in Production & OEE."
            onActivate={() => go({ kind: 'bottleneck', stage: bnStage, factor: bnFactor, end: null, label: `${stageName(bnStage)} at ${Math.round(bnFactor * 100)} % capacity` })}
          >
            <Select label="Stage" value={bnStage} onChange={setBnStage} options={stageOptions} />
            <Select label="Capacity" value={bnFactor} onChange={setBnFactor} options={[0.7, 0.55, 0.45, 0.3].map((f) => ({ value: f, label: `${Math.round(f * 100)} %` }))} />
          </Card>

          <Card
            kind="quality-deterioration"
            title="Quality deterioration"
            description="Raises rejects detected at inspection for defects originating at the chosen stage; quality rate and OEE fall."
            onActivate={() =>
              go({ kind: 'quality-deterioration', stage: qStage, factor: qFactor, end: null, label: `${stageName(qStage)} defects ×${qFactor}` })
            }
          >
            <Select
              label="Defect origin"
              value={qStage}
              onChange={setQStage}
              options={(['PRESS', 'GLAZE', 'DECOR', 'KILN'] as StageId[]).map((s) => ({ value: s, label: stageName(s) }))}
            />
            <Select label="Severity" value={qFactor} onChange={setQFactor} options={[2, 4, 6].map((f) => ({ value: f, label: `×${f} reject rate` }))} />
          </Card>

          <Card
            kind="truck-arrival"
            title="Truck arrival"
            description="An outbound truck arrives at the gate now, waits for a dock, loads and departs."
            onActivate={() => go({ kind: 'truck-arrival', end: null, label: 'Additional truck arrival' })}
          />

          <Card
            kind="yard-congestion"
            title="Yard congestion"
            description="A burst of outbound trucks arrives two minutes apart; the holding area fills and waiting time rises."
            onActivate={() => go({ kind: 'yard-congestion', count: congestion, end: null, label: `Yard congestion · ${congestion} trucks` })}
          >
            <Select label="Trucks" value={congestion} onChange={setCongestion} options={[6, 10, 14].map((n) => ({ value: n, label: `${n} trucks` }))} />
          </Card>

          <Card
            kind="prolonged-dock-stay"
            title="Prolonged dock stay"
            description="Holds a docked truck after loading (documentation hold); dock time, turnaround and dock utilisation rise."
            onActivate={() =>
              go({
                kind: 'prolonged-dock-stay',
                dockId: dock === 'auto' ? undefined : dock,
                count: hold,
                end: null,
                label: `Dock hold +${hold} min${dock === 'auto' ? '' : ` · ${DOCKS.find((d) => d.id === dock)!.name}`}`,
              })
            }
          >
            <Select
              label="Dock"
              value={dock}
              onChange={setDock}
              options={[{ value: 'auto', label: occupiedDocks.length ? 'First occupied dock' : 'No dock occupied yet' }, ...occupiedDocks.map((d) => ({ value: d, label: DOCKS.find((x) => x.id === d)!.name }))]}
            />
            <Select label="Hold" value={hold} onChange={setHold} options={[45, 75, 120].map((n) => ({ value: n, label: `+${n} min` }))} />
          </Card>

          <div className="scn">
            <h3>Reset simulation</h3>
            <p>Rebuilds the seeded baseline (7 days of history up to Mon 12 Oct 10:30) and removes all scenarios.</p>
            <div className="row">
              {confirmReset ? (
                <>
                  <span style={{ fontSize: 12 }}>Discard all scenario effects?</span>
                  <div className="spacer" />
                  <button className="btn" onClick={() => setConfirmReset(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn danger"
                    onClick={() => {
                      reset();
                      setConfirmReset(false);
                    }}
                  >
                    Reset to baseline
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => setConfirmReset(true)}>
                  <RotateCcw size={14} />
                  Reset to baseline
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
