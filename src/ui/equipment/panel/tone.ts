/**
 * Icons of the panel's tones and insight severities (always shown with words, never colour alone).
 * One concept, one icon: a stale / unconfirmed reading is CircleHelp everywhere (the kit's unknown and
 * stale states), "Simulated" keeps CircleDashed (the kit's simulated source), a neutral verdict is a
 * plain Circle, a planned stop CalendarClock (the kit's planned state).
 */
import { CalendarClock, Circle, CircleCheck, CircleHelp, Info, OctagonX, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { Tone } from '../../kit/Status';
import type { IntelInsight, IntelTone } from '../intel/types';

export const TONE_ICON: Record<IntelTone | Tone, LucideIcon> = {
  good: CircleCheck,
  warning: TriangleAlert,
  serious: TriangleAlert,
  critical: OctagonX,
  neutral: Circle,
  planned: CalendarClock,
};

/** The one icon of a stale feed / a figure not confirmed by its feed (the kit's unknown / stale icon). */
export const STALE_ICON: LucideIcon = CircleHelp;

/** A value or status that says it is a last value or not confirmed (a stale feed). */
export const isStaleWording = (t: string) => /^(unknown|last value|not confirmed)\b|not confirmed/i.test(t);

export const SEVERITY_META: Record<IntelInsight['severity'], { icon: LucideIcon; label: string; tone: Tone }> = {
  positive: { icon: CircleCheck, label: 'Normal', tone: 'good' },
  info: { icon: Info, label: 'Info', tone: 'neutral' },
  warning: { icon: TriangleAlert, label: 'Warning', tone: 'warning' },
  serious: { icon: TriangleAlert, label: 'Serious', tone: 'serious' },
  critical: { icon: OctagonX, label: 'Critical', tone: 'critical' },
};
