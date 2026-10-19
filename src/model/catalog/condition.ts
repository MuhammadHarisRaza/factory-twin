/**
 * Condition-monitoring limits of the catalogue's vibration / temperature / motor-current signals.
 *
 * The values mirror the simulated condition model (src/sim/health.ts HEALTH_ASSETS) — the model layer
 * does not import the simulation, so they are restated here and a test keeps both in step
 * (src/model/catalog/__tests__/catalog.test.ts). Mapping onto the catalogue's bands follows the
 * rule-based assessment there: warning from 80 % of the vibration alarm limit and from 5 °C below the
 * temperature alarm limit, alarm at the alarm limit; the trip limit goes into the signal metadata.
 */
export type ConditionLimits = {
  component: string;
  /** Bearing / oil temperature (°C) at full load when healthy, alarm and trip limits. */
  temp: { full: number; alarm: number; trip: number };
  /** Vibration velocity RMS (mm/s) at full load when healthy, alarm and trip limits (ISO 10816-style zones). */
  vib: { full: number; alarm: number; trip: number };
  /** Rated motor current (A). */
  currentRated: number;
};

const mill: ConditionLimits = {
  component: 'Mill gearbox · output-shaft bearing',
  temp: { full: 68, alarm: 85, trip: 95 },
  vib: { full: 2.4, alarm: 7.1, trip: 11.2 },
  currentRated: 285,
};

const press: ConditionLimits = {
  component: 'Hydraulic power unit · main pump',
  temp: { full: 52, alarm: 62, trip: 70 },
  vib: { full: 2.0, alarm: 6.0, trip: 9.0 },
  currentRated: 230,
};

export const CONDITION_LIMITS: Record<string, ConditionLimits> = {
  'C-BM1': mill,
  'C-BM2': mill,
  'C-BM3': mill,
  'D-TWR': {
    component: 'Atomiser wheel · spindle bearing',
    temp: { full: 66, alarm: 80, trip: 90 },
    vib: { full: 1.8, alarm: 4.5, trip: 7.1 },
    currentRated: 120,
  },
  'E-PRS1': press,
  'E-PRS2': press,
  'E-PRS3': press,
  'F-DRY': {
    component: 'Recirculation fan · drive-end bearing',
    temp: { full: 72, alarm: 85, trip: 95 },
    vib: { full: 2.2, alarm: 7.1, trip: 11.2 },
    currentRated: 95,
  },
  'H-KILN': {
    component: 'Roller drive gearmotor · firing zone',
    temp: { full: 74, alarm: 90, trip: 100 },
    vib: { full: 1.9, alarm: 4.5, trip: 7.1 },
    currentRated: 60,
  },
  'J-PAL': {
    component: 'Robot axis 2 · gearbox',
    temp: { full: 52, alarm: 70, trip: 80 },
    vib: { full: 1.2, alarm: 3.5, trip: 5.5 },
    currentRated: 22,
  },
};

/** Vibration warning threshold of the rule-based assessment (80 % of the alarm limit). */
export const vibrationWarning = (l: ConditionLimits) => Math.round(0.8 * l.vib.alarm * 100) / 100;
/** Temperature warning threshold of the rule-based assessment (5 °C below the alarm limit). */
export const temperatureWarning = (l: ConditionLimits) => l.temp.alarm - 5;
