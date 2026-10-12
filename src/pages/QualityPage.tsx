/**
 * Quality & Defects — an evidence-led quality workflow over the simulated inspection records.
 *
 *   header + data-driven summary → four quality KPIs → defect investigation (list of quality events
 *   and defect records · the selected item's evidence) → reject-rate trend
 *
 * The selected event or record is the route (#/quality/<event or record id>): a user's pick adds a
 * history step; arriving without one opens the newest relevant quality event (rewriting the entry).
 * Raw inspection history and the station / batch / cost tables are secondary tabs.
 *
 * Records, classes, boxes and confidences come from deterministic simulation rules — no camera or
 * vision model runs. Reference videos illustrate the inspection type only.
 */
import { useCallback, useEffect, useState } from 'react';
import { MessageSquareText, ScanSearch } from 'lucide-react';
import { useApp, type NavMode } from '../app/store';
import { qualityKpis, type KpiModel } from '../intel/kpis';
import { DEFECTS } from '../model/plant';
import type { DefectCategory } from '../model/types';
import { resolvePeriod } from '../sim/metrics';
import { useSim, useSimValue } from '../sim/store';
import { EmptyState, KpiCard, KpiRow, PageHeader, ProvenanceBadge, Tabs, kpiCardProps, useWorkspaceTab } from '../ui/kit/Page';
import { inspectionEventLinks, qualityEventsIn } from './quality/derive';
import { DefectEvidence } from './quality/DefectEvidence';
import { DefectList } from './quality/DefectList';
import { affectingScenario } from './quality/frames';
import { defaultSelection, defectList, inPeriod, qualitySummary, rateTrend, summaryText } from './quality/investigate';
import { RateTrend } from './quality/RateTrend';
import { NO_FILTERS, RecordsTab, type RecordFilters } from './quality/RecordsTab';
import { StationsTab } from './quality/StationsTab';
// Registers the inspection-image rasteriser (reports and the PDF draw the same frames).
import './quality/rasterise';
import './quality/quality.css';

const TABS = ['investigate', 'records', 'stations'] as const;
type Tab = (typeof TABS)[number];
const RECORD_PAGE = 10;


export function QualityPage() {
  // Reset Demo replays the plant and ids restart: filters and the list refer to the discarded run.
  const resets = useSim((s) => s.resets);
  return <QualityWorkspace key={resets} />;
}

function QualityWorkspace() {
  const periodKey = useApp((s) => s.period);
  const routeId = useApp((s) => s.qualityEventId);
  const onPage = useApp((s) => s.workspace === 'quality');
  const openCopilot = useApp((s) => s.openCopilot);
  const [tab, setTab] = useWorkspaceTab<Tab>('quality', 'investigate', TABS);
  const [defect, setDefect] = useState<DefectCategory | null>(null);
  const [recordLimit, setRecordLimit] = useState(RECORD_PAGE);
  const [filters, setFilters] = useState<RecordFilters>(NO_FILTERS);

  const data = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const links = inspectionEventLinks(s);
      const events = qualityEventsIn(s, p);
      const summary = qualitySummary(s, p, events);
      const list = defectList(s, p, { defect, recordLimit }, links, events);
      const focus = summary.rising ? { defect: summary.rising.defect, why: 'rising' as const } : summary.top ? { defect: summary.top.defect, why: 'most frequent' as const } : null;
      return {
        p,
        now: s.minute,
        kpis: qualityKpis(s, p),
        summary,
        list,
        scenarioRecords: new Set(list.records.filter((r) => affectingScenario(s, r)).map((r) => r.id)),
        fallback: defaultSelection(s, p, links, events),
        focus,
        trend: rateTrend(s, p, focus?.defect ?? null),
      };
    },
    [periodKey, defect, recordLimit],
  );

  // The route names the selection; without one the workspace shows (and records) the newest relevant item.
  const selectedId = routeId ?? data.fallback;
  useEffect(() => {
    if (onPage && routeId == null && data.fallback) useApp.getState().selectQualityEvent(data.fallback, 'replace');
  }, [onPage, routeId, data.fallback]);

  const select = useCallback((id: string, mode: NavMode = 'push') => {
    if (useApp.getState().qualityEventId !== id) useApp.getState().selectQualityEvent(id, mode);
  }, []);
  /**
   * Open an item's evidence from a secondary tab: the selection rewrites the tab's entry, the switch
   * to the investigation (the default view) is the user's step. Identity-stable for the memoised table.
   */
  const openInvestigation = useCallback(
    (id: string) => {
      select(id, 'replace');
      useApp.getState().setTab('quality', null, 'push');
    },
    [select],
  );
  const toRecords = (patch: Partial<RecordFilters>) => {
    setFilters({ ...NO_FILTERS, ...patch });
    setTab('records');
  };
  const investigateDefect = (d: DefectCategory | null) => {
    setDefect(d);
    setRecordLimit(RECORD_PAGE);
    if (tab !== 'investigate') setTab('investigate');
  };

  const kpi = (id: KpiModel['id']) => data.kpis.find((k) => k.id === id)!;
  const fpy = kpi('first-pass-quality');
  const topDefect = data.summary.top?.defect ?? null;
  const sc = data.summary.scenario;

  return (
    <div className="wp qd">
      <PageHeader
        title="Quality & Defects"
        context={
          <>
            <span>Tile line 1 · sorting inspection (gauge + vision tunnel)</span>
            <span>{data.p.label}</span>
            <span>Simulated inspection records — no camera or vision model connected</span>
            {sc && (
              <span className="qd-ctx-scn">
                <ProvenanceBadge kind="scenario" /> {sc.label}{' '}
                <button type="button" className="row-link" onClick={() => useApp.getState().setScenariosOpen(true)}>
                  Manage scenarios
                </button>
              </span>
            )}
          </>
        }
        summary={summaryText(data.summary, data.p.label)}
        actions={
          <button type="button" className="btn sm ghost" onClick={() => openCopilot('What quality problems are occurring, and where?')} title="Ask the rule-based copilot">
            <MessageSquareText size={13} aria-hidden /> Ask copilot
          </button>
        }
      />

      <KpiRow label="Quality KPIs">
        <KpiCard {...kpiCardProps(kpi('inspected'))} />
        <KpiCard {...kpiCardProps(kpi('defective'))} onClick={() => toRecords({ result: 'reject' })} actionLabel="Show the reject records" />
        <KpiCard {...kpiCardProps(fpy)} />
        <KpiCard
          {...kpiCardProps(kpi('top-defect'))}
          onClick={topDefect ? () => investigateDefect(defect === topDefect && tab === 'investigate' ? null : topDefect) : undefined}
          actionLabel={topDefect ? `Investigate ${DEFECTS[topDefect].label.toLowerCase()} only` : undefined}
          selected={!!topDefect && defect === topDefect && tab === 'investigate'}
        />
      </KpiRow>

      <Tabs<Tab>
        label="Quality views"
        value={tab}
        onChange={(t) => setTab(t)}
        options={[
          { value: 'investigate', label: 'Defect investigation', count: data.summary.open || null, title: 'Quality events and defect records with their evidence' },
          { value: 'records', label: 'Inspection records', title: 'Raw inspection history of the period' },
          { value: 'stations', label: 'Stations, batches & cost', title: 'Inspection stations, defect categories, batches and the scrap / rework estimate' },
        ]}
      />

      {tab === 'investigate' && (
        <>
          <div className="qd-work">
            <DefectList
              data={data.list}
              selectedId={selectedId}
              now={data.now}
              periodLabel={data.p.label}
              scenarioRecords={data.scenarioRecords}
              defect={defect}
              onDefect={investigateDefect}
              onSelect={select}
              onMore={() => setRecordLimit((n) => n + RECORD_PAGE)}
              onAllRecords={() => toRecords(defect ? { defect } : {})}
            />
            {selectedId ? (
              <DefectEvidence key={selectedId} id={selectedId} fpy={fpy} fallbackId={data.fallback} onSelect={select} />
            ) : (
              <section className="qd-ev qd-ev-empty" aria-label="Defect evidence">
                <EmptyState title="No defect to investigate" icon={ScanSearch}>
                  No quality event and no reject record {inPeriod(data.p.label)}. Choose a longer period in the header to look further back.
                </EmptyState>
              </section>
            )}
          </div>
          <RateTrend points={data.trend.points} bucketMin={data.trend.bucketMin} limit={data.summary.limit} focus={data.focus} periodLabel={data.p.label} open={data.p.to >= data.now} />
        </>
      )}

      {tab === 'records' && <RecordsTab periodKey={periodKey} filters={filters} onFilters={setFilters} onOpen={openInvestigation} onShowEvent={openInvestigation} selectedId={selectedId} />}

      {tab === 'stations' && (
        <StationsTab
          periodKey={periodKey}
          selectedId={selectedId}
          onFilterStation={(id) => toRecords({ station: id })}
          onFilterBatch={(id) => toRecords({ batch: id })}
          onDefect={(d) => investigateDefect(d)}
          onOpen={openInvestigation}
        />
      )}
    </div>
  );
}
