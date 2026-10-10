/**
 * Truck stage pipeline: every external truck in exactly one stage of its visit, from the entry gate
 * to the exit gate, with the count per stage and a chip per truck. The dispatch-staging lane shows
 * the outbound loads supplied from the K-STG staging lanes (those trucks are counted at the dock).
 */
import { ArrowDownToLine, ArrowUpFromLine, Boxes, ListOrdered, LogIn, LogOut, Scale, SquareParking, TriangleAlert, Warehouse, type LucideIcon } from 'lucide-react';
import type { OpEvent } from '../../model/types';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { formatClock } from '../../sim/time';
import { Panel } from '../../ui/kit/Panel';
import { fmtInt } from '../../ui/kit/format';
import { dur } from './common';
import { DOCK_NAME } from './derive';
import { PIPELINE_STAGES, type Pipeline, type PipelineTruck, type StageKey } from './pipeline';

const ICON: Record<StageKey, LucideIcon> = {
  gate: LogIn,
  checkin: Scale,
  holding: SquareParking,
  queue: ListOrdered,
  dock: Warehouse,
  staging: Boxes,
  exit: LogOut,
};

export function TruckPipeline({
  pipe,
  now,
  waitMax,
  alerts,
  selected,
  onSelect,
}: {
  pipe: Pipeline;
  now: number;
  /** Waiting threshold of the event rules (min). */
  waitMax: number;
  alerts: Map<string, OpEvent>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const inPipe = PIPELINE_STAGES.reduce((a, st) => a + (st.key === 'staging' ? 0 : pipe.stages[st.key].length), 0) - pipe.due;
  return (
    <Panel
      title="Truck visit pipeline"
      subtitle={`Plant time ${formatClock(now)} · ${fmtInt(pipe.onSite)} on site past gate-in · ${fmtInt(inPipe - pipe.onSite)} at the gate before gate-in${pipe.due ? ` · ${pipe.due} due (scenario)` : ''} · from simulated visit records`}
      actions={<span className="tag sim">Simulated visits</span>}
      flush
    >
      <ol className="fv-pipe" aria-label="Truck stages">
        {PIPELINE_STAGES.map((st, i) => {
          const Icon = ICON[st.key];
          if (st.key === 'staging') return <StagingLane key={st.key} step={i + 1} pipe={pipe} onSelect={onSelect} selected={selected} />;
          const rows = pipe.stages[st.key];
          const due = rows.filter((r) => r.place.due).length;
          const count = rows.length - due;
          return (
            <li key={st.key} className="fv-stage" title={st.def}>
              <header>
                <span className="fv-step">{i + 1}</span>
                <Icon size={14} aria-hidden />
                <b>{st.label}</b>
                <span className={`fv-count ${count ? '' : 'zero'}`}>{count}</span>
              </header>
              <p className="fv-sub">
                {st.sub}
                {due > 0 && <span className="fv-due"> · +{due} due</span>}
              </p>
              <div className="fv-chips">
                {rows.length ? (
                  rows.map((r) => <TruckChip key={r.v.id} r={r} now={now} waitMax={waitMax} alert={alerts.get(r.v.id)} sel={selected === r.v.id} onSelect={onSelect} />)
                ) : (
                  <span className="fv-none">No trucks</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function TruckChip({ r, now, waitMax, alert, sel, onSelect }: { r: PipelineTruck; now: number; waitMax: number; alert?: OpEvent; sel: boolean; onSelect: (id: string) => void }) {
  const out = r.v.visit!.direction === 'outbound';
  const Dir = out ? ArrowUpFromLine : ArrowDownToLine;
  // Waiting is measured from arrival in holding, as the truck-waiting rule does.
  const waited = r.place.stage === 'queue' && r.v.queuedAt != null ? now - r.v.queuedAt : 0;
  const longWait = waited >= 0.8 * waitMax;
  return (
    <button
      className={`fv-chip ${sel ? 'sel' : ''} ${r.place.due ? 'due' : ''} ${r.v.visit!.scenarioId ? 'scn' : ''}`}
      onClick={() => onSelect(r.v.id)}
      aria-pressed={sel}
      title={`${r.v.id} · ${out ? 'outbound' : 'inbound'} · ${r.v.operator}${r.v.visit!.scenarioId ? ' · scenario' : ''}`}
    >
      <span className="l1">
        <Dir size={11} aria-label={out ? 'Outbound' : 'Inbound'} />
        <b className="mono">{r.v.id}</b>
        {r.place.queuePos != null && <span className="pos">#{r.place.queuePos}</span>}
        <span className="t">{r.inStage != null ? dur(r.inStage) : ''}</span>
      </span>
      <span className="l2">{r.place.status}</span>
      {alert ? (
        <span className="l3 warn">
          <TriangleAlert size={11} aria-hidden />
          {EVENT_TYPE_LABEL[alert.type]}
        </span>
      ) : longWait ? (
        <span className="l3 warn">
          <TriangleAlert size={11} aria-hidden />
          Waiting {dur(waited)} · threshold {waitMax} min
        </span>
      ) : null}
    </button>
  );
}

function StagingLane({ step, pipe, selected, onSelect }: { step: number; pipe: Pipeline; selected: string | null; onSelect: (id: string) => void }) {
  const st = PIPELINE_STAGES.find((x) => x.key === 'staging')!;
  const busy = pipe.forklifts.filter((f) => f.truckId).length;
  return (
    <li className="fv-stage staging" title={st.def}>
      <header>
        <span className="fv-step">{step}</span>
        <Boxes size={14} aria-hidden />
        <b>{st.label}</b>
        <span className={`fv-count ${pipe.loads.length ? '' : 'zero'}`} title="Outbound loads in progress">
          {pipe.loads.length}
        </span>
      </header>
      <p className="fv-sub">{st.sub} · loads in progress</p>
      <div className="fv-chips">
        {pipe.loads.length ? (
          pipe.loads.map((l) => (
            <button key={l.v.id} className={`fv-chip load ${selected === l.v.id ? 'sel' : ''}`} onClick={() => onSelect(l.v.id)} aria-pressed={selected === l.v.id}>
              <span className="l1">
                <b className="mono">{l.v.id}</b>
                <span className="t">{DOCK_NAME[l.dockId]}</span>
              </span>
              <span className="fv-meter" aria-hidden>
                <i style={{ width: `${(l.loaded / Math.max(1, l.load)) * 100}%` }} />
              </span>
              <span className="l2">
                {l.loaded} / {l.load} pallets · {l.forklifts.length ? l.forklifts.join(', ') : 'awaiting forklift'}
              </span>
            </button>
          ))
        ) : (
          <span className="fv-none">No load in progress</span>
        )}
      </div>
      <footer className="fv-lane-f">
        <span>
          {busy} of {pipe.forklifts.length} dispatch forklifts loading
        </span>
        <span>
          {fmtInt(pipe.palletsToLoad)} pallets to load · stock {fmtInt(pipe.stock)}
        </span>
      </footer>
    </li>
  );
}
