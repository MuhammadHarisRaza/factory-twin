import { useEffect } from 'react';
import { FileText, MapPin, X } from 'lucide-react';
import { openEquipment, openEvent, useApp } from '../../app/store';
import { CONVEYOR_BY_ID, M2_PER_TILE, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import type { DowntimeEvent } from '../../model/types';
import { conveyorMetrics, downtimeIn, machineMetrics, operationalState, resolvePeriod, type PeriodKey } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatDateTime, formatDuration } from '../../sim/time';
import { EventList } from '../../ui/events/EventList';
import { ColumnChart, TipRow } from '../../ui/kit/charts';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { MetricText, OperationalStatus, SourceTag } from '../../ui/kit/Status';
import { ContextVideo } from '../../video/ContextVideo';
import { assetName, m2 } from './common';
import { granularityFor, machineLoss, machineTrend, reasonLabel } from './derive';
import { assetEvents, consequenceEvents } from './equipment';
import { sinceLabel } from './stage/derive';
import { contributionParts, equipmentContribution, lossLedger } from './loss';
import { MASS_DISCLOSURE, isMaterialAsset, tileEqToT } from './units';

type EvRow = { ev: DowntimeEvent };

/**
 * Equipment drill-down (process machine or conveyor): current state, its figures for the period,
 * its share of the line loss at the constraint, the events that contributed (→ event report) and
 * the way to the 3D twin.
 */
export function EquipmentDrawer({ id, periodKey, onClose }: { id: string; periodKey: PeriodKey; onClose: () => void }) {
  const finance = useApp((s) => s.finance);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const conveyor = CONVEYOR_BY_ID[id];
  // Slip / powder machines: their tile-equivalents in t (dry-body equivalent, disclosed), never m² of tiles.
  const material = isMaterialAsset(id);
  const unitOf = (m2v: number) => (material ? (tileEqToT(m2v / M2_PER_TILE) ?? 0) : m2v);
  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const g = granularityFor(p);
      const L = lossLedger(s, p, finance);
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
    [id, periodKey, finance],
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
          <button type="button" className="btn ghost icon" onClick={onClose} title="Close (Esc)" aria-label="Close the drill-down">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-b">
          <div className="prod-drawer-state">
            <OperationalStatus state={d.op} />
            {d.rt && (
              <span className="muted">
                since {sinceLabel(d.rt.since, d.now)} · {formatDuration(d.now - d.rt.since)}
              </span>
            )}
            <div className="spacer" />
            {latest && (
              <button type="button" className="btn sm" onClick={() => openEvent(latest.id)} title={`Open the report of ${latest.id}`}>
                <FileText size={13} aria-hidden /> Latest event report
              </button>
            )}
            <button type="button" className="btn sm" onClick={() => openEquipment(id)} title="Open the shared equipment panel (signals, analytics, events) with this asset selected and framed in the 3D Factory Twin">
              <MapPin size={13} aria-hidden /> Open in Factory Twin
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
                {isMaterialAsset(id) ? (
                  // Slip / powder: tile-equivalents and t/h (a disclosed conversion) — never tiles or m².
                  <>
                    {fmtInt(d.mm.totals.count)} tile-eq{' '}
                    <span className="muted">
                      · ≈ {fmt1(tileEqToT(d.mm.totals.count))} t · ideal {fmt1(tileEqToT(d.mm.idealRatePerHour))} t/h · {MASS_DISCLOSURE}
                    </span>
                  </>
                ) : (
                  <>
                    {fmtInt(d.mm.totals.count * M2_PER_TILE)} m² <span className="muted">· {fmtInt(d.mm.totals.count)} tiles · ideal {fmtInt(d.mm.idealRatePerHour)} tiles/h</span>
                  </>
                )}
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
                {material ? `${fmt1(unitOf(d.loss.totalM2))} t` : `${fmtInt(d.loss.totalM2)} m²`}{' '}
                <span className="muted">
                  · down {material ? fmt1(unitOf(d.loss.downM2)) : fmtInt(d.loss.downM2)} · starved {material ? fmt1(unitOf(d.loss.starvedM2)) : fmtInt(d.loss.starvedM2)} · blocked{' '}
                  {material ? fmt1(unitOf(d.loss.blockedM2)) : fmtInt(d.loss.blockedM2)} {material ? 't' : 'm²'} at ideal rate
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
                {fmtPct(d.cm.utilisation)}{' '}
                <span className="muted">
                  · transported ÷ nominal {isMaterialAsset(id) ? `${fmt1(tileEqToT(conveyor.capacityPerHour))} t/h (${MASS_DISCLOSURE})` : `${fmtInt(conveyor.capacityPerHour)} tiles/h`}
                </span>
              </dd>
              <dt>Transported</dt>
              <dd>
                {isMaterialAsset(id) ? (
                  <>
                    {fmtInt(d.cm.totals.count)} tile-eq <span className="muted">· ≈ {fmt1(tileEqToT(d.cm.totals.count))} t</span>
                  </>
                ) : (
                  <>
                    {fmtInt(d.cm.totals.count * M2_PER_TILE)} m² <span className="muted">· {fmtInt(d.cm.totals.count)} tiles</span>
                  </>
                )}
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
                {d.g === 'hour' ? 'Hourly' : 'Per-shift'} output vs ideal{' '}
                <span className="muted">· {material ? `t, dry-body equivalent (${MASS_DISCLOSURE})` : 'm²'}, dashed = ideal rate over planned time</span>
              </h3>
              <ColumnChart
                data={d.trend.map((b) => ({ key: b.key, label: b.label, value: unitOf(b.outputM2), target: unitOf(b.idealM2) }))}
                height={160}
                format={material ? fmt1 : fmtInt}
                tickEvery={Math.max(1, Math.ceil(d.trend.length / 6))}
                tip={(c) => {
                  const b = d.trend.find((x) => x.key === c.key)!;
                  const u = material ? 't' : 'm²';
                  const f = material ? fmt1 : fmtInt;
                  return (
                    <>
                      <b>{b.tip}</b>
                      <TipRow k="Output" v={`${f(unitOf(b.outputM2))} ${u}`} />
                      <TipRow k="Ideal" v={`${f(unitOf(b.idealM2))} ${u}`} />
                      <TipRow k="Planned time" v={formatDuration(b.plannedMin)} />
                    </>
                  );
                }}
              />
            </section>
          )}

          <section>
            <h3 className="prod-h3">
              Reference video <span className="muted">· illustrates the equipment type — not this plant, not a live feed</span>
            </h3>
            <ContextVideo context={{ equipmentId: id }} compact />
          </section>

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
