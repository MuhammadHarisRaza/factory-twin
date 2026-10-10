import { M2_PER_TILE } from '../../model/plant';
import type { Metric } from '../../sim/oee';

const intFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const oneFmt = new Intl.NumberFormat('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fmtInt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : intFmt.format(Math.round(n)));
export const fmt1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : oneFmt.format(n));
export const fmtM2 = (tiles: number | null | undefined) => (tiles == null ? '—' : intFmt.format(Math.round(tiles * M2_PER_TILE)));
export const fmtPct = (f: number | null | undefined, digits = 1) =>
  f == null || !Number.isFinite(f) ? '—' : `${(f * 100).toFixed(digits)} %`;
export const fmtMetric = (m: Metric, digits = 1) => (m.status === 'ok' ? fmtPct(m.value, digits) : m.status === 'invalid' ? 'Invalid' : '—');
export const pct = (f: number) => `${Math.round(f * 100)}%`;
