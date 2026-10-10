/**
 * Stack-light beacon above every process machine, coloured by the product-wide operational
 * scheme from `operationalState` (green running · amber below rate / starved / blocked · red
 * stopped or fault · grey planned stop, or unknown while the asset's data feed is stale).
 * Two instanced meshes for all machines; colours, the slow red pulse and the distance
 * scaling (so beacons stay legible in overview shots) are written in the render loop.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Color, InstancedMesh, MathUtils, MeshBasicMaterial, Object3D } from 'three';
import { PROCESS_MACHINES } from '../../model/plant';
import type { SimState } from '../../sim/engine';
import { operationalState } from '../../sim/metrics';
import { useSim } from '../../sim/store';
import { useTwin } from '../../store';
import { OPERATIONAL_STATE, OP_COLOR_HEX, toneToColor, type OpColor } from '../../ui/kit/Status';
import { MAT, UNIT_CYLINDER_LOW } from '../materials';
import { topCenter, useBoundsCount } from './shared';

const POLE_H = 0.9;
const LAMP_H = 0.34;
const LAMP_R = 0.2;

/** Lamp colours slightly below full value: lit, but not glowing. */
const LAMP_COLOR: Record<OpColor, Color> = {
  green: new Color(OP_COLOR_HEX.green).multiplyScalar(0.9),
  amber: new Color(OP_COLOR_HEX.amber).multiplyScalar(0.9),
  red: new Color(OP_COLOR_HEX.red),
  grey: new Color(OP_COLOR_HEX.grey).multiplyScalar(0.8),
};
const LAMP_MATERIAL = new MeshBasicMaterial({ color: '#ffffff', toneMapped: false });

export function StatusBeacons() {
  const visible = useTwin((s) => s.layers.status && s.layers.equipment);
  const ready = useBoundsCount(PROCESS_MACHINES);
  const anchors = useMemo(
    () => PROCESS_MACHINES.map((id) => ({ id, at: topCenter(id) })).filter((a) => a.at != null),
    // Re-read the bounds when more of them have been registered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready],
  );
  const dark = useRef<InstancedMesh>(null);
  const lamps = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const color = useMemo(() => new Color(), []);
  // Lamp colours change at most once per simulated minute: derive them once per state version.
  const ops = useRef<{ sim: SimState | null; version: number; colors: OpColor[] }>({ sim: null, version: -1, colors: [] });

  useLayoutEffect(() => {
    // instanceColor is created on first use; set every lamp once so the buffer exists.
    const m = lamps.current;
    if (!m) return;
    for (let i = 0; i < anchors.length; i++) m.setColorAt(i, LAMP_COLOR.grey);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [anchors]);

  useFrame(({ camera, clock }) => {
    const d = dark.current;
    const l = lamps.current;
    if (!d || !l || !visible) return;
    const sim = useSim.getState().sim;
    const cache = ops.current;
    if (cache.sim !== sim || cache.version !== sim.version || cache.colors.length !== anchors.length) {
      cache.sim = sim;
      cache.version = sim.version;
      cache.colors = anchors.map(({ id }) => (sim.machines[id] ? toneToColor(OPERATIONAL_STATE[operationalState(sim, id)].tone) : 'grey'));
    }
    const pulse = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 2.4));
    anchors.forEach(({ at }, i) => {
      const p = at!;
      // Constant-ish screen size: full scale up close, up to 4.5× in overview shots.
      const k = MathUtils.clamp(camera.position.distanceTo(p) / 55, 1, 4.5);
      // Pole (dark), lamp and cap.
      dummy.rotation.set(0, 0, 0);
      dummy.position.set(p.x, p.y + (POLE_H / 2) * k, p.z);
      dummy.scale.set(0.05 * k, POLE_H * k, 0.05 * k);
      dummy.updateMatrix();
      d.setMatrixAt(i * 2, dummy.matrix);
      dummy.position.set(p.x, p.y + (POLE_H + LAMP_H + 0.03) * k, p.z);
      dummy.scale.set((LAMP_R + 0.02) * k, 0.06 * k, (LAMP_R + 0.02) * k);
      dummy.updateMatrix();
      d.setMatrixAt(i * 2 + 1, dummy.matrix);
      dummy.position.set(p.x, p.y + (POLE_H + LAMP_H / 2) * k, p.z);
      dummy.scale.set(LAMP_R * k, LAMP_H * k, LAMP_R * k);
      dummy.updateMatrix();
      l.setMatrixAt(i, dummy.matrix);

      const op = cache.colors[i];
      color.copy(LAMP_COLOR[op]);
      if (op === 'red') color.multiplyScalar(pulse);
      l.setColorAt(i, color);
    });
    d.instanceMatrix.needsUpdate = true;
    l.instanceMatrix.needsUpdate = true;
    if (l.instanceColor) l.instanceColor.needsUpdate = true;
  });

  if (!anchors.length) return null;
  return (
    <group visible={visible}>
      <instancedMesh
        key={`d${anchors.length}`}
        ref={dark}
        args={[UNIT_CYLINDER_LOW, MAT.machineDark, anchors.length * 2]}
        frustumCulled={false}
      />
      <instancedMesh
        key={`l${anchors.length}`}
        ref={lamps}
        args={[UNIT_CYLINDER_LOW, LAMP_MATERIAL, anchors.length]}
        frustumCulled={false}
      />
    </group>
  );
}
