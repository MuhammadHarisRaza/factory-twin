/**
 * Compliance Overview — candidate regulatory sources, sample regulatory updates, internal controls,
 * register KPIs, category status, upcoming deadlines and the requirements register, in one screen.
 *
 * Everything shown is ILLUSTRATIVE sample data held in this browser session: no authority website is
 * monitored, no AI provider is configured (document analysis shows as unavailable), and nothing here
 * states the plant's actual compliance position. Applicability is always a person's recorded decision.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, CircleAlert, Download, FileText, Globe, Plus, RefreshCw, Search, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { CATEGORIES, SAMPLE_LOADED, SAMPLE_TODAY, SOURCE_META, type CAction, type Category, type CheckMethod, type Requirement, type Source, type SourceId, type Tone } from '../compliance/data';
import { KPI_DEFS, NO_FILTER, categoryBreakdown, daysFromToday, filterRegister, kpiValue, registerCsv, upcomingActions, type Bucket, type KpiKey, type RegisterFilter, type SortKey } from '../compliance/derive';
import { useCompliance, type Decision } from '../compliance/store';
import { PageHeader, Section } from '../ui/kit/Page';
import './compliance/compliance.css';

// ── Tones ───────────────────────────────────────────────────────────────────

const APPL_TONE: Record<string, Tone> = { Applicable: 'green', 'Not applicable': 'grey', 'Under review': 'amber', 'Review required': 'blue', 'Applicability under review': 'amber', New: 'blue' };
const STATUS_TONE: Record<Requirement['status'], Tone> = { Verified: 'green', 'In progress': 'amber', 'Not started': 'grey', 'Not assessed': 'grey', 'Gap confirmed': 'red' };
const EV_TONE: Record<Requirement['ev'], Tone> = { Current: 'green', 'Pending review': 'amber', Expiring: 'amber', Expired: 'red', Missing: 'red' };
const ACT_TONE: Record<CAction['status'], Tone> = { Overdue: 'red', Open: 'blue', 'Awaiting approval': 'amber', 'Awaiting evidence': 'amber', Completed: 'green' };
const KPI_TONE: Record<KpiKey, Tone> = { tracked: 'blue', review: 'amber', verified: 'green', gaps: 'red', overdue: 'red', evidence: 'orange' };
const BUCKET_LABEL: Record<Bucket, string> = { verified: 'verified', progress: 'in progress / review', gap: 'confirmed gap', none: 'not assessed' };

const Pill = ({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) => (
  <span className={`cp-pill t-${tone}`} title={title}>
    {children}
  </span>
);

/** The authority's logo on a light tile (logos are designed for white), or its acronym when there is none. */
function SourceLogo({ src, size = 'md' }: { src: SourceId; size?: 'sm' | 'md' | 'lg' }) {
  const m = SOURCE_META[src];
  return m.logo ? (
    <span className={`cp-logo ${size}`} title={m.logoNote ?? `${m.label} logo`}>
      <img src={m.logo} alt={`${m.label} logo`} loading="lazy" />
    </span>
  ) : (
    <span className={`cp-logo ${size} acr t-${m.tone}`} aria-hidden>
      {m.acr}
    </span>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

type Drawer = { kind: 'req' | 'upd'; id: string } | null;
type Modal = { kind: 'source'; id: Source['id'] } | { kind: 'req'; src?: SourceId } | null;

export function CompliancePage() {
  const [filter, setFilter] = useState<RegisterFilter>(NO_FILTER);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const patch = (f: Partial<RegisterFilter>) => setFilter((cur) => ({ ...cur, ...f }));
  const openReq = (id: string) => setDrawer({ kind: 'req', id });

  return (
    <div className="wp cp">
      <PageHeader
        title="Compliance Overview"
        provenance="illustrative"
        context={
          <>
            <span className="cp-ctx">
              <i className="cp-dot grey" aria-hidden />
              Last automated check: none configured
            </span>
            <span className="cp-ctx">Sample data loaded {SAMPLE_LOADED}</span>
          </>
        }
        summary="External regulations and internal factory controls in one place. Illustrative demo data — not the plant's actual compliance status."
        actions={
          <button className="btn" onClick={() => setToast('No automated source connectors are configured, so nothing was checked. Sources in manual mode are updated by hand.')}>
            <RefreshCw size={14} />
            Refresh sources
          </button>
        }
      />

      {toast && (
        <div className="cp-toast" role="status">
          <span>{toast}</span>
          <button className="btn ghost sm" onClick={() => setToast('')}>
            Dismiss
          </button>
        </div>
      )}

      <SourcesSection onConfigure={(id) => setModal({ kind: 'source', id })} onSay={setToast} onInternal={() => patch({ ...NO_FILTER, src: 'internal' })} />

      <div className="cp-two">
        <UpdatesSection onOpen={(id) => setDrawer({ kind: 'upd', id })} />
        <ControlsSection onOpen={openReq} onAll={() => patch({ ...NO_FILTER, src: 'internal' })} />
      </div>

      <KpiStrip active={filter.kpi} onPick={(k) => patch({ kpi: filter.kpi === k ? null : k })} />

      <div className="cp-two even">
        <CategoriesSection active={filter.cat} onPick={(c) => patch({ cat: filter.cat === c ? 'All' : c })} />
        <DeadlinesSection onOpen={openReq} />
      </div>

      <RegisterSection filter={filter} setFilter={setFilter} onOpen={openReq} onAdd={() => setModal({ kind: 'req' })} onSay={setToast} />

      <p className="cp-foot">
        Authority names and logos identify candidate regulators only (logos from Wikipedia / Wikimedia Commons); no affiliation or endorsement is implied. Owners are fictional. Changes are kept in this browser
        tab only.
      </p>

      {drawer && <RecordDrawer drawer={drawer} onClose={() => setDrawer(null)} onSay={setToast} onAddObligation={(src) => (setDrawer(null), setModal({ kind: 'req', src }))} />}
      {modal?.kind === 'source' && <SourceModal id={modal.id} onClose={() => setModal(null)} onSaved={setToast} />}
      {modal?.kind === 'req' && <AddRequirementModal initialSrc={modal.src} onClose={() => setModal(null)} onSaved={setToast} />}
    </div>
  );
}

// ── Regulatory sources ──────────────────────────────────────────────────────

function SourcesSection({ onConfigure, onSay, onInternal }: { onConfigure: (id: Source['id']) => void; onSay: (t: string) => void; onInternal: () => void }) {
  const sources = useCompliance((s) => s.sources);
  const reqs = useCompliance((s) => s.reqs);
  const internal = reqs.filter((r) => r.type === 'int').length;
  return (
    <Section title="Regulatory sources" subtitle="Candidate authorities and internal controls. Which ones apply has to be validated for this business.">
      <div className="cp-src-grid">
        <div className="cp-src-group">
          <h4>External authorities</h4>
          <div className="cp-src-cards">
            {sources.map((s) => (
              <article key={s.id} className="cp-src">
                <div className="cp-src-top">
                  <SourceLogo src={s.id} />
                  <div className="cp-src-name">
                    <b>{s.name}</b>
                    <span>{s.desc}</span>
                  </div>
                </div>
                <span className="cp-meta">
                  {s.cat} · {s.jur}
                </span>
                <span className="cp-meta cp-url" title={s.url || 'No official website recorded yet'}>
                  <Globe size={12} aria-hidden />
                  {s.url ? s.url.replace(/^https?:\/\//, '') : 'Official website: not configured'}
                </span>
                <span className={`cp-src-status ${s.status === 'Manual monitoring' ? 'manual' : 'off'}`}>
                  <i className="cp-dot" aria-hidden />
                  {s.status}
                </span>
                <span className="cp-meta faint">
                  Last checked: {s.checked ?? 'never'} · {reqs.filter((r) => r.src === s.id).length} req.
                </span>
                <div className="cp-src-actions">
                  <button
                    className="btn sm"
                    onClick={() => (s.url ? window.open(s.url, '_blank', 'noopener,noreferrer') : onSay(`${s.acr}: no official URL configured yet. Use Configure to add it.`))}
                  >
                    View
                  </button>
                  <button className="btn sm on" onClick={() => onConfigure(s.id)}>
                    Configure
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
        <div className="cp-src-group">
          <h4>Internal controls</h4>
          <article className="cp-src internal">
            <div className="cp-src-top">
              <span className="cp-logo md shield" aria-hidden>
                <ShieldCheck size={18} />
              </span>
              <div className="cp-src-name">
                <b>Internal policies</b>
                <span>SOPs, audits, inspections and operational checklists</span>
              </div>
            </div>
            <span className="cp-meta">Manual upload</span>
            <span className="cp-src-status on">
              <i className="cp-dot" aria-hidden />
              Maintained in-app
            </span>
            <span className="cp-meta faint">{internal} controls tracked</span>
            <div className="cp-src-actions">
              <button className="btn sm on" onClick={onInternal}>
                View controls
              </button>
            </div>
          </article>
        </div>
      </div>
    </Section>
  );
}

// ── Updates and internal controls ───────────────────────────────────────────

function UpdatesSection({ onOpen }: { onOpen: (id: string) => void }) {
  const updates = useCompliance((s) => s.updates);
  const [all, setAll] = useState(false);
  return (
    <Section
      title="Regulatory updates"
      subtitle="Sample updates entered by hand. None of these is a real notification."
      actions={
        <button className="btn ghost sm" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `View all (${updates.length})`}
        </button>
      }
    >
      <div className="cp-list">
        {(all ? updates : updates.slice(0, 4)).map((u) => (
          <button key={u.id} className="cp-row upd" onClick={() => onOpen(u.id)}>
            <SourceLogo src={u.src} size="lg" />
            <span className="cp-row-main">
              <span className="cp-row-title">
                <b>{u.title}</b>
                <span className="cp-sample">Sample</span>
              </span>
              <span className="cp-meta">
                {u.kind} · Published {u.pub} · Entered manually
              </span>
              <span className="cp-row-sum">{u.summary}</span>
            </span>
            <span className="cp-row-side">
              <Pill tone={APPL_TONE[u.status] ?? 'grey'}>{u.status}</Pill>
              <span className="cp-meta">Effective: {u.eff}</span>
            </span>
            <ChevronRight size={14} className="cp-chev" aria-hidden />
          </button>
        ))}
      </div>
    </Section>
  );
}

function ControlsSection({ onOpen, onAll }: { onOpen: (id: string) => void; onAll: () => void }) {
  const reqs = useCompliance((s) => s.reqs);
  const controls = reqs.filter((r) => r.id.startsWith('INT')).slice(0, 4);
  return (
    <Section
      title="Internal controls"
      subtitle="Factory SOPs, audits and operational checklists."
      actions={
        <button className="btn ghost sm" onClick={onAll}>
          View all in register
        </button>
      }
    >
      <div className="cp-list">
        {controls.map((r) => (
          <button key={r.id} className="cp-row ctl" onClick={() => onOpen(r.id)}>
            <span className="cp-logo md shield soft" aria-hidden>
              <FileText size={16} />
            </span>
            <span className="cp-row-main">
              <b>{r.title}</b>
              <span className="cp-meta">{r.desc.replace(/^Internal SOP: /, '')}</span>
            </span>
            <span className="tag">Internal SOP</span>
            <span className={`cp-src-status ${r.status === 'Verified' ? 'on' : 'manual'}`}>
              <i className="cp-dot" aria-hidden />
              {r.status === 'Verified' ? 'Verified' : 'Active'}
            </span>
            <ChevronRight size={14} className="cp-chev" aria-hidden />
          </button>
        ))}
      </div>
    </Section>
  );
}

// ── KPIs ────────────────────────────────────────────────────────────────────

function KpiStrip({ active, onPick }: { active: KpiKey | null; onPick: (k: KpiKey) => void }) {
  const reqs = useCompliance((s) => s.reqs);
  const actions = useCompliance((s) => s.actions);
  return (
    <div className="cp-kpis" role="group" aria-label="Register indicators (illustrative)">
      {KPI_DEFS.map((k) => (
        <button key={k.key} type="button" className={`cp-kpi t-${KPI_TONE[k.key]} ${active === k.key ? 'on' : ''}`} aria-pressed={active === k.key} onClick={() => onPick(k.key)} title={`${k.why}. Click to filter the register.`}>
          <span className="cp-kpi-label">{k.label}</span>
          <span className="cp-kpi-value num">{kpiValue(k.key, reqs, actions)}</span>
          <span className="cp-kpi-note">Illustrative demo data</span>
        </button>
      ))}
    </div>
  );
}

// ── Categories and deadlines ────────────────────────────────────────────────

function CategoriesSection({ active, onPick }: { active: Category | 'All'; onPick: (c: Category) => void }) {
  const reqs = useCompliance((s) => s.reqs);
  const cats = useMemo(() => categoryBreakdown(reqs), [reqs]);
  const order: Bucket[] = ['verified', 'progress', 'gap', 'none'];
  return (
    <Section title="Compliance categories" subtitle="Stored requirements by status. Not assessed is shown separately, never counted as compliant.">
      <div className="cp-legend">
        {order.map((b) => (
          <span key={b}>
            <i className={`cp-sw b-${b}`} aria-hidden />
            {BUCKET_LABEL[b][0].toUpperCase() + BUCKET_LABEL[b].slice(1)}
          </span>
        ))}
      </div>
      <div className="cp-cats">
        {cats.map((c) => (
          <button key={c.name} className={`cp-cat ${active === c.name ? 'on' : ''}`} onClick={() => onPick(c.name)} aria-pressed={active === c.name}>
            <span>{c.name}</span>
            <span className="cp-bar" aria-label={order.map((b) => `${c.counts[b]} ${BUCKET_LABEL[b]}`).join(', ')}>
              {order
                .filter((b) => c.counts[b])
                .map((b) => (
                  <i key={b} className={`b-${b}`} style={{ width: `${(c.counts[b] / c.n) * 100}%` }} title={`${c.counts[b]} ${BUCKET_LABEL[b]}`} />
                ))}
            </span>
            <b className="num">{c.n}</b>
          </button>
        ))}
      </div>
    </Section>
  );
}

const KIND_LABEL: Record<CAction['kind'], [string, Tone]> = { Overdue: ['Overdue', 'red'], Approval: ['Approval', 'purple'], Inspection: ['Inspection', 'blue'], Deadline: ['Due soon', 'blue'], Evidence: ['Evidence', 'amber'] };

function DeadlinesSection({ onOpen }: { onOpen: (reqId: string) => void }) {
  const actions = useCompliance((s) => s.actions);
  const list = upcomingActions(actions);
  return (
    <Section title="Upcoming deadlines & actions" subtitle={`Counted from ${SAMPLE_TODAY}, the date of the sample records. Each item opens its requirement.`}>
      <div className="cp-list tight">
        {list.map((a) => {
          const d = daysFromToday(a.due);
          const [label, tone] = KIND_LABEL[a.kind];
          return (
            <button key={a.id} className="cp-row dl" onClick={() => onOpen(a.req)}>
              <Pill tone={tone}>{label}</Pill>
              <span className="cp-row-main">
                <b className="ellipsis">{a.title}</b>
                <span className="cp-meta">
                  {a.id} · {a.req} · {a.owner}
                </span>
              </span>
              <span className="cp-meta">{a.due}</span>
              <span className={`cp-when ${d == null ? '' : d < 0 ? 'late' : d <= 7 ? 'soon' : ''}`}>{d == null ? '—' : d < 0 ? `${-d} days late` : d === 0 ? 'today' : `in ${d} days`}</span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

// ── Register ────────────────────────────────────────────────────────────────

const COLS: { label: string; key: SortKey | null }[] = [
  { label: 'ID', key: 'id' },
  { label: 'Source', key: 'src' },
  { label: 'Requirement', key: 'title' },
  { label: 'Affected area', key: 'area' },
  { label: 'Owner', key: 'owner' },
  { label: 'Effective / review', key: 'date' },
  { label: 'Applicability', key: 'appl' },
  { label: 'Status', key: 'status' },
];
const PER_PAGE = 8;
const SRC_IDS = Object.keys(SOURCE_META) as SourceId[];
const initials = (n: string) =>
  n
    .split(' ')
    .map((x) => x[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function RegisterSection({ filter, setFilter, onOpen, onAdd, onSay }: { filter: RegisterFilter; setFilter: (f: RegisterFilter) => void; onOpen: (id: string) => void; onAdd: () => void; onSay: (t: string) => void }) {
  const reqs = useCompliance((s) => s.reqs);
  const actions = useCompliance((s) => s.actions);
  const [sort, setSort] = useState<{ k: SortKey; dir: 1 | -1 }>({ k: 'id', dir: 1 });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const list = useMemo(() => filterRegister(reqs, actions, filter, sort), [reqs, actions, filter, sort]);
  const pages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  const pg = Math.min(page, pages - 1);
  const vis = list.slice(pg * PER_PAGE, pg * PER_PAGE + PER_PAGE);
  const set = (f: Partial<RegisterFilter>) => (setFilter({ ...filter, ...f }), setPage(0));
  const allOn = vis.length > 0 && vis.every((r) => selected.includes(r.id));

  const chips: { label: string; clear: () => void }[] = [];
  if (filter.kpi) chips.push({ label: KPI_DEFS.find((k) => k.key === filter.kpi)!.label, clear: () => set({ kpi: null }) });
  if (filter.q.trim()) chips.push({ label: `"${filter.q.trim()}"`, clear: () => set({ q: '' }) });

  const exportCsv = () => {
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([registerCsv(list)], { type: 'text/csv' }));
    a.href = url;
    a.download = 'compliance-requirements-sample.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onSay(`Exported ${list.length} filtered rows (sample data) to CSV.`);
  };

  return (
    <Section
      title="Requirements register"
      subtitle="External requirements and internal controls. Open a row for its source, applicability and history."
      actions={
        <>
          <button className="btn" onClick={exportCsv}>
            <Download size={14} />
            Export CSV
          </button>
          <button className="btn primary" onClick={onAdd}>
            <Plus size={14} />
            Add requirement
          </button>
        </>
      }
    >
      <div className="cp-filters">
        <label className="cp-search">
          <Search size={14} aria-hidden />
          <input type="search" value={filter.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search ID, title, authority, area, owner…" aria-label="Search requirements" />
        </label>
        <select className="select" value={filter.src} onChange={(e) => set({ src: e.target.value as RegisterFilter['src'] })} aria-label="Source">
          <option value="All">All sources</option>
          {SRC_IDS.map((s) => (
            <option key={s} value={s}>
              {SOURCE_META[s].label}
            </option>
          ))}
        </select>
        <select className="select" value={filter.cat} onChange={(e) => set({ cat: e.target.value as RegisterFilter['cat'] })} aria-label="Category">
          <option value="All">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select className="select" value={filter.status} onChange={(e) => set({ status: e.target.value as RegisterFilter['status'] })} aria-label="Status">
          <option value="All">All statuses</option>
          {(['Not assessed', 'Not started', 'In progress', 'Verified', 'Gap confirmed'] as const).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select className="select" value={filter.appl} onChange={(e) => set({ appl: e.target.value as RegisterFilter['appl'] })} aria-label="Applicability">
          <option value="All">All applicability</option>
          {(['Under review', 'Review required', 'Applicable', 'Not applicable'] as const).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        {(chips.length > 0 || filter.src !== 'All' || filter.cat !== 'All' || filter.status !== 'All' || filter.appl !== 'All') && (
          <span className="cp-chips">
            {chips.map((c) => (
              <button key={c.label} className="cp-chip" onClick={c.clear} aria-label={`Remove filter ${c.label}`}>
                {c.label} <X size={11} aria-hidden />
              </button>
            ))}
            <button className="btn ghost sm" onClick={() => (setFilter(NO_FILTER), setPage(0))}>
              Clear all
            </button>
          </span>
        )}
      </div>

      <div className="cp-table-wrap">
        <table className="table cp-table">
          <thead>
            <tr>
              <th className="cp-check">
                <input
                  type="checkbox"
                  aria-label="Select all rows on this page"
                  checked={allOn}
                  onChange={() => {
                    const ids = vis.map((r) => r.id);
                    setSelected(allOn ? selected.filter((x) => !ids.includes(x)) : [...new Set([...selected, ...ids])]);
                  }}
                />
              </th>
              {COLS.map((c) => (
                <th key={c.label} aria-sort={c.key && sort.k === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : undefined}>
                  {c.key ? (
                    <button className="cp-sort" onClick={() => setSort({ k: c.key!, dir: sort.k === c.key ? (-sort.dir as 1 | -1) : 1 })}>
                      {c.label}
                      {sort.k === c.key ? (sort.dir > 0 ? ' ↑' : ' ↓') : ''}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vis.map((r) => (
              <tr key={r.id}>
                <td className="cp-check">
                  <input type="checkbox" aria-label={`Select ${r.id}`} checked={selected.includes(r.id)} onChange={() => setSelected(selected.includes(r.id) ? selected.filter((x) => x !== r.id) : [...selected, r.id])} />
                </td>
                <td className="mono">{r.id}</td>
                <td>
                  <span className="cp-src-cell">
                    <SourceLogo src={r.src} size="sm" />
                    {SOURCE_META[r.src].label}
                  </span>
                </td>
                <td>
                  <button className="cp-link" onClick={() => onOpen(r.id)}>
                    {r.title}
                  </button>
                </td>
                <td className="dim">{r.area}</td>
                <td>
                  <span className="cp-owner">
                    <i aria-hidden>{initials(r.owner)}</i>
                    {r.owner}
                  </span>
                </td>
                <td className="dim">{r.date}</td>
                <td>
                  <Pill tone={APPL_TONE[r.appl] ?? 'grey'}>{r.appl}</Pill>
                </td>
                <td>
                  <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && (
          <div className="cp-empty" role="status">
            No requirements match these filters.{' '}
            <button className="cp-link" onClick={() => (setFilter(NO_FILTER), setPage(0))}>
              Clear filters
            </button>
          </div>
        )}
      </div>
      <div className="cp-pager">
        <span>
          Showing {list.length ? pg * PER_PAGE + 1 : 0}–{pg * PER_PAGE + vis.length} of {list.length} sample requirements
          {selected.length ? ` · ${selected.length} selected` : ''}
        </span>
        <span className="cp-pager-btns">
          <button className="btn sm" disabled={pg === 0} onClick={() => setPage(pg - 1)}>
            ‹ Previous
          </button>
          <button className="btn sm" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>
            Next ›
          </button>
        </span>
      </div>
    </Section>
  );
}

// ── Detail drawer ───────────────────────────────────────────────────────────

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function DecisionBox({ current, onSave }: { current: Decision; onSave: (d: Decision, rationale: string) => void }) {
  const [d, setD] = useState<Decision>(current);
  const [why, setWhy] = useState('');
  const [err, setErr] = useState('');
  return (
    <section className="cp-box">
      <h4>Applicability decision</h4>
      <p className="cp-meta">A person records whether this applies and why. A keyword match alone is never enough.</p>
      <div className="seg" role="radiogroup" aria-label="Applicability">
        {(['Applicable', 'Not applicable', 'Needs review'] as Decision[]).map((x) => (
          <button key={x} role="radio" aria-checked={d === x} className={d === x ? 'on' : ''} onClick={() => setD(x)}>
            {x}
          </button>
        ))}
      </div>
      <label className="field">
        Rationale {d !== 'Needs review' && <span className="cp-req">(required)</span>}
        <textarea className="input cp-textarea" rows={2} value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why does this apply (or not) to this plant? Cite the clause or permit." />
      </label>
      {err && (
        <span className="cp-err" role="alert">
          {err}
        </span>
      )}
      <button
        className="btn primary cp-self-start"
        onClick={() => {
          if (d !== 'Needs review' && !why.trim()) return setErr('Add a rationale before recording an applicability decision.');
          setErr('');
          setWhy('');
          onSave(d, why);
        }}
      >
        Save decision
      </button>
    </section>
  );
}

function RecordDrawer({ drawer, onClose, onSay, onAddObligation }: { drawer: NonNullable<Drawer>; onClose: () => void; onSay: (t: string) => void; onAddObligation: (src: SourceId) => void }) {
  useEscape(onClose);
  const { sources, reqs, updates, actions, decideRequirement, decideUpdate, addAction } = useCompliance();
  const req = drawer.kind === 'req' ? reqs.find((r) => r.id === drawer.id) : undefined;
  const upd = drawer.kind === 'upd' ? updates.find((u) => u.id === drawer.id) : undefined;
  if (!req && !upd) return null;
  const srcId = (req?.src ?? upd!.src) as SourceId;
  const source = sources.find((s) => s.id === srcId);
  const history = [...(req?.history ?? upd!.history)].reverse();

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer cp-drawer" role="dialog" aria-modal="true" aria-label={req?.title ?? upd!.title}>
        <header className="drawer-h">
          <SourceLogo src={srcId} />
          <div className="cp-drawer-t">
            <span className="cp-meta">{req ? `${req.id} · ${req.type === 'ext' ? 'External requirement' : 'Internal control'} · ${SOURCE_META[req.src].label}` : `${source?.name} · ${upd!.kind}`}</span>
            <h2>{req?.title ?? upd!.title}</h2>
          </div>
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={15} />
          </button>
        </header>
        <div className="drawer-b">
          <div className="cp-pills">
            {req ? (
              <>
                <Pill tone={APPL_TONE[req.appl] ?? 'grey'}>Applicability: {req.appl}</Pill>
                <Pill tone={STATUS_TONE[req.status]}>Status: {req.status}</Pill>
              </>
            ) : (
              <>
                <Pill tone={APPL_TONE[upd!.status] ?? 'grey'}>{upd!.status}</Pill>
                <Pill tone="grey">Provenance: manual entry</Pill>
              </>
            )}
            <span className="cp-sample">Sample record</span>
          </div>
          <p className="cp-desc">{req?.desc ?? upd!.summary}</p>
          <dl className="cp-facts">
            {(req
              ? [
                  ['Category', req.cat],
                  ['Factory area', req.area],
                  ['Owner', req.owner],
                  ['Priority', req.prio],
                  ['Effective / review', req.date],
                  ['Source document', req.type === 'ext' ? 'Not linked — sample record' : 'Internal SOP (sample)'],
                  ['Official URL', source?.url || 'Not recorded'],
                  ['Verification', 'Unverified sample — check against the original source'],
                ]
              : [
                  ['Authority', source?.name ?? '—'],
                  ['Document number', 'Not recorded'],
                  ['Published', upd!.pub],
                  ['Effective', upd!.eff],
                  ['Original source URL', source?.url || 'Not recorded — add before approval'],
                  ['Detected', `Entered manually, ${upd!.history[0].t}`],
                  ['Verification', 'Unverified sample'],
                  [
                    'Related requirements',
                    reqs
                      .filter((r) => r.src === upd!.src)
                      .map((r) => r.id)
                      .join(', ') || 'None',
                  ],
                ]
            ).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>

          {upd && (
            <section className="cp-box">
              <h4>Extracted obligations</h4>
              <div className="cp-warn">
                <TriangleAlert size={16} aria-hidden />
                <span>
                  <b>AI analysis unavailable.</b> No AI provider is configured, so nothing has been extracted automatically. Add obligations by hand from the original document; each one needs its supporting passage.
                </span>
              </div>
              <div className="cp-btns">
                <button className="btn" disabled title="No AI provider is configured">
                  Analyse document (unavailable)
                </button>
                <button className="btn primary" onClick={() => onAddObligation(upd.src)}>
                  Add obligation manually
                </button>
              </div>
            </section>
          )}

          <DecisionBox
            key={drawer.id}
            current={req ? (req.appl === 'Applicable' || req.appl === 'Not applicable' ? req.appl : 'Needs review') : upd!.status === 'Applicable' || upd!.status === 'Not applicable' ? upd!.status : 'Needs review'}
            onSave={(d, why) => {
              if (req) decideRequirement(req.id, d, why);
              else decideUpdate(upd!.id, d, why);
              onSay(`${req?.id ?? 'Update'}: applicability recorded (sample).`);
            }}
          />

          {req && (
            <>
              <section className="cp-box">
                <div className="cp-box-h">
                  <h4>Evidence</h4>
                  <button className="btn ghost sm" onClick={() => onSay('Uploading and linking documents belongs to the Evidence & Documents screen, which is not built yet.')}>
                    + Link document
                  </button>
                </div>
                <div className="cp-line">
                  <span>{req.ev === 'Missing' ? 'No document linked' : `${req.title} record`}</span>
                  <Pill tone={EV_TONE[req.ev]}>{req.ev}</Pill>
                </div>
                <p className="cp-meta">A stored document counts as evidence only after a reviewer approves it.</p>
              </section>
              <section className="cp-box">
                <div className="cp-box-h">
                  <h4>Corrective actions</h4>
                  <button className="btn ghost sm" onClick={() => onSay(`${addAction(req.id)} created for ${req.id} (sample).`)}>
                    + Create action
                  </button>
                </div>
                {actions
                  .filter((a) => a.req === req.id)
                  .map((a) => (
                    <div key={a.id} className="cp-line act">
                      <span className="mono">{a.id}</span>
                      <span>{a.title}</span>
                      <span className="cp-meta">{a.due}</span>
                      <Pill tone={ACT_TONE[a.status]}>{a.status}</Pill>
                    </div>
                  ))}
                {!actions.some((a) => a.req === req.id) && <span className="cp-meta">No actions linked.</span>}
              </section>
            </>
          )}

          <section className="cp-box">
            <h4>History</h4>
            {history.map((h, i) => (
              <div key={i} className="cp-line hist">
                <span className="cp-meta">{h.t}</span>
                <span>{h.e}</span>
              </div>
            ))}
          </section>
        </div>
      </aside>
    </>
  );
}

// ── Modals ──────────────────────────────────────────────────────────────────

function ModalShell({ title, note, onClose, onSave, saveLabel, err, children }: { title: string; note: string; onClose: () => void; onSave: () => void; saveLabel: string; err: string; children: ReactNode }) {
  useEscape(onClose);
  return (
    <div className="cp-modal-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cp-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="cp-box-h">
          <h2>{title}</h2>
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </header>
        <p className="cp-meta">{note}</p>
        {children}
        {err && (
          <span className="cp-err" role="alert">
            <CircleAlert size={13} aria-hidden /> {err}
          </span>
        )}
        <footer className="cp-btns end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={onSave}>
            {saveLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

const METHODS: { v: CheckMethod; label: string; disabled?: string }[] = [
  { v: 'manual', label: 'Manual entry' },
  { v: 'upload', label: 'Document upload' },
  { v: 'feed', label: 'Official feed / API', disabled: 'No connector exists for this authority yet' },
  { v: 'none', label: 'Not connected' },
];

function SourceModal({ id, onClose, onSaved }: { id: Source['id']; onClose: () => void; onSaved: (t: string) => void }) {
  const source = useCompliance((s) => s.sources.find((x) => x.id === id))!;
  const configure = useCompliance((s) => s.configureSource);
  const [name, setName] = useState(source.name);
  const [url, setUrl] = useState(source.url);
  const [method, setMethod] = useState<CheckMethod>(source.method);
  const [err, setErr] = useState('');
  const save = () => {
    const u = url.trim();
    if (!name.trim()) return setErr('Source name is required.');
    if (u && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(u)) return setErr('Enter a full https:// address.');
    configure(id, { name, url: u, method });
    onSaved(`${source.acr} saved. Status: ${method === 'none' ? 'Not connected' : 'Manual monitoring'}.`);
    onClose();
  };
  return (
    <ModalShell title={`Configure ${source.acr}`} note="Sources are candidates. Saving a URL does not start automatic monitoring; no connector is built yet." onClose={onClose} onSave={save} saveLabel="Save source" err={err}>
      <div className="cp-modal-logo">
        <SourceLogo src={id} size="lg" />
      </div>
      <label className="field">
        Source name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Official website or publication page
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" />
      </label>
      <div className="field">
        Check method
        <div className="seg" role="radiogroup" aria-label="Check method">
          {METHODS.map((m) => (
            <button key={m.v} role="radio" aria-checked={method === m.v} className={method === m.v ? 'on' : ''} disabled={!!m.disabled} title={m.disabled} onClick={() => setMethod(m.v)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </ModalShell>
  );
}

function AddRequirementModal({ initialSrc, onClose, onSaved }: { initialSrc?: SourceId; onClose: () => void; onSaved: (t: string) => void }) {
  const add = useCompliance((s) => s.addRequirement);
  const [title, setTitle] = useState('');
  const [area, setArea] = useState('');
  const [owner, setOwner] = useState('');
  const [src, setSrc] = useState<SourceId | ''>(initialSrc ?? '');
  const [err, setErr] = useState('');
  const save = () => {
    if (!title.trim() || !src) return setErr('Title and source are required.');
    const id = add({ title, src, area, owner });
    onSaved(`${id} added. It starts as Review required and Not assessed.`);
    onClose();
  };
  return (
    <ModalShell title="Add requirement" note={'New records start as "Review required" and "Not assessed" until someone records applicability and evidence.'} onClose={onClose} onSave={save} saveLabel="Add requirement" err={err}>
      <label className="field">
        Title
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Quarterly noise survey in press hall" autoFocus />
      </label>
      <label className="field">
        Source
        <select className="select" value={src} onChange={(e) => setSrc(e.target.value as SourceId)}>
          <option value="" disabled>
            Choose a source…
          </option>
          {SRC_IDS.map((s) => (
            <option key={s} value={s}>
              {SOURCE_META[s].label}
            </option>
          ))}
        </select>
      </label>
      <div className="cp-btns">
        <label className="field grow">
          Factory area
          <input className="input" value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Presses" />
        </label>
        <label className="field grow">
          Owner
          <input className="input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Nida Shah" />
        </label>
      </div>
    </ModalShell>
  );
}
