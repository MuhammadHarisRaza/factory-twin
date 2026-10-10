import { describe, expect, it } from 'vitest';
import { SECTION_LABEL, groupSections, lineBlocks } from './sections';

describe('Copilot answer sections', () => {
  it('labels every kind as Observed / Inferred / Estimate / How', () => {
    expect(Object.values(SECTION_LABEL).map((x) => x.label)).toEqual(['Observed', 'Inferred', 'Estimate', 'How']);
    expect(SECTION_LABEL.estimate.note).toBe('assumptions shown');
  });

  it('groups consecutive sections of the same kind, keeping order', () => {
    const g = groupSections([
      { kind: 'observed', text: 'a' },
      { kind: 'observed', text: 'b' },
      { kind: 'inferred', text: 'Likely: c' },
      { kind: 'estimate', text: 'd' },
      { kind: 'estimate', text: 'Assumptions: e' },
      { kind: 'method', text: 'f' },
    ]);
    expect(g).toEqual([
      { kind: 'observed', lines: ['a', 'b'] },
      { kind: 'inferred', lines: ['Likely: c'] },
      { kind: 'estimate', lines: ['d', 'Assumptions: e'] },
      { kind: 'method', lines: ['f'] },
    ]);
    expect(groupSections([])).toEqual([]);
  });

  it('turns numbered lines into a list and marks confidences and assumptions', () => {
    expect(lineBlocks(['Ranked:', '1. first', '2. second', 'after'], 'observed')).toEqual([
      { kind: 'p', text: 'Ranked:' },
      { kind: 'ol', items: ['first', 'second'] },
      { kind: 'p', text: 'after' },
    ]);
    expect(lineBlocks(['Possible: a hypothesis — basis.', 'Recommended: act.'], 'inferred')).toEqual([
      { kind: 'p', text: 'a hypothesis — basis.', confidence: 'Possible' },
      { kind: 'p', text: 'Recommended: act.' },
    ]);
    // A confidence word is only a tag in the Inferred section.
    expect(lineBlocks(['Likely: x'], 'observed')).toEqual([{ kind: 'p', text: 'Likely: x' }]);
    expect(lineBlocks(['≈ USD 5', 'Assumptions: price.'], 'estimate')).toEqual([
      { kind: 'p', text: '≈ USD 5' },
      { kind: 'p', text: 'Assumptions: price.', assumptions: true },
    ]);
  });
});
