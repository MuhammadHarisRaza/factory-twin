/**
 * Events & Reports › underlying record log (moved from the retired Assets › Event history) locates
 * logistics scenarios at their own subject (review finding #23):
 * a restricted-zone entry follows its forklift (the packaging floor beside the walkway once it is
 * off site), yard congestion opens the holding area, and only dock scenarios open the docks.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { activateScenario, advance, createSim } from '../../sim/engine';
import { buildRecordLog, recordTarget } from './RecordLog';

describe('record log targets', () => {
  const s = createSim(7, 2 * 1440 + 400);
  const zone = activateScenario(s, { kind: 'restricted-entry', vehicleId: 'FL-05', end: null, label: 'Restricted-zone entry · FL-05' });
  const jam = activateScenario(s, { kind: 'yard-congestion', count: 6, end: null, label: 'Yard congestion · 6 trucks' });
  const hold = activateScenario(s, { kind: 'prolonged-dock-stay', count: 30, end: null, label: 'Dock hold +30 min' });
  advance(s, s.minute + 2);
  const rows = buildRecordLog(s);
  const active = new Set(s.logistics.active);

  it('follows the forklift of a restricted-zone entry, falling back to the walkway area', () => {
    const start = rows.find((r) => r.key === `${zone.id}:s`)!;
    expect(start).toMatchObject({ vehicleId: 'FL-05', equipmentId: 'J-PAL', subject: 'FL-05', subjectSub: 'Hall pedestrian walkway' });
    expect(active.has('FL-05')).toBe(true);
    expect(recordTarget(start, active)).toEqual({ type: 'vehicle', id: 'FL-05' });
    expect(recordTarget(start, new Set())).toEqual({ type: 'equipment', id: 'J-PAL' });
    // Its "Scenario started" alert is located the same way, not at the docks.
    const alert = rows.find((r) => r.type === 'alert' && r.source === 'scenario' && r.detail.includes(zone.label))!;
    expect(alert).toBeDefined();
    expect(recordTarget(alert, active)).toEqual({ type: 'vehicle', id: 'FL-05' });
    expect(alert.equipmentId).toBe('J-PAL');
  });

  it('opens the holding area for yard congestion and the docks only for a dock scenario', () => {
    const j = rows.find((r) => r.key === `${jam.id}:s`)!;
    expect(recordTarget(j, active)).toEqual({ type: 'equipment', id: 'A-HOLD' });
    expect(j.subject).toBe('Holding area');
    const h = rows.find((r) => r.key === `${hold.id}:s`)!;
    expect(recordTarget(h, active)).toEqual({ type: 'equipment', id: 'K-DOCK' });
  });
});
