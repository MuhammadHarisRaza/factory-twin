/**
 * Per-viewer UI state of the Production workspace: which Analysis view is open. Remembered in this
 * browser only (a convenience); the page works the same when storage is unavailable.
 */
import { create } from 'zustand';
import { openView } from '../../app/store';
import type { RangeKey } from '../../model/telemetry';

export type AnalysisView = 'equipment' | 'capacity' | 'downtime' | 'shifts' | 'finance';
export const ANALYSIS_VIEWS: { value: AnalysisView; label: string }[] = [
  { value: 'equipment', label: 'Equipment OEE' },
  { value: 'capacity', label: 'Capacity waterfall' },
  { value: 'downtime', label: 'Downtime Pareto' },
  { value: 'shifts', label: 'Shift comparison' },
  { value: 'finance', label: 'Assumptions & what-ifs' },
];

const KEY = 'wai.production.analysis';
const load = (): AnalysisView => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    return ANALYSIS_VIEWS.some((x) => x.value === v) ? (v as AnalysisView) : 'equipment';
  } catch {
    return 'equipment';
  }
};

export const useProductionUi = create<{
  analysis: AnalysisView;
  setAnalysis: (v: AnalysisView) => void;
  /** Material flow: the buffer the chart area shows (null = the view's own focus) and the chart range. */
  materialBuffer: string | null;
  materialRange: RangeKey;
  setMaterialBuffer: (id: string | null) => void;
  setMaterialRange: (r: RangeKey) => void;
}>((set) => ({
  analysis: load(),
  materialBuffer: null,
  materialRange: '8h',
  setMaterialBuffer: (materialBuffer) => set({ materialBuffer }),
  setMaterialRange: (materialRange) => set({ materialRange }),
  setAnalysis: (analysis) => {
    set({ analysis });
    try {
      localStorage.setItem(KEY, analysis);
    } catch {
      /* storage unavailable: keep in memory only */
    }
  },
}));

/** Open Production › Material flow (#/production?tab=material), optionally on one buffer's charts. */
export function openMaterialFlow(bufferId?: string | null) {
  if (bufferId) useProductionUi.getState().setMaterialBuffer(bufferId);
  openView('production', 'material');
}
