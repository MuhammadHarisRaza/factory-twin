import { CircleCheck, CircleX, OctagonX, TriangleAlert } from 'lucide-react';
import type { QualityInspection } from '../../model/types';
import { StatusBadge } from '../../ui/kit/Status';

/** Inspection result: icon + label. */
export function ResultBadge({ result }: { result: QualityInspection['result'] }) {
  return result === 'pass' ? <StatusBadge tone="good" icon={CircleCheck} label="Pass" /> : <StatusBadge tone="serious" icon={CircleX} label="Reject" />;
}

const SEV = {
  minor: { tone: 'warning', icon: TriangleAlert, label: 'Minor' },
  major: { tone: 'serious', icon: TriangleAlert, label: 'Major' },
  critical: { tone: 'critical', icon: OctagonX, label: 'Critical' },
} as const;

/** Defect severity: icon + label; '—' for records without a defect. */
export function DefectSeverity({ severity }: { severity: QualityInspection['severity'] }) {
  if (!severity) return <span className="muted">—</span>;
  return <StatusBadge {...SEV[severity]} />;
}
