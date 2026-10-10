/**
 * "Show in twin" for an event. `focusEventInTwin(ev)` selects the event (useApp selectedEventId),
 * opens the Factory Twin on what it affects (openEventInTwin — the vehicle while it is on site,
 * otherwise the area / asset / station / zone, see ./model.ts) and remembers the event here, so
 * the scene pulses a ring at that place for ~10 s and shows a compact event pin that links back
 * to the event record.
 *
 * The focus is dropped when the user selects another asset or vehicle in the twin, selects another
 * event, dismisses the pin, or the demo is reset. This module has no three.js dependency, so any
 * workspace can import it without pulling in the 3D scene.
 */
import { create } from 'zustand';
import { openEventInTwin, useApp } from '../../app/store';
import type { OpEvent } from '../../model/types';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { focusPlan, selectionLeavesFocus, type EventFocus } from './model';

export { isFocusCurrent, type EventFocus } from './model';

export const useEventFocus = create<{ focus: EventFocus | null }>(() => ({ focus: null }));

let nonce = 0;

/** Open the Factory Twin on an event's asset / vehicle / area and mark it there. */
export function focusEventInTwin(ev: Pick<OpEvent, 'id' | 'asset'>) {
  const { sim, resets } = useSim.getState();
  const plan = focusPlan(sim, ev);
  useEventFocus.setState({
    focus: {
      eventId: ev.id,
      nonce: ++nonce,
      resets,
      target: { equipmentId: plan.open.equipmentId ?? null, vehicleId: plan.open.vehicleId ?? null },
    },
  });
  useApp.getState().selectEvent(ev.id);
  openEventInTwin({ asset: plan.open });
}

export function clearEventFocus() {
  if (useEventFocus.getState().focus) useEventFocus.setState({ focus: null });
}

useTwin.subscribe((s, p) => {
  const f = useEventFocus.getState().focus;
  if (f && selectionLeavesFocus(f, s, p)) clearEventFocus();
});
useApp.subscribe((s, p) => {
  const f = useEventFocus.getState().focus;
  if (f && s.selectedEventId !== p.selectedEventId && s.selectedEventId !== f.eventId) clearEventFocus();
});
useSim.subscribe((s, p) => {
  if (s.resets !== p.resets) clearEventFocus();
});
