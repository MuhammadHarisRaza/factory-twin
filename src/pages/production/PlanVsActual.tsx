import { ColumnChart, LineChart, TipRow, type LineSeries } from '../../ui/kit/charts';
import { fmtInt, pct } from '../../ui/kit/format';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatClock, shiftAt } from '../../sim/time';
import { outputStale } from '../../ui/flow/derive';
import { Block } from './common';
import { cumulativeVsPlan, granularityFor, lastFullHour, lineTrend } from './derive';
import { StaleMark } from './stage/parts';

/**
 * Target vs actual: cumulative good output against the cumulative plan over the period (the plan
 * does not accrue during planned kiln stops), with the end-of-shift projection at the shift-to-date rate.
 */
export function PlanVsActual({ periodKey }: { periodKey: PeriodKey }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      // Good output is counted at sorting: a stale sorting feed leaves the curve not confirmed (same mark as the KPIs).
      return { p, c: cumulativeVsPlan(s, periodKey, p), hour: lastFullHour(s), shift: shiftAt(s.minute), stale: outputStale(s, 'SORT', p) };
    },
    [periodKey],
  );
  const { c, hour, shift, stale } = d;
  const gap = Math.round(c.actualNowM2 - c.planNowM2);
  const series: LineSeries[] = [
    { id: 'actual', label: 'Good output (actual)', color: 'var(--series-1)', points: c.actual },
    { id: 'plan', label: 'Plan', color: 'var(--text-2)', points: c.plan, dashed: true },
  ];
  if (c.projectedEndM2 != null) series.push({ id: 'proj', label: `Projection to ${formatClock(c.end)}`, color: 'var(--series-1)', points: c.projection, dashed: true });

  const projText =
    c.projectedEndM2 != null && c.projectionRateM2h != null ? (
      <>
        Projected at {formatClock(c.end)} ({shift.label.split(' · ')[0]} end): <b>{fmtInt(c.projectedEndM2)} m²</b> vs plan {fmtInt(c.planEndM2)} m² (
        {c.planEndM2 > 0 ? pct(c.projectedEndM2 / c.planEndM2) : '—'}) at the shift-to-date rate of {fmtInt(c.projectionRateM2h)} m²/h — a straight-line projection, not a forecast.
      </>
    ) : c.projects ? (
      <>The end-of-shift projection starts after the first 15 minutes of the shift.</>
    ) : (
      <>Completed or rolling period — the projection is shown for the current shift and today.</>
    );

  return (
    <Block
      className="prod-pva"
      title="Target vs actual"
      subtitle={`Cumulative good output vs plan · m² · ${d.p.label}`}
      actions={
        <>
          {stale && <StaleMark mark={stale} />}
          <span className={`prod-gap ${gap < 0 && !stale ? 'behind' : ''}`} title={stale ? 'Simulated running good output minus the plan — not confirmed by the sorting feed' : 'Good output minus the plan, period to date'}>
            {gap >= 0 ? '+' : '−'}
            {fmtInt(Math.abs(gap))} m² vs plan{stale ? ' · not confirmed' : ''}
          </span>
        </>
      }
      note={
        <>
          <span>{projText}</span>
          <span>
            Plan = the target rate over planned production time; it pauses during planned kiln stops. Good output is counted per hour at sorting
            {c.step === 1 ? ' and interpolated within the hour' : ' (7-day view in hourly steps)'}. Last full hour ({formatClock(hour.from)}): {fmtInt(hour.outputM2)} m² vs {fmtInt(hour.targetM2)} m² plan.
          </span>
        </>
      }
    >
      <LineChart labels={c.labels} series={series} height={250} format={fmtInt} tickEvery={c.tickEvery} />
    </Block>
  );
}

/** Output trend: good output per hour (per shift over 7 days) against the plan for that bucket. */
export function OutputTrend({ periodKey }: { periodKey: PeriodKey }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const g = granularityFor(p);
      return { p, g, data: lineTrend(s, p, g), stale: outputStale(s, 'SORT', p) };
    },
    [periodKey],
  );
  const per = d.g === 'hour' ? 'hour' : 'shift';
  const behind = d.data.filter((b) => !b.partial && b.targetM2 > 0 && b.outputM2 < b.targetM2 * 0.97).length;
  const complete = d.data.filter((b) => !b.partial && b.targetM2 > 0).length;
  return (
    <Block
      title="Output trend"
      subtitle={`Good output per ${per} vs plan · m² · dashed = plan`}
      actions={
        d.stale || complete > 0 ? (
          <>
            {d.stale && <StaleMark mark={d.stale} />}
            {complete > 0 && <span className="prod-chip-num">{behind} of {complete} complete {per}s below 97 % of plan</span>}
          </>
        ) : undefined
      }
      note={<span>Faded bars are partial {per}s (still running or cut by the period). The plan per {per} excludes planned kiln stops.</span>}
    >
      <ColumnChart
        height={250}
        data={d.data.map((b) => ({ key: b.key, label: b.label, value: b.outputM2, target: b.targetM2, muted: b.partial }))}
        format={fmtInt}
        tickEvery={Math.max(1, Math.ceil(d.data.length / 8))}
        tip={(col) => {
          const b = d.data.find((x) => x.key === col.key)!;
          return (
            <>
              <b>
                {b.tip}
                {b.partial ? ' (partial)' : ''}
              </b>
              <TipRow k="Good output" v={`${fmtInt(b.outputM2)} m²`} swatch="var(--series-1)" />
              <TipRow k="Plan" v={`${fmtInt(b.targetM2)} m²`} />
              <TipRow k="Attainment" v={b.targetM2 > 0 ? pct(b.outputM2 / b.targetM2) : '—'} />
            </>
          );
        }}
      />
    </Block>
  );
}
