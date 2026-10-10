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
  starved: { label: 'Starved', tone: 'warning', icon: CirclePause },
  blocked: { label: 'Blocked', tone: 'warning', icon: CircleSlash },
  down: { label: 'Down', tone: 'critical', icon: OctagonX },
  planned: { label: 'Planned stop', tone: 'neutral', icon: CalendarClock },
};

/**
 * The product-wide four-state operational colour scheme:
 * green running normally · amber warning / degraded · red stopped or critical · grey offline / planned / unavailable.
 */
export type OpColor = 'green' | 'amber' | 'red' | 'grey';
export const OP_COLOR_HEX: Record<OpColor, string> = { green: '#2fb344', amber: '#fab219', red: '#e05252', grey: '#8a9bad' };
export const toneToColor = (t: Tone): OpColor => (t === 'good' ? 'green' : t === 'warning' || t === 'serious' ? 'amber' : t === 'critical' ? 'red' : 'grey');
export const machineColor = (state: MachineState | null | undefined): OpColor => (state ? toneToColor(MACHINE_STATE[state].tone) : 'grey');

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
