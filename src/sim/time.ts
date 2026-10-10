/**
 * Plant time. The simulation counts integer "plant minutes" from SIM_EPOCH
 * (Monday 5 October 2026, 06:00 plant time). Timestamps are encoded as UTC
 * milliseconds that *represent* plant wall-clock time, so formatting always
 * uses timeZone 'UTC' and is independent of the viewer's machine.
 */
import type { ShiftId, ShiftInstance } from '../model/types';

export const SIM_EPOCH = Date.UTC(2026, 9, 5, 6, 0, 0);
export const MIN_PER_HOUR = 60;
export const MIN_PER_DAY = 1440;
export const SHIFT_MIN = 480;
/** Where a fresh simulation starts: 7 days of history, then Monday 12 Oct 10:30. */
export const DEFAULT_START = 7 * MIN_PER_DAY + 4 * 60 + 30;

export const toMs = (minute: number) => SIM_EPOCH + minute * 60_000;
export const toIso = (minute: number) => new Date(toMs(minute)).toISOString().replace('.000Z', '');

const fmt = (minute: number, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(toMs(minute)));

export const formatClock = (minute: number) => fmt(minute, { hour: '2-digit', minute: '2-digit', hour12: false });
export const formatClockSec = (minute: number) =>
  fmt(minute, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const formatDay = (minute: number) => fmt(minute, { weekday: 'short', day: 'numeric', month: 'short' });
export const formatDateTime = (minute: number) => `${formatDay(minute)} ${formatClock(minute)}`;
export const formatDate = (minute: number) => new Date(toMs(minute)).toISOString().slice(0, 10);

/** Duration in minutes → "1 h 05 min" / "42 min" / "—". */
export function formatDuration(min: number | null | undefined) {
  if (min == null || !Number.isFinite(min)) return '—';
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** Shift pattern: A 06–14, B 14–22, C 22–06 (C belongs to the date it starts on). */
const SHIFT_START: Record<ShiftId, number> = { A: 0, B: 480, C: 960 };

export function shiftAt(minute: number): ShiftInstance {
  const dayIndex = Math.floor(minute / MIN_PER_DAY);
  const inDay = minute - dayIndex * MIN_PER_DAY;
  const id: ShiftId = inDay < 480 ? 'A' : inDay < 960 ? 'B' : 'C';
  return shiftInstance(dayIndex, id);
}

export function shiftInstance(dayIndex: number, id: ShiftId): ShiftInstance {
  const start = dayIndex * MIN_PER_DAY + SHIFT_START[id];
  const names: Record<ShiftId, string> = { A: '06:00–14:00', B: '14:00–22:00', C: '22:00–06:00' };
  return { id, date: formatDate(dayIndex * MIN_PER_DAY), start, end: start + SHIFT_MIN, label: `Shift ${id} · ${names[id]}` };
}

/** Shift that ended most recently before `minute`'s current shift. */
export const previousShift = (minute: number) => shiftAt(shiftAt(minute).start - 1);

/** Production day boundaries (06:00 → 06:00). */
export const dayStart = (minute: number) => Math.floor(minute / MIN_PER_DAY) * MIN_PER_DAY;
