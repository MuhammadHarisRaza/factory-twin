import { describe, it } from 'vitest';
import { createSim } from './sim/engine';
import { DEFAULT_START } from './sim/time';
import { DEFAULT_FINANCE } from './sim/finance';
import { DEFAULT_TARIFFS } from './sim/energy';
import { resolvePeriod } from './sim/metrics';
import { MONITORED_STAGES } from './model/plant';
import * as mon from './pages/monitoring/derive';
import * as cmd from './pages/command/derive';
import * as loss from './pages/production/loss';
import * as prod from './pages/production/derive';
import * as pipe from './pages/fleet/pipeline';
import * as fleet from './pages/fleet/derive';
import { insights } from './intel/insights';
import * as twin from './ui/twin/derive';
import { situationNow } from './pages/copilot/derive';
import { copilotEventReport, ask } from './intel/copilot';
import { assetRows } from './pages/health/derive';

const time = (fn: () => unknown, n = 5) => {
  fn();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
};

describe('perf probe 2', () => {
  it('page selectors', () => {
    const s = createSim(undefined, DEFAULT_START);
    const out: [string, number][] = [];
    const m = (label: string, fn: () => unknown) => out.push([label, time(fn)]);
    for (const pk of ['shift', '24h', '7d'] as const) {
      const p = resolvePeriod(pk, s.minute);
      m(`mon.overview ${pk}`, () => mon.overview(s, p));
      m(`mon.stageLosses all ${pk}`, () => MONITORED_STAGES.map((ms) => mon.stageLosses(s, ms, p)));
      m(`mon.stageTrend KILN ${pk}`, () => mon.stageTrend(s, MONITORED_STAGES.find((x) => x.id === 'KILN')!, p));
      m(`loss.lossLedger ${pk}`, () => loss.lossLedger(s, p, DEFAULT_FINANCE, DEFAULT_TARIFFS));
      m(`cmd.machineLosses ${pk}`, () => cmd.machineLosses(s, p));
      m(`prod.lineTrend ${pk}`, () => prod.lineTrend(s, p, prod.granularityFor(p)));
      m(`fleet.truckRows ${pk}`, () => pipe.truckRows(s, p));
      m(`fleet.eventLog ${pk}`, () => fleet.eventLog(s, p));
      m(`fleet.ruleRows ${pk}`, () => pipe.ruleRows(s, p));
      m(`insights ${pk}`, () => insights(s, { period: p, tariffs: DEFAULT_TARIFFS }));
    }
    m('mon.shiftSummary all', () => MONITORED_STAGES.map((ms) => mon.shiftSummary(s, ms)));
    m('cmd.attentionList', () => cmd.attentionList(s));
    m('cmd.useCases', () => cmd.useCases(s, DEFAULT_FINANCE));
    m('cmd.strip', () => cmd.strip(s, DEFAULT_TARIFFS));
    m('cmd.timeline', () => cmd.timeline(s));
    m('cmd.eventActions', () => cmd.eventActions(s));
    m('cmd.qualityExceptions', () => cmd.qualityExceptions(s));
    m('cmd.stageIssues', () => cmd.stageIssues(s));
    m('cmd.shiftCompare', () => cmd.shiftCompare(s));
    m('insights default', () => insights(s, { tariffs: DEFAULT_TARIFFS }));
    m('twin.lineStatus', () => twin.lineStatus(s));
    m('twin.shiftTimeline', () => twin.shiftTimeline(s));
    m('twin.liveEvents', () => twin.liveEvents(s));
    m('situationNow', () => situationNow(s));
    m('health.assetRows', () => assetRows(s));
    m('fleet.pipeline', () => pipe.pipeline(s));
    m('fleet.internalDwell', () => pipe.internalDwell(s));
    const ev = s.events[s.events.length - 1];
    m('copilotEventReport last', () => copilotEventReport(s, ev.id, DEFAULT_FINANCE, DEFAULT_TARIFFS));
    for (const q of ['What is happening now?', 'Why is OEE below target?', 'What did the losses cost this shift?', 'Which trucks are waiting?'])
      m(`ask "${q}"`, () => ask(s, q, DEFAULT_TARIFFS, { finance: DEFAULT_FINANCE }));
    out.sort((a, b) => b[1] - a[1]);
    console.log(out.map(([l, v]) => `${v.toFixed(2).padStart(8)} ms  ${l}`).join('\n'));
  }, 300_000);
});
