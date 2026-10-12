import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls, PerformanceMonitor } from '@react-three/drei';
import { EffectComposer, N8AO } from '@react-three/postprocessing';
import { ACESFilmicToneMapping, DirectionalLight, MathUtils, PMREMGenerator, Vector3 } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { CAMERA_FOV, minimapCamera, useTwin } from '../store';
import { SITE, VIEWS, ZONES } from '../data/layout';
import { Ground } from './Ground';
import { Buildings } from './Buildings';
import { SiteDetails } from './Site';
import { Structure } from './Structure';
import { Conveyors } from './Conveyors';
import { FlowOverlay } from './FlowOverlay';
import { SimVehicles, selectedVehiclePose } from './SimVehicles';
import { OperationalStatus } from './status';
import { EventFocus } from './events/EventFocus';
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
import { CctvRenderer } from './cctv/CctvRenderer';
import { sceneTabIndex, useSceneEmbedded, wheelAction } from './embedded';
import { setPinOpacity } from './status/pins';

const SITE_CENTER = new Vector3((SITE.x[0] + SITE.x[1]) / 2, 0, (SITE.z[0] + SITE.z[1]) / 2);
/** Orbit damping, applied by one controls update per frame: 0.15 keeps the feel of the former 0.08 applied twice (finding #40). */
const DAMPING = 0.15;

type Flight = {
  fromPos: Vector3;
  fromTarget: Vector3;
  toPos: Vector3;
  toTarget: Vector3;
  /** Seconds. */
  duration: number;
  elapsed: number;
  /** Extra height at mid-flight so long moves arc over the buildings. */
  lift: number;
};

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Presets are composed for a ~16:10 canvas. On narrower canvases the vertical field of
 * view widens so the horizontal coverage stays the same, instead of moving the camera
 * (which would push interior views into the steelwork).
 */
function ResponsiveFov() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  useEffect(() => {
    if (!('fov' in camera)) return;
    const aspect = size.width / size.height;
    const reference = 1.6;
    const half = (CAMERA_FOV * Math.PI) / 360;
    const fov =
      aspect >= reference ? CAMERA_FOV : (2 * Math.atan((Math.tan(half) * reference) / aspect) * 180) / Math.PI;
    camera.fov = Math.min(fov, 52);
    camera.updateProjectionMatrix();
  }, [camera, size]);
  return null;
}

/**
 * Flies the camera to the latest store request (view preset, zone, equipment focus,
 * minimap click or "fit") along an eased path, keeps the orbit target inside the
 * site, and publishes the camera position for the minimap. A user drag cancels a flight.
 */
function CameraRig() {
  const request = useTwin((s) => s.camera);
  const fitNonce = useTwin((s) => s.fitNonce);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const flight = useRef<Flight | null>(null);

  const startFlight = (toPos: Vector3, toTarget: Vector3) => {
    if (!controls) return;
    const fromPos = camera.position.clone();
    const fromTarget = controls.target.clone();
    const travel = Math.max(fromPos.distanceTo(toPos), fromTarget.distanceTo(toTarget));
    flight.current = {
      fromPos,
      fromTarget,
      toPos,
      toTarget,
      duration: MathUtils.clamp(0.75 + travel / 220, 0.8, 2.1),
      elapsed: 0,
      lift: travel > 60 ? Math.min(35, travel * 0.12) : 0,
    };
  };

  useEffect(() => {
    startFlight(new Vector3(...request.pos), new Vector3(...request.target));
    // Only a new nonce starts a flight; the coordinates come along with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.nonce, controls]);

  useEffect(() => {
    if (!fitNonce || !('fov' in camera)) return;
    // Distance at which the site's bounding circle fills the narrower field of view.
    const radius = Math.hypot(SITE.x[1] - SITE.x[0], SITE.z[1] - SITE.z[0]) / 2;
    const vFov = (camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (size.width / size.height));
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.82;
    const dir = new Vector3(...VIEWS.full.pos).sub(new Vector3(...VIEWS.full.target)).normalize();
    startFlight(SITE_CENTER.clone().add(dir.multiplyScalar(distance)), SITE_CENTER.clone());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitNonce]);

  // Following a vehicle: fly in once, then keep it centred (the user can still orbit and zoom).
  const vehicle = useTwin((s) => s.vehicle);
  const follow = useTwin((s) => s.follow);
  useEffect(() => {
    if (!vehicle || !follow || !controls) return;
    const p = selectedVehiclePose();
    if (!p) return;
    const target = new Vector3(p.x, 1.5, p.z);
    const dir = camera.position.clone().sub(controls.target).setY(0);
    if (dir.lengthSq() < 1) dir.set(0.5, 0, 0.9);
    dir.normalize();
    const distance = 46;
    const pos = target.clone().addScaledVector(dir, Math.cos(0.62) * distance).add(new Vector3(0, Math.sin(0.62) * distance, 0));
    startFlight(pos, target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, follow, controls]);

  useEffect(() => {
    if (!controls) return;
    const cancel = () => {
      flight.current = null;
    };
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [controls]);

  // Runs before drei's OrbitControls (priority -1), whose single update() per frame then applies the
  // flight / follow / clamped target with damping — calling update() here as well doubled the
  // damping (finding #40). A negative priority keeps R3F's automatic rendering.
  useFrame((state, dt) => {
    if (!controls) return;
    const f = flight.current;
    if (f) {
      f.elapsed += Math.min(dt, 0.05);
      const t = Math.min(1, f.elapsed / f.duration);
      const e = easeInOutCubic(t);
      state.camera.position.lerpVectors(f.fromPos, f.toPos, e);
      state.camera.position.y += Math.sin(Math.PI * e) * f.lift;
      controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
      if (t >= 1) flight.current = null;
    }
    const tw = useTwin.getState();
    if (!f && tw.follow && tw.vehicle) {
      const p = selectedVehiclePose();
      if (p) {
        const k = 1 - Math.exp(-dt * 4);
        const dx = (p.x - controls.target.x) * k;
        const dz = (p.z - controls.target.z) * k;
        controls.target.x += dx;
        controls.target.z += dz;
        state.camera.position.x += dx;
        state.camera.position.z += dz;
      }
    }
    const target = controls.target;
    target.x = MathUtils.clamp(target.x, SITE.x[0] - 20, SITE.x[1] + 20);
    target.z = MathUtils.clamp(target.z, SITE.z[0] - 20, SITE.z[1] + 20);
    target.y = MathUtils.clamp(target.y, 0, 30);
    if (state.camera.position.y < 1.6) state.camera.position.y = 1.6;
    minimapCamera.x = state.camera.position.x;
    minimapCamera.z = state.camera.position.z;
    minimapCamera.tx = target.x;
    minimapCamera.tz = target.z;
  }, -2);

  return null;
}

/**
 * Shadows are rendered on demand rather than every frame. Updates are requested from
 * inside the render loop (so they always happen in a normal scene render, never inside a
 * post-processing pass), when a shadow-casting layer changes, when the twin becomes
 * visible again, and every few seconds so moved geometry (dock doors) stays correct.
 */
function ShadowRefresher({ active }: { active: boolean }) {
  const gl = useThree((s) => s.gl);
  const layers = useTwin((s) => s.layers);
  const pending = useRef(3);
  const sinceRefresh = useRef(0);
  useEffect(() => {
    gl.shadowMap.autoUpdate = false;
  }, [gl]);
  useEffect(() => {
    // A few refreshes while lazily built geometry settles.
    pending.current = 3;
  }, [active, layers.roof, layers.walls, layers.structure, layers.equipment, layers.conveyors]);
  useFrame((_, dt) => {
    sinceRefresh.current += dt;
    if (pending.current > 0 && sinceRefresh.current > 0.4) {
      pending.current--;
      sinceRefresh.current = 0;
      gl.shadowMap.needsUpdate = true;
    } else if (sinceRefresh.current > 3) {
      sinceRefresh.current = 0;
      gl.shadowMap.needsUpdate = true;
    }
  });
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
    scene.environmentIntensity = 0.55;
    return () => {
      texture.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);
  return null;
}

/** Dev-only: exposes the renderer, scene and camera for console profiling. */
function DevHandles() {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { r3f: { gl, scene, camera } });
  }, [gl, scene, camera]);
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
  const sun = useMemo(() => new DirectionalLight('#fff3e3', 2.5), []);
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
    sun.shadow.bias = -4e-4;
    sun.shadow.normalBias = 0.45;
    sun.shadow.radius = 3;
    cam.updateProjectionMatrix();
  }, [sun]);
  return (
    <>
      <hemisphereLight args={['#dfe7ee', '#8a8172', 0.62]} />
      <primitive object={sun} />
      <primitive object={sun.target} />
      <directionalLight position={[120, 60, -80]} intensity={0.35} color="#cfe0ff" />
    </>
  );
}

/**
 * How visible a world-space label should be for the current camera: everything shows in
 * overview shots; in close shots only labels near the point of interest remain, so tags
 * from distant zones don't float over (or through) the machinery being inspected.
 */
export function labelOpacity(camera: Vector3, target: Vector3, x: number, z: number) {
  const height = camera.y;
  if (height > 70) return 1;
  const reach = MathUtils.lerp(28, 120, MathUtils.clamp((height - 8) / 62, 0, 1));
  const d = Math.hypot(x - target.x, z - target.z);
  return MathUtils.clamp(1 - (d - reach) / 18, 0, 1);
}

/**
 * Clickable zone name tags on the ground (hidden in flow mode), faded by relevance. A faded-out
 * tag catches neither clicks nor keyboard focus (setPinOpacity); embedded in a page the tags stay
 * clickable but leave the tab order (the page has a zone select).
 */
function ZoneLabels({ embedded }: { embedded: boolean }) {
  const visible = useTwin((s) => s.layers.labels && !s.layers.flow);
  const activeZone = useTwin((s) => s.zone);
  const selectZone = useTwin((s) => s.selectZone);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useFrame(({ camera }) => {
    if (!visible || !controls) return;
    ZONES.forEach((zone, i) => {
      const o = zone.id === activeZone ? 1 : labelOpacity(camera.position, controls.target, zone.label[0], zone.label[1]);
      setPinOpacity(refs.current[i], o);
    });
  });

  if (!visible) return null;
  return (
    <>
      {ZONES.map((zone, i) => (
        <Html key={zone.id} position={[zone.label[0], 0.5, zone.label[1]]} center zIndexRange={[8, 0]}>
          <button
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={`zone-tag ${activeZone === zone.id ? 'on' : ''}`}
            onClick={() => selectZone(zone.id)}
            title={`Go to ${zone.name}`}
            tabIndex={sceneTabIndex(embedded)}
          >
            <span style={{ background: zone.color }}>{zone.id}</span>
            {zone.short}
          </button>
        </Html>
      ))}
    </>
  );
}

/**
 * Embedded in a page (the Overview) the mouse wheel scrolls the page: the orbit controls' own wheel
 * zoom is off (enableZoom) and only Ctrl / ⌘ + wheel — or a trackpad pinch, which browsers send as
 * Ctrl + wheel — zooms the model, without the browser's page zoom. The full Factory Twin keeps the
 * controls' wheel zoom unchanged. Listens where the controls and the Html labels live.
 */
function EmbeddedWheelZoom({ embedded }: { embedded: boolean }) {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  useEffect(() => {
    const el = controls?.domElement;
    if (!embedded || !controls || !el) return;
    const onWheel = (e: WheelEvent) => {
      const action = wheelAction(true, e);
      if (action === 'page' || action === 'controls') return;
      e.preventDefault();
      if (action === 'none') return;
      controls.dispatchEvent({ type: 'start', target: controls });
      if (action === 'zoom-in') controls.dollyIn();
      else controls.dollyOut();
      controls.dispatchEvent({ type: 'end', target: controls });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [embedded, controls]);
  return null;
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

/**
 * Screen-space ambient occlusion grounds the procedural geometry (contact darkening
 * under machines, in rack bays and truss joints). MSAA comes from the composer.
 */
function Effects() {
  return (
    <EffectComposer multisampling={4} enableNormalPass={false}>
      <N8AO aoRadius={2.4} distanceFalloff={0.9} intensity={2.2} quality="medium" halfRes color="#1c2026" />
    </EffectComposer>
  );
}

/** `active` false pauses rendering (other workspace open) while keeping the scene and camera alive. */
export default function Scene({ active = true }: { active?: boolean }) {
  const start = VIEWS.full;
  // Drops ambient occlusion and resolution on slow GPUs; never re-enables mid-session
  // to avoid quality flicker during a presentation.
  const [highQuality, setHighQuality] = useState(true);
  const [dpr, setDpr] = useState(1.75);
  const embedded = useSceneEmbedded();
  return (
    <Canvas
      frameloop={active ? 'always' : 'never'}
      shadows="percentage"
      dpr={dpr}
      camera={{ position: start.pos, fov: CAMERA_FOV, near: 1, far: 1600 }}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
      }}
    >
      {active && (
        <PerformanceMonitor
          onDecline={() => {
            setHighQuality(false);
            setDpr(1);
          }}
          flipflops={1}
        />
      )}
      <color attach="background" args={['#d9e0e6']} />
      <fog attach="fog" args={['#d9e0e6', 380, 900]} />
      <Lights />
      <Environment />
      <ShadowRefresher active={active} />
      <Suspense fallback={null}>
        <Ground />
        <Buildings />
        <SiteDetails />
        <Structure />
        <Equipment />
        <Conveyors />
        <SimVehicles />
        <FlowOverlay />
        <OperationalStatus />
        <EventFocus />
        <ZoneLabels embedded={embedded} />
      </Suspense>
      <OrbitControls
        makeDefault
        target={start.target}
        enableDamping
        dampingFactor={DAMPING}
        maxPolarAngle={1.47}
        minDistance={6}
        maxDistance={480}
        screenSpacePanning={false}
        enableZoom={!embedded}
      />
      <EmbeddedWheelZoom embedded={embedded} />
      <ResponsiveFov />
      <CameraRig />
      <ReadySignal />
      <DevHandles />
      <CctvRenderer />
      {highQuality && <Effects />}
    </Canvas>
  );
}
