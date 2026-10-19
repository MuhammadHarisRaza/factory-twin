/**
 * Correlation evidence behind a quality event's hypotheses: the defect mix of the event window
 * against the 24 h before, the states of the modeled origin stage's machines, non-quality events
 * there that overlap in time, and the batches of the linked records. For a single record: the
 * machine states at the record's minute. Correlation is shown as correlation — it supports or
 * weakens a hypothesis and never establishes a cause.
 */
import type { MachineState, OpEvent } from '../../model/types';
import { openEquipment } from '../../app/store';
import { DEFECTS, STAGE_BY_ID } from '../../model/plant';
import { LOG_MIN } from '../../sim/engine';
import { EVENT_TYPE_LABEL } from '../../sim/events';
import { formatClock, formatDuration } from '../../sim/time';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { MACHINE_STATE, MachineStatus } from '../../ui/kit/Status';
import type { Correlation, StateAt } from './derive';
import { openCompare } from './compareFocus';
import { PRODUCT_BY_SKU } from './lookup';

const STATE_ORDER: MachineState[] = ['running', 'reduced', 'starved', 'blocked', 'down', 'planned'];

export function EventCorrelation({ corr, onOpenEvent }: { corr: Correlation; onOpenEvent: (e: OpEvent) => void }) {
  return (
    <div className="qd-corr">
      <p className="qd-note">
        Window {formatClock(corr.from)} – {formatClock(corr.to)} ({formatDuration(corr.to - corr.from + 1)}) ·{' '}
        {corr.minuteResolution ? 'per-minute counters' : `hourly counters (window older than the ${LOG_MIN / 60}-hour minute log)`}
      </p>
      {corr.mix.length ? (
        <table className="table qd-mix">
          <thead>
            <tr>
              <th>Category in the window</th>
              <th className="n">Rejects</th>
              <th className="n">Share</th>
              <th className="n" title="Share of rejects in the 24 h before detection">24 h before</th>
            </tr>
          </thead>
          <tbody>
            {corr.mix.slice(0, 5).map((r) => {
              const up = r.refShare != null && r.share > r.refShare * 1.3 && r.n > 0;
              return (
                <tr key={r.d}>
                  <td>
                    {DEFECTS[r.d].label}
                    {up && <span className="sub">above its usual share</span>}
                  </td>
                  <td className="n">{fmtInt(r.n)}</td>
                  <td className="n">{fmtPct(r.share, 0)}</td>
                  <td className="n">{fmtPct(r.refShare, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="muted">No rejects counted in the window.</p>
      )}
      {corr.origin && (
        <div className="qd-corr-row">
          <span className="qd-k">Machines of the modeled origin stage · {STAGE_BY_ID[corr.origin].name}</span>
          <ul className="qd-plain">
            {corr.machines.map((m) => (
              <li key={m.id}>
                <button type="button" className="row-link mono" onClick={() => openEquipment(m.id)} title={`Open ${m.id} in the Factory Twin`}>
                  {m.id}
                </button>{' '}
                {m.logged ? (
                  <span className="dim">
                    {STATE_ORDER.filter((st) => m.byState[st])
                      .map((st) => `${MACHINE_STATE[st].label.toLowerCase()} ${fmtPct(m.byState[st]! / m.logged, 0)}`)
                      .join(' · ')}
                  </span>
                ) : (
                  <span className="muted">state not in the {LOG_MIN / 60}-hour minute log</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {corr.origin && (
        <div className="qd-corr-row">
          <span className="qd-k">Events at the origin stage that overlap in time</span>
          {corr.concurrent.length ? (
            <ul className="qd-plain">
              {corr.concurrent.slice(0, 5).map((e) => (
                <li key={e.id}>
                  <button type="button" className="row-link mono" onClick={() => onOpenEvent(e)} title="Open the event's report">
                    {e.id}
                  </button>{' '}
                  {e.title} <span className="dim">· {EVENT_TYPE_LABEL[e.type]} · {formatClock(e.start)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">None — no stop, rate or condition event on {STAGE_BY_ID[corr.origin].machines.join(', ')} overlapped the window.</span>
          )}
        </div>
      )}
      {corr.batches.length > 0 && (
        <div className="qd-corr-row">
          <span className="qd-k">Batches of the linked records</span>
          <span>
            {corr.batches.map((b) => (
              <span key={b.id} className="qd-corr-batch">
                <button type="button" className="row-link mono" onClick={() => openCompare(b.id)} title={`Compare batch ${b.id} with the rest (Quality › Compare)`}>
                  {b.id}
                </button>{' '}
                <span className="dim">{PRODUCT_BY_SKU[b.sku]?.name ?? b.sku} · {b.records} rec.</span>
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/** Machine states at a record's minute (origin-stage machines and the sorting line). */
export function RecordStates({ states, time }: { states: StateAt[]; time: number }) {
  if (!states.some((x) => x.state != null)) return <p className="muted">Machine states at {formatClock(time)} are unavailable — the per-minute state log keeps the last {LOG_MIN / 60} hours only.</p>;
  return (
    <div className="qd-corr-row">
      <span className="qd-k">Machine states at {formatClock(time)}</span>
      <ul className="qd-plain">
        {states.map((x) => (
          <li key={x.id}>
            <button type="button" className="row-link mono" onClick={() => openEquipment(x.id)} title={`${x.role} — open ${x.id} in the Factory Twin`}>
              {x.id}
            </button>{' '}
            {x.state ? <MachineStatus state={x.state} /> : <span className="muted">not logged</span>} <span className="dim">· {x.role}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
