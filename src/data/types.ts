export type Range = [number, number];
/** Axis-aligned rectangle on the ground plane (metres). */
export type Rect = { x: Range; z: Range };
export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type PresetId =
  | 'full'
  | 'hall'
  | 'raw'
  | 'pressglaze'
  | 'kiln'
  | 'sorting'
  | 'packaging'
  | 'warehouse'
  | 'utilities'
  | 'site';

export type CameraView = { label: string; pos: Vec3; target: Vec3 };

export type Zone = {
  id: string;
  name: string;
  short: string;
  stage: string;
  color: string;
  rects: Rect[];
  /** Ground position of the zone tag. */
  label: Vec2;
  preset: PresetId;
  summary: string;
};

export type Equipment = {
  id: string;
  name: string;
  zone: string;
  stage: string;
  description: string;
  upstream: string[];
  downstream: string[];
};

export type FlowKind = 'raw' | 'intermediate' | 'finished';
export type FlowPath = { kind: FlowKind; y: number; pts: Vec2[] };
export type FlowStage = { n: number; label: string; at: Vec2 };
