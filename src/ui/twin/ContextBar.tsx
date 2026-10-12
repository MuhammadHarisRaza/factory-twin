/**
 * Where the user is in the model: Whole factory › zone › highlighted stage › selected asset or
 * vehicle. Each step goes back to that level ("Whole factory" resets selection, highlight and
 * camera, like the header button and R). Shown only while something is in context, so the model
 * stays uncovered in the overview shot.
 */
import { ChevronRight, House, X } from 'lucide-react';
import { EQUIPMENT_BY_ID } from '../../data/equipment';
import { ZONE_BY_ID } from '../../data/layout';
import { MONITORED_STAGE_BY_ID } from '../../model/plant';
import { useSimValue } from '../../sim/store';
import { useTwin } from '../../store';

export function ContextBar() {
  const zone = useTwin((s) => s.zone);
  const stage = useTwin((s) => s.stage);
  const selected = useTwin((s) => s.selected);
  const vehicle = useTwin((s) => s.vehicle);
  const vehicleLabel = useSimValue((s) => (vehicle ? (s.logistics.vehicles[vehicle]?.label ?? vehicle) : null), [vehicle]);
  if (!zone && !stage && !selected && !vehicle) return null;
  const tw = () => useTwin.getState();
  const z = zone ? ZONE_BY_ID[zone] : null;
  const ms = stage ? MONITORED_STAGE_BY_ID[stage] : null;
  const item = selected ? EQUIPMENT_BY_ID[selected] : null;
  const leaf = vehicle ? vehicleLabel : (item?.name ?? null);
  return (
    <nav className="tw-ctx overlay-panel" aria-label="Model context">
      <button type="button" className="tw-ctx-b" onClick={() => tw().reset()} title="Return to the whole factory: clear the selection and the stage highlight (R)">
        <House size={13} aria-hidden />
        Whole factory
      </button>
      {z && (
        <>
          <ChevronRight size={12} className="tw-ctx-sep" aria-hidden />
          <button
            type="button"
            className="tw-ctx-b"
            onClick={() => {
              if (tw().vehicle) tw().selectVehicle(null);
              tw().selectZone(z.id);
            }}
            title={`Back to zone ${z.id} (${z.name})`}
            aria-current={!ms && !leaf ? 'location' : undefined}
          >
            <span className="chip" style={{ background: z.color }} aria-hidden>
              {z.id}
            </span>
            {z.short}
          </button>
        </>
      )}
      {ms && (
        <>
          <ChevronRight size={12} className="tw-ctx-sep" aria-hidden />
          <span className="tw-ctx-stage">
            <button
              type="button"
              className="tw-ctx-b"
              onClick={() => {
                if (tw().vehicle) tw().selectVehicle(null);
                if (tw().selected) tw().select(null);
              }}
              title={`Stage highlighted in the model: ${ms.name} — open its panel`}
              aria-current={!leaf ? 'location' : undefined}
            >
              Stage · {ms.name}
            </button>
            <button type="button" className="tw-ctx-x" onClick={() => tw().selectStage(null)} title="Clear the stage highlight" aria-label={`Clear the highlight of ${ms.name}`}>
              <X size={11} />
            </button>
          </span>
        </>
      )}
      {leaf && (
        <>
          <ChevronRight size={12} className="tw-ctx-sep" aria-hidden />
          <span className="tw-ctx-leaf" aria-current="location">
            {leaf}
          </span>
        </>
      )}
    </nav>
  );
}
