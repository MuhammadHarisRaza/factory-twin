/**
 * Per-viewer UI state of the Production workspace: which Analysis view is open. Remembered in this
 * browser only (a convenience); the page works the same when storage is unavailable.
 */
import { create } from 'zustand';

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

export const useProductionUi = create<{ analysis: AnalysisView; setAnalysis: (v: AnalysisView) => void }>((set) => ({
  analysis: load(),
  setAnalysis: (analysis) => {
    set({ analysis });
    try {
      localStorage.setItem(KEY, analysis);
    } catch {
      /* storage unavailable: keep in memory only */
    }
  },
}));
