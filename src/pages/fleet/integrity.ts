/**
 * Is a truck visit record a real, current visit — or a completed one, a scheduled one, or one that
 * looks broken? A visit without a gate-out far beyond the turnaround limit is flagged
 * "Record incomplete?" (a possibly missing gate-out) instead of being presented as a real stay.
 */
import { staleVisitLimit } from '../../intel/kpis';
import type { SimState } from '../../sim/engine';
import type { TruckRuntime } from '../../sim/logistics';
import { formatClock, formatDuration } from '../../sim/time';

const dur = (m: number | null | undefined) => formatDuration(m);

/** A visit without gate-out this long after gate-in is a possibly incomplete record (shared with the KPIs, src/intel/kpis.ts). */
export { staleVisitLimit };

export type VisitIntegrityKind = 'scheduled' | 'approaching' | 'active' | 'completed' | 'incomplete';
export type VisitIntegrity = { kind: VisitIntegrityKind; label: string; note: string | null };

/** Is this visit record a real, current visit — or a completed one, a due one, or one that looks broken? */
export function visitIntegrity(s: SimState, v: TruckRuntime): VisitIntegrity {
  const now = s.minute;
  const vis = v.visit!;
  if (v.spawned > now) return { kind: 'scheduled', label: 'Scheduled arrival', note: `Due at the gate approach at ${formatClock(v.spawned)} (scenario).` };
  if (vis.gateOut != null && vis.gateOut <= now) return { kind: 'completed', label: 'Completed visit', note: null };
  if (!s.logistics.active.includes(v.id))
    return {
      kind: 'incomplete',
      label: 'Record incomplete?',
      note: 'The vehicle is no longer simulated on site, but its visit has no gate-out record — its times are not a dwell. Check the gate log.',
    };
  if (vis.gateIn > now) return { kind: 'approaching', label: 'Before gate-in', note: null };
  const onSite = now - vis.gateIn;
  if (onSite > staleVisitLimit(s.rules))
    return {
      kind: 'incomplete',
      label: 'Record incomplete?',
      note: `No gate-out recorded ${dur(onSite)} after gate-in — far beyond the ${s.rules.turnaroundMax}-min turnaround limit. Possibly a missing gate-out rather than a real ${dur(onSite)} stay; check the gate log before acting.`,
    };
  return { kind: 'active', label: 'Active visit', note: null };
}
