/** Shared labels and small presentational pieces of the Vehicle Monitoring workspace. */
import { CalendarClock, CircleDashed, CirclePause, FileText, MoveRight, PackageCheck, TriangleAlert, Wrench, type LucideIcon } from 'lucide-react';
import type { Vehicle } from '../../model/types';
import { formatDuration } from '../../sim/time';
import { StatusBadge, type Tone } from '../../ui/kit/Status';
import type { DockStatus } from './derive';
import type { MovementState } from './pipeline';

export const TYPE_LABEL: Record<Vehicle['type'], string> = {
  'outbound-truck': 'Outbound truck',
  'inbound-tipper': 'Inbound tipper',
  forklift: 'Forklift',
  'wheel-loader': 'Wheel loader',
};

export const DOCK_STATUS: Record<DockStatus, { label: string; tone: Tone; icon: LucideIcon }> = {
  free: { label: 'Free', tone: 'neutral', icon: CircleDashed },
  reserved: { label: 'Reserved', tone: 'planned', icon: CalendarClock },
  loading: { label: 'Loading', tone: 'good', icon: PackageCheck },
  paperwork: { label: 'Paperwork', tone: 'neutral', icon: FileText },
  held: { label: 'Held (documentation)', tone: 'warning', icon: TriangleAlert },
};

export const MOVEMENT: Record<MovementState, { label: string; tone: Tone; icon: LucideIcon }> = {
  moving: { label: 'Moving', tone: 'good', icon: MoveRight },
  working: { label: 'Working (stationary)', tone: 'good', icon: Wrench },
  idle: { label: 'Idle / waiting', tone: 'neutral', icon: CirclePause },
};

export const dur = (m: number | null | undefined) => formatDuration(m);

/** Clock formatter with the day for minutes before today. */
export type Clock = (m: number) => string;

export const MovementBadge = ({ state }: { state: MovementState }) => <StatusBadge {...MOVEMENT[state]} />;

/** Compact honesty label for vehicle positions. */
export const PositionTag = ({ long = false }: { long?: boolean }) => (
  <span className="tag sim" title="Positions come from the simulation at zone level; no GPS, telematics or indoor positioning is connected">
    {long ? 'Simulated position · zone level — no indoor positioning connected' : 'Simulated position · zone level'}
  </span>
);

/** Money estimate with thousands separators (currency code first). */
export const fmtMoney = (currency: string, v: number) => `${currency} ${Math.round(v).toLocaleString('en-GB')}`;
