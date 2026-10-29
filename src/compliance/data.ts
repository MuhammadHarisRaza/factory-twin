/**
 * Compliance Overview — sample records. Every authority, update, requirement and action here is an
 * ILLUSTRATIVE sample entered by hand for the demo: nothing is fetched from an authority, no source is
 * monitored automatically, and no record states the plant's actual compliance position. Authority
 * names and logos identify candidate regulators only (logos from Wikipedia / Wikimedia Commons; no
 * affiliation or endorsement). Which authorities actually apply has to be validated for the business.
 */

export type SourceId = 'fbr' | 'secp' | 'epa' | 'psqca' | 'labour' | 'eobi' | 'internal';

/** How a source is checked. 'feed' needs a connector, and none exists in this release. */
export type CheckMethod = 'manual' | 'upload' | 'feed' | 'none';

/** Never 'Monitoring active': that needs a configured process that has successfully checked the source. */
export type SourceStatus = 'Manual monitoring' | 'Not connected';

export type Source = {
  id: Exclude<SourceId, 'internal'>;
  acr: string;
  name: string;
  desc: string;
  cat: string;
  jur: string;
  status: SourceStatus;
  /** Last manual check (sample), or null when never checked. */
  checked: string | null;
  /** Official website — empty until a person records it. */
  url: string;
  method: CheckMethod;
};

export type Applicability = 'Applicable' | 'Not applicable' | 'Under review' | 'Review required';
export type ReqStatus = 'Not assessed' | 'Not started' | 'In progress' | 'Verified' | 'Gap confirmed';
export type EvidenceState = 'Current' | 'Pending review' | 'Expiring' | 'Expired' | 'Missing';
export type Priority = 'High' | 'Medium' | 'Low';
export type HistoryEntry = { t: string; e: string };

export type Requirement = {
  id: string;
  src: SourceId;
  type: 'ext' | 'int';
  title: string;
  cat: Category;
  area: string;
  owner: string;
  /** Effective or review date (or a recurrence such as "Daily"). */
  date: string;
  appl: Applicability;
  status: ReqStatus;
  prio: Priority;
  ev: EvidenceState;
  desc: string;
  history: HistoryEntry[];
};

export type UpdateStatus = 'New' | 'Review required' | 'Applicability under review' | 'Applicable' | 'Not applicable';

export type RegUpdate = { id: string; src: Exclude<SourceId, 'internal'>; title: string; kind: string; pub: string; eff: string; status: UpdateStatus; summary: string; history: HistoryEntry[] };

export type ActionKind = 'Overdue' | 'Approval' | 'Inspection' | 'Deadline' | 'Evidence';
export type ActionStatus = 'Overdue' | 'Open' | 'Awaiting approval' | 'Awaiting evidence' | 'Completed';
export type CAction = { id: string; req: string; title: string; owner: string; due: string; status: ActionStatus; kind: ActionKind };

export const CATEGORIES = [
  'Environmental',
  'Occupational health & safety',
  'Product quality',
  'Labour & social security',
  'Tax & corporate',
  'Utilities & resources',
  'Factory operations & SOPs',
  'Other regulatory obligations',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** "Today" of the sample records: deadlines are counted from this date so the sample stays consistent. */
export const SAMPLE_TODAY = '26 Oct 2026';
export const SAMPLE_LOADED = '26 Oct 2026, 10:45';

const logo = (f: string) => `${import.meta.env.BASE_URL}compliance/logos/${f}`;

/** Display metadata per source: short label, tone and logo (null = no logo, the acronym is shown). */
export const SOURCE_META: Record<SourceId, { label: string; acr: string; tone: Tone; logo: string | null; logoNote?: string }> = {
  fbr: { label: 'FBR', acr: 'FBR', tone: 'blue', logo: logo('fbr.png') },
  secp: { label: 'SECP', acr: 'SECP', tone: 'green', logo: logo('secp.png') },
  epa: { label: 'Punjab EPA', acr: 'EPA', tone: 'orange', logo: logo('punjab.svg'), logoNote: 'Emblem of the Government of Punjab' },
  psqca: { label: 'PSQCA', acr: 'PSQCA', tone: 'purple', logo: logo('psqca.jpg') },
  labour: { label: 'Labour', acr: 'LAB', tone: 'red', logo: logo('punjab.svg'), logoNote: 'Emblem of the Government of Punjab' },
  eobi: { label: 'EOBI / PESSI', acr: 'EOBI', tone: 'amber', logo: logo('eobi.png') },
  internal: { label: 'Internal SOP', acr: 'INT', tone: 'grey', logo: null },
};

export type Tone = 'green' | 'amber' | 'red' | 'grey' | 'blue' | 'purple' | 'orange';

/** Category a new requirement from each source starts in. */
export const DEFAULT_CATEGORY: Record<SourceId, Category> = {
  fbr: 'Tax & corporate',
  secp: 'Tax & corporate',
  epa: 'Environmental',
  psqca: 'Product quality',
  labour: 'Occupational health & safety',
  eobi: 'Labour & social security',
  internal: 'Factory operations & SOPs',
};

/** ID prefix of new requirements per source. */
export const ID_PREFIX: Record<SourceId, string> = { fbr: 'FBR', secp: 'SECP', epa: 'EPA', psqca: 'PSQCA', labour: 'LAB', eobi: 'SOC', internal: 'INT' };

const S = (id: Source['id'], acr: string, name: string, desc: string, cat: string, jur: string, status: SourceStatus, checked: string | null): Source => ({
  id,
  acr,
  name,
  desc,
  cat,
  jur,
  status,
  checked,
  url: '',
  method: status === 'Not connected' ? 'none' : 'manual',
});

export const SEED_SOURCES: Source[] = [
  S('fbr', 'FBR', 'Federal Board of Revenue', 'Taxation, sales tax, excise and reporting', 'Tax', 'Federal', 'Manual monitoring', '20 Oct 2026'),
  S('secp', 'SECP', 'Securities and Exchange Commission of Pakistan', 'Corporate filing, compliance and governance', 'Corporate', 'Federal', 'Manual monitoring', '18 Oct 2026'),
  S('epa', 'EPA', 'Punjab Environmental Protection Agency', 'Environmental regulations, emissions and effluent', 'Environmental', 'Punjab', 'Manual monitoring', '22 Oct 2026'),
  S('psqca', 'PSQCA', 'Pakistan Standards & Quality Control Authority', 'Product standards and certification', 'Product quality', 'Federal', 'Not connected', null),
  S('labour', 'LABOUR', 'Punjab Labour & Human Resource Department', 'Workplace safety, labour laws and employment', 'Labour & OHS', 'Punjab', 'Manual monitoring', '15 Oct 2026'),
  S('eobi', 'EOBI', 'EOBI / PESSI', 'Employee benefits and social security', 'Social security', 'Federal / Punjab', 'Not connected', null),
];

const entered = (t: string): HistoryEntry[] => [{ t, e: 'Entered manually as a sample update' }];

export const SEED_UPDATES: RegUpdate[] = [
  { id: 'u1', src: 'fbr', title: 'Sales-tax return reporting format change', kind: 'Notification (sample)', pub: '01 Apr 2026', eff: 'Not stated', status: 'Applicability under review', summary: 'Sample text: registered manufacturers may need to report production data in a revised format.', history: entered('24 Oct 2026') },
  { id: 'u2', src: 'epa', title: 'Revised kiln stack emission limits', kind: 'Standard revision (sample)', pub: '12 Oct 2026', eff: '01 Jan 2027', status: 'Review required', summary: 'Sample text: revised limits for gaseous emissions and effluent from ceramic kilns.', history: entered('23 Oct 2026') },
  { id: 'u3', src: 'psqca', title: 'Ceramic tile test-method revision', kind: 'Standard revision (sample)', pub: '05 Oct 2026', eff: 'Not stated', status: 'Review required', summary: 'Sample text: revision to dimensional, water-absorption and strength testing of tiles.', history: entered('21 Oct 2026') },
  {
    id: 'u4',
    src: 'secp',
    title: 'Annual return filing reminder',
    kind: 'Circular (sample)',
    pub: '28 Sep 2026',
    eff: '30 Nov 2026',
    status: 'Applicable',
    summary: 'Sample text: reminder of annual return filing and updated reporting fields.',
    history: [...entered('02 Oct 2026'), { t: '06 Oct 2026', e: 'Marked applicable — company files annual returns (sample rationale)' }],
  },
  { id: 'u5', src: 'labour', title: 'Workplace safety inspection checklist update', kind: 'Guidance (sample)', pub: '14 Sep 2026', eff: 'Not stated', status: 'New', summary: 'Sample text: updated checklist items for factory safety inspections.', history: entered('15 Oct 2026') },
];

const R = (id: string, src: SourceId, title: string, cat: Category, area: string, owner: string, date: string, appl: Applicability, status: ReqStatus, prio: Priority, ev: EvidenceState, desc: string): Requirement => ({
  id,
  src,
  type: src === 'internal' ? 'int' : 'ext',
  title,
  cat,
  area,
  owner,
  date,
  appl,
  status,
  prio,
  ev,
  desc,
  history: [{ t: '12 Oct 2026', e: 'Created from sample data' }],
});

// Owners are fictional names.
export const SEED_REQUIREMENTS: Requirement[] = [
  R('FBR-001', 'fbr', 'Monthly sales-tax return filing', 'Tax & corporate', 'Corporate / Finance', 'Ayesha Malik', '15 Nov 2026', 'Applicable', 'In progress', 'Medium', 'Pending review', 'Sample requirement: file the monthly sales-tax return and keep the acknowledgement.'),
  R('FBR-002', 'fbr', 'Withholding tax statements', 'Tax & corporate', 'Corporate / Finance', 'Ayesha Malik', '10 Jan 2027', 'Under review', 'Not assessed', 'Low', 'Missing', 'Sample requirement: periodic withholding statements.'),
  R('EPA-001', 'epa', 'Kiln stack emission monitoring', 'Environmental', 'Kiln', 'Bilal Ahmed', '02 Nov 2026', 'Review required', 'Not assessed', 'High', 'Missing', 'Sample requirement: periodic stack monitoring for kiln exhaust by an approved lab.'),
  R('EPA-002', 'epa', 'Wastewater discharge sampling', 'Environmental', 'Wastewater treatment', 'Sara Ahmed', '20 Oct 2026', 'Applicable', 'Gap confirmed', 'High', 'Expired', 'Sample requirement: sample and test effluent before discharge; last result is out of date.'),
  R('EPA-003', 'epa', 'Dust emission controls at spray dryer', 'Environmental', 'Spray dryer', 'Bilal Ahmed', '30 Nov 2026', 'Under review', 'Not assessed', 'Medium', 'Missing', 'Sample requirement: dust controls and records for the spray dryer exhaust.'),
  R('PSQCA-001', 'psqca', 'Tile dimensional & water-absorption testing', 'Product quality', 'Quality lab', 'Usman Malik', '05 Oct 2026', 'Applicable', 'Verified', 'Medium', 'Current', 'Sample requirement: routine product testing with retained lab records.'),
  R('SECP-001', 'secp', 'Annual company returns filing', 'Tax & corporate', 'Corporate', 'Ayesha Malik', '30 Nov 2026', 'Applicable', 'Not started', 'Medium', 'Missing', 'Sample requirement: file the annual return and keep proof of submission.'),
  R('LAB-001', 'labour', 'Workplace safety inspection register', 'Occupational health & safety', 'Whole plant', 'Nida Shah', '18 Oct 2026', 'Review required', 'In progress', 'High', 'Pending review', 'Sample requirement: keep a register of periodic safety inspections and fixes.'),
  R('SOC-001', 'eobi', 'Employee social security contributions', 'Labour & social security', 'HR', 'Nida Shah', '15 Nov 2026', 'Applicable', 'In progress', 'Medium', 'Pending review', 'Sample requirement: monthly contributions and employee registrations.'),
  R('UTL-001', 'internal', 'Gas & electricity metering records', 'Utilities & resources', 'Utilities', 'Bilal Ahmed', '31 Dec 2026', 'Under review', 'Not assessed', 'Low', 'Missing', 'Sample control: keep monthly utility meter readings for reconciliation.'),
  R('INT-001', 'internal', 'Kiln safety inspection (daily)', 'Factory operations & SOPs', 'Kiln', 'Nida Shah', 'Daily', 'Applicable', 'In progress', 'High', 'Current', 'Internal SOP: high-temperature area inspection and safety checklist each shift.'),
  R('INT-002', 'internal', 'Dust collector maintenance checklist', 'Factory operations & SOPs', 'Dust collection', 'Bilal Ahmed', 'Weekly', 'Applicable', 'Verified', 'Medium', 'Current', 'Internal SOP: preventive maintenance checklist for the dust collection system.'),
  R('INT-003', 'internal', 'Wastewater sampling procedure', 'Factory operations & SOPs', 'Wastewater treatment', 'Sara Ahmed', 'Monthly', 'Applicable', 'In progress', 'High', 'Expiring', 'Internal SOP: effluent sampling steps and lab hand-over.'),
  R('INT-004', 'internal', 'Finished tile quality inspection', 'Factory operations & SOPs', 'Sorting & QA', 'Usman Malik', 'Each batch', 'Applicable', 'Verified', 'Medium', 'Current', 'Internal SOP: inspection criteria for finished tiles before packing.'),
];

export const SEED_ACTIONS: CAction[] = [
  { id: 'ACT-001', req: 'EPA-002', title: 'Repeat wastewater sample and lab test', owner: 'Sara Ahmed', due: '20 Oct 2026', status: 'Overdue', kind: 'Overdue' },
  { id: 'ACT-004', req: 'LAB-001', title: 'Refit guard on press 2 (safety walk finding)', owner: 'Nida Shah', due: '18 Oct 2026', status: 'Overdue', kind: 'Overdue' },
  { id: 'ACT-005', req: 'INT-002', title: 'Approve dust collector checklist v3', owner: 'Bilal Ahmed', due: '28 Oct 2026', status: 'Awaiting approval', kind: 'Approval' },
  { id: 'ACT-002', req: 'EPA-001', title: 'Obtain kiln stack monitoring report', owner: 'Bilal Ahmed', due: '02 Nov 2026', status: 'Open', kind: 'Deadline' },
  { id: 'ACT-006', req: 'INT-003', title: 'Renew lab hand-over form (expires soon)', owner: 'Sara Ahmed', due: '05 Nov 2026', status: 'Awaiting evidence', kind: 'Evidence' },
  { id: 'ACT-003', req: 'SECP-001', title: 'Upload annual return acknowledgement', owner: 'Ayesha Malik', due: '30 Nov 2026', status: 'Awaiting evidence', kind: 'Evidence' },
  { id: 'ACT-007', req: 'INT-001', title: 'Monthly kiln area internal inspection', owner: 'Nida Shah', due: '31 Oct 2026', status: 'Open', kind: 'Inspection' },
];
