/**
 * Production flow strip: the monitored stages in line order as one compact row — per stage its
 * name, operating status (icon + words), output in the period, the deviation from plan where a plan
 * exists (the line output stage only), an alert indicator and the constraint marker. A stage whose
 * counting point's feed is stale keeps the running figure and shows the Stale badge with
 * "Not confirmed · <asset> data stale since hh:mm" (the plan deviation is then neutral, not a verdict).
 *
 * Selecting a stage highlights its equipment and conveyors in the shared 3D model and frames it
 * (useTwin.selectStage) by default, and the strip follows the shared stage highlight when it is set
 * elsewhere. Reusable: Production can pass its own `selected` / `onSelect` / `period`.
 */
import { ArrowRight, CircleSlash, Hourglass, OctagonX, TrendingDown, TrendingUp, TriangleAlert, X, Info, Minus } from 'lucide-react';
import { openStage } from '../../app/store';
import type { AlertSeverity, MonitoredStageId } from '../../model/types';
import { TARGET_STATUS_LABEL, resolvePeriod, type Period } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { useTwin } from '../../store';
import { ProvenanceBadge } from '../kit/Page';
import { OPERATIONAL_STATE, OperationalStatus, StatusBadge, type Tone } from '../kit/Status';
import { flowStages, type FlowStage } from './derive';
import './flow.css';

const int = (n: number) => Math.round(n).toLocaleString('en-GB');
const pct = (x: number) => `${Math.round(x * 100)} %`;

const SEV: Record<AlertSeverity, { tone: Tone; icon: typeof TriangleAlert; label: string }> = {
  critical: { tone: 'critical', icon: OctagonX, label: 'critical' },
  serious: { tone: 'serious', icon: TriangleAlert, label: 'serious' },
  warning: { tone: 'warning', icon: TriangleAlert, label: 'warning' },
  info: { tone: 'neutral', icon: Info, label: 'info' },
};

const PLAN_TONE = { ahead: 'good', 'on-track': 'good', behind: 'warning', 'well-behind': 'critical', none: 'neutral' } as const;

const outputText = (st: FlowStage) => (st.output == null ? '—' : int(st.output));
const unitText = (st: FlowStage) => (st.unit === 'pallets' ? 'pallets' : st.tileEquivalent ? 'm² eq.' : 'm²');

function stageTitle(st: FlowStage) {
  const parts = [
    st.name,
    st.status ? `Status: ${OPERATIONAL_STATE[st.status].label}${st.statusAssetName && st.status !== 'running' ? ` (${st.statusAssetName})` : ''}` : 'No state signal modelled for this stage',
    `${st.outputLabel}: ${outputText(st)} ${st.unit}${st.stale ? ` (${st.stale.label})` : ''}`,
  ];
  if (st.stale) parts.push(st.stale.note);
  if (st.plan) parts.push(`Plan so far: ${int(st.plan.planM2)} m² (${st.stale ? 'not confirmed' : TARGET_STATUS_LABEL[st.plan.status]})`);
  if (st.alerts.count) parts.push(`${st.alerts.count} unresolved ${st.alerts.count === 1 ? 'event' : 'events'} (highest: ${st.alerts.worst})`);
  if (st.constraint) parts.push(`${st.constraint.label}: ${st.constraint.detail}`);
  parts.push('Select to highlight the stage in the 3D model');
  return parts.join('\n');
}

/** Deviation from plan; neutral (no ahead / behind verdict) while the figure is not confirmed. */
function PlanDeviation({ plan, confirmed }: { plan: NonNullable<FlowStage['plan']>; confirmed: boolean }) {
  const tone = confirmed ? PLAN_TONE[plan.status] : 'neutral';
  const Icon = plan.status === 'none' ? Minus : plan.gapM2 >= 0 ? TrendingUp : TrendingDown;
  const sign = plan.gapM2 >= 0.5 ? '+' : plan.gapM2 <= -0.5 ? '−' : '±';
  return (
    <span className={`flow-plan ${tone}`} title={confirmed ? undefined : 'Simulated running figure vs plan — not confirmed by the data feed'}>
      <Icon size={11} strokeWidth={2.4} aria-hidden />
      {plan.status === 'none' ? 'No plan yet' : `${sign}${int(Math.abs(plan.gapM2))} m² vs plan${confirmed ? '' : ' · not confirmed'}`}
    </span>
  );
}

function StageCell({ st, on, onClick }: { st: FlowStage; on: boolean; onClick: () => void }) {
  const tone = st.status ? OPERATIONAL_STATE[st.status].tone : 'neutral';
  const sev = st.alerts.worst ? SEV[st.alerts.worst] : null;
  return (
    <li className="flow-i">
      <button type="button" className={`flow-st t-${tone} ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick} title={stageTitle(st)}>
        <span className="flow-h">
          <span className="flow-name">{st.short}</span>
          {sev && (
            <span className={`flow-alert ${sev.tone}`} aria-label={`${st.alerts.count} unresolved ${st.alerts.count === 1 ? 'event' : 'events'}, highest ${sev.label}`}>
              <sev.icon size={11} strokeWidth={2.4} aria-hidden />
              <b className="num">{st.alerts.count}</b>
            </span>
          )}
        </span>
        <span className="flow-out num">
          {outputText(st)}
          <small>{unitText(st)}</small>
        </span>
        {st.stale && <StaleLine stale={st.stale} />}
        <span className="flow-status">
          {st.status ? <OperationalStatus state={st.status} /> : <StatusBadge tone="neutral" icon={CircleSlash} label="No state signal" />}
        </span>
        {(st.plan || st.constraint) && (
          <span className="flow-foot">
            {st.plan && <PlanDeviation plan={st.plan} confirmed={!st.stale} />}
            {st.constraint && (
              <span className={`flow-cons ${st.constraint.constraining ? 'active' : ''}`}>
                <Hourglass size={11} strokeWidth={2.4} aria-hidden />
                {st.constraint.label}
              </span>
            )}
          </span>
        )}
      </button>
    </li>
  );
}

/** Stale counting point: the Stale badge and the not-confirmed mark ("Not confirmed · kiln data stale since 10:30"), never colour alone. */
function StaleLine({ stale }: { stale: NonNullable<FlowStage['stale']> }) {
  return (
    <span className="flow-stale" title={stale.note}>
      <ProvenanceBadge kind="stale" title={stale.note} />
      <span className="flow-stale-t">{stale.label}</span>
    </span>
  );
}

function Detail({ st, onOpen, onClear }: { st: FlowStage; onOpen: () => void; onClear: () => void }) {
  return (
    <div className="flow-detail" aria-live="polite">
      <div className="flow-detail-b">
        <b>{st.name}</b>
        {st.status ? <OperationalStatus state={st.status} /> : <StatusBadge tone="neutral" icon={CircleSlash} label="No state signal" />}
        {st.statusAssetName && st.status && st.status !== 'running' && <span className="muted">{st.statusAssetName}</span>}
        <span>
          {st.outputLabel}: <b className="num">{outputText(st)}</b> {unitText(st)}
        </span>
        {st.stale && (
          <span className="flow-detail-c">
            <ProvenanceBadge kind="stale" title={st.stale.note} /> {st.stale.label} — {st.stale.note}
          </span>
        )}
        {st.workingShare != null && <span title="Share of planned time the stage produced at its own pace — not starved, blocked or down">Working at own pace {pct(st.workingShare)} of planned time</span>}
        <span>{st.alerts.count ? `${st.alerts.count} unresolved ${st.alerts.count === 1 ? 'event' : 'events'}` : 'No unresolved events'}</span>
        {st.constraint && <span className="flow-detail-c">{st.constraint.label}: {st.constraint.evidence}</span>}
      </div>
      <div className="flow-detail-a">
        <button type="button" className="btn sm" onClick={onOpen}>
          Open in Production
          <ArrowRight size={12} aria-hidden />
        </button>
        <button type="button" className="btn ghost sm icon" onClick={onClear} aria-label="Clear the stage selection" title="Clear the stage selection">
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * Default selection: the stage becomes the model's focus — a selected asset or vehicle is released
 * (so the stage, not a single machine, is what the model and its selection card show) and the stage
 * is highlighted and framed. Clearing removes only the highlight; the camera stays.
 */
export function selectInModel(id: MonitoredStageId | null) {
  const t = useTwin.getState();
  if (id) {
    if (t.selected) t.select(null);
    if (t.vehicle) t.selectVehicle(null);
  }
  t.selectStage(id);
}

export type FlowStripProps = {
  /** Period of the output figures (default: the current shift). */
  period?: Period;
  /** Selected stage (default: the shared 3D stage highlight, useTwin.stage). */
  selected?: MonitoredStageId | null;
  /** Called with the stage to select, or null to clear (default: selectInModel — highlight and frame it in the 3D model). */
  onSelect?: (id: MonitoredStageId | null) => void;
  /** Opens a stage's workspace (default: Production, openStage). */
  onOpen?: (id: MonitoredStageId) => void;
  /** Show the one-line detail of the selected stage with "Open in Production" (default true). */
  detail?: boolean;
  label?: string;
};

export function FlowStrip({ period, selected, onSelect, onOpen, detail = true, label = 'Production flow' }: FlowStripProps) {
  const twinStage = useTwin((t) => t.stage);
  const sel = selected === undefined ? twinStage : selected;
  const stages = useSimValue((s) => flowStages(s, period ?? resolvePeriod('shift', s.minute)), [period?.from, period?.to]);
  const select = onSelect ?? selectInModel;
  const open = onOpen ?? openStage;
  const current = sel ? stages.find((x) => x.id === sel) : undefined;
  return (
    <div className="flow-wrap">
      <ol className="flow" aria-label={label} style={{ ['--n' as string]: stages.length }}>
        {stages.map((st) => (
          <StageCell key={st.id} st={st} on={st.id === sel} onClick={() => select(st.id === sel ? null : st.id)} />
        ))}
      </ol>
      {detail && current && <Detail st={current} onOpen={() => open(current.id)} onClear={() => select(null)} />}
    </div>
  );
}
