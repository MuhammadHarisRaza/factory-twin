import { OctagonX, Target, Truck } from 'lucide-react';
import { useApp } from '../app/store';
import { useSimValue } from '../sim/store';
import { fleetMetrics, lineMetrics, resolvePeriod } from '../sim/metrics';
import { useTwin } from '../store';
import { MetricText } from './kit/Status';
import { fmtPct } from './kit/format';

/**
 * Compact operational read-out over the twin (current shift, simulated): output against
 * target, line OEE, active stoppages (click to locate) and trucks on site.
 */
export function TwinStatusBar() {
  const data = useSimValue((s) => {
    const p = resolvePeriod('shift', s.minute);
    const lm = lineMetrics(s, p);
    const fm = fleetMetrics(s, p);
    return { lm, fm };
  });
  const go = useApp((s) => s.go);
  const stops = data.lm.activeStops;
  return (
    <div className="twin-status overlay-panel" role="status" aria-label="Current shift status (simulated)">
      <button onClick={() => go('production')} title="Open Production & OEE">
        <Target size={13} />
        <span className="muted">Shift output</span>
        <span className="num">{data.lm.attainment == null ? '—' : fmtPct(data.lm.attainment, 0)} of target</span>
      </button>
      <span className="sep" />
      <span>
        <span className="muted">Line OEE </span>
        <MetricText m={data.lm.oee.oee} />
      </span>
      <span className="sep" />
      <button
        onClick={() => stops[0] && useTwin.getState().select(stops[0].equipmentId)}
        disabled={!stops.length}
        title={stops.length ? `Locate ${stops.map((d) => d.equipmentId).join(', ')}` : 'No machine stopped'}
      >
        <span className={`status ${stops.length ? 'critical' : 'good'}`}>
          <OctagonX size={13} />
        </span>
        <span className="num">{stops.length ? `${stops.length} stopped · ${stops.map((d) => d.equipmentId).join(', ')}` : 'No stoppages'}</span>
      </button>
      <span className="sep" />
      <button onClick={() => go('fleet')} title="Open Fleet & Logistics">
        <Truck size={13} />
        <span className="num">
          {data.fm.onSite} on site · {data.fm.waiting} waiting
        </span>
      </button>
    </div>
  );
}
