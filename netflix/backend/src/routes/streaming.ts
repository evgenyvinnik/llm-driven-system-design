import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index.js';
import { authenticate, requireProfile } from '../middleware/auth.js';
import { getVideoStreamUrl } from '../services/storage.js';
import { STREAMING_CONFIG, MINIO_CONFIG } from '../config.js';

const router = Router();

interface VideoRow {
  id: string;
  title: string;
  type: 'movie' | 'series';
  duration_minutes: number | null;
}

interface EpisodeRow {
  id: string;
  season_id: string;
  episode_number: number;
  title: string;
  duration_minutes: number | null;
  video_key: string | null;
}

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

interface ViewingProgressRow {
  position_seconds: number;
  duration_seconds: number;
}

/**
 * GET /api/stream/:videoId/manifest
 * Get streaming manifest for a video or episode
 */
router.get('/:videoId/manifest', authenticate, requireProfile, async (req: Request, res: Response) => {
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

    res.json({
      videoId,
      episodeId: episodeId || undefined,
      durationSeconds: durationMinutes * 60,
      qualities,
      resumePosition,
    });
  } catch (error) {
    console.error('Get manifest error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/stream/:videoId/play
 * Get actual video stream URL (redirect to MinIO/S3)
 */
router.get('/:videoId/play', authenticate, async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    const { quality = '720p', episodeId } = req.query;

    // Build video key
    const contentId = episodeId || videoId;
    const videoKey = `videos/${contentId}/${quality}/video.mp4`;

    try {
      // Try to get presigned URL
      const streamUrl = await getVideoStreamUrl(videoKey);
      res.redirect(streamUrl);
    } catch {
      // If file doesn't exist, return a sample video URL for demo
      // In production, this would return 404
      res.json({
        message: 'Video file not found in storage',
        note: 'For demo purposes, upload videos to MinIO or use the sample video endpoint',
        expectedPath: videoKey,
      });
    }
  } catch (error) {
    console.error('Play video error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/stream/:videoId/progress
 * Update viewing progress
 */
router.post('/:videoId/progress', authenticate, requireProfile, async (req: Request, res: Response) => {
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
      }
    }

    res.json({ success: true, completed });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/stream/:videoId/progress
 * Get current viewing progress
 */
router.get('/:videoId/progress', authenticate, requireProfile, async (req: Request, res: Response) => {
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
    console.error('Get progress error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Helper to determine if viewing is complete (> 95%)
function isProgressComplete(position: number, duration: number): boolean {
  if (duration === 0) return false;
  return (position / duration) > 0.95;
}

export default router;
