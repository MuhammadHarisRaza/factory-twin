/**
 * Pure helpers for displaying copilot answers: the visible label of each answer section, grouping the
 * tagged sections into labelled blocks, and splitting a line into its parts (numbered item,
 * confidence, assumptions).
 */
import type { CopilotSection, SectionKind } from '../../intel/copilot';

export type { SectionKind };

/** Display label of each section kind, with a short explanation (shown on hover). */
export const SECTION_LABEL: Record<SectionKind, { label: string; hint: string; note?: string }> = {
  confirmed: { label: 'Confirmed facts', hint: 'Read directly from the simulated counters, machine states and event records — the same data as the workspaces', note: 'from the data' },
  simulated: { label: 'Simulated events', hint: 'Which records the answer uses and where they come from: the simulation’s own rules, or a scenario the presenter started' },
  inferred: { label: 'Inferred explanation', hint: 'Explanations and attributions from correlated evidence — likely, not confirmed' },
  hypotheses: { label: 'Unverified hypotheses', hint: 'Possible causes to check — not established by the data' },
  unknown: { label: 'Cannot be established', hint: 'What the available data cannot tell — nothing is invented to fill the gap' },
  estimate: { label: 'Estimate', hint: 'Calculated from the stated, editable assumptions — not a verified business figure', note: 'assumptions shown' },
  actions: { label: 'Recommended actions', hint: 'Rule-based standard responses and where to look next' },
  method: { label: 'How it was computed', hint: 'Formulas, sources and scope of the figures' },
};

/** Consecutive sections of the same kind as one block, in answer order. */
export function groupSections(sections: CopilotSection[]): { kind: SectionKind; lines: string[] }[] {
  const out: { kind: SectionKind; lines: string[] }[] = [];
  for (const x of sections) {
    const last = out.at(-1);
    if (last && last.kind === x.kind) last.lines.push(x.text);
    else out.push({ kind: x.kind, lines: [x.text] });
  }
  return out;
}

export type Confidence = 'Confirmed' | 'Likely' | 'Possible';

export type LineBlock = { kind: 'ol'; items: string[] } | { kind: 'p'; text: string; confidence?: Confidence; assumptions?: boolean };

/** Sections whose lines may start with a confidence word ("Likely: …"), shown as a tag. */
const WITH_CONFIDENCE: SectionKind[] = ['confirmed', 'inferred', 'hypotheses'];

/** Lines of one section as blocks: consecutive "1. …" lines become a list; confidences and assumptions are marked. */
export function lineBlocks(lines: string[], kind: SectionKind): LineBlock[] {
  const blocks: LineBlock[] = [];
  for (const line of lines) {
    const n = /^\d+\.\s+([\s\S]*)$/.exec(line);
    const prev = blocks.at(-1);
    if (n) {
      if (prev?.kind === 'ol') prev.items.push(n[1]);
      else blocks.push({ kind: 'ol', items: [n[1]] });
      continue;
    }
    const c = WITH_CONFIDENCE.includes(kind) ? /^(Confirmed|Likely|Possible): ([\s\S]*)$/.exec(line) : null;
    if (c) blocks.push({ kind: 'p', text: c[2], confidence: c[1] as Confidence });
    else blocks.push({ kind: 'p', text: line, ...(kind === 'estimate' && line.startsWith('Assumptions:') ? { assumptions: true } : {}) });
  }
  return blocks;
}

/** Confidence words in plain language (never colour alone). */
export const CONFIDENCE_HINT: Record<Confidence, string> = {
  Confirmed: 'Directly observed, or a scenario input',
  Likely: 'Inferred from correlated evidence — not confirmed',
  Possible: 'A hypothesis to check — not established by the data',
};
