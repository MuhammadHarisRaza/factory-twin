/**
 * The signal table's pure model (brief §6C): an equipment item's catalogue signals (src/model/catalog catalogFor)
 * joined with their current reading (src/sim/telemetry readSignal), the filters and the detail lines. The status
 * comes from the catalogue: a reading of a signal the catalogue lists as unavailable (an illustrative energy model)
 * is not shown as a value. A 'bad' reading keeps its value but says Bad; a stale one says Stale. Rendered by
 * src/ui/equipment/panel/SignalTable.tsx.
 */
import {
  AVAILABILITY_CLASS_HINT,
  AVAILABILITY_CLASS_LABEL,
  AVAILABILITY_STATUS_LABEL,
  SOURCE_SYSTEM_LABEL,
  catalogFor,
  definitionOf,
  type SignalCategory,
  type SignalDefinition,
} from '../../../model/catalog';
import type { TelemetrySample } from '../../../model/telemetry';
import type { SimState } from '../../../sim/engine';
import { readSignal } from '../../../sim/telemetry';
import { formatClock } from '../../../sim/time';
import { localeNumber } from '../../../sim/numberFormat';

export type SignalQualityWord = 'Good' | 'Uncertain' | 'Bad' | 'Stale' | 'No value' | 'Not modelled' | 'Unavailable';

export type SignalTableRow = {
  def: SignalDefinition;
  /** The panel's own words for the signal when it has them ("Vibration · hydraulic power unit"); else the catalogue name. */
  label?: string;
  /** Display value without the unit (null: none shown). */
  value: string | null;
  unit: string | null;
  quality: SignalQualityWord;
  /** Why there is no value / why it is not good. */
  note: string | null;
  /** Plant minute of the value (null = never received). */
  timestamp: number | null;
  /** "< 1 min", "3 min", "2 h 10 min", "—". */
  age: string;
  /** The demo has a value for it (simulated and a sample received). */
  hasValue: boolean;
};

/** Age of a value read at plant minute `now` (the newest simulated minute is now − 1). */
export function ageText(timestamp: number | null, now: number): string {
  if (timestamp == null) return '—';
  const min = Math.max(0, now - 1 - timestamp);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  return h >= 48 ? `${Math.floor(h / 24)} d` : `${h} h ${String(Math.round(min % 60)).padStart(2, '0')} min`;
}

/** One table row from a catalogue definition and its reading. */
export function signalTableRow(def: SignalDefinition, r: TelemetrySample, now: number): SignalTableRow {
  if (def.availabilityStatus !== 'simulated' && def.availabilityStatus !== 'connected') {
    const word: SignalQualityWord = def.availabilityStatus === 'not-modelled' ? 'Not modelled' : 'Unavailable';
    return { def, value: null, unit: def.unit, quality: word, note: def.statusNote ?? null, timestamp: null, age: '—', hasValue: false };
  }
  const has = r.value != null && r.quality !== 'missing';
  const word: SignalQualityWord = !has ? 'No value' : r.quality === 'good' ? 'Good' : r.quality === 'uncertain' ? 'Uncertain' : r.quality === 'bad' ? 'Bad' : 'Stale';
  return {
    def,
    // An absent alarm code is not proof of no fault: said as such, never as "no alarm".
    value: has ? (def.category === 'alarm' && r.value === 'none' ? 'No active alarm code' : r.text) : null,
    // The catalogue unit wins (stage 1–2 rates are 'tile-eq/h' there, never 'tiles/h').
    unit: def.unit ?? r.unit,
    quality: word,
    note: r.note ?? (has ? null : 'No value received'),
    timestamp: r.timestamp,
    age: ageText(r.timestamp, now),
    hasValue: has,
  };
}

/** The table rows of an equipment item (catalogue order: by category, simulated first, setpoints after their PV). */
export function signalTableRows(s: SimState, equipmentId: string): SignalTableRow[] {
  return catalogFor(equipmentId).map((d) => signalTableRow(d, readSignal(s, d.signalId), s.minute));
}

export type AvailabilityFilter = 'all' | 'value' | 'none';
export type SignalFilter = { query: string; category: SignalCategory | 'all'; availability: AvailabilityFilter };
export const ALL_SIGNALS: SignalFilter = { query: '', category: 'all', availability: 'all' };

/** Categories present in the rows, in catalogue order. */
export const categoriesOf = (rows: SignalTableRow[]): SignalCategory[] => [...new Set(rows.map((r) => r.def.category))];

const simulatedRow = (r: SignalTableRow) => r.def.availabilityStatus === 'simulated' || r.def.availabilityStatus === 'connected';

/**
 * Rows after the filters: `shown` in order (simulated first), and — in the default view only (no search, every
 * category and availability) — the not-modelled / unavailable rows folded away as `more`.
 */
export function filterSignalRows(rows: SignalTableRow[], f: SignalFilter): { shown: SignalTableRow[]; more: SignalTableRow[] } {
  const q = f.query.trim().toLowerCase();
  const hit = rows.filter(
    (r) =>
      (f.category === 'all' || r.def.category === f.category) &&
      (f.availability === 'all' || (f.availability === 'value' ? r.hasValue : !r.hasValue)) &&
      (!q ||
        r.def.name.toLowerCase().includes(q) ||
        (r.label ?? '').toLowerCase().includes(q) ||
        r.def.signalId.toLowerCase().includes(q) ||
        r.def.description.toLowerCase().includes(q)),
  );
  const ordered = [...hit.filter(simulatedRow), ...hit.filter((r) => !simulatedRow(r))];
  if (q || f.category !== 'all' || f.availability !== 'all') return { shown: ordered, more: [] };
  return { shown: ordered.filter(simulatedRow), more: ordered.filter((r) => !simulatedRow(r)) };
}

const num = (v: number | undefined) => (v == null ? null : localeNumber(v, undefined, 3));

/** The detail lines of a signal (label → value), for the inline detail. */
export function signalDetail(row: SignalTableRow): { label: string; value: string; hint?: string }[] {
  const d = row.def;
  const u = d.unit ? ` ${d.unit}` : '';
  const lines: { label: string; value: string; hint?: string }[] = [
    { label: 'Signal id', value: d.signalId },
    { label: 'Source system', value: `${SOURCE_SYSTEM_LABEL[d.sourceSystem]} · Tag: not configured (mapped at integration)` },
    { label: 'Availability', value: `${AVAILABILITY_CLASS_LABEL[d.availabilityClass]} · ${AVAILABILITY_STATUS_LABEL[d.availabilityStatus]}`, hint: AVAILABILITY_CLASS_HINT[d.availabilityClass] },
    { label: 'Class means', value: AVAILABILITY_CLASS_HINT[d.availabilityClass] },
  ];
  if (d.statusNote) lines.push({ label: 'Status note', value: d.statusNote });
  if (d.engineeringMin != null || d.engineeringMax != null) lines.push({ label: 'Engineering range', value: `${num(d.engineeringMin) ?? '—'} – ${num(d.engineeringMax) ?? '—'}${u}` });
  const lim = (lo?: number, hi?: number) => [lo != null ? `low ${num(lo)}` : null, hi != null ? `high ${num(hi)}` : null].filter(Boolean).join(' · ');
  if (d.warningLow != null || d.warningHigh != null) lines.push({ label: 'Warning limits', value: `${lim(d.warningLow, d.warningHigh)}${u}` });
  if (d.alarmLow != null || d.alarmHigh != null) lines.push({ label: 'Alarm limits', value: `${lim(d.alarmLow, d.alarmHigh)}${u}` });
  if (d.setpointSignalId) lines.push({ label: 'Setpoint signal', value: `${definitionOf(d.setpointSignalId)?.name ?? d.setpointSignalId} (${d.setpointSignalId})` });
  lines.push({ label: 'Expected update', value: d.expectedUpdateIntervalS == null ? 'Event-driven or not scanned' : `every ${d.expectedUpdateIntervalS} s` });
  if (d.counter) lines.push({ label: 'Counter', value: `${d.counter.rolloverAt != null ? `rolls over at ${num(d.counter.rolloverAt)}` : 'no rollover modelled'}${d.counter.resetOn ? ` · ${d.counter.resetOn}` : ''}` });
  if (row.timestamp != null) lines.push({ label: 'Last value at', value: formatClock(row.timestamp) });
  if (row.note && row.note !== d.statusNote) lines.push({ label: 'Reading', value: row.note });
  return lines;
}
