/**
 * The inspection image of one simulated record: the illustrative frame rasterised through
 * src/twin/inspectionImage.ts (the same image the event report and the PDF embed, with its burnt-in
 * "illustrative frame · simulated classification" caption), in three views — annotated (simulated
 * box, class and, for the vision tunnel only, simulated confidence), original, and a close-up crop
 * around the box. It is never a camera image; it says so on and under the picture.
 */
import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { QualityInspection } from '../../model/types';
import { renderInspectionImage } from '../../twin/inspectionImage';
import { Segmented } from '../../ui/kit/Panel';
import { ProvenanceBadge } from '../../ui/kit/Page';
import { DEFECTS } from '../../model/plant';
import { FrameStill } from './FrameArt';
import { frameForRecord } from './frames';
import { SIM_MODEL, isVisionRecord } from './derive';
// Registers the frame rasteriser with the shared inspection-image bridge.
import './rasterise';

export type ImageView = 'annotated' | 'original' | 'closeup';

/** Raster edge in pixels (sharp at 1.5× on the ≤ 420 px evidence image; PNG data URLs are cached by the rasteriser). */
const SIZE = 640;

type Loaded = { key: string; url: string | null };

/** PNG data URL of a record's frame in a view; `pending` until it has been drawn. */
export function useInspectionImage(rec: QualityInspection, view: ImageView): { pending: boolean; url: string | null } {
  const key = `${rec.id}|${view}`;
  const [done, setDone] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    renderInspectionImage(rec, { annotated: view !== 'original', crop: view === 'closeup', size: SIZE })
      .then((url) => live && setDone({ key, url }))
      .catch(() => live && setDone({ key, url: null }));
    return () => {
      live = false;
    };
  }, [key, rec, view]);
  return done?.key === key ? { pending: false, url: done.url } : { pending: true, url: null };
}

export function InspectionImage({ rec, sku, view, onView }: { rec: QualityInspection; sku: string; view: ImageView; onView: (v: ImageView) => void }) {
  const img = useInspectionImage(rec, view);
  const vision = isVisionRecord(rec);
  const what = rec.defect ? DEFECTS[rec.defect].label.toLowerCase() : 'inspection result';
  const viewWord = view === 'annotated' ? 'annotated' : view === 'original' ? 'original' : 'close-up';
  const alt = `Simulated inspection frame of ${rec.id} (${what}, ${viewWord}) — an illustration of a simulated record, not a camera image`;
  const frame = frameForRecord(rec, sku);
  const views: { value: ImageView; label: string }[] = [
    { value: 'annotated', label: 'Annotated' },
    { value: 'original', label: 'Original' },
    ...(rec.box ? [{ value: 'closeup' as const, label: 'Close-up' }] : []),
  ];

  return (
    <figure className="qd-img">
      <div className="qd-img-bar">
        <Segmented label="Inspection image view" value={view} onChange={onView} options={views} />
      </div>
      <div className="qd-img-box">
        {img.url ? (
          <img src={img.url} alt={alt} width={SIZE} height={SIZE} />
        ) : img.pending ? (
          <div className="qd-img-wait" role="status">
            <LoaderCircle size={16} className="spin" aria-hidden /> Drawing the simulated inspection frame…
          </div>
        ) : frame ? (
          // The raster bridge could not draw (no canvas): show the same illustration as inline SVG.
          <FrameStill frame={frame} annotated={view !== 'original'} crop={view === 'closeup'} label={alt} className="qd-img-svg" />
        ) : (
          <div className="qd-img-wait">No frame for this record</div>
        )}
        <ProvenanceBadge kind="simulated" className="qd-img-prov" title="Drawn from a simulated inspection record — not a camera image" />
      </div>
      <figcaption className="qd-img-cap">
        <span>
          Illustrative frame of simulated record <span className="mono">{rec.id}</span> — not a camera image.
        </span>
        {view !== 'original' &&
          (vision ? (
            <span>
              Box, class and confidence: <span className="mono">{SIM_MODEL}</span> — deterministic rules, no vision model runs.
            </span>
          ) : (
            <span>Overlay: simulated laser-gauge measurement against its tolerance — no classification confidence.</span>
          ))}
      </figcaption>
    </figure>
  );
}
