import {
  Activity,
  Box,
  CircleCheck,
  ClipboardList,
  CircleDot,
  CircleSlash,
  Eye,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  MessageSquareText,
  OctagonX,
  ScanSearch,
  TriangleAlert,
  Truck,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceId } from '../../app/store';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import type { SimState } from '../../sim/engine';
import type { HealthLevel } from '../../sim/health';
import { StatusBadge, type Tone } from '../../ui/kit/Status';
import { when, type ParamOption, type ParamValue, type ScenarioStatus, type ShowTarget, type StatusKey } from './catalogue';
import { showTarget } from './actions';

export function ParamSelect({ label, value, options, onChange }: { label: string; value: ParamValue; options: ParamOption[]; onChange: (v: ParamValue) => void }) {
  return (
    <label className="field scnp-field">
      {label}
      <select
        className="select"
        value={String(value)}
        onChange={(e) => {
          const o = options.find((x) => String(x.value) === e.target.value);
          if (o) onChange(o.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const STATUS: Record<StatusKey, { icon: LucideIcon; cls: string; prefix: string }> = {
  active: { icon: Activity, cls: 'on', prefix: 'since' },
  resolved: { icon: CircleDot, cls: 'on', prefix: 'at' },
  applied: { icon: CircleCheck, cls: '', prefix: 'at' },
  ended: { icon: CircleSlash, cls: '', prefix: 'at' },
  completed: { icon: CircleCheck, cls: '', prefix: 'at' },
};

/** Scenario status (an input's lifecycle, not an equipment state — so accent, not status colours). Icon + label. */
export function ScenarioState({ st, now, time = true }: { st: ScenarioStatus; now: number; time?: boolean }) {
  const { icon: Icon, cls, prefix } = STATUS[st.key];
  return (
    <span className={`scnp-state ${cls}`}>
      <Icon size={13} strokeWidth={2.2} aria-hidden />
      {st.label}
      {time && st.at != null && (
        <span className="scnp-state-t">
          {prefix} {when(st.at, now)}
        </span>
      )}
    </span>
  );
}

// ── Show me ───────────────────────────────────────────────────────────────────

export const WS_LABEL: Partial<Record<WorkspaceId, string>> = {
  monitoring: 'Production Monitoring',
  production: 'OEE & Loss',
  quality: 'AI Defect Monitoring',
  fleet: 'Vehicle Monitoring',
  events: 'Events & Reports',
  health: 'Machine Health',
  energy: 'Energy',
  command: 'Command Center',
  twin: 'Factory Twin',
};
const WS_ICON: Partial<Record<WorkspaceId, LucideIcon>> = {
  monitoring: Activity,
  production: Gauge,
  quality: ScanSearch,
  fleet: Truck,
  events: ClipboardList,
  health: HeartPulse,
  energy: Zap,
  command: LayoutDashboard,
  twin: Box,
};

export function targetLabel(t: ShowTarget, s?: SimState) {
  switch (t.type) {
    case 'equipment':
      return `Twin · ${t.id}`;
    case 'vehicle':
      return `Twin · follow ${s?.logistics.vehicles[t.id]?.label ?? t.id}`;
    case 'stage':
      return `Monitoring · ${MONITORED_STAGE_BY_ID[t.id]?.name ?? t.id}`;
    case 'event':
      return `Event report · ${t.id}`;
    case 'copilot':
      return 'Ask copilot';
    default:
      return WS_LABEL[t.id] ?? t.id;
  }
}

const targetIcon = (t: ShowTarget): LucideIcon =>
  t.type === 'workspace'
    ? (WS_ICON[t.id] ?? Eye)
    : t.type === 'vehicle'
      ? Truck
      : t.type === 'stage'
        ? Activity
        : t.type === 'event'
          ? ClipboardList
          : t.type === 'copilot'
            ? MessageSquareText
            : Box;

function targetTitle(t: ShowTarget, label: string) {
  switch (t.type) {
    case 'equipment':
      return `Open the Factory Twin with ${t.id} selected`;
    case 'vehicle':
      return 'Open the Factory Twin following this vehicle';
    case 'stage':
      return 'Open the stage in Production Monitoring';
    case 'event':
      return `Open the report of ${t.id} in Events & Reports (the same record as the PDF)`;
    case 'copilot':
      return `Ask the copilot (rule-based on the current demo state — no language model): “${t.question}”`;
    default:
      return `Open ${label}`;
  }
}

export function ShowButton({
  target,
  label,
  onNavigate,
  primary = false,
}: {
  target: ShowTarget;
  label: string;
  onNavigate?: () => void;
  primary?: boolean;
}) {
  const Icon = targetIcon(target);
  return (
    <button
      className={`btn sm ${primary ? 'primary' : ''}`}
      title={targetTitle(target, label)}
      onClick={() => {
        onNavigate?.();
        showTarget(target);
      }}
    >
      <Icon size={13} aria-hidden />
      {label}
    </button>
  );
}

// ── Condition level (what the signals show) ───────────────────────────────────

export const LEVEL: Record<HealthLevel, { label: string; tone: Tone; icon: LucideIcon }> = {
  normal: { label: 'Normal', tone: 'good', icon: CircleCheck },
  watch: { label: 'Watch', tone: 'warning', icon: Eye },
  warning: { label: 'Warning', tone: 'warning', icon: TriangleAlert },
  alarm: { label: 'Alarm', tone: 'critical', icon: OctagonX },
  offline: { label: 'Not running', tone: 'neutral', icon: CircleSlash },
};
export const LevelBadge = ({ level }: { level: HealthLevel }) => <StatusBadge {...LEVEL[level]} />;
