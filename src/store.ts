import { create } from 'zustand';
// Type-only: the shell must not pull three.js into the initial chunks (only the lazy Scene chunk needs it).
import type { Box3 } from 'three';
import { HALL, VIEWS, ZONE_BY_ID } from './data/layout';
import { EQUIPMENT_BY_ID } from './data/equipment';
import type { PresetId, Vec3 } from './data/types';
import { MONITORED_STAGE_BY_ID } from './model/plant';
import type { MonitoredStageId } from './model/types';
import { useTwinUi } from './ui/twin/uiStore';
import { widePanelFits } from './ui/twin/panelWidth';

/**
 * Which status markers the 3D model shows: every alert, only serious and critical ones, or none
 * (the equipment colours stay; only the floating alert markers are filtered).
 */
export type AlertFilter = 'all' | 'serious' | 'off';

export type LayerId =
  | 'roof'
  | 'walls'
  | 'structure'
  | 'equipment'
  | 'conveyors'
  | 'flow'
  | 'labels'
  | 'minimap'
  | 'status'
  | 'internal'
  | 'external';

export const LAYER_LABELS: Record<LayerId, string> = {
  roof: 'Roof',
  walls: 'Exterior walls',
  structure: 'Structure',
  equipment: 'Equipment',
  conveyors: 'Conveyors',
  flow: 'Material flow',
  labels: 'Labels',
  minimap: 'Minimap',
  status: 'Machine status',
  internal: 'Internal vehicles',
  external: 'External vehicles',
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

type XYZ = { x: number; y: number; z: number };
/** Structural subset of THREE.Box3 that the framing maths needs (a Box3 satisfies it). */
export type BoundsLike = { min: XYZ; max: XYZ };

/**
 * Camera pose that frames an asset's bounding box (plain numbers, no three.js at runtime): the bounding
 * sphere fills ~85 % of the vertical field of view, the current compass direction is kept (buildings are
 * entered from the south, where the cutaway walls are low) and, with `shiftFactor` (the compact panel),
 * the asset sits left of centre, clear of the inspector panel. Beside the wide panel the factor is 0: the
 * scene's view offset (Scene.tsx ViewInset) already centres the view in the strip left of the panel.
 * An empty box behaves like THREE.Box3 (centre and size zero).
 */
export function focusPose(box: BoundsLike, cam: { x: number; z: number; tx: number; tz: number }, shiftFactor = 0.1): { pos: Vec3; target: Vec3 } {
  const { min, max } = box;
  const empty = max.x < min.x || max.y < min.y || max.z < min.z;
  const center: XYZ = empty ? { x: 0, y: 0, z: 0 } : { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  const diagonal = empty ? 0 : Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z);
  const radius = Math.max(2.5, diagonal / 2);
  // Distance at which the bounding sphere fills ~85% of the vertical field of view.
  const distance = Math.max(11, (radius / Math.sin((CAMERA_FOV * Math.PI) / 360)) * 0.95);

  // Keep the current compass direction so the camera doesn't swing around the plant…
  let dx = cam.x - cam.tx;
  let dz = cam.z - cam.tz;
  if (dx * dx + dz * dz < 1e-6) {
    dx = 0.45;
    dz = 0.9;
  }
  const normalise = () => {
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
  };
  normalise();
  // …but look into buildings from the south, where the cutaway walls are low.
  const inside = (r: { x: [number, number]; z: [number, number] }) =>
    center.x > r.x[0] && center.x < r.x[1] && center.z > r.z[0] && center.z < r.z[1];
  if (center.x < -76 || inside(HALL.rect)) {
    if (dz < 0.55) dz = 0.55;
    normalise();
  }
  const elevation = (34 * Math.PI) / 180;
  // Shift the framing so the asset sits left of centre, clear of the (compact) inspector panel.
  const shift = distance * shiftFactor;
  const target: Vec3 = [center.x + dz * shift, center.y * 0.55, center.z - dx * shift];
  const out = Math.cos(elevation) * distance;
  const pos: Vec3 = [target[0] + dx * out, Math.max(3, target[1] + Math.sin(elevation) * distance), target[2] + dz * out];
  return { pos, target };
}

/**
 * The framing shift for a focus that opens the subject panel: none when the panel will be wide (its
 * insetRight is only measured after it opens, so the viewer's choice and the fit decide), else 0.1.
 */
export function focusShift(): number {
  const ui = useTwinUi.getState();
  const wide = ui.insetRight > 0 || (ui.panelWide && typeof window !== 'undefined' && typeof window.innerWidth === 'number' && widePanelFits(window.innerWidth, ui.viewW));
  return wide ? 0 : 0.1;
}

/** The last framing of an asset or stage: what it framed, with which shift, under which camera request. */
let lastFocus: { id: string; shift: number; nonce: number } | null = null;
export const lastFocusPose = () => lastFocus;

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
  /** Selected vehicle (exclusive with equipment selection). */
  vehicle: string | null;
  /** Camera keeps the selected vehicle in frame. */
  follow: boolean;
  /**
   * Production stage highlighted in the model (its equipment and conveyors), shared by the
   * Overview flow strip, Production and the Factory Twin. Independent of the single selection.
   */
  stage: MonitoredStageId | null;
  /** Alert markers shown in the model. */
  alertFilter: AlertFilter;
  toggle: (layer: LayerId) => void;
  /** Highlights a stage's equipment and frames it (null clears the highlight; the camera stays). */
  selectStage: (id: MonitoredStageId | null, opts?: { frame?: boolean }) => void;
  setAlertFilter: (f: AlertFilter) => void;
  selectVehicle: (id: string | null, follow?: boolean) => void;
  setFollow: (follow: boolean) => void;
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
    // The site plan covers part of the model on laptop screens: shown by default only on large ones (layer toggle).
    minimap: typeof window === 'undefined' || ((window.innerWidth ?? 1920) >= 1600 && (window.innerHeight ?? 1080) >= 900),
    status: true,
    internal: true,
    external: true,
  },
  vehicle: null,
  follow: false,
  stage: null,
  alertFilter: 'all',
  selected: null,
  hovered: null,
  zone: null,
  camera: { ...VIEWS.full, nonce: 0 },
  fitNonce: 0,
  uiHidden: false,
  zonePanel: true,
  ready: false,

  toggle: (layer) => set((s) => ({ layers: { ...s.layers, [layer]: !s.layers[layer] } })),
  selectStage: (id, opts) => {
    // The invariant of select(), the other way round: a highlighted stage never sits above a selected
    // asset outside it (no kiln under "Stage · Packaging & palletising"), nor above a selected vehicle.
    const cur = get();
    const ms = id ? MONITORED_STAGE_BY_ID[id] : null;
    const keepAsset = !ms || !cur.selected || ms.equipment.includes(cur.selected) || ms.conveyors.includes(cur.selected);
    set({ stage: id, ...(keepAsset ? {} : { selected: null }), ...(id && cur.vehicle ? { vehicle: null, follow: false } : {}) });
    if (!id || opts?.frame === false) return;
    const st = MONITORED_STAGE_BY_ID[id];
    // Frame every asset of the stage that has a measured bounding box (the model registers them on load).
    let box: BoundsLike | null = null;
    for (const eq of [...st.equipment, ...st.conveyors]) {
      const b = equipmentBounds.get(eq);
      if (!b || b.isEmpty()) continue;
      box = box
        ? {
            min: { x: Math.min(box.min.x, b.min.x), y: Math.min(box.min.y, b.min.y), z: Math.min(box.min.z, b.min.z) },
            max: { x: Math.max(box.max.x, b.max.x), y: Math.max(box.max.y, b.max.y), z: Math.max(box.max.z, b.max.z) },
          }
        : { min: { ...b.min }, max: { ...b.max } };
    }
    if (box) {
      const shift = focusShift();
      const { pos, target } = focusPose(box, minimapCamera, shift);
      set((s) => ({ camera: { pos, target, nonce: s.camera.nonce + 1 }, zone: st.zone }));
      lastFocus = { id, shift, nonce: get().camera.nonce };
    } else set({ zone: st.zone });
  },
  setAlertFilter: (alertFilter) => set({ alertFilter }),
  // A vehicle belongs to no production stage: selecting one releases the stage highlight (the breadcrumb
  // never shows "Stage · X › FL-02").
  selectVehicle: (id, follow = false) => set({ vehicle: id, follow: id ? follow : false, selected: id ? null : get().selected, ...(id ? { stage: null } : {}) }),
  setFollow: (follow) => set({ follow }),
  select: (id) => {
    // The stage highlight stays only when the selected asset belongs to that stage; otherwise it is
    // cleared, so the breadcrumb never shows the kiln selected under "Stage · Packaging & palletising".
    const cur = get().stage;
    const ms = cur ? MONITORED_STAGE_BY_ID[cur] : null;
    const keepStage = !id || (ms != null && (ms.equipment.includes(id) || ms.conveyors.includes(id)));
    set({ selected: id, vehicle: id ? null : get().vehicle, follow: id ? false : get().follow, ...(keepStage ? {} : { stage: null }) });
    if (id) {
      set({ zone: EQUIPMENT_BY_ID[id].zone });
      get().focusEquipment(id);
    }
  },
  hover: (id) => set({ hovered: id }),
  selectZone: (id) => {
    // Choosing a zone releases the equipment selection and any followed vehicle (the camera would pull back to it).
    set({ zone: id, selected: null, vehicle: null, follow: false });
    // Clearing the zone returns to the overview so the user is never left stranded.
    get().preset(id ? ZONE_BY_ID[id].preset : 'full');
  },
  preset: (id) => set((s) => ({ camera: { ...VIEWS[id], nonce: s.camera.nonce + 1 } })),
  flyTo: (pos, target) => set((s) => ({ camera: { pos, target, nonce: s.camera.nonce + 1 } })),
  focusEquipment: (id) => {
    const box = equipmentBounds.get(id);
    if (!box) return;
    const shift = focusShift();
    const { pos, target } = focusPose(box, minimapCamera, shift);
    set((s) => ({ camera: { pos, target, nonce: s.camera.nonce + 1 } }));
    lastFocus = { id, shift, nonce: get().camera.nonce };
  },
  reset: () => {
    set({ selected: null, zone: null, vehicle: null, follow: false, stage: null });
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
