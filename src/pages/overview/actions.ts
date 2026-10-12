/**
 * Overview actions on the shared stores. The embedded 3D factory is the same scene as the Factory
 * Twin, so everything here only changes the shared twin selection / camera (useTwin) or navigates
 * through the app store helpers — nothing is local to the page.
 */
import { useApp } from '../../app/store';
import { INSPECTION_STATIONS } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { useEventFocus } from '../../scene/events/focus';
import { focusPlan } from '../../scene/events/model';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';

/** Element id of the embedded model and of the issues list (scroll targets). */
export const TWIN_ID = 'ov-twin';
export const ISSUES_ID = 'ov-issues';

const reduceMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Scrolls a page block into view (only as far as needed). */
export function scrollToBlock(id: string, block: ScrollLogicalPosition = 'nearest') {
  if (typeof document === 'undefined') return;
  document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block });
}

/** Clears the twin selection shown by the card: equipment, vehicle and stage highlight (the camera stays). */
export function clearSelection() {
  const t = useTwin.getState();
  if (t.selected) t.select(null);
  if (t.vehicle) t.selectVehicle(null);
  if (t.stage) t.selectStage(null);
}

/** Frames the current selection: equipment, the followed vehicle, or the highlighted stage. */
export function focusSelection() {
  const t = useTwin.getState();
  if (t.selected) t.focusEquipment(t.selected);
  else if (t.vehicle) t.selectVehicle(t.vehicle, true);
  else if (t.stage) t.selectStage(t.stage);
}

let nonce = 0;

/**
 * "Show in model" for an issue, without leaving the Overview: marks the event in the scene (the
 * focus ring and event pin of src/scene/events, the same as the Factory Twin's "Show in twin"),
 * selects what it affects — the vehicle while it is on site, otherwise the asset, station or zone —
 * and brings the embedded model into view.
 */
export function showEventInModel(ev: Pick<OpEvent, 'id' | 'asset'>) {
  const { sim, resets } = useSim.getState();
  const plan = focusPlan(sim, ev);
  useEventFocus.setState({
    focus: {
      eventId: ev.id,
      // Distinct from the Factory Twin's own counter (which starts at 1): the ring restarts on every click.
      nonce: -++nonce,
      resets,
      target: { equipmentId: plan.open.equipmentId ?? null, vehicleId: plan.open.vehicleId ?? null },
    },
  });
  // The event becomes the selected record ('replace': no history step while on the Overview).
  useApp.getState().selectEvent(ev.id, 'replace');
  const t = useTwin.getState();
  if (plan.open.vehicleId) t.selectVehicle(plan.open.vehicleId, true);
  else if (plan.open.equipmentId) t.select(plan.open.equipmentId);
  else if (plan.open.stationId) {
    const st = INSPECTION_STATIONS.find((x) => x.id === plan.open.stationId);
    if (st) t.select(st.equipmentId);
  } else if (plan.open.zone) t.selectZone(plan.open.zone);
  scrollToBlock(TWIN_ID);
}

/** KPI card destinations. */
export const kpiNav = {
  production() {
    // Line-level figures: the Production overview of all stages (its default view), whatever stage or
    // sub-view was open there last.
    const a = useApp.getState();
    a.selectStage(null, 'replace');
    a.setTab('production', null, 'replace');
    a.go('production');
  },
  oee() {
    const a = useApp.getState();
    a.selectStage(null, 'replace');
    a.setTab('production', 'oee', 'replace');
    a.go('production');
  },
  quality() {
    useApp.getState().go('quality');
  },
  issues() {
    scrollToBlock(ISSUES_ID, 'start');
  },
};
