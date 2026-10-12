import { describe, expect, it } from 'vitest';
import { activateScenario, advance, createSim } from '../../../sim/engine';
import { operationalState } from '../../../sim/metrics';
import { alertShown, conditionSeverity, maxSeverity, sharedSeverities, staleSeverity, stateSeverity, stopMarkerSeverity } from '../alerts';

describe('alert filter of the model', () => {
  it('shows every marker, serious and critical only, or none', () => {
    for (const sev of ['info', 'warning', 'serious', 'critical'] as const) {
      expect(alertShown('all', sev)).toBe(true);
      expect(alertShown('off', sev)).toBe(false);
      expect(alertShown('serious', sev)).toBe(sev === 'serious' || sev === 'critical');
    }
    expect(maxSeverity('warning', 'critical')).toBe('critical');
    expect(maxSeverity(null, 'info')).toBe('info');
    expect(maxSeverity(undefined, undefined)).toBeNull();
  });

  it('rates a marker by its asset’s active event, else by its state', () => {
    const s = createSim(9, 2 * 1440 + 9 * 60);
    // CV-PACK stops raise a warning-level conveyor event; CV-SORT stops a serious one.
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-PACK', end: null, label: 'stop' });
    activateScenario(s, { kind: 'conveyor-stop', equipmentId: 'CV-SORT', end: null, label: 'stop' });
    advance(s, s.minute + 3);
    const sev = sharedSeverities(s);
    const pack = stopMarkerSeverity(sev['CV-PACK'], operationalState(s, 'CV-PACK'));
    const sort = stopMarkerSeverity(sev['CV-SORT'], operationalState(s, 'CV-SORT'));
    expect(pack).toBe(sev['CV-PACK']?.stop ?? 'serious');
    expect(sort).toBe('serious');
    expect(alertShown('serious', sort)).toBe(true);
    if (sev['CV-PACK']?.stop === 'warning') expect(alertShown('serious', pack)).toBe(false);
    // Without an event: stops are serious, planned stops information, degraded states warnings.
    expect(stateSeverity('fault')).toBe('serious');
    expect(stateSeverity('planned')).toBe('info');
    expect(stateSeverity('reduced')).toBe('warning');
    expect(stopMarkerSeverity(undefined, 'planned')).toBe('info');
    expect(conditionSeverity(undefined, 'alarm')).toBe('critical');
    expect(conditionSeverity(undefined, 'watch')).toBe('warning');
    expect(staleSeverity(undefined)).toBe('warning');
    // Memoised per simulation version.
    expect(sharedSeverities(s)).toBe(sev);
  });
});
