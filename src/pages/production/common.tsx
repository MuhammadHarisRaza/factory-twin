/**
 * Small shared pieces of the Production workspace: a section with a footnote, the KPI-card adapter,
 * the estimate tag, verdict lines and asset names. Figures come from src/sim/metrics.ts and
 * src/intel/kpis.ts; these only present them.
 */
import type { ReactNode } from 'react';
import { CircleCheck, Info, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import type { KpiModel } from '../../intel/kpis';
import { kpiCardProps as sharedKpiCardProps } from '../../ui/kit/Page';
import { CONVEYOR_BY_ID, OPS_BY_ID } from '../../model/plant';
import { fmtInt } from '../../ui/kit/format';
import { ProvenanceBadge, Section } from '../../ui/kit/Page';

export type Tone = 'good' | 'warning' | 'critical' | 'neutral';
export const TONE_ICON: Record<Tone, LucideIcon> = { good: CircleCheck, warning: TriangleAlert, critical: OctagonX, neutral: Info };

/** Display name of a machine or conveyor. */
export const assetName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;

/** Whether an asset has the equipment drill-down (a process machine with an ideal rate, or a conveyor). */
export const canDrill = (id: string) => !!CONVEYOR_BY_ID[id] || OPS_BY_ID[id]?.idealRatePerHour != null;

export const m2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${fmtInt(v)} m²`);

/** KpiModel (src/intel/kpis.ts) → KpiCard props: the kit's shared mapper (same value, scope, status, provenance everywhere). */
export const kpiCardProps = (k: KpiModel) => sharedKpiCardProps(k);

/** Every money figure carries this label: an estimate from the editable financial assumptions. */
export function EstTag({ title }: { title?: string }) {
  return <ProvenanceBadge kind="estimate" title={title ?? 'Estimate from the editable financial assumptions (Analysis → Assumptions & what-ifs) — not a verified business loss and not a saving'} />;
}

/** Answer-first verdict line with an icon (never colour alone). */
export function Verdict({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={`prod-verdict ${tone}`}>
      <Icon size={16} strokeWidth={2.2} aria-hidden />
      <span>{children}</span>
    </div>
  );
}

/** A kit Section with an optional footnote (method, basis, honesty notes) under its body. */
export function Block({
  title,
  subtitle,
  actions,
  children,
  note,
  flush = false,
  className = '',
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  note?: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <Section title={title} subtitle={subtitle} actions={actions} flush={flush} className={`prod-block ${className}`} id={id}>
      {children}
      {note && <div className="prod-note">{note}</div>}
    </Section>
  );
}
