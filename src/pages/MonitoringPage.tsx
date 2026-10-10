/**
 * Production Monitoring (use case 1): every monitored stage of the line — the process stages plus
 * warehouse transfer, from the configurable MONITORED_STAGES registry — with its equipment and
 * conveyor states, counted input / output, losses, signals, cameras and events.
 *
 * Overview (no stage selected) → stage detail (#/monitoring/<stage>). The period is the shared
 * header period; states and events are always "now". Nothing here keeps operational state: every
 * figure is derived from the one simulation (src/pages/monitoring/derive.ts).
 */
import { useEffect, useRef } from 'react';
import { Info, LoaderCircle } from 'lucide-react';
import { useApp } from '../app/store';
import { MONITORED_STAGE_BY_ID } from '../model/plant';
import { PERIOD_LABELS } from '../sim/metrics';
import { useSim } from '../sim/store';
import { Overview } from './monitoring/Overview';
import { StageDetail } from './monitoring/StageDetail';
import './monitoring.css';

export function MonitoringPage() {
  const period = useApp((s) => s.period);
  const stage = useApp((s) => s.monitoringStage);
  const resets = useSim((s) => s.resets);
  const resetting = useSim((s) => s.resetting);
  const ref = useRef<HTMLDivElement>(null);
  const ms = stage ? MONITORED_STAGE_BY_ID[stage] : null;

  // A new view starts at the top (the overview table can be scrolled far down when a row is picked).
  useEffect(() => {
    ref.current?.closest('.content')?.scrollTo({ top: 0 });
  }, [stage]);

  return (
    <div className="page mon" ref={ref}>
      <div className="toolbar-row">
        <div className="notice mon-notice" role="note">
          <Info size={14} aria-hidden />
          <span>
            <b>Simulated production data · counting points configurable per plant.</b> No PLC, SCADA or MES is connected; states, counts and
            events come from the simulation. Counts: {PERIOD_LABELS[period].toLowerCase()} · states and events: now.
          </span>
        </div>
        {resetting && (
          <span className="status neutral mon-resetting" role="status">
            <LoaderCircle size={13} className="spin" aria-hidden /> Resetting demo — rebuilding the seeded history…
          </span>
        )}
      </div>
      {ms ? <StageDetail key={`${ms.id}:${resets}`} stageId={ms.id} periodKey={period} /> : <Overview key={resets} periodKey={period} />}
    </div>
  );
}
