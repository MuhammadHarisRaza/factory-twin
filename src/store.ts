import { create } from 'zustand';
import { Box3, Vector3 } from 'three';
import { HALL, VIEWS, ZONE_BY_ID } from './data/layout';
import { EQUIPMENT_BY_ID } from './data/equipment';
import type { PresetId, Vec3 } from './data/types';

export type LayerId =
  | 'roof'
  | 'walls'
  | 'structure'
  | 'equipment'
  | 'conveyors'
  | 'flow'
  | 'labels'
  | 'minimap';

export const LAYER_LABELS: Record<LayerId, string> = {
  roof: 'Roof',
  walls: 'Exterior walls',
  structure: 'Structure',
  equipment: 'Equipment',
  conveyors: 'Conveyors',
  flow: 'Material flow',
  labels: 'Labels',
  minimap: 'Minimap',
};

/**
 * Camera position written every frame by the camera rig and polled by the
 * minimap. Kept outside React state so it doesn't re-render the app at 60 fps.
 */
export const minimapCamera = { x: 0, z: 0, tx: 0, tz: 0 };

/** World-space bounds of each equipment group, registered by <Selectable>. */
export const equipmentBounds = new Map<string, Box3>();

/** Vertical field of view of the scene camera (degrees). */
export const CAMERA_FOV = 32;

type CameraRequest = {
  pos: Vec3;
  target: Vec3;
  nonce: number;
};

type TwinState = {
  layers: Record<LayerId, boolean>;
  selected: string | null;
  hovered: string | null;
  zone: string | null;
  /** A new nonce tells the camera rig to fly to pos/target. */
  camera: CameraRequest;
  fitNonce: number;
  uiHidden: boolean;
  zonePanel: boolean;
  ready: boolean;
  toggle: (layer: LayerId) => void;
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
  selectZone: (id: string | null) => void;
  preset: (id: PresetId) => void;
  flyTo: (pos: Vec3, target: Vec3) => void;
  focusEquipment: (id: string) => void;
  reset: () => void;
  fit: () => void;
  setUiHidden: (hidden: boolean) => void;
  setZonePanel: (open: boolean) => void;
  setReady: () => void;
};

export const useTwin = create<TwinState>((set, get) => ({
  layers: {
    roof: false,
    walls: true,
    structure: true,
    equipment: true,
    conveyors: true,
    flow: false,
    labels: true,
    minimap: true,
  },
  selected: null,
  hovered: null,
  zone: null,
  camera: { ...VIEWS.full, nonce: 0 },
  fitNonce: 0,
  uiHidden: false,
  zonePanel: true,
  ready: false,

  toggle: (layer) => set((s) => ({ layers: { ...s.layers, [layer]: !s.layers[layer] } })),
  select: (id) => {
    set({ selected: id });
    if (id) {
      set({ zone: EQUIPMENT_BY_ID[id].zone });
      get().focusEquipment(id);
    }
  },
  hover: (id) => set({ hovered: id }),
  selectZone: (id) => {
    set({ zone: id, selected: null });
    // Clearing the zone returns to the overview so the user is never left stranded.
    get().preset(id ? ZONE_BY_ID[id].preset : 'full');
  },
  preset: (id) => set((s) => ({ camera: { ...VIEWS[id], nonce: s.camera.nonce + 1 } })),
  flyTo: (pos, target) => set((s) => ({ camera: { pos, target, nonce: s.camera.nonce + 1 } })),
  focusEquipment: (id) => {
    const box = equipmentBounds.get(id);
    if (!box) return;
    const center = box.getCenter(new Vector3());
    const radius = Math.max(2.5, box.getSize(new Vector3()).length() / 2);
    // Distance at which the bounding sphere fills ~85% of the vertical field of view.
    const distance = Math.max(11, (radius / Math.sin((CAMERA_FOV * Math.PI) / 360)) * 0.95);

    // Keep the current compass direction so the camera doesn't swing around the plant…
    const dir = new Vector3(minimapCamera.x - minimapCamera.tx, 0, minimapCamera.z - minimapCamera.tz);
    if (dir.lengthSq() < 1e-6) dir.set(0.45, 0, 0.9);
    dir.normalize();
    // …but look into buildings from the south, where the cutaway walls are low.
    const inside = (r: { x: [number, number]; z: [number, number] }) =>
      center.x > r.x[0] && center.x < r.x[1] && center.z > r.z[0] && center.z < r.z[1];
    if (center.x < -76 || inside(HALL.rect)) {
      if (dir.z < 0.55) dir.z = 0.55;
      dir.normalize();
    }
    const elevation = (34 * Math.PI) / 180;
    const target = new Vector3(center.x, center.y * 0.55, center.z);
    // Shift the framing so the asset sits left of centre, clear of the inspector panel.
    const right = new Vector3(dir.z, 0, -dir.x).multiplyScalar(distance * 0.1);
    target.add(right);
    const pos = target
      .clone()
      .addScaledVector(dir, Math.cos(elevation) * distance)
      .add(new Vector3(0, Math.sin(elevation) * distance, 0));
    pos.y = Math.max(3, pos.y);
    set((s) => ({
      camera: { pos: pos.toArray(), target: target.toArray(), nonce: s.camera.nonce + 1 },
    }));
  },
  reset: () => {
    set({ selected: null, zone: null });
    get().preset('full');
  },
  fit: () => set((s) => ({ fitNonce: s.fitNonce + 1 })),
  setUiHidden: (hidden) => set({ uiHidden: hidden }),
  setZonePanel: (open) => set({ zonePanel: open }),
  setReady: () => set({ ready: true }),
}));

// Dev-only handle for debugging and automated checks in the browser console.
if (import.meta.env.DEV) {
  const w = window as unknown as {
    twin: typeof useTwin;
    cam: typeof minimapCamera;
    shot: (view: PresetId, layers?: Partial<Record<LayerId, boolean>>) => Promise<string>;
  };
  w.twin = useTwin;
  w.cam = minimapCamera;
  // Hide the UI, set layers, fly to a view and wait for the flight to settle.
  w.shot = async (view, layers = {}) => {
    const s = useTwin.getState();
    useTwin.setState({ uiHidden: true, selected: null, zone: null, layers: { ...s.layers, flow: false, ...layers } });
    s.preset(view);
    await new Promise((r) => setTimeout(r, 3500));
    return view;
  };
}
