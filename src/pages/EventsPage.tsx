/**
 * Events & Reports — the shared event records of the simulated plant (production, quality, vehicles,
 * equipment condition, data feeds), each one investigable end to end, plus the report builder and the
 * detection rules that raise the events.
 *
 *   Events          compact filterable list + the selected event as an investigation (#/events/<id>)
 *   Reports         five report types, period + scope, live preview, PDF of the same model (?tab=reports)
 *   Reliability     downtime Pareto, recurring faults, longest stops, MTBF / MTTR, state timelines (?tab=reliability)
 *   Data & connectivity  sources, catalogue coverage, missing signals, feed freshness, data-quality findings (?tab=data)
 *   Detection rules the rule catalogue with editable thresholds, the insight-rule thresholds and the unavailable rules (?tab=rules)
 *
 * The tab lives in the address (useWorkspaceTab), so links (openReports) and Back / Forward restore it.
 */
import { LoaderCircle } from 'lucide-react';
import { attentionEvents } from '../intel/kpis';
import { EVENT_RULE_DEFS } from '../sim/events';
import { useSim, useSimValue } from '../sim/store';
import { formatDuration } from '../sim/time';
import { PageHeader, Tabs, useWorkspaceTab } from '../ui/kit/Page';
import { coverageRows } from './events/coverage';
import { DataView } from './events/DataView';
import { EventsView } from './events/EventsView';
import { inWindow, windowRange } from './events/filters';
import { reliabilityHeadline } from './events/reliability';
import { ReliabilityView } from './events/ReliabilityView';
import { modifiedCount } from './events/rules';
import { ReportsView } from './events/ReportsView';
import { RulesView } from './events/RulesView';
import { useReliabilityView } from './events/state';
import './events/events.css';

export type EventsTabId = 'events' | 'reliability' | 'data' | 'reports' | 'rules';
const TABS: readonly EventsTabId[] = ['events', 'reliability', 'data', 'reports', 'rules'];
const TAB_LABEL: Record<EventsTabId, string> = { events: 'Events', reliability: 'Reliability', data: 'Data & connectivity', reports: 'Reports', rules: 'Detection rules' };
const COVERAGE = coverageRows().total;
const DATA_SUMMARY = `No plant system is connected in this demo — every value is simulated. Of ${COVERAGE.total} catalogue signals, ${COVERAGE.simulated} are simulated, ${COVERAGE.notModelled} not modelled and ${COVERAGE.unavailable} unavailable without an integration.`;
const RULES_RUNNING = EVENT_RULE_DEFS.filter((d) => d.available).length;
const RULES_UNAVAILABLE = EVENT_RULE_DEFS.length - RULES_RUNNING;

export function EventsPage() {
  const [tab, setTab] = useWorkspaceTab<EventsTabId>('events', 'events', TABS);
  const resetting = useSim((s) => s.resetting);
  const relWindow = useReliabilityView((v) => v.window);
  const head = useSimValue(
    (s) => {
      const attention = attentionEvents(s);
      // The Events tab's "24 h" window (the header's Last 24 hours), so the count matches the default list.
      const w = windowRange('24h', s.minute);
      const day = s.events.filter((e) => inWindow(e, w, s.minute));
      return {
        attention,
        open: s.events.filter((e) => e.status !== 'resolved').length,
        day: day.length,
        dayScenario: day.filter((e) => e.source === 'scenario').length,
        rulesChanged: modifiedCount(s.rules),
        now: s.minute,
        reliability: tab === 'reliability' ? reliabilityHeadline(s, relWindow) : '',
        staleFeeds: Object.values(s.feeds).filter((f) => f.status === 'stale').length,
      };
    },
    [tab, relWindow],
  );

  const top = head.attention[0];
  const critical = head.attention.filter((e) => e.severity === 'critical').length;
  const summary =
    tab === 'reliability'
      ? head.reliability
      : tab === 'data'
        ? `${DATA_SUMMARY}${head.staleFeeds ? ` ${head.staleFeeds} asset feed${head.staleFeeds === 1 ? ' is' : 's are'} stale now.` : ''}`
        : tab === 'reports'
          ? 'Build a shift, OEE, quality, vehicle or incident report for a period and scope, preview it, and download the same report as a PDF — every figure comes from the same data as the rest of the app.'
          : tab === 'rules'
            ? `${RULES_RUNNING} detection rules run on the simulated signals and records${head.rulesChanged ? `; ${head.rulesChanged} threshold${head.rulesChanged === 1 ? ' is' : 's are'} changed from default` : ''}. ${RULES_UNAVAILABLE} more need integrations this release does not have.`
            : top
              ? `${head.attention.length} issue${head.attention.length === 1 ? ' needs' : 's need'} attention${critical ? ` (${critical} critical)` : ''} — most severe: ${top.id} ${top.title}, ${top.end == null ? `ongoing for ${formatDuration(head.now - top.start)}` : 'condition cleared, not yet resolved'}. ${head.day} events in the last 24 h, ${head.dayScenario} caused by demo scenarios.`
              : `No open issue needs attention. ${head.day} events in the last 24 h, ${head.dayScenario} caused by demo scenarios.`;

  return (
    <div className="wp evp">
      <PageHeader title="Events & Reports" context={<span>Whole factory · all event records · detection rules on simulated data</span>} summary={summary} />
      {resetting && (
        <div className="notice" role="status">
          <LoaderCircle size={15} className="spin" aria-hidden />
          <span>
            <b>Reset Demo is rebuilding the seeded history.</b> Events and reports refresh when it completes.
          </span>
        </div>
      )}
      <Tabs<EventsTabId>
        label="Events & Reports views"
        value={tab}
        onChange={(t) => setTab(t)}
        options={[
          { value: 'events', label: 'Events', count: head.open, title: 'Event records — the count is events not yet resolved' },
          { value: 'reliability', label: 'Reliability', title: 'Downtime Pareto, recurring faults, longest stops, MTBF / MTTR and equipment states' },
          { value: 'data', label: 'Data & connectivity', title: 'Data sources, signal coverage, missing signals, feed freshness and data-quality findings' },
          { value: 'reports', label: 'Reports', title: 'Report builder: shift, OEE, quality, vehicles, incident — preview and PDF' },
          { value: 'rules', label: 'Detection rules', count: RULES_RUNNING, title: 'The rules that raise events, with their thresholds' },
        ]}
      />
      <div role="tabpanel" aria-label={TAB_LABEL[tab]} className="evp-panel">
        {tab === 'events' && <EventsView />}
        {tab === 'reliability' && <ReliabilityView />}
        {tab === 'data' && <DataView />}
        {tab === 'reports' && <ReportsView />}
        {tab === 'rules' && <RulesView />}
      </div>
    </div>
  );
}
