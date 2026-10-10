/** Current shift (to now) vs the previous complete shift. */
import type { ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';
import { useApp } from '../../app/store';
import type { LineMetrics } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatDuration } from '../../sim/time';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { MetricText } from '../../ui/kit/Status';
import { Panel } from '../../ui/kit/Panel';
import { shiftCompare } from './derive';

const oeeOf = (m: LineMetrics) => (m.oee.oee.status === 'ok' ? m.oee.oee.value : null);

/** Signed percentage-point difference; null when either side is missing. */
function Delta({ a, b, higherIsBetter = true }: { a: number | null; b: number | null; higherIsBetter?: boolean }) {
  if (a == null || b == null) return <span className="muted">—</span>;
  const d = (a - b) * 100;
  if (Math.abs(d) < 0.05) return <span className="dim">±0.0 pts</span>;
  const better = higherIsBetter ? d > 0 : d < 0;
  return <span className={better ? 'cc-better' : 'cc-worse'}>{`${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts`}</span>;
}

/** Downtime rate difference (min per shift hour); lower is better. */
function RateDelta({ cur, prev }: { cur: number; prev: number }) {
  const d = cur - prev;
  const title = `${cur.toFixed(1)} vs ${prev.toFixed(1)} min of downtime per shift hour`;
  if (Math.abs(d) < 0.05) return <span className="dim" title={title}>±0.0 min/h</span>;
  return (
    <span className={d < 0 ? 'cc-better' : 'cc-worse'} title={title}>
      {`${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} min/h`}
    </span>
  );
}

export function ShiftCompare() {
  const go = useApp((s) => s.go);
  const { current: c, previous: p } = useSimValue((s) => shiftCompare(s));
  const hours = (m: LineMetrics) => Math.max(1 / 60, (m.period.to - m.period.from) / 60);
  const rows: { k: string; cur: ReactNode; prev: ReactNode; delta: ReactNode }[] = [
    {
      k: 'Output',
      cur: `${fmtInt(c.outputM2)} m²`,
      prev: `${fmtInt(p.outputM2)} m²`,
      delta: <span className="muted" title="The current shift is still in progress; compare attainment instead">in progress</span>,
    },
    { k: 'Attainment', cur: fmtPct(c.attainment, 0), prev: fmtPct(p.attainment, 0), delta: <Delta a={c.attainment} b={p.attainment} /> },
    { k: 'OEE', cur: <MetricText m={c.oee.oee} />, prev: <MetricText m={p.oee.oee} />, delta: <Delta a={oeeOf(c)} b={oeeOf(p)} /> },
    {
      k: 'Unplanned downtime',
      cur: formatDuration(c.downtimeMin),
      prev: formatDuration(p.downtimeMin),
      delta: <RateDelta cur={c.downtimeMin / hours(c)} prev={p.downtimeMin / hours(p)} />,
    },
  ];
  return (
    <Panel
      title="Shift performance"
      subtitle={`${c.period.label} (to now) vs ${p.period.label}`}
      actions={
        <button type="button" className="btn ghost sm" onClick={() => go('production')} title="Open shift history in OEE & Loss Intelligence">
          History
          <ArrowRight size={12} aria-hidden />
        </button>
      }
      footer={<span>Current shift measured to now; its target is pro-rated to the elapsed time.</span>}
      flush
    >
      <table className="table">
        <thead>
          <tr>
            <th />
            <th className="n">Current</th>
            <th className="n">Previous</th>
            <th className="n">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}>
              <td className="dim">{r.k}</td>
              <td className="n">{r.cur}</td>
              <td className="n">{r.prev}</td>
              <td className="n">{r.delta}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
