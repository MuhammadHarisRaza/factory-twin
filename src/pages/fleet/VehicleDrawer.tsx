/**
 * Vehicle detail as an overlay drawer, used on the Fleet & Movement tabs that are tables, lists or
 * charts (everything except "Site & movement"). A grid column beside a table squeezes it into
 * horizontal scrolling at laptop widths; the drawer lays over the page instead, so the table keeps
 * the full width. Same pattern as the Scenarios and Copilot drawers (.drawer-scrim + .drawer,
 * role="dialog" aria-modal): focus moves into the drawer and returns when it closes, Esc or a click
 * on the scrim closes it, and the route stays #/fleet/<vehicle id>.
 */
import { useEffect, useRef } from 'react';
import { VehicleDetail } from './VehicleDetail';

const MODAL = '[aria-modal="true"]';

export function VehicleDrawer({ id, onClose, onSelect }: { id: string; onClose: () => void; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  // Esc closes; the SidePanel's own Esc handling stands down while a modal is open, so the drawer owns
  // it. A modal opened above this one (Scenarios, Copilot) closes itself first. Focus returns to where
  // the user was (the table row) when the drawer closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelectorAll(MODAL).length > 1) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.({ preventScroll: true });
    };
  }, []);

  // Each vehicle shown (also one picked inside the drawer, e.g. the truck a forklift is loading) starts with focus on the panel.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.sp-h button')?.focus({ preventScroll: true });
  }, [id]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div ref={ref} className="drawer fl-drawer" role="dialog" aria-modal="true" aria-label={`Vehicle ${id}`}>
        <VehicleDetail key={id} id={id} onClose={onClose} onSelect={onSelect} variant="drawer" />
      </div>
    </>
  );
}
