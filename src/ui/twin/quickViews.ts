/**
 * Dynamic camera views: unlike the fixed presets they pick their target from the
 * current simulation state when clicked.
 */
import { HeartPulse, Hourglass, type LucideIcon } from 'lucide-react';
import { STAGE_BY_ID } from '../../model/plant';
import { healthAssessments } from '../../intel/insights';
import { bottleneck } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { worstHealth } from './derive';
import { useTwinUi } from './uiStore';

/** Select and frame the condition-monitored asset in the worst state, inspector on Health. */
export function focusWorstHealth() {
  const worst = worstHealth(healthAssessments(useSim.getState().sim));
  if (!worst) return;
  const tw = useTwin.getState();
  tw.select(worst.id);
  tw.focusEquipment(worst.id);
  useTwinUi.getState().setTab(worst.id, 'health');
}

/** Select the first machine of the stage currently limiting the line (last 2 h). */
export function focusBottleneck() {
  const bn = bottleneck(useSim.getState().sim);
  const id = STAGE_BY_ID[bn.current.stage].machines[0];
  useTwinUi.getState().setTab(id, 'overview');
  useTwin.getState().select(id);
}

export const QUICK_VIEWS: { id: string; label: string; hint: string; icon: LucideIcon; run: () => void }[] = [
  {
    id: 'health',
    label: 'Machine health',
    hint: 'Frame the monitored asset in the worst condition (rule-based assessment)',
    icon: HeartPulse,
    run: focusWorstHealth,
  },
  {
    id: 'bottleneck',
    label: 'Bottleneck',
    hint: 'Locate the stage limiting the line over the last 2 h',
    icon: Hourglass,
    run: focusBottleneck,
  },
];
