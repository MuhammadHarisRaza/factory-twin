import { CircleCheck, Eye, PowerOff, Siren, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { HealthLevel } from '../../sim/health';
import { OP_COLOR_HEX, StatusBadge, toneToColor, type Tone } from '../../ui/kit/Status';

/**
 * Condition level in the product-wide four-colour scheme (green normal · amber watch /
 * warning · red alarm · grey offline), always with an icon and a label.
 */
export const LEVEL_META: Record<HealthLevel, { label: string; tone: Tone; icon: LucideIcon; hint: string }> = {
  normal: { label: 'Normal', tone: 'good', icon: CircleCheck, hint: 'Signals within the expected band for the current load' },
  watch: { label: 'Watch', tone: 'warning', icon: Eye, hint: 'Vibration ≥ 1.25× expected for the load, or rising faster than 0.3 mm/s per hour' },
  warning: {
    label: 'Warning',
    tone: 'warning',
    icon: TriangleAlert,
    hint: 'Vibration ≥ 1.6× expected or ≥ 80 % of the alarm limit, or temperature within 5 °C of its alarm limit',
  },
  alarm: { label: 'Alarm', tone: 'critical', icon: Siren, hint: 'Vibration or temperature at or above its alarm limit' },
  offline: { label: 'Offline', tone: 'neutral', icon: PowerOff, hint: 'Not running in the last 60 min — condition not assessed' },
};

export const levelColor = (l: HealthLevel) => OP_COLOR_HEX[toneToColor(LEVEL_META[l].tone)];

export function LevelBadge({ level, size }: { level: HealthLevel; size?: number }) {
  const m = LEVEL_META[level];
  return (
    <span title={m.hint}>
      <StatusBadge tone={m.tone} icon={m.icon} label={m.label} size={size} />
    </span>
  );
}

/** Health score 0–100 as a short bar plus the number; '—' when the asset is not assessed. */
export function ScoreBar({ score, level }: { score: number; level: HealthLevel }) {
  if (level === 'offline')
    return (
      <span className="mh-score" title="Not assessed while the machine is not running">
        <span className="mh-score-track" />
        <span className="metric-na">—</span>
      </span>
    );
  return (
    <span className="mh-score" title={`Health score ${score} / 100`}>
      <span className="mh-score-track">
        <i style={{ width: `${Math.max(2, Math.min(100, score))}%`, background: levelColor(level) }} />
      </span>
      <b className="num">{score}</b>
    </span>
  );
}
