/** Where the shift is losing output: by downtime reason and by machine. */
import { ArrowRight } from 'lucide-react';
import { openEquipment, useApp } from '../../app/store';
import { downtimePareto, resolvePeriod } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { RankedBars } from '../../ui/kit/charts';
import { fmtInt } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { machineLosses } from './derive';

const TOP = 5;

export function ReasonLosses() {
  const go = useApp((s) => s.go);
  const d = useSimValue((s) => {
    const rows = downtimePareto(s, resolvePeriod('shift', s.minute));
    return { rows, total: rows.reduce((a, r) => a + r.minutes, 0) };
  });
  const top = d.rows.slice(0, TOP);
  return (
    <Panel
      title="Production losses"
      subtitle={`Unplanned downtime by reason · this shift · ${fmtInt(d.total)} min${d.rows.length > TOP ? ` · top ${TOP} of ${d.rows.length}` : ''}`}
      actions={
        <button type="button" className="btn ghost sm" onClick={() => go('production')} title="Open the downtime Pareto in OEE & Loss Intelligence">
          Pareto
          <ArrowRight size={12} aria-hidden />
        </button>
      }
      footer={<span>Own stops only — starved, blocked and planned time excluded. Minutes inside the current shift.</span>}
    >
      {top.length ? (
        <RankedBars
          rows={top.map((r) => ({
            key: r.key,
            label: (
              <span title={`${r.label} · ${r.category} · ${r.events} ${r.events === 1 ? 'event' : 'events'}`}>
                {r.label} <span className="dim">· {r.events}×</span>
              </span>
            ),
            value: r.minutes,
            cumulative: r.cumulative,
          }))}
          format={fmtInt}
          valueHeader="Min"
        />
      ) : (
        <div className="empty">
          <b>No unplanned downtime this shift</b>
        </div>
      )}
    </Panel>
  );
}

export function MachineLosses() {
  const d = useSimValue((s) => {
    const rows = machineLosses(s, resolvePeriod('shift', s.minute));
    return { rows, total: rows.reduce((a, r) => a + r.lostM2, 0) };
  });
  const top = d.rows.slice(0, TOP);
  return (
    <Panel
      title="Losses by machine"
      subtitle={`Output not made during own stops · this shift · ${fmtInt(d.total)} m²${d.rows.length > TOP ? ` · top ${TOP} of ${d.rows.length}` : ''} · click to locate`}
      footer={<span>Ideal-rate m² not produced while each machine was stopped; stops that began before the shift are pro-rated.</span>}
    >
      {top.length ? (
        <RankedBars
          labelHeader="Machine"
          valueHeader="Lost m²"
          showCumulative={false}
          rows={top.map((r) => ({
            key: r.id,
            label: (
              <span title={`${r.id} · ${r.name} · ${r.events} ${r.events === 1 ? 'stop' : 'stops'}, ${Math.round(r.minutes)} min${r.active ? ' · stopped now' : ''}`}>
                <span className="mono">{r.id}</span> <span className="dim">· {fmtInt(r.minutes)} min{r.active ? ' · down now' : ''}</span>
              </span>
            ),
            value: r.lostM2,
            share: d.total > 0 ? r.lostM2 / d.total : 0,
          }))}
          format={fmtInt}
          onSelect={(r) => openEquipment(r.key)}
        />
      ) : (
        <div className="empty">
          <b>No machine stops this shift</b>
        </div>
      )}
    </Panel>
  );
}
