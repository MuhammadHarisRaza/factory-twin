import { Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import { ACESFilmicToneMapping, DirectionalLight, MathUtils, PMREMGenerator, Vector3 } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { minimapCamera, useTwin } from '../store';
import { SITE, VIEWS, ZONES } from '../data/layout';
import { Ground } from './Ground';
import { Buildings } from './Buildings';
import { SiteDetails } from './Site';
import { Structure } from './Structure';
import { Conveyors } from './Conveyors';
import { FlowOverlay } from './FlowOverlay';
import { Utilities } from './zones/Utilities';
import { RawMaterials } from './zones/RawMaterials';
import { Preparation } from './zones/Preparation';
import { SprayDrying } from './zones/SprayDrying';
import { Dryer, Presses } from './zones/PressingDrying';
import { Glazing } from './zones/Glazing';
import { Kiln } from './zones/Kiln';
import { Packaging, Sorting } from './zones/SortingPackaging';
import { Warehouse } from './zones/Warehouse';
import { Maintenance } from './zones/Maintenance';

const SITE_CENTER = new Vector3((SITE.x[0] + SITE.x[1]) / 2, 0, (SITE.z[0] + SITE.z[1]) / 2);

/**
 * Eases the camera towards the latest store request (view preset, zone, focus,
 * minimap click or "fit"), keeps the orbit target inside the site, and
 * publishes the camera position for the minimap. Any user drag cancels a flight.
 */
function CameraRig() {
  const request = useTwin((s) => s.camera);
  const fitNonce = useTwin((s) => s.fitNonce);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const flight = useRef<{ pos: Vector3; target: Vector3 } | null>(null);

  useEffect(() => {
    flight.current = { pos: new Vector3(...request.pos), target: new Vector3(...request.target) };
    // Only a new nonce starts a flight; the coordinates come along with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.nonce]);

  useEffect(() => {
    if (!fitNonce || !('fov' in camera)) return;
    // Distance at which the site's bounding circle fills the narrower field of view.
    const radius = Math.hypot(SITE.x[1] - SITE.x[0], SITE.z[1] - SITE.z[0]) / 2;
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (size.width / size.height));
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.82;
    const dir = new Vector3(...VIEWS.full.pos).sub(new Vector3(...VIEWS.full.target)).normalize();
    flight.current = { pos: SITE_CENTER.clone().add(dir.multiplyScalar(distance)), target: SITE_CENTER.clone() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce]);

  useEffect(() => {
    if (!controls) return;
    const cancel = () => {
      flight.current = null;
    };
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [controls]);

  useFrame((state, dt) => {
    if (!controls) return;
    const f = flight.current;
    if (f) {
      const t = 1 - Math.exp(-dt * 2.8);
      state.camera.position.lerp(f.pos, t);
      controls.target.lerp(f.target, t);
      if (state.camera.position.distanceTo(f.pos) < 0.08 && controls.target.distanceTo(f.target) < 0.08) {
        flight.current = null;
      }
    }
    const target = controls.target;
    target.x = MathUtils.clamp(target.x, SITE.x[0] - 20, SITE.x[1] + 20);
    target.z = MathUtils.clamp(target.z, SITE.z[0] - 20, SITE.z[1] + 20);
    target.y = MathUtils.clamp(target.y, 0, 30);
    if (state.camera.position.y < 1.6) state.camera.position.y = 1.6;
    controls.update();
    minimapCamera.x = state.camera.position.x;
    minimapCamera.z = state.camera.position.z;
    minimapCamera.tx = target.x;
    minimapCamera.tz = target.z;
  });

  return null;
}

/**
 * The scene is static, so the shadow map is rendered on demand: once now and a
 * few more times while lazily built geometry settles, and again whenever a
 * layer that casts shadows is toggled.
 */
function ShadowRefresher() {
  const gl = useThree((s) => s.gl);
  const layers = useTwin((s) => s.layers);
  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    const timers = [300, 1200, 2500].map((ms) =>
      setTimeout(() => {
        gl.shadowMap.needsUpdate = true;
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [gl, layers.roof, layers.walls, layers.structure, layers.equipment, layers.conveyors]);
  return null;
}

/** Image-based lighting from three's procedural RoomEnvironment. */
function Environment() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = texture;
    scene.environmentIntensity = 0.45;
    return () => {
      texture.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/** Marks the app ready after the third rendered frame (hides the loader). */
function ReadySignal() {
  const setReady = useTwin((s) => s.setReady);
  const frames = useRef(0);
  useFrame(() => {
    if (++frames.current === 3) setReady();
  });
  return null;
}

function Lights() {
  const sun = useMemo(() => new DirectionalLight('#fff6ea', 2.3), []);
  useEffect(() => {
    sun.position.set(-90, 160, 110);
    sun.target.position.set(-10, 0, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const cam = sun.shadow.camera;
    cam.left = -175;
    cam.right = 175;
    cam.top = 130;
    cam.bottom = -130;
    cam.near = 20;
    cam.far = 420;
    sun.shadow.bias = -6e-4;
    sun.shadow.normalBias = 0.6;
    cam.updateProjectionMatrix();
  }, [sun]);
  return (
    <>
      <hemisphereLight args={['#dde7f0', '#7d7466', 0.7]} />
      <primitive object={sun} />
      <primitive object={sun.target} />
      <directionalLight position={[120, 60, -80]} intensity={0.35} color="#cfe0ff" />
    </>
  );
}

/** Clickable zone name tags on the ground (hidden in flow mode). */
function ZoneLabels() {
  const visible = useTwin((s) => s.layers.labels && !s.layers.flow);
  const activeZone = useTwin((s) => s.zone);
  const selectZone = useTwin((s) => s.selectZone);
  if (!visible) return null;
  return (
    <>
      {ZONES.map((zone) => (
        <Html key={zone.id} position={[zone.label[0], 0.5, zone.label[1]]} center zIndexRange={[8, 0]}>
          <button
            className={`zone-tag ${activeZone === zone.id ? 'on' : ''}`}
            onClick={() => selectZone(zone.id)}
            title={`Go to ${zone.name}`}
          >
            <span style={{ background: zone.color }}>{zone.id}</span>
            {zone.short}
          </button>
        </Html>
      ))}
    </>
  );
}

/** All process equipment, in process order. */
function Equipment() {
  const visible = useTwin((s) => s.layers.equipment);
  return (
    <group visible={visible}>
      <Utilities />
      <RawMaterials />
      <Preparation />
      <SprayDrying />
      <Presses />
      <Dryer />
      <Glazing />
      <Kiln />
      <Sorting />
      <Packaging />
      <Warehouse />
      <Maintenance />
    </group>
  );
}

export default function Scene() {
  const start = VIEWS.full;
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ position: start.pos, fov: 32, near: 1, far: 1600 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 1;
      }}
    >
      <color attach="background" args={['#d7dee5']} />
      <fog attach="fog" args={['#d7dee5', 380, 900]} />
      <Lights />
      <Environment />
      <ShadowRefresher />
      <Suspense fallback={null}>
        <Ground />
        <Buildings />
        <SiteDetails />
        <Structure />
        <Equipment />
        <Conveyors />
        <FlowOverlay />
        <ZoneLabels />
      </Suspense>
      <OrbitControls
        makeDefault
        target={start.target}
        enableDamping
        dampingFactor={0.08}
        maxPolarAngle={1.47}
        minDistance={6}
        maxDistance={480}
        screenSpacePanning={false}
      />
      <CameraRig />
      <ReadySignal />
    </Canvas>
  );
}
