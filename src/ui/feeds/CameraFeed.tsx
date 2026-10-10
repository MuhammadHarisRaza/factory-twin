import type { CSSProperties } from 'react';

/**
 * Camera feed (placeholder — replaced by the feeds builder). A simulated feed renders the digital
 * twin from the camera position; a configured live stream plays only when it actually connects.
 */
export type CameraFeedProps = {
  cameraId: string;
  /** Height in px (width follows the container, 16:9 by default). */
  height?: number;
  /** Smaller chrome for side panels. */
  compact?: boolean;
  style?: CSSProperties;
};

export function CameraFeed({ cameraId, height = 200, style }: CameraFeedProps) {
  return (
    <div className="empty" style={{ height, ...style }}>
      <b>{cameraId}</b>
      <span>Camera feed component loading…</span>
    </div>
  );
}
