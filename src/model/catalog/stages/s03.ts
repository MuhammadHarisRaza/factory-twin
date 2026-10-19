/** Stage 3 · hydraulic presses — documented (not simulated) signals. */
import type { SignalDefinition } from '../types';
import { MES_NOTE, doc } from './doc';

export const S03: SignalDefinition[] = (['E-PRS1', 'E-PRS2', 'E-PRS3'] as const).flatMap((id) => {
  const n = id.slice(-1);
  return [
    doc(id, 'press_phase', {
      name: 'Press cycle phase',
      description: `Phase of the current stroke of press ${n}: powder fill, pre-press, de-airing, main press, eject.`,
      category: 'state',
      dataType: 'enum',
      enumValues: ['idle', 'fill', 'pre-press', 'de-air', 'press', 'eject'],
      cls: 'core',
      status: 'not-modelled',
      source: 'PLC',
      note: 'The simulation models strokes per minute and cycle time, not the phases within a stroke.',
    }),
    doc(id, 'die_id', {
      name: 'Die / mould ID',
      description: `Identifier of the die set fitted to press ${n} (tooling register).`,
      category: 'recipe',
      dataType: 'string',
      cls: 'external',
      status: 'unavailable',
      source: 'MES',
      note: `${MES_NOTE} Die changes are simulated only as product changeovers.`,
    }),
    doc(id, 'product_id', {
      name: 'Product / recipe ID',
      description: `Product (SKU) and pressing recipe running on press ${n}.`,
      category: 'recipe',
      dataType: 'string',
      cls: 'external',
      status: 'unavailable',
      source: 'MES',
      note: `${MES_NOTE} The simulated batches rotate products, but no MES product signal exists.`,
    }),
    doc(id, 'green_thickness', {
      name: 'Green-tile thickness',
      description: `Thickness of the green tile measured after press ${n} (laser or contact gauge, where fitted).`,
      category: 'quality',
      unit: 'mm',
      dataType: 'float',
      cls: 'conditional',
      status: 'not-modelled',
      source: 'PLC',
      note: 'Green-tile dimensions are not modelled; dimensional defects appear only as inspection results at sorting.',
    }),
  ];
});
