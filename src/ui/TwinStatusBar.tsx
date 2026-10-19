/**
 * Compact status chips over the Factory Twin: four of the Overview's headline KPIs for the current
 * shift (good output against plan, line OEE, first-pass quality, issues requiring attention), read
 * from the shared view models in src/intel/kpis.ts so they show exactly the Overview's figures.
 * Each chip states its status in words and opens the workspace that explains it.
 */
import { CircleCheck, CircleDashed, Gauge, OctagonX, ScanSearch, Siren, Target, TriangleAlert, type LucideIcon } from 'lucide-react';
import { pureIcon } from './kit/icon';
import { WORKSPACE_BY_ID, openView, type WorkspaceId } from '../app/store';
import { overviewKpis, type KpiId, type KpiModel } from '../intel/kpis';
import { resolvePeriod } from '../sim/metrics';
import { useSimValue } from '../sim/store';
import type { Tone } from './kit/Status';
import { useTip } from './twin/Tip';

/** The four chips (by shared KPI id), what they open and their icon. */
export const STATUS_CHIPS: { id: KpiId; icon: LucideIcon; short: string; workspace: WorkspaceId; tab?: string }[] = [
  { id: 'good-output', icon: Target, short: 'Output', workspace: 'production' },
  { id: 'factory-oee', icon: Gauge, short: 'OEE', workspace: 'production', tab: 'oee' },
  { id: 'first-pass-quality', icon: ScanSearch, short: 'Quality', workspace: 'quality' },
  { id: 'active-issues', icon: Siren, short: 'Issues', workspace: 'events' },
];

const TONE_ICON: Record<Tone, LucideIcon> = {
  good: CircleCheck,
  warning: TriangleAlert,
  serious: TriangleAlert,
  critical: OctagonX,
  neutral: CircleDashed,
  planned: CircleDashed,
};

// The chips are line-level figures: open the line-level view (Production on all stages), on the chip's tab.
const open = (workspace: WorkspaceId, tab?: string) => openView(workspace, tab ?? null);

export function TwinStatusBar() {
  const tip = useTip<KpiId>();
  const d = useSimValue((s) => {
    const p = resolvePeriod('shift', s.minute);
    const all = overviewKpis(s, p);
    return { p, chips: STATUS_CHIPS.map((c) => ({ ...c, k: all.find((k) => k.id === c.id) as KpiModel })).filter((c) => c.k) };
  });

  return (
    <div className="tw-kpis" role="group" aria-label={`Factory status · ${d.p.label} (simulated)`}>
      {d.chips.map(({ id, icon, short, workspace, tab, k }) => {
        const Icon = pureIcon(icon);
        const tone = k.status?.tone;
        const StatusIcon = tone ? pureIcon(TONE_ICON[tone]) : null;
        return (
          <button
            key={id}
            type="button"
            className="tw-kpi"
            onClick={() => open(workspace, tab)}
            aria-label={`${k.label}: ${k.unavailable ? 'unavailable' : `${k.display}${k.unit ? ` ${k.unit}` : ''}`}${k.status ? `, ${k.status.label}` : ''}. Open ${WORKSPACE_BY_ID[workspace].title}.`}
            {...tip.bind(id, 'bottom')}
          >
            <span className={tone && tone !== 'good' ? `status ${tone}` : 'tw-kpi-i'}>
              <Icon size={15} strokeWidth={2} aria-hidden />
            </span>
            <span className="tw-kpi-t">
              <span className="l">
                <span className="lg">{k.label}</span>
                <span className="sh">{short}</span>
              </span>
              <span className="v">
                {k.unavailable ? <span className="na">Unavailable</span> : <span className="num">{k.display}</span>}
                {!k.unavailable && k.unit && <small className="u"> {k.unit}</small>}
                {k.status && StatusIcon && (
                  <small className={`tw-kpi-s ${tone}`}>
                    <StatusIcon size={11} strokeWidth={2.4} aria-hidden />
                    <span>{k.status.label}</span>
                  </small>
                )}
              </span>
            </span>
          </button>
        );
      })}
      {tip.render((id) => {
        const c = d.chips.find((x) => x.id === id);
        if (!c) return null;
        const k = c.k;
        return (
          <>
            <b>
              {k.label} · {k.scope}
            </b>
            {k.unavailable ? <div className="tw-tip-row">{k.unavailable}</div> : <div className="tw-tip-row">{k.why}</div>}
            {k.target && <div className="tw-tip-row">{k.target}</div>}
            <div className="tw-tip-note">{k.definition}</div>
            <div className="tw-tip-foot">Simulated · same figure as the Overview · click to open {WORKSPACE_BY_ID[c.workspace].title}</div>
          </>
        );
      })}
    </div>
  );
}
