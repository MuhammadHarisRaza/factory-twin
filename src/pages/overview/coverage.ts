/**
 * Data freshness & coverage on the Overview (brief §8 A): what this demo has for the plant's signal catalogue
 * (simulated / not modelled / unavailable, src/model/catalog coverage), how current the simulated signals are
 * right now (telemetry readings: quality flag, then age against the expected update interval with calc
 * freshness), which asset feeds are stale, and the integration boundary (DATA_SOURCES: one simulation engine,
 * every plant system not connected). Detail lives in Events & Reports › Data & connectivity.
 */
import { freshness } from '../../calc';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { AVAILABILITY_STATUS_LABEL, CATALOG, coverage, type AvailabilityStatus } from '../../model/catalog';
import { DATA_SOURCES } from '../../model/plant';
import type { SimState } from '../../sim/engine';
import { readSignal } from '../../sim/telemetry';
import { formatClock } from '../../sim/time';

export type CoverageRow = { status: AvailabilityStatus; label: string; count: number; share: number };

/** How current each simulated signal is now. */
export type FreshnessCounts = {
  /** Simulated signals checked. */
  checked: number;
  /** Good / uncertain quality, updated within 2× the expected interval. */
  current: number;
  /** Older than 2× (late) or 5× (stale) the expected interval, or flagged stale by the source. */
  late: number;
  stale: number;
  /** Flagged bad by the source (values not trusted). */
  bad: number;
  /** No value delivered (never received, or missing samples). */
  noValue: number;
  /** Event-driven signals with a value: not judged by age. */
  eventDriven: number;
};

export type DataCoverage = {
  /** Catalogue entries by what the demo has (connected is never produced here; listed only if it ever were). */
  catalogue: { total: number; rows: CoverageRow[] };
  freshness: FreshnessCounts;
  staleFeeds: { id: string; name: string; since: number; clock: string }[];
  /** The integration boundary: simulated sources, and plant systems that are not connected. */
  sources: { simulated: string[]; notConnected: string[]; connected: string[] };
  /** Signals or sources with a connected status (always 0 in this demo). */
  connected: number;
  /** The headline: never a connectivity claim unless a source really is connected. */
  headline: string;
  at: number;
};

const SHOWN: AvailabilityStatus[] = ['simulated', 'not-modelled', 'unavailable', 'reference', 'connected'];

/** Freshness of every simulated catalogue signal at this minute. */
export function freshnessCounts(s: SimState): FreshnessCounts {
  const out: FreshnessCounts = { checked: 0, current: 0, late: 0, stale: 0, bad: 0, noValue: 0, eventDriven: 0 };
  for (const d of CATALOG) {
    if (d.availabilityStatus !== 'simulated') continue;
    out.checked++;
    const r = readSignal(s, d.signalId);
    if (r.quality === 'stale') out.stale++;
    else if (r.quality === 'bad') out.bad++;
    else if (r.quality === 'missing') out.noValue++;
    else {
      const f = freshness(r.timestamp, s.minute, d.expectedUpdateIntervalS);
      if (f.status === 'stale') out.stale++;
      else if (f.status === 'late') out.late++;
      else if (f.status === 'event-driven') out.eventDriven++;
      else if (f.status === 'missing') out.noValue++;
      else out.current++;
    }
  }
  return out;
}

export function dataCoverage(s: SimState): DataCoverage {
  const c = coverage().total;
  const rows = SHOWN.filter((st) => st === 'simulated' || st === 'not-modelled' || st === 'unavailable' || c.byStatus[st] > 0).map((status) => ({
    status,
    label: AVAILABILITY_STATUS_LABEL[status],
    count: c.byStatus[status],
    share: c.total ? c.byStatus[status] / c.total : 0,
  }));
  const staleFeeds = Object.entries(s.feeds)
    .filter(([, f]) => f.status === 'stale')
    .map(([id, f]) => ({ id, name: EQUIPMENT_BY_ID[id]?.name ?? id, since: f.since, clock: formatClock(f.since) }))
    .sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
  const sources = {
    simulated: DATA_SOURCES.filter((d) => d.status === 'simulated').map((d) => d.name),
    notConnected: DATA_SOURCES.filter((d) => d.status === 'disconnected' || d.status === 'configured').map((d) => d.id),
    connected: DATA_SOURCES.filter((d) => d.status === 'connected').map((d) => d.name),
  };
  const connected = c.byStatus.connected + sources.connected.length;
  return {
    catalogue: { total: c.total, rows },
    freshness: freshnessCounts(s),
    staleFeeds,
    sources,
    connected,
    headline: connected === 0 ? 'No plant system connected — demo simulation' : `${sources.connected.join(', ')} delivering data alongside the demo simulation`,
    at: s.minute,
  };
}
