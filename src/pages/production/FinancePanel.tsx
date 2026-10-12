import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useApp } from '../../app/store';
import { DEFAULT_FINANCE, contributionPerM2, type FinanceAssumptions } from '../../sim/finance';
import { Block, EstTag } from './common';
import { fmtMoney } from './loss';

type NumKey = Exclude<keyof FinanceAssumptions, 'currency'>;

const FIELDS: { key: NumKey; label: string; unit: (c: string) => string; share?: boolean; max: number; step: number; hint: string }[] = [
  { key: 'sellingPricePerM2', label: 'Selling price', unit: (c) => `${c}/m²`, max: 1000, step: 0.1, hint: 'Ex-works price of first-quality tile' },
  { key: 'variableCostPerM2', label: 'Variable cost', unit: (c) => `${c}/m²`, max: 1000, step: 0.1, hint: 'Materials, energy and packaging — not spent when a tile is not made' },
  { key: 'soldOutShare', label: 'Sold-out share', unit: () => '%', share: true, max: 100, step: 5, hint: 'Share of lost good output that is lost sales (100 % = demand exceeds capacity)' },
  { key: 'scrapCostPerM2', label: 'Scrap cost', unit: (c) => `${c}/m²`, max: 1000, step: 0.1, hint: 'Cost already sunk in a rejected tile by the time it reaches sorting' },
  { key: 'reworkShare', label: 'Rework share', unit: () => '%', share: true, max: 100, step: 5, hint: 'Share of rejects regraded / reworked instead of scrapped' },
  { key: 'reworkCostPerM2', label: 'Rework cost', unit: (c) => `${c}/m²`, max: 1000, step: 0.1, hint: 'Cost to rework or regrade one m² of rejects' },
  { key: 'truckWaitCostPerHour', label: 'Truck detention', unit: (c) => `${c}/h`, max: 10000, step: 1, hint: 'Cost per hour a truck waits beyond the waiting threshold' },
];

const shown = (v: number, share?: boolean) => String(share ? Math.round(v * 1000) / 10 : Math.round(v * 100) / 100);

/** A number input that keeps what the user types and commits only valid values. */
function NumField({ label, unit, value, share, max, step, hint, onCommit }: { label: string; unit: string; value: number; share?: boolean; max: number; step: number; hint: string; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(shown(value, share));
  // Follow outside changes (Reset assumptions) without rewriting what is being typed ("0.0" → "0.05").
  useEffect(() => setDraft((d) => (Math.abs(Number(d.replace(',', '.')) - (share ? value * 100 : value)) < 1e-9 ? d : shown(value, share))), [value, share]);
  const n = Number(draft.replace(',', '.'));
  const valid = draft.trim() !== '' && Number.isFinite(n) && n >= 0 && n <= max;
  return (
    <label className="field prod-fin-field" title={hint}>
      <span>
        {label} <span className="muted">· {unit}</span>
      </span>
      <input
        className="input"
        type="number"
        inputMode="decimal"
        min={0}
        max={max}
        step={step}
        value={draft}
        aria-invalid={!valid || undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value.replace(',', '.'));
          if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= 0 && v <= max) onCommit(share ? v / 100 : v);
        }}
        onBlur={() => setDraft(shown(value, share))}
      />
      {!valid && <span className="prod-fin-err">Enter 0–{max}</span>}
    </label>
  );
}

function CurrencyField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = /^[A-Z]{3}$/.test(draft);
  return (
    <label className="field prod-fin-field" title="Three-letter currency code of every money estimate">
      <span>Currency</span>
      <input
        className="input"
        value={draft}
        maxLength={3}
        aria-invalid={!valid || undefined}
        onChange={(e) => {
          const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
          setDraft(v);
          if (/^[A-Z]{3}$/.test(v)) onCommit(v);
        }}
        onBlur={() => setDraft(value)}
      />
      {!valid && <span className="prod-fin-err">Three letters, e.g. USD</span>}
    </label>
  );
}

/** Editable financial assumptions (one set for the whole product: this page, event reports, PDFs and the copilot). */
export function FinancePanel() {
  const f = useApp((s) => s.finance);
  const setFinance = useApp((s) => s.setFinance);
  const resetFinance = useApp((s) => s.resetFinance);
  const isDefault = FIELDS.every((x) => f[x.key] === DEFAULT_FINANCE[x.key]);
  const contrib = contributionPerM2(f);
  return (
    <Block
      className="prod-fin"
      title="Financial assumptions"
      subtitle="Illustrative — edit to match the plant · used by every money estimate"
      actions={
        <>
          <EstTag />
          <button type="button" className="btn sm" onClick={resetFinance} disabled={isDefault} title={isDefault ? 'Assumptions are at their defaults' : 'Restore the default assumptions (the currency stays)'}>
            <RotateCcw size={12} aria-hidden /> Reset assumptions
          </button>
        </>
      }
      note={
        <span>
          Used on this page, in event reports and PDFs and by the copilot. Prices and costs are not read from an ERP — they are assumptions, and every money figure is an estimate, never a saving.
        </span>
      }
    >
      <div className="prod-fin-grid">
        <CurrencyField value={f.currency} onCommit={(currency) => setFinance({ currency })} />
        {FIELDS.map((x) => (
          <NumField
            key={x.key}
            label={x.label}
            unit={x.unit(f.currency)}
            value={f[x.key]}
            share={x.share}
            max={x.max}
            step={x.step}
            hint={x.hint}
            onCommit={(v) => setFinance({ [x.key]: v } as Partial<FinanceAssumptions>)}
          />
        ))}
      </div>
      <dl className="dl prod-fin-derived">
        <dt>Contribution</dt>
        <dd>
          {fmtMoney(contrib, f.currency)}/m² <span className="muted">· price − variable cost (what a tile not made would have earned)</span>
        </dd>
        <dt>Lost good m²</dt>
        <dd>
          {fmtMoney(contrib * f.soldOutShare, f.currency)}/m² <span className="muted">· contribution × {Math.round(f.soldOutShare * 100)} % sold-out share</span>
        </dd>
      </dl>
      {contrib <= 0 && (
        <div className="notice">
          <span>The selling price is not above the variable cost — lost output has no positive value under these assumptions.</span>
        </div>
      )}
    </Block>
  );
}
