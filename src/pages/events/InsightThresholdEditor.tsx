/**
 * 'Insight rule thresholds' section of the Detection rules tab: every rule of the rule engine (src/intel/rules)
 * — id, family, how it decides (Rule-based / Statistical), what it checks — with its parameters, editable
 * through useRuleThresholds. Values are typed in display units (number inputs with the parameter's min / max /
 * step / unit) and apply on Enter or when leaving the field (Esc undoes); each row says whether the value in
 * force is the default, configured here, or follows an event-rule threshold. The store's version invalidates the
 * findings memo, so every finding re-evaluates with the new value. Derivations: ./insightThresholds.ts.
 */
import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Search, X } from 'lucide-react';
import { FAMILY_LABEL, RULES, useRuleThresholds, type RuleFamily } from '../../intel/rules';
import { useSimValue } from '../../sim/store';
import { Section } from '../../ui/kit/Page';
import { commitInsightParam, displayRange, formatInsight, insightRuleRows, overrideCount, sourceLabel, type InsightParamRow } from './insightThresholds';
import { useInsightFilters } from './state';

const FAMILIES = Object.keys(FAMILY_LABEL) as RuleFamily[];

function InsightParamInput({ row }: { row: InsightParamRow }) {
  const rules = useSimValue((s) => s.rules);
  const reset = useRuleThresholds((t) => t.reset);
  const shown = formatInsight(row.param, row.value);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(shown);
    setError(null);
  }, [shown]);
  const range = displayRange(row.param);
  const commit = () => {
    if (text === shown) return;
    const r = commitInsightParam(row.key, text, rules);
    if (!r.ok) setError(r.error);
    else setError(null);
  };
  const configured = row.source === 'global';
  const rangeText = `${range.min ?? '−∞'}–${range.max ?? '∞'} ${row.param.unit}${range.step != null ? ` · step ${range.step}` : ''}`;

  return (
    <div className="ith-param">
      <label>
        <span className="ith-param-l" title={row.param.hint}>
          {row.param.label}
        </span>
        <input
          className={`input num ${configured ? 'mod' : ''}`}
          type="number"
          min={range.min ?? undefined}
          max={range.max ?? undefined}
          step={range.step ?? 'any'}
          value={text}
          aria-invalid={error != null}
          aria-label={`${row.ruleId}: ${row.param.label} (${row.param.unit})`}
          title={`${rangeText} · Enter to apply, Esc to undo`}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              setText(shown);
              setError(null);
            }
          }}
        />
        <span className="ith-param-u">{row.param.unit}</span>
      </label>
      <span className={`ith-src ${configured ? 'on' : ''}`}>{sourceLabel(row)}</span>
      <span className="ith-def num dim" title="Default">
        default {formatInsight(row.param, row.defaultValue)} {row.param.unit}
      </span>
      {configured && (
        <button className="btn ghost sm" onClick={() => reset(row.key)} title="Remove the configured value">
          <RotateCcw size={12} aria-hidden /> Default
        </button>
      )}
      {row.mirror && (
        <span className="ith-mirror">
          Mirrors the event-rule threshold {row.mirror.eventRules.length ? row.mirror.eventRules.join(' / ') : row.mirror.field}
          {row.mirror.changed ? ' (changed above)' : ''}
        </span>
      )}
      {row.overrides.length > 0 && (
        <span className="ith-mirror">
          {row.overrides.length} per-equipment value{row.overrides.length === 1 ? '' : 's'}:{' '}
          {row.overrides.map((o) => `${o.equipmentId} ${formatInsight(row.param, o.value)}`).join(', ')}
        </span>
      )}
      {error && (
        <span className="rl-param-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function InsightThresholds() {
  const f = useInsightFilters();
  const values = useRuleThresholds((t) => t.values);
  const resetAll = useRuleThresholds((t) => t.reset);
  const rules = useSimValue((s) => s.rules);
  const rows = useMemo(() => insightRuleRows(values, rules, { family: f.family, query: f.query }), [values, rules, f.family, f.query]);
  const overrides = overrideCount(values);
  const params = RULES.reduce((n, d) => n + d.params.length, 0);

  return (
    <Section
      title="Insight rule thresholds"
      subtitle={`${RULES.length} insight rules, ${params} parameters · ${overrides ? `${overrides} configured value${overrides === 1 ? '' : 's'}` : 'all at default'} — the findings re-evaluate with the value in force; remembered in this browser`}
      className="ith"
      flush
      actions={
        <button className="btn sm" onClick={() => resetAll()} disabled={!overrides} title="Remove every configured insight threshold">
          <RotateCcw size={12} aria-hidden /> Reset all to defaults
        </button>
      }
    >
      <div className="evp-filters ith-filters" role="search" aria-label="Filter insight rules">
        <label className="evp-search">
          <Search size={14} aria-hidden />
          <input
            className="input"
            type="search"
            value={f.query}
            onChange={(e) => f.set({ query: e.target.value })}
            placeholder="Search rule id, title, parameter…"
            aria-label="Search insight rules"
          />
          {f.query && (
            <button className="btn ghost sm icon" onClick={() => f.set({ query: '' })} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </label>
        <select className="select" value={f.family} onChange={(e) => f.set({ family: e.target.value as RuleFamily | 'all' })} aria-label="Rule family">
          <option value="all">All families ({RULES.length})</option>
          {FAMILIES.map((fam) => (
            <option key={fam} value={fam}>
              {FAMILY_LABEL[fam]} ({RULES.filter((d) => d.family === fam).length})
            </option>
          ))}
        </select>
      </div>
      {rows.length ? (
        <ul className="ith-list">
          {rows.map((r) => (
            <li key={r.def.id} className="ith-rule">
              <div className="ith-h">
                <b>{r.def.title}</b>
                <span className="mono muted">{r.def.id}</span>
                <span className="tag">{r.familyLabel}</span>
                <span className="tag">{r.classificationLabel}</span>
              </div>
              <p className="ith-desc">{r.def.description}</p>
              {r.params.length ? (
                <div className="ith-params">
                  {r.params.map((p) => (
                    <InsightParamInput key={p.key} row={p} />
                  ))}
                </div>
              ) : (
                <p className="muted ith-desc">No threshold — the rule fires on the condition.</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted ith-empty">No insight rule matches the search.</p>
      )}
    </Section>
  );
}
