/**
 * Compliance Overview — figures derived from the stored records only. A requirement without an
 * assessment stays "Not assessed" (never counted as compliant), and a stored document is not counted
 * as evidence until a reviewer approves it.
 */
import { CATEGORIES, SAMPLE_TODAY, SOURCE_META, type CAction, type Category, type Requirement, type SourceId } from './data';

export type KpiKey = 'tracked' | 'review' | 'verified' | 'gaps' | 'overdue' | 'evidence';

export const KPI_DEFS: { key: KpiKey; label: string; why: string }[] = [
  { key: 'tracked', label: 'Requirements tracked', why: 'External requirements and internal controls in the register' },
  { key: 'review', label: 'Awaiting applicability review', why: 'A person has not yet recorded whether these apply' },
  { key: 'verified', label: 'Verified with evidence', why: 'Assessed, with approved evidence on record' },
  { key: 'gaps', label: 'Confirmed gaps', why: 'A reviewer confirmed the requirement is not met' },
  { key: 'overdue', label: 'Overdue actions', why: 'Corrective or follow-up actions past their due date' },
  { key: 'evidence', label: 'Evidence missing or expiring', why: 'No approved document, or it has expired or expires soon' },
];

/** Whether a requirement falls under a KPI (the register filter behind each KPI card). */
export function matchesKpi(k: KpiKey, r: Requirement, actions: CAction[]): boolean {
  switch (k) {
    case 'tracked':
      return true;
    case 'review':
      return r.appl === 'Under review' || r.appl === 'Review required';
    case 'verified':
      return r.status === 'Verified';
    case 'gaps':
      return r.status === 'Gap confirmed';
    case 'overdue':
      return actions.some((a) => a.req === r.id && a.status === 'Overdue');
    case 'evidence':
      return r.ev === 'Missing' || r.ev === 'Expired' || r.ev === 'Expiring';
  }
}

export function kpiValue(k: KpiKey, reqs: Requirement[], actions: CAction[]): number {
  // Overdue counts actions, not requirements.
  if (k === 'overdue') return actions.filter((a) => a.status === 'Overdue').length;
  return reqs.filter((r) => matchesKpi(k, r, actions)).length;
}

export type Bucket = 'verified' | 'progress' | 'gap' | 'none';

export const bucketOf = (r: Requirement): Bucket => (r.status === 'Verified' ? 'verified' : r.status === 'Gap confirmed' ? 'gap' : r.status === 'Not assessed' ? 'none' : 'progress');

export function categoryBreakdown(reqs: Requirement[]): { name: Category; n: number; counts: Record<Bucket, number> }[] {
  return CATEGORIES.map((name) => {
    const counts: Record<Bucket, number> = { verified: 0, progress: 0, gap: 0, none: 0 };
    const rs = reqs.filter((r) => r.cat === name);
    for (const r of rs) counts[bucketOf(r)]++;
    return { name, n: rs.length, counts };
  });
}

/** Whole days from the sample "today" to a date like "02 Nov 2026" (negative = past); null for non-dates. */
export function daysFromToday(date: string, today = SAMPLE_TODAY): number | null {
  const d = Date.parse(`${date} 12:00 UTC`);
  const t = Date.parse(`${today} 12:00 UTC`);
  if (Number.isNaN(d) || Number.isNaN(t)) return null;
  return Math.round((d - t) / 86_400_000);
}

const KIND_ORDER: Record<CAction['kind'], number> = { Overdue: 0, Approval: 1, Inspection: 2, Deadline: 3, Evidence: 4 };

/** Open actions, most urgent kind first, then by due date. */
export function upcomingActions(actions: CAction[], limit = 7): CAction[] {
  return actions
    .filter((a) => a.status !== 'Completed')
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (daysFromToday(a.due) ?? 0) - (daysFromToday(b.due) ?? 0))
    .slice(0, limit);
}

export type RegisterFilter = { q: string; src: SourceId | 'All'; cat: Category | 'All'; status: Requirement['status'] | 'All'; appl: Requirement['appl'] | 'All'; kpi: KpiKey | null };

export const NO_FILTER: RegisterFilter = { q: '', src: 'All', cat: 'All', status: 'All', appl: 'All', kpi: null };

export type SortKey = 'id' | 'src' | 'title' | 'area' | 'owner' | 'date' | 'appl' | 'status';

export function filterRegister(reqs: Requirement[], actions: CAction[], f: RegisterFilter, sort: { k: SortKey; dir: 1 | -1 } = { k: 'id', dir: 1 }): Requirement[] {
  const q = f.q.trim().toLowerCase();
  const list = reqs.filter(
    (r) =>
      (f.src === 'All' || r.src === f.src) &&
      (f.cat === 'All' || r.cat === f.cat) &&
      (f.status === 'All' || r.status === f.status) &&
      (f.appl === 'All' || r.appl === f.appl) &&
      (!f.kpi || matchesKpi(f.kpi, r, actions)) &&
      (!q || [r.id, r.title, SOURCE_META[r.src].label, r.area, r.owner, r.desc].join(' ').toLowerCase().includes(q)),
  );
  const key = (r: Requirement) => (sort.k === 'src' ? SOURCE_META[r.src].label : r[sort.k]);
  return [...list].sort((a, b) => key(a).localeCompare(key(b)) * sort.dir);
}

/** CSV of register rows; every row is marked as an illustrative sample. */
export function registerCsv(rows: Requirement[]): string {
  const head = ['ID', 'Source', 'Requirement', 'Category', 'Area', 'Owner', 'Effective/Review', 'Applicability', 'Status', 'Data'];
  const lines = [head, ...rows.map((r) => [r.id, SOURCE_META[r.src].label, r.title, r.cat, r.area, r.owner, r.date, r.appl, r.status, 'Illustrative sample'])];
  return lines.map((l) => l.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
}

/** Next free ID for a source prefix, e.g. EPA-004. */
export function nextId(reqs: { id: string }[], prefix: string): string {
  const max = reqs.reduce((m, r) => {
    const hit = r.id.match(new RegExp(`^${prefix}-(\\d+)$`));
    return hit ? Math.max(m, Number(hit[1])) : m;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}
