import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Box3, BoxGeometry, EdgesGeometry, LineBasicMaterial, Vector3, type Group } from 'three';
import { equipmentBounds, useTwin, type LayerId } from '../store';
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { ZONE_BY_ID } from '../data/layout';

const OUTLINE_GEOMETRY = new EdgesGeometry(new BoxGeometry(1, 1, 1));

/** Wireframe box drawn on top of everything around the hovered/selected asset. */
function SelectionOutline({ box, color, pulse }: { box: Box3; color: string; pulse: boolean }) {
  const material = useMemo(
    () => new LineBasicMaterial({ color, transparent: true, depthTest: false, opacity: 0.95 }),
    [color],
  );
  useFrame(({ clock }) => {
    if (pulse) material.opacity = 0.55 + Math.sin(clock.elapsedTime * 4) * 0.4;
  });
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  return (
    <lineSegments
      geometry={OUTLINE_GEOMETRY}
      material={material}
      position={center}
      scale={[size.x + 0.6, size.y + 0.4, size.z + 0.6]}
      renderOrder={10}
    />
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
            <SelectionOutline box={box} color={isSelected ? '#2fd0ee' : '#ffffff'} pulse={isSelected} />
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
