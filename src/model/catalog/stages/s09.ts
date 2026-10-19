/**
 * Stage 9 · polishing and rectification — the signal catalogue of a stage this representative
 * glazed-tile line does not have. Every entry uses the pseudo equipment id S09 and is unavailable
 * until the stage is mapped to a real machine.
 */
import { STAGE9_EQUIPMENT_ID as S09 } from '../stages';
import type { SignalDefinition } from '../types';
import { DOC_COUNTER, S09_NOTE, doc } from './doc';

const base = { status: 'unavailable', source: 'PLC', note: S09_NOTE } as const;

export const S09_SIGNALS: SignalDefinition[] = [
  doc(S09, 'machine_state', {
    ...base,
    name: 'Machine state',
    description: 'State of the polishing / squaring line: running, starved, blocked, stopped, fault.',
    category: 'state',
    dataType: 'enum',
    enumValues: ['running', 'starved', 'blocked', 'stopped', 'fault'],
    cls: 'core',
  }),
  doc(S09, 'alarm_code', {
    ...base,
    name: 'Alarm / stop code',
    description: 'Active alarm or stop reason code of the polishing / squaring line.',
    category: 'alarm',
    dataType: 'string',
    cls: 'core',
  }),
  doc(S09, 'line_speed', {
    ...base,
    name: 'Line speed',
    description: 'Belt speed through the polishing heads and squaring wheels.',
    category: 'drive',
    unit: 'm/min',
    dataType: 'float',
    cls: 'core',
  }),
  doc(S09, 'throughput', {
    ...base,
    name: 'Throughput',
    description: 'Tiles processed per hour by the polishing / squaring line.',
    category: 'production',
    unit: 'tiles/h',
    dataType: 'float',
    cls: 'core',
  }),
  doc(S09, 'tile_count', {
    ...base,
    name: 'Tiles processed',
    description: 'Tiles leaving the polishing / squaring line, cumulative.',
    category: 'production',
    unit: 'tiles',
    dataType: 'integer',
    counter: DOC_COUNTER,
    cls: 'core',
  }),
  doc(S09, 'spindle_speed', {
    ...base,
    name: 'Spindle speed',
    description: 'Rotational speed of the polishing heads / squaring wheel spindles.',
    category: 'drive',
    unit: 'rpm',
    dataType: 'float',
    cls: 'conditional',
  }),
  doc(S09, 'spindle_current', {
    ...base,
    name: 'Spindle motor current',
    description: 'Motor current of the polishing / squaring spindles (load and tool wear).',
    category: 'drive',
    unit: 'A',
    dataType: 'float',
    cls: 'conditional',
  }),
  doc(S09, 'head_pressure', {
    ...base,
    name: 'Head feed pressure',
    description: 'Pressure with which the polishing heads are fed onto the tile surface.',
    category: 'process',
    unit: 'bar',
    dataType: 'float',
    cls: 'conditional',
  }),
  doc(S09, 'water_flow', {
    ...base,
    name: 'Cooling / process water flow',
    description: 'Water flow to the polishing heads and squaring wheels.',
    category: 'process',
    unit: 'L/min',
    dataType: 'float',
    cls: 'conditional',
  }),
  doc(S09, 'tool_change_count', {
    ...base,
    name: 'Tool changes',
    description: 'Abrasive / diamond tool changes, cumulative.',
    category: 'condition',
    unit: 'changes',
    dataType: 'integer',
    counter: DOC_COUNTER,
    cls: 'core',
  }),
  doc(S09, 'actual_size', {
    ...base,
    name: 'Actual size after rectification',
    description: 'Measured tile length and width after squaring (inline gauge).',
    category: 'quality',
    unit: 'mm',
    dataType: 'float',
    cls: 'conditional',
  }),
  doc(S09, 'squareness', {
    ...base,
    name: 'Squareness deviation',
    description: 'Deviation from a right angle measured after squaring (diagonal difference).',
    category: 'quality',
    unit: 'mm',
    dataType: 'float',
    cls: 'conditional',
  }),
];
