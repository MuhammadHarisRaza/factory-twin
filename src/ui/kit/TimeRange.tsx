/**
 * Time-range control for charts (15 min / 1 h / 8 h / 24 h / 7 days by default, from
 * src/model/telemetry.ts RANGE_OPTIONS). Same look as Segmented; a radio group with one Tab stop
 * (arrows move between the ranges that are available). A range the data cannot serve stays
 * visible but disabled, with the reason as its tooltip and accessible description, instead of
 * disappearing or drawing an empty chart.
 */
import { useRef, type KeyboardEvent } from 'react';
import { RANGE_OPTIONS, type RangeKey, type RangeOption } from '../../model/telemetry';
import './kit.css';

/** What the option draws: 'minute data', '5-min steps from minute data', 'hourly data'. */
const basisOf = (o: RangeOption) => (o.resolution === 'hour' ? 'hourly data' : o.stepMin === 1 ? 'minute data' : `${o.stepMin}-min steps from minute data`);

export function TimeRange({
  value,
  onChange,
  options = RANGE_OPTIONS,
  disabled,
  label = 'Time range',
}: {
  value: RangeKey;
  onChange: (k: RangeKey) => void;
  options?: RangeOption[];
  /** Ranges that cannot be shown, with the reason (e.g. 'Minute history covers the last 8 h'). */
  disabled?: Partial<Record<RangeKey, string>>;
  label?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = (i: number) => !disabled?.[options[i].key];
  const checked = options.findIndex((o) => o.key === value);
  // The Tab stop: the selected range, else the first available one.
  const stop = checked >= 0 ? checked : Math.max(0, options.findIndex((_, i) => enabled(i)));
  const go = (i: number) => {
    refs.current[i]?.focus();
    if (options[i].key !== value) onChange(options[i].key);
  };
  const step = (from: number, dir: 1 | -1) => {
    for (let k = 1; k <= options.length; k++) {
      const j = (from + dir * k + options.length) % options.length;
      if (enabled(j)) return go(j);
    }
  };
  const onKeyDown = (i: number) => (e: KeyboardEvent) => {
    const avail = options.map((_, j) => j).filter(enabled);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') step(i, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') step(i, -1);
    else if (e.key === 'Home' && avail.length) go(avail[0]);
    else if (e.key === 'End' && avail.length) go(avail[avail.length - 1]);
    else return;
    e.preventDefault();
  };
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const reason = disabled?.[o.key];
        const on = i === checked;
        return (
          <button
            key={o.key}
            type="button"
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="radio"
            aria-checked={on}
            aria-disabled={reason ? true : undefined}
            tabIndex={i === stop ? 0 : -1}
            className={[on ? 'on' : '', reason ? 'off' : ''].filter(Boolean).join(' ') || undefined}
            title={reason ?? `${o.label} · ${basisOf(o)}`}
            onClick={() => {
              if (!reason && !on) onChange(o.key);
            }}
            onKeyDown={onKeyDown(i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
