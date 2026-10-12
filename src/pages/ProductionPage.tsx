/**
 * Production — "Are we meeting the plan, and where are we losing output?"
 *
 * Three route-bound tabs (?tab=…) over the one simulation state:
 *   Plan & flow (default) — plan vs actual, the stage flow and the constraint, losses, events;
 *                           with a stage open (#/production/<stage>) the stage view.
 *   OEE & losses          — line OEE = A × P × Q with its definitions, integrity checks, count
 *                           reconciliation and the largest OEE losses.
 *   Analysis              — equipment OEE drill-down, capacity waterfall, downtime Pareto, shift
 *                           comparison, financial assumptions and what-if estimates.
 * The period is the shared header period; states and events are "now".
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, LoaderCircle, MessageSquareText } from 'lucide-react';
import { useApp } from '../app/store';
import { LINE, MONITORED_STAGE_BY_ID } from '../model/plant';
import { PERIOD_LABELS, resolvePeriod } from '../sim/metrics';
import { useSim, useSimValue } from '../sim/store';
import { formatClock, formatDateTime, formatDay } from '../sim/time';
import { useTwin } from '../store';
import { PageHeader, Tabs, useWorkspaceTab } from '../ui/kit/Page';
import { AnalysisTab, analysisSummary } from './production/AnalysisTab';
import { canDrill } from './production/common';
import { EquipmentDrawer } from './production/MachineDrawer';
import { OeeTab } from './production/OeeTab';
import { PlanTab } from './production/PlanTab';
import { withPeriod } from './production/loss';
import { oeeData } from './production/oee';
import { planData } from './production/plan';
import { StageView, showStageIn3D } from './production/stage/StageView';
import { stageRow, stageSentence, bottleneckView } from './production/stage/derive';
import './production/production.css';

export type ProductionTab = 'flow' | 'oee' | 'analysis';
const TABS: readonly ProductionTab[] = ['flow', 'oee', 'analysis'];

export function ProductionPage() {
  const periodKey = useApp((s) => s.period);
  const stage = useApp((s) => s.productionStage);
  const finance = useApp((s) => s.finance);
  const resets = useSim((s) => s.resets);
  const resetting = useSim((s) => s.resetting);
  const [tab, setTab] = useWorkspaceTab<ProductionTab>('production', 'flow', TABS);
  const [asset, setAsset] = useState<string | null>(null);
  const closeDrawer = useCallback(() => setAsset(null), []);
  const ref = useRef<HTMLDivElement>(null);
  const ms = stage ? MONITORED_STAGE_BY_ID[stage] : null;
  const stageOpen = !!ms && tab === 'flow';

  // While a stage is open its equipment and conveyors are highlighted in the 3D model (without moving
  // the camera); closing the stage clears the highlight this page set.
  const highlighted = useRef<string | null>(null);
  useEffect(() => {
    const twin = useTwin.getState();
    if (stage) {
      if (twin.stage !== stage) twin.selectStage(stage, { frame: false });
      highlighted.current = stage;
    } else if (highlighted.current) {
      if (twin.stage === highlighted.current) twin.selectStage(null);
      highlighted.current = null;
    }
  }, [stage]);

  // A new view starts at the top.
  useEffect(() => {
    ref.current?.closest('.content')?.scrollTo({ top: 0 });
  }, [stage, tab]);

  // The view model of the open view, computed once per simulated minute; the header summary comes from it.
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      if (stageOpen && ms) return { p, summary: stageSentence(stageRow(s, ms, p, bottleneckView(s)), periodKey), plan: null, oee: null };
      if (tab === 'oee') {
        const oee = oeeData(s, p, finance);
        return { p, summary: oee.summary, plan: null, oee };
      }
      if (tab === 'analysis')
        return { p, summary: analysisSummary(s, p, finance), plan: null, oee: null };
      const plan = planData(s, p, finance);
      return { p, summary: plan.summary, plan, oee: null };
    },
    [periodKey, tab, stageOpen, ms?.id, finance],
  );

  const scope = stageOpen && ms ? `Process step ${ms.step} · ${ms.id} · ${LINE.name}` : LINE.name;
  const context = (
    <>
      <span>{scope}</span>
      <span>
        {PERIOD_LABELS[periodKey]} ·{' '}
        {Math.floor(d.p.from / 1440) === Math.floor((d.p.to - 1) / 1440)
          ? `${formatDay(d.p.from)} ${formatClock(d.p.from)}–${formatClock(d.p.to)}`
          : `${formatDateTime(d.p.from)} – ${formatDateTime(d.p.to)}`}{' '}
        plant time
      </span>
      <span>States and events: now</span>
    </>
  );
  const askCopilot = () => useApp.getState().openCopilot(withPeriod('Why is production below target?', periodKey));

  return (
    <div className="wp prod" ref={ref}>
      <PageHeader
        title={stageOpen && ms ? ms.name : 'Production'}
        context={context}
        summary={d.summary}
        actions={
          <>
            {resetting && (
              <span className="status neutral" role="status">
                <LoaderCircle size={13} className="spin" aria-hidden /> Resetting demo…
              </span>
            )}
            {stageOpen && ms && (
              <button type="button" className="btn" onClick={() => showStageIn3D(ms.id)} title="Open the Factory Twin with this stage highlighted and framed">
                <Box size={14} aria-hidden /> Show in 3D
              </button>
            )}
            <button type="button" className="btn ghost" onClick={askCopilot} title="Ask the rule-based copilot (no language model) the same question for the same period">
              <MessageSquareText size={14} aria-hidden /> Ask Copilot
            </button>
          </>
        }
      />
      <Tabs
        label="Production views"
        value={tab}
        onChange={(t) => setTab(t)}
        options={[
          { value: 'flow', label: ms ? `Plan & flow · ${ms.name}` : 'Plan & flow', title: 'Plan vs actual, stage flow, constraint, losses and events' },
          { value: 'oee', label: 'OEE & losses', title: 'Line OEE, integrity checks, count reconciliation and the largest OEE losses' },
          { value: 'analysis', label: 'Analysis', title: 'Equipment OEE, capacity waterfall, downtime Pareto, shifts, assumptions and what-ifs' },
        ]}
      />
      {tab === 'flow' && (ms ? <StageView key={`${ms.id}:${resets}`} stageId={ms.id} periodKey={periodKey} onAsset={setAsset} /> : d.plan && <PlanTab key={resets} periodKey={periodKey} d={d.plan} onTab={setTab} />)}
      {tab === 'oee' && d.oee && <OeeTab key={resets} d={d.oee} onTab={setTab} />}
      {tab === 'analysis' && <AnalysisTab key={resets} periodKey={periodKey} asset={asset} onAsset={setAsset} />}
      {asset && canDrill(asset) && <EquipmentDrawer id={asset} periodKey={periodKey} onClose={closeDrawer} />}
    </div>
  );
}
