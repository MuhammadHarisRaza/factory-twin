/**
 * Analysis (secondary): one engineering view at a time — equipment-level OEE drill-down, the capacity
 * waterfall with its basis, the downtime Pareto with the raw stop records, the shift comparison, and
 * the financial assumptions with the what-if estimates. Same simulation state and period as the
 * other tabs.
 */
import { useState } from 'react';
import { OctagonX, X } from 'lucide-react';
import { openEquipment, useApp } from '../../app/store';
import { CONVEYOR_IDS, DOWNTIME_REASONS, M2_PER_TILE, PROCESS_MACHINES } from '../../model/plant';
import type { DowntimeCategory, DowntimeEvent } from '../../model/types';
import { scenariosActive, type SimState } from '../../sim/engine';
import type { FinanceAssumptions } from '../../sim/finance';
import { clippedDuration, downtimePareto, machineMetrics, resolvePeriod, shiftHistory, type Period, type PeriodKey, type ShiftRow } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDay, formatDuration } from '../../sim/time';
import { ColumnChart, RankedBars, TipRow } from '../../ui/kit/charts';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt, fmtPct, pct } from '../../ui/kit/format';
import { Disclosure, EmptyState } from '../../ui/kit/Page';
import { Segmented } from '../../ui/kit/Panel';
import { MetricText, SourceTag, StatusBadge } from '../../ui/kit/Status';
import { CapacityWaterfall, WATERFALL_LEGEND } from './CapacityWaterfall';
import { Block, EstTag, assetName, canDrill, m2 } from './common';
import { filterEvents, filteredPareto, isFlow, reasonLabel, withIncludeFlow, type EventFilter } from './derive';
import { EquipmentView } from './EquipmentView';
import { FinancePanel } from './FinancePanel';
import { BaselinePanel, ImprovementPanel } from './Improvements';
import { capacitySteps, contributionParts, equipmentContribution, fmtMoney, lossLedger, type Contribution, type LossLedger, type LossRow } from './loss';
import { ANALYSIS_VIEWS, useProductionUi } from './ui';

/** Header summary of the Analysis tab: the capacity gap, the largest downtime reason and the lowest machine OEE. */
export function analysisSummary(s: SimState, p: Period, f: FinanceAssumptions): string {
  const L = lossLedger(s, p, f);
  if (L.calendarMin <= 0) return 'No production time in this period yet.';
  const top = downtimePareto(s, p)[0];
  const low = PROCESS_MACHINES.map((id) => machineMetrics(s, id, p))
    .filter((m) => m.oee.oee.status === 'ok')
    .sort((a, b) => a.oee.oee.value! - b.oee.oee.value!)[0];
  return [
    `Capacity gap ${fmtInt(L.capacityGapM2)} m² (theoretical − good, ${fmtPct(L.theoreticalM2 > 0 ? L.capacityGapM2 / L.theoreticalM2 : null)} of design capacity).`,
    top ? `Largest downtime reason: ${top.label.charAt(0).toLowerCase()}${top.label.slice(1)}, ${fmtInt(top.minutes)} min of machine time.` : 'No unplanned stop in the period.',
    low ? `Lowest machine OEE: ${low.id} · ${low.name}, ${fmtPct(low.oee.oee.value)}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function AnalysisTab({ periodKey, asset, onAsset }: { periodKey: PeriodKey; asset: string | null; onAsset: (id: string) => void }) {
  const view = useProductionUi((s) => s.analysis);
  const setView = useProductionUi((s) => s.setAnalysis);
  return (
    <>
      <div className="prod-subnav">
        <Segmented label="Analysis view" value={view} options={ANALYSIS_VIEWS} onChange={setView} />
      </div>
      {view === 'equipment' && <EquipmentAnalysis periodKey={periodKey} asset={asset} onAsset={onAsset} />}
      {view === 'capacity' && <CapacityAnalysis periodKey={periodKey} />}
      {view === 'downtime' && <DowntimeAnalysis periodKey={periodKey} onAsset={onAsset} />}
      {view === 'shifts' && <ShiftComparison />}
      {view === 'finance' && <FinanceAnalysis periodKey={periodKey} />}
    </>
  );
}

// ── Equipment OEE drill-down ─────────────────────────────────────────────────

export function EquipmentAnalysis({ periodKey, asset, onAsset }: { periodKey: PeriodKey; asset: string | null; onAsset: (id: string) => void }) {
  const finance = useApp((s) => s.finance);
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const L = lossLedger(s, p, finance);
      return { p, L, contributions: equipmentContribution(s, p, L) };
    },
    [periodKey, finance],
  );
  return (
    <>
      <EquipmentView periodKey={periodKey} selected={asset} onAsset={onAsset} />
      <ContributionBlock contributions={d.contributions} total={d.L.outputLossM2} onAsset={onAsset} periodLabel={d.p.label} />
    </>
  );
}

function ContributionBlock({ contributions, total, onAsset, periodLabel }: { contributions: Contribution[]; total: number; onAsset: (id: string) => void; periodLabel: string }) {
  const top = contributions.slice(0, 10);
  return (
    <Block
      title="Loss at the kiln by causing asset"
      subtitle={`Unplanned losses at the line constraint charged to the asset that caused them · ${m2(total)} · ${periodLabel} · select an asset for its drill-down`}
      note={
        <span>
          The kiln carries its own downtime and speed loss; the root asset of each held-up kiln minute (from event records) carries that minute; rejects go to the defect’s
          modeled origin stage. The parts add up to the line loss — a lost tile is never counted twice.
        </span>
      }
    >
      {top.length ? (
        <RankedBars
          labelHeader="Asset"
          valueHeader="m²"
          showCumulative={false}
          rows={top.map((c) => ({
            key: c.key,
            label: (
              <span title={contributionParts(c)}>
                {c.equipmentId ? <span className="mono">{c.equipmentId}</span> : null} <span className="dim">{c.label}</span>
              </span>
            ),
            value: c.m2,
            share: total > 0 ? c.m2 / total : 0,
          }))}
          format={fmtInt}
          onSelect={(r) => {
            const c = contributions.find((x) => x.key === r.key);
            if (c?.equipmentId) (canDrill(c.equipmentId) ? onAsset : openEquipment)(c.equipmentId);
          }}
        />
      ) : (
        <EmptyState title="No unplanned losses at the kiln">Nothing held the constraint back in this period.</EmptyState>
      )}
    </Block>
  );
}

// ── Capacity waterfall ───────────────────────────────────────────────────────

function LedgerRow({ r, cur }: { r: LossRow; cur: string }) {
  return (
    <tr>
      <td>{r.label}</td>
      <td className="n">{r.m2 == null ? <span className="muted">—</span> : fmtInt(r.m2)}</td>
      <td className="n">{r.minutes == null ? <span className="muted">—</span> : fmtInt(r.minutes)}</td>
      <td className="n">{r.money == null ? <span className="muted">Not valued</span> : fmtMoney(r.money, cur)}</td>
      <td className="wrap prod-basis">
        {r.basis}
        <span className="muted"> · {r.valuation}</span>
      </td>
    </tr>
  );
}

export function CapacityAnalysis({ periodKey }: { periodKey: PeriodKey }) {
  const finance = useApp((s) => s.finance);
  const cur = finance.currency;
  const [sel, setSel] = useState<string | null>(null);
  const L: LossLedger = useSimValue((s) => lossLedger(s, resolvePeriod(periodKey, s.minute), finance), [periodKey, finance]);
  const steps = capacitySteps(L);
  const output = L.rows.filter((r) => r.kind === 'output');
  const other = L.rows.filter((r) => r.kind !== 'output');
  return (
    <Block
      title="Capacity waterfall"
      subtitle={`${L.period.label} · theoretical capacity → planned stops → losses at the kiln → fired → rejects → good output · m² · select a bar for its basis`}
      actions={<EstTag />}
      note={
        <span>
          The capacity gap ({m2(L.capacityGapM2)}) is theoretical − good. Theoretical capacity is a ceiling, not revenue: the plan already allows {m2(L.allowanceM2)} for normal
          losses, and only the shortfall to plan enters the financial impact ({fmtMoney(L.impact.total, cur)}, estimate).
        </span>
      }
    >
      <div className="chart-legend">
        {WATERFALL_LEGEND.map((l) => (
          <span key={l.key}>
            <i style={{ background: l.swatch }} />
            {l.label}
          </span>
        ))}
        <span>
          <i className="dash" />
          Plan
        </span>
        <span>
          <i className="prod-gap-swatch" />
          Capacity gap
        </span>
      </div>
      {L.calendarMin > 0 ? (
        <CapacityWaterfall steps={steps} plan={L.plannedM2} selectedKey={sel} onSelect={setSel} />
      ) : (
        <EmptyState title="No production time in this period yet" />
      )}
      {sel && (
        <p className="prod-wf-basis" role="status">
          <b>{steps.find((x) => x.key === sel)?.label.replace('\n', ' ')}:</b> {steps.find((x) => x.key === sel)?.basis}
        </p>
      )}
      <Disclosure title="Loss ledger — basis, valuation and assumptions" meta={`${L.rows.length} rows`}>
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table className="table prod-loss-table">
            <thead>
              <tr>
                <th>Loss category</th>
                <th className="n" title="m² of tile at the line constraint">m²</th>
                <th className="n" title="Kiln minutes (truck minutes for logistics)">Min</th>
                <th className="n">Est. value</th>
                <th>How it is measured · how it is valued</th>
              </tr>
            </thead>
            <tbody>
              {output.map((r) => (
                <LedgerRow key={r.key} r={r} cur={cur} />
              ))}
              <tr className="prod-subtotal">
                <td>Unplanned losses at the kiln</td>
                <td className="n">{fmtInt(L.outputLossM2)}</td>
                <td className="n" />
                <td className="n">{fmtMoney(L.outputMoney, cur)}</td>
                <td className="wrap prod-basis">vs the design rate · {fmtPct(L.theoreticalM2 > 0 ? L.outputLossM2 / L.theoreticalM2 : null, 1)} of theoretical capacity</td>
              </tr>
              {other.map((r) => (
                <LedgerRow key={r.key} r={r} cur={cur} />
              ))}
              <tr className="prod-subtotal">
                <td>Financial impact against the plan</td>
                <td className="n">{L.impact.shortfallM2 > 0.5 ? fmtInt(L.impact.shortfallM2) : '0'}</td>
                <td className="n" />
                <td className="n">{fmtMoney(L.impact.total, cur)}</td>
                <td className="wrap prod-basis">Shortfall of good output vs plan + direct costs of the period (estimate)</td>
              </tr>
              {L.impact.lines.map((l) => (
                <tr key={l.label}>
                  <td className="prod-indent">{l.label}</td>
                  <td className="n" />
                  <td className="n" />
                  <td className="n">{fmtMoney(l.amount, cur)}</td>
                  <td className="wrap prod-basis">{l.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="prod-notes">
          <h4>Assumptions</h4>
          <ul>
            {L.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          <h4>Not connected (shown as assumptions instead)</h4>
          <ul>
            {L.missing.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </Disclosure>
    </Block>
  );
}

// ── Downtime Pareto + raw stop records ───────────────────────────────────────

const CATEGORIES: DowntimeCategory[] = ['Mechanical', 'Electrical & control', 'Process', 'Changeover', 'Planned', 'Starved', 'Blocked'];
const ASSETS = [...PROCESS_MACHINES, ...CONVEYOR_IDS];
const EVENT_LIMIT = 400;

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

type EvRow = { ev: DowntimeEvent; inPeriod: number };

export function DowntimeAnalysis({ periodKey, onAsset }: { periodKey: PeriodKey; onAsset: (id: string) => void }) {
  const [filter, setFilter] = useState<EventFilter>({ category: 'all', equipmentId: 'all', reason: null, includeFlow: false });
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const all = filterEvents(s, p, filter);
      return {
        p,
        now: s.minute,
        pareto: filteredPareto(s, p, filter),
        total: all.length,
        active: all.filter((e) => e.end == null).length,
        rows: all.slice(0, EVENT_LIMIT).map((ev): EvRow => ({ ev, inPeriod: clippedDuration(ev, p, s.minute) })),
      };
    },
    [periodKey, filter],
  );
  const top = d.pareto.slice(0, 10);
  const minutes = d.pareto.reduce((a, r) => a + r.minutes, 0);
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
      title: 'Total record duration (in-period share in the tooltip)',
      render: (r) => <span title={`${formatDuration(r.inPeriod)} inside the period`}>{formatDuration((r.ev.end ?? d.now) - r.ev.start)}</span>,
      sort: (r) => (r.ev.end ?? d.now) - r.ev.start,
    },
    {
      key: 'eq',
      header: 'Equipment',
      render: (r) => (
        <>
          <span className="mono">{r.ev.equipmentId}</span>
          <span className="sub">{assetName(r.ev.equipmentId)}</span>
        </>
      ),
      sort: (r) => r.ev.equipmentId,
    },
    { key: 'reason', header: 'Reason', render: (r) => reasonLabel(r.ev.reasonCode), sort: (r) => reasonLabel(r.ev.reasonCode) },
    { key: 'cat', header: 'Category', render: (r) => <span className="muted">{r.ev.category}</span>, sort: (r) => r.ev.category },
    { key: 'lost', header: 'Own lost m²', numeric: true, title: 'Ideal-rate output this asset did not make during the stop (asset level, not additive)', render: (r) => fmtInt(r.ev.lostTiles * M2_PER_TILE), sort: (r) => r.ev.lostTiles },
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
    <>
      <Block
        title="Downtime Pareto"
        subtitle={`By reason · ${fmtInt(minutes)} min of machine time${d.pareto.length > top.length ? ` · top ${top.length} of ${d.pareto.length}` : ''} · ${d.p.label} · select a reason to filter the records`}
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
        note={<span>Machine minutes across all assets (simulated records). A stop costs line output only where it held up the kiln — see “Kiln held” in the records.</span>}
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
          <EmptyState title="No downtime losses">No stoppage matches this filter in the period.</EmptyState>
        )}
      </Block>
      <Block
        title="Downtime records"
        subtitle={`${fmtInt(d.total)} records${d.active ? ` · ${d.active} active` : ''} · active first, then newest · select a row for the equipment drill-down`}
        actions={
          <div className="prod-actions">
            {filter.reason && (
              <span className="prod-chip">
                Reason: {reasonLabel(filter.reason)}
                <button type="button" className="btn ghost sm icon" onClick={() => setFilter({ ...filter, reason: null })} aria-label="Clear the reason filter" title="Clear the reason filter">
                  <X size={12} />
                </button>
              </span>
            )}
            <select className="select" aria-label="Equipment" value={filter.equipmentId} onChange={(e) => setFilter({ ...filter, equipmentId: e.target.value })}>
              <option value="all">All equipment</option>
              {ASSETS.map((id) => (
                <option key={id} value={id}>
                  {id} · {assetName(id)}
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
            {dirty && (
              <button type="button" className="btn ghost sm" onClick={() => setFilter({ ...filter, category: 'all', equipmentId: 'all', reason: null })}>
                Clear filters
              </button>
            )}
          </div>
        }
        flush
      >
        <Disclosure title="Show the raw stop records" meta={`${fmtInt(d.total)} in the period`}>
          <DataTable
            columns={cols}
            rows={d.rows}
            rowKey={(r) => r.ev.id}
            onRowClick={(r) => onAsset(r.ev.equipmentId)}
            maxHeight={420}
            empty="No downtime records match the filters in this period"
            footer={
              d.total > d.rows.length ? (
                <tfoot>
                  <tr>
                    <td colSpan={cols.length}>
                      Showing the {fmtInt(d.rows.length)} most recent of {fmtInt(d.total)} records — narrow the filters to see older ones.
                    </td>
                  </tr>
                </tfoot>
              ) : undefined
            }
          />
        </Disclosure>
      </Block>
    </>
  );
}

// ── Shift comparison ─────────────────────────────────────────────────────────

export function ShiftComparison() {
  const rows = useSimValue((s) => shiftHistory(s));
  const chrono = [...rows].reverse();
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
    { key: 'out', header: 'Good m²', numeric: true, render: (r) => fmtInt(r.metrics.outputM2), sort: (r) => r.metrics.outputM2 },
    { key: 'target', header: 'Plan m²', numeric: true, render: (r) => fmtInt(r.metrics.targetM2), sort: (r) => r.metrics.targetM2 },
    {
      key: 'att',
      header: 'Attainment',
      numeric: true,
      render: (r) => <span className={r.metrics.attainment != null && r.metrics.attainment < 0.9 ? 'prod-under' : ''}>{fmtPct(r.metrics.attainment, 0)}</span>,
      sort: (r) => r.metrics.attainment,
    },
    { key: 'oee', header: 'Line OEE', numeric: true, render: (r) => <MetricText m={r.metrics.oee.oee} />, sort: (r) => r.metrics.oee.oee.value },
    { key: 'a', header: 'A', numeric: true, title: 'Availability at the kiln', render: (r) => <MetricText m={r.metrics.oee.availability} />, sort: (r) => r.metrics.oee.availability.value },
    { key: 'p', header: 'P', numeric: true, title: 'Performance at the kiln', render: (r) => <MetricText m={r.metrics.oee.performance} />, sort: (r) => r.metrics.oee.performance.value },
    { key: 'q', header: 'Q', numeric: true, title: 'First-pass quality at sorting', render: (r) => <MetricText m={r.metrics.oee.quality} />, sort: (r) => r.metrics.oee.quality.value },
    { key: 'down', header: 'Unpl. downtime', numeric: true, title: 'Unplanned stops summed over all process machines (machine time)', render: (r) => formatDuration(r.metrics.downtimeMin), sort: (r) => r.metrics.downtimeMin },
  ];
  const complete = rows.filter((r) => r.complete && r.metrics.attainment != null);
  const best = [...complete].sort((a, b) => b.metrics.attainment! - a.metrics.attainment!)[0];
  const worst = [...complete].sort((a, b) => a.metrics.attainment! - b.metrics.attainment!)[0];
  return (
    <Block
      title="Shift comparison"
      subtitle={`Good output vs plan per shift · last 7 days · in-progress shift measured to now${best && worst ? ` · best ${formatDay(best.start)} ${best.id} (${pct(best.metrics.attainment!)}), lowest ${formatDay(worst.start)} ${worst.id} (${pct(worst.metrics.attainment!)})` : ''}`}
      note={<span>Every shift uses the same definitions as the other tabs: plan per planned hour, OEE at the kiln × first-pass quality at sorting.</span>}
    >
      <ColumnChart
        height={220}
        data={chrono.map((r) => ({ key: `${r.date}-${r.id}`, label: `${formatDay(r.start).split(' ')[0].replace(',', '')} ${r.id}`, value: r.metrics.outputM2, target: r.metrics.targetM2, muted: !r.complete }))}
        format={fmtInt}
        tickEvery={Math.max(1, Math.ceil(chrono.length / 10))}
        tip={(c) => {
          const r = chrono.find((x) => `${x.date}-${x.id}` === c.key)!;
          return (
            <>
              <b>
                {formatDay(r.start)} · {r.label}
                {!r.complete ? ' (in progress)' : ''}
              </b>
              <TipRow k="Good output" v={`${fmtInt(r.metrics.outputM2)} m²`} swatch="var(--series-1)" />
              <TipRow k="Plan" v={`${fmtInt(r.metrics.targetM2)} m²`} />
              <TipRow k="Attainment" v={fmtPct(r.metrics.attainment, 0)} />
              <TipRow k="Line OEE" v={r.metrics.oee.oee.status === 'ok' ? fmtPct(r.metrics.oee.oee.value) : '—'} />
            </>
          );
        }}
      />
      <Disclosure title="Shift table" meta={`${rows.length} shifts`}>
        <DataTable columns={cols} rows={rows} rowKey={(r) => `${r.date}-${r.id}`} maxHeight={320} />
      </Disclosure>
    </Block>
  );
}

// ── Assumptions & what-ifs ───────────────────────────────────────────────────

export function FinanceAnalysis({ periodKey }: { periodKey: PeriodKey }) {
  const finance = useApp((s) => s.finance);
  const [comparing, setComparing] = useState(false);
  const d = useSimValue(
    (s) => ({ L: lossLedger(s, resolvePeriod(periodKey, s.minute), finance), scenarioCount: s.scenarios.length, activeScenarios: scenariosActive(s).length }),
    [periodKey, finance],
  );
  const showBaseline = comparing && d.scenarioCount > 0;
  return (
    <>
      <div className="prod-fin-row">
        <FinancePanel />
        <ImprovementPanel L={d.L} scenarioCount={d.scenarioCount} activeScenarios={d.activeScenarios} comparing={showBaseline} onCompare={setComparing} />
      </div>
      {showBaseline && <BaselinePanel periodKey={periodKey} />}
    </>
  );
}
