/**
 * 5. Signal trends of the stage's assets over a chosen time range (TimeRange: 15 min / 1 h / 8 h / 24 h / 7 days),
 * read through the telemetry boundary (src/sim/telemetry.ts seriesOf): output rate (t/h for slip / powder — a
 * disclosed conversion of tile-equivalents — tiles/h after pressing), condition signals of condition-monitored assets
 * (simulated sensors), buffer levels, and the process model's values with their setpoints. One chart per signal, one
 * axis each; gaps are gaps. Below, the asset's signal table from the catalogue with search, category filter, quality,
 * age and the catalogue's availability class / status per row.
 */
import { useState } from 'react';
import { Search } from 'lucide-react';
import { SIGNAL_CATEGORY_LABEL, type SignalCategory } from '../../../model/catalog';
import { BUFFER_LEVEL_SIGNAL, CONVEYOR_BY_ID, OPS_BY_ID, SIGNALS } from '../../../model/plant';
import { RANGE_BY_KEY, type RangeKey } from '../../../model/telemetry';
import type { MonitoredStage } from '../../../model/types';
import type { SimState } from '../../../sim/engine';
import { HEALTH_BY_ID } from '../../../sim/health';
import { useSimValue } from '../../../sim/store';
import { seriesOf } from '../../../sim/telemetry';
import { formatClock, formatDuration } from '../../../sim/time';
import { TimeSeriesChart, type TimeRefLine, type TimeSeries } from '../../../ui/kit/charts';
import { DataTable, type Column } from '../../../ui/kit/DataTable';
import { fmt1, fmtInt } from '../../../ui/kit/format';
import { Disclosure, Unavailable } from '../../../ui/kit/Page';
import { Empty, Segmented } from '../../../ui/kit/Panel';
import { TimeRange } from '../../../ui/kit/TimeRange';
import { Block } from '../common';
import { MASS_DISCLOSURE, isMaterialAsset, massFlowSignalOf, tileEqToT } from '../units';
import { bufferName, feedOf, filterSignalRows, processCharts, rowCategories, signalRows, stageAssetIds, trendSignals, type SignalRow } from './derive';
import { FeedBadge } from './parts';

type Chart = {
  key: string;
  title: string;
  unit: string;
  signalId: string | null;
  from: number;
  to: number;
  series: TimeSeries[];
  ref: TimeRefLine[];
  yMin?: number;
  yMax?: number;
  digits: number;
  note?: string;
};

const hasSignals = (id: string) => SIGNALS.some((x) => x.equipmentId === id);

/** Units that are not physical (no unit suffix after the value). */
const NO_UNIT = new Set(['enum', 'code', 'zone id', 'in/out', 'pass/fail', '']);
export const PLACEHOLDER_REASON =
  'Not in the model: there is no physical (thermal / drying / pneumatic) model behind this process value, so it is listed without a value — any figure would be invented.';
export const ENERGY_REASON = 'Energy is not monitored in this product: the signal is configured for data provenance only and is listed without a value.';

/** A numeric signal over the range; a counter is differenced into a per-hour rate (a reset or a gap → null). Factor converts units. */
function line(s: SimState, signalId: string, range: RangeKey, opts: { counter?: boolean; factor?: number } = {}) {
  const ser = seriesOf(s, signalId, range);
  if (!ser) return null;
  const f = opts.factor ?? 1;
  const v = opts.counter
    ? ser.v.map((x, i) => {
        const prev = i > 0 ? ser.v[i - 1] : null;
        return x == null || prev == null || x < prev ? null : ((x - prev) * 60 * f) / ser.stepMin;
      })
    : ser.v.map((x) => (x == null ? null : x * f));
  return { t: ser.t, v, note: ser.note, step: ser.stepMin };
}

/** The charts of one asset (and the stage's input buffer) over a range. */
export function signalCharts(s: SimState, ms: MonitoredStage, id: string, range: RangeKey): Chart[] {
  const r = RANGE_BY_KEY[range];
  const to = s.minute;
  const from = s.minute - r.minutes;
  const charts: Chart[] = [];
  const push = (c: Omit<Chart, 'from' | 'to'>) => charts.push({ ...c, from, to });
  const material = isMaterialAsset(id);
  for (const sig of trendSignals(id)) {
    if (sig.source === 'minute-log') {
      const nominal = OPS_BY_ID[id]?.idealRatePerHour ?? CONVEYOR_BY_ID[id]?.capacityPerHour ?? null;
      const counter = sig.signal.name === 'tile_count';
      if (material) {
        // Slip / powder: t/h — the simulated mass flow when the asset has one, else its tile-equivalents converted.
        const mass = massFlowSignalOf(id);
        const l = mass ? line(s, mass, range) : line(s, sig.signal.id, range, { counter, factor: tileEqToT(1)! });
        if (!l) continue;
        push({
          key: sig.signal.id,
          title: counter ? 'Material transported (dry-body equivalent)' : 'Output rate (dry-body equivalent)',
          unit: 't/h',
          signalId: mass ?? sig.signal.id,
          series: [{ id: sig.signal.id, label: 'Rate', t: l.t, v: l.v, color: 'var(--series-1)' }],
          ref: nominal ? [{ value: tileEqToT(nominal)!, label: `${OPS_BY_ID[id]?.idealRatePerHour ? 'Ideal' : 'Capacity'} ${fmt1(tileEqToT(nominal))} t/h`, kind: 'limit' }] : [],
          yMin: 0,
          digits: 1,
          note: [MASS_DISCLOSURE, l.note].filter(Boolean).join(' · '),
        });
      } else {
        const l = counter ? line(s, sig.signal.id, range, { counter: true }) : line(s, sig.signal.id, range);
        if (!l) continue;
        push({
          key: sig.signal.id,
          title: sig.label,
          unit: 'tiles/h',
          signalId: sig.signal.id,
          series: [{ id: sig.signal.id, label: sig.label, t: l.t, v: l.v, color: 'var(--series-1)' }],
          ref: nominal ? [{ value: nominal, label: `${OPS_BY_ID[id]?.idealRatePerHour ? 'Ideal' : 'Capacity'} ${fmtInt(nominal)}/h`, kind: 'limit' }] : [],
          yMin: 0,
          digits: 0,
          note: l.note,
        });
      }
    } else if (sig.source === 'condition') {
      const l = line(s, sig.signal.id, range);
      const a = HEALTH_BY_ID[id];
      if (!l || !a) continue;
      const name = sig.signal.name;
      const ref: TimeRefLine[] =
        name === 'vibration'
          ? [
              { value: a.vib.alarm, label: `Alarm ${a.vib.alarm}`, kind: 'warning' },
              { value: a.vib.trip, label: `Trip ${a.vib.trip}`, kind: 'alarm' },
            ]
          : name === 'temperature'
            ? [{ value: a.temp.alarm, label: `Alarm ${a.temp.alarm} °C`, kind: 'alarm' }]
            : [{ value: a.currentRated, label: `Rated ${a.currentRated} A`, kind: 'limit' }];
      push({ key: sig.signal.id, title: sig.label, unit: sig.unit, signalId: sig.signal.id, series: [{ id: sig.signal.id, label: sig.label, t: l.t, v: l.v, color: 'var(--series-1)' }], ref, digits: name === 'vibration' ? 1 : 0, note: l.note });
    } else if (sig.source === 'buffer-log' && sig.bufferId) {
      const l = line(s, sig.signal.id, range);
      if (!l) continue;
      push({ key: sig.signal.id, title: sig.label, unit: '%', signalId: sig.signal.id, series: [{ id: sig.signal.id, label: 'Level', t: l.t, v: l.v, color: 'var(--series-1)' }], ref: [], yMin: 0, yMax: 100, digits: 0, note: l.note });
    }
  }
  // Process model: each PV with its setpoint (dashed step) and the catalogue's warning / alarm limits.
  for (const pc of processCharts(id)) {
    const pv = line(s, pc.pv, range);
    if (!pv) continue;
    const sp = pc.sp ? line(s, pc.sp, range) : null;
    const series: TimeSeries[] = [{ id: pc.pv, label: 'Process value', t: pv.t, v: pv.v, color: 'var(--series-1)' }];
    if (sp) series.push({ id: pc.sp!, label: 'Setpoint', t: sp.t, v: sp.v, color: 'var(--accent)', dashed: true, step: true });
    const ref: TimeRefLine[] = [];
    if (pc.alarmHigh != null) ref.push({ value: pc.alarmHigh, label: `Alarm high ${pc.alarmHigh}`, kind: 'alarm' });
    if (pc.alarmLow != null) ref.push({ value: pc.alarmLow, label: `Alarm low ${pc.alarmLow}`, kind: 'alarm' });
    push({ key: pc.pv, title: pc.label, unit: pc.unit, signalId: pc.pv, series, ref, digits: Math.min(1, pc.digits), note: pv.note });
  }
  // The stage's work-in-progress buffer, unless the selected asset already carries that buffer's level.
  const wipSig = ms.wipBufferId ? BUFFER_LEVEL_SIGNAL[ms.wipBufferId] : null;
  if (ms.wipBufferId && wipSig && !charts.some((c) => c.signalId === wipSig)) {
    const l = line(s, wipSig, range);
    if (l)
      push({
        key: `wip:${ms.wipBufferId}`,
        title: `Stage input buffer · ${bufferName(ms.wipBufferId)}`,
        unit: '%',
        signalId: wipSig,
        series: [{ id: wipSig, label: 'Level', t: l.t, v: l.v, color: 'var(--series-1)' }],
        ref: [],
        yMin: 0,
        yMax: 100,
        digits: 0,
        note: l.note,
      });
  }
  return charts;
}

export function SignalTrends({ ms }: { ms: MonitoredStage }) {
  const assets = stageAssetIds(ms).filter(hasSignals);
  const [picked, setPicked] = useState<string | null>(assets[0] ?? null);
  const [range, setRange] = useState<RangeKey>('8h');
  const id = picked && assets.includes(picked) ? picked : (assets[0] ?? null);

  const d = useSimValue(
    (s) => ({ charts: id ? signalCharts(s, ms, id, range) : [], rows: id ? signalRows(s, id) : [], feed: id ? feedOf(s, id) : null }),
    [id, ms.id, range],
  );

  const withheld = d.rows.filter((r) => r.value == null).length;

  return (
    <Block
      title="Signal trends"
      subtitle={`${RANGE_BY_KEY[range].label} · configured per equipment type from the signal catalogue · one chart per signal, one axis each`}
      actions={
        <>
          {assets.length > 1 && <Segmented label="Asset" value={id ?? ''} options={assets.map((a) => ({ value: a, label: a }))} onChange={(v) => setPicked(v)} />}
          <TimeRange value={range} onChange={setRange} label="Signal chart range" />
        </>
      }
      note={
        <span>
          15 min and 1 h: minute data; 8 h: 5-min steps; 24 h and 7 days: hourly means. Rates of slip and powder are dry-body equivalents in t/h ({MASS_DISCLOSURE}). Condition
          signals: simulated sensors on the monitored component (named on each chart) — no physical sensor is connected. Process values come from the simulated process
          model with their setpoints; values without a model are listed as “Not modelled” without a value; energy is not monitored in this product. A stale or bad sample is a
          gap, never a zero.
        </span>
      }
    >
      {!id ? (
        <Empty title="No configured signals at this stage" />
      ) : (
        <>
          <div className="stg-sig-head">
            <span>
              <span className="mono">{id}</span> <span className="muted">· {d.rows.length} catalogued signals</span>
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
          <Disclosure title="All catalogued signals and current values" meta={`${d.rows.length} signals${withheld ? ` · ${withheld} without a value` : ''}`}>
            <div className="stg-sig-table">
              <SignalTable rows={d.rows} />
            </div>
          </Disclosure>
        </>
      )}
    </Block>
  );
}

const QUALITY_LABEL: Record<NonNullable<SignalRow['quality']>, string> = { good: 'Good', uncertain: 'Uncertain', bad: 'Bad', stale: 'Stale', missing: 'Missing' };

const SIGNAL_COLUMNS: Column<SignalRow>[] = [
  {
    key: 'id',
    header: 'Signal id',
    sort: (r) => r.id,
    render: (r) => (
      <span>
        <span className="mono">{r.id}</span>
        <span className="sub">{r.name}</span>
      </span>
    ),
  },
  { key: 'category', header: 'Category', sort: (r) => r.categoryLabel, render: (r) => <span className="muted">{r.categoryLabel}</span> },
  {
    key: 'value',
    header: 'Current value',
    numeric: true,
    render: (r) =>
      r.value == null ? (
        <Unavailable reason={r.basis === 'placeholder' ? PLACEHOLDER_REASON : r.basis === 'energy-model' ? ENERGY_REASON : (r.reason ?? 'No value in this release')}>
          {r.valueLabel ?? 'Unavailable'}
        </Unavailable>
      ) : (
        <span className="num">
          {r.value} {!NO_UNIT.has(r.unit) && <span className="muted">{r.unit}</span>}
          {r.staleSince != null && <span className="muted"> · stale since {formatClock(r.staleSince)}</span>}
        </span>
      ),
  },
  {
    key: 'quality',
    header: 'Quality · age',
    render: (r) =>
      r.quality == null ? (
        <span className="muted">—</span>
      ) : (
        <span>
          {QUALITY_LABEL[r.quality]}
          {r.ageMin != null && <span className="muted"> · {r.ageMin < 1 ? 'this minute' : `${formatDuration(r.ageMin)} ago`}</span>}
        </span>
      ),
  },
  {
    key: 'availability',
    header: 'Availability',
    title: 'Catalogue availability class and status — what a real plant would need, and what this demo has',
    sort: (r) => `${r.availabilityClass ?? ''} ${r.availabilityStatus ?? ''}`,
    render: (r) =>
      r.availabilityClass ? (
        <span>
          {r.availabilityClass}
          <span className="sub">{r.availabilityStatus}</span>
        </span>
      ) : (
        <span className="muted">Not in the catalogue</span>
      ),
  },
  { key: 'basis', header: 'Basis', render: (r) => <span className="muted">{r.basisLabel}</span> },
  {
    key: 'trend',
    header: 'History',
    render: (r) => <span className="muted">{r.value == null ? 'No value' : r.trend ? 'Charted above' : 'Current value only'}</span>,
  },
];

/** Every catalogued signal of an asset with search and a category filter: value (withheld without a model), quality, availability, basis, history. */
export function SignalTable({ rows }: { rows: SignalRow[] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SignalCategory | 'all'>('all');
  const cats = rowCategories(rows);
  const shown = filterSignalRows(rows, query, category);
  return (
    <>
      <div className="stg-sig-filters" role="search">
        <label className="stg-sig-search">
          <Search size={13} aria-hidden />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search signals" aria-label="Search signals by id, name, category or unit" />
        </label>
        <label>
          <span className="muted">Category</span>{' '}
          <select value={category} onChange={(e) => setCategory(e.target.value as SignalCategory | 'all')} aria-label="Filter by category">
            <option value="all">All categories</option>
            {cats.map((c) => (
              <option key={c} value={c}>
                {SIGNAL_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">
          {shown.length} of {rows.length}
        </span>
      </div>
      <DataTable columns={SIGNAL_COLUMNS} rows={shown} rowKey={(r) => r.id} maxHeight={300} empty={rows.length ? 'No signal matches the search or filter' : 'No signals configured'} />
    </>
  );
}

function ChartBlock({ c }: { c: Chart }) {
  const main = c.series[0];
  const last = main ? [...main.v].reverse().find((x) => x != null) : null;
  const fmt = (v: number) => (c.digits ? fmt1(v) : fmtInt(v));
  return (
    <section className="stg-chart">
      <header>
        <h3>
          {c.title} <span className="muted">({c.unit})</span>
        </h3>
        <span className="muted">
          Latest <b className="num">{last != null ? `${fmt(last)} ${c.unit}` : 'no data'}</b>
        </span>
      </header>
      {c.signalId && <div className="mono muted stg-sig-id">{c.signalId}</div>}
      <TimeSeriesChart label={`${c.title}, ${c.unit}`} from={c.from} to={c.to} unit={c.unit} series={c.series} refLines={c.ref} yMin={c.yMin} yMax={c.yMax} height={140} formatValue={fmt} />
      {c.note && <div className="muted stg-sig-id">{c.note}</div>}
    </section>
  );
}
