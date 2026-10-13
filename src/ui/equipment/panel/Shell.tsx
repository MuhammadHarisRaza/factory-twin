/**
 * The shell every contextual panel of the Factory Twin shares (equipment, vehicle, stage): a fixed
 * header, a scrolling body (overscroll contained, so the model behind never scrolls with it) and a
 * persistent action bar. The header carries the one status line: state pill, since, source pill.
 * Wide (src/ui/twin/panelWidth.ts) the header is one line and the width button sits by the close button.
 */
import type { ReactNode, Ref } from 'react';
import { CircleDashed, CircleHelp, Maximize2, Minimize2, Radio, X, type LucideIcon } from 'lucide-react';
import { useWidePanel, useWidePanelFits } from '../../twin/panelWidth';
import { useTwinUi } from '../../twin/uiStore';
import type { FlowLink } from './links';

export function PanelShell({
  label,
  header,
  actions,
  children,
  bodyRef,
  className = '',
}: {
  label: string;
  header: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyRef?: Ref<HTMLDivElement>;
  className?: string;
}) {
  return (
    <aside className={`inspector overlay-panel tw-insp eqp ${className}`} aria-label={label}>
      {header}
      <div className="tw-insp-b eqp-b" ref={bodyRef}>
        {children}
      </div>
      {actions && (
        // A plain labelled group: its buttons are reached with Tab (no toolbar arrow-key model is implied).
        <div className="eqp-bar" role="group" aria-label="Panel actions">
          {actions}
        </div>
      )}
    </aside>
  );
}

export function PanelHeader({
  zone,
  title,
  subtitle,
  status,
  onClose,
  closeLabel,
  closeTitle = 'Close (Esc)',
}: {
  zone: { id: string; color: string } | null;
  title: string;
  subtitle: ReactNode;
  status: ReactNode;
  onClose: () => void;
  closeLabel: string;
  closeTitle?: string;
}) {
  const fits = useWidePanelFits();
  return (
    <header className="eqp-h">
      <div className="eqp-h-main">
        <div className="eqp-h-title">
          {zone && (
            <span className="chip" style={{ background: zone.color }} title={`Zone ${zone.id}`} aria-label={`Zone ${zone.id}`}>
              {zone.id}
            </span>
          )}
          <h2>{title}</h2>
        </div>
        <div className="eqp-h-sub">{subtitle}</div>
        <div className="eqp-h-status">{status}</div>
      </div>
      {fits && <WidthToggle />}
      <button type="button" className="btn ghost sm icon eqp-close" onClick={onClose} title={closeTitle} aria-label={closeLabel}>
        <X size={16} />
      </button>
    </header>
  );
}

/** The panel's width button (wide: 70 % of the screen, two columns · compact: one column at the side); remembered. */
function WidthToggle() {
  const wide = useWidePanel();
  return (
    <button
      type="button"
      className="btn ghost sm icon eqp-width"
      aria-pressed={wide}
      aria-label="Wide panel"
      title={wide ? 'Compact panel — one column at the side' : 'Wide panel — 70 % of the screen, the video across the top'}
      onClick={() => useTwinUi.getState().setPanelWide(!wide)}
    >
      {wide ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
    </button>
  );
}

/** The kit's source icons: Simulated (CircleDashed), a stale feed (CircleHelp — its stale / unknown icon), Connected (Radio). */
const SOURCE_ICON: Record<'simulated' | 'stale' | 'connected', LucideIcon> = { simulated: CircleDashed, stale: CircleHelp, connected: Radio };

/** The one source pill of a panel (Simulated · Stale since hh:mm · Connected). */
export function SourcePill({ kind, label, title }: { kind: 'simulated' | 'stale' | 'connected'; label: string; title: string }) {
  const Icon = SOURCE_ICON[kind];
  return (
    <span className={`prov prov-${kind} eqp-src`} title={title}>
      <Icon size={11} strokeWidth={2.2} aria-hidden />
      {label}
    </span>
  );
}

/** A labelled action of the bar (icon + words); a disabled one keeps its tooltip and focus. */
export function BarButton({
  icon: Icon,
  label,
  title,
  onClick,
  pressed,
  disabled,
}: {
  icon: LucideIcon;
  label: string;
  title: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn sm eqp-act ${pressed ? 'on' : ''}`}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      title={title}
    >
      <Icon size={14} aria-hidden />
      <span>{label}</span>
    </button>
  );
}

/** A body section: a small heading with optional meta on the right (scope, freshness, count). */
export function Section({ id, title, meta, children, refEl }: { id: string; title: ReactNode; meta?: ReactNode; children: ReactNode; refEl?: (el: HTMLElement | null) => void }) {
  return (
    <section className="eqp-sec" aria-labelledby={id} ref={refEl}>
      <div className="eqp-sec-h">
        <h3 id={id}>{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  );
}

/** One compact line of links to the workspaces that explain the subject further. */
export function ContinueIn({ links }: { links: FlowLink[] }) {
  if (!links.length) return null;
  return (
    <nav className="eqp-links" aria-label="Continue in">
      <span>Continue in</span>
      {links.map((l) => (
        <button key={l.key} type="button" className="tw-link" onClick={l.run} title={l.title}>
          {l.label}
        </button>
      ))}
    </nav>
  );
}
