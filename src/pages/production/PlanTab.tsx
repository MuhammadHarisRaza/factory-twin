/**
 * Plan & flow (default tab): the five production KPIs, target vs actual and the output trend, the
 * stage flow with the constraint and its evidence, the largest production losses and the important
 * production events. Raw logs live in Analysis and Events & Reports, not here.
 */
import type { MouseEvent } from 'react';
import { ArrowDown, ArrowRight, FileText, Hourglass, Landmark } from 'lucide-react';
import { openEvent, useApp } from '../../app/store';
import { M2_PER_TILE } from '../../model/plant';
import type { PeriodKey } from '../../sim/metrics';
import { formatClock, formatDuration } from '../../sim/time';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { StateTimeline, type StateLegendItem } from '../../ui/kit/charts';
import { Disclosure, EmptyState, KpiCard, KpiRow, ProvenanceBadge } from '../../ui/kit/Page';
import { EventStatusBadge, OPERATIONAL_STATE, SeverityBadge, SourceTag, StatusBadge } from '../../ui/kit/Status';
import type { ProductionTab } from '../ProductionPage';
import { Block, kpiCardProps } from './common';
import { FinanceNote, LossCards } from './LossCards';
import type { ConstraintView, FlowRow, PlanData, ProductionEvent } from './plan';
import type { StateDistribution } from './states';
import { OutputTrend, PlanVsActual } from './PlanVsActual';
import { ActiveEvents, CauseText, ConstraintTag, Count, StaleMark } from './stage/parts';
import { countCell, rateShare } from './stage/derive';
import { openMaterialFlow, useProductionUi } from './ui';
import { NO_CALIBRATION } from './units';

/** Plan & flow; `d` is computed once per simulated minute by ProductionPage (planData). */
export function PlanTab({ periodKey, d, onTab }: { periodKey: PeriodKey; d: PlanData; onTab: (t: ProductionTab) => void }) {
  const editAssumptions = () => {
    useProductionUi.getState().setAnalysis('finance');
    onTab('analysis');
  };
  const [good, attain, rate, reject, downtime] = d.kpis;
  return (
    <>
      <KpiRow label="Production KPIs">
        <KpiCard {...kpiCardProps(good)} />
        <KpiCard {...kpiCardProps(attain)} />
        <KpiCard {...kpiCardProps(rate)} />
        <KpiCard {...kpiCardProps(reject)} onClick={() => useApp.getState().go('quality')} actionLabel="Open Quality & Defects" />
        <KpiCard {...kpiCardProps(downtime)} onClick={() => onTab('oee')} actionLabel="Open OEE & losses" />
      </KpiRow>

      <div className="prod-2col">
        <PlanVsActual periodKey={periodKey} />
        <OutputTrend periodKey={periodKey} />
      </div>

      <StageFlow flow={d.flow} cv={d.cv} periodLabel={d.p.label} />

      <StatesBlock d={d.states} periodLabel={d.p.label} />

      <div className="work">
        <Block
          title="Where output is lost"
          subtitle={`Largest losses at the kiln vs its design rate · ${d.p.label}`}
          note={
            <>
              <span>
                Losses are measured once, at the kiln (theoretical capacity = design rate × time); a stop elsewhere counts only for the minutes it held the kiln up. The plan
                already allows {fmtPct(d.allowance, 0)} of design capacity for normal losses
                {d.shortfallM2 > 0.5 ? `; good output is ${fmtInt(d.shortfallM2)} m² short of plan` : '; good output is at or above plan'}
                {d.lossStale ? ` (simulated running figures, not confirmed — ${d.lossStale}).` : '.'}
              </span>
              <FinanceNote onEdit={editAssumptions} />
            </>
          }
          actions={
            <>
              {d.lossStale && (
                <span className="prod-stale" title="The losses are the simulation's running accounting; the data feed has not confirmed them">
                  <ProvenanceBadge kind="stale" />
                  <span>Not confirmed · {d.lossStale}</span>
                </span>
              )}
              <button type="button" className="btn sm ghost" onClick={() => onTab('oee')}>
                OEE & losses <ArrowRight size={12} aria-hidden />
              </button>
            </>
          }
        >
          <LossCards items={d.losses} mode="capacity" empty="No loss against design capacity at the kiln in this period" />
          <Disclosure title="All capacity steps" meta={`theoretical ${fmtInt(d.cap.theoreticalM2)} m² → good ${fmtInt(d.cap.goodM2)} m²`}>
            <table className="table prod-steps">
              <thead>
                <tr>
                  <th>Step</th>
                  <th className="n">m²</th>
                  <th className="n">Share</th>
                  <th>Basis</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Theoretical capacity</td>
                  <td className="n">{fmtInt(d.cap.theoreticalM2)}</td>
                  <td className="n muted">100 %</td>
                  <td className="wrap prod-basis">Kiln design rate × calendar time — a ceiling, not a target</td>
                </tr>
                {d.cap.losses.map((l) => (
                  <tr key={l.key}>
                    <td>
                      {l.label}
                      {l.kind === 'transit' && <span className="muted"> · not a loss</span>}
                    </td>
                    <td className="n">
                      {l.m2 >= 0 ? '−' : '+'}
                      {fmtInt(Math.abs(l.m2))}
                    </td>
                    <td className="n muted">{d.cap.theoreticalM2 > 0 ? fmtPct(l.m2 / d.cap.theoreticalM2, 1) : '—'}</td>
                    <td className="wrap prod-basis">{l.basis}</td>
                  </tr>
                ))}
                <tr className="prod-subtotal">
                  <td>Good output</td>
                  <td className="n">{fmtInt(d.cap.goodM2)}</td>
                  <td className="n muted">{d.cap.theoreticalM2 > 0 ? fmtPct(d.cap.goodM2 / d.cap.theoreticalM2, 1) : '—'}</td>
                  <td className="wrap prod-basis">First-quality tiles accepted at sorting; the steps above close exactly to it</td>
                </tr>
              </tbody>
            </table>
          </Disclosure>
        </Block>
        <EventsBlock events={d.events} periodLabel={d.p.label} now={d.now} />
      </div>
    </>
  );
}

// ── Stage flow & constraint ──────────────────────────────────────────────────

/**
 * The constraint statement: the shared claim (its label, stage and sentence — the Overview's words),
 * then the supporting evidence (trace shares, buffers, event records). Amber only while the claim is
 * constraining output.
 */
function ConstraintCallout({ cv }: { cv: ConstraintView }) {
  const Icon = cv.constraining ? Hourglass : Landmark;
  const select = useApp((s) => s.selectStage);
  return (
    <div className={`prod-cv ${cv.constraining ? 'shifted' : 'agrees'}`}>
      <Icon size={18} aria-hidden className="prod-cv-ico" />
      <div className="prod-cv-b">
        <div className="prod-cv-h">
          <b>{cv.headline}</b>
          <span className="muted">· the kiln’s state now and the bottleneck trace of {cv.windowLabel} · simulated</span>
        </div>
        <p>{cv.statement}</p>
        {cv.evidence.length > 0 && (
          <>
            <span className="prod-cv-ev">Supporting evidence</span>
            <ul>
              {cv.evidence.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </>
        )}
        <div className="prod-cv-links">
          <button type="button" className="row-link" onClick={() => select(cv.named.monitored)}>
            Open {cv.constraint.name.toLowerCase()} <ArrowRight size={11} aria-hidden />
          </button>
          {cv.root?.eventIds[0] && (
            <button type="button" className="row-link" onClick={() => openEvent(cv.root!.eventIds[0])}>
              <FileText size={11} aria-hidden /> {cv.root.eventIds[0]} report
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function BufferCell({ r }: { r: FlowRow }) {
  if (r.row.ms.id === 'WH')
    return r.row.io.wip != null ? <span className="muted num">{fmtInt(r.row.io.wip)} pallets in stock</span> : <span className="stg-nm">Stock not measured</span>;
  const b = r.buffer;
  if (!b) return <span className="muted">No input buffer</span>;
  const open = (e: MouseEvent) => {
    e.stopPropagation();
    openMaterialFlow(b.id);
  };
  if (b.fill == null)
    return (
      <button type="button" className="row-link prod-buf" onClick={open} title={`${b.name}: ${b.effect} Open Material flow for this buffer.`}>
        <span className="stg-nm">Level not available</span>
      </button>
    );
  // Slip tanks and powder silos: a level percentage only — no level-to-mass calibration is configured.
  const qty = b.material ? `level % only (${NO_CALIBRATION.toLowerCase()})` : `${fmtInt(b.tiles)} of ${fmtInt(b.capacity)} tiles`;
  return (
    <button type="button" className="row-link prod-buf" onClick={open} title={`${b.name}: ${qty} · ${b.effect} Open Material flow for this buffer.`}>
      <span className="prod-buf-track" aria-hidden>
        <i style={{ width: `${Math.min(100, b.fill * 100)}%` }} />
      </span>
      <span className="num">{fmtPct(b.fill, 0)}</span>
      {b.trend && b.trend !== 'steady' && (
        <span className={`prod-trend ${b.trend}`}>
          {b.trend === 'filling' ? '▲' : '▼'} {b.trend}
        </span>
      )}
    </button>
  );
}

function StageFlow({ flow, cv, periodLabel }: { flow: FlowRow[]; cv: ConstraintView; periodLabel: string }) {
  const select = useApp((s) => s.selectStage);
  return (
    <Block
      title="Stage flow"
      subtitle={`Input → output per stage · ${periodLabel} · state, buffers and events now · select a stage for its detail`}
      actions={
        <button type="button" className="btn sm ghost" onClick={() => openMaterialFlow()} title="Rates in physical units, buffer levels, balance and starvation / blockage findings">
          Material flow <ArrowRight size={12} aria-hidden />
        </button>
      }
      note={
        <span>
          Counts come from each stage’s configured counting points; a quantity without one reads “Not measured”. Rate = actual output ÷ ideal rate × planned running
          time. Buffer = the stage’s input buffer level now (from its level signal) and its 60-minute trend — select it for
          Material flow; slip tanks and powder silos are level % only. All values simulated.
        </span>
      }
      flush
    >
      <ConstraintCallout cv={cv} />
      <div className="prod-flow" role="list" aria-label="Production stages in flow order">
        <div className="prod-flow-head" aria-hidden>
          <span>Stage</span>
          <span>State now</span>
          <span className="n">Input → output</span>
          <span className="n">Rate vs expected</span>
          <span>Input buffer</span>
          <span>Active events</span>
        </div>
        {flow.map((r, i) => {
          const { ms, io } = r.row;
          const st = r.row.state ? OPERATIONAL_STATE[r.row.state] : null;
          const share = rateShare(io);
          return (
            <div key={ms.id} role="listitem">
              {i > 0 && (
                <div className="prod-flow-link" aria-hidden>
                  <ArrowDown size={12} />
                </div>
              )}
              {/* The whole row opens the stage for pointer users; the stage name is the keyboard / screen-reader control. */}
              <div className={`prod-flow-row ${r.isClaim && cv.constraining ? 'claim' : ''}`} onClick={() => select(ms.id)}>
                <span className="prod-flow-name">
                  <span className="prod-step">{ms.step}</span>
                  <button
                    type="button"
                    className="prod-flow-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      select(ms.id);
                    }}
                    aria-label={`Open ${ms.name}: ${st ? st.label : 'no state signal'}${r.isClaim && cv.constraining ? ', currently constraining output' : r.isDesign ? ', modeled design constraint' : ''}`}
                  >
                    {ms.name}
                  </button>
                  <ConstraintTag row={r.row} />
                  {r.row.cause && (
                    <span className="prod-flow-cause">
                      <CauseText cause={r.row.cause} stop />
                    </span>
                  )}
                </span>
                <span>
                  {st ? <StatusBadge tone={st.tone} icon={st.icon} label={st.label} /> : <span className="muted">Counts only</span>}
                  {r.row.stale.length > 0 && (
                    <span className="muted prod-flow-sub" title="No new data from the asset's (simulated) feed: its state is unknown and its signal values are frozen at the last value received">
                      Feed stale: {r.row.stale.map((a) => `${a.id}${a.feed.since != null ? ` since ${formatClock(a.feed.since)}` : ''}`).join(', ')} · state unknown
                    </span>
                  )}
                </span>
                <span className="n prod-io">
                  <Count cell={countCell(ms, 'input', io)} compact />
                  <span className="muted" aria-hidden>
                    →
                  </span>
                  <Count cell={countCell(ms, 'output', io)} compact />
                  {r.row.staleMark && <StaleMark mark={r.row.staleMark} />}
                </span>
                <span className="n num">{share != null ? fmtPct(share, 0) : <span className="muted">—</span>}</span>
                <BufferCell r={r} />
                <span>
                  <ActiveEvents events={r.row.active} worst={r.row.worst} />
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Block>
  );
}

// ── Equipment-state distribution ─────────────────────────────────────────────

const STATE_LEGEND: StateLegendItem[] = [
  { state: 'running', label: OPERATIONAL_STATE.running.label, tone: 'good' },
  { state: 'reduced', label: OPERATIONAL_STATE.reduced.label, tone: 'warning', pattern: 'solid' },
  { state: 'starved', label: OPERATIONAL_STATE.starved.label, tone: 'warning', pattern: 'hatch' },
  { state: 'blocked', label: OPERATIONAL_STATE.blocked.label, tone: 'warning', pattern: 'dots' },
  { state: 'idle', label: OPERATIONAL_STATE.idle.label, tone: 'warning', pattern: 'hatch' },
  { state: 'fault', label: OPERATIONAL_STATE.fault.label, tone: 'critical', pattern: 'dots' },
  { state: 'stopped', label: OPERATIONAL_STATE.stopped.label, tone: 'critical', pattern: 'solid' },
  { state: 'changeover', label: OPERATIONAL_STATE.changeover.label, tone: 'planned', pattern: 'hatch' },
  { state: 'planned', label: OPERATIONAL_STATE.planned.label, tone: 'planned', pattern: 'solid' },
  { state: 'unknown', label: OPERATIONAL_STATE.unknown.label, tone: 'unknown', pattern: 'dots' },
  { state: 'disconnected', label: OPERATIONAL_STATE.disconnected.label, tone: 'unknown', pattern: 'hatch' },
];

/** Machines per state now and the time in each state over the period, with the machines' state timelines. */
function StatesBlock({ d, periodLabel }: { d: StateDistribution; periodLabel: string }) {
  const hours = (m: number) => (m >= 600 ? `${fmtInt(m / 60)} h` : formatDuration(m));
  return (
    <Block
      title="Equipment states"
      subtitle={`${d.machines} process machines · how many are in each state now and machine-time in state over ${periodLabel} · simulated`}
      note={
        <span>
          From each machine’s state timeline (state signal and stop records; minute log for the last hours). Time without a state record
          {d.unrecorded > 0.5 ? ` (${hours(d.unrecorded)} of machine-time here)` : ''} is shown as such, never as running. Shares are of the machine-time with a record.
        </span>
      }
    >
      <div className="prod-states-now" role="list" aria-label="Machines per state now">
        {d.now.map((x) => {
          const st = OPERATIONAL_STATE[x.state];
          return (
            <span key={x.state} role="listitem" className="prod-state-chip" title={x.ids.join(', ')}>
              <StatusBadge tone={st.tone} icon={st.icon} label={st.label} />
              <b className="num">{x.count}</b>
            </span>
          );
        })}
      </div>
      {d.period.length ? (
        <table className="table prod-states">
          <thead>
            <tr>
              <th>State · {periodLabel}</th>
              <th className="n">Machine-time</th>
              <th className="n">Share</th>
            </tr>
          </thead>
          <tbody>
            {d.period.map((x) => {
              const st = OPERATIONAL_STATE[x.state];
              return (
                <tr key={x.state}>
                  <td>
                    <StatusBadge tone={st.tone} icon={st.icon} label={st.label} />
                  </td>
                  <td className="n num">{hours(x.minutes)}</td>
                  <td className="n num">{fmtPct(x.share, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No state record in this period yet" />
      )}
      <Disclosure title="State timeline per machine" meta={`${d.lanes.length} lanes · ${formatClock(d.window.from)}–${formatClock(d.window.to)}`}>
        <StateTimeline label="Process machine states over the period" from={d.window.from} to={d.window.to} lanes={d.lanes} legend={STATE_LEGEND} laneHeight={12} />
      </Disclosure>
    </Block>
  );
}

// ── Important production events ──────────────────────────────────────────────

function EventsBlock({ events, periodLabel, now }: { events: { total: number; list: ProductionEvent[] }; periodLabel: string; now: number }) {
  const go = useApp((s) => s.go);
  return (
    <Block
      title="Important production events"
      subtitle={`${events.total} in ${periodLabel} · active and largest line impact first`}
      actions={
        <button type="button" className="btn sm ghost" onClick={() => go('events')}>
          All events <ArrowRight size={12} aria-hidden />
        </button>
      }
      note={<span>Root events only — knock-on starvation is part of its root. Kiln impact is the event engine’s accounting for the whole event (simulated).</span>}
      flush
    >
      {events.list.length ? (
        <ul className="prod-events">
          {events.list.map(({ ev, kilnMin, lostGoodTiles }) => (
            <li key={ev.id}>
              <button type="button" className="prod-event" onClick={() => openEvent(ev.id)} title={`${ev.id} — open the event report`}>
                <span className="prod-event-l1">
                  <SeverityBadge severity={ev.severity} />
                  <span className="prod-event-title">{ev.title}</span>
                </span>
                <span className="prod-event-l2">
                  <span className="mono">{ev.id}</span>
                  {ev.asset.equipmentId && <span className="mono">{ev.asset.equipmentId}</span>}
                  <span>
                    {formatClock(ev.start)}
                    {ev.end == null ? ` · active ${formatDuration(Math.max(0, now - ev.start))}` : ` · ${formatDuration(ev.end - ev.start)}`}
                  </span>
                  <EventStatusBadge status={ev.status} />
                  <SourceTag source={ev.source} />
                </span>
                <span className="prod-event-impact">
                  {kilnMin >= 0.5 ? (
                    <>
                      Held the kiln <b className="num">{formatDuration(kilnMin)}</b> · ≈ {fmtInt(lostGoodTiles * M2_PER_TILE)} m² good output
                    </>
                  ) : (
                    <span className="muted">No kiln hold-up recorded — absorbed by buffers or not a stop</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No production event in this period">Stops, conveyor stoppages and slowdowns raise events here when they happen.</EmptyState>
      )}
    </Block>
  );
}
