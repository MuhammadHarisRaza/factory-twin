import { Flame, OctagonX, TriangleAlert, Zap } from 'lucide-react';
import { StatusBadge } from '../../ui/kit/Status';
import { devLevel, fmtSigned, isGas } from './derive';

/** Category colours shared by the split bar, the ranked bars and the type labels. */
export const ELEC_COLOR = 'var(--series-1)';
export const GAS_COLOR = 'var(--series-2)';

/**
 * Deviation vs the energy model: plain figure within ±8 %, amber above 8 %, red above
 * 15 % — always with an icon and a label, never colour alone.
 */
export function DevBadge({ d, label = true }: { d: number | null | undefined; label?: boolean }) {
  if (d == null) return <span className="metric-na" title="Too little consumption to compare with the model">—</span>;
  const lvl = devLevel(d);
  if (lvl === 'ok') return <span className="num">{fmtSigned(d)}</span>;
  const word = d < 0 ? 'Below model' : lvl === 'critical' ? 'Severe' : 'High';
  return (
    <StatusBadge
      tone={lvl}
      icon={lvl === 'critical' ? OctagonX : TriangleAlert}
      label={label ? `${fmtSigned(d)} · ${word}` : fmtSigned(d)}
    />
  );
}

/** Supply type: gas-fired consumers also draw some electricity (fans, drives). */
export function ConsumerType({ id }: { id: string }) {
  return isGas(id) ? (
    <span className="en-type" title="Natural gas (thermal) plus electricity for fans and drives">
      <Flame size={13} style={{ color: GAS_COLOR }} aria-hidden />
      Gas + elec.
    </span>
  ) : (
    <span className="en-type">
      <Zap size={13} style={{ color: ELEC_COLOR }} aria-hidden />
      Electric
    </span>
  );
}
