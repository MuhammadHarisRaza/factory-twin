/**
 * Stage view signals (Production → a stage → Signal trends): process values without a physical model
 * and energy-model signals are listed without a value (the same classification as the equipment
 * workspace's Technical details), every row says its basis, and condition charts are named after the
 * monitored component — never a bare "Temperature" that would read as a kiln temperature.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.hoisted(() => {
  const g = globalThis as unknown as { window?: unknown };
  g.window ??= { addEventListener() {}, removeEventListener() {}, innerWidth: 1920, innerHeight: 1080 };
});

import { createSim } from '../../../sim/engine';
import { HEALTH_BY_ID } from '../../../sim/health';
import { signalValue } from '../../../sim/signals';
import { BASIS_LABEL } from '../../../ui/equipment/signals';
import { signalRows, trendSignals } from './derive';
import { SignalTable } from './Signals';

const s = createSim();
const rowsOf = (id: string) => Object.fromEntries(signalRows(s, id).map((r) => [r.name, r]));

describe('stage view signal table', () => {
  it('withholds placeholder process values ("Not modelled") and energy-model values ("Not monitored")', () => {
    const kiln = rowsOf('H-KILN');
    const twr = rowsOf('D-TWR');
    const dry = rowsOf('F-DRY');
    for (const r of [kiln.temp_firing, kiln.temp_preheat, twr.temp_inlet, twr.powder_moisture, dry.temp_deck]) {
      expect(r, 'configured').toBeDefined();
      expect(r.value, r.id).toBeNull();
      expect(r.valueLabel, r.id).toBe('Not modelled');
      expect(r.basis, r.id).toBe('placeholder');
      expect(r.basisLabel).toBe(BASIS_LABEL.placeholder);
      expect(r.staleSince).toBeNull();
    }
    expect(kiln.energy_kwh).toMatchObject({ value: null, valueLabel: 'Not monitored', basis: 'energy-model', basisLabel: BASIS_LABEL['energy-model'] });
    // Engine and condition signals keep their simulated values.
    expect(kiln.rate).toMatchObject({ basis: 'engine', valueLabel: null });
    expect(kiln.rate.value).not.toBeNull();
    expect(kiln.temperature).toMatchObject({ basis: 'condition', basisLabel: BASIS_LABEL.condition });
    expect(kiln.temperature.value).not.toBeNull();
  });

  it('renders a Basis column and never the placeholder number', () => {
    const html = renderToStaticMarkup(<SignalTable rows={signalRows(s, 'H-KILN')} />);
    for (const text of ['Signal id', 'Current value', 'Basis', 'History', 'Not modelled', 'Not monitored', BASIS_LABEL.placeholder, BASIS_LABEL['energy-model'], 'H-KILN.temp_firing'])
      expect(html, text).toContain(text);
    const firing = signalValue(s, 'H-KILN.temp_firing').text;
    const energy = signalValue(s, 'H-KILN.energy_kwh').text;
    expect(firing).toMatch(/\d/);
    expect(html).not.toContain(`>${firing}<`);
    expect(html).not.toContain(`${firing} `);
    expect(html).not.toContain(energy);
    expect(html).not.toMatch(/kWh/);
  });

  it('names condition charts after the monitored component', () => {
    const kiln = trendSignals('H-KILN').filter((x) => x.source === 'condition');
    expect(kiln.length).toBe(3);
    const component = HEALTH_BY_ID['H-KILN'].component;
    expect(kiln.map((x) => x.label)).toEqual(
      expect.arrayContaining([`Temperature · ${component}`, `Vibration velocity · ${component}`, `Motor current · ${component}`]),
    );
    for (const id of ['C-BM1', 'D-TWR', 'E-PRS1', 'F-DRY', 'H-KILN', 'J-PAL'])
      for (const t of trendSignals(id).filter((x) => x.source === 'condition')) {
        expect(t.label, id).not.toBe('Temperature');
        expect(t.label, id).toContain(HEALTH_BY_ID[id].component);
        expect(t.component).toBe(HEALTH_BY_ID[id].component);
      }
  });
});
