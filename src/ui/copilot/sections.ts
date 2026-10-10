/**
 * Pure helpers for displaying copilot answers: grouping the tagged sections into labelled blocks
 * and splitting a line into its parts (numbered item, confidence, assumptions).
 */
import type { CopilotSection } from '../../intel/copilot';

export type SectionKind = CopilotSection['kind'];

/** Display label of each section kind (Observed / Inferred / Estimate / How) with a short explanation. */
export const SECTION_LABEL: Record<SectionKind, { label: string; hint: string; note?: string }> = {
  observed: { label: 'Observed', hint: 'Read directly from the simulated signals, counters and event records' },
  inferred: { label: 'Inferred', hint: 'Explanations from correlated evidence — hypotheses with a confidence, not confirmed causes unless marked confirmed' },
  estimate: { label: 'Estimate', hint: 'Calculated from the stated, editable assumptions — not a verified business figure', note: 'assumptions shown' },
  method: { label: 'How', hint: 'How the figures were computed' },
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

export type LineBlock =
  | { kind: 'ol'; items: string[] }
  | { kind: 'p'; text: string; confidence?: 'Confirmed' | 'Likely' | 'Possible'; assumptions?: boolean };

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
    const c = kind === 'inferred' ? /^(Confirmed|Likely|Possible): ([\s\S]*)$/.exec(line) : null;
    if (c) blocks.push({ kind: 'p', text: c[2], confidence: c[1] as 'Confirmed' | 'Likely' | 'Possible' });
    else blocks.push({ kind: 'p', text: line, ...(kind === 'estimate' && line.startsWith('Assumptions:') ? { assumptions: true } : {}) });
  }
  return blocks;
}
