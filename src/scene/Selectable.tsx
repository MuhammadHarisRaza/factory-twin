import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { type ThreeEvent } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { Box3, Vector3, type Group } from 'three';
import { equipmentBounds, useTwin, type LayerId } from '../store';
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { ZONE_BY_ID } from '../data/layout';

/** Corner-bracket segments (3 short edges per box corner) around a box. */
function bracketPoints(box: Box3) {
  const { min, max } = box;
  const pad = 0.3;
  const lo = new Vector3(min.x - pad, Math.max(0.05, min.y - 0.1), min.z - pad);
  const hi = new Vector3(max.x + pad, max.y + 0.2, max.z + pad);
  const size = hi.clone().sub(lo);
  const arm = (axisLen: number) => Math.min(1.6, axisLen * 0.22);
  const pts: [number, number, number][] = [];
  for (const cx of [0, 1])
    for (const cy of [0, 1])
      for (const cz of [0, 1]) {
        const c = new Vector3(cx ? hi.x : lo.x, cy ? hi.y : lo.y, cz ? hi.z : lo.z);
        const sx = cx ? -1 : 1;
        const sy = cy ? -1 : 1;
        const sz = cz ? -1 : 1;
        pts.push(c.toArray(), [c.x + sx * arm(size.x), c.y, c.z]);
        pts.push(c.toArray(), [c.x, c.y + sy * arm(size.y), c.z]);
        pts.push(c.toArray(), [c.x, c.y, c.z + sz * arm(size.z)]);
      }
  return pts;
}

/**
 * Restrained selection cue: corner brackets drawn over the scene plus a soft floor
 * footprint for the selected asset; brackets only (thinner, white) on hover.
 */
function SelectionOutline({ box, selected }: { box: Box3; selected: boolean }) {
  const points = useMemo(() => bracketPoints(box), [box]);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  return (
    <>
      <Line
        points={points}
        segments
        color={selected ? '#46c4dc' : '#ffffff'}
        lineWidth={selected ? 2.4 : 1.6}
        transparent
        opacity={selected ? 0.95 : 0.75}
        depthTest={false}
        renderOrder={10}
      />
      {selected && (
        <mesh position={[center.x, 0.09, center.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={9}>
          <planeGeometry args={[size.x + 1.2, size.z + 1.2]} />
          <meshBasicMaterial color="#46c4dc" transparent opacity={0.14} depthWrite={false} />
        </mesh>
      )}
    </>
  );
}

/**
 * Wraps the geometry of one equipment item. Measures it once, registers its
 * bounds for camera focus, and adds an invisible hit box, hover/selection
 * outline and a floating name tag.
 */
export function Selectable({
  id,
  children,
  layer = 'equipment',
}: {
  id: string;
  children: ReactNode;
  /** Clicks are ignored while this layer is hidden; null = always clickable. */
  layer?: LayerId | null;
}) {
  const ref = useRef<Group>(null);
  const [box, setBox] = useState<Box3 | null>(null);
  const isSelected = useTwin((s) => s.selected === id);
  const isHovered = useTwin((s) => s.hovered === id);
  const item = EQUIPMENT_BY_ID[id];
  const zoneActive = useTwin((s) => s.zone === item.zone);
  const labelsOn = useTwin((s) => s.layers.labels);

  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.updateWorldMatrix(true, true);
    const b = new Box3().setFromObject(ref.current);
    equipmentBounds.set(id, b);
    setBox(b);
  }, [id]);

  const handlers = {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      const s = useTwin.getState();
      if (layer && !s.layers[layer]) return;
      e.stopPropagation();
      s.hover(id);
      document.body.style.cursor = 'pointer';
    },
    onPointerOut: () => {
      const s = useTwin.getState();
      if (s.hovered === id) s.hover(null);
      document.body.style.cursor = '';
    },
    onClick: (e: ThreeEvent<MouseEvent>) => {
      const s = useTwin.getState();
      if (layer && !s.layers[layer]) return;
      e.stopPropagation();
      // Ignore clicks that were really the end of an orbit drag.
      if (e.delta > 6) return;
      s.select(id);
    },
  };

  const center = box?.getCenter(new Vector3());
  const size = box?.getSize(new Vector3());
  const showTag = isSelected || isHovered || (labelsOn && zoneActive);

  return (
    <>
      <group ref={ref}>{children}</group>
      {box && center && size && (
        <>
          <mesh position={center} scale={[size.x + 0.4, size.y + 0.4, size.z + 0.4]} visible={false} {...handlers}>
            <boxGeometry />
          </mesh>
          {(isSelected || isHovered) && (
            <SelectionOutline box={box} selected={isSelected} />
          )}
          {showTag && (
            <Html
              position={[center.x, box.max.y + 1.2, center.z]}
              center
              zIndexRange={[9, 0]}
              style={{ pointerEvents: 'none' }}
            >
              <div className={`eq-tag ${isSelected ? 'sel' : ''}`}>
                <span className="eq-chip" style={{ background: ZONE_BY_ID[item.zone].color }}>
                  {item.zone}
                </span>
                {item.name}
              </div>
            </Html>
          )}
        </>
      )}
    </>
  );
}
