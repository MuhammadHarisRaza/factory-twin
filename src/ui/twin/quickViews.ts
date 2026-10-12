/**
 * Dynamic camera views: unlike the fixed presets they pick their target from the
 * current simulation state when clicked.
 */
import { HeartPulse, Hourglass, type LucideIcon } from 'lucide-react';
import { healthAssessments } from '../../intel/insights';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { constraintMarker } from './constraint';
import { worstHealth } from './derive';
import { useTwinUi } from './uiStore';

/** Select and frame the condition-monitored asset in the worst state, its workspace at the condition section. */
export function focusWorstHealth() {
  const worst = worstHealth(healthAssessments(useSim.getState().sim));
  if (!worst) return;
  useTwinUi.getState().focusSection(worst.id, 'condition');
  useTwin.getState().select(worst.id);
}

/**
 * Highlight the stage the constraint claim names (constraintClaim — the stage currently constraining
 * output, or the kiln as the modeled design constraint) and select its first machine.
 */
export function focusConstraint() {
  const c = constraintMarker(useSim.getState().sim);
  const id = c.machines[0];
  const tw = useTwin.getState();
  tw.selectStage(c.stage, { frame: false });
  useTwinUi.getState().focusSection(id, 'overview');
  tw.select(id);
}

export const QUICK_VIEWS: { id: string; label: string; hint: string; icon: LucideIcon; run: () => void }[] = [
  {
    id: 'health',
    label: 'Worst condition',
    hint: 'Open the condition-monitored asset in the worst state (rule-based assessment of simulated signals)',
    icon: HeartPulse,
    run: focusWorstHealth,
  },
  {
    id: 'constraint',
    label: 'Line constraint',
    hint: 'Highlight the stage constraining output now — or the kiln, the modeled design constraint, when no other stage holds it up — and open its first machine',
    icon: Hourglass,
    run: focusConstraint,
  },
];
