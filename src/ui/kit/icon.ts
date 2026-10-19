import { memo } from 'react';
import type { LucideIcon } from 'lucide-react';

const PURE = new WeakMap<LucideIcon, LucideIcon>();

/**
 * The icon component memoised (one per icon): icons are pure functions of a few primitive props, and an icon inside
 * a chip, badge or gauge that re-renders every simulated minute otherwise rebuilds its SVG (and, in development,
 * each element's debug stack) every time.
 */
export function pureIcon(Icon: LucideIcon): LucideIcon {
  let p = PURE.get(Icon);
  if (!p) PURE.set(Icon, (p = memo(Icon) as unknown as LucideIcon));
  return p;
}
