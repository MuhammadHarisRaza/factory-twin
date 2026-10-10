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

/** Shared material palette. Reusing instances keeps draw-call state changes low. */
export const MAT = {
  steel: std('#4b5561', 0.55, 0.5),
  steelLight: std('#8a949f', 0.6, 0.42),
  truss: std('#5d6873', 0.5, 0.5),
  cladding: std('#c9ced3', 0.35, 0.55, { side: DOUBLE }),
  claddingDark: std('#7f8892', 0.3, 0.6, { side: DOUBLE }),
  roof: std('#aab2ba', 0.45, 0.5, { side: DOUBLE }),
  skylight: new MeshPhysicalMaterial({
    color: '#dfe9ef',
    roughness: 0.15,
    transparent: true,
    opacity: 0.45,
    side: DOUBLE,
  }),
  concreteWall: std('#a7a39b', 0.05, 0.9),
  plinth: std('#8d8a84', 0.05, 0.92),
  door: std('#6c7b89', 0.5, 0.45),
  doorFrame: std('#3c454f', 0.5, 0.5),
  glass: new MeshPhysicalMaterial({
    color: '#9fc0d0',
    roughness: 0.08,
    metalness: 0.1,
    transparent: true,
    opacity: 0.35,
  }),
  machine: std('#d4d8dc', 0.3, 0.45),
  machineBlue: std('#2f5d8a', 0.35, 0.45),
  machineDark: std('#3a434d', 0.45, 0.5),
  stainless: std('#c3c8cd', 0.9, 0.28),
  galvanised: std('#a9b0b6', 0.75, 0.4),
  safety: std('#e0b12e', 0.25, 0.5),
  safetyRed: std('#b8332e', 0.25, 0.55),
  rubber: std('#1e2226', 0, 0.85),
  belt: std('#26292d', 0.05, 0.8),
  roller: std('#9aa2aa', 0.8, 0.35),
  insulation: std('#b6b9bc', 0.15, 0.75),
  kilnFrame: std('#59616a', 0.55, 0.45),
  refractory: std('#c9b9a4', 0, 0.9),
  copper: std('#b87333', 0.8, 0.35),
  pipeBlue: std('#3c6e9b', 0.4, 0.45),
  pipeGrey: std('#8e979f', 0.6, 0.4),
  pipeYellow: std('#c9a22b', 0.4, 0.45),
  greenWalk: std('#4f7a5c', 0, 0.9),
  clay: std('#9a6b4f', 0, 1),
  feldspar: std('#d8d0c2', 0, 1),
  sand: std('#c7ab76', 0, 1),
  kaolin: std('#e7e3da', 0, 1),
  redClay: std('#8d4f3a', 0, 1),
  powder: std('#dccdb1', 0, 0.95),
  greenTile: std('#b19f88', 0, 0.8),
  glazedTile: std('#e9e7e1', 0.05, 0.35),
  carton: std('#b0855a', 0, 0.9),
  pallet: std('#8b6a45', 0, 0.95),
  wrap: new MeshPhysicalMaterial({ color: '#d9e4ea', roughness: 0.2, transparent: true, opacity: 0.55 }),
  rackUpright: std('#2f5e9e', 0.4, 0.45),
  rackBeam: std('#e2762d', 0.35, 0.45),
  glowHot: new MeshStandardMaterial({
    color: '#ff9a4a',
    emissive: '#ff5a12',
    emissiveIntensity: 1.6,
    toneMapped: false,
  }),
  lamp: new MeshStandardMaterial({
    color: '#f4f8ff',
    emissive: '#e8f2ff',
    emissiveIntensity: 1.4,
    toneMapped: false,
  }),
  screen: new MeshStandardMaterial({ color: '#0c1a24', emissive: '#1f6e8a', emissiveIntensity: 0.5 }),
  marker: new MeshStandardMaterial({ color: '#36c3d9', emissive: '#1fa8c0', emissiveIntensity: 0.9 }),
  truckCab: std('#e8eaec', 0.4, 0.4),
  truckCabBlue: std('#2d5b8c', 0.4, 0.4),
  trailer: std('#9aa3ab', 0.5, 0.45),
  forklift: std('#e3a826', 0.3, 0.45),
  loader: std('#d9a61e', 0.3, 0.5),
  car: [
    std('#7d8791', 0.6, 0.35),
    std('#e9ebee', 0.6, 0.35),
    std('#2b3138', 0.6, 0.35),
    std('#7b2b2b', 0.6, 0.35),
    std('#3b5a7a', 0.6, 0.35),
  ],
  grass: std('#7f8b68', 0, 1),
  marking: new MeshBasicMaterial({ color: '#e7c330' }),
  markingWhite: new MeshBasicMaterial({ color: '#eef0f2' }),
};

/** Unit geometries shared by every primitive; size comes from mesh scale. */
export const UNIT_BOX = new BoxGeometry(1, 1, 1);
export const UNIT_CYLINDER = new CylinderGeometry(1, 1, 1, 20);
export const UNIT_CYLINDER_LOW = new CylinderGeometry(1, 1, 1, 10);
