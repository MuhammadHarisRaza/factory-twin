import { describe, expect, it } from 'vitest';
import { ZONE_BY_ID } from '../../../data/layout';
import { DOCKS, GEOFENCES } from '../../../model/plant';
import type { OpEvent } from '../../../model/types';
import { createSim } from '../../../sim/engine';
import {
  RING_SECONDS,
  centredLoop,
  circleLoop,
  focusPlan,
  growScale,
  isFocusCurrent,
  rectLoop,
  ringPhase,
  rippleReach,
  selectionLeavesFocus,
  type EventFocus,
} from '../model';

const START = 2 * 1440 + 300;
const ev = (asset: OpEvent['asset']) => ({ asset });

describe('focusPlan', () => {
  const s = createSim(7, START);

  it('an asset event rings the asset and opens it', () => {
    const p = focusPlan(s, ev({ equipmentId: 'CV-PACK', stage: 'PACK', zone: 'J' }));
    expect(p).toMatchObject({ primary: 'equipment', equipmentId: 'CV-PACK', vehicleId: null, area: null, departed: null });
    expect(p.open).toEqual({ equipmentId: 'CV-PACK' });
  });

  it('a station event without an equipment id resolves to the station asset', () => {
    const p = focusPlan(s, ev({ stationId: 'ST-GAUGE', zone: 'I' }));
    expect(p.primary).toBe('equipment');
    expect(p.open).toEqual({ equipmentId: 'I-GAUGE' });
  });

  it('follows a vehicle while it is on site, and also outlines its geofence', () => {
    const id = s.logistics.active[0];
    expect(id).toBeDefined();
    const p = focusPlan(s, ev({ vehicleId: id, geofenceId: 'GF-PALCELL', equipmentId: 'J-PAL', zone: 'J' }));
    expect(p.primary).toBe('vehicle');
    expect(p.vehicleId).toBe(id);
    expect(p.open).toEqual({ vehicleId: id });
    const gf = GEOFENCES.find((g) => g.id === 'GF-PALCELL')!;
    expect(p.area).toMatchObject({ id: 'GF-PALCELL', x: gf.rect.x, z: gf.rect.z });
  });

  it('a vehicle that has left the site hands the ring to the area where the event happened', () => {
    const p = focusPlan(s, ev({ vehicleId: 'TRK-GONE', geofenceId: 'GF-HOLD', zone: 'A' }));
    expect(p.primary).toBe('area');
    expect(p.vehicleId).toBeNull();
    expect(p.departed).toEqual({ vehicleId: 'TRK-GONE', at: null });
    // The holding area's asset is opened instead of the departed truck.
    expect(p.open).toEqual({ equipmentId: 'A-HOLD' });
  });

  it('a departed truck at a dock marks that dock bay', () => {
    const dock = DOCKS[2];
    const p = focusPlan(s, ev({ vehicleId: 'TRK-GONE', dockId: dock.id, zone: 'K' }));
    expect(p.primary).toBe('area');
    expect(p.area!.x[0]).toBeLessThan(dock.x);
    expect(p.area!.x[1]).toBeGreaterThan(dock.x);
    expect(p.open).toEqual({ equipmentId: 'K-DOCK' });
  });

  it('an area without an asset opens its zone; nothing else falls back to the zone tag', () => {
    const walk = focusPlan(s, ev({ vehicleId: 'TRK-GONE', geofenceId: 'GF-WALK', zone: 'J' }));
    expect(walk.primary).toBe('area');
    expect(walk.open).toEqual({ stationId: undefined, zone: 'J' });
    const zone = focusPlan(s, ev({ zone: 'H' }));
    expect(zone.primary).toBe('point');
    expect(zone.point).toEqual(ZONE_BY_ID.H.label);
    expect(focusPlan(s, ev({})).primary).toBeNull();
  });

  it('ignores the whole-site geofence', () => {
    const p = focusPlan(s, ev({ geofenceId: 'GF-SITE', equipmentId: 'A-GATE' }));
    expect(p.area).toBeNull();
    expect(p.primary).toBe('equipment');
  });
});

describe('focus ring', () => {
  it('pulses for RING_SECONDS, fading out in the last second', () => {
    expect(ringPhase(-1, 3)).toBeNull();
    expect(ringPhase(RING_SECONDS, 3)).toBeNull();
    const a = ringPhase(0.2, 3)!;
    expect(a.opacity).toBeCloseTo(0.95);
    expect(a.grow).toBeGreaterThan(0);
    expect(a.grow).toBeLessThan(3);
    expect(ringPhase(RING_SECONDS - 0.5, 3)!.opacity).toBeCloseTo(0.475);
    // The ripple restarts every period and fades as it grows.
    const early = ringPhase(1.7, 3, 1.6)!;
    const late = ringPhase(3.0, 3, 1.6)!;
    expect(early.grow).toBeLessThan(late.grow);
    expect(early.rippleOpacity).toBeGreaterThan(late.rippleOpacity);
  });

  it('loops are closed and grow by the same distance on both axes', () => {
    const c = circleLoop(2, 16);
    expect(c.pts[0][0]).toBeCloseTo(c.pts[c.pts.length - 1][0]);
    expect(c.pts[0][1]).toBeCloseTo(c.pts[c.pts.length - 1][1]);
    const r = rectLoop(10, 2);
    expect(r.pts[0]).toEqual(r.pts[r.pts.length - 1]);
    const [kx, kz] = growScale(r, 1);
    expect(r.hx * kx - r.hx).toBeCloseTo(1);
    expect(r.hz * kz - r.hz).toBeCloseTo(1);
    expect(rippleReach(r)).toBeGreaterThanOrEqual(1.6);
    expect(rippleReach(rectLoop(100, 100))).toBe(6);
  });

  it('centredLoop re-centres a world loop on its bounding box', () => {
    const { loop, cx, cz } = centredLoop([
      [10, 20],
      [14, 20],
      [14, 30],
      [10, 30],
      [10, 20],
    ]);
    expect([cx, cz]).toEqual([12, 25]);
    expect([loop.hx, loop.hz]).toEqual([2, 5]);
    expect(loop.pts[0]).toEqual([-2, -5]);
  });
});

describe('remembered focus', () => {
  const f: EventFocus = { eventId: 'EV-00012', nonce: 1, resets: 0, target: { equipmentId: 'CV-PACK', vehicleId: null } };

  it('applies only while the same event is selected in the same simulation', () => {
    expect(isFocusCurrent(f, 'EV-00012', 0)).toBe(true);
    expect(isFocusCurrent(f, 'EV-00013', 0)).toBe(false);
    expect(isFocusCurrent(f, null, 0)).toBe(false);
    expect(isFocusCurrent(f, 'EV-00012', 1)).toBe(false);
    expect(isFocusCurrent(null, 'EV-00012', 0)).toBe(false);
  });

  it('is left when another asset or vehicle is selected, kept for the target or a cleared selection', () => {
    const none = { selected: null, vehicle: null };
    expect(selectionLeavesFocus(f, { selected: 'CV-PACK', vehicle: null }, { selected: 'H-KILN', vehicle: null })).toBe(false);
    expect(selectionLeavesFocus(f, none, { selected: 'CV-PACK', vehicle: null })).toBe(false);
    expect(selectionLeavesFocus(f, { selected: 'J-BOX', vehicle: null }, { selected: 'CV-PACK', vehicle: null })).toBe(true);
    expect(selectionLeavesFocus(f, { selected: null, vehicle: 'FLT-01' }, none)).toBe(true);
    const v: EventFocus = { ...f, target: { equipmentId: null, vehicleId: 'TRK-1202' } };
    expect(selectionLeavesFocus(v, { selected: null, vehicle: 'TRK-1202' }, { selected: 'H-KILN', vehicle: null })).toBe(false);
    // Unrelated store changes (same selection) never drop it.
    expect(selectionLeavesFocus(f, { selected: 'J-BOX', vehicle: null }, { selected: 'J-BOX', vehicle: null })).toBe(false);
  });
});
