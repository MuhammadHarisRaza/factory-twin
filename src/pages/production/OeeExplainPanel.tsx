import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { resolvePeriod, type PeriodKey } from '../../sim/metrics';
import type { Metric } from '../../sim/oee';
import { useSimValue } from '../../sim/store';
import { fmt1, fmtInt, fmtMetric, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { MetricText } from '../../ui/kit/Status';
import { oeeExplain } from './derive';

const min1 = (v: number) => `${fmt1(v)} min`;
const show = (m: Metric) => (m.status === 'ok' ? fmtMetric(m) : '—');

/**
 * The live OEE formula for the selected period with every underlying value, so the
 * figures in the summary band can be followed by hand.
 */
export function OeeExplainPanel({ periodKey, className }: { periodKey: PeriodKey; className: string }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      return { p, x: oeeExplain(s, p) };
    },
    [periodKey],
  );
  const { x } = d;
  const r = x.oee;
  const approx = x.rounding.applicable && !x.rounding.matches;

  const inputs: { k: string; v: ReactNode; note: string }[] = [
    {
      k: 'Planned production time',
      v: min1(x.plannedMin),
      note: x.plannedStopMin > 0 ? `${fmtInt(x.calendarMin)} min calendar − ${fmt1(x.plannedStopMin)} min planned stops` : `${fmtInt(x.calendarMin)} min calendar, no planned stops`,
    },
    { k: 'Operating time', v: min1(x.operatingMin), note: 'Kiln producing (not down, starved or blocked)' },
    { k: 'Ideal cycle time', v: `${x.idealCycleSec.toFixed(2)} s/tile`, note: `Kiln design rate ${fmtInt(x.idealRatePerHour)} tiles/h` },
    { k: 'Total count', v: `${fmtInt(x.totalCount)} tiles`, note: 'Fired at the kiln' },
    { k: 'Good count', v: `${fmtInt(x.good)} tiles`, note: `Accepted first time of ${fmtInt(x.sorted)} sorted` },
  ];

  return (
    <Panel
      className={className}
      title="How OEE is calculated"
      subtitle={`Line OEE · ${d.p.label} · underlying values update every simulated minute`}
      footer={
        <div className="prod-foot">
          <span>
            Simplified demonstration of OEE: availability and performance are measured at the line constraint (H-KILN roller kiln); quality is
            first-pass yield at sorting. Computed from simulated minute records.
          </span>
          <span>
            Percentages rounded to 0.1 %; OEE is computed from the unrounded components.
            {approx && ` ≈ marks a rounding difference: the rounded components multiply to ${fmtPct(x.rounding.productOfShown)}.`}
          </span>
          {r.issues.length > 0 && (
            <span className="prod-issues">
              <TriangleAlert size={12} aria-hidden /> {r.issues.join(' · ')}
            </span>
          )}
        </div>
      }
    >
      <dl className="prod-oee-inputs">
        {inputs.map((i) => (
          <div key={i.k}>
            <dt>{i.k}</dt>
            <dd>{i.v}</dd>
            <dd className="note">{i.note}</dd>
          </div>
        ))}
      </dl>

      <div className="prod-formula" role="table" aria-label="OEE calculation">
        <FormulaRow
          name="Availability"
          expr="Operating time ÷ planned production time"
          values={`${min1(x.operatingMin)} ÷ ${min1(x.plannedMin)}`}
          m={r.availability}
        />
        <FormulaRow
          name="Performance"
          expr="Ideal cycle time × total count ÷ operating time"
          values={`${x.idealCycleSec.toFixed(2)} s × ${fmtInt(x.totalCount)} tiles = ${min1(x.netRunMin)} ÷ ${min1(x.operatingMin)}`}
          m={r.performance}
        />
        <FormulaRow name="Quality" expr="Good count ÷ tiles sorted (first-pass yield)" values={`${fmtInt(x.good)} ÷ ${fmtInt(x.sorted)} tiles`} m={r.quality} />
        <FormulaRow
          name="OEE"
          expr="Availability × Performance × Quality"
          values={`${show(r.availability)} × ${show(r.performance)} × ${show(r.quality)}`}
          m={r.oee}
          approx={approx}
          total
        />
      </div>
    </Panel>
  );
}

function FormulaRow({ name, expr, values, m, approx = false, total = false }: { name: string; expr: string; values: string; m: Metric; approx?: boolean; total?: boolean }) {
  return (
    <div className={`prod-f-row ${total ? 'total' : ''}`} role="row">
      <span className="prod-f-name" role="rowheader">
        {name}
      </span>
      <span className="prod-f-calc" role="cell">
        <span className="prod-f-expr">{expr}</span>
        <span className="prod-f-values">{values}</span>
      </span>
      <span className="prod-f-res" role="cell" title={approx ? 'Differs from the product of the rounded components only by rounding' : undefined}>
        <span className="prod-f-eq" aria-hidden>
          {approx ? '≈' : '='}
        </span>
        <MetricText m={m} />
      </span>
    </div>
  );
}
