/**
 * Process, setpoint, derived and command signals the demo simulates (brief §4 / §9) — the single
 * contract between the simulation (src/sim/process.ts produces their values) and the catalogue
 * (src/model/catalog builds their SignalDefinitions). Every value is a labelled simulation: a
 * deterministic process model (PV follows SP with smooth noise, drifts when the machine stops, and is
 * offset by a 'process-deviation' scenario). None of it is plant telemetry.
 *
 * Ids follow the existing convention `<equipmentId>.<name>`. A PV's setpoint is `pairId`.
 * Limits are absolute engineering values (warning / alarm bands around the nominal setpoint).
 */
import { M2_PER_TILE } from '../plant';
import type { AvailabilityClass, SignalCategory, SourceSystem } from './types';

/**
 * Simulated assumption: dry pressed-body mass per m² of a 60×60 cm porcelain tile (~9.5 mm). Used
 * only to show powder / slip flows in t/h instead of tile-equivalents; always disclosed with the figure.
 */
export const KG_PER_M2 = 21;
/** Simulated assumption: kg of dry body per tile (tile-equivalent → mass). */
export const KG_PER_TILE = M2_PER_TILE * KG_PER_M2;
/** Simulated assumption: tiles formed per press stroke (two-cavity 60×60 die). */
export const PRESS_CAVITIES = 2;
/** Cartons per tile count (tiles per carton) used to derive the carton counter. */
export const TILES_PER_CARTON = 6;

export type ProcessRole =
  /** A measured process value controlled to a setpoint (pairId). */
  | 'pv'
  /** The setpoint of a PV (recipe / operator value). */
  | 'sp'
  /** A value derived from the simulated production state (speed from rate, cycle time from strokes, mass flow from rate). */
  | 'derived'
  /** A run command; its feedback is the machine's existing state signal. */
  | 'command';

/** What a PV does while its machine is not running. */
export type StoppedBehaviour =
  /** Keeps following the setpoint (e.g. a kiln idling hot during a planned stop). */
  | { kind: 'hold' }
  /** Relaxes towards `value` with time constant `tauMin` (e.g. a dryer cooling down). */
  | { kind: 'decay'; value: number; tauMin: number }
  /** No value while stopped (e.g. press pressure, powder moisture with no powder flowing). */
  | { kind: 'none' };

export type ProcessSignalSpec = {
  id: string;
  equipmentId: string;
  name: string;
  description: string;
  role: ProcessRole;
  category: SignalCategory;
  unit: string | null;
  /** For a PV: its setpoint id; for an SP: the PV it controls. */
  pairId?: string;
  /** Nominal setpoint / typical running value. */
  nominal?: number;
  /** PV noise amplitude (± around SP, deterministic). */
  noise?: number;
  engineeringMin?: number;
  engineeringMax?: number;
  warningLow?: number;
  warningHigh?: number;
  alarmLow?: number;
  alarmHigh?: number;
  stopped?: StoppedBehaviour;
  /** How a 'down' (unplanned) stop differs from a planned one, if it does. */
  stoppedDown?: StoppedBehaviour;
  availabilityClass: AvailabilityClass;
  sourceSystem: SourceSystem;
  /** Decimal places for display. */
  digits: number;
  metadata?: Record<string, string | number | boolean>;
};

const band = (sp: number, warn: number, alarm: number) => ({
  warningLow: sp - warn,
  warningHigh: sp + warn,
  alarmLow: sp - alarm,
  alarmHigh: sp + alarm,
});

/** A PV/SP pair. */
function pvsp(
  equipmentId: string,
  key: string,
  label: string,
  unit: string,
  o: {
    sp: number;
    noise: number;
    warn: number;
    alarm: number;
    eng: [number, number];
    stopped: StoppedBehaviour;
    stoppedDown?: StoppedBehaviour;
    cls?: AvailabilityClass;
    digits?: number;
    pvDescription: string;
    metadata?: ProcessSignalSpec['metadata'];
  },
): ProcessSignalSpec[] {
  const pv = `${equipmentId}.${key}_pv`;
  const sp = `${equipmentId}.${key}_sp`;
  const digits = o.digits ?? 0;
  return [
    {
      id: pv,
      equipmentId,
      name: `${label} · actual`,
      description: o.pvDescription,
      role: 'pv',
      category: 'process',
      unit,
      pairId: sp,
      nominal: o.sp,
      noise: o.noise,
      engineeringMin: o.eng[0],
      engineeringMax: o.eng[1],
      ...band(o.sp, o.warn, o.alarm),
      stopped: o.stopped,
      stoppedDown: o.stoppedDown,
      availabilityClass: o.cls ?? 'core',
      sourceSystem: 'PLC',
      digits,
      metadata: o.metadata,
    },
    {
      id: sp,
      equipmentId,
      name: `${label} · setpoint`,
      description: `Setpoint of ${label.toLowerCase()} (recipe / operator value).`,
      role: 'sp',
      category: 'setpoint',
      unit,
      pairId: pv,
      nominal: o.sp,
      engineeringMin: o.eng[0],
      engineeringMax: o.eng[1],
      availabilityClass: o.cls ?? 'core',
      sourceSystem: 'PLC',
      digits,
      metadata: o.metadata,
    },
  ];
}

const command = (equipmentId: string, machine: string): ProcessSignalSpec => ({
  id: `${equipmentId}.run_command`,
  equipmentId,
  name: 'Run command',
  description: `Run / enable command to the ${machine} from the line sequence. Its feedback is the machine's running state; a command without feedback is a reliability finding.`,
  role: 'command',
  category: 'command',
  unit: null,
  availabilityClass: 'core',
  sourceSystem: 'PLC',
  digits: 0,
});

const derived = (
  equipmentId: string,
  key: string,
  name: string,
  unit: string,
  description: string,
  o: { nominal: number; cls?: AvailabilityClass; digits?: number; eng?: [number, number]; category?: SignalCategory; source?: SourceSystem },
): ProcessSignalSpec => ({
  id: `${equipmentId}.${key}`,
  equipmentId,
  name,
  description,
  role: 'derived',
  category: o.category ?? 'production',
  unit,
  nominal: o.nominal,
  engineeringMin: o.eng?.[0],
  engineeringMax: o.eng?.[1],
  availabilityClass: o.cls ?? 'core',
  sourceSystem: o.source ?? 'PLC',
  digits: o.digits ?? 1,
});

/** Kiln zones: preheating, firing, peak firing, rapid cooling, final cooling. */
export const KILN_ZONES = [
  { no: 1, role: 'Preheating', sp: 950 },
  { no: 2, role: 'Firing', sp: 1150 },
  { no: 3, role: 'Peak firing', sp: 1195 },
  { no: 4, role: 'Rapid cooling', sp: 600 },
  { no: 5, role: 'Final cooling', sp: 140 },
] as const;

export const PROCESS_SIGNALS: ProcessSignalSpec[] = [
  // ── Stage 1 · ball mills and slip ──────────────────────────────────────────
  ...(['C-BM1', 'C-BM2', 'C-BM3'] as const).flatMap((id) => [
    derived(id, 'mill_speed', 'Mill speed', 'rpm', 'Drum speed of the continuous ball mill (from the drive); zero while stopped.', {
      nominal: 13.5,
      cls: 'conditional',
      eng: [0, 20],
      category: 'drive',
    }),
    derived(id, 'slip_flow', 'Slip output · dry-body equivalent', 't/h', `Slip discharged by the mill, as dry-body mass (simulated: tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg per tile). Needs a flow meter and density measurement on a real line.`, {
      nominal: 3.6,
      cls: 'conditional',
      eng: [0, 8],
      category: 'material',
    }),
    command(id, 'ball mill'),
  ]),
  ...pvsp('C-SLIP', 'slip_density', 'Slip density', 'g/cm³', {
    sp: 1.7,
    noise: 0.004,
    warn: 0.02,
    alarm: 0.04,
    eng: [1.5, 1.9],
    stopped: { kind: 'hold' },
    cls: 'conditional',
    digits: 3,
    pvDescription: 'Density of the slip in the storage tanks (inline densimeter). Drives the spray dryer load.',
  }),
  // ── Stage 2 · spray dryer and powder ───────────────────────────────────────
  ...pvsp('D-TWR', 'inlet_temp', 'Inlet air temperature', '°C', {
    sp: 560,
    noise: 4,
    warn: 15,
    alarm: 30,
    eng: [0, 700],
    stopped: { kind: 'decay', value: 150, tauMin: 40 },
    pvDescription: 'Hot-air temperature entering the spray dryer tower (thermocouple at the inlet duct).',
  }),
  ...pvsp('D-TWR', 'outlet_temp', 'Outlet air temperature', '°C', {
    sp: 105,
    noise: 1.5,
    warn: 5,
    alarm: 10,
    eng: [0, 200],
    stopped: { kind: 'decay', value: 60, tauMin: 30 },
    pvDescription: 'Exhaust air temperature leaving the tower; tracks the drying load.',
  }),
  ...pvsp('D-TWR', 'powder_moisture', 'Powder moisture', '%', {
    sp: 6.0,
    noise: 0.12,
    warn: 0.4,
    alarm: 0.8,
    eng: [0, 12],
    stopped: { kind: 'none' },
    cls: 'conditional',
    digits: 2,
    pvDescription: 'Residual moisture of the spray-dried granulate (online NIR / microwave analyser, where fitted). Affects pressing and green strength.',
  }),
  derived('D-TWR', 'powder_flow', 'Powder output', 't/h', `Granulate produced by the spray dryer (simulated: tile-equivalent rate × ${KG_PER_TILE.toFixed(2)} kg per tile). Needs a belt weigher or mass-flow meter on a real line.`, {
    nominal: 10.9,
    cls: 'conditional',
    eng: [0, 20],
    category: 'material',
  }),
  command('D-TWR', 'spray dryer'),
  // ── Stage 3 · presses ──────────────────────────────────────────────────────
  ...(['E-PRS1', 'E-PRS2', 'E-PRS3'] as const).flatMap((id) => [
    derived(id, 'strokes_per_min', 'Press strokes', '1/min', `Pressing cycles per minute (${PRESS_CAVITIES} tiles per stroke).`, {
      nominal: 3.9,
      digits: 2,
      eng: [0, 8],
    }),
    derived(id, 'cycle_time', 'Cycle time', 's', 'Time of one press cycle (fill, press, de-air, eject), from the cycle-start timestamps; mean over the minute.', {
      nominal: 15.3,
      digits: 1,
      eng: [0, 60],
    }),
    derived(id, 'cycle_time_target', 'Cycle time · target', 's', 'Target cycle time of the current die / product (from the ideal rate).', {
      nominal: 15.3,
      digits: 1,
      category: 'setpoint',
    }),
    ...pvsp(id, 'press_pressure', 'Pressing pressure', 'bar', {
      sp: 300,
      noise: 2.5,
      warn: 10,
      alarm: 20,
      eng: [0, 400],
      stopped: { kind: 'none' },
      digits: 0,
      pvDescription: 'Peak hydraulic pressure of the pressing stroke.',
    }),
    {
      id: `${id}.oil_temp`,
      equipmentId: id,
      name: 'Hydraulic oil temperature',
      description: 'Temperature of the hydraulic power unit oil.',
      role: 'pv' as const,
      category: 'condition' as const,
      unit: '°C',
      nominal: 45,
      noise: 1.5,
      engineeringMin: 0,
      engineeringMax: 90,
      warningHigh: 55,
      alarmHigh: 62,
      stopped: { kind: 'decay' as const, value: 32, tauMin: 60 },
      availabilityClass: 'conditional' as const,
      sourceSystem: 'PLC' as const,
      digits: 1,
    },
    command(id, 'press'),
  ]),
  // ── Stage 4 · dryer ────────────────────────────────────────────────────────
  ...pvsp('F-DRY', 'zone1_temp', 'Dryer zone 1 temperature', '°C', {
    sp: 180,
    noise: 1.8,
    warn: 8,
    alarm: 15,
    eng: [0, 300],
    stopped: { kind: 'decay', value: 60, tauMin: 30 },
    pvDescription: 'Air temperature of the first (entry) drying zone.',
    metadata: { zone: 1 },
  }),
  ...pvsp('F-DRY', 'zone2_temp', 'Dryer zone 2 temperature', '°C', {
    sp: 210,
    noise: 2,
    warn: 8,
    alarm: 15,
    eng: [0, 300],
    stopped: { kind: 'decay', value: 60, tauMin: 30 },
    pvDescription: 'Air temperature of the second (exit) drying zone.',
    metadata: { zone: 2 },
  }),
  derived('F-DRY', 'roller_speed', 'Roller speed', 'm/min', 'Speed of the dryer roller decks (from the drive); follows the line rate.', {
    nominal: 4.2,
    digits: 2,
    eng: [0, 8],
    category: 'drive',
  }),
  command('F-DRY', 'dryer'),
  // ── Stage 5 · glazing ──────────────────────────────────────────────────────
  ...pvsp('G-LINE', 'glaze_density', 'Glaze density', 'g/L', {
    sp: 1820,
    noise: 4,
    warn: 20,
    alarm: 40,
    eng: [1500, 2100],
    stopped: { kind: 'hold' },
    cls: 'conditional',
    pvDescription: 'Density of the glaze fed to the application bells (inline densimeter, where fitted).',
  }),
  derived('G-LINE', 'line_speed', 'Line speed', 'm/min', 'Glazing line belt speed (from the drive); follows the line rate.', {
    nominal: 21,
    digits: 1,
    eng: [0, 40],
    category: 'drive',
  }),
  command('G-LINE', 'glaze line'),
  // ── Stage 6 · digital printing ─────────────────────────────────────────────
  {
    id: 'G-INK.ink_level',
    equipmentId: 'G-INK',
    name: 'Ink supply level (lowest channel)',
    description: 'Level of the emptiest ink tank of the printer supply system; refilled from IBCs when low.',
    role: 'derived',
    category: 'material',
    unit: '%',
    nominal: 60,
    engineeringMin: 0,
    engineeringMax: 100,
    warningLow: 20,
    alarmLow: 10,
    availabilityClass: 'conditional',
    sourceSystem: 'PLC',
    digits: 0,
  },
  command('G-INK', 'printer'),
  // ── Stage 7 · kiln ─────────────────────────────────────────────────────────
  ...KILN_ZONES.flatMap((z) =>
    pvsp('H-KILN', `zone${z.no}_temp`, `Zone ${z.no} temperature · ${z.role.toLowerCase()}`, '°C', {
      sp: z.sp,
      noise: z.sp > 900 ? 3 : 2,
      warn: z.sp > 900 ? 10 : 15,
      alarm: z.sp > 900 ? 20 : 30,
      eng: [0, 1300],
      // A kiln idles hot through a planned stop; after a breakdown the zones cool slowly.
      stopped: { kind: 'hold' },
      stoppedDown: { kind: 'decay', value: z.no >= 4 ? 80 : 500, tauMin: 180 },
      pvDescription: `Temperature of kiln zone ${z.no} (${z.role.toLowerCase()}), roof thermocouple — simulated zone model.`,
      metadata: { zone: z.no, role: z.role },
    }),
  ),
  derived('H-KILN', 'roller_speed', 'Roller speed', 'm/min', 'Speed of the kiln roller drive (from the drive); follows the firing rate.', {
    nominal: 9.5,
    digits: 2,
    eng: [0, 20],
    category: 'drive',
  }),
  command('H-KILN', 'kiln roller drive'),
  // ── Stage 11 · packing ─────────────────────────────────────────────────────
  derived('J-BOX', 'carton_count', 'Cartons produced', 'cartons', `Carton counter (${TILES_PER_CARTON} tiles per carton), cumulative.`, {
    nominal: 0,
    digits: 0,
    category: 'production',
  }),
  command('J-BOX', 'carton packaging machine'),
  derived('J-PAL', 'pallet_count', 'Pallets completed', 'pallets', 'Pallet counter of the palletiser cell, cumulative.', {
    nominal: 0,
    digits: 0,
    category: 'production',
  }),
  command('J-PAL', 'palletiser'),
];

export const PROCESS_SIGNAL_BY_ID: Record<string, ProcessSignalSpec> = Object.fromEntries(PROCESS_SIGNALS.map((p) => [p.id, p]));
