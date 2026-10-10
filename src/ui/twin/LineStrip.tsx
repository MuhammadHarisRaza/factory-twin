import { Fragment } from 'react';
import { Boxes, Check, Hourglass, LocateFixed, Truck, Warehouse, X } from 'lucide-react';
import { useTwin } from '../../store';
import { ZONE_BY_ID } from '../../data/layout';
import { DOCKS } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { fleetMetrics, resolvePeriod } from '../../sim/metrics';
import type { TruckRuntime } from '../../sim/logistics';
import { formatClock, formatDuration } from '../../sim/time';
import { MACHINE_STATE, OP_COLOR_HEX, machineColor } from '../kit/Status';
import { fmtInt, fmtPct } from '../kit/format';
import { currentStep, lineStatus, visitSteps, type LineStageStatus } from './derive';
import { useTip } from './Tip';

/** Process stages Raw → Warehouse as connected chips, coloured by the worst machine state. */
function StageStrip() {
  const selected = useTwin((s) => s.selected);
  const zone = useTwin((s) => s.zone);
  const data = useSimValue((s) => {
    const fm = fleetMetrics(s, resolvePeriod('shift', s.minute));
    return { ...lineStatus(s), stock: s.logistics.stockPallets, onSite: fm.onSite, waiting: fm.waiting };
  });
  const tip = useTip<string>();

  const locate = (st: LineStageStatus) => {
    tip.hide();
    const tw = useTwin.getState();
    if (st.focusId) tw.select(st.focusId);
    else tw.selectZone(st.def.zone);
  };

  return (
    <div className="tw-line overlay-panel" role="group" aria-label="Production line status by stage (simulated)">
      <span className="tw-strip-t">Line</span>
      <div className="tw-line-chips">
        {data.stages.map((st, i) => {
          const color = st.worst ? OP_COLOR_HEX[machineColor(st.worst)] : OP_COLOR_HEX.grey;
          const Icon = st.worst ? MACHINE_STATE[st.worst].icon : st.def.key === 'RAW' ? Boxes : Warehouse;
          const on = selected ? st.machines.some((m) => m.id === selected) : zone === st.def.zone;
          const stateLabel = st.worst ? MACHINE_STATE[st.worst].label : 'No machine state';
          return (
            <Fragment key={st.def.key}>
              {i > 0 && <span className="tw-conn" aria-hidden />}
              <button
                className={`tw-stage ${on ? 'on' : ''} ${st.bottleneck ? 'bn' : ''} ${st.worst ? '' : 'store'}`}
                style={{ ['--c' as string]: color }}
                onClick={() => locate(st)}
                aria-label={`${st.def.name}: ${stateLabel}${st.bottleneck ? ', current bottleneck' : ''}`}
                {...tip.bind(st.def.key, 'top')}
              >
                <Icon size={13} strokeWidth={2.3} aria-hidden />
                <span>{st.def.label}</span>
                {st.bottleneck && <Hourglass className="tw-bn-i" size={11} strokeWidth={2.4} aria-hidden />}
              </button>
            </Fragment>
          );
        })}
      </div>
      {tip.render((key) => {
        const st = data.stages.find((x) => x.def.key === key);
        if (!st) return null;
        const z = ZONE_BY_ID[st.def.zone];
        return (
          <>
            <b>
              {st.def.name} · Zone {z.id}
            </b>
            {st.machines.length ? (
              st.machines.map((m) => {
                const ms = MACHINE_STATE[m.state];
                const MIcon = ms.icon;
                return (
                  <div key={m.id} className="tw-tip-row">
                    <span className={`status ${ms.tone}`}>
                      <MIcon size={12} strokeWidth={2.3} aria-hidden />
                      {m.id} · {ms.label}
                    </span>
                    {m.reason && <span className="muted"> · {m.reason}</span>}
                  </div>
                );
              })
            ) : st.def.key === 'RAW' ? (
              <div className="tw-tip-row">Receiving & storage — no machine state modelled; raw-material supply is not a constraint in this simulation.</div>
            ) : (
              <div className="tw-tip-row">
                {fmtInt(data.stock)} pallets in stock · {data.onSite} trucks on site, {data.waiting} waiting — no machine state modelled.
              </div>
            )}
            {st.bottleneck && (
              <div className="tw-tip-row">
                <span className="tw-bn-note">
                  <Hourglass size={12} aria-hidden />
                  Current bottleneck · working {fmtPct(data.bottleneckShare, 0)} of planned time ({data.window.toLowerCase()})
                </span>
              </div>
            )}
            <div className="tw-tip-foot">Simulated · click to locate {st.focusId ? st.focusId : `zone ${z.id}`}</div>
          </>
        );
      })}
    </div>
  );
}

/** Milestones of the selected truck's visit with timestamps. */
function VisitStepper({ id }: { id: string }) {
  const follow = useTwin((s) => s.follow);
  const data = useSimValue(
    (s) => {
      const v = s.logistics.vehicles[id] as TruckRuntime | undefined;
      if (!v?.visit) return null;
      return { v, steps: visitSteps(s, v), now: s.minute };
    },
    [id],
  );
  if (!data) return null;
  const { v, steps, now } = data;
  const vis = v.visit!;
  const cur = currentStep(steps);
  const dock = vis.dockId ? DOCKS.find((d) => d.id === vis.dockId)?.name : null;
  const onSiteFor = vis.gateIn <= now ? (vis.gateOut ?? now) - vis.gateIn : null;
  return (
    <div className="tw-visit overlay-panel" role="group" aria-label={`Visit tracking for ${v.label} (simulated)`}>
      <div className="tw-visit-h">
        <Truck size={14} aria-hidden />
        <b>{v.label}</b>
        <span className="muted">
          {vis.direction === 'outbound' ? `Outbound · ${vis.load} pallets` : `Inbound · ${vis.load} t ${vis.material ?? ''}`}
          {dock ? ` · ${dock}` : ''} · {v.operator}
        </span>
        <span className="spacer" />
        {onSiteFor != null && <span className="muted num">{vis.gateOut != null ? 'Turnaround' : 'On site'} {formatDuration(onSiteFor)}</span>}
        <button
          className={`btn ghost sm icon ${follow ? 'on' : ''}`}
          onClick={() => useTwin.getState().setFollow(!follow)}
          title={follow ? 'Stop following' : 'Keep the camera on this truck'}
          aria-pressed={follow}
        >
          <LocateFixed size={13} />
        </button>
        <button className="btn ghost sm icon" onClick={() => useTwin.getState().selectVehicle(null)} title="Back to the line status (Esc)">
          <X size={14} />
        </button>
      </div>
      <ol className="tw-steps">
        {steps.map((st, i) => {
          const done = st.time != null;
          const active = i === cur;
          const since = active && i > 0 ? steps[i - 1].time : null;
          return (
            <li key={st.key} className={done ? 'done' : active ? 'cur' : ''} aria-current={active ? 'step' : undefined}>
              <span className="tw-step-dot" aria-hidden>
                {done ? <Check size={11} strokeWidth={3} /> : i + 1}
              </span>
              <span className="tw-step-x">
                <span className="tw-step-l">{st.label}</span>
                <span className="tw-step-t num">
                  {done ? formatClock(st.time!) : active ? (since != null ? `${formatDuration(now - since)} so far` : 'Next') : '—'}
                  {st.note && done ? <span className="muted"> · {st.note}</span> : null}
                </span>
              </span>
              {i < steps.length - 1 && <span className="tw-step-c" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Bottom-left strip: line status, or the visit stepper while a truck is selected. */
export function LineStrip() {
  const vehicle = useTwin((s) => s.vehicle);
  const isTruck = useSimValue((s) => (vehicle ? s.logistics.vehicles[vehicle]?.class === 'external' : false), [vehicle]);
  return vehicle && isTruck ? <VisitStepper id={vehicle} /> : <StageStrip />;
}
