/**
 * Detection rules and safety configuration of Vehicle Monitoring (thresholds of the shared event
 * engine, restricted geofences), internal-vehicle pickups / drop-offs, and the capabilities that are
 * not available without integrations — each with what it would need. No claims beyond the simulation.
 */
import { useState } from 'react';
import { CircleSlash, RotateCcw, ShieldAlert } from 'lucide-react';
import type { EventRules } from '../../model/types';
import { useSim } from '../../sim/store';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { Panel } from '../../ui/kit/Panel';
import { StatusBadge } from '../../ui/kit/Status';
import { fmtInt } from '../../ui/kit/format';
import { type Clock } from './common';
import { geofenceName } from './derive';
import { NOT_AVAILABLE, type HandlingEvent, type RuleLimit, type RuleRow, type ZoneRow } from './pipeline';

// ── Rules & restricted zones ─────────────────────────────────────────────────

/** Number input that commits a valid value on blur / Enter and reverts an invalid one (keyed by value). */
function ThresholdInput({ k, value, limit, label }: { k: keyof EventRules; value: number; limit: RuleLimit; label: string }) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const v = Number(text);
    if (!Number.isFinite(v) || v < limit.min || v > limit.max) return setText(String(value));
    const r = Math.round(v / limit.step) * limit.step;
    if (r !== value) useSim.getState().setRule(k, r);
    else setText(String(value));
  };
  return (
    <span className="fv-thr">
      <input
        className="input"
        type="number"
        min={limit.min}
        max={limit.max}
        step={limit.step}
        value={text}
        aria-label={`${label} threshold (${limit.unit})`}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <span className="dim">{limit.unit}</span>
    </span>
  );
}

export function SafetyRules({ rules, zones, clock, periodLabel, onSelect }: { rules: RuleRow[]; zones: ZoneRow[]; clock: Clock; periodLabel: string; onSelect: (id: string) => void }) {
  const cols: Column<RuleRow>[] = [
    {
      key: 'rule',
      header: 'Rule',
      render: (r) => (
        <span title={r.description}>
          <span className="mono">{r.id}</span> {r.label}
        </span>
      ),
    },
    {
      key: 'thr',
      header: 'Threshold',
      render: (r) =>
        r.key && r.limit && r.value != null ? (
          <span className="fv-thr-cell">
            <ThresholdInput key={r.value} k={r.key} value={r.value} limit={r.limit} label={r.label} />
            {r.def != null && r.value !== r.def && (
              <button className="btn sm ghost icon" title={`Back to the default (${r.def} ${r.limit.unit})`} aria-label={`Reset ${r.label} threshold to ${r.def}`} onClick={() => useSim.getState().setRule(r.key!, r.def!)}>
                <RotateCcw size={12} aria-hidden />
              </button>
            )}
          </span>
        ) : (
          <span className="dim">No entry (any)</span>
        ),
    },
    {
      key: 'n',
      header: 'Events',
      numeric: true,
      title: `Events touching ${periodLabel} · condition active now`,
      render: (r) => (
        <>
          {fmtInt(r.count)}
          <span className="sub">{r.active ? `${r.active} active` : ''}</span>
        </>
      ),
    },
  ];
  return (
    <Panel
      title="Detection rules & restricted zones"
      subtitle="Thresholds of the shared event engine — a change applies from the next simulated minute, in every workspace"
      flush
      footer={<span>Rules run on simulated gate, dock and position records (zone level). Restricted zones are checked on the simulated route travelled each minute.</span>}
    >
      <DataTable columns={cols} rows={rules} rowKey={(r) => r.id} maxHeight="none" />
      <ul className="fv-zones" aria-label="Configured restricted zones">
        {zones.map((z) => (
          <li key={z.g.id}>
            <span className="fv-zone-n">
              <ShieldAlert size={13} aria-hidden />
              <b>{z.g.name}</b>
              <span className="mono dim">{z.g.id}</span>
            </span>
            <span className="fv-zone-r">No entry for internal vehicles</span>
            <span className="fv-zone-s">
              {z.inside.length ? (
                <StatusBadge tone="warning" icon={ShieldAlert} label={`Inside now: ${z.inside.join(', ')}`} />
              ) : (
                <span className="dim">Nobody inside</span>
              )}
              <span className="dim">
                {' '}
                · {z.today} entr{z.today === 1 ? 'y' : 'ies'} today
                {z.last && (
                  <>
                    {' '}
                    · last {clock(z.last.time)}{' '}
                    <button className="row-link mono" onClick={() => onSelect(z.last!.vehicleId)}>
                      {z.last.vehicleId}
                    </button>
                  </>
                )}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ── Pickups & drop-offs ──────────────────────────────────────────────────────

const HANDLING_LIMIT = 40;

export function HandlingPanel({ rows, from, now, clock, selected, onSelect }: { rows: HandlingEvent[]; from: number; now: number; clock: Clock; selected: string | null; onSelect: (id: string) => void }) {
  const pickups = rows.filter((r) => r.kind === 'pickup').length;
  return (
    <Panel
      title="Pickups & drop-offs"
      subtitle={`Since ${clock(from)}${from > now - 60 ? ' (oldest movement retained for every vehicle)' : ' · last 60 min'} · from the simulated movement legs`}
      flush
      footer={
        <span>
          {fmtInt(pickups)} pickups · {fmtInt(rows.length - pickups)} drop-offs{rows.length > HANDLING_LIMIT ? ` · latest ${HANDLING_LIMIT} shown` : ''}
        </span>
      }
    >
      {rows.length ? (
        <ul className="fv-list fv-handling">
          {rows.slice(0, HANDLING_LIMIT).map((h) => (
            <li key={h.id} className={selected === h.vehicleId ? 'sel' : ''}>
              <span className="t">{clock(h.time)}</span>
              <button className="row-link mono" onClick={() => onSelect(h.vehicleId)}>
                {h.vehicleId}
              </button>
              <span className={`fv-kind ${h.kind}`}>{h.kind === 'pickup' ? 'Pickup' : 'Drop-off'}</span>
              <span className="a">
                {h.activity}
                <span className="dim"> · {h.dock ?? geofenceName(h.zone)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fv-muted fv-pad">No pickup or drop-off since {clock(from)}.</p>
      )}
    </Panel>
  );
}

// ── Not available ─────────────────────────────────────────────────────────────

export function NotAvailablePanel() {
  return (
    <Panel title="Not available in this demo" subtitle="Vehicle capabilities that need an integration — none is connected, so none is claimed">
      <ul className="fv-na">
        {NOT_AVAILABLE.map((x) => (
          <li key={x.id}>
            <div className="fv-na-h">
              <b>{x.label}</b>
              <StatusBadge tone="neutral" icon={CircleSlash} label="Not available" />
            </div>
            <p className="dim">{x.status}</p>
            <dl className="dl">
              <dt>Would need</dt>
              <dd>{x.needs}</dd>
              <dt>In this demo</dt>
              <dd>{x.instead}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
