/**
 * The five Overview KPIs for the current shift, rendered from the single KPI source
 * (src/intel/kpis.ts overviewKpis). Each card opens where its figure is explained.
 */
import type { KpiId, KpiModel } from '../../intel/kpis';
import { overviewKpis } from '../../intel/kpis';
import { resolvePeriod } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { KpiCard, KpiRow } from '../../ui/kit/Page';
import { kpiCardProps as sharedKpiCardProps } from '../../ui/kit/Page';
import { kpiNav } from './actions';

/** KpiModel → KpiCard props (the shared mapper of the kit). */
export const kpiCardProps = (k: KpiModel) => sharedKpiCardProps(k);

const DESTINATION: Partial<Record<KpiId, { go: () => void; label: string }>> = {
  'good-output': { go: kpiNav.production, label: 'Open Production' },
  'target-attainment': { go: kpiNav.production, label: 'Open Production' },
  'factory-oee': { go: kpiNav.oee, label: 'Open the OEE breakdown in Production' },
  'first-pass-quality': { go: kpiNav.quality, label: 'Open Quality & Defects' },
  'active-issues': { go: kpiNav.issues, label: 'Show the issues list' },
};

export function OverviewKpis() {
  const kpis = useSimValue((s) => overviewKpis(s, resolvePeriod('shift', s.minute)));
  return (
    <KpiRow label="Current shift key figures">
      {kpis.map((k) => {
        const d = DESTINATION[k.id];
        return (
          <div className="ov-kpi" key={k.id} title={k.definition}>
            <KpiCard {...kpiCardProps(k)} onClick={d?.go} actionLabel={d?.label} />
          </div>
        );
      })}
    </KpiRow>
  );
}
