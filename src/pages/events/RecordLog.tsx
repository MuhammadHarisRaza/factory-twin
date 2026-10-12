/**
 * Underlying record log of Events & Reports (moved from the retired Assets page): the raw records the
 * events are built from — alerts, machine downtime, gate, dock and restricted-zone records, scenario
 * activations — newest first. A secondary, collapsed view: the event list is the primary one.
 * Clicking a row opens the Factory Twin on its subject (the vehicle while on site, else its area).
 */
import { useState } from 'react';
import { openEquipment, openVehicle } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { DOCKS, GEOFENCES, OPS_BY_ID, REASON_BY_CODE, STAGE_BY_ID } from '../../model/plant';
import type { AlertSeverity, RecordSource, ScenarioActivation } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { useSimValue } from '../../sim/store';
import { formatDateTime, formatDuration } from '../../sim/time';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt } from '../../ui/kit/format';
import { Segmented } from '../../ui/kit/Panel';
import { SeverityBadge, SourceTag } from '../../ui/kit/Status';
import { RESTRICTED_FORKLIFT } from '../scenarios/catalogue';

type RecordType = 'alert' | 'downtime' | 'gate' | 'dock' | 'restricted' | 'scenario';
type TypeFilter = RecordType | 'all';

const TYPE_LABEL: Record<RecordType, string> = {
  alert: 'Alert',
  downtime: 'Downtime',
  gate: 'Gate',
  dock: 'Dock',
  restricted: 'Restricted zone',
  scenario: 'Scenario',
};

export type RecordRow = {
  key: string;
  time: number;
  type: RecordType;
  /** Sub-label of the type, e.g. "start" / "end". */
  phase?: string;
  subject: string;
  subjectSub?: string;
  detail: string;
  severity: AlertSeverity;
  source: RecordSource;
  equipmentId?: string;
  vehicleId?: string;
  /** Where to go when the vehicle has left the site. */
  fallback?: string;
};

const LIMIT = 300;
const DOCK_NAME = Object.fromEntries(DOCKS.map((d) => [d.id, d.name]));
const GEOFENCE_NAME = Object.fromEntries(GEOFENCES.map((g) => [g.id, g.name]));
const DOCK_KIND: Record<string, string> = { assigned: 'Dock assigned', docked: 'Docked', 'loading-complete': 'Loading complete', undocked: 'Undocked' };

const downtimeSeverity = (equipmentId: string): AlertSeverity =>
  equipmentId === 'H-KILN' ? 'critical' : OPS_BY_ID[equipmentId]?.stage === 'PRESS' ? 'serious' : 'warning';

/**
 * Where a scenario (and its subject-less alert) is located. A restricted-zone entry follows its
 * forklift while it is on site and otherwise opens the packaging floor beside the hall walkway;
 * yard congestion opens the holding area; only dock scenarios open the dispatch docks.
 */
function scenarioTarget(sc: ScenarioActivation): Pick<RecordRow, 'equipmentId' | 'vehicleId' | 'subject' | 'subjectSub'> {
  if (sc.equipmentId) return { equipmentId: sc.equipmentId, subject: sc.equipmentId, subjectSub: EQUIPMENT_BY_ID[sc.equipmentId]?.name };
  if (sc.stage) {
    const st = STAGE_BY_ID[sc.stage];
    return { equipmentId: st.machines[0], subject: st.name, subjectSub: sc.stage };
  }
  if (sc.kind === 'truck-arrival') return { equipmentId: 'A-GATE', subject: 'Main gate', subjectSub: 'A-GATE' };
  if (sc.kind === 'restricted-entry') {
    const id = sc.vehicleId ?? RESTRICTED_FORKLIFT;
    return { vehicleId: id, equipmentId: 'J-PAL', subject: id, subjectSub: GEOFENCE_NAME['GF-WALK'] ?? 'Hall pedestrian walkway' };
  }
  if (sc.kind === 'yard-congestion') return { equipmentId: 'A-HOLD', subject: 'Holding area', subjectSub: 'A-HOLD' };
  return { equipmentId: 'K-DOCK', subject: sc.dockId ? (DOCK_NAME[sc.dockId] ?? sc.dockId) : 'Dispatch yard', subjectSub: 'K-DOCK' };
}

/** Scenario an alert announces ("Scenario started: <label>"), matched by label and, when possible, start minute. */
function scenarioOfAlert(s: SimState, a: SimState['alerts'][number]): ScenarioActivation | undefined {
  const candidates = s.scenarios.filter((x) => a.title.endsWith(x.label));
  return candidates.find((x) => x.start === a.time) ?? candidates[candidates.length - 1];
}

export function buildRecordLog(s: SimState): RecordRow[] {
  const out: RecordRow[] = [];
  const now = s.minute;
  const vLabel = (id: string) => s.logistics.vehicles[id]?.label ?? id;

  for (const a of s.alerts) {
    // Scenario alerts without a subject (stage or truck scenarios) locate the scenario's own target;
    // only vehicle alerts fall back to the dispatch area (finding #29).
    const sc = !a.equipmentId && a.source === 'scenario' ? scenarioOfAlert(s, a) : undefined;
    const tgt = sc ? scenarioTarget(sc) : null;
    out.push({
      key: a.id,
      time: a.time,
      type: 'alert',
      subject: a.equipmentId ?? (a.vehicleId ? vLabel(a.vehicleId) : (tgt?.subject ?? '—')),
      subjectSub: a.equipmentId ? EQUIPMENT_BY_ID[a.equipmentId]?.name : a.vehicleId ? undefined : tgt?.subjectSub,
      detail: `${a.title} — ${a.detail}`,
      severity: a.severity,
      source: a.source,
      equipmentId: a.equipmentId ?? tgt?.equipmentId,
      vehicleId: a.vehicleId ?? tgt?.vehicleId,
      fallback: a.vehicleId ? 'K-DOCK' : undefined,
    });
  }

  for (const d of s.downtime) {
    if (d.category === 'Starved' || d.category === 'Blocked') continue;
    const r = REASON_BY_CODE[d.reasonCode];
    const base = { subject: d.equipmentId, subjectSub: EQUIPMENT_BY_ID[d.equipmentId]?.name, source: d.source, equipmentId: d.equipmentId, type: 'downtime' as const };
    out.push({ ...base, key: `${d.id}:s`, time: d.start, phase: 'start', detail: `${r.label} (${r.category})`, severity: r.planned ? 'info' : downtimeSeverity(d.equipmentId) });
    if (d.end != null) out.push({ ...base, key: `${d.id}:e`, time: d.end, phase: 'end', detail: `${r.label} · ${formatDuration(d.end - d.start)}`, severity: 'info' });
  }

  for (const g of s.logistics.gateEvents)
    out.push({
      key: g.id,
      time: g.time,
      type: 'gate',
      phase: g.direction === 'in' ? 'in' : 'out',
      subject: vLabel(g.vehicleId),
      subjectSub: g.vehicleId,
      detail: g.direction === 'in' ? 'Gate entry' : 'Gate exit',
      severity: 'info',
      source: g.source,
      vehicleId: g.vehicleId,
      fallback: 'A-GATE',
    });

  for (const e of s.logistics.dockEvents)
    out.push({
      key: e.id,
      time: e.time,
      type: 'dock',
      subject: vLabel(e.vehicleId),
      subjectSub: e.vehicleId,
      detail: `${DOCK_NAME[e.dockId] ?? e.dockId} · ${DOCK_KIND[e.kind] ?? e.kind}`,
      severity: 'info',
      source: e.source,
      vehicleId: e.vehicleId,
      fallback: 'K-DOCK',
    });

  for (const e of s.logistics.restrictedEvents)
    out.push({
      key: e.id,
      time: e.time,
      type: 'restricted',
      subject: vLabel(e.vehicleId),
      subjectSub: e.vehicleId,
      detail: `${GEOFENCE_NAME[e.geofenceId] ?? e.geofenceId} · ${formatDuration(e.durationMin)} inside`,
      severity: 'warning',
      source: e.source,
      vehicleId: e.vehicleId,
    });

  for (const sc of s.scenarios) {
    const tgt = scenarioTarget(sc);
    out.push({ ...tgt, key: `${sc.id}:s`, time: sc.start, type: 'scenario', phase: 'start', detail: `Activated: ${sc.label}`, severity: 'info', source: 'scenario' });
    if (sc.end != null && sc.end <= now)
      out.push({ ...tgt, key: `${sc.id}:e`, time: sc.end, type: 'scenario', phase: 'end', detail: `Ended: ${sc.label}`, severity: 'info', source: 'scenario' });
  }

  return out.sort((a, b) => b.time - a.time || (a.key < b.key ? 1 : -1));
}

/** What a row click opens: its vehicle while on site, else its equipment, else the area it left from. */
export function recordTarget(r: RecordRow, active: Set<string>): { type: 'vehicle' | 'equipment'; id: string } | null {
  if (r.vehicleId && active.has(r.vehicleId)) return { type: 'vehicle', id: r.vehicleId };
  if (r.equipmentId) return { type: 'equipment', id: r.equipmentId };
  if (r.fallback) return { type: 'equipment', id: r.fallback };
  return null;
}

export function RecordLog() {
  const [type, setType] = useState<TypeFilter>('all');
  const { rows, total, active } = useSimValue(
    (s) => {
      const all = buildRecordLog(s);
      const matching = type === 'all' ? all : all.filter((r) => r.type === type);
      return { rows: matching.slice(0, LIMIT), total: matching.length, active: new Set(s.logistics.active) };
    },
    [type],
  );

  const navigate = (r: RecordRow) => {
    const t = recordTarget(r, active);
    if (t?.type === 'vehicle') openVehicle(t.id);
    else if (t) openEquipment(t.id);
  };

  const columns: Column<RecordRow>[] = [
    { key: 'time', header: 'Time', render: (r) => formatDateTime(r.time), sort: (r) => r.time },
    {
      key: 'type',
      header: 'Record',
      render: (r) => (
        <>
          {TYPE_LABEL[r.type]}
          {r.phase && <span className="sub">{r.phase}</span>}
        </>
      ),
      sort: (r) => r.type,
    },
    {
      key: 'subject',
      header: 'Subject',
      render: (r) => (
        <>
          <span className={r.equipmentId && r.subject === r.equipmentId ? 'mono' : undefined}>{r.subject}</span>
          {r.subjectSub && <span className="sub">{r.subjectSub}</span>}
        </>
      ),
      sort: (r) => r.subject,
    },
    { key: 'detail', header: 'Detail', render: (r) => <span title={r.detail}>{r.detail}</span> },
    {
      key: 'sev',
      header: 'Severity',
      render: (r) => <SeverityBadge severity={r.severity} />,
      sort: (r) => ['info', 'warning', 'serious', 'critical'].indexOf(r.severity),
    },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.source} /> },
  ];

  return (
    <div className="evp-log">
      <div className="evp-log-h">
        <Segmented<TypeFilter>
          label="Record type"
          value={type}
          onChange={setType}
          options={[{ value: 'all', label: 'All' }, ...(Object.keys(TYPE_LABEL) as RecordType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))]}
        />
        <span className="muted">
          {fmtInt(total)} records · newest first{total > LIMIT ? ` · showing the latest ${LIMIT}` : ''} · click a row to locate it in the Factory Twin
        </span>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.key} onRowClick={navigate} maxHeight={460} empty="No records of this type yet" />
      <p className="evp-log-f">
        Downtime lists machine stops and planned stops; starved / blocked spells are analysed in Production. Vehicles that have left the site open the gate or dock area.
      </p>
    </div>
  );
}
