/**
 * The selected vehicle's remaining planned route, drawn on the ground as a dashed accent
 * band from the vehicle to its next destination, with a destination pin (activity, place and
 * planned arrival). The band geometry is rebuilt only when the plan changes (once per
 * simulated minute at most); the part already driven is clipped in the shader every frame,
 * so the route shortens smoothly as the vehicle moves.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { MapPin } from 'lucide-react';
import { BufferAttribute, BufferGeometry, Color, DoubleSide, MathUtils, ShaderMaterial, type Group, type Mesh } from 'three';
import { GEOFENCES } from '../../model/plant';
import { simClock, useSim, useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { plannedRoute, routeProgress, type PlannedRoute } from './model';

/** Same accent as the vehicle selection ring. */
const ROUTE_COLOR = '#46c4dc';
const ROUTE_Y = 0.16;
const GEOFENCE_NAME = Object.fromEntries(GEOFENCES.map((g) => [g.id, g.name]));

/** Flat ribbon along the route with mitred joins; per-vertex arc length for clipping and dashes. */
function ribbonGeometry(r: PlannedRoute) {
  const n = r.pts.length;
  const pos = new Float32Array(n * 2 * 3);
  const side = new Float32Array(n * 2 * 2);
  const dist = new Float32Array(n * 2);
  const normal = (i: number) => {
    const a = r.pts[Math.max(0, i)];
    const b = r.pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return [-dz / l, dx / l];
  };
  for (let i = 0; i < n; i++) {
    const n0 = normal(i - 1);
    const n1 = normal(i);
    let mx = i === 0 ? n1[0] : i === n - 1 ? n0[0] : n0[0] + n1[0];
    let mz = i === 0 ? n1[1] : i === n - 1 ? n0[1] : n0[1] + n1[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    // Miter length, limited so sharp turns don't spike.
    const ref = i === n - 1 ? n0 : n1;
    const dot = Math.max(0.35, mx * ref[0] + mz * ref[1]);
    const k = 1 / dot;
    for (let s = 0; s < 2; s++) {
      const v = i * 2 + s;
      pos.set([r.pts[i][0], ROUTE_Y, r.pts[i][1]], v * 3);
      const sign = s === 0 ? 1 : -1;
      side.set([mx * k * sign, mz * k * sign], v * 2);
      dist[v] = r.cum[i];
    }
  }
  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('aSide', new BufferAttribute(side, 2));
  g.setAttribute('aDist', new BufferAttribute(dist, 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

function routeMaterial() {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(ROUTE_COLOR) },
      uHalf: { value: 0.4 },
      uStart: { value: 0 },
      uOffset: { value: 0 },
      uPeriod: { value: 3 },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aSide;
      attribute float aDist;
      uniform float uHalf;
      varying float vDist;
      void main() {
        vec3 p = position;
        p.x += aSide.x * uHalf;
        p.z += aSide.y * uHalf;
        vDist = aDist;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStart;
      uniform float uOffset;
      uniform float uPeriod;
      varying float vDist;
      void main() {
        if (vDist < uStart) discard;
        float fadeIn = smoothstep(uStart, uStart + uPeriod * 0.6, vDist);
        float dash = step(fract((vDist - uOffset) / uPeriod), 0.55);
        gl_FragColor = vec4(uColor, mix(0.24, 0.95, dash) * fadeIn);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    side: DoubleSide,
    depthWrite: false,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export function VehicleRoute() {
  const id = useTwin((s) => s.vehicle);
  const layers = useTwin((s) => s.layers);
  const vehicle = useSimValue((s) => (id ? (s.logistics.vehicles[id] ?? null) : null), [id]);
  // Legs are appended in place as the plan develops; re-derive every simulated minute.
  const route = useSimValue(() => (vehicle ? plannedRoute(vehicle, simClock.t) : null), [vehicle]);
  const layerOn = vehicle ? layers[vehicle.class === 'external' ? 'external' : 'internal'] : false;

  const geometry = useMemo(() => (route ? ribbonGeometry(route) : null), [route]);
  const material = useMemo(routeMaterial, []);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  const mesh = useRef<Mesh>(null);
  const pin = useRef<Group>(null);
  const label = useRef<HTMLDivElement>(null);

  useFrame(({ camera }, dt) => {
    if (!route || !mesh.current) return;
    const t = simClock.t;
    const done = routeProgress(route, t);
    const arrived = t >= route.dest.leg.start || done >= route.length - 0.5;
    mesh.current.visible = !arrived;
    if (pin.current) pin.current.visible = !arrived;
    if (label.current) label.current.style.visibility = arrived ? 'hidden' : '';
    // Roughly constant on-screen width: thin up close, wider in overview shots.
    const d = camera.position.distanceTo(pin.current?.position ?? camera.position);
    const half = MathUtils.clamp(camera.position.y * 0.0042 + d * 0.0012, 0.22, 1.3);
    const u = material.uniforms;
    u.uHalf.value = half;
    u.uPeriod.value = half * 9;
    u.uStart.value = done;
    // Dashes march towards the destination while the simulation runs.
    if (useSim.getState().running) u.uOffset.value += Math.min(dt, 0.1) * half * 6;
    if (pin.current) pin.current.scale.setScalar(MathUtils.clamp(half / 0.4, 0.7, 3));
  });

  if (!route || !geometry || !layerOn || !vehicle) return null;
  const leg = route.dest.leg;
  const place = GEOFENCE_NAME[leg.zone];
  const eta = Number.isFinite(leg.start) ? formatClock(leg.start) : null;
  return (
    <group>
      <mesh ref={mesh} geometry={geometry} material={material} renderOrder={6} frustumCulled={false} />
      <group ref={pin} position={[route.dest.x, ROUTE_Y, route.dest.z]}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} renderOrder={7}>
          <ringGeometry args={[0.9, 1.25, 40]} />
          <meshBasicMaterial color={ROUTE_COLOR} transparent opacity={0.95} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]} renderOrder={7}>
          <circleGeometry args={[0.38, 24]} />
          <meshBasicMaterial color={ROUTE_COLOR} transparent opacity={0.95} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      <Html position={[route.dest.x, 2.2, route.dest.z]} center zIndexRange={[9, 0]} style={{ pointerEvents: 'none' }}>
        <div ref={label} className="vehicle-tag sel ops-dest">
          <MapPin size={12} strokeWidth={2.4} aria-hidden />
          <b>{leg.activity}</b>
          {(place || eta) && (
            <span className="muted">
              {place}
              {place && eta ? ' · ' : ''}
              {eta ? `ETA ${eta}` : ''}
            </span>
          )}
        </div>
      </Html>
    </group>
  );
}
