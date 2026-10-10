import { useMemo } from 'react';
import { HALL, HALL_FRAMES, SPRAY_TOWER } from '../data/layout';
import type { Vec2 } from '../data/types';
import { useTwin } from '../store';
import { BUILDING_FRAMES, type BuildingFrame } from './buildings/frames';
import { MAT } from './materials';
import { Instances, type Instance } from './primitives';

/** Square-section member in the y/z plane at `x`, from `a` to `b` (each [z, y]). */
function member(x: number, a: Vec2, b: Vec2, size: number): Instance {
  const [z0, y0] = a;
  const [z1, y1] = b;
  const len = Math.hypot(z1 - z0, y1 - y0);
  return {
    p: [x, (y0 + y1) / 2, (z0 + z1) / 2],
    s: [size, size, len],
    r: [-Math.atan2(y1 - y0, z1 - z0), 0, 0],
  };
}

/** Columns, rafters / lattice trusses and purlins of one portal-framed building. */
function frameMembers(b: BuildingFrame) {
  const cols: Instance[] = [];
  const members: Instance[] = [];
  const purlins: Instance[] = [];
  const bases: Instance[] = [];
  const eaves: Instance[] = [];
  const columnLines = [...new Set(b.spans.flat())];
  const { x } = b.rect;
  const length = x[1] - x[0];
  const cx = (x[0] + x[1]) / 2;

  for (const fx of b.frames) {
    for (const z of columnLines) {
      // Universal-column I-section: web in the frame plane, flanges either side.
      cols.push({ p: [fx, b.eave / 2, z], s: [0.04, b.eave, 0.42] });
      for (const f of [-0.2, 0.2]) cols.push({ p: [fx, b.eave / 2, z + f], s: [0.32, b.eave, 0.04] });
      bases.push({ p: [fx, 0.05, z], s: [0.7, 0.1, 0.7] });
      // Knee braces from the column into the rafter / bottom chord.
      for (const dir of [-1, 1]) {
        if ((dir < 0 && z === columnLines[0]) || (dir > 0 && z === columnLines[columnLines.length - 1])) continue;
        members.push(member(fx, [z, b.eave - 2.6], [z + dir * 1.8, b.eave - 0.3], 0.14));
      }
    }
    for (const [z0, z1] of b.spans) {
      const ridgeZ = (z0 + z1) / 2;
      const ridgeY = b.eave + b.rise;
      members.push(member(fx, [z0, b.eave], [ridgeZ, ridgeY], 0.35));
      members.push(member(fx, [ridgeZ, ridgeY], [z1, b.eave], 0.35));
      if (b.trussed) {
        const chordY = b.eave - 1.6;
        members.push(member(fx, [z0, chordY], [z1, chordY], 0.22));
        for (let i = 0; i <= 8; i++) {
          const z = z0 + ((z1 - z0) * i) / 8;
          const top = b.eave + b.rise * (1 - Math.abs(z - ridgeZ) / ((z1 - z0) / 2));
          // Vertical web
          members.push(member(fx, [z, chordY], [z, top], 0.12));
          if (i < 8) {
            const zNext = z0 + ((z1 - z0) * (i + 1)) / 8;
            const topNext = b.eave + b.rise * (1 - Math.abs(zNext - ridgeZ) / ((z1 - z0) / 2));
            // Diagonal web, sloping up towards the ridge
            members.push(
              i < 4
                ? member(fx, [z, chordY], [zNext, topNext], 0.1)
                : member(fx, [z, top], [zNext, chordY], 0.1),
            );
          }
        }
      }
    }
  }

  for (const [z0, z1] of b.spans) {
    const ridgeZ = (z0 + z1) / 2;
    for (let i = 0; i <= 3; i++) {
      for (const side of [-1, 1]) {
        const t = i / 3;
        const z = side < 0 ? z0 + (ridgeZ - z0) * t : z1 - (z1 - ridgeZ) * t;
        const y = b.eave + b.rise * t + 0.15;
        purlins.push({ p: [cx, y, z], s: [length, 0.12, 0.08] });
      }
    }
  }
  // Eave beams tie the frames together along each column line.
  for (const z of columnLines) eaves.push({ p: [cx, b.eave - 0.2, z], s: [length, 0.4, 0.25] });
  // Wind bracing in the end bays, on the closed north wall line only so the
  // cut-away south side stays unobstructed.
  for (const z of [columnLines[0]])
    for (const [xa, xb] of [
      [b.frames[0], b.frames[1]],
      [b.frames[b.frames.length - 2], b.frames[b.frames.length - 1]],
    ]) {
      const len = Math.hypot(xb - xa, b.eave - 1);
      const ang = Math.atan2(b.eave - 1, xb - xa);
      for (const sgn of [1, -1])
        eaves.push({ p: [(xa + xb) / 2, (b.eave + 1) / 2, z], s: [len, 0.07, 0.07], r: [0, 0, sgn * ang] });
    }

  return { cols, members, purlins, bases, eaves };
}

/** Steel frame of the spray-dryer tower: columns, ring beams, access decks and a stair stringer. */
function sprayTowerMembers() {
  const { x, z } = SPRAY_TOWER.rect;
  const h = SPRAY_TOWER.height;
  const xs = [x[0], (x[0] + x[1]) / 2, x[1]];
  const zs = [z[0], (z[0] + z[1]) / 2, z[1]];
  const cols: Instance[] = [];
  const beams: Instance[] = [];
  const decks: Instance[] = [];

  for (const cx of xs)
    for (const cz of zs) {
      // No column in the middle, where the dryer chamber stands.
      if (cx !== xs[1] || cz !== zs[1]) cols.push({ p: [cx, h / 2, cz], s: [0.5, h, 0.5] });
    }

  for (const y of [8, 16, 24, h]) {
    for (const bz of [z[0], z[1]]) beams.push({ p: [(x[0] + x[1]) / 2, y, bz], s: [x[1] - x[0], 0.45, 0.3] });
    for (const bx of [x[0], x[1]]) beams.push({ p: [bx, y, (z[0] + z[1]) / 2], s: [0.3, 0.45, z[1] - z[0]] });
    if (y < h) {
      decks.push({ p: [(x[0] + x[1]) / 2, y + 0.25, z[0] + 2], s: [x[1] - x[0] - 0.6, 0.06, 3.4] });
      decks.push({ p: [(x[0] + x[1]) / 2, y + 0.25, z[1] - 2], s: [x[1] - x[0] - 0.6, 0.06, 3.4] });
    }
  }

  for (let i = 0; i < 3; i++) {
    const y0 = 8 * i + 0.5;
    const y1 = 8 * (i + 1);
    const len = Math.hypot(z[1] - z[0], y1 - y0) / 2;
    beams.push({
      p: [x[1], (y0 + y1) / 2, (z[0] * 3 + z[1]) / 4],
      s: [0.16, 0.16, len],
      r: [-Math.atan2(y1 - y0, (z[1] - z[0]) / 2), 0, 0],
    });
  }

  return { cols, beams, decks };
}

/**
 * Building services hung from the hall trusses: cable-tray runs along both process
 * lines (with drop rods at every frame) and a grid of high-bay luminaires.
 */
function hallServices() {
  const trays: Instance[] = [];
  const rods: Instance[] = [];
  const housings: Instance[] = [];
  const lenses: Instance[] = [];
  const x0 = HALL.rect.x[0] + 2;
  const x1 = HALL.rect.x[1] - 2;
  for (const z of [-5.5, 8.5]) {
    const y = 8.4;
    trays.push({ p: [(x0 + x1) / 2, y, z], s: [x1 - x0, 0.08, 0.6] });
    for (const side of [-0.3, 0.3]) trays.push({ p: [(x0 + x1) / 2, y + 0.08, z + side], s: [x1 - x0, 0.16, 0.03] });
    for (const fx of HALL_FRAMES)
      if (fx > x0 && fx < x1)
        for (const side of [-0.32, 0.32]) rods.push({ p: [fx, (y + 10.4) / 2, z + side], s: [0.03, 10.4 - y, 0.03] });
  }
  for (let x = HALL.rect.x[0] + 7.6; x < HALL.rect.x[1]; x += 15.2)
    for (const z of [-22, -8, 8, 22]) {
      housings.push({ p: [x, 9.95, z], s: [0.32, 0.35, 0.32] });
      lenses.push({ p: [x, 9.76, z], s: [0.3, 0.03, 0.3] });
    }
  return { trays, rods, housings, lenses };
}

/** All primary steelwork, instanced per material; follows the structure layer. */
export function Structure() {
  const visible = useTwin((s) => s.layers.structure);
  const roofOn = useTwin((s) => s.layers.roof);
  const parts = useMemo(() => {
    const frames = BUILDING_FRAMES.map(frameMembers);
    const tower = sprayTowerMembers();
    return {
      cols: [...frames.flatMap((f) => f.cols), ...tower.cols],
      members: [...frames.flatMap((f) => f.members), ...tower.beams],
      purlins: frames.flatMap((f) => f.purlins),
      bases: frames.flatMap((f) => f.bases),
      eaves: frames.flatMap((f) => f.eaves),
      decks: tower.decks,
      services: hallServices(),
    };
  }, []);
  return (
    <group visible={visible}>
      <Instances items={parts.cols} m={MAT.steel} />
      <Instances items={parts.members} m={MAT.truss} />
      <Instances items={parts.eaves} m={MAT.truss} cast={false} />
      <Instances items={parts.bases} m={MAT.concreteWall} cast={false} />
      {/* Purlins and luminaires hang from the roof build-up: hidden with the roof so the cutaway stays clean. */}
      <group visible={roofOn}>
        <Instances items={parts.purlins} m={MAT.steelLight} cast={false} />
        <Instances items={parts.services.housings} m={MAT.machineDark} cyl cast={false} />
        <Instances items={parts.services.lenses} m={MAT.lamp} cyl cast={false} />
      </group>
      <Instances items={parts.decks} m={MAT.galvanised} />
      <Instances items={parts.services.trays} m={MAT.cableTray} cast={false} />
      <Instances items={parts.services.rods} m={MAT.cableTray} cast={false} />
    </group>
  );
}
