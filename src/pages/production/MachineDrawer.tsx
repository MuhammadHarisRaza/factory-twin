import { useEffect } from 'react';
import { MapPin, X } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { M2_PER_TILE, OPS_BY_ID, STAGE_BY_ID } from '../../model/plant';
import { openEquipment } from '../../app/store';
import type { PeriodKey } from '../../sim/metrics';
import { downtimeIn, machineMetrics, resolvePeriod } from '../../sim/metrics';
import { useSimValue } from '../../sim/store';
import { formatClock, formatDateTime, formatDuration } from '../../sim/time';
import { ColumnChart, TipRow } from '../../ui/kit/charts';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt, fmtPct } from '../../ui/kit/format';
import { MachineStatus, MetricText, SourceTag } from '../../ui/kit/Status';
import type { DowntimeEvent } from '../../model/types';
import { granularityFor, machineTrend, reasonLabel } from './derive';

type EvRow = { ev: DowntimeEvent };

/** Machine drill-down: live state, A/P/Q, output vs ideal per bucket and its downtime events in the period. */
export function MachineDrawer({ id, periodKey, onClose }: { id: string; periodKey: PeriodKey; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = useSimValue(
    (s) => {
      const p = resolvePeriod(periodKey, s.minute);
      const g = granularityFor(p);
      const mm = machineMetrics(s, id, p);
      const events: EvRow[] = downtimeIn(s, p)
        .filter((e) => e.equipmentId === id)
        .sort((a, b) => (a.end == null ? 0 : 1) - (b.end == null ? 0 : 1) || b.start - a.start)
        .map((ev) => ({ ev }));
      return { p, g, mm, rt: s.machines[id], now: s.minute, trend: machineTrend(s, id, p, g), events };
    },
    [id, periodKey],
  );
  const eq = EQUIPMENT_BY_ID[id];
  const t = d.mm.totals;
  const share = (v: number) => (t.planned > 0 ? v / t.planned : null);
  const n = d.trend.length;

  const cols: Column<EvRow>[] = [
    { key: 'start', header: 'Start', render: (r) => formatDateTime(r.ev.start), sort: (r) => r.ev.start },
    { key: 'dur', header: 'Duration', numeric: true, render: (r) => (r.ev.end == null ? <b>Active · {formatDuration(d.now - r.ev.start)}</b> : formatDuration(r.ev.end - r.ev.start)), sort: (r) => (r.ev.end ?? d.now) - r.ev.start },
    { key: 'reason', header: 'Reason', render: (r) => reasonLabel(r.ev.reasonCode), sort: (r) => reasonLabel(r.ev.reasonCode) },
    { key: 'cat', header: 'Category', render: (r) => <span className="muted">{r.ev.category}</span> },
    { key: 'src', header: 'Source', render: (r) => <SourceTag source={r.ev.source} /> },
  ];

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer prod-drawer" role="dialog" aria-label={`${id} detail`}>
        <div className="drawer-h">
          <div className="prod-drawer-title">
            <h2>
              <span className="mono">{id}</span> · {eq?.name ?? id}
            </h2>
            <small>
              {STAGE_BY_ID[OPS_BY_ID[id].stage!].name} · {d.p.label}
            </small>
          </div>
          <div className="spacer" />
          <button className="btn ghost icon" onClick={onClose} title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div className="drawer-b">
          <div className="prod-drawer-state">
            <MachineStatus state={d.rt.state} />
            <span className="muted">
              since {formatClock(d.rt.since)} · {formatDuration(d.now - d.rt.since)}
            </span>
            <div className="spacer" />
            <button className="btn sm" onClick={() => openEquipment(id)}>
              <MapPin size={13} />
              View in Factory Twin
            </button>
          </div>

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
            <dt>OEE</dt>
            <dd>
              <b>
                <MetricText m={d.mm.oee.oee} />
              </b>
            </dd>
            <dt>Output</dt>
            <dd>
              {fmtInt(t.count * M2_PER_TILE)} m² <span className="muted">· {fmtInt(t.count)} tiles · ideal {fmtInt(d.mm.idealRatePerHour)} tiles/h</span>
            </dd>
            <dt>Unplanned down</dt>
            <dd>{formatDuration(t.down)}</dd>
            <dt>Starved / blocked</dt>
            <dd>
              {fmtPct(share(t.starved))} / {fmtPct(share(t.blocked))} <span className="muted">of planned time</span>
            </dd>
          </dl>
          {d.mm.oee.issues.length > 0 && (
            <div className="notice">
              <span>{d.mm.oee.issues.join(' · ')}</span>
            </div>
          )}

          <section>
            <h3 className="prod-h3">
              {d.g === 'hour' ? 'Hourly' : 'Per-shift'} output vs ideal <span className="muted">· m², dashed = ideal rate over planned time</span>
            </h3>
            <ColumnChart
              data={d.trend.map((b) => ({ key: b.key, label: b.label, value: b.outputM2, target: b.idealM2 }))}
              height={170}
              format={fmtInt}
              tickEvery={Math.max(1, Math.ceil(n / 6))}
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

          <section>
            <h3 className="prod-h3">
              Downtime events <span className="muted">· {d.events.length} in period</span>
            </h3>
            <DataTable columns={cols} rows={d.events} rowKey={(r) => r.ev.id} maxHeight={260} empty="No downtime on this machine in the period" />
          </section>
        </div>
      </aside>
    </>
  );
}
