/**
 * The live 3D factory at the centre of the Overview — the one shared scene (TwinSlot), with a few
 * compact controls at its edges (zone, alert markers, whole factory, focus) and ONE small card for
 * the current selection (equipment, vehicle or highlighted stage). Selection and camera are the
 * shared twin state, so "Open details" continues in the Factory Twin on the same scene.
 */
import { useEffect } from 'react';
import { ArrowRight, Bell, CircleCheck, CircleDot, Crosshair, MapPin, RotateCcw, TriangleAlert, type LucideIcon } from 'lucide-react';
import { openStage, useApp } from '../../app/store';
import { TwinSlot } from '../../app/twinHost';
import { ZONES } from '../../data/layout';
import { resolvePeriod } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { useTwin, type AlertFilter } from '../../store';
import { ProvenanceBadge } from '../../ui/kit/Page';
import { Segmented } from '../../ui/kit/Panel';
import { OperationalStatus, StatusBadge, type Tone } from '../../ui/kit/Status';
import { TWIN_ID, clearSelection, focusSelection } from './actions';
import { selectionCard, type CardStatus, type SelectionCardModel } from './derive';

const ALERT_OPTIONS: { value: AlertFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'serious', label: 'Serious & critical' },
  { value: 'off', label: 'Off' },
];

const TEXT_ICON: Record<Tone, LucideIcon> = {
  good: CircleCheck,
  warning: TriangleAlert,
  serious: TriangleAlert,
  critical: TriangleAlert,
  neutral: CircleDot,
  planned: CircleDot,
};

function CardStatusBadge({ status }: { status: CardStatus }) {
  if (!status) return <StatusBadge tone="neutral" icon={CircleDot} label="No state signal" />;
  if (status.kind === 'op') return <OperationalStatus state={status.op} />;
  return <StatusBadge tone={status.tone} icon={TEXT_ICON[status.tone]} label={status.label} />;
}

function SelectionCard({ card }: { card: SelectionCardModel }) {
  return (
    <aside className="ov-sel" aria-label={`Selected: ${card.title}`}>
      <div className="ov-sel-h">
        <b className="ov-sel-t">{card.title}</b>
        <span className="ov-sel-sub">{card.subtitle}</span>
      </div>
      <div className="ov-sel-s">
        <CardStatusBadge status={card.status} />
        {card.stale && <ProvenanceBadge kind="stale" title={card.stale.note} />}
        {card.stale?.label && (
          <span className="ov-sel-stale" title={card.stale.note}>
            {card.stale.label}
          </span>
        )}
      </div>
      <dl className="ov-sel-f">
        {card.facts.map((f) => (
          <div key={f.label} title={f.hint}>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
      <div className="ov-sel-a">
        {card.kind === 'stage' && card.stageId ? (
          <button type="button" className="btn sm primary" onClick={() => openStage(card.stageId!)} title="Open this stage in Production (the highlight stays in the model)">
            Open in Production
            <ArrowRight size={12} aria-hidden />
          </button>
        ) : (
          <button type="button" className="btn sm primary" onClick={() => useApp.getState().go('twin')} title="Continue in the Factory Twin with this selection — the same model and camera">
            Open details
            <ArrowRight size={12} aria-hidden />
          </button>
        )}
        <button type="button" className="btn sm ghost" onClick={clearSelection} title="Clear the selection (Esc)">
          Clear
        </button>
      </div>
    </aside>
  );
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

/** Esc clears the model selection on the Overview (unless a drawer, dialog or field has the key). */
function useEscapeClears(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTyping(e.target)) return;
      const a = useApp.getState();
      if (a.workspace !== 'overview' || a.copilotOpen || a.scenariosOpen || document.querySelector('[role="dialog"], [aria-modal="true"]')) return;
      clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

export function OverviewTwin() {
  const zone = useTwin((t) => t.zone);
  const selected = useTwin((t) => t.selected);
  const vehicle = useTwin((t) => t.vehicle);
  const stage = useTwin((t) => t.stage);
  const alertFilter = useTwin((t) => t.alertFilter);
  const hasSelection = !!(selected || vehicle || stage);
  useEscapeClears(hasSelection);
  const card = useSimValue((s) => selectionCard(s, { selected, vehicle, stage }, resolvePeriod('shift', s.minute)), [selected, vehicle, stage]);
  const focusTitle = selected ? 'Frame the selected equipment' : vehicle ? 'Follow the selected vehicle' : 'Frame the highlighted stage';

  return (
    <div id={TWIN_ID} className="ov-twin-box">
      <TwinSlot className="ov-twin" label="3D factory model (simulated state)">
        <div className="ov-ctl ov-ctl-tl" role="toolbar" aria-label="Model view">
          <label className="ov-zone" title="Fly to a production zone">
            <MapPin size={13} aria-hidden />
            <select className="select ov-select" aria-label="Production zone" value={zone ?? ''} onChange={(e) => useTwin.getState().selectZone(e.target.value || null)}>
              <option value="">All zones</option>
              {ZONES.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.id} · {z.short}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn sm ov-btn" onClick={() => useTwin.getState().reset()} title="Return to the whole factory and clear the selection">
            <RotateCcw size={13} aria-hidden />
            Whole factory
          </button>
          {hasSelection && (
            <button type="button" className="btn sm ov-btn" onClick={focusSelection} title={focusTitle}>
              <Crosshair size={13} aria-hidden />
              Focus
            </button>
          )}
        </div>
        <div className="ov-ctl ov-ctl-tr" title="Which alert markers the model shows (equipment colours stay)">
          <span className="ov-ctl-l">
            <Bell size={13} aria-hidden />
            Alerts
          </span>
          <Segmented<AlertFilter> label="Alert markers shown in the model" value={alertFilter} options={ALERT_OPTIONS} onChange={(v) => useTwin.getState().setAlertFilter(v)} />
        </div>
        {card && <SelectionCard card={card} />}
        <div className="ov-ctl-br">
          <ProvenanceBadge kind="simulated" title="The model shows the simulated plant state — no PLC, SCADA, camera or tracking system is connected" />
          <span className="ov-hint">Drag to orbit · Ctrl/⌘ + scroll to zoom · click equipment</span>
        </div>
      </TwinSlot>
    </div>
  );
}
