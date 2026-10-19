/**
 * Signals (brief §6C): the subject's catalogue signals joined with their current reading (intel/signalTable.ts) —
 * name · value and unit · quality / status (words + icon) · age · category — with a search box, a category filter
 * (only categories present) and an availability filter. Compact by default: the signals the demo simulates first,
 * the not-modelled / unavailable catalogue entries folded under "N more catalogue signals". A row opens an inline
 * detail: what the signal is, where it would come from (no tag is configured — mapped at integration), its
 * availability class and status, ranges and limits, setpoint, expected update interval, counter semantics and a
 * small history chart over the panel's range. Rows keep the `data-signal` anchors evidence links scroll to.
 */
import { memo, useEffect, useId, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { ChevronDown, CircleCheck, CircleDashed, CircleHelp, CircleSlash, OctagonX, Search, TriangleAlert, type LucideIcon } from 'lucide-react';
import { AVAILABILITY_CLASS_HINT, SIGNAL_CATEGORY_LABEL, type AvailabilityClass } from '../../../model/catalog';
import type { RangeKey, TelemetrySeries } from '../../../model/telemetry';
import { RANGE_BY_KEY } from '../../../model/telemetry';
import { TimeSeriesChart } from '../../kit/charts';

import {
  ALL_SIGNALS,
  categoriesOf,
  filterSignalRows,
  signalDetail,
  type AvailabilityFilter,
  type SignalFilter,
  type SignalQualityWord,
  type SignalTableRow,
} from '../intel/signalTable';

export * from '../intel/signalTable';

export const QUALITY_META: Record<SignalQualityWord, { tone: 'good' | 'warning' | 'critical' | 'neutral'; icon: LucideIcon }> = {
  Good: { tone: 'good', icon: CircleCheck },
  Uncertain: { tone: 'warning', icon: TriangleAlert },
  Bad: { tone: 'critical', icon: OctagonX },
  Stale: { tone: 'neutral', icon: CircleHelp },
  'No value': { tone: 'neutral', icon: CircleSlash },
  'Not modelled': { tone: 'neutral', icon: CircleDashed },
  Unavailable: { tone: 'neutral', icon: CircleSlash },
};

// ── UI ───────────────────────────────────────────────────────────────────────

/** The availability class as a short chip (Core / Conditional / External); the full class and its meaning in the tooltip. */
export const CLASS_CHIP: Record<AvailabilityClass, string> = { core: 'Core', conditional: 'Conditional', external: 'External' };

function ClassChip({ cls }: { cls: AvailabilityClass }) {
  return (
    <span className={`eqp-cls c-${cls}`} title={AVAILABILITY_CLASS_HINT[cls]}>
      {CLASS_CHIP[cls]}
    </span>
  );
}

function Quality({ row }: { row: SignalTableRow }) {
  const m = QUALITY_META[row.quality];
  const Icon = m.icon;
  return (
    <span className={`status ${m.tone}`} title={row.note ?? undefined}>
      <Icon size={11} strokeWidth={2.2} aria-hidden />
      {row.quality}
    </span>
  );
}

function Detail({ row, id, range, history, chartId, onChart }: { row: SignalTableRow; id: string; range: RangeKey; history?: (signalId: string) => TelemetrySeries | null; chartId?: string | null; onChart?: (id: string) => void }) {
  const numeric = row.def.dataType === 'float' || row.def.dataType === 'integer';
  const x = numeric && row.def.availabilityStatus === 'simulated' && history ? history(row.def.signalId) : null;
  const from = x?.t[0] ?? 0;
  const to = x ? from + x.t.length * x.stepMin : 0;
  return (
    <div className="eqp-st-d" id={id}>
      <p>{row.def.description}</p>
      <dl>
        {signalDetail(row).map((l) => (
          <div key={l.label} title={l.hint}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>
      {x ? (
        <TimeSeriesChart
          label={`${row.def.name} · last ${RANGE_BY_KEY[range].label}`}
          from={from}
          to={to}
          series={[{ id: row.def.signalId, label: row.def.name, t: x.t, v: x.v }]}
          unit={x.unit}
          height={110}
          emptyReason={x.note ?? 'No sample in this range'}
        />
      ) : (
        <p className="eqp-st-nohist">
          {!numeric ? 'No numeric history: a state, event or text signal.' : row.def.availabilityStatus !== 'simulated' ? 'No history: the demo has no value for this signal.' : 'No history available for this signal.'}
        </p>
      )}
      {chartId && onChart && (
        <button type="button" className="tw-link" onClick={() => onChart(chartId)}>
          Show its chart
        </button>
      )}
    </div>
  );
}

/** What a closed row shows is the same (its value's timestamp only appears in the open detail). */
const sameRow = (a: SignalTableRow, b: SignalTableRow) =>
  a.def === b.def && a.label === b.label && a.value === b.value && a.unit === b.unit && a.quality === b.quality && a.note === b.note && a.age === b.age && a.hasValue === b.hasValue;

type RowProps = {

  r: SignalTableRow;
  isOpen: boolean;
  on: boolean;
  did: string;
  setOpen: Dispatch<SetStateAction<string | null>>;
  range: RangeKey;
  history?: (signalId: string) => TelemetrySeries | null;
  chartOf?: (signalId: string) => string | null;
  onChart?: (chartId: string) => void;
};

/**
 * One signal row. The rows are rebuilt from the readings every simulated minute, but most read the same: a closed
 * row re-renders only when what it shows changes; an open row (its detail charts the history) every time.
 */
const Row = memo(
  function Row({ r, isOpen, on, did, setOpen, range, history, chartOf, onChart }: RowProps) {
    const id = r.def.signalId;

    return (
      <li className={`eqp-st-r ${on ? 'on' : ''}
 ${r.hasValue ? '' : 'na'}`} data-signal={id} tabIndex={-1}>
        <button type="button" className="eqp-st-b" aria-expanded={isOpen} aria-controls={did} onClick={() => setOpen(isOpen ? '' : id)} title={id}>
          <span className="lab">{r.label ?? r.def.name}</span>
          <span className="val num">{r.value ?? '—'}</span>
          <span className="unit">{r.value != null && r.unit ? r.unit : ''}</span>
          <Quality row={r} />
          <span className="age num">{r.age}</span>
          <span className="cat">{SIGNAL_CATEGORY_LABEL[r.def.category]}</span>
          <ClassChip cls={r.def.availabilityClass} />
          <ChevronDown size={12} aria-hidden className="chev" />
        </button>
        {isOpen && <Detail row={r} id={did} range={range} history={history} chartId={chartOf?.(id)} onChart={onChart} />}
      </li>
    );
  },
  (a, b) => !a.isOpen && !b.isOpen && a.on === b.on && a.did === b.did && a.setOpen === b.setOpen && sameRow(a.r, b.r),
);

const AVAIL_OPTIONS: { value: AvailabilityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'value', label: 'Has value' },
  { value: 'none', label: 'Not available' },
];

export function SignalTable({
  rows,
  range,
  history,
  highlight = null,
  chartOf,
  onChart,
  label = 'Signals',
}: {
  rows: SignalTableRow[];
  range: RangeKey;
  /** Numeric history of a signal over the range (null: none). */
  history?: (signalId: string) => TelemetrySeries | null;
  /** A signal an evidence link points at: highlighted, unfolded and its detail open. */
  highlight?: string | null;
  /** The chart id that shows a signal, when the chart set has one. */
  chartOf?: (signalId: string) => string | null;
  onChart?: (chartId: string) => void;
  label?: string;
}) {
  const [f, setF] = useState<SignalFilter>(ALL_SIGNALS);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const uid = useId();
  const cats = useMemo(() => categoriesOf(rows), [rows]);
  const { shown, more: folded } = useMemo(() => filterSignalRows(rows, f), [rows, f]);
  // An evidence link to a folded row unfolds it; it opens the row's detail.
  const list = more || (highlight && folded.some((r) => r.def.signalId === highlight)) ? [...shown, ...folded] : shown;
  // An evidence link keeps its row open (and unfolded) after the highlight fades; '' = closed by the viewer.
  useEffect(() => {
    if (!highlight) return;
    setOpen(highlight);
    if (folded.some((r) => r.def.signalId === highlight)) setMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per evidence link, not per tick
  }, [highlight]);
  const openId = open ?? highlight;
  if (!rows.length) return <p className="eqp-chart-empty">No catalogue signal is defined for this asset.</p>;
  return (
    <div className="eqp-st">
      <div className="eqp-st-tools">
        <label className="eqp-st-search">
          <Search size={13} aria-hidden />
          <input type="search" placeholder="Search name, id, description" aria-label="Search signals" value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} />
        </label>
        {/* Segmented, wrapping: only the categories this asset has. */}
        <div className="seg eqp-st-cats" role="radiogroup" aria-label="Signal category">
          {(['all', ...cats] as SignalFilter['category'][]).map((c) => (
            <button key={c} type="button" role="radio" aria-checked={f.category === c} className={f.category === c ? 'on' : ''} onClick={() => setF({ ...f, category: c })}>
              {c === 'all' ? 'All' : SIGNAL_CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <div className="seg" role="radiogroup" aria-label="Availability">
          {AVAIL_OPTIONS.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={f.availability === o.value} className={f.availability === o.value ? 'on' : ''} onClick={() => setF({ ...f, availability: o.value })}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="eqp-st-head" aria-hidden>
        <span>Signal</span>
        <span>Value</span>
        <span>Unit</span>
        <span>Quality</span>
        <span>Age</span>
        <span>Category</span>
        <span>Availability</span>
      </div>
      <ul className="eqp-st-rows" aria-label={label}>
        {list.map((r) => {
          const id = r.def.signalId;
          const did = `${uid}-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
          return <Row key={id} r={r} isOpen={openId === id} on={highlight === id} did={did} setOpen={setOpen} range={range} history={history} chartOf={chartOf} onChart={onChart} />;
        })}

      </ul>
      {!list.length && <p className="eqp-chart-empty">No signal matches the filters.</p>}
      {folded.length > 0 && list === shown && (
        <button type="button" className="eqp-st-more" aria-expanded={false} onClick={() => setMore(true)}>
          + {folded.length} catalogue signal{folded.length === 1 ? '' : 's'} without a value ({folded
            .slice(0, 4)
            .map((r) => (r.label ?? r.def.name).toLowerCase())
            .join(', ')}
          {folded.length > 4 ? '…' : ''}) · not modelled or unavailable in the demo · <span className="show">Show</span>
        </button>
      )}
      {folded.length > 0 && list !== shown && more && (
        <button type="button" className="eqp-st-more" aria-expanded onClick={() => setMore(false)}>
          Fold the {folded.length} catalogue signals without a value
        </button>
      )}
    </div>
  );
}
