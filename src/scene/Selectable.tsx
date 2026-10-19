import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import { Box3, Vector3, type Group } from 'three';
import { equipmentBounds, useTwin, type LayerId } from '../store';
import { EQUIPMENT_BY_ID } from '../data/equipment';
import { ZONE_BY_ID } from '../data/layout';
import { CONVEYOR_BY_ID } from '../model/plant';
import type { OperationalState } from '../model/types';
import { operationalState } from '../sim/metrics';
import { useSimValue } from '../sim/store';
import { OPERATIONAL_STATE, OP_COLOR_HEX, toneToColor } from '../ui/kit/Status';
import { alertShown, sharedSeverities, stopMarkerSeverity } from './status/alerts';
import { useSceneTabIndex } from './embedded';

/** Operational states that get a status pin above the asset when it is not tagged (conveyors use their own run tags). */
const PINNED: ReadonlySet<OperationalState> = new Set<OperationalState>(['stopped', 'fault', 'planned', 'changeover', 'reduced']);

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

/** The twin's selection accent (also used by the vehicle ring and the planned route). */
const SELECT_COLOR = '#46c4dc';

/**
 * Restrained selection cue: corner brackets drawn over the scene, plus — for the selected asset —
 * a soft floor footprint with a crisp outline, so the selection reads clearly in wide shots and
 * stays distinct from a highlighted production stage (thin dashed outline, no brackets) and the
 * line-constraint marker (grey or amber dashes). Brackets only (thinner, white) on hover.
 */
function SelectionOutline({ box, selected }: { box: Box3; selected: boolean }) {
  const points = useMemo(() => bracketPoints(box), [box]);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const footprint = useMemo(() => {
    const pad = 0.6;
    const y = 0.12;
    return [
      [box.min.x - pad, y, box.min.z - pad],
      [box.max.x + pad, y, box.min.z - pad],
      [box.max.x + pad, y, box.max.z + pad],
      [box.min.x - pad, y, box.max.z + pad],
      [box.min.x - pad, y, box.min.z - pad],
    ] as [number, number, number][];
  }, [box]);
  return (
    <>
      <Line
        points={points}
        segments
        color={selected ? SELECT_COLOR : '#ffffff'}
        lineWidth={selected ? 2.6 : 1.6}
        transparent
        opacity={selected ? 1 : 0.75}
        depthTest={false}
        renderOrder={10}
      />
      {selected && (
        <>
          <mesh position={[center.x, 0.09, center.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={9}>
            <planeGeometry args={[size.x + 1.2, size.z + 1.2]} />
            <meshBasicMaterial color={SELECT_COLOR} transparent opacity={0.18} depthWrite={false} />
          </mesh>
          <Line points={footprint} color={SELECT_COLOR} lineWidth={2} transparent opacity={0.95} renderOrder={9} />
        </>
      )}
    </>
  );
}

/** The state pin above a stopped / held asset; selects it. Out of the tab order while the scene is embedded in a page. */
function StatusPinButton({ id, className, title, children }: { id: string; className: string; title: string; children: ReactNode }) {
  const tabIndex = useSceneTabIndex();
  return (
    <button className={className} onClick={() => useTwin.getState().select(id)} title={title} tabIndex={tabIndex}>
      {children}
    </button>
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
  const statusOn = useTwin((s) => s.layers.status);
  const alertFilter = useTwin((s) => s.alertFilter);
  // Operational state from the shared simulation (process machines and conveyors only): a planned stop
  // is not a fault, and an asset whose data feed is stale is 'unknown' rather than assumed running.
  const state = useSimValue((s) => (s.machines[id] ? operationalState(s, id) : null), [id]);
  // Severity of the stop / state marker (the asset's active stop event, else its state) for the alert filter.
  const markerSeverity = useSimValue((s) => (state ? stopMarkerSeverity(sharedSeverities(s)[id], state) : null), [id, state]);
  const st = state ? OPERATIONAL_STATE[state] : null;
  // Product-wide four-colour scheme (green · amber · red · grey).
  const op = st ? toneToColor(st.tone) : null;
  // Conveyors are marked along their run by the status layer (status/ConveyorStatus.tsx).
  const conveyor = CONVEYOR_BY_ID[id] != null;
  const alertOn = markerSeverity != null && alertShown(alertFilter, markerSeverity);
  const pinned = statusOn && alertOn && !conveyor && state != null && PINNED.has(state);
  const stopped = statusOn && alertOn && !conveyor && (state === 'stopped' || state === 'fault');

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
  // Stable points so drei keeps the outline's geometry and material across renders (finding #36).
  const downPts = useMemo(
    () =>
      box
        ? ([
            [box.min.x - 0.6, 0.1, box.min.z - 0.6],
            [box.max.x + 0.6, 0.1, box.min.z - 0.6],
            [box.max.x + 0.6, 0.1, box.max.z + 0.6],
            [box.min.x - 0.6, 0.1, box.max.z + 0.6],
            [box.min.x - 0.6, 0.1, box.min.z - 0.6],
          ] as [number, number, number][])
        : null,
    [box],
  );
  // Zone tags only for assets near the camera, so a zone view never becomes a wall of labels.
  const tagRef = useRef<HTMLDivElement>(null);
  useFrame(({ camera }) => {
    const el = tagRef.current;
    if (!el || !center) return;
    const near = isSelected || isHovered || camera.position.distanceTo(center) < 42;
    el.style.opacity = near ? '1' : '0';
  });
  const showTag = isSelected || isHovered || (labelsOn && zoneActive);
  const StIcon = st?.icon;

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
              <div ref={tagRef} className={`eq-tag ${isSelected ? 'sel' : ''}`} style={{ transition: 'opacity 0.2s' }}>
                <span className="eq-chip" style={{ background: ZONE_BY_ID[item.zone].color }}>
                  {item.zone}
                </span>
                {item.name}
                {st && StIcon && (
                  <span className={`st status ${st.tone}`}>
                    <StIcon size={11} strokeWidth={2.4} />
                    {st.label}
                  </span>
                )}
              </div>
            </Html>
          )}
          {pinned && !showTag && st && StIcon && (
            <Html position={[center.x, box.max.y + 1.2, center.z]} center zIndexRange={[8, 0]}>
              <StatusPinButton id={id} className={`status-pin status ${st.tone} ops-${op}`} title={`${item.name}: ${st.label}`}>
                <StIcon size={12} strokeWidth={2.4} />
                {st.label}
              </StatusPinButton>
            </Html>
          )}
          {stopped && downPts && (
            <Line
              points={downPts}
              color={OP_COLOR_HEX.red}
              lineWidth={2}
              transparent
              opacity={0.85}
            />
          )}
        </>
      )}
    </>
  );
}
