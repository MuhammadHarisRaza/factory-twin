/**
 * Detection rules tab of Events & Reports (moved from the retired Assets page): the rule catalogue
 * (EVENT_RULE_DEFS) with the thresholds in force — editable through the shared sim store (setRule /
 * resetRules; they apply from the next simulated minute) — the events each rule raised (a click lists
 * them in the Events tab), and the rules this release cannot run, with the reason. Below, the thresholds of the
 * insight rules (rule-engine findings) — see ./InsightThresholdEditor.tsx.
 */
import { useEffect, useState } from 'react';
import { CircleSlash, RotateCcw } from 'lucide-react';
import { useApp } from '../../app/store';
import { DEFAULT_EVENT_RULES } from '../../model/plant';
import type { EventCategory } from '../../model/types';
import { EVENT_CATEGORY_LABEL, EVENT_RULE_DEFS } from '../../sim/events';
import { useSim, useSimValue } from '../../sim/store';
import { DataTable, type Column } from '../../ui/kit/DataTable';
import { fmtInt } from '../../ui/kit/format';
import { Section } from '../../ui/kit/Page';
import { DEFAULT_FILTERS } from './filters';
import { formatParam, isModified, modifiedCount, parseParam, ruleParams, sharedWith, type RuleParam } from './rules';
import { InsightThresholds } from './InsightThresholdEditor';
import { useEventsView } from './state';

type RuleDef = (typeof EVENT_RULE_DEFS)[number];
type RuleStats = Record<string, { total: number; open: number; session: number }>;

const CATEGORY_ORDER: EventCategory[] = ['production', 'data', 'equipment', 'quality', 'logistics'];
export const AVAILABLE_RULES = EVENT_RULE_DEFS.filter((d) => d.available).sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
export const UNAVAILABLE_RULES = EVENT_RULE_DEFS.filter((d) => !d.available);

/** One threshold field: typed in display units, applied on Enter or when leaving the field (Esc undoes). */
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
    <div className="rl-param">
      <label>
        <span className="rl-param-l">{param.label}</span>
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
        <span className="rl-param-u">{param.unit}</span>
      </label>
      {shared.length > 0 && <span className="rl-param-shared">shared with {shared.join(', ')}</span>}
      {error && (
        <span className="rl-param-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Lists the events of one rule in the Events tab (all time, so the count matches). */
function showRuleEvents(ruleId: string) {
  useEventsView.getState().setFilters({ ...DEFAULT_FILTERS, window: 'all', query: ruleId });
  useApp.getState().setTab('events', null);
}

export function RulesView() {
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
        <span className="rl-wrap">
          <b className="rl-name">{d.label}</b>
          <span className="mono muted"> {d.id}</span>
          <span className="rl-desc">{d.description}</span>
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
          <div className="rl-params">
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
          <div className="rl-defaults">
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
      header: 'Events raised',
      numeric: true,
      title: 'Events detected by this rule (including the pre-rolled history) · still open',
      render: (d) => {
        const x = stats[d.id];
        return x ? (
          <button className="row-link rl-count" onClick={() => showRuleEvents(d.id)} title={`${x.session} in this demo session — list them in the Events tab`}>
            <span className="num">{fmtInt(x.total)}</span>
            <span className="sub">{x.open} open</span>
          </button>
        ) : (
          <span className="muted">0</span>
        );
      },
      sort: (d) => stats[d.id]?.total ?? 0,
    },
  ];

  return (
    <div className="rl-page">
      <div className="work rl">
        <Section
          title="Detection rules"
          subtitle={`${AVAILABLE_RULES.length} rules running on the simulated signals and records · ${modified ? `${modified} threshold${modified === 1 ? '' : 's'} changed from default` : 'all thresholds at default'}`}
          flush
          actions={
            <button className="btn sm" onClick={resetRules} disabled={!modified} title="Restore every threshold to its default">
              <RotateCcw size={12} aria-hidden /> Reset all to defaults
            </button>
          }
        >
          <div className="rl-table">
            <DataTable columns={columns} rows={AVAILABLE_RULES} rowKey={(d) => d.id} maxHeight="none" />
          </div>
          <p className="rl-foot">
            Thresholds apply from the next simulated minute and stay in force until Reset Demo, which restores the defaults. Events already detected keep the threshold recorded in
            their trigger.
          </p>
        </Section>
        <div className="rl-side">
          <Section title="Not available in this release" subtitle="Rules that need data this deployment does not have">
            <ul className="rl-list">
              {UNAVAILABLE_RULES.map((d) => (
                <li key={d.id}>
                  <CircleSlash size={13} aria-hidden />
                  <div>
                    <b>{d.label}</b> <span className="mono muted">{d.id}</span>
                    <span className="rl-why">Unavailable — {d.unavailableReason ?? 'not configured'}.</span>
                    <span className="rl-desc">{d.description}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="How detection works">
            <ul className="rl-list plain">
              <li>
                <b>Rules, not a model.</b> Every event is raised by one of these rules on simulated signals and records; the trigger, the values observed and the threshold are
                stored with the event.
              </li>
              <li>
                <b>One record per condition.</b> A condition that persists updates its open event instead of raising a new one; the event clears when the condition does.
              </li>
              <li>
                <b>Causes are inferred.</b> Suspected causes carry a confidence — confirmed, likely or possible — traced from correlated events.
              </li>
              <li>
                <b>Simulated inspection.</b> Defect classes come from SIM-CV v0 (simulated) — no vision model is connected.
              </li>
            </ul>
          </Section>
        </div>
      </div>
      <InsightThresholds />
    </div>
  );
}
