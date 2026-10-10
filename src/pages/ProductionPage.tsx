import { useCallback, useState, type ReactNode } from 'react';
import { ArrowRight, CircleCheck, Info, OctagonX, TriangleAlert, X } from 'lucide-react';
import { useApp, openEquipment } from '../app/store';
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { BASE_REJECT_RATE, DOWNTIME_REASONS, LINE, M2_PER_TILE, PROCESS_MACHINES, STAGE_BY_ID, TARGET } from '../model/plant';
import type { DowntimeCategory, DowntimeEvent, StageId } from '../model/types';
import {
  bottleneck,
  clippedDuration,
  energyIn,
  lineLossTree,
  lineMetrics,
  resolvePeriod,
  shiftHistory,
  stageMetrics,
  type MachineMetrics,
  type PeriodKey,
  type ShiftRow,
  type StageMetrics,
} from '../sim/metrics';
import { useSimValue } from '../sim/store';
import { formatClock, formatDateTime, formatDay, formatDuration } from '../sim/time';
import { ColumnChart, LineChart, RankedBars, TipRow, Waterfall, type WaterfallStep } from '../ui/kit/charts';
import { DataTable, type Column } from '../ui/kit/DataTable';
import { fmt1, fmtInt, fmtPct, pct } from '../ui/kit/format';
import { Panel, Segmented } from '../ui/kit/Panel';
import { MachineStatus, MetricText, SourceTag, StatusBadge } from '../ui/kit/Status';
import type { MachineState } from '../model/types';
import { LossBars } from './production/LossBars';
import { MachineDrawer } from './production/MachineDrawer';
import { OeeExplainPanel } from './production/OeeExplainPanel';
import { PlanVsActual } from './production/PlanVsActual';
import {
  filterEvents,
  filteredPareto,
  granularityFor,
  isFlow,
  lineTrend,
  machineLosses,
  reasonLabel,
  shiftProjection,
  type EventFilter,
} from './production/derive';
import './production.css';

const eqName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? id;
const stageName = (id: StageId) => STAGE_BY_ID[id].name;
const CATEGORIES: DowntimeCategory[] = ['Mechanical', 'Electrical & control', 'Process', 'Changeover', 'Planned', 'Starved', 'Blocked'];
const EVENT_LIMIT = 400;

export function ProductionPage() {
  const periodKey = useApp((s) => s.period);
  const [machine, setMachine] = useState<string | null>(null);
  const [filter, setFilter] = useState<EventFilter>({ category: 'all', equipmentId: 'all', reason: null, includeFlow: false });
  const closeDrawer = useCallback(() => setMachine(null), []);
  const bn = useSimValue((s) => bottleneck(s));

  return (
    <div className="page prod">
      {/* 1. Are we on target? */}
      <Summary periodKey={periodKey} constraint={bn.current} shifted={bn.shifted} />
      <PlanVsActual periodKey={periodKey} className="col-7" />
      <OeeExplainPanel periodKey={periodKey} className="col-5" />

      {/* 2. Where do we lose, and why? */}
      <LossWaterfall periodKey={periodKey} />
      <DowntimePareto periodKey={periodKey} filter={filter} setFilter={setFilter} />
      <MachineLossPanel periodKey={periodKey} selected={machine} onSelect={setMachine} />
      <StageTable periodKey={periodKey} constraintStage={bn.current.stage} selected={machine} onSelect={setMachine} />

      {/* 3. How is it trending? */}
      <Trends periodKey={periodKey} />
      <BottleneckPanel ranked={bn.ranked} shifted={bn.shifted} />
      <ShiftTable />

      {/* 4. Event detail */}
      <EventTable periodKey={periodKey} filter={filter} setFilter={setFilter} />

      {machine && <MachineDrawer id={machine} periodKey={periodKey} onClose={closeDrawer} />}
    </div>
  );
}

// ── 1. Summary band ──────────────────────────────────────────────────────────

function Kpi({ label, value, lines, title }: { label: string; value: ReactNode; lines: ReactNode[]; title?: string }) {
  return (
    <div title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {lines.map((l, i) => (
        <div key={i} className="kpi-sub">
          {l}
        </div>
      ))}
    </div>
  );
}

function Summary({ periodKey, constraint, shifted }: { periodKey: PeriodKey; constraint: StageMetrics; shifted: boolean }) {
  const tariffs = useApp((s) => s.tariffs);
  const go = useApp((s) => s.go);
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const lm = lineMetrics(s, p);
      return { p, lm, energy: energyIn(s, p, tariffs), proj: periodKey === 'shift' ? shiftProjection(s, lm.output) : null };
    },
    [periodKey, tariffs],
  );
  const { lm, proj, energy } = d;
  const att = lm.attainment;
  const gap = lm.targetM2 - lm.outputM2;
  // Meter scale: target sits at 80 % of the track so over-delivery stays visible.
  const scale = Math.max(1.25, (att ?? 0) * 1.05);
  const verdict =
    att == null
      ? { tone: 'neutral', icon: Info, text: 'No production time in this period yet' }
      : att >= 1
        ? { tone: 'good', icon: CircleCheck, text: `Ahead of target · ${pct(att)} of target` }
        : att >= 0.97
          ? { tone: 'good', icon: CircleCheck, text: `On track · ${pct(att)} of target` }
          : { tone: att >= 0.9 ? 'warning' : 'critical', icon: att >= 0.9 ? TriangleAlert : OctagonX, text: `Behind target by ${fmtInt(gap)} m²` };
  const VIcon = verdict.icon;
  const oee = lm.oee.oee;
  const oeeDelta = oee.status === 'ok' ? Math.round((oee.value! - TARGET.oeeTarget) * 1000) / 10 : null;
  const rejectRate = lm.inspected > 0 ? lm.rejected / lm.inspected : null;
  const stops = lm.activeStops.length;

  return (
    <section className="summary prod-kpis" aria-label="Production summary">
      <div className="prod-kpi-head">
        <div className="kpi-label">Actual vs target · {d.p.label}</div>
        <div className={`prod-verdict ${verdict.tone}`}>
          <VIcon size={16} strokeWidth={2.2} aria-hidden />
          {verdict.text}
        </div>
        <div className="kpi-value">
          {fmtInt(lm.outputM2)}
          <small>/ {fmtInt(lm.targetM2)} m² target</small>
        </div>
        <div className="meter" title={`Attainment ${fmtPct(att)} — tick marks the target`}>
          <i style={{ width: `${Math.min(100, ((att ?? 0) / scale) * 100)}%` }} />
          <b style={{ left: `calc(${(1 / scale) * 100}% - 1px)` }} />
        </div>
        <div className="kpi-sub">
          {proj ? (
            <span title="Shift-to-date average rate extrapolated to the end of the shift">
              Projected at {formatClock(proj.endsAt)}: <b className="prod-strong">{fmtInt(proj.projectedM2)} m²</b> ({pct(proj.attainment)}) at {fmtInt(proj.rateM2h)} m²/h
            </span>
          ) : (
            <span>{fmtPct(att)} attainment · first-quality m² accepted at sorting</span>
          )}
        </div>
        <div className="kpi-sub" title="Active-period method over the last 2 h">
          <span>
            Constraint: <span className="prod-strong">{constraint.name}</span>
          </span>
          {shifted && <StatusBadge tone="warning" icon={TriangleAlert} label={`Shifted from ${stageName(LINE.designConstraint)}`} />}
        </div>
      </div>

      <Kpi
        label="OEE"
        title="Availability × Performance × Quality — see “How OEE is calculated”"
        value={<MetricText m={oee} />}
        lines={[
          <>
            <span>Target {pct(TARGET.oeeTarget)}</span>
            {oeeDelta != null && (
              <span className={oeeDelta < 0 ? 'prod-under' : ''}>
                {oeeDelta < 0 ? '−' : '+'}
                {fmt1(Math.abs(oeeDelta))} pts
              </span>
            )}
          </>,
        ]}
      />
      <Kpi
        label="Availability"
        title="Kiln operating time ÷ planned production time"
        value={<MetricText m={lm.oee.availability} />}
        lines={[<span key="a">Kiln run ÷ planned time</span>]}
      />
      <Kpi
        label="Performance"
        title="Ideal cycle time × kiln count ÷ operating time"
        value={<MetricText m={lm.oee.performance} />}
        lines={[<span key="p">Kiln rate ÷ ideal rate</span>]}
      />
      <Kpi
        label="Quality rate"
        title="Tiles accepted first time ÷ tiles sorted"
        value={<MetricText m={lm.oee.quality} />}
        lines={[<span key="q">First pass at sorting</span>]}
      />
      <Kpi
        label="Total downtime"
        title="Unplanned stops summed over all process machines; excludes planned stops and starved / blocked time"
        value={
          <>
            {fmtInt(lm.downtimeMin)}
            <small>min</small>
          </>
        }
        lines={[
          stops ? (
            <StatusBadge tone="critical" icon={OctagonX} label={`${stops} active ${stops === 1 ? 'stop' : 'stops'}`} />
          ) : (
            <StatusBadge tone="good" icon={CircleCheck} label="None active" />
          ),
          <span key="u">Unplanned · all machines</span>,
        ]}
      />
      <Kpi
        label="Defect rate"
        title="Tiles rejected at sorting ÷ tiles sorted"
        value={fmtPct(rejectRate)}
        lines={[
          <span key="r">
            {fmtInt(lm.rejected)} of {fmtInt(lm.inspected)} tiles
          </span>,
          <button key="l" className="row-link" onClick={() => go('quality')}>
            Quality <ArrowRight size={11} aria-hidden />
          </button>,
        ]}
      />
      <Kpi
        label="Energy per good m²"
        title="Electrical + thermal energy of all metered consumers ÷ first-quality m². Illustrative model; tariffs are assumptions."
        value={
          <>
            {fmt1(energy.sec)}
            <small>kWh/m²</small>
          </>
        }
        lines={[
          <span key="t">
            {fmtInt(energy.total)} kWh · {tariffs.currency} {fmtInt(energy.cost)}
          </span>,
          <>
            <span className="tag sim">Illustrative model</span>
            <button className="row-link" onClick={() => go('energy')}>
              Energy <ArrowRight size={11} aria-hidden />
            </button>
          </>,
        ]}
      />
    </section>
  );
}

// ── 2. Where we lose ─────────────────────────────────────────────────────────

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
        { label: 'Planned\ntime', value: t.planned, kind: 'total', note: 'Kiln planned production time' },
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

function DowntimePareto({ periodKey, filter, setFilter }: { periodKey: PeriodKey; filter: EventFilter; setFilter: (f: EventFilter) => void }) {
  const rows = useSimValue((s) => filteredPareto(s, resolvePeriod(periodKey, s.minute), filter), [periodKey, filter]);
  const top = rows.slice(0, 10);
  const total = rows.reduce((a, r) => a + r.minutes, 0);
  return (
    <Panel
      className="col-7"
      title="Downtime Pareto"
      subtitle={`By reason · ${fmtInt(total)} min${rows.length > top.length ? ` · top ${top.length} of ${rows.length}` : ''} · click a reason to filter events`}
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
            onChange={(v) => {
              const includeFlow = v === 'flow';
              setFilter({
                ...filter,
                includeFlow,
                category: !includeFlow && filter.category !== 'all' && isFlow(filter.category) ? 'all' : filter.category,
                reason: !includeFlow && (filter.reason === 'STARVED' || filter.reason === 'BLOCKED') ? null : filter.reason,
              });
            }}
          />
        </div>
      }
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
    <select
      className="select"
      aria-label="Downtime category"
      value={filter.category}
      onChange={(e) => setFilter({ ...filter, category: e.target.value as EventFilter['category'], reason: null })}
    >
      <option value="all">All categories</option>
      {CATEGORIES.filter((c) => filter.includeFlow || !isFlow(c)).map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

function MachineLossPanel({ periodKey, selected, onSelect }: { periodKey: PeriodKey; selected: string | null; onSelect: (id: string) => void }) {
  const rows = useSimValue((s) => machineLosses(s, resolvePeriod(periodKey, s.minute)), [periodKey]);
  const total = rows.reduce((a, r) => a + r.totalM2, 0);
  return (
    <Panel
      className="col-4"
      title="Losses by machine"
      subtitle={`Lost output at ideal rate · ${fmtInt(total)} m² · click a machine for the drill-down`}
      footer={
        <span>
          Unplanned downtime and starved / blocked minutes × the machine’s ideal rate, in tile-equivalent m². Losses away from the kiln cost line output
          only when they starve or block the kiln.
        </span>
      }
    >
      {total > 0 ? (
        <LossBars rows={rows} selectedKey={selected} onSelect={onSelect} />
      ) : (
        <div className="empty">
          <b>No losses</b>
          No unplanned downtime, starved or blocked time in this period
        </div>
      )}
    </Panel>
  );
}

// ── 3. Attention: stages & machines ──────────────────────────────────────────

type MachineRow = { stage: StageMetrics; m: MachineMetrics; state: MachineState; since: number };

function StageTable({ periodKey, constraintStage, selected, onSelect }: { periodKey: PeriodKey; constraintStage: StageId; selected: string | null; onSelect: (id: string) => void }) {
  const rows = useSimValue(
    (s) =>
      stageMetrics(s, resolvePeriod(periodKey, s.minute)).flatMap((st) =>
        st.machines.map((m): MachineRow => ({ stage: st, m, state: s.machines[m.id].state, since: s.machines[m.id].since })),
      ),
    [periodKey],
  );
  const share = (r: MachineRow, v: number) => (r.m.totals.planned > 0 ? v / r.m.totals.planned : null);
  const cols: Column<MachineRow>[] = [
    {
      key: 'stage',
      header: 'Stage',
      render: (r) => (
        <span className="prod-stage">
          {r.stage.name}
          {r.stage.stage === constraintStage && <span className="tag prod-constraint" title="Current constraint (active-period method, last 2 h)">Constraint</span>}
          {r.stage.stage === LINE.designConstraint && r.stage.stage !== constraintStage && <span className="tag" title="Designed line constraint">Design</span>}
        </span>
      ),
    },
    {
      key: 'machine',
      header: 'Machine',
      render: (r) => (
        <>
          <span className="mono">{r.m.id}</span>
          <span className="sub">{r.m.name}</span>
        </>
      ),
      sort: (r) => r.m.id,
    },
    { key: 'state', header: 'State', render: (r) => <MachineStatus state={r.state} />, sort: (r) => r.state },
    { key: 'out', header: 'Output m²', numeric: true, render: (r) => fmtInt(r.m.totals.count * M2_PER_TILE), sort: (r) => r.m.totals.count },
    { key: 'a', header: 'A', numeric: true, render: (r) => <MetricText m={r.m.oee.availability} />, sort: (r) => r.m.oee.availability.value },
    { key: 'p', header: 'P', numeric: true, render: (r) => <MetricText m={r.m.oee.performance} />, sort: (r) => r.m.oee.performance.value },
    { key: 'q', header: 'Q', numeric: true, render: (r) => <MetricText m={r.m.oee.quality} />, sort: (r) => r.m.oee.quality.value },
    { key: 'oee', header: 'OEE', numeric: true, render: (r) => <b><MetricText m={r.m.oee.oee} /></b>, sort: (r) => r.m.oee.oee.value },
    { key: 'down', header: 'Unpl. down', numeric: true, title: 'Unplanned downtime, minutes', render: (r) => fmtInt(r.m.totals.down), sort: (r) => r.m.totals.down },
    { key: 'starved', header: 'Starved', numeric: true, render: (r) => fmtPct(share(r, r.m.totals.starved), 0), sort: (r) => share(r, r.m.totals.starved) },
    { key: 'blocked', header: 'Blocked', numeric: true, render: (r) => fmtPct(share(r, r.m.totals.blocked), 0), sort: (r) => share(r, r.m.totals.blocked) },
    {
      key: 'buf',
      header: 'Input buffer',
      numeric: true,
      title: 'Current fill of the buffer feeding this stage',
      render: (r) => (r.stage.inputBufferLevel == null ? <span className="dim">Raw supply</span> : <BufferLevel v={r.stage.inputBufferLevel} />),
      sort: (r) => r.stage.inputBufferLevel,
    },
  ];
  return (
    <Panel className="col-8" title="Stages & machines" subtitle="Period figures per machine · live state · click a row for the machine drill-down" flush>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.m.id} onRowClick={(r) => onSelect(r.m.id)} selectedKey={selected} maxHeight="none" />
    </Panel>
  );
}

function BufferLevel({ v }: { v: number }) {
  return (
    <span className="prod-buf" title={`${fmtPct(v, 0)} full`}>
      <span className="prod-buf-track">
        <i style={{ width: `${Math.min(100, v * 100)}%` }} />
      </span>
      {fmtPct(v, 0)}
    </span>
  );
}

// ── 7. Bottleneck ────────────────────────────────────────────────────────────

function BottleneckPanel({ ranked, shifted }: { ranked: StageMetrics[]; shifted: boolean }) {
  return (
    <Panel
      className="col-4"
      title="Bottleneck · last 2 h"
      subtitle={shifted ? `Constraint has moved from ${stageName(LINE.designConstraint)}` : `Constraint at ${stageName(LINE.designConstraint)} as designed`}
      footer={
        <span>
          Active-period method: the stage that spent the largest share of planned time working or broken down — rather than starved by upstream or
          blocked by downstream — is the current constraint.
        </span>
      }
    >
      <div className="prod-legend chart-legend">
        <span>
          <i style={{ background: 'var(--series-1)' }} />
          Active
        </span>
        <span>
          <i style={{ background: 'var(--series-2)' }} />
          Starved
        </span>
        <span>
          <i style={{ background: 'var(--series-3)' }} />
          Blocked
        </span>
      </div>
      <div className="prod-bn" role="table" aria-label="Stages ranked by active share">
        {ranked.map((st, i) => (
          <div key={st.stage} className={`prod-bn-row ${i === 0 ? 'top' : ''}`} role="row" title={`Active ${pct(st.activeShare)} · starved ${pct(st.starvedShare)} · blocked ${pct(st.blockedShare)}`}>
            <span className="prod-bn-name">
              {i + 1}. {st.name}
            </span>
            <span className="prod-bn-track">
              <i style={{ width: `${st.activeShare * 100}%`, background: 'var(--series-1)' }} />
              <i style={{ width: `${st.starvedShare * 100}%`, background: 'var(--series-2)' }} />
              <i style={{ width: `${st.blockedShare * 100}%`, background: 'var(--series-3)' }} />
            </span>
            <span className="prod-bn-val">{pct(st.activeShare)}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

// ── 4. Trends ────────────────────────────────────────────────────────────────

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
  // Axis top on a whole-percent step so the five gridlines land on readable values.
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
          <button className="btn sm ghost" onClick={() => go('quality')} title="Open Quality Intelligence for defects, stations and batches">
            Quality <ArrowRight size={12} aria-hidden />
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

// ── 6. Downtime events ───────────────────────────────────────────────────────

type EvRow = { ev: DowntimeEvent; inPeriod: number };

function EventTable({ periodKey, filter, setFilter }: { periodKey: PeriodKey; filter: EventFilter; setFilter: (f: EventFilter) => void }) {
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const all = filterEvents(s, p, filter);
      return { now: s.minute, total: all.length, active: all.filter((e) => e.end == null).length, rows: all.slice(0, EVENT_LIMIT).map((ev): EvRow => ({ ev, inPeriod: clippedDuration(ev, p, s.minute) })) };
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
    { key: 'dur', header: 'Duration', numeric: true, title: 'Total event duration (in-period share in tooltip)', render: (r) => <span title={`${formatDuration(r.inPeriod)} inside the period`}>{formatDuration((r.ev.end ?? d.now) - r.ev.start)}</span>, sort: (r) => (r.ev.end ?? d.now) - r.ev.start },
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
    { key: 'lost', header: 'Lost m²', numeric: true, title: 'Ideal-rate output not made during the event', render: (r) => fmtInt(r.ev.lostTiles * M2_PER_TILE), sort: (r) => r.ev.lostTiles },
    { key: 'impact', header: 'Constraint impact', numeric: true, title: 'Minutes the kiln was starved or blocked while this event was active', render: (r) => (r.ev.constraintImpactMin > 0 ? `${fmtInt(r.ev.constraintImpactMin)} min` : <span className="dim">0 min</span>), sort: (r) => r.ev.constraintImpactMin },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.ev.source} />, sort: (r) => r.ev.source },
  ];
  return (
    <Panel
      className="col-12"
      title="Downtime events"
      subtitle={`${fmtInt(d.total)} events${d.active ? ` · ${d.active} active` : ''} · active first, then newest · click a row to locate the equipment in the Factory Twin`}
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
          <select className="select" aria-label="Machine" value={filter.equipmentId} onChange={(e) => setFilter({ ...filter, equipmentId: e.target.value })}>
            <option value="all">All machines</option>
            {PROCESS_MACHINES.map((id) => (
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
            <input type="checkbox" checked={filter.includeFlow} onChange={(e) => setFilter({ ...filter, includeFlow: e.target.checked, category: !e.target.checked && filter.category !== 'all' && isFlow(filter.category) ? 'all' : filter.category })} />
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
        onRowClick={(r) => openEquipment(r.ev.equipmentId)}
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

// ── 5. Shift performance ─────────────────────────────────────────────────────

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
    { key: 'down', header: 'Unpl. downtime', numeric: true, render: (r) => formatDuration(r.metrics.downtimeMin), sort: (r) => r.metrics.downtimeMin },
  ];
  return (
    <Panel className="col-8" title="Shift performance" subtitle="Last 7 days · newest first · in-progress shift measured to now (target pro-rated)" flush>
      <DataTable columns={cols} rows={rows} rowKey={(r) => `${r.date}-${r.id}`} maxHeight={320} />
    </Panel>
  );
}
