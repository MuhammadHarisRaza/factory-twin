import {
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
  Gauge,
  OctagonX,
  TriangleAlert,
  CalendarClock,
  Info,
  type LucideIcon,
} from 'lucide-react';
import type { AlertSeverity, MachineState, SourceStatus } from '../../model/types';
import type { Metric } from '../../sim/oee';
import { fmtMetric } from './format';

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'planned';

export const MACHINE_STATE: Record<MachineState, { label: string; tone: Tone; icon: LucideIcon }> = {
  running: { label: 'Running', tone: 'good', icon: CircleCheck },
  reduced: { label: 'Reduced rate', tone: 'warning', icon: Gauge },
  starved: { label: 'Starved', tone: 'neutral', icon: CirclePause },
  blocked: { label: 'Blocked', tone: 'neutral', icon: CircleSlash },
  down: { label: 'Down', tone: 'critical', icon: OctagonX },
  planned: { label: 'Planned stop', tone: 'planned', icon: CalendarClock },
};

export const SEVERITY: Record<AlertSeverity, { label: string; tone: Tone; icon: LucideIcon }> = {
  info: { label: 'Info', tone: 'neutral', icon: Info },
  warning: { label: 'Warning', tone: 'warning', icon: TriangleAlert },
  serious: { label: 'Serious', tone: 'serious', icon: TriangleAlert },
  critical: { label: 'Critical', tone: 'critical', icon: OctagonX },
};

export const SOURCE_STATUS: Record<SourceStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  simulated: { label: 'Simulated', tone: 'warning', icon: CircleDashed },
  configured: { label: 'Configured', tone: 'neutral', icon: CirclePause },
  disconnected: { label: 'Disconnected', tone: 'neutral', icon: CircleSlash },
  connected: { label: 'Connected', tone: 'good', icon: CircleCheck },
};

/** Icon + label status. Colour is never the only carrier of meaning. */
export function StatusBadge({ tone, icon: Icon, label, size = 13 }: { tone: Tone; icon: LucideIcon; label: string; size?: number }) {
  return (
    <span className={`status ${tone}`}>
      <Icon size={size} strokeWidth={2.2} aria-hidden />
      {label}
    </span>
  );
}

export const MachineStatus = ({ state }: { state: MachineState }) => <StatusBadge {...MACHINE_STATE[state]} />;
export const SeverityBadge = ({ severity }: { severity: AlertSeverity }) => <StatusBadge {...SEVERITY[severity]} />;
export const SourceBadge = ({ status }: { status: SourceStatus }) => <StatusBadge {...SOURCE_STATUS[status]} />;

/** Labels a record as simulated or scenario-generated. */
export function SourceTag({ source }: { source: 'simulation' | 'scenario' }) {
  return source === 'scenario' ? <span className="tag scenario">Scenario</span> : <span className="tag sim">Simulated</span>;
}

/** A metric value that shows why it is unavailable or invalid instead of a misleading number. */
export function MetricText({ m, digits = 1 }: { m: Metric; digits?: number }) {
  if (m.status === 'ok') return <span className="num">{fmtMetric(m, digits)}</span>;
  if (m.status === 'invalid')
    return (
      <span className="metric-invalid" title={m.issue}>
        Invalid
      </span>
    );
  return (
    <span className="metric-na" title={m.issue}>
      —
    </span>
  );
}
