import { CircleCheck, CircleSlash, Eye, Info, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { InsightKind, InsightSeverity } from '../../intel/insights';
import type { HealthLevel } from '../../sim/health';
import { StatusBadge, type Tone } from '../../ui/kit/Status';

export const INSIGHT_SEVERITY: Record<InsightSeverity, { label: string; tone: Tone; icon: LucideIcon }> = {
  critical: { label: 'Critical', tone: 'critical', icon: OctagonX },
  serious: { label: 'Serious', tone: 'serious', icon: TriangleAlert },
  warning: { label: 'Warning', tone: 'warning', icon: TriangleAlert },
  info: { label: 'Info', tone: 'neutral', icon: Info },
  positive: { label: 'On track', tone: 'good', icon: CircleCheck },
};

export const InsightBadge = ({ severity }: { severity: InsightSeverity }) => <StatusBadge {...INSIGHT_SEVERITY[severity]} />;

export const INSIGHT_KIND: Record<InsightKind, string> = {
  target: 'Output',
  stoppage: 'Stoppage',
  bottleneck: 'Bottleneck',
  buffer: 'Buffer',
  quality: 'Quality',
  health: 'Machine health',
  energy: 'Energy',
  logistics: 'Logistics',
  shift: 'Shift',
};

const HEALTH: Record<HealthLevel, { label: string; tone: Tone; icon: LucideIcon }> = {
  normal: { label: 'Normal', tone: 'good', icon: CircleCheck },
  watch: { label: 'Watch', tone: 'warning', icon: Eye },
  warning: { label: 'Warning', tone: 'serious', icon: TriangleAlert },
  alarm: { label: 'Alarm', tone: 'critical', icon: OctagonX },
  offline: { label: 'Offline', tone: 'neutral', icon: CircleSlash },
};

export const HealthBadge = ({ level, score }: { level: HealthLevel; score?: number }) => {
  const h = HEALTH[level];
  return <StatusBadge tone={h.tone} icon={h.icon} label={score != null && level !== 'offline' ? `${h.label} · ${score}/100` : h.label} />;
};
