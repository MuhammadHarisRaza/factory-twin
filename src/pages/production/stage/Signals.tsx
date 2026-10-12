/**
 * 5. Signal trends of the stage's assets, configured per equipment type from SIGNALS: output rate from
 * the per-minute log (last 4 h), condition signals of condition-monitored assets (simulated sensors),
 * buffer levels from the buffer log. One chart per signal, one y-axis each. Signals without a kept
 * history are listed with their current value only.
 */
import { useState, type ReactNode } from 'react';
import { CONVEYOR_BY_ID, OPS_BY_ID, SIGNALS } from '../../../model/plant';
import type { MonitoredStage } from '../../../model/types';
import { HEALTH_BY_ID } from '../../../sim/health';
import { useSimValue } from '../../../sim/store';
import { formatClock } from '../../../sim/time';
import { LineChart, type RefLine } from '../../../ui/kit/charts';
import { DataTable, type Column } from '../../../ui/kit/DataTable';
import { fmt1, fmtInt } from '../../../ui/kit/format';
import { Disclosure, Unavailable } from '../../../ui/kit/Page';
import { Empty, Segmented } from '../../../ui/kit/Panel';
import { Block } from '../common';
import {
  bufferHistory,
  bufferName,
  conditionHistory,
  feedOf,
  rateHistory,
  signalRows,
  stageAssetIds,
  trendSignals,
  type SignalRow,
  type TrendSignal,
} from './derive';
import { FeedBadge } from './parts';

type Chart = { key: string; title: string; unit: string; signalId: string | null; t: number[]; v: (number | null)[]; ref: RefLine[]; yMax?: number; digits: number; tickEvery: number };

const hasSignals = (id: string) => SIGNALS.some((x) => x.equipmentId === id);

/** Units that are not physical (no unit suffix after the value). */
const NO_UNIT = new Set(['enum', 'code', 'zone id', 'in/out', 'pass/fail']);
export const PLACEHOLDER_REASON =
  'Not in the model: there is no physical (thermal / drying / pneumatic) model behind this process value, so it is listed without a value — any figure would be invented.';
export const ENERGY_REASON = 'Energy is not monitored in this product: the signal is configured for data provenance only and is listed without a value.';

export function SignalTrends({ ms }: { ms: MonitoredStage }) {
  const assets = stageAssetIds(ms).filter(hasSignals);
  const [picked, setPicked] = useState<string | null>(assets[0] ?? null);
  const id = picked && assets.includes(picked) ? picked : (assets[0] ?? null);

  const d = useSimValue(
    (s) => {
      const charts: Chart[] = [];
      const sigs: TrendSignal[] = id ? trendSignals(id) : [];
      const cond = id && sigs.some((x) => x.source === 'condition') ? conditionHistory(s, id) : null;
      for (const sig of sigs) {
        if (sig.source === 'minute-log') {
          const h = rateHistory(s, id!);
          const nominal = OPS_BY_ID[id!]?.idealRatePerHour ?? CONVEYOR_BY_ID[id!]?.capacityPerHour;
          charts.push({
            key: sig.signal.id,
            title: sig.label,
            unit: sig.unit,
            signalId: sig.signal.id,
            t: h.t,
            v: h.v,
            ref: nominal ? [{ value: nominal, label: `${OPS_BY_ID[id!]?.idealRatePerHour ? 'Ideal' : 'Capacity'} ${fmtInt(nominal)}/h` }] : [],
            digits: 0,
            tickEvery: 30,
          });
        } else if (sig.source === 'condition' && cond) {
          const a = HEALTH_BY_ID[id!];
          const name = sig.signal.name;
          const v = name === 'vibration' ? cond.vibration : name === 'temperature' ? cond.temperature : cond.current;
          const ref: RefLine[] =
            name === 'vibration'
              ? [
                  { value: a.vib.alarm, label: `Alarm ${a.vib.alarm}` },
                  { value: a.vib.trip, label: `Trip ${a.vib.trip}` },
                ]
              : name === 'temperature'
                ? [{ value: a.temp.alarm, label: `Alarm ${a.temp.alarm} °C` }]
                : [{ value: a.currentRated, label: `Rated ${a.currentRated} A` }];
          charts.push({ key: sig.signal.id, title: sig.label, unit: sig.unit, signalId: sig.signal.id, t: cond.t, v, ref, digits: name === 'vibration' ? 1 : 0, tickEvery: 15 });
        } else if (sig.source === 'buffer-log' && sig.bufferId) {
          const h = bufferHistory(s, sig.bufferId);
          charts.push({ key: sig.signal.id, title: sig.label, unit: '% full', signalId: sig.signal.id, t: h.t, v: h.v, ref: [], yMax: 100, digits: 0, tickEvery: 30 });
        }
      }
      // The stage's work-in-progress buffer, unless the selected asset already is that buffer.
      if (ms.wipBufferId && !sigs.some((x) => x.bufferId === ms.wipBufferId)) {
        const h = bufferHistory(s, ms.wipBufferId);
        charts.push({ key: `wip:${ms.wipBufferId}`, title: `Stage input buffer · ${bufferName(ms.wipBufferId)}`, unit: '% full', signalId: null, t: h.t, v: h.v, ref: [], yMax: 100, digits: 0, tickEvery: 30 });
      }
      return { charts, rows: id ? signalRows(s, id) : [], feed: id ? feedOf(s, id) : null };
    },
    [id, ms.id],
  );

  const withheld = d.rows.filter((r) => r.value == null).length;

  return (
    <Block
      title="Signal trends · last 4 h"
      subtitle="Configured per equipment type from the signal list · one chart per signal, one axis each"
      actions={
        assets.length > 1 ? (
          <Segmented label="Asset" value={id ?? ''} options={assets.map((a) => ({ value: a, label: a }))} onChange={(v) => setPicked(v)} />
        ) : undefined
      }
      note={
        <span>
          Rate: per-minute counter log (last 4 h). Condition signals: simulated sensors on the monitored component (named on each chart) with rule-based
          limits — no physical sensor is connected. Buffer level: per-minute level log. Process values without a physical model (kiln and dryer
          temperatures, powder moisture, pressures) are listed as “Not modelled” without a value; energy signals are not monitored in this product. A stale
          data feed leaves a gap from the moment it froze.
        </span>
      }
    >
      {!id ? (
        <Empty title="No configured signals at this stage" />
      ) : (
        <>
          <div className="stg-sig-head">
            <span>
              <span className="mono">{id}</span> <span className="muted">· {d.rows.length} configured signals</span>
            </span>
            {d.feed && <FeedBadge feed={d.feed} />}
          </div>
          {d.charts.length ? (
            <div className="stg-charts">
              {d.charts.map((c) => (
                <ChartBlock key={c.key} c={c} />
              ))}
            </div>
          ) : (
            <p className="muted stg-more">No signal of {id} keeps a history in this release — current values below.</p>
          )}
          <Disclosure title="All configured signals and current values" meta={`${d.rows.length} signals${withheld ? ` · ${withheld} without a value` : ''}`}>
            <div className="stg-sig-table">
              <SignalTable rows={d.rows} />
            </div>
          </Disclosure>
        </>
      )}
    </Block>
  );
}

const SIGNAL_COLUMNS: Column<SignalRow>[] = [
  { key: 'id', header: 'Signal id', render: (r) => <span className="mono">{r.id}</span> },
  { key: 'kind', header: 'Kind', render: (r) => <span className="muted">{r.kind}</span> },
  {
    key: 'value',
    header: 'Current value',
    numeric: true,
    render: (r) =>
      r.value == null ? (
        <Unavailable reason={r.basis === 'placeholder' ? PLACEHOLDER_REASON : ENERGY_REASON}>{r.valueLabel ?? 'Unavailable'}</Unavailable>
      ) : (
        <span className="num">
          {r.value} {!NO_UNIT.has(r.unit) && <span className="muted">{r.unit}</span>}
          {r.staleSince != null && <span className="muted"> · stale since {formatClock(r.staleSince)}</span>}
        </span>
      ),
  },
  { key: 'basis', header: 'Basis', render: (r) => <span className="muted">{r.basisLabel}</span> },
  {
    key: 'trend',
    header: 'History',
    render: (r) => <span className="muted">{r.value == null ? 'No value' : r.trend ? 'Charted above' : 'Current value only'}</span>,
  },
];

/** Every configured signal of an asset: value (withheld when there is no physical model), basis and history. */
export function SignalTable({ rows }: { rows: SignalRow[] }) {
  return <DataTable columns={SIGNAL_COLUMNS} rows={rows} rowKey={(r) => r.id} maxHeight={260} empty="No signals configured" />;
}

function ChartBlock({ c }: { c: Chart }) {
  const last = [...c.v].reverse().find((x) => x != null);
  const fmt = (v: number) => (c.digits ? fmt1(v) : fmtInt(v));
  const now: ReactNode = last != null ? `${fmt(last)} ${c.unit}` : 'no data';
  return (
    <section className="stg-chart">
      <header>
        <h3>
          {c.title} <span className="muted">({c.unit})</span>
        </h3>
        <span className="muted">
          Latest <b className="num">{now}</b>
        </span>
      </header>
      {c.signalId && <div className="mono muted stg-sig-id">{c.signalId}</div>}
      <LineChart
        labels={c.t.map(formatClock)}
        height={140}
        yMax={c.yMax}
        tickEvery={c.tickEvery}
        format={fmt}
        series={[{ id: c.key, label: c.title, color: 'var(--series-1)', points: c.v }]}
        reference={c.ref}
      />
    </section>
  );
}
