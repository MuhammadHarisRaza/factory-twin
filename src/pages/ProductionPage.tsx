import { useCallback, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { useApp } from '../app/store';
import { PERIOD_LABELS } from '../sim/metrics';
import { Segmented } from '../ui/kit/Panel';
import { LEVELS, type Level } from './production/common';
import { EquipmentView } from './production/EquipmentView';
import { FactoryView } from './production/FactoryView';
import { LineView } from './production/LineView';
import { EquipmentDrawer } from './production/MachineDrawer';
import './production.css';

const LEVEL_KEY = 'wai.oee.level';
const loadLevel = (): Level => {
  try {
    const v = localStorage.getItem(LEVEL_KEY);
    return v === 'line' || v === 'equipment' ? v : 'factory';
  } catch {
    return 'factory';
  }
};
const saveLevel = (v: Level) => {
  try {
    localStorage.setItem(LEVEL_KEY, v);
  } catch {
    /* storage unavailable: keep in memory only */
  }
};

/**
 * OEE & Loss Intelligence (use case 2): one workspace, three levels over the same simulation
 * state — factory (output, capacity, losses, estimated value, investigation, what-ifs), production
 * line (throughput, traced bottleneck, buffers, line OEE) and equipment (every machine and conveyor,
 * with a drill-down to its events, their reports and the 3D twin).
 */
export function ProductionPage() {
  const periodKey = useApp((s) => s.period);
  const [level, setLevelState] = useState<Level>(loadLevel);
  const [asset, setAsset] = useState<string | null>(null);
  const setLevel = useCallback((l: Level) => {
    setLevelState(l);
    saveLevel(l);
  }, []);
  const closeDrawer = useCallback(() => setAsset(null), []);
  const about = LEVELS.find((l) => l.value === level)!.about;

  return (
    <div className="page prod">
      <div className="toolbar-row prod-levelbar">
        <Segmented label="Level" value={level} options={LEVELS.map((l) => ({ value: l.value, label: l.label }))} onChange={setLevel} />
        <span className="muted prod-level-about">{about}</span>
        <div className="spacer" />
        <span className="muted">{PERIOD_LABELS[periodKey]}</span>
        <span className="tag sim" title="All figures come from the simulated plant; nothing is connected to a real line">
          <FlaskConical size={11} aria-hidden /> Simulated data
        </span>
        <span className="tag sim" title="Money figures are estimates from the editable financial assumptions (Factory level)">
          Money = estimate · assumptions shown
        </span>
      </div>

      {level === 'factory' && <FactoryView periodKey={periodKey} onLevel={setLevel} onAsset={setAsset} />}
      {level === 'line' && <LineView periodKey={periodKey} onAsset={setAsset} />}
      {level === 'equipment' && <EquipmentView periodKey={periodKey} selected={asset} onAsset={setAsset} />}

      {asset && <EquipmentDrawer id={asset} periodKey={periodKey} onClose={closeDrawer} />}
    </div>
  );
}
