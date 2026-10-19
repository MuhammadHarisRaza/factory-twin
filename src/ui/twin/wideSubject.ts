/**
 * Whether the Factory Twin shows its subject panel wide now: a subject the Inspector shows in the panel
 * shell is open (a vehicle, an equipment item or a production stage — a zone alone keeps its compact
 * summary) and the viewer's width choice fits the window (src/ui/twin/panelWidth.ts). The overlay grid,
 * the toolbar's zone-list button and the focus hand-over read the same answer.
 */
import { useTwin } from '../../store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import { useWidePanel } from './panelWidth';

export function useWideSubjectPanel(): boolean {
  const selected = useTwin((s) => s.selected);
  const vehicle = useTwin((s) => s.vehicle);
  const stage = useTwin((s) => s.stage);
  const wide = useWidePanel();
  const subject = !!(vehicle || (selected && EQUIPMENT_BY_ID[selected]) || (stage && MONITORED_STAGE_BY_ID[stage]));
  return wide && subject;
}
