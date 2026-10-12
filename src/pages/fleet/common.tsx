/** Shared labels and small presentational pieces of the Fleet & Movement workspace. */
import {
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleSlash,
  FileQuestion,
  FileText,
  History,
  MoveRight,
  PackageCheck,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Vehicle } from '../../model/types';
import type { KpiModel } from '../../intel/kpis';
import { kpiCardProps as sharedKpiCardProps } from '../../ui/kit/Page';
import { dayStart, formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { StatusBadge, type Tone } from '../../ui/kit/Status';
import type { DockStatus } from './derive';
import type { VisitIntegrity } from './integrity';
import type { LocationKind } from './movement';
import type { MovementState } from './pipeline';

export const TYPE_LABEL: Record<Vehicle['type'], string> = {
  'outbound-truck': 'Outbound truck',
  'inbound-tipper': 'Inbound tipper',
  forklift: 'Forklift',
  'wheel-loader': 'Wheel loader',
};

/** Internal / external classification in words. */
export const classLabel = (v: Vehicle) => (v.class === 'external' ? 'External vehicle (carrier)' : 'Internal vehicle (site fleet)');

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

/** Plant clock that adds the day for minutes before the current production day (06:00). */
export const makeClock =
  (now: number): Clock =>
  (m: number) =>
    m < dayStart(now) ? formatDateTime(m) : formatClock(m);

/** A "since" time that names the start of the simulated history instead of implying an observed start. */
export const sinceText = (m: number, clock: Clock) => (m < 1 ? 'the start of the simulated history' : clock(m));

export const MovementBadge = ({ state }: { state: MovementState }) => <StatusBadge {...MOVEMENT[state]} />;

/** Compact honesty label for vehicle positions. */
export const PositionTag = ({ long = false }: { long?: boolean }) => (
  <span className="tag sim" title="Positions come from the simulation at zone level; no GPS, telematics or indoor positioning is connected">
    {long ? 'Simulated position · zone level — no indoor positioning connected' : 'Simulated position · zone level'}
  </span>
);

export const POSITIONS_NOTE = 'Simulated positions — no tracking system connected';

/** The map's provenance badge: positions are simulated, never GPS coordinates. */
export const PositionsBadge = () => (
  <span
    className="fl-posbadge"
    title="Vehicle positions are interpolated from the simulated routes on the site layout (zone level). No GPS, telematics, ANPR or indoor positioning is connected — these are not GPS coordinates."
  >
    <CircleDashed size={12} strokeWidth={2.2} aria-hidden />
    {POSITIONS_NOTE}
  </span>
);

const LOCATION_ICON: Record<LocationKind, LucideIcon> = {
  simulated: CircleDashed,
  historical: History,
  'not-arrived': CalendarClock,
  none: CircleSlash,
};

/** What kind of location is shown (simulated now · last known historical · none) — icon + words. */
export const LocationKindTag = ({ kind, label }: { kind: LocationKind; label: string }) => {
  const Icon = LOCATION_ICON[kind];
  return (
    <span className={`fl-lockind ${kind}`}>
      <Icon size={12} strokeWidth={2.2} aria-hidden />
      {label}
    </span>
  );
};

const INTEGRITY: Record<VisitIntegrity['kind'], { tone: Tone; icon: LucideIcon }> = {
  active: { tone: 'good', icon: CircleCheck },
  completed: { tone: 'neutral', icon: CircleCheck },
  approaching: { tone: 'neutral', icon: MoveRight },
  scheduled: { tone: 'planned', icon: CalendarClock },
  incomplete: { tone: 'neutral', icon: FileQuestion },
};

/** Visit-record status: active / completed / before gate-in / scheduled / record incomplete? */
export const IntegrityBadge = ({ integrity }: { integrity: VisitIntegrity }) => <StatusBadge {...INTEGRITY[integrity.kind]} label={integrity.label} />;

/** KpiModel (src/intel/kpis.ts) → KpiCard props: the kit's shared mapper (same value, scope, status, provenance everywhere). */
export const kpiCardProps = (k: KpiModel) => sharedKpiCardProps(k);

/** Money estimate with thousands separators (currency code first). */
export const fmtMoney = (currency: string, v: number) => `${currency} ${Math.round(v).toLocaleString('en-GB')}`;
