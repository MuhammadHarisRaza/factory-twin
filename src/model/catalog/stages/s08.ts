/**
 * Stage 8 · cooling buffer and roller conveyors — documented (not simulated) signals. The stage has no
 * dedicated machine: the kiln outfeed storage (BUF-KOUT) and the sorting-line roller conveyor (CV-SORT)
 * play the role, so the entries are documented on CV-SORT.
 */
import type { SignalDefinition } from '../types';
import { DOC_COUNTER, RUN_STATES, bufferLevel, doc } from './doc';

export const S08: SignalDefinition[] = [
  ...bufferLevel(
    'BUF-KOUT',
    'CV-SORT',
    'outfeed_buffer_level',
    'Kiln outfeed storage occupancy',
    'Occupancy of the roller storage after the kiln exit that plays the cooling buffer; it fills when sorting slows down and then limits the kiln.',
  ),
  doc('CV-SORT', 'storage_mode', {
    name: 'Outfeed storage mode',
    description: 'Mode of the kiln outfeed roller storage: passing tiles through, storing them, or releasing stored tiles.',
    category: 'state',
    dataType: 'enum',
    enumValues: ['pass-through', 'storing', 'releasing'],
    cls: 'core',
    status: 'not-modelled',
    source: 'PLC',
    note: 'The kiln outfeed storage is simulated as a buffer (BUF-KOUT) without a storage-mode signal.',
  }),
  doc('CV-SORT', 'cooling_fan_state', {
    name: 'Final-cooling fan state',
    description: 'Run state of the final-cooling air fans over the kiln exit and the outfeed storage.',
    category: 'state',
    dataType: 'enum',
    enumValues: RUN_STATES,
    cls: 'core',
    status: 'not-modelled',
    source: 'PLC',
    note: 'Cooling fans are not modelled.',
  }),
  doc('CV-SORT', 'cooling_air_temp', {
    name: 'Cooling air temperature',
    description: 'Temperature of the cooling air over the outfeed rollers.',
    category: 'process',
    unit: '°C',
    dataType: 'float',
    cls: 'conditional',
    status: 'not-modelled',
    source: 'PLC',
    note: 'Cooling after the kiln is not modelled; the kiln cooling zones are H-KILN.zone4_temp_pv and H-KILN.zone5_temp_pv.',
  }),
  doc('CV-SORT', 'tile_exit_temp', {
    name: 'Tile temperature at sorting',
    description: 'Surface temperature of the tiles reaching the gauge (pyrometer, where fitted) — too hot affects measurement and packing.',
    category: 'process',
    unit: '°C',
    dataType: 'float',
    cls: 'conditional',
    status: 'not-modelled',
    source: 'PLC',
    note: 'Tile cooling is not modelled.',
  }),
  doc('CV-SORT', 'entry_count', {
    name: 'Outfeed storage entry count',
    description: 'Tiles entering the outfeed storage from the kiln exit (photo-eye), cumulative.',
    category: 'production',
    unit: 'tiles',
    dataType: 'integer',
    counter: DOC_COUNTER,
    cls: 'core',
    status: 'not-modelled',
    source: 'PLC',
    note: 'Kiln discharge is counted on H-KILN.count_total and the conveyor throughput on CV-SORT.tile_count; a separate entry photo-eye is not modelled.',
  }),
  doc('CV-SORT', 'jam_sensor', {
    name: 'Jam detection',
    description: 'Jam / tile-overlap photo-eyes along the outfeed rollers.',
    category: 'alarm',
    dataType: 'boolean',
    cls: 'core',
    status: 'not-modelled',
    source: 'PLC',
    note: 'Tile jams appear only as conveyor stop reasons, not as sensor signals.',
  }),
  doc('CV-SORT', 'drive_current', {
    name: 'Roller drive current',
    description: 'Motor current of the outfeed roller drives (rising current can indicate roller wear or overload).',
    category: 'drive',
    unit: 'A',
    dataType: 'float',
    cls: 'conditional',
    status: 'not-modelled',
    source: 'PLC',
    note: 'Conveyor drive condition is not modelled.',
  }),
];
