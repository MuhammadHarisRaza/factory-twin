import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { DEFAULT_EVENT_RULES } from '../../model/plant';
import { EVENT_CATEGORY_LABEL, EVENT_RULE_DEFS } from '../../sim/events';
import { useSim, useSimValue } from '../../sim/store';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt } from '../../ui/kit/format';
import { Panel } from '../../ui/kit/Panel';
import { isModified, modifiedCount, parseParam, formatParam, ruleParams, sharedWith, type RuleParam } from './rules';

type RuleDef = (typeof EVENT_RULE_DEFS)[number];
type RuleStats = Record<string, { total: number; open: number; session: number }>;

const CATEGORY_ORDER = ['production', 'data', 'equipment', 'quality', 'logistics', 'energy'];
const AVAILABLE = EVENT_RULE_DEFS.filter((d) => d.available).sort(
  (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
);
const UNAVAILABLE = EVENT_RULE_DEFS.filter((d) => !d.available);

/** One threshold field: typed in display units, applied on Enter or when leaving the field. */
function ParamInput({ ruleId, param, value, modified }: { ruleId: string; param: RuleParam; value: number; modified: boolean }) {
  const setRule = useSim((s) => s.setRule);
  const [text, setText] = useState(() => formatParam(param, value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(formatParam(param, value));
    setError(null);
  }, [param, value]);

  const commit = () => {
    const r = parseParam(param, text);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    if (Math.abs(r.value - value) > 1e-12) setRule(param.key, r.value);
    else setText(formatParam(param, value));
  };
  const shared = sharedWith(ruleId, param.key);

  return (
    <div className="a-param">
      <label>
        <span className="a-param-l">{param.label}</span>
        <input
          className={`input num ${modified ? 'mod' : ''}`}
          inputMode="decimal"
          value={text}
          aria-invalid={error != null}
          aria-label={`${ruleId}: ${param.label} (${param.unit})`}
          title={`${param.min}–${param.max} ${param.unit} · Enter to apply, Esc to undo`}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') {
              e.stopPropagation();
              setText(formatParam(param, value));
              setError(null);
            }
          }}
        />
        <span className="a-param-u">{param.unit}</span>
      </label>
      {shared.length > 0 && <span className="a-param-shared">shared with {shared.join(', ')}</span>}
      {error && (
        <span className="a-param-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Detection rules with their thresholds in force (editable) and the rules that need integrations this release lacks. */
export function RulesTab() {
  const rules = useSimValue((s) => s.rules);
  const stats = useSimValue((s) => {
    const m: RuleStats = {};
    for (const e of s.events) {
      const k = e.trigger.ruleId;
      const x = (m[k] ??= { total: 0, open: 0, session: 0 });
      x.total++;
      if (e.status !== 'resolved') x.open++;
      if (!e.historical) x.session++;
    }
    return m;
  });
  const setRule = useSim((s) => s.setRule);
  const resetRules = useSim((s) => s.resetRules);
  const modified = modifiedCount(rules);

  const columns: Column<RuleDef>[] = [
    {
      key: 'rule',
      header: 'Rule',
      render: (d) => (
        <span className="a-wrap">
          <b className="a-rule-name">{d.label}</b>
          <span className="mono muted"> {d.id}</span>
          <span className="a-rule-desc">{d.description}</span>
        </span>
      ),
      sort: (d) => d.id,
    },
    { key: 'cat', header: 'Category', render: (d) => EVENT_CATEGORY_LABEL[d.category], sort: (d) => CATEGORY_ORDER.indexOf(d.category) },
    {
      key: 'threshold',
      header: 'Threshold in force',
      render: (d) => {
        const ps = ruleParams(d.id);
        if (!ps.length) return <span className="muted">No threshold — fires on the condition</span>;
        return (
          <div className="a-params">
            {ps.map((p) => (
              <ParamInput key={p.key} ruleId={d.id} param={p} value={rules[p.key]} modified={isModified(rules, p.key)} />
            ))}
          </div>
        );
      },
    },
    {
      key: 'default',
      header: 'Default',
      render: (d) => {
        const ps = ruleParams(d.id);
        if (!ps.length) return <span className="muted">—</span>;
        const mod = ps.some((p) => isModified(rules, p.key));
        return (
          <div className="a-defaults">
            {ps.map((p) => (
              <span key={p.key} className="num dim">
                {formatParam(p, DEFAULT_EVENT_RULES[p.key])} {p.unit}
              </span>
            ))}
            {mod && (
              <button className="btn ghost sm" onClick={() => ps.forEach((p) => setRule(p.key, DEFAULT_EVENT_RULES[p.key]))} title="Restore this rule's default threshold">
                <RotateCcw size={12} aria-hidden /> Default
              </button>
            )}
          </div>
        );
      },
    },
    {
      key: 'events',
      header: 'Events',
      numeric: true,
      title: 'Events detected by this rule (including the pre-rolled history) · still open',
      render: (d) => {
        const x = stats[d.id];
        return x ? (
          <span title={`${x.session} in this demo session`}>
            {fmtInt(x.total)}
            <span className="sub">{x.open} open</span>
          </span>
        ) : (
          <span className="muted">0</span>
        );
      },
      sort: (d) => stats[d.id]?.total ?? 0,
    },
  ];

  return (
    <>
      <div className="col-8">
        <Panel
          title="Event rules"
          subtitle={`${AVAILABLE.length} detection rules active · ${modified ? `${modified} threshold${modified === 1 ? '' : 's'} changed from default` : 'all thresholds at default'}`}
          flush
          actions={
            <button className="btn sm" onClick={resetRules} disabled={!modified} title="Restore every threshold to its default">
              <RotateCcw size={12} aria-hidden /> Reset all to defaults
            </button>
          }
          footer="Thresholds apply from the next simulated minute and stay in force until Reset Demo, which restores the defaults. Events already detected keep the threshold recorded in their trigger."
        >
          <div className="a-rules">
            <DataTable columns={columns} rows={AVAILABLE} rowKey={(d) => d.id} maxHeight="none" />
          </div>
        </Panel>
      </div>
      <div className="col-4 a-stack">
        <Panel title="Not available in this release" subtitle="Rules that need data this deployment does not have">
          <ul className="a-list">
            {UNAVAILABLE.map((d) => (
              <li key={d.id}>
                <b>{d.label}</b> <span className="mono muted">{d.id}</span>
                <br />
                Unavailable — {d.unavailableReason ?? 'not configured'}. {d.description}
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="How detection works" subtitle="Rule-based on the simulated signals">
          <ul className="a-list">
            <li>
              <b>Rules, not a model.</b> Every event is raised by one of these rules on simulated signals and records; the trigger, the values observed and
              the threshold are stored in the event.
            </li>
            <li>
              <b>One record.</b> A condition that persists updates its open event instead of raising a new one; the event clears when the condition does.
            </li>
            <li>
              <b>Causes are inferred.</b> Suspected causes are hypotheses with a confidence (confirmed / likely / possible), traced from correlated events.
            </li>
          </ul>
        </Panel>
      </div>
    </>
  );
}
