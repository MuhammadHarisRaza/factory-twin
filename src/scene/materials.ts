import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type MeshStandardMaterialParameters,
} from 'three';

/** Park–Miller PRNG so procedural textures look the same on every load. */
export function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** Deterministic 0–1 hash of any values (FNV-1a + murmur finaliser). */
export function hash01(...parts: unknown[]) {
  let h = 2166136261;
  for (const part of parts) {
    const str = String(part);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 40503;
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 1540483477);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  repeat: [number, number],
) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(...repeat);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Flat base colour sprinkled with light/dark speckles. */
function speckle(
  ctx: CanvasRenderingContext2D,
  size: number,
  rgb: [number, number, number],
  contrast: number,
  count: number,
  seed: number,
) {
  ctx.fillStyle = `rgb(${rgb.join(',')})`;
  ctx.fillRect(0, 0, size, size);
  const rand = seededRandom(seed);
  for (let i = 0; i < count; i++) {
    const v = (rand() - 0.5) * contrast;
    const c = v > 0 ? 255 : 0;
    ctx.fillStyle = `rgba(${c},${c},${c},${Math.abs(v) / 255})`;
    const dot = 1 + rand() * 3;
    ctx.fillRect(rand() * size, rand() * size, dot, dot);
  }
}

/** Concrete slab with stains and saw-cut joints. */
export const concreteTexture = () =>
  canvasTexture(
    512,
    (ctx, size) => {
      speckle(ctx, size, [182, 184, 182], 34, 26000, 7);
      const rand = seededRandom(11);
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = `rgba(120,118,112,${0.03 + rand() * 0.05})`;
        ctx.beginPath();
        ctx.ellipse(rand() * size, rand() * size, 20 + rand() * 60, 10 + rand() * 40, rand() * 3, 0, 7);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(90,92,94,0.55)';
      ctx.lineWidth = 1.5;
      for (const v of [0, size / 2]) {
        ctx.beginPath();
        ctx.moveTo(v, 0);
        ctx.lineTo(v, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, v);
        ctx.lineTo(size, v);
        ctx.stroke();
      }
    },
    [1, 1],
  );

/**
 * Sealed factory floor covering 24 × 24 m: fine aggregate speckle, broad trowel mottling,
 * faint wheel tracks and saw-cut joints on a 6 m grid.
 */
export const floorTexture = () =>
  canvasTexture(
    1024,
    (ctx, size) => {
      speckle(ctx, size, [186, 187, 183], 26, 60000, 17);
      const rand = seededRandom(23);
      for (let i = 0; i < 90; i++) {
        const light = rand() > 0.5;
        ctx.fillStyle = light ? `rgba(214,214,208,${0.04 + rand() * 0.05})` : `rgba(120,118,110,${0.03 + rand() * 0.05})`;
        ctx.beginPath();
        ctx.ellipse(rand() * size, rand() * size, 40 + rand() * 160, 20 + rand() * 90, rand() * 3, 0, 7);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(70,70,68,0.06)';
      for (let i = 0; i < 14; i++) {
        ctx.lineWidth = 6 + rand() * 6;
        const y = rand() * size;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(size * 0.3, y + (rand() - 0.5) * 80, size * 0.7, y + (rand() - 0.5) * 80, size, y);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(88,90,92,0.5)';
      ctx.lineWidth = 1.4;
      for (let k = 0; k < 4; k++) {
        const v = (k * size) / 4;
        ctx.beginPath();
        ctx.moveTo(v, 0);
        ctx.lineTo(v, size);
        ctx.moveTo(0, v);
        ctx.lineTo(size, v);
        ctx.stroke();
      }
    },
    [1, 1],
  );

export const asphaltTexture = () =>
  canvasTexture(256, (ctx, size) => speckle(ctx, size, [70, 73, 77], 40, 9000, 3), [1, 1]);

export const grassTexture = () =>
  canvasTexture(
    256,
    (ctx, size) => {
      speckle(ctx, size, [118, 128, 98], 46, 9000, 5);
      const rand = seededRandom(9);
      for (let i = 0; i < 60; i++) {
        ctx.fillStyle = `rgba(140,128,96,${0.08 + rand() * 0.1})`;
        ctx.beginPath();
        ctx.arc(rand() * size, rand() * size, 6 + rand() * 22, 0, 7);
        ctx.fill();
      }
    },
    [1, 1],
  );

/** Soft radial gradient used as a fake contact shadow under machines (shared). */
export const blobShadowTexture = (() => {
  let tex: CanvasTexture | null = null;
  return () => {
    if (tex) return tex;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    tex = new CanvasTexture(canvas);
    return tex;
  };
})();

const std = (
  color: string,
  metalness: number,
  roughness: number,
  extra: MeshStandardMaterialParameters = {},
) => new MeshStandardMaterial({ color, metalness, roughness, ...extra });

const DOUBLE = 2; // THREE.DoubleSide

/**
 * Shared material palette. Reusing instances keeps draw-call state changes low.
 *
 * Colours follow a restrained industrial scheme: light-grey machine casings (≈RAL 7035),
 * muted blue / green accents for drives and guarding, painted (non-metallic) structural
 * steel, real metals only where metal is bare (stainless, galvanised, rollers).
 */
export const MAT = {
  // Structure and envelope
  steel: std('#4a525b', 0.3, 0.6),
  steelLight: std('#8d959c', 0.35, 0.5),
  truss: std('#59636d', 0.3, 0.58),
  cladding: std('#d2d5d5', 0.15, 0.68, { side: DOUBLE }),
  claddingDark: std('#6c747c', 0.15, 0.65, { side: DOUBLE }),
  roof: std('#b2b7bb', 0.3, 0.55, { side: DOUBLE }),
  skylight: new MeshPhysicalMaterial({
    color: '#e3ecf0',
    roughness: 0.2,
    transparent: true,
    opacity: 0.4,
    side: DOUBLE,
  }),
  concreteWall: std('#aaa69e', 0.02, 0.9),
  plinth: std('#8f8c86', 0.02, 0.92),
  door: std('#76838f', 0.3, 0.5),
  doorFrame: std('#3c434b', 0.3, 0.55),
  glass: new MeshPhysicalMaterial({
    color: '#a9c4d0',
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity: 0.32,
  }),
  /** Tinted curtain-wall glazing for offices (reflective, opaque). */
  curtainGlass: std('#40525e', 0.55, 0.16),
  /** Clear polycarbonate machine guarding / inspection windows. */
  polycarbonate: new MeshPhysicalMaterial({
    color: '#d3e2e8',
    roughness: 0.12,
    transparent: true,
    opacity: 0.22,
    side: DOUBLE,
    depthWrite: false,
  }),

  // Machinery
  machine: std('#d9dad5', 0.12, 0.5),
  machineBlue: std('#3f5d79', 0.15, 0.5),
  machineGreen: std('#4d6b5e', 0.12, 0.55),
  machineDark: std('#3a4046', 0.2, 0.55),
  stainless: std('#c5c9cc', 0.9, 0.3),
  galvanised: std('#a7aeb3', 0.7, 0.42),
  /** Hot-dip galvanised cable trays and ladders. */
  cableTray: std('#99a1a6', 0.65, 0.45),
  /** Spiral ducting and sheet-metal hoods. */
  duct: std('#b4babe', 0.6, 0.4),
  safety: std('#d4a52c', 0.1, 0.55),
  safetyRed: std('#a5352f', 0.1, 0.58),
  rubber: std('#1e2226', 0, 0.85),
  belt: std('#26292d', 0.05, 0.8),
  roller: std('#9aa2aa', 0.8, 0.35),
  insulation: std('#cac8c1', 0.05, 0.82),
  kilnFrame: std('#59616a', 0.3, 0.55),
  /** Painted kiln casing panels. */
  kilnShell: std('#8e9399', 0.2, 0.6),
  refractory: std('#c9b9a4', 0, 0.9),
  copper: std('#b07038', 0.8, 0.38),
  pipeBlue: std('#4a6c8c', 0.2, 0.5),
  pipeGrey: std('#8f979e', 0.5, 0.45),
  pipeYellow: std('#c29a2e', 0.15, 0.5),
  greenWalk: std('#557a62', 0, 0.9),

  // Materials in process
  clay: std('#9a6b4f', 0, 1),
  feldspar: std('#d8d0c2', 0, 1),
  sand: std('#c7ab76', 0, 1),
  kaolin: std('#e7e3da', 0, 1),
  redClay: std('#8d4f3a', 0, 1),
  powder: std('#dccdb1', 0, 0.95),
  greenTile: std('#b19f88', 0, 0.8),
  glazedTile: std('#e9e7e1', 0.05, 0.35),
  carton: std('#b38a60', 0, 0.9),
  pallet: std('#8b6a45', 0, 0.95),
  wrap: new MeshPhysicalMaterial({ color: '#d9e4ea', roughness: 0.2, transparent: true, opacity: 0.5 }),
  rackUpright: std('#38597a', 0.2, 0.5),
  rackBeam: std('#cc7434', 0.15, 0.5),

  // Emissive accents (kept deliberately subtle)
  glowHot: new MeshStandardMaterial({
    color: '#ff9a4a',
    emissive: '#ff5a12',
    emissiveIntensity: 1.2,
    toneMapped: false,
  }),
  lamp: new MeshStandardMaterial({
    color: '#f4f8ff',
    emissive: '#e8f2ff',
    emissiveIntensity: 1.1,
    toneMapped: false,
  }),
  screen: new MeshStandardMaterial({ color: '#0c1a24', emissive: '#2a6c84', emissiveIntensity: 0.35 }),
  marker: new MeshStandardMaterial({ color: '#7fa6b4', emissive: '#3c7f92', emissiveIntensity: 0.3 }),

  // Vehicles and site
  truckCab: std('#e8eaec', 0.3, 0.42),
  truckCabBlue: std('#35587a', 0.3, 0.42),
  trailer: std('#9aa3ab', 0.4, 0.48),
  forklift: std('#d6a128', 0.15, 0.5),
  loader: std('#cf9f28', 0.15, 0.55),
  car: [
    std('#7d8791', 0.6, 0.35),
    std('#e9ebee', 0.6, 0.35),
    std('#2b3138', 0.6, 0.35),
    std('#6e2e2e', 0.6, 0.35),
    std('#3b5a7a', 0.6, 0.35),
  ],
  grass: std('#7f8b68', 0, 1),
  marking: new MeshBasicMaterial({ color: '#d9b938' }),
  markingWhite: new MeshBasicMaterial({ color: '#e8eaec' }),
};

/** Unit geometries shared by every primitive; size comes from mesh scale. */
export const UNIT_BOX = new BoxGeometry(1, 1, 1);
export const UNIT_CYLINDER = new CylinderGeometry(1, 1, 1, 20);
export const UNIT_CYLINDER_LOW = new CylinderGeometry(1, 1, 1, 10);
