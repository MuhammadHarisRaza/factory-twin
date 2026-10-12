/**
 * Overview — the operational command view. Answers "what is happening, and what needs attention?"
 * for the current shift in one screen:
 *   header (factory · line · shift · plant time, SIMULATED) → a data-driven executive summary →
 *   five KPIs → the live 3D factory (the one shared scene) with the issues requiring attention beside
 *   it → the production flow strip across the page under both.
 * Every figure comes from the shared simulation through the shared metric / KPI / event layers.
 */
import { CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { executiveSummary } from '../intel/summary';
import { FACTORY, LINE } from '../model/plant';
import { useSimValue } from '../sim/store';
import { formatClock, formatDay, shiftAt } from '../sim/time';
import { FlowStrip } from '../ui/flow/FlowStrip';
import { PageHeader, Section } from '../ui/kit/Page';
import { IssuesPanel } from './overview/Issues';
import { OverviewKpis } from './overview/Kpis';
import { OverviewTwin } from './overview/OverviewTwin';
import './overview/overview.css';

function Context() {
  const minute = useSimValue((s) => s.minute);
  const sh = shiftAt(minute);
  return (
    <>
      <span className="ov-ctx-i" title={FACTORY.reference}>
        {FACTORY.name}
      </span>
      <span className="ov-ctx-i">{LINE.name}</span>
      <span className="ov-ctx-i">
        Shift {sh.id} · {formatClock(sh.start)}–{formatClock(sh.end)}
      </span>
      <span className="ov-ctx-i" title="Simulated plant clock (see the clock and speed control in the header)">
        Plant time {formatDay(minute)} <b className="num">{formatClock(minute)}</b>
      </span>
    </>
  );
}

function Summary() {
  const sum = useSimValue((s) => executiveSummary(s));
  const Icon = sum.state === 'normal' ? CircleCheck : sum.state === 'no-data' ? Info : TriangleAlert;
  return (
    <span className={`ov-sum ${sum.state}`}>
      <Icon size={15} strokeWidth={2.2} aria-hidden />
      <span>{sum.text}</span>
    </span>
  );
}

export function OverviewPage() {
  return (
    <div className="wp ov">
      <PageHeader title="Overview" context={<Context />} summary={<Summary />} provenance="simulated" />
      <OverviewKpis />
      {/* Model with the issues beside it (from 1280 px), the flow strip across both columns below; stacked below 1280 px. */}
      <div className="ov-work">
        <OverviewTwin />
        <IssuesPanel />
        <Section title="Production flow" subtitle="Current shift · status now, output so far · select a stage to highlight it in the model" className="ov-flow">
          <FlowStrip detail={false} />
        </Section>
      </div>
    </div>
  );
}
