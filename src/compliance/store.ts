/**
 * Compliance records held in memory for this browser session (sample data; no backend). Every
 * change a person makes is written to the record's history.
 */
import { create } from 'zustand';
import { DEFAULT_CATEGORY, ID_PREFIX, SAMPLE_TODAY, SEED_ACTIONS, SEED_REQUIREMENTS, SEED_SOURCES, SEED_UPDATES, type CAction, type CheckMethod, type Requirement, type RegUpdate, type Source, type SourceId } from './data';
import { nextId } from './derive';

/** A person's applicability decision. 'Needs review' keeps the record in the review queue. */
export type Decision = 'Applicable' | 'Not applicable' | 'Needs review';

const USER = 'Demo user';
const note = (rationale: string) => (rationale.trim() ? ` — ${rationale.trim()}` : '');

type ComplianceState = {
  sources: Source[];
  updates: RegUpdate[];
  reqs: Requirement[];
  actions: CAction[];
  configureSource: (id: Source['id'], v: { name: string; url: string; method: CheckMethod }) => void;
  decideRequirement: (id: string, d: Decision, rationale: string) => void;
  decideUpdate: (id: string, d: Decision, rationale: string) => void;
  addAction: (reqId: string) => string;
  addRequirement: (v: { title: string; src: SourceId; area: string; owner: string }) => string;
  reset: () => void;
};

const seed = () => ({ sources: SEED_SOURCES, updates: SEED_UPDATES, reqs: SEED_REQUIREMENTS, actions: SEED_ACTIONS });

export const useCompliance = create<ComplianceState>((set, get) => ({
  ...seed(),
  configureSource: (id, v) =>
    set((s) => ({
      // Saving a URL never starts monitoring: a source is either checked by hand or not connected.
      sources: s.sources.map((x) => (x.id === id ? { ...x, name: v.name.trim(), url: v.url.trim(), method: v.method, status: v.method === 'none' ? 'Not connected' : 'Manual monitoring' } : x)),
    })),
  decideRequirement: (id, d, rationale) =>
    set((s) => ({
      reqs: s.reqs.map((r) => {
        if (r.id !== id) return r;
        const appl = d === 'Needs review' ? 'Review required' : d;
        return { ...r, appl, status: d === 'Not applicable' ? 'Not assessed' : r.status, history: [...r.history, { t: SAMPLE_TODAY, e: `Applicability set to ${appl} by ${USER}${note(rationale)}` }] };
      }),
    })),
  decideUpdate: (id, d, rationale) =>
    set((s) => ({
      updates: s.updates.map((u) => {
        if (u.id !== id) return u;
        const status = d === 'Needs review' ? 'Applicability under review' : d;
        return { ...u, status, history: [...u.history, { t: SAMPLE_TODAY, e: `Marked ${status} by ${USER}${note(rationale)}` }] };
      }),
    })),
  addAction: (reqId) => {
    const s = get();
    const r = s.reqs.find((x) => x.id === reqId);
    const id = nextId(s.actions, 'ACT');
    set({
      actions: [...s.actions, { id, req: reqId, title: `Follow-up for ${reqId}`, owner: r?.owner ?? 'Unassigned', due: '09 Nov 2026', status: 'Open', kind: 'Deadline' }],
      reqs: s.reqs.map((x) => (x.id === reqId ? { ...x, history: [...x.history, { t: SAMPLE_TODAY, e: `Action ${id} created by ${USER}` }] } : x)),
    });
    return id;
  },
  addRequirement: (v) => {
    const s = get();
    const id = nextId(s.reqs, ID_PREFIX[v.src]);
    // New records start unassessed: nothing counts as compliant until a person records it.
    const r: Requirement = {
      id,
      src: v.src,
      type: v.src === 'internal' ? 'int' : 'ext',
      title: v.title.trim(),
      cat: DEFAULT_CATEGORY[v.src],
      area: v.area.trim() || 'Not mapped',
      owner: v.owner.trim() || 'Unassigned',
      date: 'Not set',
      appl: 'Review required',
      status: 'Not assessed',
      prio: 'Medium',
      ev: 'Missing',
      desc: `Added by ${USER}.`,
      history: [{ t: SAMPLE_TODAY, e: `Created by ${USER}` }],
    };
    set({ reqs: [...s.reqs, r] });
    return id;
  },
  reset: () => set(seed()),
}));
