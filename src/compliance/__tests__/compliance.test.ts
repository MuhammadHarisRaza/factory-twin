import { beforeEach, describe, expect, it } from 'vitest';
import { SEED_ACTIONS, SEED_REQUIREMENTS, SEED_SOURCES } from '../data';
import { NO_FILTER, categoryBreakdown, daysFromToday, filterRegister, kpiValue, nextId, registerCsv, upcomingActions } from '../derive';
import { useCompliance } from '../store';

describe('compliance derivations', () => {
  it('counts KPIs from the stored records only', () => {
    expect(kpiValue('tracked', SEED_REQUIREMENTS, SEED_ACTIONS)).toBe(14);
    expect(kpiValue('verified', SEED_REQUIREMENTS, SEED_ACTIONS)).toBe(3);
    expect(kpiValue('gaps', SEED_REQUIREMENTS, SEED_ACTIONS)).toBe(1);
    expect(kpiValue('overdue', SEED_REQUIREMENTS, SEED_ACTIONS)).toBe(2);
  });

  it('keeps not-assessed records out of the verified bucket', () => {
    const cats = categoryBreakdown(SEED_REQUIREMENTS);
    expect(cats.reduce((n, c) => n + c.n, 0)).toBe(SEED_REQUIREMENTS.length);
    const env = cats.find((c) => c.name === 'Environmental')!;
    expect(env.counts).toEqual({ verified: 0, progress: 0, gap: 1, none: 2 });
  });

  it('counts days from the sample date and ignores recurrences', () => {
    expect(daysFromToday('09 Nov 2026')).toBe(14);
    expect(daysFromToday('18 Oct 2026')).toBe(-8);
    expect(daysFromToday('Daily')).toBeNull();
    expect(upcomingActions(SEED_ACTIONS)[0].status).toBe('Overdue');
  });

  it('filters, searches and exports the register', () => {
    expect(filterRegister(SEED_REQUIREMENTS, SEED_ACTIONS, { ...NO_FILTER, q: 'kiln' }).map((r) => r.id)).toEqual(['EPA-001', 'INT-001']);
    expect(filterRegister(SEED_REQUIREMENTS, SEED_ACTIONS, { ...NO_FILTER, kpi: 'overdue' }).map((r) => r.id)).toEqual(['EPA-002', 'LAB-001']);
    const csv = registerCsv(SEED_REQUIREMENTS.slice(0, 2)).split('\n');
    expect(csv).toHaveLength(3);
    expect(csv[1]).toContain('"Illustrative sample"');
  });

  it('never marks a source as automatically monitored', () => {
    expect(SEED_SOURCES.every((s) => s.status === 'Manual monitoring' || s.status === 'Not connected')).toBe(true);
    expect(SEED_SOURCES.every((s) => s.url === '')).toBe(true);
  });

  it('allocates the next free id', () => {
    expect(nextId(SEED_REQUIREMENTS, 'EPA')).toBe('EPA-004');
    expect(nextId(SEED_ACTIONS, 'ACT')).toBe('ACT-008');
  });
});

describe('compliance store', () => {
  beforeEach(() => useCompliance.getState().reset());

  it('starts new requirements unassessed', () => {
    const id = useCompliance.getState().addRequirement({ title: 'Noise survey', src: 'labour', area: '', owner: '' });
    const r = useCompliance.getState().reqs.find((x) => x.id === id)!;
    expect(id).toBe('LAB-002');
    expect([r.appl, r.status, r.ev, r.area, r.owner]).toEqual(['Review required', 'Not assessed', 'Missing', 'Not mapped', 'Unassigned']);
  });

  it('records decisions in the history', () => {
    useCompliance.getState().decideRequirement('EPA-001', 'Applicable', 'Kiln exhaust is a permitted stack');
    const r = useCompliance.getState().reqs.find((x) => x.id === 'EPA-001')!;
    expect(r.appl).toBe('Applicable');
    expect(r.history.at(-1)!.e).toContain('Kiln exhaust is a permitted stack');
  });

  it('keeps a configured source manual, or not connected', () => {
    useCompliance.getState().configureSource('psqca', { name: 'PSQCA', url: 'https://example.org', method: 'upload' });
    expect(useCompliance.getState().sources.find((s) => s.id === 'psqca')!.status).toBe('Manual monitoring');
    useCompliance.getState().configureSource('psqca', { name: 'PSQCA', url: '', method: 'none' });
    expect(useCompliance.getState().sources.find((s) => s.id === 'psqca')!.status).toBe('Not connected');
  });
});
