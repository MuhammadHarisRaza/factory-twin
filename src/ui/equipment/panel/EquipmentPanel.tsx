/**
 * The equipment intelligence panel — ONE component for every selectable asset of the 3D factory and
 * every vehicle, rendering an EquipmentIntel (./../intel/types.ts) derived from the shared simulation.
 *
 *   fixed header   glowing zone badge · name · id · stage (with the brief's 12-stage mapping) · state pill + since +
 *                  data badge (Simulated / Stale / Unavailable / Reference) + "Updated hh:mm" · width · close
 *   scrolling body feed (one, the full card width) → facets → key figures (hero tiles with sparklines) → the process
 *                  now (kiln zone profile + deviation gauges, PV / SP gauges, a buffer's level gauge; with the time
 *                  range) → what matters (curated insights + rule findings) → charts over the viewer's time range →
 *                  signals (catalogue table) → events & alarms → continue in → technical details (collapsed) → legend
 *   action bar     Focus (follow a vehicle) · Camera (the floating camera view) · Ask Copilot (accented)
 *
 * Wide (the default where the window fits it, src/ui/twin/panelWidth.ts: 70 % of the screen) — the approved card
 * design: the feed and facets across the top, the key figures in one row, the process block, then two columns —
 * the charts on the left, what matters and events on the right — then the signal table, continue in, technical
 * details and the legend across the card. Compact it is the one column above.
 *
 * Status and provenance are said once: the state and the source in the header, the feed's own source
 * in its badge (a camera view: twin view, configured stream) or in its ⓘ (a recording or reference clip:
 * "Recorded footage — not a live feed" / "Reference footage — not this plant, not a live feed"; on a phone also the "Show camera" line's badge). Links (Overview quick views, event rows) can ask for a section (useTwinUi.focusSection):
 * overview → the feed, condition → its insight or the signals, next → what matters, events → events.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { Crosshair, Hourglass, LocateFixed, LogOut, MessageSquareText, MoveRight, CirclePause, Video, type LucideIcon } from 'lucide-react';
import type { Window } from '../../../calc/types';
import { useApp } from '../../../app/store';
import { CAMERA_BY_ID } from '../../../model/plant';
import { RANGE_BY_KEY, type RangeKey } from '../../../model/telemetry';
import { CHART } from '../../../intel/rules/types';
import { clockLabel } from '../../../intel/summary';
import { useSimValue } from '../../../sim/store';
import { useTwin } from '../../../store';
import { useCopilot } from '../../copilot/store';
import { openEventRecord, openEventsFor } from '../../events/open';
import { OPERATIONAL_STATE } from '../../kit/Status';
import { useTwinUi, type WorkspaceSection } from '../../twin/uiStore';
import { useWidePanel } from '../../twin/panelWidth';
import { PANEL_CHART, chartIds, type ChartSpec } from '../intel/charts';
import { deriveEquipmentIntel, deriveVehicleIntel } from '../intel/derive';
import { rangeCovering } from '../intel/ranges';
import type { EquipmentIntel, Facet, IntelHeader } from '../intel/types';
import { TechnicalDetails } from '../TechnicalDetails';
import { useEvent } from '../../kit/useEvent';

import { Analytics } from './Analytics';
import { Charts, type ChartHighlight } from './Charts';
import { EventList, LogList, eventFilterOptions, filterLog, type EventFilter } from './Events';
import { Facets } from './Facets';
import { FeedView } from './Feed';
import { Insights } from './Insights';
import { flowLinks, vehicleLinks } from './links';
import { MetricTiles, MetricsScope, notModelledKpis, shownKpis } from './Metrics';
import { RuleFindings, groupFindings } from './RuleFindings';
import { ProcessBlock } from './Process';
import { TimeRange } from '../../kit/TimeRange';
import { BarButton, ContinueIn, PanelHeader, PanelShell, Section, SourcePill } from './Shell';
import { SignalTable } from './SignalTable';
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
  const stopped = op === 'stopped' || op === 'fault' || op === 'planned' || op === 'changeover';
  const headerEqual = new Set<string>();
  const rows = intel.signals.rows.filter((r) => {
    const name = r.id.slice(r.id.indexOf('.') + 1);
    if ((name === 'state' || name === 'run_state') && !r.stale && op != null) {
      headerEqual.add(r.id);
      return false;
    }
    if (name === 'alarm' && !r.stale && stopped && r.value != null && r.value !== 'No active alarm code') {
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

/** The chart a signal's detail links to, when the chart set has one (its process chart, the level, cycle, rate or speed chart). */
export function chartOfSignal(specs: ChartSpec[], signalId: string): string | null {
  const name = signalId.slice(signalId.indexOf('.') + 1);
  const wanted = [
    CHART.process(signalId),
    CHART.buffer(signalId),
    ...(name === 'cycle_time' || name === 'cycle_time_target' ? [CHART.cycle] : []),
    ...(name === 'rate' || name === 'slip_flow' || name === 'powder_flow' ? [CHART.rate] : []),
    ...(name === 'speed' ? [PANEL_CHART.speed] : []),
    ...(name === 'state' || name === 'run_state' ? [CHART.states] : []),
  ];
  for (const w of wanted) if (specs.some((x) => chartIds(x).includes(w))) return w;
  return null;
}

/** The order of the panel's sections: wide (feed + facets across the top, two columns) or compact (one column). */
export const PANEL_ORDER = {
  compact: ['feed', 'facets', 'figures', 'process', 'matters', 'charts', 'signals', 'events', 'continue', 'technical', 'legend'],
  wide: { top: ['feed', 'facets', 'figures', 'process'], a: ['charts'], b: ['matters', 'events'], bottom: ['signals', 'continue', 'technical', 'legend'] },
} as const;

export function EquipmentPanel({ intel, now, onRange }: { intel: EquipmentIntel; now: number; onRange?: (k: RangeKey) => void }) {
  const subject = intel.subject;
  const id = subject.id;
  const vehicle = subject.type === 'vehicle';
  const h = intel.header;
  const follow = useTwin((s) => s.follow);
  const camOpen = useTwinUi((s) => s.camera);
  const focusFor = useTwinUi((s) => s.focusFor);
  const wide = useWidePanel();
  // Handlers keep one identity across simulated minutes (and see the latest props), so unchanged sections skip their render.
  const setRange = useEvent((k: RangeKey) => (onRange ?? useTwinUi.getState().setPanelRange)(k));

  // Per-subject view state: the expanded event, the signal row and the chart window an evidence link pointed to, the log filter.
  const [openEv, setOpenEv] = useState<{ id: string; ev: string } | null>(null);
  const [mark, setMark] = useState<{ id: string; sig: string } | null>(null);
  const [chartMark, setChartMark] = useState<{ id: string; hl: ChartHighlight } | null>(null);
  const [evFilter, setEvFilter] = useState<{ id: string; f: EventFilter } | null>(null);
  const expanded = openEv?.id === id ? openEv.ev : null;
  const highlight = mark?.id === id ? mark.sig : null;
  const chartHl = chartMark?.id === id ? chartMark.hl : null;
  const filter: EventFilter = evFilter?.id === id ? evFilter.f : 'all';
  useEffect(() => {
    if (!mark) return;
    const t = setTimeout(() => setMark(null), 2400);
    return () => clearTimeout(t);
  }, [mark]);
  useEffect(() => {
    if (!chartMark) return;
    const t = setTimeout(() => setChartMark(null), 6000);
    return () => clearTimeout(t);
  }, [chartMark]);

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
    if (!el) return false;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
    const f = focusSel ? el.querySelector<HTMLElement>(focusSel) : el;
    f?.focus({ preventScroll: true });
    return true;
  };
  const onSignal = useEvent((sig: string) => {
    setMark({ id, sig });
    requestAnimationFrame(() => jumpTo(`[data-signal="${CSS.escape(sig)}"]`));
  });
  const onEvent = useEvent((ev: string) => {
    if (intel.events.rows.some((r) => r.event.id === ev)) {
      setOpenEv({ id, ev });
      setEvFilter({ id, f: 'all' });
      requestAnimationFrame(() => jumpTo(`[data-event="${CSS.escape(ev)}"]`, '.eqp-ev-h'));
    } else openEventRecord(ev);
  });
  const charts = intel.charts ?? null;
  /** A chart link: the range is widened to cover the window, the window is marked, the chart scrolled to; without that chart, the signal row. */
  const onChart = useEvent((chartId: string, window: Window | null) => {
    if (charts && window) {
      const need = rangeCovering(now, window, charts.disabled);
      if (RANGE_BY_KEY[need].minutes > RANGE_BY_KEY[charts.range].minutes) setRange(need);
      setChartMark({ id, hl: { chartId, from: window.from, to: window.to } });
    } else setChartMark({ id, hl: { chartId, from: now, to: now } });
    requestAnimationFrame(() => {
      if (jumpTo(`[data-charts~="${CSS.escape(chartId)}"]`)) return;
      const sig = /^chart:(?:process|buffer):(.+)$/.exec(chartId)?.[1];
      if (sig) onSignal(sig);
    });
  });
  const onSignalChart = useEvent((c: string) => onChart(c, null));
  const chartOf = useEvent((s: string) => (charts ? chartOfSignal(charts.specs, s) : null));
  const history = useEvent((signalId: string) => intel.history?.(signalId) ?? null);
  const onToggleEvent = useEvent((ev: string) => setOpenEv(expanded === ev ? null : { id, ev }));
  const onViewAll = useEvent(() => openEventsFor(vehicle ? { vehicleId: id } : { equipmentId: id }));

  const facets = useMemo(() => panelFacets(intel), [intel]);
  // Tile statuses a shown facet already states are not repeated on the tile.
  const quiet = useMemo(() => new Set(facets.map((f) => f.value.toLowerCase())), [facets]);
  const omit = useMemo(() => panelTileOmissions(intel), [intel]);
  const metrics = useMemo(() => panelMetrics(intel, facets), [intel, facets]);
  const tiles = useMemo(() => shownKpis(metrics, omit), [metrics, omit]);
  const sig = useMemo(() => panelSignals(intel, tiles), [intel, tiles]);
  const table = intel.signalTable && intel.signalTable.length > 0 ? intel.signalTable : null;
  // Changes identity only when the set of signals does (the insight cards render their links from it).
  const signalIds = (table ? table.map((r) => r.def.signalId) : sig.rows.map((r) => r.id)).join('\n');
  const hasSignal = useMemo(() => {
    const ids = new Set(signalIds ? signalIds.split('\n') : []);

    return (s: string) => ids.has(s);
  }, [signalIds]);

  const notModelled = mergeNotModelled(intel.signals.notModelled, notModelledKpis(intel.metrics));
  // The signals' freshness is said once in the heading — only when it is not the header's "Simulated · now".
  const freshness = commonFreshness(sig.rows);
  const links = subject.type === 'vehicle' ? vehicleLinks(id) : flowLinks(subject.profile);
  // Events an insight already presents (title and impact): their row in Events is collapsed to title, time and status.
  const shownAbove = useMemo(() => new Set(intel.insights.filter((i) => i.id.startsWith('event:')).map((i) => i.id.slice(6))), [intel.insights]);

  // Header: the one state line. The data badge is the data's source — a playing camera stream is the feed badge's, not this.
  const StateIcon = stateIcon(h.state, vehicle);
  const source = { kind: h.source.kind, label: h.source.label, title: SOURCE_TITLE[h.source.kind] };
  const subtitleParts = h.subtitle.split(' · ');
  const last = subtitleParts.length > 1 ? subtitleParts.pop()! : null;
  // An asset's id sits beside its name (the approved card); a vehicle keeps its last subtitle part in the line.
  const idTag = !vehicle && last === id ? last : null;
  const tail = idTag ? null : last;
  const header = (
    <PanelHeader
      zone={h.zone}
      title={h.title}
      tag={idTag ?? undefined}
      subtitle={
        <>
          {subtitleParts.join(' · ')}
          {h.stage12 && (
            <span className="eqp-stage12" title={h.stage12.note}>
              {' · '}
              {h.stage12.label}
            </span>
          )}
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
          {h.lastUpdate != null && h.source.kind !== 'stale' && (
            <span className="eqp-upd num" title="Newest sample of the asset’s simulated signals">
              Updated {clockLabel(h.lastUpdate, now)}
            </span>
          )}
        </>
      }
      onClose={() => (vehicle ? useTwin.getState().selectVehicle(null) : useTwin.getState().select(null))}
      closeLabel={vehicle ? 'Close vehicle details' : 'Close equipment details'}
    />
  );

  const actions = panelActions(intel, { follow, camera: camOpen }).map((x) => (
    <BarButton key={x.key} icon={x.icon} label={x.label} title={x.title} pressed={x.pressed} disabled={x.disabled} onClick={x.run} accent={x.key === 'ask'} />
  ));

  const reg = (k: 'feed' | 'insights' | 'signals' | 'events') => (el: HTMLElement | null) => void (sections.current[k] = el);
  const a = intel.analytics;
  const showSignals = !!table || sig.rows.length > 0 || notModelled.length > 0;
  const log = intel.log ?? [];
  const showEvents = intel.events.rows.length > 0 || intel.events.total > 0 || log.length > 0;
  // Chips that would only restate the header (the run state, the stop code) are left out.
  const insights = useMemo(
    () => (sig.headerEqual.size ? intel.insights.map((i) => ({ ...i, evidence: i.evidence.filter((e) => !(e.kind === 'signal' && e.ref && sig.headerEqual.has(e.ref))) })) : intel.insights),
    [intel.insights, sig.headerEqual],
  );
  const findings = intel.findings?.shown ?? [];

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
        <MetricTiles set={metrics} label={`${h.title} key figures`} quiet={quiet} omit={omit} trends={intel.tileTrends} />
      </Section>
    ) : (
      <div className="eqp-sec">
        <MetricTiles set={metrics} label={`${h.title} key figures`} />
      </div>
    ));

  const fired = useMemo(() => groupFindings(findings).fired.length, [findings]);
  const nFindings = insights.filter((i) => i.severity !== 'positive').length + fired;
  const nRules = useMemo(() => new Set(findings.map((f) => f.ruleId)).size, [findings]);
  const matters = (insights.length > 0 || findings.length > 0) && (
    <Section
      id={`eqp-ins-${id}`}
      title="What matters"
      meta={
        findings.length > 0 ? (
          <span className="eqp-sec-meta num">
            {nRules} rule{nRules === 1 ? '' : 's'} checked · {nFindings} finding{nFindings === 1 ? '' : 's'}
            {intel.findings?.at != null && intel.findings.at < now && <> · checked {clockLabel(intel.findings.at, now)}</>}
          </span>
        ) : undefined
      }
      refEl={reg('insights')}
    >
      {insights.length > 0 && <Insights key={id} insights={insights} onSignal={onSignal} onEvent={onEvent} hasSignal={hasSignal} />}
      {/* Relative to the evaluation (a live card's may be a few minutes old — the heading says when it was checked). */}
      {findings.length > 0 && (
        <RuleFindings key={`rf-${id}`} findings={findings} now={intel.findings?.at ?? now} onSignal={onSignal} onChart={onChart} onEvent={onEvent} hasSignal={hasSignal} />
      )}

    </Section>
  );

  // The process now (kiln zone profile, PV / SP gauges, a level gauge); it carries the card's one time-range control.
  const proc = intel.process ?? null;
  const process = proc && (
    <ProcessBlock
      id={id}
      process={proc}
      meta={charts ? <TimeRange value={charts.range} onChange={setRange} disabled={charts.disabled} label="Chart time range" /> : undefined}
    />
  );

  // Charts over the viewer's range; without a chart set (vehicles) the activity analytics as before.
  const analytics = charts ? (
    <Section id={`eqp-an-${id}`} title="How it has behaved">
      <Charts
        specs={charts.specs}
        range={charts.range}
        onRange={setRange}
        disabled={charts.disabled}
        highlight={chartHl}
        notCharted={charts.notCharted}
        onEvent={onEvent}
        rangeControl={!proc}
        asOf={charts.at != null && charts.at < now ? clockLabel(charts.at, now) : null}
      />

      {a && (a.stops || a.loss) && <Analytics a={a} vehicle={vehicle} figuresOnly />}
    </Section>
  ) : (
    a && (
      <Section id={`eqp-an-${id}`} title={a.window.label}>
        <Analytics a={{ ...a, facts: panelFacts(intel, facets, tiles) }} vehicle={vehicle} />
      </Section>
    )
  );

  const withValue = table ? table.filter((r) => r.hasValue).length : 0;
  const signals = showSignals && (
    <Section
      id={`eqp-sig-${id}`}
      title={table ? 'PLC signals' : 'Signals'}
      meta={
        table ? (
          <span className="eqp-sec-meta num">
            {withValue} with values · {table.length - withValue} not available
          </span>
        ) : freshness && freshness !== FRESH ? (
          <span className="eqp-sec-meta">{freshness}</span>
        ) : undefined
      }
      refEl={reg('signals')}
    >
      {table ? (
        <SignalTable
          key={id}
          rows={table}
          range={charts?.range ?? '8h'}
          history={intel.history ? history : undefined}
          highlight={highlight}
          chartOf={charts ? chartOf : undefined}
          onChart={onSignalChart}
          label={`${h.title} signals`}
        />
      ) : (
        <Signals signals={{ ...intel.signals, rows: sig.rows }} highlight={highlight} />
      )}
      <NotModelled items={notModelled} />
    </Section>
  );

  const evOptions = eventFilterOptions(intel.events, log);
  const shownLog = filterLog(log, filter);
  const events = showEvents && (
    <Section
      id={`eqp-ev-${id}`}
      title="Events & alarms"
      meta={intel.events.openCount > 0 ? <span className="eqp-sec-meta">{intel.events.openCount} open</span> : undefined}
      refEl={reg('events')}
    >
      {log.length > 0 && (
        <div className="seg eqp-ev-filter" role="radiogroup" aria-label="Event type">
          {evOptions.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={filter === o.value} className={filter === o.value ? 'on' : ''} onClick={() => setEvFilter({ id, f: o.value })}>
              {o.label}
              {o.value !== 'all' && <small className="num"> {o.n}</small>}
            </button>
          ))}
        </div>
      )}
      {(filter === 'all' || filter === 'event') && (
        <EventList
          events={intel.events}
          now={now}
          open={expanded}
          onToggle={onToggleEvent}
          onViewAll={onViewAll}
          subject={id}
          shownAbove={shownAbove}
        />
      )}
      <LogList
        entries={shownLog}
        now={now}
        onEvent={onEvent}
        empty={filter !== 'all' && filter !== 'event' ? `No ${evOptions.find((o) => o.value === filter)!.label.toLowerCase()} entry in the last ${RANGE_BY_KEY[charts?.range ?? '8h'].label}.` : undefined}
      />
      {log.length > 0 && <p className="eqp-fine">Alarms, state changes and data-quality entries of the last {RANGE_BY_KEY[charts?.range ?? '8h'].label} · simulated.</p>}
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
        <>
          {figures}
          {process}
          <div className="eqp-cols">
            <div className="eqp-col eqp-col-a">{matters}</div>
            <div className="eqp-col eqp-col-b">{events}</div>
          </div>
          {analytics}
          {signals}
        </>
      ) : (
        <>
          {figures}
          {process}
          {matters}
          {analytics}
          {signals}
          {events}
        </>
      )}

      <ContinueIn links={links} />
      <TechnicalDetails intel={intel} />
      {table && (
        <p className="eqp-legend">
          <span className="eqp-cls c-core">Core</span> core candidate · <span className="eqp-cls c-conditional">Conditional</span> only where the controller or sensor supports it ·{' '}
          <span className="eqp-cls c-external">External</span> from another system —{' '}
          {h.source.kind === 'simulated' || h.source.kind === 'stale' ? 'all values are simulated demo data; no plant system feeds this card.' : 'no operating data is simulated for this asset.'}
        </p>
      )}
    </PanelShell>
  );
}

/** What the header's data badge means, per kind. */
const SOURCE_TITLE: Record<EquipmentIntel['header']['source']['kind'], string> = {
  simulated: 'Generated by the demo simulation engine — not plant telemetry.',
  stale: 'The asset’s (simulated) data feed stopped updating — values are the last ones received and the current state is unknown.',
  connected: 'Delivered by a configured, verified connection.',
  unavailable: 'No operating data is simulated for this asset; its catalogue signals are not modelled or need an integration.',
  reference: 'Part of the 3D layout for spatial context only — no data of any kind.',
};

// ── Hosts (the Factory Twin's inspector) ─────────────────────────────────────

/** The panel of a selected equipment item, derived from the shared simulation each tick (charts over the viewer's range). */
export function SelectedEquipmentPanel({ id }: { id: string }) {
  const finance = useApp((s) => s.finance);
  const cameraSources = useApp((s) => s.cameraSources);
  const range = useTwinUi((s) => s.panelRange);
  const d = useSimValue((s) => ({ intel: deriveEquipmentIntel(s, id, { finance, cameraSources, range, live: true }
), now: s.minute }), [id, finance, cameraSources, range]);

  return <EquipmentPanel intel={d.intel} now={d.now} />;
}

/** The panel of a selected vehicle (truck or internal vehicle) — the same component. */
export function SelectedVehiclePanel({ id }: { id: string }) {
  const finance = useApp((s) => s.finance);
  const cameraSources = useApp((s) => s.cameraSources);
  const d = useSimValue((s) => ({ intel: deriveVehicleIntel(s, id, { finance, cameraSources }), now: s.minute }), [id, finance, cameraSources]);
  return <EquipmentPanel intel={d.intel} now={d.now} />;
}
