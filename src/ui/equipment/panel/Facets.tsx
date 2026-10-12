/**
 * Facets: the distinct conditions an operator must not confuse — machine up, material fed, condition,
 * line role (vehicles: location, movement, trip, dwell) — as one compact row of chips "Label · value"
 * with a tone icon. How each is determined is in its tooltip. A facet without a value is not shown.
 */
import type { Facet } from '../intel/types';
import { STALE_ICON, TONE_ICON, isStaleWording } from './tone';

export function Facets({ facets }: { facets: Facet[] }) {
  const shown = facets.filter((f) => f.value.trim() && f.value.trim() !== '—');
  if (!shown.length) return null;
  return (
    <ul className="eqp-facets" aria-label="Current state">
      {shown.map((f) => {
        const Icon = f.tone === 'neutral' && isStaleWording(f.value) ? STALE_ICON : TONE_ICON[f.tone];
        return (
          <li key={f.key} className={`eqp-facet ${f.tone}`} title={f.hint}>
            <span className="l">{f.label}</span>
            <span className="v">
              <Icon size={12} strokeWidth={2.2} aria-hidden />
              {f.value}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
