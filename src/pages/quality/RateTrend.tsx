/**
 * The page's one trend chart. Question: is the reject rate rising, and which defect drives it?
 * Reject rate per hour (per 4 h over a week) for all defects, the rising (or most frequent)
 * category on the same scale, and the alert limit of the reject-rate rule.
 */
import { DEFECTS } from '../../model/plant';
import type { DefectCategory } from '../../model/types';
import { formatClock, formatDay } from '../../sim/time';
import { LineChart, type LineSeries } from '../../ui/kit/charts';
import { EmptyState, Section } from '../../ui/kit/Page';
import { inPeriod, type TrendPoint } from './investigate';

type Props = {
  points: TrendPoint[];
  bucketMin: number;
  limit: number;
  focus: { defect: DefectCategory; why: 'rising' | 'most frequent' } | null;
  periodLabel: string;
  /** The period runs to now, so its last bucket is still filling. */
  open: boolean;
};

const pct = (f: number, d = 1) => `${(f * 100).toFixed(d)} %`;

export function RateTrend({ points, bucketMin, limit, focus, periodLabel, open }: Props) {
  const wide = bucketMin >= 240;
  const labels = points.map((p) => (wide ? `${formatDay(p.start).split(' ')[0]} ${formatClock(p.start)}` : formatClock(p.start)));
  const series: LineSeries[] = [{ id: 'all', label: 'All defects', color: 'var(--series-1)', points: points.map((p) => (p.rate != null ? p.rate * 100 : null)) }];
  if (focus)
    series.push({
      id: focus.defect,
      label: `${DEFECTS[focus.defect].label} (${focus.why})`,
      color: 'var(--series-2)',
      points: points.map((p) => (p.focusRate != null ? p.focusRate * 100 : null)),
    });
  const last = [...points].reverse().find((p) => p.rate != null) ?? null;
  const any = points.some((p) => p.rate != null);
  return (
    <Section
      title={`Reject rate per ${wide ? '4 hours' : 'hour'}`}
      subtitle={`Is it rising, and which defect drives it? · ${periodLabel} · dashed line = alert limit of the reject-rate rule`}
    >
      {any ? (
        <>
          <LineChart
            labels={labels}
            series={series}
            height={190}
            format={(v) => `${v.toFixed(1)} %`}
            tickEvery={Math.max(1, Math.ceil(points.length / 9))}
            reference={{ value: limit * 100, label: `Alert limit ${pct(limit, 0)}` }}
          />
          {last && (
            <p className="qd-note">
              Latest {wide ? '4 hours' : 'hour'} ({labels[points.indexOf(last)]}
              {open && last === points[points.length - 1] ? ', in progress' : ''}): {pct(last.rate!, 2)} of {Math.round(last.inspected).toLocaleString('en-GB')} tiles inspected —{' '}
              {last.rate! > limit ? 'above' : 'within'} the {pct(limit, 0)} limit
              {focus && last.focusRate != null ? `; ${DEFECTS[focus.defect].label.toLowerCase()} ${pct(last.focusRate, 2)}` : ''}.
            </p>
          )}
        </>
      ) : (
        <EmptyState title="No inspection data in this period">The sorter has not inspected tiles {inPeriod(periodLabel)} yet.</EmptyState>
      )}
    </Section>
  );
}
