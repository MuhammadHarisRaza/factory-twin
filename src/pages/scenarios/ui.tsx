import {
  Activity,
  Box,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Eye,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  OctagonX,
  ScanSearch,
  TriangleAlert,
  Truck,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceId } from '../../app/store';
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
  production: 'Production',
  quality: 'Quality',
  health: 'Machine Health',
  energy: 'Energy',
  command: 'Command Center',
  fleet: 'Fleet',
  twin: 'Factory Twin',
};
const WS_ICON: Partial<Record<WorkspaceId, LucideIcon>> = {
  production: Gauge,
  quality: ScanSearch,
  health: HeartPulse,
  energy: Zap,
  command: LayoutDashboard,
  fleet: Truck,
  twin: Box,
};

export function targetLabel(t: ShowTarget, s?: SimState) {
  if (t.type === 'equipment') return `Twin · ${t.id}`;
  if (t.type === 'vehicle') return `Twin · follow ${s?.logistics.vehicles[t.id]?.label ?? t.id}`;
  return WS_LABEL[t.id] ?? t.id;
}

export function ShowButton({ target, label, onNavigate }: { target: ShowTarget; label: string; onNavigate?: () => void }) {
  const Icon = target.type === 'workspace' ? (WS_ICON[target.id] ?? Eye) : target.type === 'vehicle' ? Truck : Box;
  const title =
    target.type === 'equipment'
      ? `Open the Factory Twin with ${target.id} selected`
      : target.type === 'vehicle'
        ? 'Open the Factory Twin following this truck'
        : `Open ${label}`;
  return (
    <button
      className="btn sm"
      title={title}
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
