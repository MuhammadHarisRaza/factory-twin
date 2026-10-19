/**
 * Data & connectivity derivations (./coverage.ts): sources never claim a connection, the coverage matrix adds up
 * to the catalogue, stage 8 partial and stage 9 flagged, per-equipment rows, gap filters and facets, freshness.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG, STAGE9_EQUIPMENT_ID } from '../../model/catalog';
import { DATA_SOURCES } from '../../model/plant';
import { TRACKED_ASSETS, createSim } from '../../sim/engine';
import {
  DEFAULT_GAP_FILTERS,
  GAP_SIGNALS,
  NO_PLANT_CONNECTION,
  assetFreshness,
  classCounts,
  coverageRows,
  equipmentCoverageRows,
  filterEquipmentRows,
  freshnessSummary,
  gapFacets,
  gapSignals,
  sourceRows,
} from './coverage';

describe('sources', () => {
  it('reads the simulation as Simulated and every other source as Not connected', () => {
    const rows = sourceRows();
    expect(rows).toHaveLength(DATA_SOURCES.length);
    expect(rows.filter((r) => r.status === 'simulated').map((r) => r.id)).toEqual(['SIM']);
    for (const r of rows) {
      expect(['Simulated', 'Not connected']).toContain(r.statusLabel);
      expect(r.boundary).not.toMatch(/(?<!not |no )\bconnected\b/i);
    }
    expect(NO_PLANT_CONNECTION).toMatch(/No plant system is connected/);
  });
});

describe('coverage matrix', () => {
  it('adds up to the catalogue for every class, and counts nothing connected', () => {
    const all = coverageRows('all');
    expect(all.total.total).toBe(CATALOG.length);
    const sumRows = all.rows.reduce((a, r) => a + r.total, 0);
    expect(sumRows).toBe(CATALOG.length);
    expect(all.total.simulated + all.total.notModelled + all.total.unavailable + all.total.reference + all.total.connected).toBe(CATALOG.length);
    expect(all.total.connected).toBe(0);
    const cc = classCounts();
    expect(cc.core + cc.conditional + cc.external).toBe(cc.all);
    for (const cls of ['core', 'conditional', 'external'] as const) {
      const m = coverageRows(cls);
      expect(m.total.total).toBe(cc[cls]);
      expect(m.rows.reduce((a, r) => a + r.total, 0)).toBe(cc[cls]);
      expect(m.rows.every((r) => r.simulated + r.notModelled + r.unavailable + r.reference + r.connected === r.total)).toBe(true);
    }
  });

  it('marks stage 8 partial and flags stage 9 for configuration', () => {
    const { rows } = coverageRows();
    expect(rows).toHaveLength(13); // 12 stages + support
    expect(rows.find((r) => r.no === 8)!.presentLabel).toMatch(/^Partial/);
    expect(rows.find((r) => r.no === 9)!.presentLabel).toBe('Not present — flagged for configuration');
  });
});

describe('per-equipment coverage', () => {
  const s = createSim();
  const rows = equipmentCoverageRows(s);
  it('covers the catalogue equipment with consistent counts and a feed status', () => {
    expect(rows.reduce((a, r) => a + r.total, 0)).toBe(CATALOG.length);
    for (const r of rows) expect(r.simulated + r.notModelled + r.unavailable).toBeLessThanOrEqual(r.total);
    const s9 = rows.find((r) => r.id === STAGE9_EQUIPMENT_ID);
    if (s9) expect(s9.feedLabel).toMatch(/flagged for configuration/);
    for (const r of rows) {
      expect(r.feedLabel).not.toMatch(/^connected/i);
      if (r.simulated === 0) expect(r.lastUpdate).toBeNull();
    }
    expect(rows.some((r) => r.feed === 'simulated')).toBe(true);
  }, 60_000);

  it('filters by text and stage', () => {
    const id = rows.find((r) => r.stageNo === 4)!.id;
    expect(filterEquipmentRows(rows, { query: id.toLowerCase(), stage: 'all' }).map((r) => r.id)).toContain(id);
    expect(filterEquipmentRows(rows, { query: '', stage: 4 }).every((r) => r.stageNo === 4)).toBe(true);
    expect(filterEquipmentRows(rows, { query: '', stage: 'support' }).every((r) => r.stageNo == null)).toBe(true);
    expect(filterEquipmentRows(rows, { query: 'zzzz-no-such', stage: 'all' })).toEqual([]);
  });
});

describe('signals without a value', () => {
  it('lists only not-modelled / unavailable entries, filterable, with facet counts', () => {
    const all = gapSignals(DEFAULT_GAP_FILTERS);
    expect(all.length).toBe(GAP_SIGNALS.length);
    expect(all.every((d) => d.availabilityStatus === 'not-modelled' || d.availabilityStatus === 'unavailable')).toBe(true);
    const f = gapFacets(DEFAULT_GAP_FILTERS);
    expect(f.status.all).toBe(all.length);
    expect(f.status['not-modelled'] + f.status.unavailable).toBe(all.length);
    expect(f.cls.core + f.cls.conditional + f.cls.external).toBe(all.length);
    const nm = gapSignals({ ...DEFAULT_GAP_FILTERS, status: 'not-modelled' });
    expect(nm.length).toBe(f.status['not-modelled']);
    const ext = gapSignals({ ...DEFAULT_GAP_FILTERS, cls: 'external' });
    expect(ext.every((d) => d.availabilityClass === 'external')).toBe(true);
    const src = all[0].sourceSystem;
    expect(gapSignals({ ...DEFAULT_GAP_FILTERS, source: src }).every((d) => d.sourceSystem === src)).toBe(true);
    const eq = all[0].equipmentId;
    expect(gapSignals({ ...DEFAULT_GAP_FILTERS, equipmentId: eq }).every((d) => d.equipmentId === eq)).toBe(true);
    // A facet ignores its own filter: picking a status keeps the other status's count visible.
    expect(gapFacets({ ...DEFAULT_GAP_FILTERS, status: 'unavailable' }).status['not-modelled']).toBe(f.status['not-modelled']);
  });
});

describe('asset feed freshness', () => {
  it('reads the state signal of every tracked asset and flags a stale feed', () => {
    const s = createSim();
    const rows = assetFreshness(s);
    expect(rows).toHaveLength(TRACKED_ASSETS.length);
    expect(rows.every((r) => r.signalId.endsWith('.state') || r.signalId.endsWith('.run_state'))).toBe(true);
    const sum = freshnessSummary(rows);
    expect(sum.fresh + sum.late + sum.stale + sum.missing + sum['event-driven']).toBe(rows.length);
    for (const r of rows) if (r.status === 'fresh') expect(r.staleSince).toBeNull();
  }, 60_000);
});
