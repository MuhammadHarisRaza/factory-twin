/**
 * Recommended first actions per downtime reason and per defect category. Shared by the event
 * engine, the insights, reports and the copilot so every surface recommends the same thing.
 */
import type { DefectCategory } from './types';

export const REASON_ACTIONS: Record<string, string> = {
  MECH_HYD: 'Dispatch maintenance to check hydraulic pressure, pump and valves; confirm accumulator pre-charge before restart.',
  MECH_DIE: 'Change the damaged punch/die set from the tool store; inspect the last pressed tiles for cracks.',
  MECH_ROLLER: 'Clear the roller jam, remove broken tiles from the channel and check roller alignment before restart.',
  MECH_BELT: 'Re-track the belt and check the tensioner; look for spillage that caused the drift.',
  MECH_BEARING: 'Isolate and inspect the bearing; replace from stores and verify lubrication before restart.',
  MECH_CARTON: 'Clear the carton jam, check blank quality and glue temperature.',
  MECH_GRIPPER: 'Inspect gripper vacuum cups and air supply; recalibrate the pick position.',
  MECH_NOZZLE: 'Swap to the standby atomiser and inspect the wheel/nozzles for wear.',
  ELEC_DRIVE: 'Read the drive fault code, reset and check motor insulation; call electrical maintenance if it recurs.',
  ELEC_SENSOR: 'Clean or replace the faulty sensor and verify the signal before restart.',
  ELEC_BURNER: 'Check flame detection and gas train; restart the burner sequence under supervision.',
  ELEC_PRINTHEAD: 'Run a printhead purge and nozzle check; replace the head if missing nozzles persist.',
  ELEC_ROBOT: 'Read the robot controller alarm, run diagnostics and re-home the robot.',
  PROC_MOISTURE: 'Adjust spray-dryer inlet temperature and slip feed to bring powder moisture back into spec.',
  PROC_DENSITY: 'Correct slip density (water / deflocculant dosing) before resuming milling.',
  PROC_VISCOSITY: 'Correct glaze viscosity and density; flush the bell before restart.',
  PROC_INK: 'Restore ink supply (tank level, filters, degassing) and run a test print.',
  PROC_TEMP: 'Check burner settings and thermocouples against the firing curve.',
  CHG_PRODUCT: 'Follow the changeover checklist; verify first-off tiles before releasing the line.',
  SCN_STOP: 'Dispatch maintenance to diagnose the stoppage; prepare the line to restart in sequence.',
  CNV_JAM: 'Isolate the conveyor (lock-out), remove the jammed or broken tiles at the transfer and check guide rails before restart.',
  CNV_TRACK: 'Check belt tracking and tension; clean the drive drum and look for spillage under the return strand.',
  CNV_DRIVE: 'Read the drive fault code, check motor current and the gearbox; reset and restart under supervision.',
  CNV_PULLCORD: 'Find out why the pull-cord was operated, confirm the area is safe, reset the cord switch and restart.',
  SCN_CNV_STOP: 'Send maintenance to the conveyor, confirm the cause of the stop and restart it; watch the downstream buffer.',
};

/** Process conditions to investigate per defect category. */
export const DEFECT_ACTIONS: Record<DefectCategory, string> = {
  crack: 'Check press specific pressure and powder moisture/granulometry; inspect the die and green-tile handling.',
  chip: 'Inspect roller alignment and transfer points after the kiln; check for tile collisions at the sorter.',
  surface: 'Check glaze filtration and booth cleanliness; look for dust contamination before glazing.',
  glaze: 'Check glaze density, viscosity and bell flow rate; verify tile temperature at glazing.',
  shade: 'Recalibrate the inkjet colour profile and check kiln firing-zone temperatures for drift.',
  planarity: 'Review the kiln firing and cooling curves (top/bottom temperature balance).',
  dimension: 'Check press die wear and powder fill; verify kiln shrinkage against the firing curve.',
};
