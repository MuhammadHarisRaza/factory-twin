import { Expand, Info, Presentation, RotateCcw } from 'lucide-react';
import { useTwin } from '../store';

export function TopBar() {
  const reset = useTwin((s) => s.reset);
  const fit = useTwin((s) => s.fit);
  const setUiHidden = useTwin((s) => s.setUiHidden);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="mark">wAI</div>
        <div>
          <div className="title">wAI Manufacturing Digital Twin</div>
          <div className="sub">Ceramic tile facility · Phase 1 factory model</div>
        </div>
      </div>
      <div className="disclaimer" tabIndex={0}>
        <Info size={14} />
        <span>Representative layout · reference context: Ghani Ceramics</span>
        <div className="tip">
          This is a representative ceramic tile plant built for demonstration. It does not reproduce Ghani
          Ceramics' actual site layout, equipment, brands, capacity or configuration. No live data is shown.
        </div>
      </div>
      <div className="spacer" />
      <button className="tb-btn" onClick={fit} title="Fit the whole site in view (F)">
        <Expand size={16} />
        Fit
      </button>
      <button className="tb-btn" onClick={reset} title="Reset camera and selection (R)">
        <RotateCcw size={16} />
        Reset
      </button>
      <button className="tb-btn" onClick={() => setUiHidden(true)} title="Presentation mode — hide the interface (H)">
        <Presentation size={16} />
        Present
      </button>
    </header>
  );
}
