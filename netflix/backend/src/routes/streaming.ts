import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate, requireProfile } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { getVideoStreamUrl } from '../services/storage.js';
import { withStorageCircuitBreaker } from '../services/circuit-breaker.js';
import { streamingLogger } from '../services/logger.js';
import {
  recordStreamingStart,
  recordStreamingEnd,
  recordBufferEvent,
  recordPlaybackError,
} from '../services/metrics.js';
import { STREAMING_CONFIG, MINIO_CONFIG } from '../config.js';

/**
 * Streaming router.
 * Handles video playback including manifest generation, stream URLs,
 * and viewing progress tracking for resume functionality.
 */
const router = Router();

/** Database row type for video queries (minimal fields for streaming) */
interface VideoRow {
  id: string;
  title: string;
  type: 'movie' | 'series';
  duration_minutes: number | null;
}

/** Database row type for episode queries */
interface EpisodeRow {
  id: string;
  season_id: string;
  episode_number: number;
  title: string;
  duration_minutes: number | null;
  video_key: string | null;
}

/** Database row type for video file (quality variant) queries */
interface VideoFileRow {
  id: string;
  video_id: string | null;
  episode_id: string | null;
  quality: string;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  video_key: string;
}

/** Database row type for viewing progress queries */
interface ViewingProgressRow {
  position_seconds: number;
  duration_seconds: number;
}

/**
 * GET /api/stream/:videoId/manifest
 * Returns streaming manifest with available quality levels and resume position.
 * For series, requires episodeId query parameter.
 */
router.get(
  '/:videoId/manifest',
  authenticate,
  requireProfile,
  rateLimit('playback'),
  async (req: Request, res: Response) => {
    try {
      const { videoId } = req.params;
      const { episodeId } = req.query;

      let durationMinutes: number;
      let contentId: string;
      let contentType: 'video' | 'episode';

      if (episodeId) {
        // Get episode info
        const episode = await queryOne<EpisodeRow>(
          'SELECT * FROM episodes WHERE id = $1',
          [episodeId]
        );

        if (!episode) {
          res.status(404).json({ error: 'Episode not found' });
          return;
        }

        durationMinutes = episode.duration_minutes || 45;
        contentId = episode.id;
        contentType = 'episode';
      } else {
        // Get video info
        const video = await queryOne<VideoRow>(
          'SELECT * FROM videos WHERE id = $1',
          [videoId]
        );

        if (!video) {
          res.status(404).json({ error: 'Video not found' });
          return;
        }

        if (video.type === 'series') {
          res.status(400).json({ error: 'Episode ID required for series' });
          return;
        }

        durationMinutes = video.duration_minutes || 120;
        contentId = video.id;
        contentType = 'video';
      }

      // Get available qualities from database (or use defaults)
      const videoFiles = await query<VideoFileRow>(
        contentType === 'episode'
          ? 'SELECT * FROM video_files WHERE episode_id = $1'
          : 'SELECT * FROM video_files WHERE video_id = $1',
        [contentId]
      );

      // Build quality list
      let qualities;
      if (videoFiles.length > 0) {
        qualities = videoFiles.map((vf) => ({
          quality: vf.quality,
          bitrate: vf.bitrate || 1000,
          width: vf.width || 1280,
          height: vf.height || 720,
          url: `${req.protocol}://${req.get('host')}/api/stream/${videoId}/play?quality=${vf.quality}${episodeId ? `&episodeId=${episodeId}` : ''}`,
        }));
      } else {
        // Use default qualities for demo
        qualities = STREAMING_CONFIG.qualities.map((q) => ({
          quality: q.name,
          bitrate: q.bitrate,
          width: q.width,
          height: q.height,
          url: `${req.protocol}://${req.get('host')}/api/stream/${videoId}/play?quality=${q.name}${episodeId ? `&episodeId=${episodeId}` : ''}`,
        }));
      }

      // Get resume position
      let resumePosition = 0;
      const progress = await queryOne<ViewingProgressRow>(
        contentType === 'episode'
          ? 'SELECT position_seconds, duration_seconds FROM viewing_progress WHERE profile_id = $1 AND episode_id = $2'
          : 'SELECT position_seconds, duration_seconds FROM viewing_progress WHERE profile_id = $1 AND video_id = $2',
        [req.profileId, contentId]
      );

      if (progress && !isProgressComplete(progress.position_seconds, progress.duration_seconds)) {
        resumePosition = progress.position_seconds;
      }

      streamingLogger.info({
        videoId,
        episodeId,
        profileId: req.profileId,
        contentType,
      }, 'Generated streaming manifest');

      res.json({
        videoId,
        episodeId: episodeId || undefined,
        durationSeconds: durationMinutes * 60,
        qualities,
        resumePosition,
      });
    } catch (error) {
      streamingLogger.error({ error }, 'Get manifest error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

/**
 * GET /api/stream/:videoId/play
 * Redirects to presigned video stream URL in MinIO/S3.
 * For demo, returns error info if video file doesn't exist.
 */
router.get(
  '/:videoId/play',
  authenticate,
  rateLimit('playback'),
  async (req: Request, res: Response) => {
    try {
      const { videoId } = req.params;
      const { quality = '720p', episodeId } = req.query;
      const qualityStr = String(quality);

      // Build video key
      const contentId = episodeId || videoId;
      const videoKey = `videos/${contentId}/${qualityStr}/video.mp4`;
      const contentType = episodeId ? 'episode' : 'movie';

      try {
        // Try to get presigned URL with circuit breaker
        const streamUrl = await withStorageCircuitBreaker(() =>
          getVideoStreamUrl(videoKey)
        );

        // Record streaming start metric
        recordStreamingStart(qualityStr, contentType as 'movie' | 'episode');

        streamingLogger.info({
          videoId,
          episodeId,
          quality: qualityStr,
          profileId: req.profileId,
        }, 'Streaming started');

        res.redirect(streamUrl);
      } catch (error) {
        // If file doesn't exist or circuit is open, return fallback
        recordPlaybackError('storage_error', contentType as 'movie' | 'episode');

        streamingLogger.warn({
          videoId,
          quality: qualityStr,
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
 * Updates viewing progress for resume functionality.
 * Also adds to watch history when content is completed (>95%).
 */
router.post(
  '/:videoId/progress',
  authenticate,
  requireProfile,
  rateLimit('progress'),
  async (req: Request, res: Response) => {
    try {
      const { videoId } = req.params;
      const { episodeId, positionSeconds, durationSeconds } = req.body;

      if (typeof positionSeconds !== 'number' || typeof durationSeconds !== 'number') {
        res.status(400).json({ error: 'Position and duration required' });
        return;
      }

      const completed = isProgressComplete(positionSeconds, durationSeconds);

      if (episodeId) {
        // Update episode progress
        await query(
          `INSERT INTO viewing_progress (profile_id, episode_id, position_seconds, duration_seconds, completed, last_watched_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (profile_id, video_id, episode_id)
           DO UPDATE SET position_seconds = $3, duration_seconds = $4, completed = $5, last_watched_at = NOW()`,
          [req.profileId, episodeId, positionSeconds, durationSeconds, completed]
        );

        // If completed, add to watch history
        if (completed) {
          await query(
            `INSERT INTO watch_history (profile_id, episode_id, watched_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT DO NOTHING`,
            [req.profileId, episodeId]
          );

          // Record streaming end
          recordStreamingEnd();
        }
      } else {
        // Update movie progress
        await query(
          `INSERT INTO viewing_progress (profile_id, video_id, position_seconds, duration_seconds, completed, last_watched_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (profile_id, video_id, episode_id)
           DO UPDATE SET position_seconds = $3, duration_seconds = $4, completed = $5, last_watched_at = NOW()`,
          [req.profileId, videoId, positionSeconds, durationSeconds, completed]
        );

        // If completed, add to watch history
        if (completed) {
          await query(
            `INSERT INTO watch_history (profile_id, video_id, watched_at)
             VALUES ($1, $2, NOW())
             ON CONFLICT DO NOTHING`,
            [req.profileId, videoId]
          );

          // Record streaming end
          recordStreamingEnd();
        }
      }

      res.json({ success: true, completed });
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
      const { videoId } = req.params;
      const { episodeId } = req.query;

      const progress = await queryOne<ViewingProgressRow & { completed: boolean }>(
        episodeId
          ? 'SELECT position_seconds, duration_seconds, completed FROM viewing_progress WHERE profile_id = $1 AND episode_id = $2'
          : 'SELECT position_seconds, duration_seconds, completed FROM viewing_progress WHERE profile_id = $1 AND video_id = $2',
        [req.profileId, episodeId || videoId]
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

/**
 * Determines if viewing is complete based on position and duration.
 * Content is considered complete when more than 95% has been watched.
 *
 * @param position - Current position in seconds
 * @param duration - Total duration in seconds
 * @returns True if viewing is complete
 */
function isProgressComplete(position: number, duration: number): boolean {
  if (duration === 0) return false;
  return (position / duration) > 0.95;
}

export default router;
