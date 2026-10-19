import { rejectRate } from '../../calc';
import { INSPECTION_STATIONS, PRODUCTS } from '../../model/plant';
import type { InspectionStation, Product } from '../../model/types';

export const STATION_BY_ID: Record<string, InspectionStation> = Object.fromEntries(INSPECTION_STATIONS.map((s) => [s.id, s]));
export const PRODUCT_BY_SKU: Record<string, Product> = Object.fromEntries(PRODUCTS.map((p) => [p.sku, p]));

/**
 * Reject (or category) rate = tiles rejected ÷ tiles inspected, through src/calc rejectRate — the one
 * definition. null when nothing was inspected (or the counts are not a valid proportion), never 0.
 */
export function rateOf(rejected: number, inspected: number): number | null {
  const r = rejectRate(rejected, inspected);
  return r.status === 'ok' ? r.value : null;
}
