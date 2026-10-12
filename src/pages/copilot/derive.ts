/**
 * Copilot workspace — pure derivations for the page header and the incident picker. Everything is
 * read from the one simulation state with the same KPI functions the Overview uses (current shift),
 * so the page, the KPI cards and the copilot's answers agree.
 */
import type { OpEvent } from '../../model/types';
import { activeIssuesKpi, attentionEvents, goodOutputKpi, periodScope, targetAttainmentKpi } from '../../intel/kpis';
import type { SimState } from '../../sim/engine';
import { lineMetrics, resolvePeriod } from '../../sim/metrics';

/** Incidents to investigate: the issues requiring attention, ranked exactly as on the Overview. */
export const pickerEvents = (s: SimState): OpEvent[] => attentionEvents(s);

export type CopilotSummary = {
  periodLabel: string;
  /** The KPI cards' time scope: "Shift A · 06:00–10:30 (to date)". */
  scope: string;
  /** "1,869 m²" or null when no output can be counted yet. */
  good: string | null;
  /** "85.8 %" or null when no planned time has elapsed. */
  attainment: string | null;
  attainmentStatus: string | null;
  issues: number;
  worst: OpEvent['severity'] | null;
  /** One data-driven sentence for the page header. */
  sentence: string;
};

/** The one-sentence situation shown under the page title (the Overview's KPIs for the current shift). */
export function copilotSummary(s: SimState): CopilotSummary {
  const p = resolvePeriod('shift', s.minute);
  const lm = lineMetrics(s, p);
  const good = goodOutputKpi(s, p, lm);
  const att = targetAttainmentKpi(s, p, lm);
  const issues = activeIssuesKpi(s);
  const list = attentionEvents(s);
  const worst = list[0]?.severity ?? null;
  const scope = periodScope(s, p);
  const goodText = good.unavailable ? null : `${good.display} ${good.unit}`;
  const attText = att.unavailable ? null : `${att.display} ${att.unit}`;
  // The plan in the Good output card's words ("Plan to date 1,782 m² · shift 3,168 m²"): a pro-rata plan is never the shift's.
  const plan = good.target ? `${good.target.charAt(0).toLowerCase()}${good.target.slice(1)}` : null;
  // A figure on a stale sorting feed is the card's running value, marked not confirmed — never stated as fact.
  const stale = good.provenance === 'stale' || att.provenance === 'stale' ? (att.status?.label ?? good.status?.label ?? 'Not confirmed · data stale').replace(/^Not confirmed · /, '') : null;
  const output =
    !goodText || !attText || !plan
      ? 'no planned production time has elapsed yet'
      : stale
        ? `output vs plan not confirmed — ${stale} (simulated running total ${goodText} against ${plan})`
        : `good output ${goodText} against ${plan} — ${attText} of plan (${(att.status?.label ?? '').toLowerCase()})`;
  const open = list.length ? `${list.length} issue${list.length === 1 ? '' : 's'} require${list.length === 1 ? 's' : ''} attention (highest: ${worst})` : 'no issue requires attention';
  return {
    periodLabel: p.label,
    scope,
    good: goodText,
    attainment: attText,
    attainmentStatus: att.status?.label ?? null,
    issues: issues.value ?? 0,
    worst,
    sentence: `${scope}: ${output}; ${open}. Ask why, or pick an incident to investigate — answers are assembled from the same KPIs and event records as the workspaces.`,
  };
}
