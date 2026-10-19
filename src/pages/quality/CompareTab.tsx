/**
 * Quality › Compare (#/quality?tab=compare): reject rate and first-pass yield by batch, shift and product
 * (each against the rest of the window with a z-test), the hourly trend, defect categories with their
 * modelled origin stage, and the process association (rule engine findings + a per-batch scatter of mean
 * |PV − SP| against the batch reject rate). All counts are simulated; associations are not causes.
 */
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, CircleDashed, FlaskConical, Minus, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { CLASSIFICATION_LABEL, type RuleFinding } from '../../intel/rules';
import { DEFECTS } from '../../model/plant';
import type { RangeKey } from '../../model/telemetry';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime } from '../../sim/time';
import { RankedBars, ScatterChart, TimeSeriesChart, type RankedRow } from '../../ui/kit/charts';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { Disclosure, EmptyState, ProvenanceBadge, Section } from '../../ui/kit/Page';
import { Segmented } from '../../ui/kit/Panel';
import { SEVERITY, StatusBadge, type Tone } from '../../ui/kit/Status';
import { TimeRange } from '../../ui/kit/TimeRange';
import {
  ASSOCIATION_NOTE,
  BATCH_STATUS_LABEL,
  COMPARE_MIN_TILES,
  COMPARE_RANGES,
  COMPARE_Z,
  PV_OPTIONS,
  RECIPE_NOTE,
  SCATTER_MIN_BATCHES,
  VERDICT_LABEL,
  associationModel,
  compareView,
  rangeAvailability,
  rangeCovering,
  type BatchRow,
  type CompareRangeKey,
  type GroupRow,
  type Verdict,
} from './compare';
import { useCompareFocus } from './compareFocus';

export type Group = 'batch' | 'shift' | 'product';
type Metric = 'rate' | 'fpy';

const VERDICT_ICON: Record<Verdict, { icon: LucideIcon; tone: Tone }> = {
  higher: { icon: ArrowUp, tone: 'warning' },
  lower: { icon: ArrowDown, tone: 'good' },
  'not-significant': { icon: Minus, tone: 'neutral' },
  'too-few': { icon: CircleDashed, tone: 'neutral' },
  'no-rest': { icon: Minus, tone: 'neutral' },
  unavailable: { icon: CircleDashed, tone: 'neutral' },
};

const calcText = (c: { status: string; value: number | null }, digits = 2) => (c.status === 'ok' ? fmtPct(c.value, digits) : '—');

function VerdictCell({ r }: { r: GroupRow }) {
  const v = VERDICT_ICON[r.vs.verdict];
  return (
    <span title={r.vs.text}>
      <StatusBadge icon={v.icon} tone={v.tone} label={VERDICT_LABEL[r.vs.verdict]} size={12} />
      <span className="sub">{r.vs.text}</span>
    </span>
  );
}

function commonCols<T extends GroupRow>(): Column<T>[] {
  return [
    { key: 'inspected', header: 'Inspected', numeric: true, render: (r) => fmtInt(r.counts.inspected), sort: (r) => r.counts.inspected },
    { key: 'rejected', header: 'Rejected', numeric: true, render: (r) => fmtInt(r.counts.rejected), sort: (r) => r.counts.rejected },
    {
      key: 'rate',
      header: 'Reject rate',
      numeric: true,
      render: (r) => (r.rate.status === 'ok' ? fmtPct(r.rate.value, 2) : <span className="muted" title={r.rate.reason}>Unavailable</span>),
      sort: (r) => r.rate.value,
    },
    {
      key: 'fpy',
      header: 'FPY',
      numeric: true,
      title: 'First-pass yield = accepted ÷ inspected (no rework loop in the model)',
      render: (r) => (r.fpy.status === 'ok' ? fmtPct(r.fpy.value, 2) : <span className="muted" title={r.fpy.reason}>Unavailable</span>),
      sort: (r) => r.fpy.value,
    },
    {
      key: 'top',
      header: 'Top defect',
      render: (r) => (r.top ? <span title={`${fmtInt(r.top.tiles)} tiles · ${fmtPct(r.top.share, 0)} of its rejects`}>{DEFECTS[r.top.defect].label}</span> : <span className="muted">—</span>),
    },
    { key: 'vs', header: 'Vs the rest of the window', render: (r) => <VerdictCell r={r} />, sort: (r) => (r.vs.test?.status === 'ok' ? r.vs.test.value.z : null) },
  ];
}

const batchCols: Column<BatchRow>[] = [
  {
    key: 'id',
    header: 'Batch',
    render: (r) => (
      <>
        <span className="mono">{r.batch.id}</span>
        <span className="sub">{r.product} · {r.batch.sku}</span>
      </>
    ),
    sort: (r) => r.batch.start,
  },
  {
    key: 'pressed',
    header: 'Pressed',
    render: (r) => (
      <span title="Start – end of pressing">
        {formatDateTime(r.batch.start)} – {r.batch.end == null ? 'active' : formatClock(r.batch.end)}
      </span>
    ),
    sort: (r) => r.batch.start,
  },
  {
    key: 'status',
    header: 'At sorting',
    render: (r) => (
      <>
        {BATCH_STATUS_LABEL[r.status]}
        {r.partial && <span className="sub">part before the window</span>}
      </>
    ),
  },
  ...commonCols<BatchRow>(),
];
const groupCols: Column<GroupRow>[] = [
  {
    key: 'label',
    header: 'Group',
    render: (r) => (
      <>
        {r.label}
        <span className="sub">{r.sub}</span>
      </>
    ),
    sort: (r) => r.label,
  },
  ...commonCols<GroupRow>(),
];

export function CompareTab({ onBatchRecords, initialGroup = 'batch', initialRange = '24h' }: { onBatchRecords: (batchId: string) => void; initialGroup?: Group; initialRange?: CompareRangeKey }) {
  const focus = useCompareFocus((s) => s.batchId);
  const setFocus = useCompareFocus((s) => s.setBatch);
  const [range, setRange] = useState<CompareRangeKey>(initialRange);
  const [group, setGroup] = useState<Group>(initialGroup);
  const [metric, setMetric] = useState<Metric>('rate');
  const [pvId, setPvId] = useState<string | null>(null);

  const d = useSimValue(
    (s) => {
      const view = compareView(s, range);
      return { now: s.minute, view, assoc: associationModel(s, view, { pvId }), disabled: rangeAvailability(s.minute), cover: focus ? rangeCovering(s, focus) : null };
    },
    [range, pvId, focus],
  );

  // A linked batch: show the batch table, over the shortest range that covers it.
  const cover = d.cover;
  useEffect(() => {
    if (!focus) return;
    setGroup('batch');
    if (cover && cover !== 'none' && COMPARE_RANGES.findIndex((o) => o.key === cover) > COMPARE_RANGES.findIndex((o) => o.key === range)) setRange(cover);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const v = d.view;
  const focusRow = focus ? v.batches.find((b) => b.key === focus) : undefined;
  const rangeLabel = COMPARE_RANGES.find((o) => o.key === range)!.label;

  const trendT = v.trend.map((b) => b.t);
  const trendByT = new Map(v.trend.map((b) => [b.t, b]));
  const series =
    metric === 'rate'
      ? [{ id: 'rate', label: 'Reject rate', t: trendT, v: v.trend.map((b) => (b.rate == null ? null : b.rate * 100)), step: true }]
      : [{ id: 'fpy', label: 'First-pass yield', t: trendT, v: v.trend.map((b) => (b.fpy == null ? null : b.fpy * 100)), step: true }];

  const defectRows: RankedRow[] = v.defects.map((x, i) => ({
    key: x.defect,
    label: (
      <>
        {x.label}
        <span className="muted"> · modelled origin {x.originText}</span>
      </>
    ),
    value: x.tiles,
    share: x.share,
    color: `var(--series-${(i % 7) + 1})`,
  }));

  const a = d.assoc;
  const fired = a.findings.filter((f) => f.status === 'fired');
  const notEvaluated = a.findings.filter((f) => f.status === 'insufficient-data');
  const clear = a.findings.filter((f) => f.status === 'clear');

  return (
    <div className="qd-tab qc">
      <div className="qc-bar">
        <TimeRange
          value={range as RangeKey}
          onChange={(k) => setRange(k as CompareRangeKey)}
          options={COMPARE_RANGES}
          disabled={d.disabled as Partial<Record<RangeKey, string>>}
          label="Comparison window"
        />
        <span className="dim">
          {v.windowText} · hourly inspection counters{v.clipped ? ' · history shorter than the range' : ''}
        </span>
        <ProvenanceBadge kind="simulated" />
      </div>

      <Section
        title="Reject rate and first-pass yield by group"
        subtitle={`${rangeLabel} · each group against the rest of the window · two-proportion z-test, |z| ≥ ${COMPARE_Z}, at least ${COMPARE_MIN_TILES} tiles in each`}
        actions={
          <Segmented<Group>
            label="Compare by"
            value={group}
            onChange={setGroup}
            options={[
              { value: 'batch', label: `Batch (${v.batches.length})` },
              { value: 'shift', label: 'Shift' },
              { value: 'product', label: 'Product' },
            ]}
          />
        }
        flush
      >
        {focus && group === 'batch' && !focusRow && (
          <p className="qd-note qd-pad">
            Batch <span className="mono">{focus}</span>{' '}
            {cover === 'none' ? 'is older than the 7-day window (or not in the retained history).' : `is outside the ${rangeLabel} window.`}{' '}
            {cover && cover !== 'none' && !d.disabled[cover] && (
              <button type="button" className="row-link" onClick={() => setRange(cover)}>
                Show {COMPARE_RANGES.find((o) => o.key === cover)!.label}
              </button>
            )}{' '}
            <button type="button" className="row-link" onClick={() => setFocus(null)}>
              Clear
            </button>
          </p>
        )}
        {group === 'batch' && (
          <DataTable
            columns={batchCols}
            rows={v.batches}
            rowKey={(r) => r.key}
            selectedKey={focus}
            onRowClick={(r) => setFocus(focus === r.key ? null : r.key)}
            maxHeight={360}
            empty="No batch reached sorting in this window"
          />
        )}
        {group === 'shift' && <DataTable columns={groupCols} rows={v.shifts} rowKey={(r) => r.key} maxHeight="none" empty="No shift in this window" />}
        {group === 'product' && (
          <>
            <DataTable columns={groupCols} rows={v.products} rowKey={(r) => r.key} maxHeight="none" empty="No product reached sorting in this window" />
            <p className="qd-note qd-pad">{RECIPE_NOTE}</p>
          </>
        )}
        {group === 'batch' && focusRow && (
          <p className="qd-note qd-pad">
            <span className="mono">{focusRow.batch.id}</span> · {focusRow.product}: {calcText(focusRow.rate)} rejected of {fmtInt(focusRow.counts.inspected)} tiles · {focusRow.vs.text}.{' '}
            <button type="button" className="row-link" onClick={() => onBatchRecords(focusRow.batch.id)}>
              Show its inspection records
            </button>
          </p>
        )}
        <p className="qd-note qd-pad">
          Tiles inspected = vision tunnel count; rejected = gauge + tunnel rejects; a batch is counted over the minutes its tiles passed sorting (pressed about 3 h
          earlier). A significant difference is unlikely to be chance — it does not say what caused it.{v.total.counts.rounded ? ' Part of an hour older than the minute log is rounded to the whole hour.' : ''}
        </p>
      </Section>

      <div className="qd-two">
        <Section
          title={metric === 'rate' ? 'Reject rate per hour' : 'First-pass yield per hour'}
          subtitle={`${rangeLabel} · tiles inspected per hour in the tooltip · gaps where nothing was inspected`}
          actions={
            <Segmented<Metric>
              label="Trend measure"
              value={metric}
              onChange={setMetric}
              options={[
                { value: 'rate', label: 'Reject rate' },
                { value: 'fpy', label: 'FPY' },
              ]}
            />
          }
        >
          <TimeSeriesChart
            label={metric === 'rate' ? 'Reject rate per hour' : 'First-pass yield per hour'}
            from={v.window.from}
            to={Math.max(v.window.to, v.window.from + 60)}
            series={series}
            unit="%"
            refLines={metric === 'rate' ? [{ value: v.limit * 100, label: `Alert limit ${fmtPct(v.limit, 0)}`, kind: 'limit' }] : []}
            formatValue={(x) => `${x.toFixed(2)} %`}
            emptyReason="No tile inspected in this window"
            tipRows={(t) => {
              const b = trendByT.get(Math.floor(t / 60) * 60);
              return b ? [{ label: 'Inspected', value: `${fmtInt(b.inspected)} tiles${b.partial ? ' (hour in progress)' : ''}` }] : [];
            }}
          />
        </Section>
        <Section title="Defect categories" subtitle={`${rangeLabel} · tiles rejected per category · share of all rejects`}>
          {defectRows.length ? (
            <>
              <RankedBars rows={defectRows} format={fmtInt} labelHeader="Defect category" valueHeader="Tiles" showCumulative={false} />
              <p className="qd-note">The origin stage is the modelled origin of the category — a hypothesis to check, not a confirmed cause.</p>
            </>
          ) : (
            <EmptyState title="No rejects in this window" />
          )}
        </Section>
      </div>

      <Section title="Process association" subtitle={`${ASSOCIATION_NOTE} · rule QL-PROCESS-ASSOCIATION and per-batch process deviation`} actions={<ProvenanceBadge kind="simulated" />}>
        <div className="qc-assoc">
          <div className="qc-findings">
            {fired.length ? (
              fired.map((f) => <AssocFinding key={f.key} f={f} />)
            ) : (
              <p className="muted">No process association detected{clear.length ? ` · ${clear.length} equipment item${clear.length === 1 ? '' : 's'} checked` : ''}.</p>
            )}
            {notEvaluated.length > 0 && (
              <Disclosure title={`Not evaluated (${notEvaluated.length})`}>
                <ul className="qd-plain">
                  {notEvaluated.map((f) => (
                    <li key={f.key}>
                      {f.title}
                      {f.missingSignals.length > 0 && <span className="dim"> · {f.missingSignals.map((m) => `${m.name}: ${m.reason}`).join('; ')}</span>}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </div>
          <div className="qc-scatter">
            <label className="qc-pv">
              <span className="qd-k">Process value</span>
              <select className="select" value={a.pv.id} onChange={(e) => setPvId(e.target.value)} aria-label="Process value for the batch scatter">
                {PV_OPTIONS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="dim">{a.pvWhy === 'chosen' ? 'chosen' : `default: ${a.pvWhy}`}</span>
            </label>
            {a.enough ? (
              <ScatterChart
                label={`Batch reject rate vs mean deviation of ${a.pv.label}`}
                points={a.points.map((p) => ({ x: p.x, y: p.y * 100, label: `${p.batchId} · ${p.product} · ${fmtInt(p.inspected)} tiles` }))}
                xLabel={`Mean |PV − SP| · ${a.pv.label}`}
                yLabel="Batch reject rate"
                xUnit={a.pv.unit ?? ''}
                yUnit="%"
                minPoints={SCATTER_MIN_BATCHES}
                note={`${ASSOCIATION_NOTE}. One point per batch: mean |PV − SP| over the running minutes its tiles took, against its reject rate. No trend line is fitted.`}
              />
            ) : (
              <EmptyState title="Not enough matched batches" icon={FlaskConical}>
                {a.points.length} of {v.batches.length} batches have enough inspected tiles and usable {a.pv.label} data; at least {SCATTER_MIN_BATCHES} are needed{range !== '7d' && !d.disabled['7d'] ? ' — choose 7 days for more batches' : ''}. {ASSOCIATION_NOTE}.
              </EmptyState>
            )}
            {a.unmatched.length > 0 && (
              <Disclosure title={`Batches not matched (${a.unmatched.length})`}>
                <ul className="qd-plain">
                  {a.unmatched.map((u) => (
                    <li key={u.batchId}>
                      <span className="mono">{u.batchId}</span> <span className="dim">· {u.reason}</span>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

function AssocFinding({ f }: { f: RuleFinding }) {
  const sev = SEVERITY[f.severity] ?? { label: f.severity, tone: 'warning' as Tone, icon: TriangleAlert };
  return (
    <article className="qc-finding">
      <header>
        <StatusBadge icon={sev.icon ?? OctagonX} tone={sev.tone} label={sev.label} size={12} /> <b>{f.title}</b> <span className="tag">{CLASSIFICATION_LABEL[f.classification]}</span>
      </header>
      <p>{f.explanation}</p>
      <p className="dim">
        {f.firstSeen != null ? `Since ${formatClock(f.firstSeen)} · ` : ''}Confidence {f.confidence}
        {f.confidenceNote ? ` — ${f.confidenceNote}` : ''} · Simulated data · rule {f.ruleId}
      </p>
      {f.next && <p className="dim">Next check: {f.next}</p>}
    </article>
  );
}
