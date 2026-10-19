/**
 * The Reliability and Data & connectivity tabs and the insight-rule thresholds editor (Detection rules), server
 * rendered, plus the editor's pure helpers: display units, Default / Configured, the event-rule mirror, and a
 * value change reaching useRuleThresholds (whose version invalidates the findings memo).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { useApp } from '../../app/store';
import { RULES, RULE_PARAM_DEFAULTS, findingsFor, paramKey, useRuleThresholds } from '../../intel/rules';
import { DEFAULT_EVENT_RULES } from '../../model/plant';
import { useSim } from '../../sim/store';
import { EventsPage } from '../EventsPage';
import { commitInsightParam, displayRange, formatInsight, insightRuleRows, overrideCount, parseInsight, sourceLabel } from './insightThresholds';
import { useDataView, useInsightFilters, useReliabilityView } from './state';

useSim.getState().pause();

const render = (node: React.ReactNode) => {
  Object.assign(useSim.getInitialState(), useSim.getState());
  Object.assign(useApp.getInitialState(), useApp.getState());
  Object.assign(useReliabilityView.getInitialState(), useReliabilityView.getState());
  Object.assign(useDataView.getInitialState(), useDataView.getState());
  Object.assign(useInsightFilters.getInitialState(), useInsightFilters.getState());
  Object.assign(useRuleThresholds.getInitialState(), useRuleThresholds.getState());
  return renderToStaticMarkup(node);
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const openTab = (tab: string) => useApp.setState({ workspace: 'events', tabs: { events: tab } });

const HONESTY = (t: string, tilesPerHour = false) => {
  expect(t).not.toMatch(/\bAI\b/);
  expect(t).not.toMatch(/Ghani/i);
  // Reliability and Data show no rate at all; rule descriptions may name tiles/h for the stages after pressing.
  if (!tilesPerHour) expect(t).not.toMatch(/tiles\/h/);
  else expect(t).not.toMatch(/(powder|slip|silo)[^,.;]{0,30}tiles\/h/i);
};

beforeAll(() => {
  useRuleThresholds.getState().reset();
});
afterEach(() => useRuleThresholds.getState().reset());

describe('Reliability tab', () => {
  it('renders the window, the stop classes, the Pareto, the tables, the timelines and the findings', () => {
    openTab('reliability');
    useReliabilityView.setState({ window: '24h', cls: 'unplanned', by: 'reason', lanes: 'machines' });
    const t = text(render(<EventsPage />));
    for (const label of [
      'Reliability',
      'Data & connectivity',
      'Unplanned stops',
      'Changeover stops',
      'Planned stops',
      'Downtime Pareto — unplanned stops',
      'By reason',
      'By equipment',
      'Longest unplanned stops',
      'Recurring fault codes',
      'MTBF / MTTR per asset',
      'Equipment states',
      'Reliability rule findings',
      'Communication & data-quality issues',
      'unplanned downtime',
    ])
      expect(t, label).toContain(label);
    expect(t).toMatch(/Unavailable/); // MTBF of an asset without failure
    HONESTY(t);
  }, 60_000);
});

describe('Data & connectivity tab', () => {
  it('states that nothing is connected and renders sources, coverage, equipment, gaps, freshness and findings', () => {
    openTab('data');
    const html = render(<EventsPage />);
    const t = text(html);
    for (const label of [
      'No plant system is connected in this demo',
      'docs/INTEGRATION.md',
      'docs/SIGNALS.md',
      'Data sources',
      'Not connected',
      'Simulated',
      'Signal catalogue coverage by stage',
      'Not present — flagged for configuration',
      'Partial',
      'Coverage per equipment',
      'Signals without a value in this demo',
      'All source systems',
      'Asset feed freshness',
      'Stale since',
      'Data-quality findings',
    ])
      expect(t, label).toContain(label);
    // No source or entry claims a working connection.
    expect(html).not.toContain('prov-connected');
    // Every mention of 'connected' is a negation ('Not connected', 'no MES is connected') or a hypothetical
    // ('a connected vision system would …') — never a claim that something is connected.
    const claims = [...t.matchAll(/[^.·—]{0,60}\bconnected\b[^.·—]{0,40}/gi)].map((m) => m[0]).filter((x) => !/\b(no|not|none|would)\b/i.test(x));
    expect(claims).toEqual([]);
    HONESTY(t);
  }, 60_000);

  it('applies the equipment search and the gap filters', () => {
    openTab('data');
    useDataView.setState({ equipmentQuery: 'zzzz-no-such', gaps: { ...useDataView.getState().gaps, query: 'zzzz-no-such' } });
    const t = text(render(<EventsPage />));
    expect(t).toContain('No equipment matches the search');
    expect(t).toContain('No catalogue entry matches these filters');
    useDataView.setState({ equipmentQuery: '', gaps: { ...useDataView.getState().gaps, query: '' } });
  }, 60_000);
});

describe('Insight rule thresholds', () => {
  const rule = RULES.find((d) => d.params.some((p) => !p.mirrors))!;
  const param = rule.params.find((p) => !p.mirrors)!;
  const key = paramKey(rule.id, param.key);
  /** A valid value one step away from the default, in display units. */
  const bumped = () => {
    const { max, step } = displayRange(param);
    const cur = Number(formatInsight(param, param.default));
    const d = step ?? 1;
    return max != null && cur + d > max ? cur - d : cur + d;
  };

  it('lists every rule with its params, Default by default', () => {
    const rows = insightRuleRows({}, DEFAULT_EVENT_RULES);
    expect(rows).toHaveLength(RULES.length);
    for (const r of rows) {
      expect(['Rule-based', 'Statistical']).toContain(r.classificationLabel);
      for (const p of r.params) {
        expect(p.value).toBe(RULE_PARAM_DEFAULTS[p.key]);
        expect(sourceLabel(p)).toMatch(/^Default/);
      }
    }
    // A parameter mirroring an event-rule threshold follows it until configured here.
    const mirrored = rows.flatMap((r) => r.params).find((p) => p.mirror);
    if (mirrored) {
      const changed = { ...DEFAULT_EVENT_RULES, [mirrored.mirror!.field]: DEFAULT_EVENT_RULES[mirrored.mirror!.field] * 1.5 };
      const row = insightRuleRows({}, changed).flatMap((r) => r.params).find((p) => p.key === mirrored.key)!;
      expect(row.source).toBe('event-rule');
      expect(row.mirror!.changed).toBe(true);
      expect(sourceLabel(row)).toMatch(/^Follows/);
    }
  });

  it('filters by family and text', () => {
    expect(insightRuleRows({}, DEFAULT_EVENT_RULES, { family: 'reliability', query: '' }).every((r) => r.def.family === 'reliability')).toBe(true);
    expect(insightRuleRows({}, DEFAULT_EVENT_RULES, { family: 'all', query: rule.id }).map((r) => r.def.id)).toContain(rule.id);
    expect(insightRuleRows({}, DEFAULT_EVENT_RULES, { family: 'all', query: 'zzzz-no-such' })).toEqual([]);
  });

  it('parses display units and refuses out-of-range values', () => {
    const shown = formatInsight(param, param.default);
    const r = parseInsight(param, shown);
    expect(r.ok && Math.abs(r.value - param.default) < 1e-9).toBe(true);
    const { max } = displayRange(param);
    if (max != null) expect(parseInsight(param, String(max + 1000)).ok).toBe(false);
    expect(parseInsight(param, 'abc').ok).toBe(false);
  });

  it('writes a changed value to useRuleThresholds, marks it Configured, bumps the version, and resets back', () => {
    const v0 = useRuleThresholds.getState().version;
    const s = useSim.getState().sim;
    const before = findingsFor(s, { kind: 'plant' });
    const next = bumped();
    const r = commitInsightParam(key, String(next), DEFAULT_EVENT_RULES);
    expect(r.ok).toBe(true);
    const st = useRuleThresholds.getState();
    expect(key in st.values).toBe(true);
    expect(st.version).toBeGreaterThan(v0);
    expect(overrideCount(st.values)).toBe(1);
    const row = insightRuleRows(st.values, DEFAULT_EVENT_RULES).find((x) => x.def.id === rule.id)!.params.find((p) => p.key === key)!;
    expect(sourceLabel(row)).toBe('Configured');
    // The findings memo is keyed by the version: a fresh evaluation, not the cached array.
    expect(findingsFor(s, { kind: 'plant' })).not.toBe(before);
    // Typing the default again removes the override.
    commitInsightParam(key, formatInsight(param, param.default), DEFAULT_EVENT_RULES);
    expect(key in useRuleThresholds.getState().values).toBe(false);
  });

  it('renders the editor on the Detection rules tab with Configured and Reset', () => {
    commitInsightParam(key, String(bumped()), DEFAULT_EVENT_RULES);
    openTab('rules');
    useInsightFilters.setState({ family: 'all', query: '' });
    const html = render(<EventsPage />);
    const t = text(html);
    for (const label of ['Detection rules', 'Insight rule thresholds', 'All families', 'Reset all to defaults', 'Configured', rule.id, rule.title, '1 configured value']) expect(t, label).toContain(label);
    expect(html).toMatch(/type="number"/);
    if (RULES.some((d) => d.params.some((p) => p.mirrors))) expect(t).toContain('Mirrors the event-rule threshold');
    HONESTY(t, true);
  }, 60_000);
});
