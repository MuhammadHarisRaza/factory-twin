/**
 * Operational insights on the Overview — the plant-wide rule findings (src/intel/rules plantFindings), shaped
 * as a compact feed: severity, title, 'Rule-based' / 'Statistical', one line of the evidence with its figures,
 * where (equipment and stage), since when, and the place to continue. Rule findings are evaluations of the
 * simulated signals, kept apart from the event records of "Issues requiring attention". Only fired findings
 * are listed; the counts say how many checks were evaluated and how many could not be (insufficient data), so
 * an empty feed never reads as proof that nothing is wrong.
 */
import type { WorkspaceId } from '../../app/store';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { CLASSIFICATION_LABEL, FAMILY_LABEL, RULE_FAMILIES, plantFindings, type Confidence, type PlantFindings, type RuleFamily, type RuleFinding, type Severity } from '../../intel/rules';

import { STAGE_BY_NO, stageOfEquipment } from '../../model/catalog';
import type { MonitoredStageId } from '../../model/types';
import type { SimState } from '../../sim/engine';
import { formatClock, formatDay } from '../../sim/time';

/** Findings listed (the most severe, most recent first). */
export const INSIGHTS_TOP = 5;

export type InsightFilter = RuleFamily | 'all';

/** Where a finding continues: the equipment in the Factory Twin, a Production stage, or a workspace view. */
export type InsightTarget =
  | { kind: 'equipment'; equipmentId: string; label: string }
  | { kind: 'stage'; stageId: MonitoredStageId; label: string }
  | { kind: 'view'; workspace: WorkspaceId; tab: string | null; label: string };

export type InsightRow = {
  key: string;
  ruleId: string;
  family: RuleFamily;
  familyLabel: string;
  severity: Severity;
  /** 'Rule-based' or 'Statistical' (never AI). */
  classification: string;
  title: string;
  /** The first sentence of the explanation (its figures and window). */
  line: string;
  /** The full explanation (tooltip). */
  explanation: string;
  /** Equipment and stage ("H-KILN · Single-layer roller kiln · Stage 7 Kiln firing"). */
  where: string;
  /** "since 10:20" (or with the day when it is not today); null without an episode start. */
  since: string | null;
  confidence: Confidence;
  confidenceNote: string;
  /** A simulated scenario acts on the finding's scope. */
  scenario: boolean;
  next: string | null;
  target: InsightTarget;
};

export type InsightFeed = {
  /** The filter applied (a family without fired findings falls back to 'all'). */
  filter: InsightFilter;
  rows: InsightRow[];
  /** Fired findings in the filter (rows are the first INSIGHTS_TOP of them). */
  fired: number;
  /** Fired findings plant-wide, per severity (most severe first) and per family (families with any). */
  bySeverity: { severity: Severity; count: number }[];
  byFamily: { family: RuleFamily; label: string; count: number }[];
  firedTotal: number;
  /** Checks evaluated (fired + clear) and not evaluated (insufficient data). */
  evaluated: number;
  notEvaluated: number;
  /** Plant minute of the evaluation. */
  at: number;
};

const SEVERITY_ORDER: Severity[] = ['critical', 'serious', 'warning', 'info'];

/**
 * The first sentence of a rule explanation (sentence end: '.', '!' or '?' followed by a space and a capital,
 * so ids like 'F-BUF.level' and decimals stay whole), shortened at a word boundary beyond `max` characters.
 */
export function firstSentence(text: string, max = 240): string {
  const t = text.trim().replace(/\s+/g, ' ');
  const m = /^(.+?[.!?])(?= [A-Z(]|$)/.exec(t);
  const out = m ? m[1] : t;
  return out.length > max ? `${out.slice(0, max - 1).replace(/[\s,;:—–-]+\S*$/, '')}…` : out;
}

const sinceText = (s: SimState, at: number | null) => (at == null ? null : `since ${formatDay(at) === formatDay(s.minute) ? formatClock(at) : `${formatDay(at)} ${formatClock(at)}`}`);

function whereOf(f: RuleFinding): { where: string; target: InsightTarget } {
  const sc = f.scope;
  if (sc.kind === 'equipment') {
    const no = stageOfEquipment(sc.equipmentId);
    const name = EQUIPMENT_BY_ID[sc.equipmentId]?.name;
    const stage = no ? `Stage ${no} ${STAGE_BY_NO[no].name}` : 'Site utilities';
    return {
      where: [sc.equipmentId, name, stage].filter(Boolean).join(' · '),
      target: { kind: 'equipment', equipmentId: sc.equipmentId, label: 'Open in twin' },
    };
  }
  if (sc.kind === 'stage') {
    const st = STAGE_BY_NO[sc.stageNo];
    const where = `Stage ${sc.stageNo} ${st.name}`;
    if (f.family === 'quality') return { where, target: { kind: 'view', workspace: 'quality', tab: null, label: 'Open Quality' } };
    if (st.monitoredStage) return { where, target: { kind: 'stage', stageId: st.monitoredStage, label: 'Open stage' } };
    return { where, target: { kind: 'view', workspace: 'production', tab: null, label: 'Open Production' } };
  }
  return { where: 'Plant', target: { kind: 'view', workspace: 'production', tab: null, label: 'Open Production' } };
}

export function insightRow(s: SimState, f: RuleFinding): InsightRow {
  const { where, target } = whereOf(f);
  return {
    key: f.key,
    ruleId: f.ruleId,
    family: f.family,
    familyLabel: FAMILY_LABEL[f.family],
    severity: f.severity,
    classification: CLASSIFICATION_LABEL[f.classification],
    title: f.title,
    line: firstSentence(f.explanation),
    explanation: f.explanation,
    where,
    since: sinceText(s, f.firstSeen),
    confidence: f.confidence,
    confidenceNote: f.confidenceNote,
    scenario: !!f.provenance.scenarioId,
    next: f.next,
    target,
  };
}

/**
 * The Overview insight feed: the top fired plant findings (optionally of one family) and the counts behind them.
 * `evaluated` passes an evaluation made earlier (the live view's, src/intel/rules/live.ts) with its minute; by default
 * the findings are evaluated now.
 */
export function insightFeed(s: SimState, filter: InsightFilter = 'all', top = INSIGHTS_TOP, evaluated?: { value: PlantFindings; at: number }): InsightFeed {
  const p = evaluated?.value ?? plantFindings(s, { top });
  const fired = p.findings.filter((f) => f.status === 'fired');
  const byFamily = RULE_FAMILIES.map((family) => ({ family, label: FAMILY_LABEL[family], count: p.summary.byFamily[family].fired })).filter((x) => x.count > 0);
  const effective: InsightFilter = filter !== 'all' && byFamily.some((x) => x.family === filter) ? filter : 'all';
  const list = effective === 'all' ? fired : fired.filter((f) => f.family === effective);
  return {
    filter: effective,
    rows: (effective === 'all' ? p.top : list.slice(0, top)).map((f) => insightRow(s, f)),
    fired: list.length,
    bySeverity: SEVERITY_ORDER.map((severity) => ({ severity, count: p.summary.bySeverity[severity] })).filter((x) => x.count > 0),
    byFamily,
    firedTotal: fired.length,
    evaluated: p.summary.byStatus.fired + p.summary.byStatus.clear,
    notEvaluated: p.summary.byStatus['insufficient-data'],
    at: evaluated?.at ?? s.minute,
  };
}
