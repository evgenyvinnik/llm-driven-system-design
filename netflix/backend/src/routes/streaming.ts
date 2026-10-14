import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { query, queryOne } from '../db/index.js';
import { authenticate, requireProfile } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { getVideoStreamUrl } from '../services/storage.js';
import { withStorageCircuitBreaker } from '../services/circuit-breaker.js';
import { streamingLogger } from '../services/logger.js';
import { invalidateHomepage } from '../services/redis.js';
import {
  recordStreamingStart,
  recordStreamingEnd,
  recordBufferEvent,
  recordPlaybackError,
  playbackSessions,
  progressWrites,
  streamUrlRejections,
} from '../services/metrics.js';
import {
  resolvePlayable,
  loadViewer,
  evaluateEntitlement,
  planFor,
  qualitiesForPlan,
  acquireStreamSlot,
  releaseStreamSlot,
  buildStreamUrl,
  verifyStreamToken,
  type QualityRung,
  type ResolveError,
} from '../services/playback.js';
import { recordProgress, resolvePositionTimestamp, isProgressComplete } from '../services/progress.js';
import { PLAYBACK_CONFIG } from '../config.js';

/**
 * Streaming router.
 *
 * Playback is a short protocol:
 * 1. `POST /:videoId/sessions` checks entitlement (maturity, episode belongs to
 *    the title, plan quality cap, concurrent-stream slot) and returns a manifest
 *    whose rendition URLs are signed for this session.
 * 2. The player fetches `GET /:videoId/play?...&sig=` -- verified from the token
 *    alone, like a CDN edge -- which 302s to a presigned MinIO URL.
 * 3. `POST /:videoId/progress` every 10 s saves the resume position
 *    (last-writer-wins by position timestamp) and renews the stream slot.
 * 4. `DELETE /sessions/:sessionId` frees the slot when the player closes.
 */
const router = Router();

const uuid = z.string().uuid();

const sessionBodySchema = z.object({
  episodeId: uuid.optional(),
});

const progressBodySchema = z.object({
  episodeId: uuid.optional(),
  positionSeconds: z.number().min(0),
  durationSeconds: z.number().positive().max(24 * 60 * 60),
  /** When the position was observed (ms since epoch) -- the last-writer-wins clock. */
  clientTimestamp: z.number().int().positive().optional(),
  /** Renews this session's stream slot (progress reports double as heartbeats). */
  playbackSessionId: uuid.optional(),
});

/** Database row type for video file (quality variant) queries */
interface VideoFileRow {
  quality: string;
  bitrate: number | null;
  width: number | null;
  height: number | null;
}

/** Database row type for viewing progress queries */
interface ViewingProgressRow {
  position_seconds: number;
  duration_seconds: number;
}

function sendResolveError(res: Response, error: ResolveError): void {
  if (error === 'episode_required') {
    res.status(400).json({ error: 'Episode ID required for series' });
  } else if (error === 'episode_not_in_title') {
    res.status(404).json({ error: 'Episode not found in this title' });
  } else {
    res.status(404).json({ error: 'Video not found' });
  }
}

/**
 * POST /api/stream/:videoId/sessions
 * Starts a playback session: entitlement checks, a concurrent-stream slot, and
 * a manifest with signed rendition URLs and the resume position.
 * 403 maturity_restricted | 409 stream_limit | 404 unknown title or episode.
 */
router.post(
  '/:videoId/sessions',
  authenticate,
  requireProfile,
  rateLimit('playback'),
  async (req: Request, res: Response) => {
    try {
      const videoId = uuid.safeParse(req.params.videoId);
      const body = sessionBodySchema.safeParse(req.body ?? {});
      if (!videoId.success || !body.success) {
        res.status(400).json({ error: 'Invalid video or episode id' });
        return;
      }

      const viewer = await loadViewer(req.profileId!, req.accountId!);
      if (!viewer) {
        res.status(404).json({ error: 'Profile not found' });
        return;
      }

      const content = await resolvePlayable(videoId.data, body.data.episodeId);
      if (typeof content === 'string') {
        playbackSessions.labels('not_found').inc();
        sendResolveError(res, content);
        return;
      }

      const entitlement = evaluateEntitlement(viewer, content);
      if (!entitlement.allowed) {
        playbackSessions.labels(entitlement.reason).inc();
        streamingLogger.warn({
          profileId: viewer.profileId,
          videoId: content.videoId,
          titleMaturity: content.maturityLevel,
          profileMaturity: viewer.maturityLevel,
        }, 'Playback refused: maturity level');
        res.status(403).json({ error: 'This title is not available on this profile', code: entitlement.reason });
        return;
      }

      const plan = planFor(viewer.subscriptionTier);
      const sessionId = randomUUID();
      const slot = await acquireStreamSlot(viewer.accountId, sessionId, plan.maxStreams);
      if (!slot.granted) {
        playbackSessions.labels('stream_limit').inc();
        res.status(409).json({
          error: `Your plan allows ${slot.limit} screen${slot.limit === 1 ? '' : 's'} at a time. Stop playback on another device to watch here.`,
          code: 'stream_limit',
          activeStreams: slot.activeStreams,
          limit: slot.limit,
        });
        return;
      }

      // Renditions recorded for this content, if any; otherwise the default ladder.
      const files = await query<VideoFileRow>(
        content.episodeId
          ? 'SELECT quality, bitrate, width, height FROM video_files WHERE episode_id = $1'
          : 'SELECT quality, bitrate, width, height FROM video_files WHERE video_id = $1',
        [content.contentId]
      );
      const recorded: QualityRung[] = files.map((f) => ({
        quality: f.quality,
        bitrate: f.bitrate || 1000,
        width: f.width || 1280,
        height: f.height || 720,
      }));
      const ladder = qualitiesForPlan(viewer.subscriptionTier, recorded.length > 0 ? recorded : undefined);

      const expiresAt = Math.floor(Date.now() / 1000) + PLAYBACK_CONFIG.urlTtlSeconds;
      const qualities = ladder.map((q) => ({
        ...q,
        url: buildStreamUrl({
          sessionId,
          videoId: content.videoId,
          episodeId: content.episodeId,
          quality: q.quality,
          expiresAt,
        }),
      }));

      const progress = await queryOne<ViewingProgressRow>(
        'SELECT position_seconds, duration_seconds FROM viewing_progress WHERE profile_id = $1 AND content_id = $2',
        [viewer.profileId, content.contentId]
      );
      const resumePosition =
        progress && !isProgressComplete(progress.position_seconds, progress.duration_seconds)
          ? progress.position_seconds
          : 0;

      const startQuality = ladder.find((q) => q.quality === '720p') || ladder[0];
      playbackSessions.labels('started').inc();
      recordStreamingStart(startQuality?.quality || 'unknown', content.episodeId ? 'episode' : 'movie');

      streamingLogger.info({
        sessionId,
        videoId: content.videoId,
        episodeId: content.episodeId,
        profileId: viewer.profileId,
        plan: viewer.subscriptionTier,
        activeStreams: slot.activeStreams,
        failedOpen: slot.failedOpen,
      }, 'Playback session started');

      res.status(201).json({
        playbackSessionId: sessionId,
        videoId: content.videoId,
        episodeId: content.episodeId ?? undefined,
        durationSeconds: content.durationSeconds,
        qualities,
        resumePosition,
        urlExpiresAt: new Date(expiresAt * 1000).toISOString(),
        lease: {
          ttlSeconds: PLAYBACK_CONFIG.streamLeaseSeconds,
          heartbeatSeconds: PLAYBACK_CONFIG.progressIntervalSeconds,
          activeStreams: slot.activeStreams,
          limit: slot.limit,
        },
      });
    } catch (error) {
      streamingLogger.error({ error }, 'Start playback session error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * DELETE /api/stream/sessions/:sessionId
 * Ends a playback session and frees its stream slot. Idempotent (always 204).
 */
router.delete('/sessions/:sessionId', authenticate, async (req: Request, res: Response) => {
  const sessionId = uuid.safeParse(req.params.sessionId);
  if (!sessionId.success) {
    res.status(400).json({ error: 'Invalid session id' });
    return;
  }

  const released = await releaseStreamSlot(req.accountId!, sessionId.data);
  if (released) {
    recordStreamingEnd();
  }
  res.status(204).end();
});

/**
 * GET /api/stream/:videoId/play?quality&episodeId&sid&exp&sig
 * Verifies the signed URL and redirects to a presigned MinIO URL.
 *
 * No session cookie and no database lookup: the token is the credential, as on
 * a CDN edge. The object key is derived only from signed fields, so a caller
 * cannot swap in another title or quality.
 */
router.get(
  '/:videoId/play',
  rateLimit('playback'),
  async (req: Request, res: Response) => {
    try {
      const { quality, episodeId, sid, exp, sig } = req.query;
      if (typeof quality !== 'string' || typeof sid !== 'string' || typeof exp !== 'string' || typeof sig !== 'string') {
        streamUrlRejections.labels('missing').inc();
        res.status(401).json({ error: 'Signed stream URL required; start a playback session first' });
        return;
      }

      const claims = {
        sessionId: sid,
        videoId: req.params.videoId,
        episodeId: typeof episodeId === 'string' && episodeId ? episodeId : null,
        quality,
        expiresAt: Number(exp),
      };
      const verdict = verifyStreamToken(claims, sig);
      if (verdict !== 'ok') {
        streamUrlRejections.labels(verdict).inc();
        res.status(403).json({
          error: verdict === 'expired' ? 'Stream URL expired; start a new playback session' : 'Invalid stream URL signature',
        });
        return;
      }

      const contentId = claims.episodeId || claims.videoId;
      const videoKey = `videos/${contentId}/${quality}/video.mp4`;
      const contentType = claims.episodeId ? 'episode' : 'movie';
      // The storage URL must not outlive the stream URL it was minted for.
      const presignSeconds = Math.max(60, Math.min(3600, claims.expiresAt - Math.floor(Date.now() / 1000)));

      try {
        const streamUrl = await withStorageCircuitBreaker(() =>
          getVideoStreamUrl(videoKey, presignSeconds)
        );

        streamingLogger.info({
          videoId: claims.videoId,
          episodeId: claims.episodeId,
          quality,
          sessionId: sid,
        }, 'Stream URL redirected');

        res.redirect(streamUrl);
      } catch (error) {
        // If file doesn't exist or circuit is open, return fallback
        recordPlaybackError('storage_error', contentType);

        streamingLogger.warn({
          videoId: claims.videoId,
          quality,
          error: String(error),
        }, 'Video file not found or storage unavailable');

        res.json({
          message: 'Video file not found in storage',
          note: 'For demo purposes, upload videos to MinIO or use the sample video endpoint',
          expectedPath: videoKey,
        });
      }
    } catch (error) {
      streamingLogger.error({ error }, 'Play video error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/stream/:videoId/progress
 * Saves the resume position (last-writer-wins by `clientTimestamp`), records a
 * view in watch history on the transition to completed (>95%), and renews the
 * stream slot when `playbackSessionId` is sent.
 *
 * Retries and late arrivals return 200 with `applied: false` -- the stored
 * position is already as new or newer.
 */
router.post(
  '/:videoId/progress',
  authenticate,
  requireProfile,
  rateLimit('progress'),
  async (req: Request, res: Response) => {
    try {
      const videoId = uuid.safeParse(req.params.videoId);
      const body = progressBodySchema.safeParse(req.body);
      if (!videoId.success || !body.success) {
        res.status(400).json({
          error: 'Invalid progress report',
          details: body.success ? undefined : body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        return;
      }

      const { episodeId, clientTimestamp, playbackSessionId } = body.data;
      const durationSeconds = Math.floor(body.data.durationSeconds);
      const positionSeconds = Math.min(Math.floor(body.data.positionSeconds), durationSeconds);

      const viewer = await loadViewer(req.profileId!, req.accountId!);
      if (!viewer) {
        res.status(404).json({ error: 'Profile not found' });
        return;
      }

      const content = await resolvePlayable(videoId.data, episodeId);
      if (typeof content === 'string') {
        sendResolveError(res, content);
        return;
      }
      if (!evaluateEntitlement(viewer, content).allowed) {
        res.status(403).json({ error: 'This title is not available on this profile', code: 'maturity_restricted' });
        return;
      }

      const result = await recordProgress({
        profileId: viewer.profileId,
        videoId: content.videoId,
        episodeId: content.episodeId,
        positionSeconds,
        durationSeconds,
        positionTimestamp: resolvePositionTimestamp(clientTimestamp),
      });
      progressWrites.labels(result.applied ? 'applied' : 'stale').inc();

      if (result.continueWatchingChanged) {
        await invalidateHomepage(viewer.profileId);
      }

      // Progress reports double as the stream-slot heartbeat.
      let lease: { active: boolean; activeStreams: number; limit: number } | undefined;
      if (playbackSessionId) {
        const slot = await acquireStreamSlot(
          viewer.accountId,
          playbackSessionId,
          planFor(viewer.subscriptionTier).maxStreams
        );
        lease = { active: slot.granted, activeStreams: slot.activeStreams, limit: slot.limit };
        if (!slot.granted) {
          streamingLogger.info({ accountId: viewer.accountId, playbackSessionId }, 'Stream slot lost');
        }
      }

      res.json({
        success: true,
        applied: result.applied,
        completed: result.completed,
        positionSeconds: result.positionSeconds,
        lease,
      });
    } catch (error) {
      streamingLogger.error({ error }, 'Update progress error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/stream/:videoId/progress
 * Returns current viewing progress for a video or episode.
 */
router.get(
  '/:videoId/progress',
  authenticate,
  requireProfile,
  async (req: Request, res: Response) => {
    try {
      const { episodeId } = req.query;
      const contentId = uuid.safeParse(typeof episodeId === 'string' && episodeId ? episodeId : req.params.videoId);
      if (!contentId.success) {
        res.status(400).json({ error: 'Invalid video or episode id' });
        return;
      }

      const progress = await queryOne<ViewingProgressRow & { completed: boolean }>(
        `SELECT position_seconds, duration_seconds, completed
         FROM viewing_progress
         WHERE profile_id = $1 AND content_id = $2`,
        [req.profileId, contentId.data]
      );

      if (!progress) {
        res.json({ positionSeconds: 0, durationSeconds: 0, percentComplete: 0, completed: false });
        return;
      }

      res.json({
        positionSeconds: progress.position_seconds,
        durationSeconds: progress.duration_seconds,
        percentComplete: Math.round((progress.position_seconds / progress.duration_seconds) * 100),
        completed: progress.completed,
      });
    } catch (error) {
      streamingLogger.error({ error }, 'Get progress error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/stream/:videoId/buffer
 * Records a buffer event during playback (for QoE metrics).
 */
router.post(
  '/:videoId/buffer',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { quality, episodeId } = req.body;
      const contentType = episodeId ? 'episode' : 'movie';

      recordBufferEvent(quality || 'unknown', contentType);

      streamingLogger.debug({
        videoId: req.params.videoId,
        quality,
        contentType,
      }, 'Buffer event recorded');

      res.json({ success: true });
    } catch (error) {
      streamingLogger.error({ error }, 'Buffer event error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * POST /api/stream/:videoId/error
 * Records a playback error (for QoE metrics).
 */
router.post(
  '/:videoId/error',
  authenticate,
  async (req: Request, res: Response) => {
    try {
      const { errorType, episodeId } = req.body;
      const contentType = episodeId ? 'episode' : 'movie';

      recordPlaybackError(errorType || 'unknown', contentType);

      streamingLogger.warn({
        videoId: req.params.videoId,
        errorType,
        contentType,
      }, 'Playback error recorded');

      res.json({ success: true });
    } catch (error) {
      streamingLogger.error({ error }, 'Playback error recording failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);


export default router;
