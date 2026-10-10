/**
 * Operations copilot — deterministic, rule-based question answering over the live
 * simulation state. No LLM is connected: questions are matched to intents by keywords
 * and every answer is assembled from the same metrics and insights the dashboards show,
 * with the facts it used and links to where they can be inspected.
 */
import { EQUIPMENT, EQUIPMENT_BY_ID } from '../data/equipment';
import { DEFECTS, LINE, M2_PER_TILE, OPS_BY_ID, REASON_BY_CODE, STAGE_BY_ID, TARGET } from '../model/plant';
import type { SimState } from '../sim/engine';
import { DEFAULT_TARIFFS, type Tariffs } from '../sim/energy';
import { HEALTH_BY_ID, assess, formatH } from '../sim/health';
import {
  bottleneck,
  HELD_UP_SHARE,
  targetStatus,
  defectShift,
  downtimePareto,
  energyIn,
  fleetMetrics,
  kilnIdleBurn,
  lineMetrics,
  machineMetrics,
  qualityIn,
  resolvePeriod,
  stageMetrics,
  type PeriodKey,
} from '../sim/metrics';
import { formatClock, formatDuration } from '../sim/time';
import { DEFECT_ACTIONS, REASON_ACTIONS, healthAssessments, insights, nextActions, type InsightLink } from './insights';

export type CopilotIntent =
  | 'below-target'
  | 'bottleneck'
  | 'largest-downtime'
  | 'kiln'
  | 'defects'
  | 'next-actions'
  | 'energy'
  | 'health'
  | 'oee'
  | 'logistics'
  | 'machine'
  | 'help';

export type CopilotAnswer = {
  intent: CopilotIntent;
  /** Plain-language answer, one or more short paragraphs. */
  text: string[];
  /** Facts the answer used (label → value). */
  facts: { label: string; value: string }[];
  links: InsightLink[];
  /** Period the figures refer to. */
  periodLabel: string;
  followUps: string[];
};

export const SUGGESTED_QUESTIONS = [
  "Why is today's production below target?",
  'Which machine is the main bottleneck?',
  'What caused the largest downtime loss?',
  'How is the kiln affecting production?',
  'Which defect category has increased?',
  'What should the shift supervisor do next?',
  'Is any machine at risk of failure?',
  'Where are we wasting energy?',
];

const pct = (f: number | null | undefined, d = 1) => (f == null ? '—' : `${(f * 100).toFixed(d)} %`);
const m2 = (tiles: number) => `${Math.round(tiles * M2_PER_TILE).toLocaleString('en-GB')} m²`;
const has = (q: string, words: string[]) => words.some((w) => q.includes(w));

function classify(q: string): CopilotIntent {
  if (has(q, ['supervisor', 'what should', 'next step', 'next action', 'do next', 'recommend', 'priorit'])) return 'next-actions';
  if (has(q, ['bottleneck', 'constraint', 'limiting', 'slowest', 'holding back'])) return 'bottleneck';
  if (has(q, ['kiln', 'firing'])) return 'kiln';
  if (has(q, ['defect', 'reject', 'quality', 'scrap', 'crack', 'glaze', 'shade', 'chip'])) return 'defects';
  if (has(q, ['energy', 'gas', 'power', 'electric', 'kwh', 'wasting'])) return 'energy';
  if (has(q, ['health', 'vibration', 'maintenance', 'failure', 'fail', 'predict', 'bearing', 'at risk'])) return 'health';
  if (has(q, ['truck', 'dock', 'yard', 'forklift', 'dispatch', 'logistic', 'vehicle'])) return 'logistics';
  if (has(q, ['downtime', 'stoppage', 'stopped', 'loss', 'losing', 'breakdown'])) return 'largest-downtime';
  if (has(q, ['below target', 'behind', 'target', 'short', 'output', 'production'])) return 'below-target';
  if (has(q, ['oee', 'availability', 'performance', 'effectiveness'])) return 'oee';
  return 'help';
}

/** Finds an equipment item mentioned by id or (part of) its name. */
function findMachine(q: string) {
  const byId = EQUIPMENT.find((e) => q.includes(e.id.toLowerCase()));
  if (byId) return byId.id;
  const aliases: [RegExp, string][] = [
    [/press(?:\s*#?\s*)1\b/, 'E-PRS1'],
    [/press(?:\s*#?\s*)2\b/, 'E-PRS2'],
    [/press(?:\s*#?\s*)3\b/, 'E-PRS3'],
    [/mill(?:\s*#?\s*)1\b/, 'C-BM1'],
    [/mill(?:\s*#?\s*)2\b/, 'C-BM2'],
    [/mill(?:\s*#?\s*)3\b/, 'C-BM3'],
    [/spray dryer|atomi[sz]er/, 'D-TWR'],
    [/roller dryer|\bdryer\b/, 'F-DRY'],
    [/inkjet|printer/, 'G-INK'],
    [/glaz(e|ing) line/, 'G-LINE'],
    [/palleti[sz]er|robot/, 'J-PAL'],
    [/sorter|sorting/, 'I-SORT'],
  ];
  for (const [re, id] of aliases) if (re.test(q)) return id;
  return null;
}

function periodFor(q: string): PeriodKey {
  if (q.includes('today')) return 'today';
  if (q.includes('week')) return '7d';
  if (q.includes('24')) return '24h';
  if (q.includes('previous shift') || q.includes('last shift')) return 'prev-shift';
  return 'shift';
}

/** A period label inside a sentence: "Today" → "today", "Shift A · 06:00–14:00" → "shift A · 06:00–14:00". */
const inPeriod = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

export function ask(s: SimState, question: string, tariffs: Tariffs = DEFAULT_TARIFFS): CopilotAnswer {
  const q = question.toLowerCase().trim();
  const p = resolvePeriod(periodFor(q), s.minute);
  const machine = findMachine(q);
  let intent = classify(q);
  if (machine && (intent === 'help' || intent === 'health' || intent === 'below-target' || intent === 'oee')) intent = intent === 'health' ? 'health' : 'machine';
  const base = { periodLabel: p.label };

  switch (intent) {
    case 'below-target': {
      const lm = lineMetrics(s, p);
      const pareto = downtimePareto(s, p).slice(0, 3);
      const bn = bottleneck(s);
      const losses = lossBreakdown(s, p.from, p.to);
      const status = targetStatus(lm.attainment);
      const behind = status === 'behind' || status === 'well-behind';
      return {
        ...base,
        intent,
        text: [
          behind
            ? `Output for ${inPeriod(p.label)} is ${m2(lm.output)} against a target of ${m2(lm.target)} — ${pct(lm.attainment, 0)} of target, ${m2(lm.target - lm.output)} behind.`
            : `Output for ${inPeriod(p.label)} is ${status === 'ahead' ? 'ahead of target' : 'on track'}: ${m2(lm.output)} (${pct(lm.attainment, 0)} of ${m2(lm.target)})${lm.output < lm.target ? ` — ${m2(lm.target - lm.output)} short, within normal variation` : ''}.`,
          `Line OEE is ${pct(lm.oee.oee.value)} (target ${pct(TARGET.oeeTarget, 0)}). The biggest loss is ${losses[0].label.toLowerCase()} (${pct(losses[0].share, 0)} of lost constraint time), followed by ${losses[1].label.toLowerCase()}.`,
          pareto.length
            ? `The largest stoppage reasons were ${pareto.map((r) => `${r.label.toLowerCase()} (${Math.round(r.minutes)} min)`).join(', ')}. The line is currently constrained by ${bn.current.name.toLowerCase()}${bn.shifted ? ', not the kiln as designed' : ''}.`
            : `There were no unplanned stoppages; the line is currently constrained by ${bn.current.name.toLowerCase()}.`,
        ],
        facts: [
          { label: 'Output', value: m2(lm.output) },
          { label: 'Target', value: m2(lm.target) },
          { label: 'Availability', value: pct(lm.oee.availability.value) },
          { label: 'Performance', value: pct(lm.oee.performance.value) },
          { label: 'Quality', value: pct(lm.oee.quality.value) },
          { label: 'OEE', value: pct(lm.oee.oee.value) },
        ],
        links: [{ kind: 'workspace', id: 'production', label: 'Open Production & OEE' }, ...bnLinks(bn.current.stage)],
        followUps: ['Which machine is the main bottleneck?', 'What caused the largest downtime loss?'],
      };
    }
    case 'bottleneck': {
      const bn = bottleneck(s);
      const c = bn.current;
      const k = bn.constraint;
      const kilnName = STAGE_BY_ID[LINE.designConstraint].name.toLowerCase();
      const machines = STAGE_BY_ID[c.stage].machines.join(', ');
      const up = bn.stages.filter((r) => bn.stages.indexOf(r) < bn.stages.indexOf(c) && r.blockedShare > HELD_UP_SHARE).map((r) => r.name.toLowerCase());
      const down = bn.stages.filter((r) => bn.stages.indexOf(r) > bn.stages.indexOf(c) && r.starvedShare > HELD_UP_SHARE).map((r) => r.name.toLowerCase());
      return {
        ...base,
        periodLabel: bn.period.label,
        intent,
        text: [
          bn.cause === 'constraint'
            ? `${c.name} (${machines}) is the bottleneck, as designed: over the last 2 hours it was starved ${pct(c.starvedShare, 0)} and blocked ${pct(c.blockedShare, 0)} of the time, so the line output is set by the kiln's own rate and stops.`
            : bn.cause === 'starving'
              ? `${c.name} (${machines}) is the current bottleneck: the kiln waited for tiles ${pct(k.starvedShare, 0)} of the last 2 hours, and ${c.name.toLowerCase()} is the first stage upstream that was not itself waiting (active ${pct(c.activeShare, 0)}, down ${pct(c.downShare, 0)}).`
              : `${c.name} (${machines}) is the current bottleneck: the kiln was blocked ${pct(k.blockedShare, 0)} of the last 2 hours because ${c.name.toLowerCase()} could not take its output.`,
          bn.shifted
            ? `The designed constraint is ${kilnName}; every minute it waits on ${c.name.toLowerCase()} is output lost for the whole line.${up.length ? ` Blocked upstream: ${up.join(', ')}.` : ''}${down.length ? ` Starved downstream: ${down.join(', ')}.` : ''}`
            : `${down.length ? `Downstream stages wait on it (starved: ${down.join(', ')}), ` : ''}${up.length ? `upstream stages are held back (blocked: ${up.join(', ')}). ` : ''}Keep it fed and running — a lost kiln minute cannot be recovered later.`,
          `Method: starting at the kiln, a starved constraint is traced upstream (blocked: downstream) past every stage that was itself held up more than ${pct(HELD_UP_SHARE, 0)} of the window.`,
        ],
        facts: bn.stages.map((r) => ({ label: r.name, value: `${pct(r.activeShare, 0)} active · ${pct(r.starvedShare, 0)} starved · ${pct(r.blockedShare, 0)} blocked` })),
        links: [...bnLinks(c.stage), { kind: 'workspace', id: 'production', label: 'Open bottleneck analysis' }],
        followUps: ['How is the kiln affecting production?', 'What should the shift supervisor do next?'],
      };
    }
    case 'largest-downtime': {
      const pareto = downtimePareto(s, p);
      if (!pareto.length)
        return { ...base, intent, text: [`No unplanned downtime has been recorded in ${inPeriod(p.label)}.`], facts: [], links: [], followUps: SUGGESTED_QUESTIONS.slice(0, 2) };
      const top = pareto[0];
      const events = s.downtime.filter((d) => d.reasonCode === top.key && d.start < p.to && (d.end ?? s.minute) > p.from);
      const byMachine = new Map<string, number>();
      for (const d of events) byMachine.set(d.equipmentId, (byMachine.get(d.equipmentId) ?? 0) + ((d.end ?? s.minute) - d.start));
      const worst = [...byMachine.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        ...base,
        intent,
        text: [
          `The largest downtime loss in ${inPeriod(p.label)} is ${top.label.toLowerCase()}: ${Math.round(top.minutes)} min over ${top.events} event${top.events > 1 ? 's' : ''} (${pct(top.share, 0)} of unplanned downtime).`,
          worst ? `Most of it was on ${worst[0]} (${EQUIPMENT_BY_ID[worst[0]].name}, ${Math.round(worst[1])} min).` : '',
          REASON_ACTIONS[top.key] ? `Standard response: ${REASON_ACTIONS[top.key]}` : '',
        ].filter(Boolean),
        facts: pareto.slice(0, 5).map((r) => ({ label: r.label, value: `${Math.round(r.minutes)} min · ${r.events}×` })),
        links: [
          ...(worst ? [{ kind: 'equipment' as const, id: worst[0], label: `Locate ${worst[0]}` }] : []),
          { kind: 'workspace', id: 'production', label: 'Open downtime Pareto' },
        ],
        followUps: ['Why is today\'s production below target?', 'Is any machine at risk of failure?'],
      };
    }
    case 'kiln': {
      const k = machineMetrics(s, 'H-KILN', p);
      const st = stageMetrics(s, p).find((x) => x.stage === 'KILN')!;
      const bn = bottleneck(s);
      const idle = kilnIdleBurn(s, p);
      const state = s.machines['H-KILN'];
      return {
        ...base,
        intent,
        text: [
          `The kiln is ${stateWord(state.state)} (since ${formatClock(state.since)}). In ${inPeriod(p.label)} it ran at availability ${pct(k.oee.availability.value)} and performance ${pct(k.oee.performance.value)}; it fired ${m2(k.totals.count)}.`,
          `It was starved ${Math.round(k.totals.starved)} min and blocked ${Math.round(k.totals.blocked)} min — time the line cannot recover because the kiln is the designed constraint. ${bn.current.stage === 'KILN' ? 'It is currently the bottleneck.' : `The current bottleneck is ${bn.current.name.toLowerCase()}, which is starving it.`}`,
          `While waiting for tiles the kiln still burnt ≈ ${Math.round(idle).toLocaleString('en-GB')} kWh of gas (${tariffs.currency} ${(idle * tariffs.gas).toFixed(0)}).`,
        ],
        facts: [
          { label: 'Kiln availability', value: pct(k.oee.availability.value) },
          { label: 'Kiln performance', value: pct(k.oee.performance.value) },
          { label: 'Starved', value: `${Math.round(k.totals.starved)} min` },
          { label: 'Input buffer', value: pct(st.inputBufferLevel, 0) },
        ],
        links: [
          { kind: 'equipment', id: 'H-KILN', label: 'Locate the kiln' },
          { kind: 'workspace', id: 'energy', label: 'Kiln energy' },
        ],
        followUps: ['Which machine is the main bottleneck?', 'Where are we wasting energy?'],
      };
    }
    case 'defects': {
      const shift = defectShift(s, 120, 1440);
      const top = shift[0];
      const q2 = qualityIn(s, p);
      const rising = top.ratio != null && top.ratio > 1.3;
      const origin = DEFECTS[top.defect].origin;
      return {
        ...base,
        intent,
        text: [
          rising
            ? `${top.label} has increased the most: ${pct(top.rateRecent, 2)} of inspected tiles in the last 2 hours versus ${pct(top.rateRef, 2)} over the previous 24 hours (${top.ratio!.toFixed(1)}×). It originates at ${STAGE_BY_ID[origin].name.toLowerCase()}.`
            : `No defect category has increased significantly; the largest relative change is ${top.label.toLowerCase()} at ${top.ratio != null ? `${top.ratio.toFixed(1)}×` : '—'} its 24-hour rate.`,
          `In ${inPeriod(p.label)} the sorter inspected ${Math.round(q2.inspected).toLocaleString('en-GB')} tiles and rejected ${Math.round(q2.rejected).toLocaleString('en-GB')} (${pct(q2.inspected ? q2.rejected / q2.inspected : null, 2)}).`,
          rising ? `Investigate: ${DEFECT_ACTIONS[top.defect]}` : '',
          'Inspection records are simulated; no computer-vision model is running in this demo.',
        ].filter(Boolean),
        facts: shift.slice(0, 4).map((d) => ({ label: d.label, value: d.ratio != null ? `${d.ratio.toFixed(1)}× · ${pct(d.rateRecent, 2)}` : '—' })),
        links: [
          { kind: 'equipment', id: 'I-VIS', label: 'Locate inspection tunnel' },
          { kind: 'equipment', id: STAGE_BY_ID[origin].machines[0], label: `Origin: ${STAGE_BY_ID[origin].name}` },
          { kind: 'workspace', id: 'quality', label: 'Open Quality Intelligence' },
        ],
        followUps: ['What should the shift supervisor do next?', 'Why is today\'s production below target?'],
      };
    }
    case 'next-actions': {
      const acts = nextActions(s, { tariffs });
      if (!acts.length)
        return { ...base, intent, text: ['Nothing needs intervention right now: no stoppages, health warnings, quality or energy exceptions are active.'], facts: [], links: [], followUps: SUGGESTED_QUESTIONS.slice(0, 3) };
      return {
        ...base,
        intent,
        text: [
          `Recommended actions, in priority order (rule-based, from the current state):`,
          ...acts.map((a, i) => `${i + 1}. ${a.title} — ${a.recommendation}`),
        ],
        facts: acts.slice(0, 4).map((a) => ({ label: a.title, value: a.impact ?? a.severity })),
        links: acts.flatMap((a) => a.links.slice(0, 1)).slice(0, 4),
        followUps: ['Why is today\'s production below target?', 'Is any machine at risk of failure?'],
      };
    }
    case 'energy': {
      const e = energyIn(s, p, tariffs);
      const worst = [...e.rows].filter((r) => r.deviation != null && r.expected > 50).sort((a, b) => (b.deviation ?? 0) - (a.deviation ?? 0))[0];
      const idle = kilnIdleBurn(s, p);
      return {
        ...base,
        intent,
        text: [
          `${p.label}: ${Math.round(e.total).toLocaleString('en-GB')} kWh (${Math.round(e.thermal).toLocaleString('en-GB')} kWh gas, ${Math.round(e.elec).toLocaleString('en-GB')} kWh electricity), ${tariffs.currency} ${e.cost.toFixed(0)}; ${e.sec != null ? `${e.sec.toFixed(2)} kWh per good m²` : 'no good output yet'}.`,
          worst && (worst.deviation ?? 0) > 0.05
            ? `${worst.label} is ${pct(worst.deviation, 0)} above the energy model for the same production — ${tariffs.currency} ${(worst.cost - worst.expectedCost).toFixed(0)} extra so far.`
            : 'All consumers are within 5 % of the energy model.',
          `The kiln burnt ≈ ${Math.round(idle).toLocaleString('en-GB')} kWh while starved or blocked.`,
          'Energy values are simulated from an illustrative model; tariffs are editable in Energy Intelligence.',
        ],
        facts: [
          { label: 'Total energy', value: `${Math.round(e.total).toLocaleString('en-GB')} kWh` },
          { label: 'vs model', value: pct(e.deviation) },
          { label: 'Cost', value: `${tariffs.currency} ${e.cost.toFixed(0)}` },
          { label: 'Excess cost', value: `${tariffs.currency} ${e.excessCost.toFixed(0)}` },
        ],
        links: [
          ...(worst ? [{ kind: 'equipment' as const, id: worst.id, label: `Locate ${worst.id}` }] : []),
          { kind: 'workspace', id: 'energy', label: 'Open Energy Intelligence' },
        ],
        followUps: ['How is the kiln affecting production?', 'What should the shift supervisor do next?'],
      };
    }
    case 'health': {
      const list = machine && HEALTH_BY_ID[machine] ? [assess(s, machine)] : healthAssessments(s).sort((a, b) => a.score - b.score);
      const worst = list[0];
      const atRisk = list.filter((h) => h.level === 'warning' || h.level === 'alarm' || h.level === 'watch');
      return {
        ...base,
        periodLabel: 'Last 3 h of signals',
        intent,
        text: [
          atRisk.length
            ? `${atRisk.length} asset${atRisk.length > 1 ? 's show' : ' shows'} an abnormal pattern. Most at risk: ${worst.id} (${EQUIPMENT_BY_ID[worst.id].name}), health ${worst.score}/100, level ${worst.level}.`
            : `All monitored assets are within normal limits. Lowest health score: ${worst.id} at ${worst.score}/100.`,
          ...worst.findings,
          worst.etaTripH != null ? `If the trend continues it reaches its trip limit in ≈ ${formatH(worst.etaTripH)}.` : '',
          worst.recommendation ? `Recommendation: ${worst.recommendation}` : '',
          'Detection is rule-based on simulated signals (expected-vs-observed and trend); no trained model or physical sensor is connected.',
        ].filter(Boolean),
        facts: list.slice(0, 4).map((h) => ({ label: h.id, value: `${h.score}/100 · ${h.level}` })),
        links: [
          { kind: 'equipment', id: worst.id, label: `Locate ${worst.id}` },
          { kind: 'workspace', id: 'health', label: 'Open Machine Health' },
        ],
        followUps: ['What should the shift supervisor do next?', 'What caused the largest downtime loss?'],
      };
    }
    case 'oee': {
      const lm = lineMetrics(s, p);
      return {
        ...base,
        intent,
        text: [
          `Line OEE for ${inPeriod(p.label)} is ${pct(lm.oee.oee.value)} = availability ${pct(lm.oee.availability.value)} × performance ${pct(lm.oee.performance.value)} × quality ${pct(lm.oee.quality.value)}.`,
          `Availability and performance are measured at the line constraint (H-KILN): operating ${Math.round(lm.constraint.totals.operating)} of ${Math.round(lm.constraint.totals.planned)} planned min, ${Math.round(lm.constraint.totals.count).toLocaleString('en-GB')} tiles at an ideal ${lm.constraint.idealRatePerHour} tiles/h. Quality is first-pass yield at sorting: ${Math.round(lm.good).toLocaleString('en-GB')} good of ${Math.round(lm.inspected).toLocaleString('en-GB')}.`,
        ],
        facts: [
          { label: 'Planned time', value: `${Math.round(lm.constraint.totals.planned)} min` },
          { label: 'Operating time', value: `${Math.round(lm.constraint.totals.operating)} min` },
          { label: 'Total count (kiln)', value: Math.round(lm.constraint.totals.count).toLocaleString('en-GB') },
          { label: 'Good / inspected', value: `${Math.round(lm.good).toLocaleString('en-GB')} / ${Math.round(lm.inspected).toLocaleString('en-GB')}` },
        ],
        links: [{ kind: 'workspace', id: 'production', label: 'Open Production & OEE' }],
        followUps: ["Why is today's production below target?", 'Which machine is the main bottleneck?'],
      };
    }
    case 'logistics': {
      const fm = fleetMetrics(s, p);
      const docked = Object.entries(s.logistics.docks).filter(([, d]) => d.vehicleId);
      return {
        ...base,
        intent,
        text: [
          `${fm.onSite} external vehicle${fm.onSite === 1 ? '' : 's'} on site: ${fm.waiting} waiting for a dock, ${fm.atDock} at a dock. ${docked.length} of 6 docks occupied.`,
          `In ${inPeriod(p.label)}: ${fm.completedVisits} visits completed, average turnaround ${fm.avgTurnaround != null ? `${Math.round(fm.avgTurnaround)} min` : '—'}, gate-to-dock ${fm.avgGateToDock != null ? `${Math.round(fm.avgGateToDock)} min` : '—'}, dock utilisation ${pct(fm.dockUtilisation, 0)}.`,
          'Vehicle positions and gate events are simulated at zone level; no GPS or ANPR is connected.',
        ],
        facts: [
          { label: 'On site', value: String(fm.onSite) },
          { label: 'Waiting', value: String(fm.waiting) },
          { label: 'Warehouse stock', value: `${fm.stockPallets} pallets` },
        ],
        links: [{ kind: 'workspace', id: 'fleet', label: 'Open Fleet & Logistics' }],
        followUps: ['What should the shift supervisor do next?'],
      };
    }
    case 'machine': {
      const id = machine!;
      const item = EQUIPMENT_BY_ID[id];
      const ops = OPS_BY_ID[id];
      if (ops.category !== 'process')
        return {
          ...base,
          intent,
          text: [`${item.name} (${id}) — ${item.description}`, 'It has no production counter in this demo; see Assets & Data for its signals.'],
          facts: [],
          links: [{ kind: 'equipment', id, label: `Locate ${id}` }],
          followUps: SUGGESTED_QUESTIONS.slice(0, 2),
        };
      const mm = machineMetrics(s, id, p);
      const m = s.machines[id];
      const active = m.activeDowntimeId ? s.downtime.find((d) => d.id === m.activeDowntimeId) : null;
      const h = HEALTH_BY_ID[id] ? assess(s, id) : null;
      const rec = insights(s, { tariffs }).find((i) => i.equipmentId === id && i.recommendation);
      return {
        ...base,
        intent,
        text: [
          `${item.name} (${id}) is ${stateWord(m.state)} since ${formatClock(m.since)}${active ? ` — ${REASON_BY_CODE[active.reasonCode].label.toLowerCase()}, ${formatDuration(s.minute - active.start)} so far` : ''}.`,
          `In ${inPeriod(p.label)}: output ${m2(mm.totals.count)}, OEE ${pct(mm.oee.oee.value)} (A ${pct(mm.oee.availability.value)}, P ${pct(mm.oee.performance.value)}, Q ${pct(mm.oee.quality.value)}), ${Math.round(mm.totals.down)} min unplanned downtime.`,
          h ? `Condition: health ${h.score}/100 (${h.level}).` : '',
          rec ? `Recommendation: ${rec.recommendation}` : '',
        ].filter(Boolean),
        facts: [
          { label: 'State', value: stateWord(m.state) },
          { label: 'OEE', value: pct(mm.oee.oee.value) },
          { label: 'Downtime', value: `${Math.round(mm.totals.down)} min` },
        ],
        links: [{ kind: 'equipment', id, label: `Locate ${id}` }],
        followUps: ['What should the shift supervisor do next?'],
      };
    }
    default:
      return {
        ...base,
        intent: 'help',
        text: [
          'I answer from the current simulated plant state — production and OEE, bottlenecks, downtime, the kiln, quality and defects, machine health, energy, logistics, or a specific machine (e.g. "How is press 2 doing?").',
          'This copilot is rule-based: it matches your question to a topic and builds the answer from the same figures the dashboards show. No language model is connected.',
        ],
        facts: [],
        links: [],
        followUps: SUGGESTED_QUESTIONS.slice(0, 4),
      };
  }
}

function stateWord(state: string) {
  return (
    { running: 'running', reduced: 'running at reduced rate', starved: 'starved of input', blocked: 'blocked by downstream', down: 'down', planned: 'on a planned stop' } as Record<string, string>
  )[state] ?? state;
}

function bnLinks(stage: keyof typeof STAGE_BY_ID): InsightLink[] {
  return STAGE_BY_ID[stage].machines.slice(0, 3).map((id) => ({ kind: 'equipment', id, label: `Locate ${id}` }));
}

/** Loss categories at the constraint for the period, largest first. */
function lossBreakdown(s: SimState, from: number, to: number) {
  const k = machineMetrics(s, 'H-KILN', { from, to, label: '' }).totals;
  const q = qualityIn(s, { from, to, label: '' });
  const ideal = 60 / (OPS_BY_ID['H-KILN'].idealRatePerHour ?? 1);
  const perf = Math.max(0, k.operating - k.count * ideal);
  const qual = q.inspected > 0 ? (k.count * ideal * q.rejected) / q.inspected : 0;
  const rows = [
    { label: 'Kiln downtime', min: k.down },
    { label: 'Kiln starvation (upstream losses)', min: k.starved },
    { label: 'Kiln blocking (downstream losses)', min: k.blocked },
    { label: 'Speed / micro-stop losses', min: perf },
    { label: 'Quality rejects', min: qual },
  ];
  const total = rows.reduce((a, r) => a + r.min, 0) || 1;
  return rows.map((r) => ({ ...r, share: r.min / total })).sort((a, b) => b.min - a.min);
}
