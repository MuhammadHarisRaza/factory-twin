import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useApp } from '../../app/store';
import { DEFAULT_TARIFFS, type Tariffs } from '../../sim/energy';
import { Panel } from '../../ui/kit/Panel';
import { fmt1, fmtInt } from '../../ui/kit/format';
import { fmtMoney, fmtRate, parseAmount, parseCurrency, sameTariffs } from './derive';

type Totals = { elec: number; thermal: number; total: number; cost: number; co2Kg: number };

const PRICE_MAX = 1000;
const FACTOR_MAX = 5;

/**
 * Editable energy tariffs and emission factors (shared app state). Valid entries apply
 * immediately to every cost and CO₂ figure in the product; invalid ones are flagged and
 * not applied.
 */
export function TariffPanel({ totals, periodLabel }: { totals: Totals; periodLabel: string }) {
  const tariffs = useApp((s) => s.tariffs);
  const set = (t: Partial<Tariffs>) => useApp.getState().setTariffs(t);
  const modified = !sameTariffs(tariffs, DEFAULT_TARIFFS);
  const cur = tariffs.currency;
  const elecCost = totals.elec * tariffs.electricity;
  const gasCost = totals.thermal * tariffs.gas;

  return (
    <Panel
      title="Tariffs & emission factors"
      subtitle="Assumptions behind every cost and CO₂e figure"
      actions={
        <button className="btn sm" disabled={!modified} onClick={() => set(DEFAULT_TARIFFS)} title="Restore the illustrative default tariffs">
          <RotateCcw size={12} aria-hidden />
          Reset to defaults
        </button>
      }
      footer={
        <span>
          {modified ? <b className="en-mod">Modified</b> : 'Illustrative defaults'} · applies immediately to all workspaces (Command Center, scenario impact,
          copilot). Gas priced per kWh of lower heating value.
        </span>
      }
    >
      <div className="en-tariffs">
        <TextField label="Currency code" value={cur} onCommit={(currency) => set({ currency })} />
        <AmountField label="Electricity price" unit={`${cur} / kWh`} value={tariffs.electricity} max={PRICE_MAX} onCommit={(electricity) => set({ electricity })} />
        <AmountField label="Gas price" unit={`${cur} / kWh`} value={tariffs.gas} max={PRICE_MAX} onCommit={(gas) => set({ gas })} />
        <AmountField label="CO₂e factor · electricity" unit="kg / kWh" value={tariffs.co2Electricity} max={FACTOR_MAX} onCommit={(co2Electricity) => set({ co2Electricity })} />
        <AmountField label="CO₂e factor · gas" unit="kg / kWh" value={tariffs.co2Gas} max={FACTOR_MAX} onCommit={(co2Gas) => set({ co2Gas })} />
      </div>

      <h3 className="en-h3">Applied to the period · {periodLabel}</h3>
      <dl className="dl en-breakdown">
        <dt>Electricity</dt>
        <dd>
          {fmtInt(totals.elec)} kWh × {fmtRate(tariffs.electricity)} = <b>{fmtMoney(elecCost, cur)}</b>
        </dd>
        <dt>Gas</dt>
        <dd>
          {fmtInt(totals.thermal)} kWh × {fmtRate(tariffs.gas)} = <b>{fmtMoney(gasCost, cur)}</b>
        </dd>
        <dt>Total cost</dt>
        <dd>
          <b>{fmtMoney(totals.cost, cur)}</b>
          <span className="muted"> · blended {totals.total > 0 ? fmtRate(totals.cost / totals.total) : '—'} {cur}/kWh</span>
        </dd>
        <dt>CO₂e</dt>
        <dd>
          {fmt1(totals.co2Kg / 1000)} t
          <span className="muted">
            {' '}
            · elec. {fmt1((totals.elec * tariffs.co2Electricity) / 1000)} t · gas {fmt1((totals.thermal * tariffs.co2Gas) / 1000)} t
          </span>
        </dd>
      </dl>
    </Panel>
  );
}

/**
 * Text input that keeps the user's draft while typing, commits valid values on every
 * keystroke and falls back to the applied value on blur (or when reset elsewhere).
 */
function useDraft(applied: string) {
  const [draft, setDraft] = useState(applied);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(applied);
  }, [applied, editing]);
  return { draft, setDraft, focus: () => setEditing(true), blur: () => setEditing(false) };
}

function AmountField({ label, unit, value, max, onCommit }: { label: string; unit: string; value: number; max: number; onCommit: (v: number) => void }) {
  const { draft, setDraft, focus, blur } = useDraft(String(value));
  const invalid = parseAmount(draft, max) == null;
  return (
    <label className="field en-field">
      {label}
      <span className="en-input">
        <input
          className={`input ${invalid ? 'en-invalid' : ''}`}
          inputMode="decimal"
          value={draft}
          aria-invalid={invalid || undefined}
          onFocus={focus}
          onBlur={blur}
          onChange={(e) => {
            setDraft(e.target.value);
            const v = parseAmount(e.target.value, max);
            if (v != null) onCommit(v);
          }}
        />
        <span className="en-unit">{unit}</span>
      </span>
      {invalid && <span className="en-err">Enter a number from 0 to {fmtInt(max)} — not applied</span>}
    </label>
  );
}

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const { draft, setDraft, focus, blur } = useDraft(value);
  const invalid = parseCurrency(draft) == null;
  return (
    <label className="field en-field en-wide">
      {label}
      <span className="en-input">
        <input
          className={`input en-code ${invalid ? 'en-invalid' : ''}`}
          value={draft}
          maxLength={3}
          spellCheck={false}
          autoCapitalize="characters"
          aria-invalid={invalid || undefined}
          onFocus={focus}
          onBlur={blur}
          onChange={(e) => {
            setDraft(e.target.value.toUpperCase());
            const v = parseCurrency(e.target.value);
            if (v != null) onCommit(v);
          }}
        />
        <span className="en-unit">Three letters, e.g. USD, EUR, PKR</span>
      </span>
      {invalid && <span className="en-err">Enter a three-letter code — not applied</span>}
    </label>
  );
}
