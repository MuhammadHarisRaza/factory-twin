/** 4. Production trend of a stage: output per hour (or shift) vs the expected output for the period. */
import type { MonitoredStage } from '../../../model/types';
import { resolvePeriod, type PeriodKey } from '../../../sim/metrics';
import { useSimValue } from '../../../sim/store';
import { ColumnChart, LineChart, TipRow } from '../../../ui/kit/charts';
import { fmtInt, fmtPct } from '../../../ui/kit/format';
import { Empty } from '../../../ui/kit/Panel';
import { Block } from '../common';
import { outputStale } from '../../../ui/flow/derive';
import { MASS_DISCLOSURE } from '../units';
import { countUnit, stageTrend } from './derive';
import { StaleMark } from './parts';

const compact = (v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : fmtInt(v));

export function TrendPanel({ ms, periodKey }: { ms: MonitoredStage; periodKey: PeriodKey }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      return { p, ...stageTrend(s, ms, p), stale: outputStale(s, ms.id, p) };
    },
    [periodKey, ms.id],
  );
  const n = d.buckets.length;
  const tickEvery = n > 24 ? Math.ceil(n / 12) : n > 12 ? 2 : 1;
  const per = d.granularity === 'hour' ? 'hour' : 'shift';
  const isPallets = ms.unit === 'pallets';
  // Totals over the buckets with a measured output only (a bucket without one is not a zero).
  const totals = d.buckets.reduce((a, b) => (b.output == null ? a : { out: a.out + b.output, exp: a.exp + (b.expected ?? 0) }), { out: 0, exp: 0 });
  const gaps = d.buckets.filter((b) => b.output == null).length;
  const unit = countUnit(ms, ms.unit, ms.output.signalId);

  return (
    <Block
      title="Production trend"
      subtitle={
        isPallets
          ? `Pallets received vs dispatched per ${per} · ${d.p.label}`
          : `${ms.output.label} per ${per} vs expected · ${d.p.label}`
      }
      actions={
        !isPallets && (totals.exp > 0 || d.stale) ? (
          <>
            {d.stale && <StaleMark mark={d.stale} />}
            {totals.exp > 0 && (
              <span className="stg-chip-num" title="Period total, actual vs expected">
                {fmtInt(totals.out)} / {fmtInt(totals.exp)} {unit} · {fmtPct(totals.out / totals.exp, 0)}
              </span>
            )}
          </>
        ) : undefined
      }
      note={
        <span>
          {isPallets
            ? 'Received = palletised tiles ÷ tiles per pallet; dispatched = pallets on trucks at loading-complete.'
            : `Dashed step = expected output: ideal rate × planned running time of the stage’s last machines (planned stops excluded). Faded bars are partial buckets.${
                gaps ? ` ${gaps} bucket${gaps === 1 ? '' : 's'} without a measured output ${gaps === 1 ? 'is' : 'are'} left empty — not a zero.` : ''
              }${unit === 'tile-eq' ? ` Slip / powder counted in tile-equivalents (${MASS_DISCLOSURE} for t).` : ''}`}
        </span>
      }
    >
      {!n ? (
        <Empty title="No production time in this period yet" />
      ) : isPallets ? (
        <LineChart
          labels={d.buckets.map((b) => b.label)}
          height={210}
          tickEvery={tickEvery}
          format={(v) => fmtInt(v)}
          series={[
            { id: 'in', label: 'Pallets received from the wrapper', color: 'var(--series-1)', points: d.buckets.map((b) => b.input) },
            { id: 'out', label: 'Pallets dispatched', color: 'var(--series-2)', points: d.buckets.map((b) => b.output) },
          ]}
        />
      ) : (
        <ColumnChart
          height={210}
          tickEvery={tickEvery}
          format={compact}
          data={d.buckets.map((b) => ({ key: b.key, label: b.label, value: b.output ?? 0, target: b.expected ?? undefined, muted: b.partial || b.output == null }))}
          tip={(c) => {
            const b = d.buckets.find((x) => x.key === c.key)!;
            return (
              <>
                <b>
                  {b.tip}
                  {b.partial ? ' (partial)' : ''}
                </b>
                <TipRow k="Output" v={b.output != null ? `${fmtInt(b.output)} ${unit}` : 'Not measured'} swatch="var(--series-1)" />
                <TipRow k="Expected" v={b.expected != null ? `${fmtInt(b.expected)} ${unit}` : '—'} />
                {b.expected != null && b.expected > 0 && b.output != null && <TipRow k="Actual vs expected" v={fmtPct(b.output / b.expected, 0)} />}
                {b.input != null && <TipRow k="Input" v={`${fmtInt(b.input)} ${unit}`} />}
              </>
            );
          }}
        />
      )}
    </Block>
  );
}
