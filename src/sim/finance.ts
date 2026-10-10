/**
 * Financial assumptions for loss estimates. Every money figure in the product is an estimate built
 * from these explicit, editable values — never a verified business loss. Lost theoretical capacity
 * is not lost revenue: only good output the line could have sold is valued, at contribution margin
 * (price − variable cost avoided), scaled by how much of it would really have been sold.
 */
import { M2_PER_TILE } from '../model/plant';

export type FinanceAssumptions = {
  currency: string;
  /** Ex-works selling price of first-quality tile, per m². */
  sellingPricePerM2: number;
  /** Variable cost per m² (materials, energy, packaging) — not spent when a tile is not made. */
  variableCostPerM2: number;
  /** Share (0–1) of lost good output that is lost sales (1 = demand exceeds capacity). */
  soldOutShare: number;
  /** Cost already sunk in a rejected tile by the time it reaches sorting, per m². */
  scrapCostPerM2: number;
  /** Share (0–1) of rejects that can be regraded / reworked instead of scrapped. */
  reworkShare: number;
  /** Cost to rework / regrade, per m². */
  reworkCostPerM2: number;
  /** Detention / demurrage cost of a truck waiting beyond the free time, per hour. */
  truckWaitCostPerHour: number;
};

export const DEFAULT_FINANCE: FinanceAssumptions = {
  currency: 'USD',
  sellingPricePerM2: 8.0,
  variableCostPerM2: 4.8,
  soldOutShare: 1,
  scrapCostPerM2: 3.9,
  reworkShare: 0.25,
  reworkCostPerM2: 1.2,
  truckWaitCostPerHour: 35,
};

export const contributionPerM2 = (f: FinanceAssumptions) => f.sellingPricePerM2 - f.variableCostPerM2;

export type MoneyLine = { label: string; amount: number; basis: string };
export type Estimate = {
  currency: string;
  total: number;
  lines: MoneyLine[];
  assumptions: string[];
  missing: string[];
  limitations: string[];
};

const m2 = (tiles: number) => tiles * M2_PER_TILE;
const money = (f: FinanceAssumptions, v: number) => `${f.currency} ${v.toFixed(2)}`;

/** Lost good output (tiles) valued at contribution margin × sold-out share. */
export function lostOutputValue(f: FinanceAssumptions, lostGoodTiles: number): MoneyLine {
  const area = m2(lostGoodTiles);
  return {
    label: 'Lost good output (contribution)',
    amount: area * contributionPerM2(f) * f.soldOutShare,
    basis: `${area.toFixed(1)} m² × ${money(f, contributionPerM2(f))}/m² contribution (price ${money(f, f.sellingPricePerM2)} − variable cost ${money(f, f.variableCostPerM2)} not spent) × ${Math.round(f.soldOutShare * 100)} % sold-out share`,
  };
}

/** Rejected tiles: scrapped share at sunk cost, reworked share at rework cost. */
export function rejectCost(f: FinanceAssumptions, rejectTiles: number): MoneyLine[] {
  const area = m2(rejectTiles);
  return [
    {
      label: 'Scrap (sunk cost of rejected tiles)',
      amount: area * (1 - f.reworkShare) * f.scrapCostPerM2,
      basis: `${(area * (1 - f.reworkShare)).toFixed(1)} m² scrapped × ${money(f, f.scrapCostPerM2)}/m²`,
    },
    {
      label: 'Rework / regrade',
      amount: area * f.reworkShare * f.reworkCostPerM2,
      basis: `${(area * f.reworkShare).toFixed(1)} m² reworked × ${money(f, f.reworkCostPerM2)}/m²`,
    },
  ];
}

export function waitingCost(f: FinanceAssumptions, minutes: number): MoneyLine {
  return {
    label: 'Truck waiting (detention)',
    amount: (minutes / 60) * f.truckWaitCostPerHour,
    basis: `${Math.round(minutes)} min beyond the threshold × ${money(f, f.truckWaitCostPerHour)}/h`,
  };
}

export function assumptionList(f: FinanceAssumptions): string[] {
  return [
    `Selling price ${money(f, f.sellingPricePerM2)}/m², variable cost ${money(f, f.variableCostPerM2)}/m² → contribution ${money(f, contributionPerM2(f))}/m².`,
    `${Math.round(f.soldOutShare * 100)} % of lost good output is assumed to be lost sales.`,
    `Rejects: ${Math.round((1 - f.reworkShare) * 100)} % scrapped at ${money(f, f.scrapCostPerM2)}/m² sunk cost, ${Math.round(f.reworkShare * 100)} % reworked at ${money(f, f.reworkCostPerM2)}/m².`,
    `Truck detention ${money(f, f.truckWaitCostPerHour)}/h beyond the waiting threshold.`,
    'All values are illustrative assumptions, editable in OEE & Loss Intelligence.',
  ];
}
