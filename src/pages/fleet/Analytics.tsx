/** Period analytics of Vehicle Monitoring: turnaround per visit (vs the rule threshold) and gate movements per hour. */
import { formatClock, formatDay } from '../../sim/time';
import { Empty, Panel } from '../../ui/kit/Panel';
import { ColumnChart, StackedColumns, TipRow, type ColumnDatum } from '../../ui/kit/charts';
import { fmtInt } from '../../ui/kit/format';
import { dur } from './common';
import type { completedVisits, hourlyGate } from './derive';

const PER_VISIT_MAX = 40;
const BUCKET = 15;
const minFmt = (v: number) => `${fmtInt(v)} min`;

export function TurnaroundChart({
  visits,
  threshold,
  periodLabel,
  onSelect,
}: {
  visits: ReturnType<typeof completedVisits>;
  /** Turnaround threshold of the event rules (min). */
  threshold: number;
  periodLabel: string;
  onSelect: (id: string) => void;
}) {
  const perVisit = visits.length <= PER_VISIT_MAX;
  const withT = visits.filter((x) => x.d.turnaround != null);
  let data: ColumnDatum[];
  if (perVisit) {
    data = withT.map(({ v, d }) => ({ key: v.id, label: v.id.slice(4), value: d.turnaround!, target: threshold, muted: v.visit!.direction === 'inbound' }));
  } else {
    const max = Math.max(...withT.map((x) => x.d.turnaround!));
    const n = Math.min(16, Math.max(1, Math.ceil((max + 0.001) / BUCKET)));
    const counts = Array.from({ length: n }, () => 0);
    for (const x of withT) counts[Math.min(n - 1, Math.floor(x.d.turnaround! / BUCKET))]++;
    data = counts.map((c, i) => ({
      key: String(i),
      label: i === n - 1 && max >= n * BUCKET ? `${i * BUCKET}+` : `${i * BUCKET}`,
      value: c,
    }));
  }
  const byId = new Map(visits.map((x) => [x.v.id, x]));
  const outbound = withT.filter((x) => x.v.visit!.direction === 'outbound').map((x) => x.d.turnaround!);
  const max = outbound.length ? Math.max(...outbound) : null;
  const over = withT.filter((x) => x.d.turnaround! >= threshold).length;
  return (
    <Panel
      title={perVisit ? 'Turnaround per visit' : 'Turnaround distribution'}
      subtitle={
        perVisit
          ? `Gate in → gate out, visits completed in ${periodLabel} · outbound solid, inbound faded · dashed = threshold ${threshold} min · click a bar to select`
          : `Visits per ${BUCKET}-min turnaround band · ${withT.length} visits in ${periodLabel}`
      }
      footer={
        <span>
          {max != null ? `Longest outbound visit ${dur(max)}` : 'No outbound visits completed in the period'} · {over} visit{over === 1 ? '' : 's'} at or above {threshold} min
        </span>
      }
    >
      {withT.length ? (
        perVisit ? (
          <ColumnChart
            data={data}
            height={190}
            format={minFmt}
            tickEvery={Math.max(1, Math.ceil(data.length / 14))}
            onSelect={(c) => onSelect(c.key)}
            tip={(c) => {
              const x = byId.get(c.key)!;
              return (
                <>
                  <b>
                    {x.v.id} · {x.v.visit!.direction === 'outbound' ? 'Outbound' : 'Inbound'}
                  </b>
                  <TipRow k="Carrier" v={x.v.operator} />
                  <TipRow k="Turnaround" v={dur(x.d.turnaround)} />
                  <TipRow k="Threshold" v={`${threshold} min`} />
                  <TipRow k="Waiting" v={dur(x.d.waiting)} />
                  <TipRow k={x.v.visit!.direction === 'outbound' ? 'Dock time' : 'Unloading'} v={dur(x.d.dockTime)} />
                  <TipRow k="Gate out" v={formatClock(x.v.visit!.gateOut!)} />
                </>
              );
            }}
          />
        ) : (
          <ColumnChart
            data={data}
            height={190}
            format={(v) => fmtInt(v)}
            tip={(c) => (
              <>
                <b>{c.label.endsWith('+') ? `${c.label} min` : `${c.label}–${Number(c.label) + BUCKET} min`}</b>
                <TipRow k="Visits" v={fmtInt(c.value)} />
              </>
            )}
          />
        )
      ) : (
        <Empty title="No visits completed in this period" />
      )}
    </Panel>
  );
}

export function GateChart({ gate, gateIn, gateOut, periodLabel }: { gate: ReturnType<typeof hourlyGate>; gateIn: number; gateOut: number; periodLabel: string }) {
  const multiDay = gate.hours.length > 30;
  return (
    <Panel title="Gate movements per hour" subtitle={`Gate-in and gate-out records · ${periodLabel}`} footer={<span>{fmtInt(gateIn)} in · {fmtInt(gateOut)} out in the period</span>}>
      {gate.hours.length ? (
        <StackedColumns
          labels={gate.hours.map((h) => (multiDay ? formatDay(h * 60) : formatClock(h * 60)))}
          series={[
            { key: 'in', label: 'Gate in', color: 'var(--series-1)' },
            { key: 'out', label: 'Gate out', color: 'var(--series-2)' },
          ]}
          values={gate.values}
          format={(v) => fmtInt(v)}
          tickEvery={multiDay ? 24 : gate.hours.length > 12 ? 2 : 1}
          height={190}
        />
      ) : (
        <Empty title="No hours in this period yet" />
      )}
    </Panel>
  );
}
