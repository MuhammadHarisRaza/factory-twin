/**
 * Contextual reference video: picks the registry clips for an equipment item, a stage or a topic
 * and shows one in the shared player (it starts muted once on screen, see VideoPlayer). When several
 * topics apply (the kiln: infeed, firing, exterior, discharge) the user switches between them;
 * each keeps its own label, so an exterior clip is never presented as the firing zone.
 */
import { useCallback, useMemo, useState } from 'react';
import { Clapperboard } from 'lucide-react';
import type { VideoContext, VideoRef, VideoTopic } from './types';
import { VIDEOS } from './registry';
import { EQUIPMENT_TOPICS, STAGE_TOPICS, TOPIC_LABEL } from './topics';
import { VideoPlayer } from './VideoPlayer';
import './video.css';

/** Topics that apply to a context, most specific first. */
export function topicsFor(ctx: VideoContext): VideoTopic[] {
  if (ctx.topic) return [ctx.topic];
  if (ctx.equipmentId && EQUIPMENT_TOPICS[ctx.equipmentId]) return EQUIPMENT_TOPICS[ctx.equipmentId];
  if (ctx.equipmentId) return [];
  if (ctx.stage) return STAGE_TOPICS[ctx.stage] ?? [];
  return [];
}

/** Best clip per applicable topic (equipment match first). */
export function clipsFor(ctx: VideoContext, videos: VideoRef[] = VIDEOS): { topic: VideoTopic; video: VideoRef }[] {
  const out: { topic: VideoTopic; video: VideoRef }[] = [];
  for (const topic of topicsFor(ctx)) {
    const candidates = videos.filter((v) => v.topic === topic);
    if (!candidates.length) continue;
    const best = candidates.find((v) => ctx.equipmentId && v.equipment.includes(ctx.equipmentId)) ?? candidates[0];
    out.push({ topic, video: best });
  }
  return out;
}

/**
 * `subject` names what the panel is about (e.g. a vehicle id). While the viewer watches a clip (started
 * it with sound or unmuted it), a change of context for the same subject (a truck moving from the queue
 * to the dock changes the topic) does not swap the clip under them; selecting another subject does.
 * `bare`: one clip only — the most specific topic's — with no topic tabs, no heading and the bare
 * player (no caption); the host shows its source.
 */
export function ContextVideo({
  context,
  compact = false,
  bare = false,
  title = 'Reference video',
  subject,
}: {
  context: VideoContext;
  compact?: boolean;
  bare?: boolean;
  title?: string;
  subject?: string;
}) {
  const clips = useMemo(() => clipsFor(context), [context]);
  const key = `${context.equipmentId ?? ''}|${context.stage ?? ''}|${context.topic ?? ''}`;
  const who = subject ?? `${context.equipmentId ?? ''}|${context.stage ?? ''}`;
  const [pick, setPick] = useState<{ key: string; topic: VideoTopic } | null>(null);
  // The clip being watched, kept while the viewer engages with it and the subject is the same.
  const [held, setHeld] = useState<{ who: string; clip: { topic: VideoTopic; video: VideoRef } } | null>(null);
  const topic = pick && pick.key === key && !bare ? pick.topic : clips[0]?.topic;
  const chosen = clips.find((c) => c.topic === topic) ?? clips[0];
  const current = held && held.who === who ? held.clip : chosen;
  const onActiveChange = useCallback(
    (_loaded: boolean, engaged: boolean) => setHeld(engaged && current ? { who, clip: current } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- capture the clip that was playing when it started
    [who, current?.video.id],
  );

  if (!current) {
    const topics = topicsFor(context);
    return (
      <div className={`cv cv-none ${compact ? 'compact' : ''}`} role="note">
        <Clapperboard size={14} aria-hidden />
        <span>{topics.length ? `No reference video available for ${TOPIC_LABEL[topics[0]].toLowerCase()}.` : 'No reference video for this item.'}</span>
      </div>
    );
  }
  if (bare)
    return (
      <div className="cv bare">
        <VideoPlayer key={current.video.id} video={current.video} bare onActiveChange={onActiveChange} />
      </div>
    );
  return (
    <div className={`cv ${compact ? 'compact' : ''}`}>
      {(clips.length > 1 || !compact) && (
        <div className="cv-head">
          {!compact && <span className="cv-title">{title}</span>}
          {clips.length > 1 && (
            <div className="cv-topics" role="tablist" aria-label="Reference footage topic">
              {clips.map((c) => (
                <button key={c.topic} type="button" role="tab" aria-selected={c.topic === current.topic} className={c.topic === current.topic ? 'on' : ''} onClick={() => {
                    setHeld(null);
                    setPick({ key, topic: c.topic });
                  }}>
                  {TOPIC_LABEL[c.topic]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <VideoPlayer key={current.video.id} video={current.video} compact={compact} onActiveChange={onActiveChange} />
    </div>
  );
}
