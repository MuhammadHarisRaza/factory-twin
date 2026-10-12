/**
 * The line-constraint marker of the Factory Twin surfaces — the line strip, the stage panel, the
 * equipment workspace, the 3D model's constraint outline and chip (also shown on the Overview) and
 * the "Line constraint" quick view. One shape over constraintClaim (src/intel/summary.ts), the single
 * definition of what may be said about the constraint, so every surface agrees with the Overview's
 * summary sentence and flow strip:
 *  - claim.constraining → "Constraining output", warning styling, "currently constraining output —
 *    <evidence>" (the kiln stopped or slowed now, or the stage the kiln's starvation / blockage was
 *    traced to);
 *  - otherwise → a neutral "Design constraint (modeled)" with the evidence (no other stage held the
 *    kiln up); with a stale kiln feed or a planned kiln stop nothing is claimed beyond the design
 *    label (constraintPhrase says why).
 * Pure: no React, no three.js.
 */
import { STAGE_BY_ID } from '../../model/plant';
import type { MonitoredStageId, StageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { constraintClaim, constraintPhrase, type ConstraintClaim } from '../../intel/summary';

/** Marker label while the evidence supports "currently constraining output". */
export const ACTIVE_CONSTRAINT_LABEL = 'Constraining output';
/** Marker label otherwise: the configured line constraint, nothing more. */
export const DESIGN_CONSTRAINT_LABEL = 'Design constraint (modeled)';

export type ConstraintMarker = {
  claim: ConstraintClaim;
  /** True only when the claim supports "currently constraining output": warning styling allowed. */
  active: boolean;
  /** Monitored stage the claim names (production stage panels, flow strip). */
  stage: MonitoredStageId;
  /** Process stage whose machines are marked (the end of the trace, or the kiln). */
  processStage: StageId;
  machines: string[];
  /** Display name of the monitored stage. */
  name: string;
  /** "Constraining output" or "Design constraint (modeled)". */
  label: string;
  /** The claim as one sentence (constraintPhrase — the Overview summary's wording), with a full stop. */
  sentence: string;
  /** Tooltip: label and stage, then the evidence with its figures. */
  title: string;
};

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The constraint marker for the current state (pass a claim already computed to avoid a second trace). */
export function constraintMarker(s: SimState, claim: ConstraintClaim = constraintClaim(s)): ConstraintMarker {
  const active = claim.constraining;
  const label = active ? ACTIVE_CONSTRAINT_LABEL : DESIGN_CONSTRAINT_LABEL;
  return {
    claim,
    active,
    stage: claim.stage,
    processStage: claim.processStage,
    machines: STAGE_BY_ID[claim.processStage].machines,
    name: claim.name,
    label,
    sentence: `${cap(constraintPhrase(claim))}.`,
    title: `${label} · ${claim.name}\n${cap(claim.detail)}.`,
  };
}
