/**
 * Events & Reports — the shared event records of the simulated plant (production, quality, vehicles,
 * equipment condition, data feeds), each one investigable end to end, plus the report builder and the
 * detection rules that raise the events.
 *
 *   Events          compact filterable list + the selected event as an investigation (#/events/<id>)
 *   Reports         five report types, period + scope, live preview, PDF of the same model (?tab=reports)
 *   Detection rules the rule catalogue with editable thresholds and the unavailable rules (?tab=rules)
 *
 * The tab lives in the address (useWorkspaceTab), so links (openReports) and Back / Forward restore it.
 */
import { LoaderCircle } from 'lucide-react';
import { attentionEvents } from '../intel/kpis';
import { EVENT_RULE_DEFS } from '../sim/events';
import { useSim, useSimValue } from '../sim/store';
import { formatDuration } from '../sim/time';
import { PageHeader, Tabs, useWorkspaceTab } from '../ui/kit/Page';
import { EventsView } from './events/EventsView';
import { inWindow, windowRange } from './events/filters';
import { modifiedCount } from './events/rules';
import { ReportsView } from './events/ReportsView';
import { RulesView } from './events/RulesView';
import './events/events.css';

type EventsTabId = 'events' | 'reports' | 'rules';
const TABS: readonly EventsTabId[] = ['events', 'reports', 'rules'];
const RULES_RUNNING = EVENT_RULE_DEFS.filter((d) => d.available).length;
const RULES_UNAVAILABLE = EVENT_RULE_DEFS.length - RULES_RUNNING;

export function EventsPage() {
  const [tab, setTab] = useWorkspaceTab<EventsTabId>('events', 'events', TABS);
  const resetting = useSim((s) => s.resetting);
  const head = useSimValue((s) => {
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
    };
  });

  const top = head.attention[0];
  const critical = head.attention.filter((e) => e.severity === 'critical').length;
  const summary =
    tab === 'reports'
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
          { value: 'reports', label: 'Reports', title: 'Report builder: shift, OEE, quality, vehicles, incident — preview and PDF' },
          { value: 'rules', label: 'Detection rules', count: RULES_RUNNING, title: 'The rules that raise events, with their thresholds' },
        ]}
      />
      <div role="tabpanel" aria-label={tab === 'events' ? 'Events' : tab === 'reports' ? 'Reports' : 'Detection rules'} className="evp-panel">
        {tab === 'events' && <EventsView />}
        {tab === 'reports' && <ReportsView />}
        {tab === 'rules' && <RulesView />}
      </div>
    </div>
  );
}
