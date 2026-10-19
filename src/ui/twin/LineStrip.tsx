import { Fragment } from 'react';
import { pureIcon } from '../kit/icon';
import { Boxes, Check, Hourglass, LocateFixed, Truck, Warehouse, X } from 'lucide-react';
import { useTwin } from '../../store';
import { ZONE_BY_ID } from '../../data/layout';
import { DOCKS } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { fleetMetrics, resolvePeriod } from '../../sim/metrics';
import type { TruckRuntime } from '../../sim/logistics';
import { formatClock, formatDuration } from '../../sim/time';
import { OPERATIONAL_STATE, OP_COLOR_HEX, toneToColor } from '../kit/Status';
import { fmtInt } from '../kit/format';
import type { OperationalState } from '../../model/types';
import type { ConstraintMarker } from './constraint';
import { LINE_STAGES, currentStep, lineStatus, visitSteps, worstOf, type AssetStatus, type LineConnector, type LineStageStatus } from './derive';
import { useTip } from './Tip';

/** Colour of an operational state in the four-state scheme (stopped / fault red, idle / blocked amber, planned / stale grey). */
const opColor = (op: OperationalState) => OP_COLOR_HEX[toneToColor(OPERATIONAL_STATE[op].tone)];

/** One machine or conveyor row in a tooltip: id, operational state, since, reason, stale feed. */
function AssetTipRow({ a }: { a: AssetStatus }) {
  const os = OPERATIONAL_STATE[a.op];
  const Icon = pureIcon(os.icon);
  return (
    <div className="tw-tip-row">
      <span className={`status ${os.tone}`}>
        <Icon size={12} strokeWidth={2.3} aria-hidden />
        {a.id} · {os.label}
      </span>
      <span className="muted">
        {a.staleSince != null ? ` · data stale since ${formatClock(a.staleSince)}` : a.op !== 'running' ? ` · since ${formatClock(a.since)}` : ''}
        {a.reason ? ` · ${a.reason}` : ''}
      </span>
    </div>
  );
}

/**
 * The constraint marker in a chip's tooltip, in the Overview's wording (constraintClaim): amber and
 * "currently constraining output" only with traced evidence, otherwise the neutral modeled design
 * constraint with the evidence behind it.
 */
function ConstraintTipRow({ c }: { c: ConstraintMarker }) {
  return (
    <div className="tw-tip-row">
      <span className={`tw-bn-note ${c.active ? 'active' : ''}`}>
        <Hourglass size={12} aria-hidden />
        {c.label}
      </span>
      <span className="muted"> · {c.sentence}</span>
    </div>
  );
}

type TipKey = `s:${string}` | `c:${string}`;

/**
 * Process stages Raw → Warehouse as chips coloured by the worst machine state, linked by the
 * conveyors that carry tiles between them (thin connectors coloured by the conveyor's state).
 * A stage chip highlights that production stage in the model and opens its panel (useTwin.stage,
 * shared with the Overview flow strip and Production); clicking the highlighted stage again clears it.
 */
function StageStrip() {
  const selected = useTwin((s) => s.selected);
  const zone = useTwin((s) => s.zone);
  const stage = useTwin((s) => s.stage);
  const data = useSimValue((s) => {
    const fm = fleetMetrics(s, resolvePeriod('shift', s.minute));
    return { ...lineStatus(s), stock: s.logistics.stockPallets, onSite: fm.onSite, waiting: fm.waiting };
  });
  const tip = useTip<TipKey>();

  const locate = (st: LineStageStatus) => {
    tip.hide();
    const tw = useTwin.getState();
    const m = st.def.monitored;
    if (!m) {
      // Raw materials: no production stage, show the receiving zone.
      tw.selectStage(null);
      tw.selectZone(st.def.zone);
      return;
    }
    if (tw.stage === m && !tw.selected && !tw.vehicle) {
      tw.selectStage(null);
      return;
    }
    if (tw.vehicle) tw.selectVehicle(null);
    if (tw.selected) tw.select(null);
    tw.selectStage(m);
  };
  const locateConveyor = (cn: LineConnector) => {
    tip.hide();
    const c = worstOf(cn.conveyors);
    if (c) useTwin.getState().select(c.id);
  };

  return (
    <div className="tw-line overlay-panel" role="group" aria-label="Production line status by stage and conveyor (simulated)">
      <span className="tw-strip-t">Line</span>
      <div className="tw-line-chips">
        {data.stages.map((st, i) => {
          const color = st.worst ? opColor(st.worst) : OP_COLOR_HEX.grey;
          const Icon = pureIcon(st.worst ? OPERATIONAL_STATE[st.worst].icon : st.def.key === 'RAW' ? Boxes : Warehouse);
          const on = selected
            ? st.machines.some((m) => m.id === selected) || st.conveyors.some((c) => c.id === selected)
            : stage
              ? st.def.monitored === stage
              : zone === st.def.zone;
          const stateLabel = st.worst ? OPERATIONAL_STATE[st.worst].label : 'No machine state';
          const cn = i > 0 ? data.connectors[i - 1] : null;
          const cw = cn?.conveyors.length ? worstOf(cn.conveyors) : null;
          return (
            <Fragment key={st.def.key}>
              {cn &&
                (cw ? (
                  <button
                    className={`tw-conn cv ${cn.conveyors.some((c) => c.id === selected) ? 'on' : ''} ${cw.op === 'unknown' ? 'stale' : ''} ${cw.op === 'stopped' || cw.op === 'fault' ? 'stop' : ''}`}
                    style={{ ['--c' as string]: opColor(cw.op) }}
                    onClick={() => locateConveyor(cn)}
                    aria-label={cn.conveyors.map((c) => `Conveyor ${c.id}: ${OPERATIONAL_STATE[c.op].label}`).join(', ')}
                    {...tip.bind(`c:${cn.key}`, 'top')}
                  />
                ) : (
                  <span className="tw-conn" aria-hidden />
                ))}
              <button
                className={`tw-stage ${on ? 'on' : ''} ${st.constraint ? `bn ${st.constraint.active ? 'active' : ''}` : ''} ${st.worst ? '' : 'store'}`}
                style={{ ['--c' as string]: color }}
                onClick={() => locate(st)}
                aria-label={`${st.def.name}: ${stateLabel}${st.constraint ? `, ${st.constraint.label.toLowerCase()}` : ''}${st.def.monitored ? (stage === st.def.monitored ? ' — highlighted, click to clear' : ' — click to highlight the stage') : ''}`}
                aria-pressed={st.def.monitored ? stage === st.def.monitored : undefined}
                {...tip.bind(`s:${st.def.key}`, 'top')}
              >
                <Icon size={13} strokeWidth={2.3} aria-hidden />
                <span>{st.def.label}</span>
                {st.constraint && <Hourglass className="tw-bn-i" size={11} strokeWidth={2.4} aria-hidden />}
              </button>
            </Fragment>
          );
        })}
      </div>
      {tip.render((key) => {
        if (key.startsWith('c:')) {
          const cn = data.connectors.find((x) => x.key === key.slice(2));
          if (!cn) return null;
          const from = LINE_STAGES.find((x) => x.key === cn.from)!;
          const to = LINE_STAGES.find((x) => x.key === cn.to)!;
          return (
            <>
              <b>{cn.conveyors.map((c) => c.name).join(' · ')}</b>
              <div className="tw-tip-row">
                Conveyor · {from.name} → {to.name}
              </div>
              {cn.conveyors.map((c) => (
                <AssetTipRow key={c.id} a={c} />
              ))}
              <div className="tw-tip-foot">Simulated · click to inspect {cn.conveyors.map((c) => c.id).join(', ')}</div>
            </>
          );
        }
        const st = data.stages.find((x) => x.def.key === key.slice(2));
        if (!st) return null;
        const z = ZONE_BY_ID[st.def.zone];
        return (
          <>
            <b>
              {st.def.name} · Zone {z.id}
            </b>
            {st.machines.length ? (
              st.machines.map((m) => <AssetTipRow key={m.id} a={m} />)
            ) : st.def.key === 'RAW' ? (
              <div className="tw-tip-row">Receiving & storage — no machine state modelled; raw-material supply is not a constraint in this simulation.</div>
            ) : (
              <div className="tw-tip-row">
                {fmtInt(data.stock)} pallets in stock · {data.onSite} trucks on site, {data.waiting} waiting — no machine state modelled.
              </div>
            )}
            {st.conveyors.map((c) => (
              <AssetTipRow key={c.id} a={c} />
            ))}
            {st.constraint && <ConstraintTipRow c={st.constraint} />}
            <div className="tw-tip-foot">
              Simulated · {st.def.monitored ? (stage === st.def.monitored ? 'click to clear the highlight' : 'click to highlight the stage in the model') : `click to show zone ${z.id}`}
            </div>
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
