/**
 * Self-contained SVG markup of an illustrative inspection frame (the same FrameArt drawing the
 * Quality workspace shows), for rasterising into reports and the PDF. Pure: no simulation store,
 * no DOM. react-dom/server is loaded on first use so it stays out of the main bundle.
 */
import { createElement } from 'react';
import { FrameStill } from './FrameArt';
import type { Frame } from './frames';

export type StillOpts = {
  /** With the gauge overlay, detection box, class + simulated confidence and a scale bar. */
  annotated: boolean;
  /** Square crop around the detection box (ignored when the record has no box). */
  crop?: boolean;
  /** Output edge in pixels. */
  size: number;
};

export async function frameStillMarkup(frame: Frame, opts: StillOpts): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  return renderToStaticMarkup(
    createElement(FrameStill, {
      frame,
      annotated: opts.annotated,
      crop: opts.crop && !!frame.rec?.box,
      standalone: { size: Math.max(16, Math.round(opts.size)) },
    }),
  );
}

/** Caption every exported frame carries, so the image can never pass for a camera picture. */
export const STILL_CAPTION = 'Illustrative frame · simulated classification — no vision model';
