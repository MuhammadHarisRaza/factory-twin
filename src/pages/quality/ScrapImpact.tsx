/**
 * Scrap / rework impact of rejects, for the reporting period and per quality event, with the
 * financial assumptions behind every figure. Period figures come from the inspection counters;
 * event figures are the same EventImpact the event report and the PDF render (excess rejects over
 * the 24 h reference). All money values are estimates from editable assumptions.
 */
import { useState } from 'react';
import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../../app/store';
import { M2_PER_TILE } from '../../model/plant';
import type { OpEvent } from '../../model/types';
import { assumptionList } from '../../sim/finance';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmt1, fmtInt, fmtPct } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { EventStatusBadge, MetricText } from '../../ui/kit/Status';
import { fmtMoney, type ImpactFigures, type PeriodQualityImpact } from './derive';

export type EventImpactRow = { ev: OpEvent; f: ImpactFigures };

type Props = {
  impact: PeriodQualityImpact;
  rows: EventImpactRow[];
  periodLabel: string;
  focusId: string | null;
  onFocus: (id: string) => void;
};

export function ScrapImpact({ impact: m, rows, periodLabel, focusId, onFocus }: Props) {
  const finance = useApp((s) => s.finance);
  const [edit, setEdit] = useState(false);
  const c = finance.currency;
  const eventTotal = rows.reduce((a, r) => a + (r.f.total ?? 0), 0);

  const cols: Column<EventImpactRow>[] = [
    {
      key: 'ev',
      header: 'Event',
      render: (r) => (
        <span className="q-ev-cell" title={r.ev.title}>
          <span className="mono">{r.ev.id}</span> {r.ev.title}
        </span>
      ),
      sort: (r) => r.ev.id,
    },
    { key: 'st', header: 'Status', render: (r) => <EventStatusBadge status={r.ev.status} />, sort: (r) => r.ev.status },
    { key: 'rej', header: 'Rejected', numeric: true, render: (r) => r.f.rejected ?? '—' },
    { key: 'exc', header: 'Excess', numeric: true, title: 'Rejects above the 24 h reference rate for the tiles inspected', render: (r) => r.f.excess ?? '—' },
    { key: 'q', header: 'Quality rate', numeric: true, render: (r) => r.f.rateEffect ?? <span className="muted">—</span> },
    { key: 'cost', header: 'Estimate', numeric: true, render: (r) => fmtMoney(r.f.currency ?? c, r.f.total), sort: (r) => r.f.total },
  ];

  return (
    <Panel
      className="q-imp-panel"
      title="Scrap & rework impact"
      subtitle={
        <>
          {periodLabel} and per quality event · <span className="tag sim">estimate · assumptions shown</span>
        </>
      }
      actions={
        <button className={`btn sm ${edit ? 'on' : ''}`} aria-expanded={edit} onClick={() => setEdit(!edit)}>
          <SlidersHorizontal size={13} /> Assumptions
        </button>
      }
      footer={
        <ul className="q-imp-ass">
          {assumptionList(finance)
            .filter((a) => !a.startsWith('Truck'))
            .map((a) => (
              <li key={a}>{a}</li>
            ))}
        </ul>
      }
    >
      {edit && <AssumptionEditor />}
      <div className="q-imp">
        <section>
          <h3>{periodLabel}</h3>
          <dl className="dl">
            <dt>Rejected</dt>
            <dd>
              {fmtInt(m.rejected)} tiles <span className="muted">· {fmt1(m.rejected * M2_PER_TILE)} m² · {fmtPct(m.rate, 2)} of {fmtInt(m.inspected)} inspected</span>
            </dd>
            {m.lines.map((l) => (
              <FragmentRow key={l.label} k={l.label} v={fmtMoney(c, l.amount)} sub={l.basis} />
            ))}
            <dt>Total</dt>
            <dd>
              <b>{fmtMoney(c, m.total)}</b> <span className="muted">scrap + rework of every reject</span>
            </dd>
            <dt>Above {fmtPct(m.baseRate, 1)} baseline</dt>
            <dd>
              {fmtInt(m.excessVsBase)} tiles → {fmtMoney(c, m.excessVsBaseTotal)}
              <div className="q-vd-sub">Rejects above the plant's normal reject rate for the tiles inspected</div>
            </dd>
            <dt>vs no-scenario run</dt>
            <dd>
              {m.extraVsBaseline == null ? (
                <span className="muted">Baseline twin not ready yet</span>
              ) : (
                <>
                  {m.extraVsBaseline >= 0 ? '+' : '−'}
                  {fmtInt(Math.abs(m.extraVsBaseline))} tiles → {fmtMoney(c, m.extraVsBaselineTotal)}
                  <div className="q-vd-sub">Same seed simulated without scenarios: {fmtInt(m.baselineRejected)} rejects</div>
                </>
              )}
            </dd>
          </dl>
          <h3 className="q-imp-h">Quality rate & OEE</h3>
          <dl className="dl">
            <dt>Quality rate (Q)</dt>
            <dd>
              <MetricText m={m.quality} digits={2} /> <span className="muted">first-pass yield at sorting</span>
            </dd>
            <dt>Line OEE</dt>
            <dd>
              <MetricText m={m.oee} digits={1} />
            </dd>
            <dt>OEE lost to quality</dt>
            <dd>
              {m.oeeLossToQuality != null ? `${(m.oeeLossToQuality * 100).toFixed(2)} pts` : '—'}
              <div className="q-vd-sub">A × P × (1 − Q) — what line OEE would gain with no rejects</div>
            </dd>
          </dl>
        </section>
        <section className="q-imp-ev">
          <h3>
            Per quality event <span className="muted">· same figures as the event report</span>
          </h3>
          <DataTable
            columns={cols}
            rows={rows}
            rowKey={(r) => r.ev.id}
            onRowClick={(r) => onFocus(r.ev.id)}
            selectedKey={focusId}
            maxHeight={250}
            empty="No quality events in this period"
          />
          <p className="q-imp-note">
            Events together: <b>{fmtMoney(c, eventTotal)}</b> — the scrap & rework of their excess rejects over each event's 24 h reference. Events
            can overlap in time, so their sum is not added to the period total.
          </p>
        </section>
      </div>
    </Panel>
  );
}

function FragmentRow({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>
        {v}
        <div className="q-vd-sub">{sub}</div>
      </dd>
    </>
  );
}

/** The reject-related assumptions, edited in the shared finance store (the same values every page uses). */
function AssumptionEditor() {
  const finance = useApp((s) => s.finance);
  const setFinance = useApp((s) => s.setFinance);
  const resetFinance = useApp((s) => s.resetFinance);
  return (
    <div className="q-imp-edit" role="group" aria-label="Reject cost assumptions">
      <NumField label={`Scrap cost (${finance.currency}/m²)`} value={finance.scrapCostPerM2} min={0} max={1000} step={0.1} onCommit={(v) => setFinance({ scrapCostPerM2: v })} />
      <NumField label="Reworked share (%)" value={Math.round(finance.reworkShare * 100)} min={0} max={100} step={5} onCommit={(v) => setFinance({ reworkShare: v / 100 })} />
      <NumField label={`Rework cost (${finance.currency}/m²)`} value={finance.reworkCostPerM2} min={0} max={1000} step={0.1} onCommit={(v) => setFinance({ reworkCostPerM2: v })} />
      <button className="btn sm ghost" onClick={resetFinance} title="Restore every financial assumption to its default">
        <RotateCcw size={13} /> Defaults
      </button>
      <span className="q-imp-edit-note muted">Shared with Production (OEE & losses), event reports and the PDF.</span>
    </div>
  );
}

/** Number input with a local draft: valid values commit as typed, an empty / invalid draft reverts on blur. */
function NumField({ label, value, min, max, step, onCommit }: { label: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const valid = (v: string) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft ?? String(value)}
        aria-invalid={draft != null && valid(draft) == null}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = valid(e.target.value);
          if (n != null) onCommit(n);
        }}
        onBlur={() => setDraft(null)}
      />
    </label>
  );
}
