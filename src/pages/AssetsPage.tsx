/**
 * Assets & Data — the registry behind every other workspace: equipment mapped to the
 * 3D model, the signals each asset provides and the metrics they feed, data sources
 * and their integration status, a unified event log and the simulation parameters.
 */
import { useState } from 'react';
import { Info } from 'lucide-react';
import { Segmented } from '../ui/kit/Panel';
import { EquipmentTab } from './assets/EquipmentTab';
import { EventsTab } from './assets/EventsTab';
import { SignalsTab } from './assets/SignalsTab';
import { SimulationTab } from './assets/SimulationTab';
import { SourcesTab } from './assets/SourcesTab';
import './assets.css';

type Tab = 'equipment' | 'signals' | 'sources' | 'events' | 'simulation';

const TABS: { value: Tab; label: string }[] = [
  { value: 'equipment', label: 'Equipment registry' },
  { value: 'signals', label: 'Signals & mappings' },
  { value: 'sources', label: 'Data sources' },
  { value: 'events', label: 'Event history' },
  { value: 'simulation', label: 'Simulation' },
];

export function AssetsPage() {
  const [tab, setTab] = useState<Tab>('equipment');
  const [signalEquipment, setSignalEquipment] = useState('');

  return (
    <div className="page assets-page">
      <div className="toolbar-row">
        <Segmented<Tab> label="Assets & Data section" value={tab} options={TABS} onChange={setTab} />
        <div className="spacer" />
        <span className="a-note">
          <Info size={13} aria-hidden />
          All values come from the simulation engine; no external system is connected.
        </span>
      </div>

      {tab === 'equipment' && (
        <EquipmentTab
          onShowSignals={(id) => {
            setSignalEquipment(id);
            setTab('signals');
          }}
        />
      )}
      {tab === 'signals' && <SignalsTab equipment={signalEquipment} onEquipment={setSignalEquipment} />}
      {tab === 'sources' && <SourcesTab />}
      {tab === 'events' && <EventsTab />}
      {tab === 'simulation' && <SimulationTab />}
    </div>
  );
}
