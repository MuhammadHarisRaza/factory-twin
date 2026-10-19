/**
 * Data & connectivity tab of Events & Reports (?tab=data, brief §8 F): the statement that no plant system is
 * connected, the data sources with their honest status (the simulation 'Simulated', every integration 'Not
 * connected'), catalogue coverage per brief stage × availability class × status, coverage per equipment item
 * (searchable), the signals this demo has no value for with the reason, the state-signal freshness of every
 * tracked asset, and the data-quality rule findings. Derivations: ./coverage.ts (pure, tested).
 */
import { useMemo } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, CircleSlash, Clock, Search, X } from 'lucide-react';
import { openEquipment } from '../../app/store';
import { findingsFor, useRuleThresholds } from '../../intel/rules';
import { SOURCE_SYSTEM_LABEL, STAGE9_EQUIPMENT_ID, STAGES_12, type SignalDefinition } from '../../model/catalog';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt } from '../../ui/kit/format';
import { Section } from '../../ui/kit/Page';
import { Segmented } from '../../ui/kit/Panel';
import { StatusBadge, type Tone } from '../../ui/kit/Status';
import type { FreshnessStatus } from '../../calc';
import type { Quality } from '../../calc/types';
import {
  AVAILABILITY_CLASSES,
  BOUNDARY_NOTE,
  FRESHNESS_LABEL,
  GAP_SOURCES,
  GAP_STATUSES,
  NO_PLANT_CONNECTION,
  assetFreshness,
  classCounts,
  classLabel,
  coverageRows,
  equipmentCoverageRows,
  filterEquipmentRows,
  freshnessSummary,
  gapFacets,
  gapSignals,
  gapStatusLabel,
  sourceRows,
  unlistedSystems,
  type ClassFilter,
  type CoverageRow,
  type EquipmentCoverageRow,
  type FeedState,
  type FreshnessRow,
  type GapFilters,
  type SourceRow,
  type StageFilter,
} from './coverage';
import { FindingList } from './FindingList';
import { findingGroup } from './reliability';
import { useDataView } from './state';

const FEED_BADGE: Record<FeedState, { tone: Tone; icon: typeof CircleCheck }> = {
  simulated: { tone: 'warning', icon: CircleDashed },
  stale: { tone: 'critical', icon: Clock },
  issue: { tone: 'warning', icon: CircleAlert },
  none: { tone: 'neutral', icon: CircleSlash },
};
const FRESH_BADGE: Record<FreshnessStatus, { tone: Tone; icon: typeof CircleCheck }> = {
  fresh: { tone: 'good', icon: CircleCheck },
  'event-driven': { tone: 'neutral', icon: CircleDashed },
  late: { tone: 'warning', icon: Clock },
  stale: { tone: 'critical', icon: Clock },
  missing: { tone: 'neutral', icon: CircleSlash },
};
const QUALITY_LABEL: Record<Quality, string> = { good: 'Good', uncertain: 'Uncertain', bad: 'Bad', stale: 'Stale', missing: 'Missing' };

const stageValue = (v: string): StageFilter => (v === 'all' || v === 'support' ? v : (Number(v) as StageFilter));
const count = (n: number) => (n ? <span className="num">{fmtInt(n)}</span> : <span className="num dim">0</span>);

function StageSelect({ value, onChange, counts, label }: { value: StageFilter; onChange: (v: StageFilter) => void; counts?: Record<string, number>; label: string }) {
  const c = (k: string) => (counts ? ` (${counts[k] ?? 0})` : '');
  return (
    <select className="select" value={String(value)} onChange={(e) => onChange(stageValue(e.target.value))} aria-label={label}>
      <option value="all">All stages{c('all')}</option>
      {STAGES_12.map((st) => (
        <option key={st.no} value={st.no}>
          {st.no} · {st.name}
          {c(String(st.no))}
        </option>
      ))}
      <option value="support">Support (no stage){c('support')}</option>
    </select>
  );
}

function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <label className="evp-search">
      <Search size={14} aria-hidden />
      <input className="input" type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-label={label} />
      {value && (
        <button className="btn ghost sm icon" onClick={() => onChange('')} aria-label="Clear search">
          <X size={13} />
        </button>
      )}
    </label>
  );
}

const SOURCES = sourceRows();
const UNLISTED = unlistedSystems();
const CLASS_COUNTS = classCounts();

const sourceColumns: Column<SourceRow>[] = [
  {
    key: 'name',
    header: 'Source',
    render: (r) => (
      <span className="dv-wrap">
        <b>{r.name}</b>
        <span className="dv-sub">{r.description}</span>
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) =>
      r.status === 'simulated' ? <StatusBadge tone="warning" icon={CircleDashed} label="Simulated" /> : <StatusBadge tone="neutral" icon={CircleSlash} label="Not connected" />,
  },
  { key: 'protocol', header: 'Protocol', render: (r) => r.protocol },
  {
    key: 'signals',
    header: 'Catalogue entries',
    numeric: true,
    title: 'Simulation: the entries it simulates · other sources: entries of the source systems it stands for',
    render: (r) => (r.signals ? <span className="num">{fmtInt(r.signals.total)}</span> : <span className="muted">none mapped</span>),
  },
  { key: 'boundary', header: 'Integration boundary', render: (r) => <span className="dv-sub">{r.boundary}</span> },
];

const coverageColumns: Column<CoverageRow>[] = [
  {
    key: 'stage',
    header: 'Stage',
    render: (r) => (
      <span className="dv-wrap">
        <b>{r.no != null ? `${r.no} · ${r.name}` : r.name}</b>
        {r.present !== 'yes' && r.presentLabel && <span className={`dv-sub ${r.present === 'no' ? 'dv-flag' : ''}`}>{r.presentLabel}</span>}
        {r.note && <span className="dv-sub">{r.note}</span>}
      </span>
    ),
  },
  { key: 'total', header: 'Entries', numeric: true, render: (r) => count(r.total) },
  { key: 'sim', header: 'Simulated', numeric: true, render: (r) => count(r.simulated) },
  { key: 'nm', header: 'Not modelled', numeric: true, render: (r) => count(r.notModelled) },
  { key: 'un', header: 'Unavailable', numeric: true, render: (r) => count(r.unavailable) },
  { key: 'ref', header: 'Reference', numeric: true, title: 'Reference data (master data, specifications), not a live signal', render: (r) => count(r.reference) },
];

const freshColumns: Column<FreshnessRow>[] = [
  {
    key: 'asset',
    header: 'Asset',
    render: (r) => (
      <button className="row-link" onClick={() => openEquipment(r.id)} title="Open the equipment panel in the Factory Twin">
        {r.id} · {r.name}
      </button>
    ),
    sort: (r) => r.id,
  },
  { key: 'signal', header: 'State signal', render: (r) => <span className="mono">{r.signalId}</span> },
  { key: 'value', header: 'Value', render: (r) => r.text || <span className="muted">no value</span> },
  { key: 'ts', header: 'Timestamp', render: (r) => (r.timestamp != null ? formatClock(r.timestamp) : <span className="muted">none received</span>), sort: (r) => r.timestamp },
  { key: 'q', header: 'Quality', render: (r) => <span className={r.quality === 'good' ? '' : 'dv-flag'}>{QUALITY_LABEL[r.quality]}</span>, sort: (r) => r.quality },
  {
    key: 'status',
    header: 'Freshness',
    render: (r) => <StatusBadge {...FRESH_BADGE[r.status]} label={FRESHNESS_LABEL[r.status]} />,
    sort: (r) => r.status,
  },
  { key: 'since', header: 'Stale since', render: (r) => (r.staleSince != null ? formatClock(r.staleSince) : <span className="muted">—</span>), sort: (r) => r.staleSince },
];

const gapColumns: Column<SignalDefinition>[] = [
  {
    key: 'signal',
    header: 'Signal',
    render: (d) => (
      <span className="dv-wrap">
        <b>{d.name}</b>
        <span className="mono dv-sub">{d.signalId}</span>
      </span>
    ),
    sort: (d) => d.signalId,
  },
  { key: 'stage', header: 'Stage', render: (d) => (d.stage != null ? d.stage : <span className="muted">support</span>), sort: (d) => d.stage ?? 99 },
  { key: 'cls', header: 'Class', render: (d) => classLabel(d.availabilityClass), sort: (d) => d.availabilityClass },
  {
    key: 'status',
    header: 'Status',
    render: (d) => <StatusBadge tone="neutral" icon={CircleSlash} label={gapStatusLabel(d.availabilityStatus as 'not-modelled' | 'unavailable')} />,
    sort: (d) => d.availabilityStatus,
  },
  { key: 'src', header: 'Source system', render: (d) => SOURCE_SYSTEM_LABEL[d.sourceSystem], sort: (d) => SOURCE_SYSTEM_LABEL[d.sourceSystem] },
  { key: 'note', header: 'Why', render: (d) => <span className="dv-sub">{d.statusNote ?? 'No status note in the catalogue'}</span> },
];

export function DataView() {
  const v = useDataView();
  const thresholds = useRuleThresholds((t) => t.version);
  const live = useSimValue(
    (s) => {
      const fresh = assetFreshness(s);
      return {
        equipment: equipmentCoverageRows(s),
        fresh,
        freshSum: freshnessSummary(fresh),
        dq: findingGroup(findingsFor(s, { kind: 'plant' }), 'data'),
      };
    },
    [thresholds],
  );
  const matrix = useMemo(() => coverageRows(v.cls), [v.cls]);
  const equipment = useMemo(() => filterEquipmentRows(live.equipment, { query: v.equipmentQuery, stage: v.equipmentStage }), [live.equipment, v.equipmentQuery, v.equipmentStage]);
  const gaps = useMemo(() => gapSignals(v.gaps), [v.gaps]);
  const facets = useMemo(() => gapFacets(v.gaps), [v.gaps]);
  const setGaps = (p: Partial<GapFilters>) => v.setGaps(p);

  const equipmentColumns: Column<EquipmentCoverageRow>[] = [
    {
      key: 'asset',
      header: 'Equipment',
      render: (r) =>
        r.id !== STAGE9_EQUIPMENT_ID ? (
          <button className="row-link" onClick={() => openEquipment(r.id)} title="Open the equipment panel in the Factory Twin">
            {r.id} · {r.name}
          </button>
        ) : (
          <span>
            {r.id} · {r.name}
          </span>
        ),
      sort: (r) => r.id,
    },
    { key: 'stage', header: 'Stage', render: (r) => r.stageName, sort: (r) => r.stageNo ?? 99 },
    { key: 'sim', header: 'Simulated', numeric: true, render: (r) => count(r.simulated), sort: (r) => r.simulated },
    { key: 'nm', header: 'Not modelled', numeric: true, render: (r) => count(r.notModelled), sort: (r) => r.notModelled },
    { key: 'un', header: 'Unavailable', numeric: true, render: (r) => count(r.unavailable), sort: (r) => r.unavailable },
    {
      key: 'last',
      header: 'Last update',
      render: (r) => (r.lastUpdate != null ? formatClock(r.lastUpdate) : <span className="muted">none received</span>),
      sort: (r) => r.lastUpdate,
    },
    { key: 'feed', header: 'Feed', render: (r) => <StatusBadge {...FEED_BADGE[r.feed]} label={r.feedLabel} />, sort: (r) => r.feed },
    {
      key: 'gaps',
      header: '',
      render: (r) =>
        r.notModelled + r.unavailable > 0 ? (
          <button className="btn ghost sm" onClick={() => setGaps({ equipmentId: r.id })} title="List this equipment's missing signals below">
            Missing signals
          </button>
        ) : null,
    },
  ];

  const total = matrix.total;
  return (
    <div className="dv">
      <div className="notice dv-statement" role="note">
        <CircleSlash size={15} aria-hidden />
        <span>
          <b>{NO_PLANT_CONNECTION}</b> {BOUNDARY_NOTE}
        </span>
      </div>

      <Section title="Data sources" subtitle={`1 simulated source · ${SOURCES.length - 1} integrations not connected in this release`} flush>
        <DataTable columns={sourceColumns} rows={SOURCES} rowKey={(r) => r.id} maxHeight="none" />
        {UNLISTED.length > 0 && (
          <p className="dv-foot">
            Catalogue source systems without a declared data source: {UNLISTED.map((u) => `${u.label} (${u.signals.total} entries)`).join(' · ')} — not connected.
          </p>
        )}
      </Section>

      <Section
        title="Signal catalogue coverage by stage"
        subtitle={`${fmtInt(total.total)} entries · ${fmtInt(total.simulated)} simulated · ${fmtInt(total.notModelled)} not modelled · ${fmtInt(total.unavailable)} unavailable · ${fmtInt(total.reference)} reference · none connected`}
        actions={
          <Segmented<ClassFilter>
            label="Availability class"
            value={v.cls}
            options={[
              { value: 'all', label: `All (${CLASS_COUNTS.all})` },
              ...AVAILABILITY_CLASSES.map((c) => ({ value: c as ClassFilter, label: `${classLabel(c)} (${CLASS_COUNTS[c]})` })),
            ]}
            onChange={(cls) => v.set({ cls })}
          />
        }
        flush
      >
        <DataTable columns={coverageColumns} rows={[...matrix.rows, total]} rowKey={(r) => r.key} maxHeight="none" />
      </Section>

      <Section
        title="Coverage per equipment"
        subtitle={`${equipment.length} of ${live.equipment.length} equipment items · counts from the catalogue, last update and feed from the simulated readings`}
        flush
      >
        <div className="evp-filters dv-filters" role="search" aria-label="Filter equipment">
          <SearchBox value={v.equipmentQuery} onChange={(equipmentQuery) => v.set({ equipmentQuery })} placeholder="Search id or name…" label="Search equipment by id or name" />
          <StageSelect value={v.equipmentStage} onChange={(equipmentStage) => v.set({ equipmentStage })} label="Equipment stage" />
        </div>
        <DataTable columns={equipmentColumns} rows={equipment} rowKey={(r) => r.id} maxHeight={380} empty="No equipment matches the search" />
      </Section>

      <Section
        title="Signals without a value in this demo"
        subtitle={`${gaps.length} catalogue entr${gaps.length === 1 ? 'y' : 'ies'} · not modelled by the simulation, or unavailable without an integration — each with its catalogue note`}
        flush
      >
        <div className="evp-filters dv-filters" role="search" aria-label="Filter signals without a value">
          <SearchBox value={v.gaps.query} onChange={(query) => setGaps({ query })} placeholder="Search signal, name or note…" label="Search signals without a value" />
          <StageSelect value={v.gaps.stage} onChange={(stage) => setGaps({ stage })} counts={facets.stage} label="Signal stage" />
          <select className="select" value={v.gaps.cls} onChange={(e) => setGaps({ cls: e.target.value as ClassFilter })} aria-label="Availability class">
            <option value="all">All classes ({facets.cls.all})</option>
            {AVAILABILITY_CLASSES.map((c) => (
              <option key={c} value={c}>
                {classLabel(c)} ({facets.cls[c]})
              </option>
            ))}
          </select>
          <select className="select" value={v.gaps.status} onChange={(e) => setGaps({ status: e.target.value as GapFilters['status'] })} aria-label="Availability status">
            <option value="all">Not modelled & unavailable ({facets.status.all})</option>
            {GAP_STATUSES.map((st) => (
              <option key={st} value={st}>
                {gapStatusLabel(st)} ({facets.status[st]})
              </option>
            ))}
          </select>
          <select className="select" value={v.gaps.source} onChange={(e) => setGaps({ source: e.target.value as GapFilters['source'] })} aria-label="Source system">
            <option value="all">All source systems ({facets.source.all})</option>
            {GAP_SOURCES.map((x) => (
              <option key={x} value={x}>
                {SOURCE_SYSTEM_LABEL[x]} ({facets.source[x] ?? 0})
              </option>
            ))}
          </select>
          {v.gaps.equipmentId && (
            <button className="btn ghost sm" onClick={() => setGaps({ equipmentId: null })} aria-label="Show the signals of every equipment item">
              <X size={12} aria-hidden /> Only {v.gaps.equipmentId}
            </button>
          )}
        </div>
        <DataTable columns={gapColumns} rows={gaps} rowKey={(d) => d.signalId} maxHeight={420} empty="No catalogue entry matches these filters" />
      </Section>

      <div className="rel-grid">
        <Section
          title="Asset feed freshness"
          subtitle={`State signal of each tracked asset, judged from its delivered timestamp · ${live.freshSum.fresh} fresh · ${live.freshSum.late} late · ${live.freshSum.stale} stale · ${live.freshSum.missing} without a value${live.freshSum.bad ? ` · ${live.freshSum.bad} flagged bad` : ''}`}
          flush
        >
          <DataTable columns={freshColumns} rows={live.fresh} rowKey={(r) => r.id} maxHeight={380} initialSort={{ key: 'status', dir: 'desc' }} />
        </Section>
        <Section
          title="Data-quality findings"
          subtitle={`${live.dq.fired} detected · ${live.dq.insufficient} not evaluated · ${live.dq.clear} clear — data-quality rules on the simulated readings`}
        >
          <FindingList findings={live.dq.shown} empty="No data-quality rule has detected anything now" limit={10} />
        </Section>
      </div>
    </div>
  );
}
