/**
 * Shift summary of a stage (current shift to date) and the shift report download. The PDF is built
 * from the same records by src/report/pdf.ts — this panel only summarises and triggers it.
 */
import { useState } from 'react';
import { FileDown, LoaderCircle } from 'lucide-react';
import { openEvent } from '../../app/store';
import type { AlertSeverity, MonitoredStage } from '../../model/types';
import { exportStageShiftPdf } from '../../report/pdf';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDuration } from '../../sim/time';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { SeverityBadge } from '../../ui/kit/Status';
import { m2, shiftSummary } from './derive';

const SEVERITIES: AlertSeverity[] = ['critical', 'serious', 'warning', 'info'];

export function ShiftPanel({ ms }: { ms: MonitoredStage }) {
  const d = useSimValue((s) => shiftSummary(s, ms), [ms.id]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { io } = d;
  const attainment = d.expected != null && d.expected > 0 && io.output != null ? io.output / d.expected : null;

  const download = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await exportStageShiftPdf(ms.id);
      setMsg({ ok: true, text: `Shift report for ${ms.id} generated at plant time ${formatClock(d.period.to)}.` });
    } catch (e) {
      setMsg({ ok: false, text: `The PDF could not be generated: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const sevs = SEVERITIES.filter((k) => d.bySeverity[k] > 0);
  const top = d.topLoss;

  return (
    <Panel
      title="Shift summary"
      subtitle={`${d.period.label} · ${formatDuration(d.elapsedMin)} elapsed`}
      actions={
        <button className="btn sm" onClick={download} disabled={busy} title="Stage shift report: I/O, equipment states, events and impact of this shift — the same records as in the app">
          {busy ? <LoaderCircle size={13} className="spin" aria-hidden /> : <FileDown size={13} aria-hidden />}
          Download shift report (PDF)
        </button>
      }
      footer={<span>Shift to date · simulated data · events are the same records as in Events &amp; Reports</span>}
    >
      <dl className="dl mon-dl">
        <dt>Output</dt>
        <dd>
          {io.output != null ? (
            <>
              <b className="num">{fmtInt(io.output)}</b> {io.unit}
              {d.expected != null && (
                <span className="muted">
                  {' '}
                  of {fmtInt(d.expected)} expected{attainment != null ? ` · ${fmtPct(attainment, 0)}` : ''}
                </span>
              )}
            </>
          ) : (
            <span className="mon-nm">Not measured</span>
          )}
        </dd>
        {ms.good && ms.rejected && (
          <>
            <dt>Good · rejected</dt>
            <dd>
              <span className="num">{fmtInt(io.good)}</span> · <span className="num">{fmtInt(io.rejected)}</span> {io.unit}
            </dd>
          </>
        )}
        <dt>Events</dt>
        <dd>
          <span className="num">{d.events.length}</span> in the shift · <span className="num">{d.raised.length}</span> detected in it ·{' '}
          <span className="num">{d.active.length}</span> active now
          {sevs.length > 0 && (
            <div className="mon-sevs">
              {sevs.map((k) => (
                <span key={k} className="mon-inline">
                  <SeverityBadge severity={k} />
                  <span className="num">{d.bySeverity[k]}</span>
                </span>
              ))}
              {d.resolved > 0 && <span className="muted">· {d.resolved} resolved</span>}
            </div>
          )}
        </dd>
        <dt>Largest asset loss</dt>
        <dd>
          {top ? (
            <>
              <span className="mono">{top.id}</span>{' '}
              {top.lostTiles != null ? (
                <span className="muted">
                  · {fmtInt(m2(top.lostTiles))} m² not made · {fmtInt(top.downMin)} min down
                </span>
              ) : (
                <span className="muted">· {fmtInt(top.downMin)} min stopped</span>
              )}
            </>
          ) : (
            <span className="muted">{ms.id === 'WH' ? 'No stop accounting at warehouse transfer' : 'No loss this shift'}</span>
          )}
        </dd>
        <dt>Reached the kiln</dt>
        <dd>
          {d.reachedConstraintMin > 0 ? (
            <>
              <span className="num">{fmtInt(d.reachedConstraintMin)}</span> min of kiln time held up by this stage’s events
            </>
          ) : (
            <span className="muted">{ms.id === 'WH' ? 'Downstream of the line — no effect on the kiln' : 'No loss of this stage held up the kiln'}</span>
          )}
        </dd>
        <dt>Scenarios</dt>
        <dd>
          {d.scenarios.length ? (
            <div className="mon-stack">
              {d.scenarios.map((sc) => (
                <span key={sc.id} className="mon-inline">
                  <span className="tag scenario">Simulated</span>
                  <span>{sc.label}</span>
                </span>
              ))}
            </div>
          ) : (
            <span className="muted">None in effect</span>
          )}
        </dd>
      </dl>
      {d.active.length > 0 && (
        <p className="mon-more">
          Most recent active:{' '}
          <button className="row-link" onClick={() => openEvent(d.active[0].id)} title="Open the event report">
            <span className="mono">{d.active[0].id}</span> {d.active[0].title}
          </button>
        </p>
      )}
      {msg && (
        <p className={`mon-msg ${msg.ok ? '' : 'err'}`} role="status">
          {msg.text}
        </p>
      )}
    </Panel>
  );
}
