/**
 * One live 3D factory, shown in two places. The scene (WebGL context, models, camera, selection)
 * is created once and stays mounted; the Factory Twin shows it full size, and a page can host it
 * embedded by rendering <TwinSlot/>: the scene's container is then positioned over the slot's box
 * (inside the scrolling content area, so it scrolls with the page). Nothing is re-created when
 * moving between the Overview and the Factory Twin, and selection and camera carry over.
 */
import { Component, useEffect, useRef, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { create } from 'zustand';
import { useTwin } from '../store';

type TwinHostState = {
  /** Element the embedded twin covers (null = no page hosts it). */
  slot: HTMLElement | null;
  setSlot: (el: HTMLElement | null) => void;
  /** The 3D scene failed to start (no WebGL, chunk error): loaders stop and the error message shows. */
  sceneError: string | null;
};

export const useTwinHost = create<TwinHostState>((set) => ({
  slot: null,
  setSlot: (slot) => set({ slot }),
  sceneError: null,
}));

/**
 * Records a scene start-up failure for the loaders, then passes the error on to the boundary
 * outside it (which explains it to the user).
 */
export class SceneFailureFlag extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    queueMicrotask(() => useTwinHost.setState({ sceneError: error.message || 'Unknown error' }));
    return { error };
  }

  render() {
    if (this.state.error) throw this.state.error;
    return this.props.children;
  }
}

/**
 * Placeholder for the embedded 3D factory. Children (controls, legends) are drawn above the scene,
 * inside the slot; keep them few and at the edges so the model stays visible.
 */
export function TwinSlot({ className = '', children, label = '3D factory model' }: { className?: string; children?: ReactNode; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const ready = useTwin((t) => t.ready);
  const failed = useTwinHost((h) => h.sceneError != null);
  useEffect(() => {
    const el = ref.current;
    useTwinHost.getState().setSlot(el);
    return () => {
      if (useTwinHost.getState().slot === el) useTwinHost.getState().setSlot(null);
    };
  }, []);
  return (
    <div ref={ref} className={`twin-slot ${className}`} role="region" aria-label={label} aria-busy={!ready && !failed}>
      {!ready && !failed && (
        <div className="twin-slot-loading" role="status">
          <LoaderCircle className="spin" size={22} aria-hidden />
          Building the factory model…
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Keeps `host` (absolutely positioned in `container`, the scrolling content area) over `slot`.
 * Measured every animation frame while embedded: layout above the slot can change at any time
 * (cards loading, panels opening) and a ResizeObserver on the slot alone misses moves.
 */
export function useFollowSlot(host: HTMLElement | null, slot: HTMLElement | null) {
  useEffect(() => {
    if (!host || !slot) return;
    const container = host.offsetParent as HTMLElement | null;
    if (!container) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const r = slot.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      const top = Math.round(r.top - c.top + container.scrollTop);
      const left = Math.round(r.left - c.left + container.scrollLeft);
      const key = `${top},${left},${Math.round(r.width)},${Math.round(r.height)}`;
      if (key !== last) {
        last = key;
        host.style.top = `${top}px`;
        host.style.left = `${left}px`;
        host.style.width = `${Math.round(r.width)}px`;
        host.style.height = `${Math.round(r.height)}px`;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      host.style.top = host.style.left = host.style.width = host.style.height = '';
    };
  }, [host, slot]);
}
