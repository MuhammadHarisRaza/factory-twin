/**
 * Root-cause view of the focused quality event: the event's suspected causes as hypotheses with
 * their confidence (confirmed only for observed facts or recorded scenario inputs), and the
 * correlation evidence that supports or weakens them. Correlation is shown as correlation — the
 * panel never states that something caused the defects.
 */
import { CircleCheck, CircleDashed, CircleHelp, FileText, FlaskConical } from 'lucide-react';
import type { MachineState, OpEvent } from '../../model/types';
import { openEquipment, openEvent } from '../../app/store';
import { DEFECTS, STAGE_BY_ID } from '../../model/plant';
import { EVENT_TYPE_LABEL, eventById, evidenceOf } from '../../sim/events';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDuration } from '../../sim/time';
import { LineChart } from '../../ui/kit/charts';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { Empty, Panel } from '../../ui/kit/Panel';
import { EventStatusBadge, MACHINE_STATE } from '../../ui/kit/Status';
import { PRODUCT_BY_SKU } from './lookup';
import { correlationEvidence, type Correlation } from './derive';

const CONF = {
  confirmed: { label: 'Confirmed', icon: CircleCheck, note: 'directly observed or a recorded scenario input' },
  likely: { label: 'Likely', icon: CircleHelp, note: 'inference supported by correlated evidence' },
  possible: { label: 'Possible', icon: CircleDashed, note: 'hypothesis to check' },
} as const;

const STATE_ORDER: MachineState[] = ['running', 'reduced', 'starved', 'blocked', 'down', 'planned'];

export function RootCause({ eventId, onFocus }: { eventId: string | null; onFocus: (id: string) => void }) {
  const d = useSimValue(
    (s) => {
      const ev = eventId ? eventById(s, eventId) : undefined;
      if (!ev) return null;
      const series = evidenceOf(s, ev).find((x) => x.kind === 'counter-series' && x.series?.[0]?.unit === '%')?.series?.[0] ?? null;
      return { ev, status: ev.status, corr: correlationEvidence(s, ev), series, rejectRateMax: s.rules.rejectRateMax };
    },
    [eventId],
  );
  if (!d) {
    return (
      <Panel title="Root-cause hypotheses" subtitle="Select a quality event">
        <Empty title="No quality event selected">Pick an event in the quality events table, or a record that belongs to one.</Empty>
      </Panel>
    );
  }
  const { ev, corr } = d;
  return (
    <Panel
      className="q-rc-panel"
      title="Root-cause hypotheses"
      subtitle={
        <>
          <span className="mono">{ev.id}</span> · {ev.title}
        </>
      }
      actions={<EventStatusBadge status={d.status} />}
      footer="Suspected causes are hypotheses. Confidence: confirmed = directly observed or a recorded scenario input; likely / possible = inferences to verify on the line. Correlation in time is not proof of a cause."
    >
      <div className="q-rc">
        <section>
          <h3>Suspected causes</h3>
          {ev.causes.length ? (
            <ol className="q-rc-causes">
              {ev.causes.map((c, i) => {
                const m = CONF[c.confidence];
                return (
                  <li key={i} className={`q-rc-cause ${c.confidence}`}>
                    <span className={`q-conf ${c.confidence}`} title={m.note}>
                      <m.icon size={12} aria-hidden /> {m.label}
                    </span>
                    <div>
                      <div className="q-rc-text">
                        {c.confidence === 'confirmed' ? '' : 'Hypothesis: '}
                        {c.text}
                      </div>
                      <div className="q-vd-sub">Basis: {c.basis}</div>
                      {c.relatedEventId && (
                        <button className="row-link mono" onClick={() => openEvent(c.relatedEventId!)} title="Open the related event's report">
                          <FileText size={12} /> {c.relatedEventId}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="muted">No cause suggested by the rules for this event.</p>
          )}
        </section>

        <section>
          <h3>Correlation evidence</h3>
          <p className="q-rc-window">
            Event window {formatClock(corr.from)} – {formatClock(corr.to)} ({formatDuration(corr.to - corr.from + 1)}) ·{' '}
            {corr.minuteResolution ? 'per-minute counters' : 'hourly counters (window older than the 4-hour minute log)'}
          </p>
          <MixTable corr={corr} />
          {d.series && d.series.t.length > 1 && (
            <div className="q-rc-chart">
              <div className="q-rc-k">{d.series.label} per 5 min, frozen with the event (%)</div>
              <LineChart
                labels={d.series.t.map((t) => formatClock(t))}
                series={[{ id: 'rate', label: d.series.label, color: 'var(--series-1)', points: d.series.v }]}
                format={(v) => `${v.toFixed(1)} %`}
                height={130}
                tickEvery={6}
                reference={ev.trigger.ruleId === 'Q-RATE' ? { value: d.rejectRateMax * 100, label: 'Rule threshold' } : undefined}
              />
            </div>
          )}
          <Machines corr={corr} />
          <Concurrent corr={corr} onFocus={onFocus} />
          {corr.batches.length > 0 && (
            <div className="q-rc-row">
              <span className="q-rc-k">Batches of the linked records</span>
              <span>
                {corr.batches.map((b) => (
                  <span key={b.id} className="q-rc-batch">
                    <span className="mono">{b.id}</span> <span className="dim">{PRODUCT_BY_SKU[b.sku]?.name ?? b.sku} · {b.records} rec.</span>
                  </span>
                ))}
              </span>
            </div>
          )}
          {corr.scenario && (
            <div className="q-rc-row">
              <span className="q-rc-k">Recorded input</span>
              <span>
                <span className="tag scenario">
                  <FlaskConical size={11} aria-hidden /> {corr.scenario.label}
                </span>{' '}
                <span className="dim">scenario active since {formatClock(corr.scenario.start)}</span>
              </span>
            </div>
          )}
        </section>
      </div>
    </Panel>
  );
}

function MixTable({ corr }: { corr: Correlation }) {
  if (!corr.mix.length) return <p className="muted">No rejects counted in the window.</p>;
  return (
    <table className="table q-rc-mix">
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
                <span className="sub">origin {STAGE_BY_ID[DEFECTS[r.d].origin].name}</span>
              </td>
              <td className="n">{fmtInt(r.n)}</td>
              <td className="n">
                {fmtPct(r.share, 0)}
                {up && <span className="sub">above its usual share</span>}
              </td>
              <td className="n">{fmtPct(r.refShare, 0)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Machines({ corr }: { corr: Correlation }) {
  if (!corr.origin) return null;
  const stage = STAGE_BY_ID[corr.origin];
  return (
    <div className="q-rc-row">
      <span className="q-rc-k">Origin stage · {stage.name}</span>
      <ul className="q-rc-machines">
        {corr.machines.map((m) => (
          <li key={m.id}>
            <button className="row-link mono" onClick={() => openEquipment(m.id)} title={`Open ${m.id} in the Factory Twin`}>
              {m.id}
            </button>
            {m.logged ? (
              <span className="dim">
                {STATE_ORDER.filter((st) => m.byState[st])
                  .map((st) => `${MACHINE_STATE[st].label.toLowerCase()} ${fmtPct(m.byState[st]! / m.logged, 0)}`)
                  .join(' · ')}
              </span>
            ) : (
              <span className="muted">state not in the 4-hour minute log</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Concurrent({ corr, onFocus }: { corr: Correlation; onFocus: (id: string) => void }) {
  if (!corr.origin) return null;
  const machines = STAGE_BY_ID[corr.origin].machines.join(', ');
  return (
    <div className="q-rc-row">
      <span className="q-rc-k">Concurrent events at the origin stage</span>
      {corr.concurrent.length ? (
        <ul className="q-rc-conc">
          {corr.concurrent.slice(0, 5).map((e: OpEvent) => (
            <li key={e.id}>
              <button className="row-link mono" onClick={() => (e.category === 'quality' ? onFocus(e.id) : openEvent(e.id))} title="Open the event's report">
                {e.id}
              </button>
              <span>{e.title}</span>
              <span className="dim">
                {EVENT_TYPE_LABEL[e.type]} · {formatClock(e.start)} · overlaps the window in time
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="muted">None — no stop, rate or condition event on {machines} overlapped the window.</span>
      )}
    </div>
  );
}
