/**
 * The equipment intelligence panel — ONE component for every selectable asset of the 3D factory and
 * every vehicle, rendering an EquipmentIntel (./../intel/types.ts) derived from the shared simulation.
 *
 *   fixed header   zone · name · stage · id · state pill + since + source pill · width · close
 *   scrolling body feed (one) → facets → key figures → what matters → last 4 h → signals → events
 *                  → continue in → technical details (collapsed)
 *   action bar     Focus (follow a vehicle) · Camera (the floating camera view) · Ask Copilot
 *
 * Wide (the default where the window fits it, src/ui/twin/panelWidth.ts: 70 % of the screen) the feed and
 * facets run across the panel's top; under them two columns — key figures, what matters and events on
 * the left, the last 4 h and signals on the right — then continue in and technical details. Compact it
 * is the one column above.
 *
 * Status and provenance are said once: the state and the source in the header, the feed's own source
 * in its badge. Links (Overview quick views, event rows) can ask for a section (useTwinUi.focusSection):
 * overview → the feed, condition → its insight or the signals, next → what matters, events → events.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Hourglass, LocateFixed, LogOut, MessageSquareText, MoveRight, CirclePause, Video, type LucideIcon } from 'lucide-react';
import { useApp } from '../../../app/store';
import { CAMERA_BY_ID } from '../../../model/plant';
import { clockLabel } from '../../../intel/summary';
import { useSimValue } from '../../../sim/store';
import { useTwin } from '../../../store';
import { useCopilot } from '../../copilot/store';
import { openEventRecord, openEventsFor } from '../../events/open';
import { OPERATIONAL_STATE } from '../../kit/Status';
import { useTwinUi, type WorkspaceSection } from '../../twin/uiStore';
import { useWidePanel } from '../../twin/panelWidth';
import { deriveEquipmentIntel, deriveVehicleIntel } from '../intel/derive';
import type { EquipmentIntel, Facet, IntelHeader } from '../intel/types';
import { TechnicalDetails } from '../TechnicalDetails';
import { Analytics } from './Analytics';
import { EventList } from './Events';
import { Facets } from './Facets';
import { FeedView, useStreamState } from './Feed';
import { Insights } from './Insights';
import { flowLinks, vehicleLinks } from './links';
import { MetricTiles, MetricsScope, notModelledKpis, shownKpis } from './Metrics';
import { BarButton, ContinueIn, PanelHeader, PanelShell, Section, SourcePill } from './Shell';
import { NotModelled, Signals, commonFreshness, mergeNotModelled } from './Signals';
import { TONE_ICON, isStaleWording } from './tone';
import '../equipment.css';
import './panel.css';

// ── Pure helpers (exported for tests) ────────────────────────────────────────

const firstWord = (t: string) => t.toLowerCase().split(/[\s·—]+/)[0];

/** The KPI tile a facet would repeat, when the subject's key figures have it (machines: the rate). */
const hasTile = (intel: EquipmentIntel, key: string) => intel.metrics.kpis.some((k) => k.key === key && !k.notModelled && !k.unavailable);

/**
 * Facets without what the header pill already says ("Running" next to "Running"; "Unknown" next to a
 * stale header; a vehicle's "Stationary · 8 min" next to "Stationary · idle since …", its task "Idle"
 * next to "Stationary · idle"), without a figure a key-figure tile is the home of (a machine's rate vs
 * ideal: the rate tile), without an empty value, and without a facet whose value another facet already
 * contains (a vehicle's time at its stop).
 */
export function panelFacets(intel: EquipmentIntel): Facet[] {
  const head = intel.header.state.label.toLowerCase();
  const op = intel.header.state.op;
  // A station's machine facet is the sorting line's state (another subject): it stays.
  const own = intel.subject.type === 'equipment' && intel.subject.profile.kind !== 'station';
  const machine = intel.subject.type === 'equipment' && intel.subject.profile.kind === 'machine';
  const vehicle = intel.subject.type === 'vehicle';
  const out: Facet[] = [];
  for (const f of intel.facets) {
    const v = f.value.toLowerCase().trim();
    if (!v || v === '—' || v === '-') continue;
    if (own && f.key === 'machine' && op != null && (head.startsWith(v) || op === 'unknown' || op === 'disconnected')) continue;
    if (machine && f.key === 'rate' && hasTile(intel, 'rate')) continue;
    if (vehicle && f.key === 'movement' && firstWord(head) === firstWord(v)) continue;
    if (vehicle && f.key === 'trip' && v.length > 3 && head.includes(v)) continue;
    // "At stop 12 min" next to "Stationary · … since 12:28": the header already says since when it stands.
    if (vehicle && f.key === 'dwell' && f.label === 'At stop' && intel.header.since != null && firstWord(head) === 'stationary') continue;
    if (v.length > 3 && out.some((g) => g.value.toLowerCase() !== v && g.value.toLowerCase().includes(v))) continue;
    out.push(f);
  }
  return out;
}

/**
 * The status the rate tile shows: the rate facet's words when the panel dropped that facet for the
 * tile (one home for rate vs ideal — "92 % of ideal · paced by supply", "Constraining output").
 */
export function panelMetrics(intel: EquipmentIntel, facets: Facet[]): EquipmentIntel['metrics'] {
  const rate = intel.facets.find((f) => f.key === 'rate');
  if (!rate || facets.includes(rate) || intel.subject.type !== 'equipment' || intel.subject.profile.kind !== 'machine') return intel.metrics;
  // A stale feed's "Last value · hh:mm" stays: it says when the value was received.
  return {
    ...intel.metrics,
    kpis: intel.metrics.kpis.map((k) => (k.key === 'rate' && !k.unavailable && !(k.status && isStaleWording(k.status.label)) ? { ...k, status: { tone: rate.tone, label: cap1(rate.value) } } : k)),
  };
}

const cap1 = (t: string) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);

/**
 * Analytics facts without a figure a shown facet already states (a vehicle's time at its stop) or a
 * key-figure tile already shows (a vehicle's idle time of the last hour is the utilisation tile's).
 */
export function panelFacts(intel: EquipmentIntel, facets: Facet[], tiles: { key: string }[] = []): NonNullable<NonNullable<EquipmentIntel['analytics']>['facts']> {
  const said = facets.map((f) => f.value.toLowerCase());
  const util = tiles.some((t) => t.key === 'utilisation');
  return (intel.analytics?.facts ?? []).filter((x) => !(/\d/.test(x.value) && x.value.length > 3 && said.some((t) => t.includes(x.value.toLowerCase()))) && !(util && /^Idle\b/.test(x.label)));
}

/**
 * Tiles that repeat a facet — vehicles: location, movement, task / visit phase, time on site; buffers:
 * the level (its facet reads it on its side of the kiln).
 */
const FACET_TILES: Partial<Record<Facet['key'], string[]>> = { location: ['location'], movement: ['movement'], trip: ['task', 'phase'], dwell: ['on-site'] };

export function panelTileOmissions(intel: EquipmentIntel): Set<string> {
  if (intel.subject.type === 'equipment' && intel.subject.profile.kind === 'buffer' && intel.facets.some((f) => f.key === 'material' && f.label === 'Level')) return new Set(['level']);
  if (intel.subject.type !== 'vehicle') return new Set();
  return new Set(intel.facets.flatMap((f) => FACET_TILES[f.key] ?? []));
}

/**
 * Signal rows the panel shows: not the run state while it equals the header's state (it is shown
 * again only as a last value of a stale feed), not the alarm / stop code while the header carries the
 * stop reason, not the output rate while the rate tile and the rate trend are its home. `headerEqual`
 * are the rows hidden because the header says the same (chips pointing at them are dropped too).
 */
export function panelSignals(intel: EquipmentIntel, tiles: { key: string }[]): { rows: EquipmentIntel['signals']['rows']; headerEqual: Set<string> } {
  const op = intel.header.state.op;
  const stopped = op === 'stopped' || op === 'fault' || op === 'planned';
  const headerEqual = new Set<string>();
  const rows = intel.signals.rows.filter((r) => {
    const name = r.id.slice(r.id.indexOf('.') + 1);
    if ((name === 'state' || name === 'run_state') && !r.stale && op != null) {
      headerEqual.add(r.id);
      return false;
    }
    if (name === 'alarm' && !r.stale && stopped && r.value != null && r.value !== 'No active alarm') {
      headerEqual.add(r.id);
      return false;
    }
    if (name === 'rate' && tiles.some((t) => t.key === 'rate') && intel.analytics?.rate) return false;
    return true;
  });
  return { rows, headerEqual };
}

/** Words of the header's state for a subject without an operational state (vehicles, buffers). */
function stateIcon(state: IntelHeader['state'], vehicle: boolean): LucideIcon {
  if (state.op) return OPERATIONAL_STATE[state.op].icon;
  if (vehicle) {
    if (/^Moving/.test(state.label)) return MoveRight;
    if (/^Waiting/.test(state.label)) return Hourglass;
    if (/^Stationary/.test(state.label)) return CirclePause;
    if (/^Left/.test(state.label)) return LogOut;
  }
  return TONE_ICON[state.tone];
}

/** The section a focus request brings into view. */
export function sectionFor(section: WorkspaceSection, intel: EquipmentIntel): 'feed' | 'insights' | 'signals' | 'events' {
  if (section === 'events') return 'events';
  if (section === 'next') return intel.insights.length ? 'insights' : 'events';
  if (section === 'condition') return intel.insights.some((i) => i.id.startsWith('condition:')) || !intel.signals.rows.length ? 'insights' : 'signals';
  return 'feed';
}

export type PanelAction = { key: 'focus' | 'camera' | 'ask'; icon: LucideIcon; label: string; title: string; pressed?: boolean; disabled?: boolean; run: () => void };

/**
 * The action bar — nothing else: Focus (frame the asset; a vehicle: follow it), Camera (the existing
 * floating camera view of the subject's camera; disabled with the reason when none covers it) and
 * Ask Copilot (the subject's question, in its context — the top open event when an insight rests on one).
 */
export function panelActions(intel: EquipmentIntel, ui: { follow: boolean; camera: string | null }): PanelAction[] {
  const id = intel.subject.id;
  const vehicle = intel.subject.type === 'vehicle';
  const cam = intel.cameraId ? CAMERA_BY_ID[intel.cameraId] : undefined;
  const camOn = !!cam && ui.camera === cam.id;
  const ask = intel.ask ?? { prompt: vehicle ? `What is ${id} doing?` : `How is ${id} performing?` };
  return [
    vehicle
      ? {
          key: 'focus',
          icon: LocateFixed,
          // A toggle keeps its name; aria-pressed (and the pressed style) carries the state.
          label: 'Follow',
          pressed: ui.follow,
          title: ui.follow ? 'Stop keeping the 3D camera on this vehicle' : 'Keep the 3D camera on this vehicle',
          run: () => useTwin.getState().setFollow(!ui.follow),
        }
      : { key: 'focus', icon: Crosshair, label: 'Focus', title: 'Frame this asset in the 3D model', run: () => useTwin.getState().focusEquipment(id) },
    {
      key: 'camera',
      icon: Video,
      label: 'Camera',
      pressed: cam ? camOn : undefined,
      disabled: !cam,
      title: cam
        ? `${camOn ? 'Close' : 'Open'} the floating camera view · ${cam.name} (${cam.id})`
        : vehicle
          ? 'No camera covers the area this vehicle is in'
          : 'No camera position covers this asset',
      run: () => {
        if (cam) useTwinUi.getState().setCamera(camOn ? null : cam.id);
      },
    },
    {
      key: 'ask',
      icon: MessageSquareText,
      label: 'Ask Copilot',
      title: `Ask the Copilot: “${ask.prompt}” — rule-based answers on the current demo state, no language model`,
      run: () => {
        // The question is about this subject: its context chip is shown again if the user had removed it.
        if (!vehicle) useCopilot.setState((s) => ({ dismissed: s.dismissed.filter((k) => k !== `equipment:${id}`) }));
        useApp.getState().openCopilot(ask.prompt, ask.eventId ? { eventId: ask.eventId } : undefined);
      },
    },
  ];
}

/** Smooth scrolling unless the user asked for reduced motion. */
const scrollBehavior = (): ScrollBehavior =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/** The freshness of a simulated signal read now (the header's source pill already says “Simulated”). */
const FRESH = 'Simulated · now';

// Focus requests are honoured once (their nonce), across panel instances.
let handledNonce: number | null = null;

// ── The panel ────────────────────────────────────────────────────────────────

export function EquipmentPanel({ intel, now }: { intel: EquipmentIntel; now: number }) {
  const subject = intel.subject;
  const id = subject.id;
  const vehicle = subject.type === 'vehicle';
  const h = intel.header;
  const follow = useTwin((s) => s.follow);
  const camOpen = useTwinUi((s) => s.camera);
  const focusFor = useTwinUi((s) => s.focusFor);
  const stream = useStreamState(intel.feed.kind === 'live-stream' ? intel.feed.cameraId : null);
  const wide = useWidePanel();

  // Per-subject view state: the expanded event and the signal row an evidence chip pointed to.
  const [openEv, setOpenEv] = useState<{ id: string; ev: string } | null>(null);
  const [mark, setMark] = useState<{ id: string; sig: string } | null>(null);
  const expanded = openEv?.id === id ? openEv.ev : null;
  const highlight = mark?.id === id ? mark.sig : null;
  useEffect(() => {
    if (!mark) return;
    const t = setTimeout(() => setMark(null), 2400);
    return () => clearTimeout(t);
  }, [mark]);

  const body = useRef<HTMLDivElement>(null);
  const sections = useRef<Partial<Record<'feed' | 'insights' | 'signals' | 'events', HTMLElement | null>>>({});
  const shownId = useRef<string | null>(null);
  const wanted = focusFor?.id === id ? focusFor : null;
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    if (wanted && wanted.nonce !== handledNonce) {
      handledNonce = wanted.nonce;
      const target = sections.current[sectionFor(wanted.section, intel)];
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'start' });
        shownId.current = id;
        return;
      }
    }
    // Another subject starts at the top — at once, never scrolled smoothly from the old position.
    if (shownId.current !== id) {
      if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      else el.scrollTop = 0;
      shownId.current = id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs per subject / request, not per tick
  }, [id, wanted]);

  /** Brings a row into view and moves focus to it (so keyboard and screen-reader users land there too). */
  const jumpTo = (sel: string, focusSel?: string) => {
    const el = body.current?.querySelector<HTMLElement>(sel);
    if (!el) return;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
    const f = focusSel ? el.querySelector<HTMLElement>(focusSel) : el;
    f?.focus({ preventScroll: true });
  };
  const onSignal = (sig: string) => {
    setMark({ id, sig });
    requestAnimationFrame(() => jumpTo(`[data-signal="${CSS.escape(sig)}"]`));
  };
  const onEvent = (ev: string) => {
    if (intel.events.rows.some((r) => r.event.id === ev)) {
      setOpenEv({ id, ev });
      requestAnimationFrame(() => jumpTo(`[data-event="${CSS.escape(ev)}"]`, '.eqp-ev-h'));
    } else openEventRecord(ev);
  };

  const facets = useMemo(() => panelFacets(intel), [intel]);
  // Tile statuses a shown facet already states are not repeated on the tile.
  const quiet = useMemo(() => new Set(facets.map((f) => f.value.toLowerCase())), [facets]);
  const omit = useMemo(() => panelTileOmissions(intel), [intel]);
  const metrics = useMemo(() => panelMetrics(intel, facets), [intel, facets]);
  const tiles = useMemo(() => shownKpis(metrics, omit), [metrics, omit]);
  const sig = useMemo(() => panelSignals(intel, tiles), [intel, tiles]);
  const hasSignal = useCallback((s: string) => sig.rows.some((r) => r.id === s), [sig.rows]);
  const notModelled = mergeNotModelled(intel.signals.notModelled, notModelledKpis(intel.metrics));
  // The signals' freshness is said once in the heading — only when it is not the header's "Simulated · now".
  const freshness = commonFreshness(sig.rows);
  const links = subject.type === 'vehicle' ? vehicleLinks(id) : flowLinks(subject.profile);
  // Events an insight already presents (title and impact): their row in Events is collapsed to title, time and status.
  const shownAbove = useMemo(() => new Set(intel.insights.filter((i) => i.id.startsWith('event:')).map((i) => i.id.slice(6))), [intel.insights]);

  // Header: the one state line. The source pill upgrades to connected only while a configured stream plays.
  const StateIcon = stateIcon(h.state, vehicle);
  const live = intel.feed.kind === 'live-stream' && stream === 'live';
  const source = live
    ? { kind: 'connected' as const, label: 'Simulated · camera connected', title: `Operating data comes from the simulation; the stream configured for ${intel.feed.kind === 'live-stream' ? intel.feed.cameraId : ''} is playing.` }
    : h.source.kind === 'stale'
      ? { kind: 'stale' as const, label: h.source.label, title: 'The asset’s (simulated) data feed stopped updating — values are the last ones received and the current state is unknown.' }
      : { kind: h.source.kind, label: h.source.label, title: 'Generated by the demo simulation engine — not plant telemetry.' };
  const subtitleParts = h.subtitle.split(' · ');
  const tail = subtitleParts.length > 1 ? subtitleParts.pop()! : null;
  const header = (
    <PanelHeader
      zone={h.zone}
      title={h.title}
      subtitle={
        <>
          {subtitleParts.join(' · ')}
          {tail && (
            <>
              {' · '}
              <span className={vehicle ? '' : 'mono'}>{tail}</span>
            </>
          )}
        </>
      }
      status={
        <>
          <span className={`status ${h.state.tone} eqp-state`}>
            <StateIcon size={13} strokeWidth={2.2} aria-hidden />
            {h.state.label}
          </span>
          {h.since != null && h.source.kind !== 'stale' && <span className="eqp-since num">since {clockLabel(h.since, now)}</span>}
          <SourcePill kind={source.kind} label={source.label} title={source.title} />
        </>
      }
      onClose={() => (vehicle ? useTwin.getState().selectVehicle(null) : useTwin.getState().select(null))}
      closeLabel={vehicle ? 'Close vehicle details' : 'Close equipment details'}
    />
  );

  const actions = panelActions(intel, { follow, camera: camOpen }).map((x) => (
    <BarButton key={x.key} icon={x.icon} label={x.label} title={x.title} pressed={x.pressed} disabled={x.disabled} onClick={x.run} />
  ));

  const reg = (k: 'feed' | 'insights' | 'signals' | 'events') => (el: HTMLElement | null) => void (sections.current[k] = el);
  const a = intel.analytics;
  const showSignals = sig.rows.length > 0 || notModelled.length > 0;
  const showEvents = intel.events.rows.length > 0 || intel.events.total > 0;
  // Chips that would only restate the header (the run state, the stop code) are left out.
  const insights = useMemo(
    () => (sig.headerEqual.size ? intel.insights.map((i) => ({ ...i, evidence: i.evidence.filter((e) => !(e.kind === 'signal' && e.ref && sig.headerEqual.has(e.ref))) })) : intel.insights),
    [intel.insights, sig.headerEqual],
  );

  const top = (
    <div className="eqp-top" ref={reg('feed')}>
      <FeedView feed={intel.feed} subject={id} />
      <Facets facets={facets} />
    </div>
  );

  const figures =
    (tiles.length > 0 || intel.metrics.note) &&
    (tiles.length > 0 ? (
      <Section id={`eqp-kpi-${id}`} title="Key figures" meta={<MetricsScope set={metrics} own={vehicle ? undefined : id} />}>
        <MetricTiles set={metrics} label={`${h.title} key figures`} quiet={quiet} omit={omit} />
      </Section>
    ) : (
      <div className="eqp-sec">
        <MetricTiles set={metrics} label={`${h.title} key figures`} />
      </div>
    ));

  const matters = insights.length > 0 && (
    <Section id={`eqp-ins-${id}`} title="What matters" refEl={reg('insights')}>
      <Insights key={id} insights={insights} onSignal={onSignal} onEvent={onEvent} hasSignal={hasSignal} />
    </Section>
  );

  const analytics = a && (
    <Section id={`eqp-an-${id}`} title={a.window.label}>
      <Analytics a={{ ...a, facts: panelFacts(intel, facets, tiles) }} vehicle={vehicle} />
    </Section>
  );

  const signals = showSignals && (
    <Section
      id={`eqp-sig-${id}`}
      title="Signals"
      meta={freshness && freshness !== FRESH ? <span className="eqp-sec-meta">{freshness}</span> : undefined}
      refEl={reg('signals')}
    >
      <Signals signals={{ ...intel.signals, rows: sig.rows }} highlight={highlight} />
      <NotModelled items={notModelled} />
    </Section>
  );

  const events = showEvents && (
    <Section
      id={`eqp-ev-${id}`}
      title="Events"
      meta={intel.events.openCount > 0 ? <span className="eqp-sec-meta">{intel.events.openCount} open</span> : undefined}
      refEl={reg('events')}
    >
      <EventList
        events={intel.events}
        now={now}
        open={expanded}
        onToggle={(ev) => setOpenEv(expanded === ev ? null : { id, ev })}
        onViewAll={() => openEventsFor(vehicle ? { vehicleId: id } : { equipmentId: id })}
        subject={id}
        shownAbove={shownAbove}
      />
    </Section>
  );

  return (
    <PanelShell
      label={`${h.title} · ${vehicle ? 'vehicle' : 'equipment'} details`}
      header={header}
      actions={actions}
      bodyRef={body}
      className={`${vehicle ? 'eqp-vehicle' : ''} ${wide ? 'eqp-wide' : ''}`}
    >
      {top}
      {wide ? (
        <div className="eqp-cols">
          <div className="eqp-col eqp-col-a">
            {figures}
            {matters}
            {events}
          </div>
          <div className="eqp-col eqp-col-b">
            {analytics}
            {signals}
          </div>
        </div>
      ) : (
        <>
          {figures}
          {matters}
          {analytics}
          {signals}
          {events}
        </>
      )}

      <ContinueIn links={links} />
      <TechnicalDetails intel={intel} />
    </PanelShell>
  );
}

// ── Hosts (the Factory Twin's inspector) ─────────────────────────────────────

/** The panel of a selected equipment item, derived from the shared simulation each tick. */
export function SelectedEquipmentPanel({ id }: { id: string }) {
  const finance = useApp((s) => s.finance);
  const cameraSources = useApp((s) => s.cameraSources);
  const d = useSimValue((s) => ({ intel: deriveEquipmentIntel(s, id, { finance, cameraSources }), now: s.minute }), [id, finance, cameraSources]);
  return <EquipmentPanel intel={d.intel} now={d.now} />;
}

/** The panel of a selected vehicle (truck or internal vehicle) — the same component. */
export function SelectedVehiclePanel({ id }: { id: string }) {
  const finance = useApp((s) => s.finance);
  const cameraSources = useApp((s) => s.cameraSources);
  const d = useSimValue((s) => ({ intel: deriveVehicleIntel(s, id, { finance, cameraSources }), now: s.minute }), [id, finance, cameraSources]);
  return <EquipmentPanel intel={d.intel} now={d.now} />;
}
