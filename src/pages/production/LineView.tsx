import { Fragment, useState } from 'react';
import { ArrowDown, CircleCheck, OctagonX, TriangleAlert, X } from 'lucide-react';
import { useApp } from '../../app/store';
import { BASE_REJECT_RATE, CONVEYOR_IDS, DOWNTIME_REASONS, LINE, M2_PER_TILE, PROCESS_MACHINES, STAGE_BY_ID, TARGET } from '../../model/plant';
import type { DowntimeCategory, DowntimeEvent } from '../../model/types';
import {
  HELD_UP_SHARE,
  bottleneck,
  clippedDuration,
  lineLossTree,
  lineMetrics,
  resolvePeriod,
  shiftHistory,
  type PeriodKey,
  type ShiftRow,
} from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDay, formatDuration } from '../../sim/time';
import { ColumnChart, LineChart, RankedBars, TipRow, Waterfall, type WaterfallStep } from '../../ui/kit/charts';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmt1, fmtInt, fmtPct, pct } from '../../ui/kit/format';
import { Panel, Segmented } from '../../ui/kit/Panel';
import { MetricText, OperationalStatus, SourceTag, StatusBadge } from '../../ui/kit/Status';
import { Kpi, TONE_ICON, Verdict, assetName, type Tone } from './common';
import { filterEvents, filteredPareto, granularityFor, isFlow, lineTrend, reasonLabel, withIncludeFlow, type EventFilter } from './derive';
import { lineFlow, lineSummary, type FlowBuffer, type FlowStage } from './line';
import { OeeExplainPanel } from './OeeExplainPanel';
import { PlanVsActual } from './PlanVsActual';

const eqName = assetName;
const CATEGORIES: DowntimeCategory[] = ['Mechanical', 'Electrical & control', 'Process', 'Changeover', 'Planned', 'Starved', 'Blocked'];
const EVENT_LIMIT = 400;
const ASSETS = [...PROCESS_MACHINES, ...CONVEYOR_IDS];

/** Production line level: throughput, the traced bottleneck and buffers, line OEE and its losses. */
export function LineView({ periodKey, onAsset }: { periodKey: PeriodKey; onAsset: (id: string) => void }) {
  const [filter, setFilter] = useState<EventFilter>({ category: 'all', equipmentId: 'all', reason: null, includeFlow: false });
  return (
    <>
      <LineSummaryBand periodKey={periodKey} />
      <PlanVsActual periodKey={periodKey} className="col-7" />
      <OeeExplainPanel periodKey={periodKey} className="col-5" />
      <LineFlowPanel onAsset={onAsset} />
      <LossWaterfall periodKey={periodKey} />
      <DowntimePareto periodKey={periodKey} filter={filter} setFilter={setFilter} />
      <Trends periodKey={periodKey} />
      <ShiftTable />
      <EventTable periodKey={periodKey} filter={filter} setFilter={setFilter} onAsset={onAsset} />
    </>
  );
}

// ── Summary band ─────────────────────────────────────────────────────────────

function LineSummaryBand({ periodKey }: { periodKey: PeriodKey }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const lm = lineMetrics(s, p);
      const calendar = Math.max(0, Math.min(p.to, s.minute) - p.from);
      return { p, lm, sm: lineSummary(s, lm, calendar), bn: bottleneck(s) };
    },
    [periodKey],
  );
  const { lm, sm, bn } = d;
  const rate = sm.goodPerHourM2;
  const ratio = rate != null && sm.planPerHourM2 > 0 ? rate / sm.planPerHourM2 : null;
  const tone: Tone = ratio == null ? 'neutral' : ratio >= 0.97 ? 'good' : ratio >= 0.9 ? 'warning' : 'critical';
  const scale = Math.max(1.25, (ratio ?? 0) * 1.05);
  const oee = lm.oee.oee;
  const oeeDelta = oee.status === 'ok' ? (oee.value! - TARGET.oeeTarget) * 100 : null;
  const stops = lm.activeStops.length;
  const causeLabel = bn.cause === 'constraint' ? 'Kiln limits the line, as designed' : bn.cause === 'starving' ? 'Starving the kiln' : 'Blocking the kiln';
  return (
    <section className="summary prod-kpis prod-kpis-5" aria-label="Line summary">
      <div className="prod-kpi-head">
        <div className="kpi-label">Line throughput · {d.p.label}</div>
        <Verdict tone={tone}>
          {ratio == null ? 'No production time in this period yet' : `${fmtPct(ratio, 0)} of the plan rate · ${fmtInt(sm.firedPerHour)} tiles/h fired of ${fmtInt(sm.designPerHour)} design`}
        </Verdict>
        <div className="kpi-value">
          {fmtInt(rate)}
          <small>/ {fmtInt(sm.planPerHourM2)} m²/h plan</small>
        </div>
        <div className="meter" title="Good m² per hour vs the plan rate — tick marks the plan">
          <i style={{ width: `${Math.min(100, ((ratio ?? 0) / scale) * 100)}%` }} />
          <b style={{ left: `calc(${(1 / scale) * 100}% - 1px)` }} />
        </div>
        <div className="kpi-sub">
          <span>
            First-quality output at sorting · {fmtInt(lm.outputM2)} m² in the period
          </span>
        </div>
      </div>
      <Kpi
        label="Line OEE"
        title="Availability × performance at the line constraint (kiln) × first-pass quality at sorting — see “How OEE is calculated”"
        value={<MetricText m={oee} />}
        lines={[
          <span key="apq">
            A <MetricText m={lm.oee.availability} /> · P <MetricText m={lm.oee.performance} /> · Q <MetricText m={lm.oee.quality} />
          </span>,
          <span key="t" className={oeeDelta != null && oeeDelta < 0 ? 'prod-under' : ''}>
            Target {pct(TARGET.oeeTarget)}
            {oeeDelta != null && ` · ${oeeDelta < 0 ? '−' : '+'}${fmt1(Math.abs(oeeDelta))} pts`}
          </span>,
        ]}
      />
      <Kpi
        label="Bottleneck (traced)"
        title={`Traced from the kiln over the ${bn.period.label.toLowerCase()} — see Line flow`}
        value={<span className="prod-kpi-text">{bn.current.name}</span>}
        lines={[
          <StatusBadge key="c" tone={bn.cause === 'constraint' ? 'good' : 'warning'} icon={bn.cause === 'constraint' ? CircleCheck : TriangleAlert} label={causeLabel} />,
          <span key="w">{bn.period.label}</span>,
        ]}
      />
      <Kpi
        label="Kiln starved / blocked"
        title={`Share of the kiln's planned time waiting for tiles (starved) or unable to discharge (blocked), ${bn.period.label.toLowerCase()}. Above ${Math.round(HELD_UP_SHARE * 100)} % the trace moves off the kiln.`}
        value={
          <>
            {fmtPct(bn.constraint.starvedShare, 0)}
            <small>/ {fmtPct(bn.constraint.blockedShare, 0)}</small>
          </>
        }
        lines={[<span key="w">starved / blocked · {bn.period.label.toLowerCase()}</span>]}
      />
      <Kpi
        label="WIP in process"
        title="Tiles in the buffers between pressing and palletising (slip and powder excluded)"
        value={
          <>
            {fmtInt(sm.wipTiles)}
            <small>tiles</small>
          </>
        }
        lines={[<span key="f">Kiln infeed covers {fmtInt(sm.kilnFeedMin)} min</span>, <span key="o">outfeed space {fmtInt(sm.kilnSpaceMin)} min</span>]}
      />
      <Kpi
        label="Unplanned downtime"
        title="Unplanned stops summed over all process machines; excludes planned stops and starved / blocked time"
        value={
          <>
            {fmtInt(lm.downtimeMin)}
            <small>min</small>
          </>
        }
        lines={[
          stops ? <StatusBadge key="a" tone="critical" icon={OctagonX} label={`${stops} active ${stops === 1 ? 'stop' : 'stops'}`} /> : <StatusBadge key="a" tone="good" icon={CircleCheck} label="None active" />,
          <span key="u">All machines · machine time</span>,
        ]}
      />
    </section>
  );
}

// ── Line flow & bottleneck trace ─────────────────────────────────────────────

const FLOW_SEGMENTS = [
  { key: 'working', label: 'Working', color: 'var(--series-1)' },
  { key: 'down', label: 'Down', color: 'var(--series-2)' },
  { key: 'starved', label: 'Starved', color: 'var(--series-3)' },
  { key: 'blocked', label: 'Blocked', color: 'var(--series-4)' },
] as const;

const ROLE_NOTE: Record<FlowStage['role'], string> = {
  bottleneck: 'Bottleneck — sets the line pace',
  upstream: 'Upstream — blocks when the bottleneck is slower',
  downstream: 'Downstream — starves when the bottleneck is slower',
};

function BufferRow({ b }: { b: FlowBuffer }) {
  const Icon = TONE_ICON[b.tone];
  return (
    <div className="prod-flow-buf" role="row">
      <span className="prod-flow-arrow" role="cell">
        <ArrowDown size={13} aria-hidden />
        <span>
          {b.name}
          {b.material && <span className="tag prod-flow-mat">material</span>}
        </span>
      </span>
      <span className="prod-buf" role="cell" title={`${fmtInt(b.tiles)} of ${fmtInt(b.capacity)} tiles`}>
        <span className="prod-buf-track">
          <i style={{ width: `${Math.min(100, b.fill * 100)}%` }} />
        </span>
        {fmtPct(b.fill, 0)}
      </span>
      <span className="n" role="cell" title="Change over the last 60 min">
        {b.delta60 == null ? '—' : `${b.delta60 >= 0 ? '+' : '−'}${fmtInt(Math.abs(b.delta60))}`}
      </span>
      <span className="n" role="cell" title="Minutes the next stage could run on this buffer alone, at its design rate">
        {fmtInt(b.coverMin)} min
      </span>
      <span className={`prod-flow-effect ${b.tone}`} role="cell">
        <Icon size={12} aria-hidden /> {b.effect}
      </span>
    </div>
  );
}

function LineFlowPanel({ onAsset }: { onAsset: (id: string) => void }) {
  const d = useSimValue((s) => {
    const bn = bottleneck(s);
    return { bn, flow: lineFlow(s, bn) };
  });
  const { bn, flow } = d;
  return (
    <Panel
      className="col-12"
      title={`Line flow & bottleneck trace · ${bn.period.label.toLowerCase()}`}
      subtitle={
        bn.shifted
          ? `${bn.current.name} is ${bn.cause === 'starving' ? 'starving' : 'blocking'} the kiln (designed constraint) — WIP accumulates upstream of it and drains downstream`
          : `Constraint at ${STAGE_BY_ID[LINE.designConstraint].name.toLowerCase()} (kiln), as designed`
      }
      actions={
        <div className="chart-legend prod-flow-legend">
          {FLOW_SEGMENTS.map((x) => (
            <span key={x.key}>
              <i style={{ background: x.color }} />
              {x.label}
            </span>
          ))}
        </div>
      }
      footer={
        <span>
          Traced from the kiln: if it waited for tiles (starved over {Math.round(HELD_UP_SHARE * 100)} % of the window) the bottleneck is the first stage upstream that was not itself
          waiting; if it was blocked, the first stage downstream that was not blocked. Shares are minutes of the window from the per-minute log (planned stops excluded). Buffer
          cover = tiles ÷ the next stage’s design rate; Δ = change over the last 60 min.
        </span>
      }
      flush
    >
      <div className="prod-flow" role="table" aria-label="Stages and buffers in process order">
        <div className="prod-flow-head" role="row">
          <span role="columnheader">Stage · machines</span>
          <span role="columnheader">Time split</span>
          <span role="columnheader" className="n">
            Working
          </span>
          <span role="columnheader">Role in the flow</span>
        </div>
        {flow.map((st) => (
          <Fragment key={st.stage}>
            {st.input && <BufferRow b={st.input} />}
            <div className={`prod-flow-stage ${st.role}`} role="row">
              <span className="prod-flow-name" role="cell">
                <b>
                  {st.index + 1}. {st.name}
                </b>
                {st.role === 'bottleneck' && <span className="tag scenario">Bottleneck</span>}
                {st.isDesignConstraint && st.role !== 'bottleneck' && <span className="tag">Design constraint</span>}
                <span className="prod-flow-machines">
                  {st.machines.map((m) => (
                    <button key={m.id} className="prod-flow-m" onClick={() => onAsset(m.id)} title={`${m.id} · ${eqName(m.id)} — open the drill-down`}>
                      <span className="mono">{m.id}</span>
                      <OperationalStatus state={m.state} />
                    </button>
                  ))}
                </span>
              </span>
              <span
                className="prod-bn-track"
                role="cell"
                title={`Working ${pct(st.workingShare)} · down ${pct(st.downShare)} · starved ${pct(st.starvedShare)} · blocked ${pct(st.blockedShare)}`}
              >
                {[st.workingShare, st.downShare, st.starvedShare, st.blockedShare].map((v, i) =>
                  v > 0 ? <i key={FLOW_SEGMENTS[i].key} style={{ width: `${v * 100}%`, background: FLOW_SEGMENTS[i].color }} /> : null,
                )}
              </span>
              <span className="n" role="cell">
                {pct(st.workingShare)}
              </span>
              <span className="muted" role="cell">
                {ROLE_NOTE[st.role]}
                {st.starvedShare > HELD_UP_SHARE && ` · starved ${pct(st.starvedShare)}`}
                {st.blockedShare > HELD_UP_SHARE && ` · blocked ${pct(st.blockedShare)}`}
                {st.downShare > HELD_UP_SHARE && ` · down ${pct(st.downShare)}`}
              </span>
            </div>
          </Fragment>
        ))}
      </div>
    </Panel>
  );
}

// ── OEE loss waterfall (kiln minutes) ────────────────────────────────────────

function LossWaterfall({ periodKey }: { periodKey: PeriodKey }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      return { tree: lineLossTree(s, p), lm: lineMetrics(s, p) };
    },
    [periodKey],
  );
  const t = d.tree;
  const steps: WaterfallStep[] = t
    ? [
        { label: 'Planned\ntime', value: t.planned, kind: 'total', note: 'Kiln planned production time, minutes' },
        { label: 'Availability\nloss', value: t.availabilityLoss, kind: 'loss', note: 'Kiln not producing: down, starved or blocked' },
        { label: 'Performance\nloss', value: t.performanceLoss, kind: 'loss', note: 'Kiln running below ideal rate' },
        { label: 'Quality\nloss', value: t.qualityLoss, kind: 'loss', note: 'Time spent on tiles rejected at sorting' },
        { label: 'Fully\nproductive', value: t.fullyProductive, kind: 'total', note: 'Ideal-rate time of good tiles' },
      ]
    : [];
  const issues = d.lm.oee.issues;
  return (
    <Panel
      className="col-5"
      title="OEE loss waterfall"
      subtitle="Where planned kiln time goes · minutes"
      footer={
        <div className="prod-foot">
          <span>
            Planned production time at the kiln split into availability, performance and quality losses; fully productive ÷ planned time = line OEE
            {t && t.planned > 0 ? ` (${fmtPct(t.fullyProductive / t.planned)})` : ''}.
          </span>
          {issues.length > 0 && (
            <span className="prod-issues">
              <TriangleAlert size={12} aria-hidden /> {issues.join(' · ')}
            </span>
          )}
        </div>
      }
    >
      {t ? (
        <Waterfall steps={steps} format={fmtInt} height={220} />
      ) : (
        <div className="empty">
          <b>Loss tree unavailable</b>
          {d.lm.oee.oee.issue ?? 'OEE could not be computed for this period'}
        </div>
      )}
    </Panel>
  );
}

// ── Downtime Pareto ──────────────────────────────────────────────────────────

function DowntimePareto({ periodKey, filter, setFilter }: { periodKey: PeriodKey; filter: EventFilter; setFilter: (f: EventFilter) => void }) {
  const rows = useSimValue((s) => filteredPareto(s, resolvePeriod(periodKey, s.minute), filter), [periodKey, filter]);
  const top = rows.slice(0, 10);
  const total = rows.reduce((a, r) => a + r.minutes, 0);
  return (
    <Panel
      className="col-7"
      title="Downtime Pareto"
      subtitle={`By reason · ${fmtInt(total)} min machine time${rows.length > top.length ? ` · top ${top.length} of ${rows.length}` : ''} · click a reason to filter events`}
      actions={
        <div className="prod-actions">
          <CategorySelect filter={filter} setFilter={setFilter} />
          <Segmented
            label="Loss scope"
            value={filter.includeFlow ? 'flow' : 'own'}
            options={[
              { value: 'own', label: 'Own stops' },
              { value: 'flow', label: '+ Starved / blocked' },
            ]}
            onChange={(v) => setFilter(withIncludeFlow(filter, v === 'flow'))}
          />
        </div>
      }
      footer={<span>Machine minutes, all assets — a stop costs line output only where it held up the kiln (Factory level, Loss & cost).</span>}
    >
      {top.length ? (
        <RankedBars
          rows={top.map((r) => ({
            key: r.key,
            label: (
              <span className={filter.reason === r.key ? 'prod-sel' : ''}>
                {r.label} <span className="dim">· {r.category} · {r.events}×</span>
              </span>
            ),
            value: r.minutes,
            cumulative: r.cumulative,
            color: filter.reason && filter.reason !== r.key ? 'var(--line-3)' : undefined,
          }))}
          format={fmtInt}
          valueHeader="Min"
          onSelect={(r) => setFilter({ ...filter, reason: filter.reason === r.key ? null : r.key })}
        />
      ) : (
        <div className="empty">
          <b>No downtime losses</b>
          No stoppages match this filter in the period
        </div>
      )}
    </Panel>
  );
}

function CategorySelect({ filter, setFilter }: { filter: EventFilter; setFilter: (f: EventFilter) => void }) {
  return (
    <select className="select" aria-label="Downtime category" value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value as EventFilter['category'], reason: null })}>
      <option value="all">All categories</option>
      {CATEGORIES.filter((c) => filter.includeFlow || !isFlow(c)).map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

// ── Trends ───────────────────────────────────────────────────────────────────

function Trends({ periodKey }: { periodKey: PeriodKey }) {
  const go = useApp((s) => s.go);
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const g = granularityFor(p);
      return { g, data: lineTrend(s, p, g) };
    },
    [periodKey],
  );
  const unit = d.g === 'hour' ? 'Hourly' : 'Per-shift';
  const tickEvery = Math.max(1, Math.ceil(d.data.length / 8));
  const rates = d.data.map((b) => b.defectRate);
  const rateMax = Math.max(0.02, Math.ceil((Math.max(BASE_REJECT_RATE, ...rates.filter((r): r is number => r != null)) * 1.15) / 0.02) * 0.02);
  return (
    <>
      <Panel className="col-4" title={`${unit} output vs target`} subtitle="First-quality m² · dashed = target">
        <ColumnChart
          data={d.data.map((b) => ({ key: b.key, label: b.label, value: b.outputM2, target: b.targetM2, muted: b.partial }))}
          format={fmtInt}
          tickEvery={tickEvery}
          tip={(c) => {
            const b = d.data.find((x) => x.key === c.key)!;
            return (
              <>
                <b>
                  {b.tip}
                  {b.partial ? ' (partial)' : ''}
                </b>
                <TipRow k="Output" v={`${fmtInt(b.outputM2)} m²`} />
                <TipRow k="Target" v={`${fmtInt(b.targetM2)} m²`} />
                <TipRow k="Attainment" v={b.targetM2 > 0 ? pct(b.outputM2 / b.targetM2) : '—'} />
              </>
            );
          }}
        />
      </Panel>
      <Panel className="col-4" title={`${unit} line OEE`} subtitle={`Dashed = target ${pct(TARGET.oeeTarget)} · gaps where OEE is unavailable`}>
        <LineChart
          labels={d.data.map((b) => b.label)}
          series={[{ id: 'oee', label: 'Line OEE', color: 'var(--series-1)', points: d.data.map((b) => b.oee) }]}
          yMax={1}
          format={(v) => pct(v)}
          tickEvery={tickEvery}
          reference={{ value: TARGET.oeeTarget, label: `Target ${pct(TARGET.oeeTarget)}` }}
        />
      </Panel>
      <Panel
        className="col-4"
        title={`${unit} defect rate`}
        subtitle={`Rejected ÷ sorted tiles · dashed = baseline ${fmtPct(BASE_REJECT_RATE)}`}
        actions={
          <button className="btn sm ghost" onClick={() => go('quality')} title="Open AI Defect Monitoring for defects, stations and evidence">
            Defects
          </button>
        }
      >
        <LineChart
          labels={d.data.map((b) => b.label)}
          series={[{ id: 'defects', label: 'Defect rate', color: 'var(--series-1)', points: rates }]}
          yMax={rateMax}
          format={(v) => fmtPct(v)}
          tickEvery={tickEvery}
          reference={{ value: BASE_REJECT_RATE, label: `Baseline ${fmtPct(BASE_REJECT_RATE)}` }}
        />
      </Panel>
    </>
  );
}

// ── Shift performance ────────────────────────────────────────────────────────

function ShiftTable() {
  const rows = useSimValue((s) => shiftHistory(s));
  const cols: Column<ShiftRow>[] = [
    {
      key: 'shift',
      header: 'Shift',
      render: (r) => (
        <>
          {r.label}
          {!r.complete && <span className="tag scenario prod-inprog">In progress</span>}
        </>
      ),
    },
    { key: 'date', header: 'Date', render: (r) => formatDay(r.start), sort: (r) => r.start },
    { key: 'out', header: 'Output m²', numeric: true, render: (r) => fmtInt(r.metrics.outputM2), sort: (r) => r.metrics.outputM2 },
    { key: 'target', header: 'Target m²', numeric: true, render: (r) => fmtInt(r.metrics.targetM2), sort: (r) => r.metrics.targetM2 },
    {
      key: 'att',
      header: 'Attainment',
      numeric: true,
      render: (r) => <span className={r.metrics.attainment != null && r.metrics.attainment < 0.9 ? 'prod-under' : ''}>{fmtPct(r.metrics.attainment, 0)}</span>,
      sort: (r) => r.metrics.attainment,
    },
    { key: 'oee', header: 'OEE', numeric: true, render: (r) => <MetricText m={r.metrics.oee.oee} />, sort: (r) => r.metrics.oee.oee.value },
    { key: 'q', header: 'Quality', numeric: true, render: (r) => <MetricText m={r.metrics.oee.quality} />, sort: (r) => r.metrics.oee.quality.value },
    { key: 'down', header: 'Unpl. downtime', numeric: true, render: (r) => formatDuration(r.metrics.downtimeMin), sort: (r) => r.metrics.downtimeMin },
  ];
  return (
    <Panel className="col-12" title="Shift performance" subtitle="Last 7 days · newest first · in-progress shift measured to now (target pro-rated)" flush>
      <DataTable columns={cols} rows={rows} rowKey={(r) => `${r.date}-${r.id}`} maxHeight={300} />
    </Panel>
  );
}

// ── Downtime events ──────────────────────────────────────────────────────────

type EvRow = { ev: DowntimeEvent; inPeriod: number };

function EventTable({ periodKey, filter, setFilter, onAsset }: { periodKey: PeriodKey; filter: EventFilter; setFilter: (f: EventFilter) => void; onAsset: (id: string) => void }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const all = filterEvents(s, p, filter);
      return {
        now: s.minute,
        total: all.length,
        active: all.filter((e) => e.end == null).length,
        rows: all.slice(0, EVENT_LIMIT).map((ev): EvRow => ({ ev, inPeriod: clippedDuration(ev, p, s.minute) })),
      };
    },
    [periodKey, filter],
  );
  const reasons = DOWNTIME_REASONS.filter((r) => (filter.includeFlow || !isFlow(r.category)) && (filter.category === 'all' || r.category === filter.category));
  const dirty = filter.category !== 'all' || filter.equipmentId !== 'all' || filter.reason != null;
  const cols: Column<EvRow>[] = [
    { key: 'start', header: 'Start', render: (r) => formatDateTime(r.ev.start), sort: (r) => r.ev.start },
    {
      key: 'end',
      header: 'End',
      render: (r) => (r.ev.end == null ? <StatusBadge tone="critical" icon={OctagonX} label="Active" /> : formatClock(r.ev.end)),
      sort: (r) => r.ev.end ?? Number.MAX_SAFE_INTEGER,
    },
    {
      key: 'dur',
      header: 'Duration',
      numeric: true,
      title: 'Total event duration (in-period share in tooltip)',
      render: (r) => <span title={`${formatDuration(r.inPeriod)} inside the period`}>{formatDuration((r.ev.end ?? d.now) - r.ev.start)}</span>,
      sort: (r) => (r.ev.end ?? d.now) - r.ev.start,
    },
    {
      key: 'eq',
      header: 'Equipment',
      render: (r) => (
        <>
          <span className="mono">{r.ev.equipmentId}</span>
          <span className="sub">{eqName(r.ev.equipmentId)}</span>
        </>
      ),
      sort: (r) => r.ev.equipmentId,
    },
    { key: 'reason', header: 'Reason', render: (r) => reasonLabel(r.ev.reasonCode), sort: (r) => reasonLabel(r.ev.reasonCode) },
    { key: 'cat', header: 'Category', render: (r) => <span className="muted">{r.ev.category}</span>, sort: (r) => r.ev.category },
    { key: 'lost', header: 'Own lost m²', numeric: true, title: 'Ideal-rate output this asset did not make during the stop (asset level)', render: (r) => fmtInt(r.ev.lostTiles * M2_PER_TILE), sort: (r) => r.ev.lostTiles },
    {
      key: 'impact',
      header: 'Kiln held',
      numeric: true,
      title: 'Minutes the kiln (line constraint) was down, starved or blocked while this stop was active — what it may have cost the line',
      render: (r) => (r.ev.constraintImpactMin > 0 ? `${fmtInt(r.ev.constraintImpactMin)} min` : <span className="dim">0 min</span>),
      sort: (r) => r.ev.constraintImpactMin,
    },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.ev.source} />, sort: (r) => r.ev.source },
  ];
  return (
    <Panel
      className="col-12"
      title="Downtime events"
      subtitle={`${fmtInt(d.total)} events${d.active ? ` · ${d.active} active` : ''} · active first, then newest · click a row for the equipment drill-down`}
      actions={
        <div className="prod-actions">
          {filter.reason && (
            <span className="prod-chip">
              Reason: {reasonLabel(filter.reason)}
              <button className="btn ghost sm icon" onClick={() => setFilter({ ...filter, reason: null })} title="Clear reason filter">
                <X size={12} />
              </button>
            </span>
          )}
          <CategorySelect filter={filter} setFilter={setFilter} />
          <select className="select" aria-label="Equipment" value={filter.equipmentId} onChange={(e) => setFilter({ ...filter, equipmentId: e.target.value })}>
            <option value="all">All equipment</option>
            {ASSETS.map((id) => (
              <option key={id} value={id}>
                {id} · {eqName(id)}
              </option>
            ))}
          </select>
          <select className="select" aria-label="Reason" value={filter.reason ?? ''} onChange={(e) => setFilter({ ...filter, reason: e.target.value || null })}>
            <option value="">All reasons</option>
            {reasons.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </select>
          <label className="prod-check">
            <input type="checkbox" checked={filter.includeFlow} onChange={(e) => setFilter(withIncludeFlow(filter, e.target.checked))} />
            Starved / blocked
          </label>
          {dirty && (
            <button className="btn ghost sm" onClick={() => setFilter({ ...filter, category: 'all', equipmentId: 'all', reason: null })}>
              Clear filters
            </button>
          )}
        </div>
      }
      flush
    >
      <DataTable
        columns={cols}
        rows={d.rows}
        rowKey={(r) => r.ev.id}
        onRowClick={(r) => onAsset(r.ev.equipmentId)}
        maxHeight={380}
        empty="No downtime events match the filters in this period"
        footer={
          d.total > d.rows.length ? (
            <tfoot>
              <tr>
                <td colSpan={cols.length}>
                  Showing the {fmtInt(d.rows.length)} most recent of {fmtInt(d.total)} events — narrow the filters to see older ones.
                </td>
              </tr>
            </tfoot>
          ) : undefined
        }
      />
    </Panel>
  );
}
