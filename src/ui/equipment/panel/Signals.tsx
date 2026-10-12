/**
 * PLC-style signals of the subject, ordered by usefulness (run state, rate, alarm, condition, conveyor,
 * buffer, inspection, counters): label · value and unit · interpretation against its configured limit
 * (limits in the tooltip) · a sparkline only where history exists. The freshness every row shares is
 * said once in the heading; a row that differs says its own. Parameters the model does not contain
 * are one muted "Not modelled" line whose reasons open below it.
 */
import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Sparkline } from '../../kit/charts';
import type { IntelSignal, IntelSignals } from '../intel/types';
import { STALE_ICON, TONE_ICON } from './tone';

/** The freshness most rows share (said once in the section heading). */
export function commonFreshness(rows: IntelSignal[]): string | null {
  if (!rows.length) return null;
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.freshness, (n.get(r.freshness) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function Row({ r, shared, on }: { r: IntelSignal; shared: string | null; on: boolean }) {
  const it = r.interpretation;
  // A reading of a stale / unconfirmed feed carries the one stale icon, not the neutral one.
  const Icon = it ? (r.stale && it.tone === 'neutral' ? STALE_ICON : TONE_ICON[it.tone]) : null;
  const vals = r.trend?.filter((v): v is number => v != null) ?? [];
  return (
    <li className={`eqp-sig ${on ? 'on' : ''} ${r.stale ? 'stale' : ''}`} data-signal={r.id} tabIndex={-1} title={[r.id, r.limits].filter(Boolean).join(' · ')}>
      <span className="lab">{r.label}</span>
      <span className="val num">
        {r.value ?? '—'}
        {r.unit && r.value != null && <small>{r.unit}</small>}
      </span>
      <span className="int">
        {it && Icon && (
          <span className={`status ${it.tone}`}>
            <Icon size={11} strokeWidth={2.2} aria-hidden />
            {it.label}
          </span>
        )}
        {r.freshness !== shared && <span className="fresh">{r.freshness}</span>}
      </span>
      <span className="spk">{vals.length >= 2 && <Sparkline values={r.trend!} width={56} height={20} color={r.stale ? 'var(--text-4)' : 'var(--accent)'} />}</span>
    </li>
  );
}

export function NotModelled({ items }: { items: { label: string; reason: string }[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!items.length) return null;
  return (
    <div className="eqp-nm">
      <button type="button" className="eqp-nm-b" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span>
          <b>Not modelled</b>{' '}
          {items.map((i, n) => (
            <span key={i.label} title={i.reason}>
              {i.label}
              {n < items.length - 1 ? ', ' : ''}
            </span>
          ))}
        </span>
        <ChevronDown size={13} aria-hidden className="chev" />
      </button>
      {open && (
        <ul id={id}>
          {items.map((i) => (
            <li key={i.label}>
              <b>{i.label}</b> — {i.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Signals({ signals, highlight }: { signals: IntelSignals; highlight: string | null }) {
  const shared = commonFreshness(signals.rows);
  if (!signals.rows.length) return null;
  return (
    <ul className="eqp-sigs" aria-label={`Signals${shared ? ` · ${shared}` : ''}`}>
      {signals.rows.map((r) => (
        <Row key={r.id} r={r} shared={shared} on={highlight === r.id} />
      ))}
    </ul>
  );
}

/** Not-modelled items of the signals and the KPI set, each once (a KPI label contained in a signal item is the same parameter). */
export function mergeNotModelled(a: { label: string; reason: string }[], b: { label: string; reason: string }[]) {
  const out = [...a];
  const has = (l: string) => out.some((x) => x.label.toLowerCase().includes(l.toLowerCase()) || l.toLowerCase().includes(x.label.toLowerCase()));
  for (const x of b) if (!has(x.label)) out.push(x);
  return out;
}
