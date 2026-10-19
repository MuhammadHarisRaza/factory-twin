/**
 * Units of the Production workspace for slip and powder (brief stages 1–2). The simulation counts slip and
 * powder in tile-equivalents; a figure for them is never shown as tiles / tiles/h. Rates are shown in t/h —
 * a labelled simulated conversion (tile-equivalents × KG_PER_TILE, src/model/catalog/process.ts), always with
 * its disclosure — and counts as tile-eq with the converted tonnes. A silo or slip-tank level is a percentage:
 * no mass is derived from it without a level-to-mass calibration (src/calc massFromLevel), and none is configured.
 */
import { KG_PER_TILE, PROCESS_SIGNAL_BY_ID, definitionOf } from '../../model/catalog';
import type { MonitoredStageId, StageId } from '../../model/types';

/** Process stages whose material is slip / powder (tile-equivalents): ball mills and spray dryer. */
export const MATERIAL_PROCESS_STAGES: ReadonlySet<StageId> = new Set<StageId>(['PREP', 'SPRAY']);
/** Monitored stages whose counts are slip / powder tile-equivalents. */
export const MATERIAL_MONITORED_STAGES: ReadonlySet<MonitoredStageId> = new Set<MonitoredStageId>(['PREP', 'SPRAY']);

/** The conversion factor as shown, computed from KG_PER_TILE (never typed by hand). */
export const KG_PER_TILE_TEXT = KG_PER_TILE.toFixed(2);
/** The disclosure that goes with every t or t/h figure derived from tile-equivalents. */
export const MASS_DISCLOSURE = `simulated: tile-eq × ${KG_PER_TILE_TEXT} kg`;
/** The longer note for footnotes. */
export const MASS_NOTE = `Slip and powder flows are dry-body equivalents in t/h — a labelled simulation assumption (tile-equivalents × ${KG_PER_TILE_TEXT} kg per tile-equivalent), not a weighed flow.`;
/** Why a silo / slip-tank level has no mass. */
export const NO_CALIBRATION = 'No level-to-mass calibration configured';

/** Tile-equivalents → tonnes of dry body (null stays null: missing is never zero). */
export const tileEqToT = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) ? null : (n * KG_PER_TILE) / 1000);

/** Catalogue unit of a signal (null when the catalogue does not know it). */
export const catalogUnit = (signalId: string | null | undefined): string | null => (signalId ? (definitionOf(signalId)?.unit ?? null) : null);

/**
 * Whether an asset carries slip / powder counted in tile-equivalents (ball mills, spray dryer, powder belt):
 * the catalogue gives its rate or counter the unit tile-eq/h or tile-eq.
 */
export function isMaterialAsset(id: string): boolean {
  const u = catalogUnit(`${id}.rate`) ?? catalogUnit(`${id}.tile_count`) ?? catalogUnit(`${id}.count_total`);
  return u === 'tile-eq/h' || u === 'tile-eq';
}

/** The simulated mass-flow signal (t/h) of a ball mill or the spray dryer, if it has one. */
export const massFlowSignalOf = (id: string): string | null => [`${id}.slip_flow`, `${id}.powder_flow`].find((x) => PROCESS_SIGNAL_BY_ID[x] != null) ?? null;
