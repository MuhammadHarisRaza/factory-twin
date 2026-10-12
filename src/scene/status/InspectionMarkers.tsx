/**
 * Quality inspection points (planarity gauge, optical tunnel, QC bench) with the current
 * reject rate. A station turns amber while a quality exception involves it or an active quality
 * event (src/sim/events.ts) is open at it, and red while one of those events is critical. In wide
 * shots, where the three stations sit a few metres apart, they collapse into one line-level marker.
 * The amber / red alert colouring honours the model's alert filter; the reject rate always shows.
 */
import { useMemo, useRef } from 'react';
import { Html } from '@react-three/drei';
import { ScanLine } from 'lucide-react';
import { useSimValue } from '../../sim/store';
import { formatClock } from '../../sim/time';
import { useTwin, type AlertFilter } from '../../store';
import { useSceneTabIndex } from '../embedded';
import { alertShown } from './alerts';
import { sharedQualityEvents, sharedQualityStatus, type QualityStatus, type StationEvents, type StationId } from './model';
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

const NO_EVENTS: StationEvents = { count: 0, level: null, events: [] };

/**
 * The station's active quality events the alert filter lets through (level recomputed: red for a
 * critical event, amber otherwise). The chip itself is a label and always shows its reject rate.
 */
function filtered(ev: StationEvents, filter: AlertFilter): StationEvents {
  if (filter === 'all') return ev;
  const events = ev.events.filter((e) => alertShown(filter, e.severity));
  return { count: events.length, events, level: events.some((e) => e.severity === 'critical') ? 'red' : events.length ? 'amber' : null };
}

/** Chip colour: red for a critical event, amber for any other event or a flagged exception (a warning, shown only under "all alerts"). */
const chipClass = (flagged: boolean, ev: StationEvents, filter: AlertFilter) =>
  ev.level === 'red' ? 'ops-red' : ev.level === 'amber' || (flagged && filter === 'all') ? 'ops-amber' : '';

const eventsNote = (ev: StationEvents) =>
  ev.count
    ? ` Active quality event${ev.count === 1 ? '' : 's'}: ${ev.events
        .slice(0, 3)
        .map((e) => `${e.id} ${e.title}`)
        .join('; ')}${ev.count > 3 ? `; +${ev.count - 3} more` : ''}.`
    : '';

const eventsCount = (ev: StationEvents) => (ev.count ? ` · ${ev.count} event${ev.count === 1 ? '' : 's'}` : '');

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
  const tabIndex = useSceneTabIndex();
  const filter = useTwin((s) => s.alertFilter);
  const q = useSimValue((s) => sharedQualityStatus(s));
  const all = useSimValue((s) => sharedQualityEvents(s));
  const events = useMemo(() => Object.fromEntries(Object.entries(all).map(([k, v]) => [k, filtered(v, filter)])) as Record<string, StationEvents>, [all, filter]);
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
        const ev = events[a.station] ?? NO_EVENTS;
        return (
          <Html key={a.equipmentId} position={[a.at.x, a.at.y, a.at.z]} center zIndexRange={[7, 0]}>
            <div className="ops-lift">
              <button
                ref={refs[i]}
                className={`ops-chip ${chipClass(t.flagged, ev, filter)}`}
                onClick={() => select(a.equipmentId)}
                tabIndex={tabIndex}
                title={`${a.name}. ${t.detail}${t.flagged ? scenarioNote : ''}${eventsNote(ev)} Simulated inspection records.`}
              >
                <ScanLine size={12} strokeWidth={2.3} aria-hidden />
                Inspection
                <span className="ops-sub num">
                  {t.value}
                  {eventsCount(ev)}
                </span>
              </button>
            </div>
          </Html>
        );
      })}
      {vis && (
        <Html position={[vis.x, vis.y + 1.5, vis.z]} center zIndexRange={[7, 0]}>
          <button
            ref={lineRef}
            className={`ops-chip ${chipClass(q.exception, events.line ?? NO_EVENTS, filter)}`}
            onClick={() => select('I-VIS')}
            tabIndex={tabIndex}
            title={`Sorting line inspection: ${pct(q.rate)} of tiles rejected since the start of the previous hour.${
              q.exception ? ' Quality exception active.' : ''
            }${scenarioNote}${eventsNote(events.line ?? NO_EVENTS)} Simulated inspection records.`}
          >
            <ScanLine size={12} strokeWidth={2.3} aria-hidden />
            Inspection
            <span className="ops-sub num">
              {pct(q.rate)} rejects{eventsCount(events.line ?? NO_EVENTS)}
            </span>
          </button>
        </Html>
      )}
    </>
  );
}
