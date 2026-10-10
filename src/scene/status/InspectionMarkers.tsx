/**
 * Quality inspection points (planarity gauge, optical tunnel, QC bench) with the current
 * reject rate, amber while a quality exception is active. In wide shots, where the three
 * stations sit a few metres apart, they collapse into one line-level marker.
 */
import { useMemo, useRef } from 'react';
import { Html } from '@react-three/drei';
import { ScanLine } from 'lucide-react';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin } from '../../store';
import { sharedQualityStatus, type QualityStatus, type StationId } from './model';
import { topCenter, useBoundsCount, useRelevanceFade } from './shared';

const STATIONS: { equipmentId: string; station: StationId | 'ST-QC'; name: string }[] = [
  { equipmentId: 'I-GAUGE', station: 'ST-GAUGE', name: 'Planarity & caliper gauge' },
  { equipmentId: 'I-VIS', station: 'ST-VIS', name: 'Optical inspection tunnel' },
  { equipmentId: 'I-QC', station: 'ST-QC', name: 'QC laboratory bench' },
];
const IDS = STATIONS.map((s) => s.equipmentId);
/** Camera distance beyond which the stations collapse into one marker. */
const COLLAPSE_AT = 95;

const pct = (r: number | null) => (r == null ? '—' : `${(r * 100).toFixed(1)} %`);

function stationText(q: QualityStatus, station: StationId | 'ST-QC') {
  if (station === 'ST-QC') {
    if (!q.qc) return { value: 'no sample', flagged: false, detail: 'No laboratory sample recorded yet.' };
    const fail = q.qc.result === 'reject';
    return {
      value: fail ? 'retest' : 'sample pass',
      flagged: fail,
      detail: `Last laboratory sample at ${formatClock(q.qc.time)}: ${fail ? 'out of specification, retest requested' : 'within specification'}.`,
    };
  }
  const st = q.stations[station];
  return {
    value: pct(st.rate),
    flagged: st.flagged,
    detail: `Rejected ${pct(st.rate)} of ${Math.round(st.inspected).toLocaleString('en-GB')} tiles inspected since the start of the previous hour.`,
  };
}

export function InspectionMarkers() {
  // Like the zone tags: labels layer, but out of the way of the numbered flow-mode stages.
  const visible = useTwin((s) => s.layers.labels && !s.layers.flow);
  const selected = useTwin((s) => s.selected);
  const q = useSimValue((s) => sharedQualityStatus(s));
  const ready = useBoundsCount(IDS);
  const anchors = useMemo(
    () => STATIONS.map((s) => ({ ...s, at: topCenter(s.equipmentId, 1.2) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready],
  );
  const refs = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)];
  const lineRef = useRef<HTMLButtonElement>(null);
  const vis = anchors[1].at;

  // Near: the three station markers; far: one line-level marker at the vision tunnel.
  useRelevanceFade(
    [
      ...anchors.map((a, i) => ({ el: refs[i], x: a.at?.x ?? 0, z: a.at?.z ?? 0 })),
      { el: lineRef, x: vis?.x ?? 0, z: vis?.z ?? 0 },
    ],
    (i) => i < 3 && anchors[i].equipmentId === selected,
    (i, cam) => {
      const near = vis ? cam.distanceTo(vis) < COLLAPSE_AT : true;
      return (i < 3) === near ? 1 : 0;
    },
  );

  if (!visible) return null;
  const select = (id: string) => useTwin.getState().select(id);
  const scenarioNote = q.scenario ? ' Quality deterioration scenario active.' : '';
  return (
    <>
      {anchors.map((a, i) => {
        if (!a.at) return null;
        const t = stationText(q, a.station);
        return (
          <Html key={a.equipmentId} position={[a.at.x, a.at.y, a.at.z]} center zIndexRange={[7, 0]}>
            <div className="ops-lift">
              <button
                ref={refs[i]}
                className={`ops-chip ${t.flagged ? 'ops-amber' : ''}`}
                onClick={() => select(a.equipmentId)}
                title={`${a.name}. ${t.detail}${t.flagged ? scenarioNote : ''} Simulated inspection records.`}
              >
                <ScanLine size={12} strokeWidth={2.3} aria-hidden />
                Inspection
                <span className="ops-sub num">{t.value}</span>
              </button>
            </div>
          </Html>
        );
      })}
      {vis && (
        <Html position={[vis.x, vis.y + 1.5, vis.z]} center zIndexRange={[7, 0]}>
          <button
            ref={lineRef}
            className={`ops-chip ${q.exception ? 'ops-amber' : ''}`}
            onClick={() => select('I-VIS')}
            title={`Sorting line inspection: ${pct(q.rate)} of tiles rejected since the start of the previous hour.${
              q.exception ? ' Quality exception active.' : ''
            }${scenarioNote} Simulated inspection records.`}
          >
            <ScanLine size={12} strokeWidth={2.3} aria-hidden />
            Inspection
            <span className="ops-sub num">{pct(q.rate)} rejects</span>
          </button>
        </Html>
      )}
    </>
  );
}
