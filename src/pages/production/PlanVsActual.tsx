import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatClock, shiftAt } from '../../sim/time';
import { LineChart, type LineSeries } from '../../ui/kit/charts';
import { fmtInt, pct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { cumulativeVsPlan, lastFullHour } from './derive';

/** Cumulative first-quality output vs the pro-rated plan, with the end-of-shift projection. */
export function PlanVsActual({ periodKey, className }: { periodKey: PeriodKey; className: string }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      return { p, c: cumulativeVsPlan(s, periodKey, p), hour: lastFullHour(s), shift: shiftAt(s.minute) };
    },
    [periodKey],
  );
  const { c, hour, shift } = d;
  const gap = Math.round(c.actualNowM2 - c.planNowM2);
  const series: LineSeries[] = [
    { id: 'actual', label: 'Actual', color: 'var(--series-1)', points: c.actual },
    { id: 'plan', label: 'Plan', color: 'var(--text-2)', points: c.plan, dashed: true },
  ];
  if (c.projectedEndM2 != null) series.push({ id: 'proj', label: `Projection to ${formatClock(c.end)}`, color: 'var(--series-1)', points: c.projection, dashed: true });

  const projText =
    c.projectedEndM2 != null && c.projectionRateM2h != null ? (
      <span>
        Projected at {formatClock(c.end)} ({shift.label.split(' · ')[0]} end): <b className="prod-strong">{fmtInt(c.projectedEndM2)} m²</b> vs plan{' '}
        {fmtInt(c.planEndM2)} m² ({c.planEndM2 > 0 ? pct(c.projectedEndM2 / c.planEndM2) : '—'}) at the shift-to-date rate of {fmtInt(c.projectionRateM2h)} m²/h.
      </span>
    ) : c.projects ? (
      <span>The end-of-shift projection starts after the first 15 minutes of the shift.</span>
    ) : (
      <span>Completed or rolling period — the end-of-shift projection is shown for the current shift and today.</span>
    );

  return (
    <Panel
      className={className}
      title="Planned vs actual production"
      subtitle={`Cumulative first-quality m² · ${d.p.label}`}
      actions={
        <span className={`prod-gap ${gap < 0 ? 'behind' : ''}`} title="Actual first-quality output minus the pro-rated plan, period to date">
          {gap >= 0 ? '+' : '−'}
          {fmtInt(Math.abs(gap))} m² vs plan
        </span>
      }
      footer={
        <div className="prod-foot">
          {projText}
          <span>
            Last full hour ({formatClock(hour.from)}): {fmtInt(hour.outputM2)} m² vs {fmtInt(hour.targetM2)} m² target. Output is counted per hour at
            sorting{c.step === 1 ? '; within an hour the line is interpolated' : '; 7-day view in hourly steps'}.
          </span>
        </div>
      }
    >
      <LineChart labels={c.labels} series={series} height={240} format={fmtInt} tickEvery={c.tickEvery} />
    </Panel>
  );
}
