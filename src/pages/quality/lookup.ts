import { INSPECTION_STATIONS, PRODUCTS } from '../../model/plant';
import type { InspectionStation, Product } from '../../model/types';

export const STATION_BY_ID: Record<string, InspectionStation> = Object.fromEntries(INSPECTION_STATIONS.map((s) => [s.id, s]));
export const PRODUCT_BY_SKU: Record<string, Product> = Object.fromEntries(PRODUCTS.map((p) => [p.sku, p]));
