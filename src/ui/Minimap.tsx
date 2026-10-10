import { useEffect, useState } from 'react';
import { minimapCamera, useTwin } from '../store';
import { simClock, useSim } from '../sim/store';
import { poseAt } from '../sim/logistics';
import {
  FLOW_COLORS,
  FLOW_PATHS,
  HALL,
  LINK,
  PARKING,
  PAVED,
  RAW_SHED,
  ROADS,
  SITE,
  SPRAY_TOWER,
  WAREHOUSE,
  WORKSHOP,
  ZONES,
} from '../data/layout';
import type { Rect } from '../data/types';

/** Drawing width (viewBox units); the panel scales the plan down when space is short. */
const WIDTH = 270;
const BUILDINGS: Rect[] = [HALL.rect, RAW_SHED.rect, WAREHOUSE.rect, WORKSHOP.rect, SPRAY_TOWER.rect, LINK.rect];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Overhead site plan with the camera's position and heading. Click to fly there. */
export function Minimap() {
  const visible = useTwin((s) => s.layers.minimap);
  const activeZone = useTwin((s) => s.zone);
  const selectZone = useTwin((s) => s.selectZone);
  const flyTo = useTwin((s) => s.flyTo);
  const flow = useTwin((s) => s.layers.flow);
  const selectedVehicle = useTwin((s) => s.vehicle);
  const [cam, setCam] = useState({ ...minimapCamera });
  const [vehicles, setVehicles] = useState<{ id: string; x: number; z: number; external: boolean }[]>([]);

  useEffect(() => {
    const id = setInterval(() => {
      setCam({ ...minimapCamera });
      const lg = useSim.getState().sim.logistics;
      setVehicles(
        lg.active.flatMap((vid) => {
          const v = lg.vehicles[vid];
          const p = poseAt(v, simClock.t);
          return p ? [{ id: vid, x: p.x, z: p.z, external: v.class === 'external' }] : [];
        }),
      );
    }, 120);
    return () => clearInterval(id);
  }, []);

  if (!visible) return null;

  const scale = WIDTH / (SITE.x[1] - SITE.x[0]);
  const height = (SITE.z[1] - SITE.z[0]) * scale;
  const mx = (x: number) => (x - SITE.x[0]) * scale;
  const my = (z: number) => (z - SITE.z[0]) * scale;
  const rect = (r: Rect) => ({
    x: mx(r.x[0]),
    y: my(r.z[0]),
    width: (r.x[1] - r.x[0]) * scale,
    height: (r.z[1] - r.z[0]) * scale,
  });
  const heading = Math.atan2(cam.tz - cam.z, cam.tx - cam.x);
  const camX = clamp(mx(cam.x), 4, WIDTH - 4);
  const camY = clamp(my(cam.z), 4, height - 4);

  return (
    <div className="minimap overlay-panel" aria-label="Site plan">
      <div className="mm-h">
        <span>Site plan</span>
        <span className="muted">click to move · zone to select · N ↑</span>
      </div>
      <svg
        width={WIDTH}
        height={height}
        viewBox={`0 0 ${WIDTH} ${height}`}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect();
          const x = SITE.x[0] + ((e.clientX - b.left) / b.width) * (SITE.x[1] - SITE.x[0]);
          const z = SITE.z[0] + ((e.clientY - b.top) / b.height) * (SITE.z[1] - SITE.z[0]);
          flyTo([x + 30, 45, z + 45], [x, 0, z]);
        }}
        role="img"
        aria-label="Overhead site plan"
      >
        <rect x={0} y={0} width={WIDTH} height={height} fill="#24303a" />
        {ROADS.filter((r) => r.z[0] < SITE.z[1]).map((r, i) => (
          <rect key={i} {...rect(r)} fill="#3b4651" />
        ))}
        {[...PAVED, PARKING].map((r, i) => (
          <rect key={'p' + i} {...rect(r)} fill="#33404b" />
        ))}
        {BUILDINGS.map((r, i) => (
          <rect key={'b' + i} {...rect(r)} fill="#4a5864" stroke="#62717e" strokeWidth={0.6} />
        ))}
        {ZONES.map((zone) =>
          zone.rects.map((r, i) => (
            <rect
              key={zone.id + i}
              className="mm-zone"
              {...rect(r)}
              fill={zone.color}
              fillOpacity={activeZone === zone.id ? 0.55 : 0.16}
              stroke={activeZone === zone.id ? '#fff' : 'none'}
              strokeWidth={1}
              style={{ cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation();
                selectZone(zone.id);
              }}
            >
              <title>{`${zone.id} — ${zone.name}`}</title>
            </rect>
          )),
        )}
        {ZONES.map((zone) => (
          <text
            key={'t' + zone.id}
            x={mx(zone.label[0])}
            y={my(zone.label[1]) + 3}
            fontSize={8}
            textAnchor="middle"
            fill="#e8eef3"
            fontWeight={700}
            pointerEvents="none"
          >
            {zone.id}
          </text>
        ))}
        {flow &&
          FLOW_PATHS.map((path, i) => (
            <polyline
              key={'f' + i}
              points={path.pts.map(([x, z]) => `${mx(x)},${my(z)}`).join(' ')}
              fill="none"
              stroke={FLOW_COLORS[path.kind]}
              strokeWidth={1.6}
              strokeDasharray="3 2"
              pointerEvents="none"
            />
          ))}
        {vehicles.map((v) => (
          <circle
            key={v.id}
            cx={mx(v.x)}
            cy={my(v.z)}
            r={v.external ? 2.6 : 1.6}
            fill={v.external ? '#e7ebee' : '#c98500'}
            stroke={v.id === selectedVehicle ? '#79bdd6' : '#0b1116'}
            strokeWidth={v.id === selectedVehicle ? 1.8 : 0.8}
            pointerEvents="none"
          />
        ))}
        <g transform={`translate(${camX} ${camY}) rotate(${(heading * 180) / Math.PI})`} pointerEvents="none">
          <path d="M0 0 L26 -11 L26 11 Z" fill="#2fd0ee" fillOpacity={0.22} />
          <circle r={3.6} fill="#2fd0ee" stroke="#0b1116" strokeWidth={1.2} />
        </g>
      </svg>
    </div>
  );
}
