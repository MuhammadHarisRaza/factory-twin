/**
 * Vehicles driven by the logistics simulation. Each frame the pose is interpolated from
 * the vehicle's timed legs at the continuous simulation clock, so the 3D scene, the
 * Fleet site map and every logistics metric show the same movement.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import type { Group, Material } from 'three';
import type { Vehicle, VehicleLeg } from '../model/types';
import { phaseLabel, poseAt } from '../sim/logistics';
import { simClock, useSim, useSimValue } from '../sim/store';
import { useTwin } from '../store';
import { MAT, hash01 } from './materials';
import { Forklift, Truck, WheelLoader } from './vehicles';

const CAB: Material[] = [MAT.truckCab, MAT.truckCabBlue, MAT.trailer];

function VehicleObject({ v }: { v: Vehicle }) {
  const ref = useRef<Group>(null);
  const selected = useTwin((s) => s.vehicle === v.id);
  const layerOn = useTwin((s) => s.layers[v.class === 'external' ? 'external' : 'internal']);
  // Load state and activity follow the current leg. The leg is tracked in the render loop and the
  // component re-renders only when it changes (finding #39), not once per simulated minute.
  const legRef = useRef<VehicleLeg | null>(null);
  const [leg, setLeg] = useState<VehicleLeg | null>(() => {
    legRef.current = poseAt(v, simClock.t)?.leg ?? null;
    return legRef.current;
  });
  const loaded = leg?.loaded ?? false;

  useLayoutEffect(() => {
    // Moving objects would otherwise invalidate the static shadow map every frame.
    ref.current?.traverse((o) => {
      o.castShadow = false;
    });
  }, [loaded]);

  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    const p = poseAt(useSim.getState().sim.logistics.vehicles[v.id] ?? v, simClock.t);
    const l = p?.leg ?? null;
    if (l !== legRef.current) {
      legRef.current = l;
      setLeg(l);
    }
    if (!p) {
      g.visible = false;
      return;
    }
    g.visible = layerOn;
    const jump = Math.hypot(g.position.x - p.x, g.position.z - p.z) > 20;
    g.position.set(p.x, 0, p.z);
    let turn = p.heading - g.rotation.y;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    g.rotation.y = jump ? p.heading : g.rotation.y + turn * Math.min(1, dt * 7);
  });

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!layerOn || e.delta > 6) return;
    e.stopPropagation();
    useTwin.getState().selectVehicle(v.id);
  };
  const cab = CAB[Math.floor(hash01(v.id) * CAB.length)];
  const label = v.class === 'external' && v.phase ? phaseLabel[v.phase] : leg?.activity;

  return (
    <group
      ref={ref}
      name={`vehicle:${v.id}`}
      onClick={onClick}
      onPointerOver={(e) => {
        if (!layerOn) return;
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => (document.body.style.cursor = '')}
    >
      {v.type === 'outbound-truck' && <Truck p={[0, 0, 0]} kind="box" cab={cab} />}
      {v.type === 'inbound-tipper' && <Truck p={[0, 0, 0]} kind={loaded ? 'tipper' : 'flat'} cab={MAT.truckCabBlue} />}
      {v.type === 'forklift' && <Forklift p={[0, 0, 0]} load={loaded} />}
      {v.type === 'wheel-loader' && <WheelLoader p={[0, 0, 0]} />}
      {selected && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.06, 0]} renderOrder={9}>
            <ringGeometry args={[v.class === 'external' ? 8.2 : 2.4, v.class === 'external' ? 8.6 : 2.7, 48]} />
            <meshBasicMaterial color="#46c4dc" transparent opacity={0.9} depthWrite={false} />
          </mesh>
          <Html position={[0, v.class === 'external' ? 5.2 : 3.4, 0]} center zIndexRange={[9, 0]} style={{ pointerEvents: 'none' }}>
            <div className="vehicle-tag sel">
              <b>{v.label}</b>
              {label && <span className="muted">· {label}</span>}
            </div>
          </Html>
        </>
      )}
    </group>
  );
}

/** All active simulated vehicles (internal and external). */
export function SimVehicles() {
  const vehicles = useSimValue((s) => s.logistics.active.map((id) => s.logistics.vehicles[id]));
  return (
    <group>
      {vehicles.map((v) => (
        <VehicleObject key={v.id} v={v} />
      ))}
    </group>
  );
}

/** Current pose of the selected vehicle (for camera follow); null when none. */
export function selectedVehiclePose() {
  const id = useTwin.getState().vehicle;
  if (!id) return null;
  const v = useSim.getState().sim.logistics.vehicles[id];
  return v ? poseAt(v, simClock.t) : null;
}
