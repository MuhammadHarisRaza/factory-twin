import { useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type Placement = 'top' | 'bottom' | 'right' | 'left';

/** Positions a tooltip next to an anchor rectangle, flipped and clamped to the viewport. */
function TipLayer({ rect, placement, children }: { rect: DOMRect; placement: Placement; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const m = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = rect.bottom + m;
    if (placement === 'top') {
      top = rect.top - h - m;
      if (top < 4) top = rect.bottom + m;
    } else if (placement === 'bottom') {
      if (top + h > vh - 4) top = rect.top - h - m;
    } else {
      top = rect.top + rect.height / 2 - h / 2;
      left = placement === 'right' ? rect.right + m : rect.left - w - m;
      if (placement === 'right' && left + w > vw - 4) left = rect.left - w - m;
      if (placement === 'left' && left < 4) left = rect.right + m;
    }
    left = Math.max(4, Math.min(vw - w - 4, left));
    top = Math.max(4, Math.min(vh - h - 4, top));
    setPos((p) => (p && Math.abs(p.left - left) < 0.5 && Math.abs(p.top - top) < 0.5 ? p : { left, top }));
  });
  return createPortal(
    <div ref={ref} className="tw-tip" role="tooltip" style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
      {children}
    </div>,
    document.body,
  );
}

/**
 * One hover / focus tooltip per component. `bind(key)` goes on the anchor; `render`
 * draws the content for the active key (so live values stay current while it is open).
 */
export function useTip<K extends string>() {
  const [tip, setTip] = useState<{ key: K; rect: DOMRect; placement: Placement } | null>(null);
  const show = (key: K, placement: Placement) => (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) =>
    setTip({ key, rect: e.currentTarget.getBoundingClientRect(), placement });
  const hide = () => setTip(null);
  return {
    active: tip?.key ?? null,
    hide,
    bind: (key: K, placement: Placement = 'top') => ({
      onMouseEnter: show(key, placement),
      onMouseLeave: hide,
      onFocus: show(key, placement),
      onBlur: hide,
    }),
    render: (content: (key: K) => ReactNode) => {
      if (!tip) return null;
      const node = content(tip.key);
      return node == null ? null : (
        <TipLayer rect={tip.rect} placement={tip.placement}>
          {node}
        </TipLayer>
      );
    },
  };
}
