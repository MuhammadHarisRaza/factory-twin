import { create } from 'zustand';
import { Box3, Vector3 } from 'three';
import { VIEWS, ZONE_BY_ID } from './data/layout';
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

type CameraRequest = { pos: Vec3; target: Vec3; nonce: number };

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
    if (id) get().preset(ZONE_BY_ID[id].preset);
  },
  preset: (id) => set((s) => ({ camera: { ...VIEWS[id], nonce: s.camera.nonce + 1 } })),
  flyTo: (pos, target) => set((s) => ({ camera: { pos, target, nonce: s.camera.nonce + 1 } })),
  focusEquipment: (id) => {
    const box = equipmentBounds.get(id);
    if (!box) return;
    const center = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const distance = Math.max(16, size.length() * 1.25);
    const offset = new Vector3(0.5, 0.62, 0.95).normalize().multiplyScalar(distance);
    get().flyTo(
      [center.x + offset.x, Math.max(4, center.y * 0.5 + offset.y), center.z + offset.z],
      [center.x, center.y * 0.5, center.z],
    );
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
if (import.meta.env.DEV) (window as unknown as { twin: typeof useTwin }).twin = useTwin;
