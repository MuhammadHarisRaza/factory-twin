import { useEffect } from 'react';
import { FileText, MapPin, X } from 'lucide-react';
import { openEquipment, openEvent, useApp } from '../../app/store';
import { CONVEYOR_BY_ID, M2_PER_TILE, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { DowntimeEvent } from '../../model/types';
import { conveyorMetrics, downtimeIn, machineMetrics, operationalState, resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { ColumnChart, TipRow } from '../../ui/kit/charts';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { MetricText, OperationalStatus, SourceTag } from '../../ui/kit/Status';
import { assetName, m2 } from './common';
import { granularityFor, machineLoss, machineTrend, reasonLabel } from './derive';
import { assetEvents, consequenceEvents } from './equipment';
import { contributionParts, equipmentContribution, lossLedger } from './loss';

type EvRow = { ev: DowntimeEvent };

/**
 * Equipment drill-down (process machine or conveyor): current state, its figures for the period,
 * its share of the line loss at the constraint, the events that contributed (→ event report) and
 * the way to the 3D twin.
 */
export function EquipmentDrawer({ id, periodKey, onClose }: { id: string; periodKey: PeriodKey; onClose: () => void }) {
  const finance = useApp((s) => s.finance);
  const tariffs = useApp((s) => s.tariffs);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const conveyor = CONVEYOR_BY_ID[id];
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const g = granularityFor(p);
      const L = lossLedger(s, p, finance, tariffs);
      const contribution = equipmentContribution(s, p, L).find((c) => c.equipmentId === id) ?? null;
      const own = assetEvents(s, id, p);
      const downtime: EvRow[] = downtimeIn(s, p)
        .filter((e) => e.equipmentId === id)
        .sort((a, b) => (a.end == null ? 0 : 1) - (b.end == null ? 0 : 1) || b.start - a.start)
        .map((ev) => ({ ev }));
      return {
        p,
        g,
        now: s.minute,
        rt: s.machines[id],
        op: operationalState(s, id),
        contribution,
        own,
        consequences: consequenceEvents(s, own),
        downtime,
        mm: conveyor ? null : machineMetrics(s, id, p),
        cm: conveyor ? conveyorMetrics(s, id, p) : null,
        trend: conveyor ? [] : machineTrend(s, id, p, g),
        loss: conveyor ? null : machineLoss(s, id, p),
      };
    },
    [id, periodKey, finance, tariffs],
  );
  const where = conveyor
    ? `${conveyor.from ? STAGE_BY_ID[conveyor.from].name : 'Supply'} → ${conveyor.to ? STAGE_BY_ID[conveyor.to].name : 'Dispatch'} · conveyor`
    : STAGE_BY_ID[OPS_BY_ID[id].stage!].name;
  const latest = d.own[0];

  const cols: Column<EvRow>[] = [
    { key: 'start', header: 'Start', render: (r) => formatDateTime(r.ev.start), sort: (r) => r.ev.start },
    { key: 'dur', header: 'Duration', numeric: true, render: (r) => (r.ev.end == null ? <b>Active · {formatDuration(d.now - r.ev.start)}</b> : formatDuration(r.ev.end - r.ev.start)), sort: (r) => (r.ev.end ?? d.now) - r.ev.start },
    { key: 'reason', header: 'Reason', render: (r) => reasonLabel(r.ev.reasonCode), sort: (r) => reasonLabel(r.ev.reasonCode) },
    { key: 'cat', header: 'Category', render: (r) => <span className="muted">{r.ev.category}</span> },
    { key: 'kiln', header: 'Kiln held', numeric: true, title: 'Minutes the kiln was held while this stop was active', render: (r) => `${fmtInt(r.ev.constraintImpactMin)} min`, sort: (r) => r.ev.constraintImpactMin },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.ev.source} /> },
  ];

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer prod-drawer" role="dialog" aria-label={`${id} drill-down`}>
        <div className="drawer-h">
          <div className="prod-drawer-title">
            <h2>
              <span className="mono">{id}</span> · {assetName(id)}
            </h2>
            <small>
              {where} · {d.p.label}
            </small>
          </div>
          <div className="spacer" />
          <button className="btn ghost icon" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-b">
          <div className="prod-drawer-state">
            <OperationalStatus state={d.op} />
            {d.rt && (
              <span className="muted">
                since {formatClock(d.rt.since)} · {formatDuration(d.now - d.rt.since)}
              </span>
            )}
            <div className="spacer" />
            {latest && (
              <button className="btn sm" onClick={() => openEvent(latest.id)} title={`Open the report of ${latest.id}`}>
                <FileText size={13} aria-hidden /> Latest event report
              </button>
            )}
            <button className="btn sm" onClick={() => openEquipment(id)} title="Select and frame this asset in the 3D Factory Twin">
              <MapPin size={13} aria-hidden /> View in 3D
            </button>
          </div>

          <section className="prod-drawer-line">
            <h3 className="prod-h3">
              Share of the line loss at the constraint <span className="muted">· counted once, at the kiln</span>
            </h3>
            {d.contribution ? (
              <p>
                <b className="prod-strong">{m2(d.contribution.m2)}</b> — {contributionParts(d.contribution)}.
              </p>
            ) : (
              <p className="muted">None in this period: nothing this asset did held the kiln up or caused rejects it is charged with.</p>
            )}
          </section>

          {d.mm && d.loss ? (
            <dl className="dl prod-apq">
              <dt>Availability</dt>
              <dd>
                <MetricText m={d.mm.oee.availability} />
              </dd>
              <dt>Performance</dt>
              <dd>
                <MetricText m={d.mm.oee.performance} />
              </dd>
              <dt>Quality</dt>
              <dd>
                <MetricText m={d.mm.oee.quality} />
                <span className="muted"> · rejects attributed to this stage</span>
              </dd>
              <dt>Machine OEE</dt>
              <dd>
                <b>
                  <MetricText m={d.mm.oee.oee} />
                </b>
                <span className="muted"> · this machine’s own time accounting</span>
              </dd>
              <dt>Output</dt>
              <dd>
                {fmtInt(d.mm.totals.count * M2_PER_TILE)} m² <span className="muted">· {fmtInt(d.mm.totals.count)} tiles · ideal {fmtInt(d.mm.idealRatePerHour)} tiles/h</span>
              </dd>
              <dt>Unplanned down</dt>
              <dd>{formatDuration(d.mm.totals.down)}</dd>
              <dt>Starved / blocked</dt>
              <dd>
                {fmtPct(d.mm.totals.planned > 0 ? d.mm.totals.starved / d.mm.totals.planned : null)} / {fmtPct(d.mm.totals.planned > 0 ? d.mm.totals.blocked / d.mm.totals.planned : null)}{' '}
                <span className="muted">of planned time</span>
              </dd>
              <dt>Own lost output</dt>
              <dd title="Unplanned downtime and starved / blocked minutes × ideal rate — asset level, not additive to the line loss">
                {fmtInt(d.loss.totalM2)} m²{' '}
                <span className="muted">
                  · down {fmtInt(d.loss.downM2)} · starved {fmtInt(d.loss.starvedM2)} · blocked {fmtInt(d.loss.blockedM2)} m² at ideal rate
                </span>
              </dd>
            </dl>
          ) : d.cm ? (
            <dl className="dl prod-apq">
              <dt>Availability</dt>
              <dd>
                {fmtPct(d.cm.availability)} <span className="muted">· running share of planned time</span>
              </dd>
              <dt>Utilisation</dt>
              <dd>
                {fmtPct(d.cm.utilisation)} <span className="muted">· transported ÷ nominal {fmtInt(conveyor.capacityPerHour)} tiles/h</span>
              </dd>
              <dt>Transported</dt>
              <dd>
                {fmtInt(d.cm.totals.count * M2_PER_TILE)} m² <span className="muted">· {fmtInt(d.cm.totals.count)} tiles</span>
              </dd>
              <dt>Stops</dt>
              <dd>
                {d.cm.stops} · {formatDuration(d.cm.downMin)}
              </dd>
              <dt>OEE</dt>
              <dd className="muted">Not meaningful for a conveyor — it has no production cycle of its own; availability and utilisation describe it.</dd>
            </dl>
          ) : null}
          {d.mm && d.mm.oee.issues.length > 0 && (
            <div className="notice">
              <span>{d.mm.oee.issues.join(' · ')}</span>
            </div>
          )}

          <section>
            <h3 className="prod-h3">
              Contributing events <span className="muted">· {d.own.length} in period · click an event for its report</span>
            </h3>
            <EventList events={d.own} hideAsset limit={12} empty="No events on this asset in the period" />
          </section>
          {d.consequences.length > 0 && (
            <section>
              <h3 className="prod-h3">
                Consequences elsewhere <span className="muted">· linked by the event engine (inferred)</span>
              </h3>
              <EventList events={d.consequences} limit={8} />
            </section>
          )}

          {!conveyor && (
            <section>
              <h3 className="prod-h3">
                {d.g === 'hour' ? 'Hourly' : 'Per-shift'} output vs ideal <span className="muted">· m², dashed = ideal rate over planned time</span>
              </h3>
              <ColumnChart
                data={d.trend.map((b) => ({ key: b.key, label: b.label, value: b.outputM2, target: b.idealM2 }))}
                height={160}
                format={fmtInt}
                tickEvery={Math.max(1, Math.ceil(d.trend.length / 6))}
                tip={(c) => {
                  const b = d.trend.find((x) => x.key === c.key)!;
                  return (
                    <>
                      <b>{b.tip}</b>
                      <TipRow k="Output" v={`${fmtInt(b.outputM2)} m²`} />
                      <TipRow k="Ideal" v={`${fmtInt(b.idealM2)} m²`} />
                      <TipRow k="Planned time" v={formatDuration(b.plannedMin)} />
                    </>
                  );
                }}
              />
            </section>
          )}

          <section>
            <h3 className="prod-h3">
              Downtime records <span className="muted">· {d.downtime.length} in period</span>
            </h3>
            <DataTable columns={cols} rows={d.downtime} rowKey={(r) => r.ev.id} maxHeight={240} empty="No downtime on this asset in the period" />
          </section>
        </div>
      </aside>
    </>
  );
}
