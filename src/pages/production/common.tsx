import type { ReactNode } from 'react';
import { CircleCheck, Info, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CONVEYOR_BY_ID } from '../../model/plant';
import { fmtInt } from '../../ui/kit/format';

/** The three levels of the workspace. */
export type Level = 'factory' | 'line' | 'equipment';

export const LEVELS: { value: Level; label: string; about: string }[] = [
  { value: 'factory', label: 'Factory', about: 'Output, capacity, losses and their estimated value — and what to do about them' },
  { value: 'line', label: 'Production line', about: 'Throughput, the traced bottleneck, buffers and line OEE' },
  { value: 'equipment', label: 'Equipment', about: 'Every machine and conveyor — open one for its events, reports and the 3D view' },
];

export type Tone = 'good' | 'warning' | 'critical' | 'neutral';
export const TONE_ICON: Record<Tone, LucideIcon> = { good: CircleCheck, warning: TriangleAlert, critical: OctagonX, neutral: Info };

/** Display name of a machine or conveyor. */
export const assetName = (id: string) => EQUIPMENT_BY_ID[id]?.name ?? CONVEYOR_BY_ID[id]?.name ?? id;

export const m2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? '—' : `${fmtInt(v)} m²`);

/** Every money figure carries this label: it is an estimate from editable assumptions. */
export function EstTag({ title }: { title?: string }) {
  return (
    <span className="tag sim prod-est" title={title ?? 'Estimate from the editable financial assumptions (Factory level) — not a verified business loss'}>
      Estimate · assumptions shown
    </span>
  );
}

/** One cell of a summary band. */
export function Kpi({ label, value, lines, title }: { label: ReactNode; value: ReactNode; lines: ReactNode[]; title?: string }) {
  return (
    <div title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {lines.map((l, i) => (
        <div key={i} className="kpi-sub">
          {l}
        </div>
      ))}
    </div>
  );
}

/** Answer-first verdict line with an icon (never colour alone). */
export function Verdict({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone];
  return (
    <div className={`prod-verdict ${tone}`}>
      <Icon size={16} strokeWidth={2.2} aria-hidden />
      {children}
    </div>
  );
}
