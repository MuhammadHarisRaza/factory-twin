import { describe, expect, it } from 'vitest';
import { CORE_SECTIONS, SECTION_ORDER } from '../../intel/copilot';
import { SECTION_LABEL, groupSections, lineBlocks } from './sections';

describe('Copilot answer sections', () => {
  it('labels every kind, the five core sections with the required names', () => {
    expect(Object.keys(SECTION_LABEL).sort()).toEqual([...SECTION_ORDER].sort());
    expect(CORE_SECTIONS.map((k) => SECTION_LABEL[k].label)).toEqual(['Confirmed facts', 'Simulated events', 'Inferred explanation', 'Unverified hypotheses', 'Recommended actions']);
    expect(SECTION_LABEL.unknown.label).toBe('Cannot be established');
    expect(SECTION_LABEL.estimate.note).toBe('assumptions shown');
  });

  it('groups consecutive sections of the same kind, keeping order', () => {
    const g = groupSections([
      { kind: 'confirmed', text: 'a' },
      { kind: 'confirmed', text: 'b' },
      { kind: 'inferred', text: 'Likely: c' },
      { kind: 'estimate', text: 'd' },
      { kind: 'estimate', text: 'Assumptions: e' },
      { kind: 'method', text: 'f' },
    ]);
    expect(g).toEqual([
      { kind: 'confirmed', lines: ['a', 'b'] },
      { kind: 'inferred', lines: ['Likely: c'] },
      { kind: 'estimate', lines: ['d', 'Assumptions: e'] },
      { kind: 'method', lines: ['f'] },
    ]);
    expect(groupSections([])).toEqual([]);
  });

  it('turns numbered lines into a list and marks confidences and assumptions', () => {
    expect(lineBlocks(['Ranked:', '1. first', '2. second', 'after'], 'confirmed')).toEqual([
      { kind: 'p', text: 'Ranked:' },
      { kind: 'ol', items: ['first', 'second'] },
      { kind: 'p', text: 'after' },
    ]);
    expect(lineBlocks(['Possible: a hypothesis — basis.'], 'hypotheses')).toEqual([{ kind: 'p', text: 'a hypothesis — basis.', confidence: 'Possible' }]);
    expect(lineBlocks(['Likely: x', 'plain'], 'inferred')).toEqual([{ kind: 'p', text: 'x', confidence: 'Likely' }, { kind: 'p', text: 'plain' }]);
    expect(lineBlocks(['Confirmed: the kiln is the constraint'], 'confirmed')).toEqual([{ kind: 'p', text: 'the kiln is the constraint', confidence: 'Confirmed' }]);
    // A confidence word is only a tag in the fact / inference / hypothesis sections.
    expect(lineBlocks(['Likely: x'], 'actions')).toEqual([{ kind: 'p', text: 'Likely: x' }]);
    expect(lineBlocks(['≈ USD 5', 'Assumptions: price.'], 'estimate')).toEqual([
      { kind: 'p', text: '≈ USD 5' },
      { kind: 'p', text: 'Assumptions: price.', assumptions: true },
    ]);
  });
});
