const express = require('express');
const db = require('../db');
const { client: redis } = require('../db/redis');
const { isAuthenticated } = require('../middleware/auth');

// Shared observability and resilience modules
const { logger } = require('../shared/logger');
const { watchProgressUpdates } = require('../shared/metrics');
const {
  watchProgressIdempotency,
  completeWatchProgressIdempotency
} = require('../shared/idempotency');

const router = express.Router();

// Get watch progress for current profile
router.get('/progress', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const result = await db.query(`
      SELECT wp.content_id, wp.position, wp.duration, wp.completed, wp.updated_at,
             c.title, c.thumbnail_url, c.content_type, c.series_id,
             c.season_number, c.episode_number
      FROM watch_progress wp
      JOIN content c ON c.id = wp.content_id
      WHERE wp.profile_id = $1
      ORDER BY wp.updated_at DESC
    `, [req.session.profileId]);

    res.json(result.rows);
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Get progress error');
    }
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

// Get continue watching list
router.get('/continue', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const result = await db.query(`
      SELECT
        c.id,
        c.title,
        c.thumbnail_url,
        c.duration,
        c.content_type,
        c.series_id,
        c.season_number,
        c.episode_number,
        wp.position,
        (wp.position::float / c.duration) as progress_pct,
        s.title as series_title,
        s.thumbnail_url as series_thumbnail
      FROM watch_progress wp
      JOIN content c ON c.id = wp.content_id
      LEFT JOIN content s ON s.id = c.series_id
      WHERE wp.profile_id = $1
        AND wp.position > 60
        AND (wp.position::float / c.duration) < 0.9
        AND wp.completed = false
      ORDER BY wp.updated_at DESC
      LIMIT 20
    `, [req.session.profileId]);

    const items = result.rows.map(row => ({
      ...row,
      progressPercent: Math.round(row.progress_pct * 100),
      remainingMinutes: Math.round((row.duration - row.position) / 60)
    }));

    res.json(items);
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Get continue watching error');
    }
    res.status(500).json({ error: 'Failed to get continue watching' });
  }
});

/**
 * Update watch progress with idempotency support
 *
 * This endpoint handles playback position updates from clients.
 * Clients typically send updates every 10-30 seconds during playback.
 *
 * Idempotency is handled via:
 * 1. Optional Idempotency-Key header (global idempotency middleware)
 * 2. Client timestamp comparison (last-write-wins with stale detection)
 *
 * Request body:
 * - position: Current playback position in seconds
 * - duration: Total content duration in seconds
 * - clientTimestamp: (optional) Client-side timestamp for conflict resolution
 */
router.post('/progress/:contentId', isAuthenticated, watchProgressIdempotency(redis), async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { contentId } = req.params;
    const { position, duration, clientTimestamp } = req.body;

    if (typeof position !== 'number' || typeof duration !== 'number') {
      return res.status(400).json({ error: 'Position and duration are required' });
    }

    // Validate position bounds
    if (position < 0 || position > duration) {
      return res.status(400).json({ error: 'Invalid position value' });
    }

    // Check if completed (> 90%)
    const completed = position / duration > 0.9;

    // Use timestamp from body or metadata from idempotency middleware
    const effectiveTimestamp = clientTimestamp ||
      req.watchProgressMeta?.clientTimestamp ||
      Date.now();

    // Update with last-write-wins semantic using client timestamp
    const updateResult = await db.query(`
      INSERT INTO watch_progress (user_id, profile_id, content_id, position, duration, completed, client_timestamp, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (profile_id, content_id)
      DO UPDATE SET
        position = CASE
          WHEN COALESCE(watch_progress.client_timestamp, 0) < $7 THEN $4
          ELSE watch_progress.position
        END,
        duration = CASE
          WHEN COALESCE(watch_progress.client_timestamp, 0) < $7 THEN $5
          ELSE watch_progress.duration
        END,
        completed = CASE
          WHEN COALESCE(watch_progress.client_timestamp, 0) < $7 THEN $6
          ELSE watch_progress.completed
        END,
        client_timestamp = GREATEST(COALESCE(watch_progress.client_timestamp, 0), $7),
        updated_at = NOW()
      RETURNING
        position,
        completed,
        (client_timestamp = $7) as was_updated
    `, [
      req.session.userId,
      req.session.profileId,
      contentId,
      position,
      duration,
      completed,
      effectiveTimestamp
    ]);

    const wasUpdated = updateResult.rows[0]?.was_updated !== false;

    // Track metrics
    if (wasUpdated) {
      watchProgressUpdates.inc({ status: 'success' });
    } else {
      watchProgressUpdates.inc({ status: 'conflict' });
    }

    // Complete idempotency tracking
    await completeWatchProgressIdempotency(redis, req.watchProgressMeta);

    // If completed, add to history
    if (completed && wasUpdated) {
      await db.query(`
        INSERT INTO watch_history (user_id, profile_id, content_id, watched_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT DO NOTHING
      `, [req.session.userId, req.session.profileId, contentId]);
    }

    if (req.log) {
      req.log.debug({
        contentId,
        position,
        completed,
        wasUpdated,
        clientTimestamp: effectiveTimestamp
      }, 'Watch progress updated');
    }

    res.json({
      success: true,
      completed,
      wasUpdated,
      position: updateResult.rows[0]?.position
    });
  } catch (error) {
    watchProgressUpdates.inc({ status: 'error' });
    if (req.log) {
      req.log.error({ error: error.message }, 'Update progress error');
    }
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

/**
 * Batch update watch progress
 *
 * Allows clients to sync multiple progress updates at once,
 * useful for offline-to-online sync scenarios.
 *
 * Request body:
 * - updates: Array of { contentId, position, duration, clientTimestamp }
 */
router.post('/progress/batch', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { updates } = req.body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Updates array is required' });
    }

    if (updates.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 updates per batch' });
    }

    const results = [];

    for (const update of updates) {
      const { contentId, position, duration, clientTimestamp } = update;

      if (typeof position !== 'number' || typeof duration !== 'number') {
        results.push({ contentId, success: false, error: 'Invalid position/duration' });
        continue;
      }

      try {
        const completed = position / duration > 0.9;
        const effectiveTimestamp = clientTimestamp || Date.now();

        const updateResult = await db.query(`
          INSERT INTO watch_progress (user_id, profile_id, content_id, position, duration, completed, client_timestamp, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (profile_id, content_id)
          DO UPDATE SET
            position = CASE
              WHEN COALESCE(watch_progress.client_timestamp, 0) < $7 THEN $4
              ELSE watch_progress.position
            END,
            duration = CASE
              WHEN COALESCE(watch_progress.client_timestamp, 0) < $7 THEN $5
              ELSE watch_progress.duration
            END,
            completed = CASE
              WHEN COALESCE(watch_progress.client_timestamp, 0) < $7 THEN $6
              ELSE watch_progress.completed
            END,
            client_timestamp = GREATEST(COALESCE(watch_progress.client_timestamp, 0), $7),
            updated_at = NOW()
          RETURNING (client_timestamp = $7) as was_updated
        `, [
          req.session.userId,
          req.session.profileId,
          contentId,
          position,
          duration,
          completed,
          effectiveTimestamp
        ]);

        const wasUpdated = updateResult.rows[0]?.was_updated !== false;
        results.push({ contentId, success: true, wasUpdated, completed });

        if (wasUpdated) {
          watchProgressUpdates.inc({ status: 'success' });
        } else {
          watchProgressUpdates.inc({ status: 'conflict' });
        }

        // Add to history if completed
        if (completed && wasUpdated) {
          await db.query(`
            INSERT INTO watch_history (user_id, profile_id, content_id, watched_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT DO NOTHING
          `, [req.session.userId, req.session.profileId, contentId]);
        }
      } catch (updateError) {
        results.push({ contentId, success: false, error: updateError.message });
        watchProgressUpdates.inc({ status: 'error' });
      }
    }

    if (req.log) {
      const successCount = results.filter(r => r.success).length;
      req.log.info({
        total: updates.length,
        success: successCount,
        failed: updates.length - successCount
      }, 'Batch progress update completed');
    }

    res.json({ success: true, results });
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Batch update progress error');
    }
    res.status(500).json({ error: 'Failed to batch update progress' });
  }
});

// Get watch history
router.get('/history', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(`
      SELECT
        wh.id,
        wh.watched_at,
        c.id as content_id,
        c.title,
        c.thumbnail_url,
        c.content_type,
        c.duration,
        c.series_id,
        c.season_number,
        c.episode_number,
        s.title as series_title
      FROM watch_history wh
      JOIN content c ON c.id = wh.content_id
      LEFT JOIN content s ON s.id = c.series_id
      WHERE wh.profile_id = $1
      ORDER BY wh.watched_at DESC
      LIMIT $2 OFFSET $3
    `, [req.session.profileId, parseInt(limit), parseInt(offset)]);

    res.json(result.rows);
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Get history error');
    }
    res.status(500).json({ error: 'Failed to get history' });
  }
});

// Clear watch history
router.delete('/history', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    await db.query(`
      DELETE FROM watch_history WHERE profile_id = $1
    `, [req.session.profileId]);

    await db.query(`
      DELETE FROM watch_progress WHERE profile_id = $1
    `, [req.session.profileId]);

    if (req.log) {
      req.log.info({ profileId: req.session.profileId }, 'Watch history cleared');
    }

    res.json({ success: true });
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Clear history error');
    }
    res.status(500).json({ error: 'Failed to clear history' });
  }
});

// Get progress for specific content
router.get('/progress/:contentId', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { contentId } = req.params;

    const result = await db.query(`
      SELECT position, duration, completed, updated_at, client_timestamp
      FROM watch_progress
      WHERE profile_id = $1 AND content_id = $2
    `, [req.session.profileId, contentId]);

    if (result.rows.length === 0) {
      return res.json({
        position: 0,
        duration: 0,
        completed: false,
        clientTimestamp: null
      });
    }

    const row = result.rows[0];
    res.json({
      position: row.position,
      duration: row.duration,
      completed: row.completed,
      updatedAt: row.updated_at,
      clientTimestamp: row.client_timestamp
    });
  } catch (error) {
    if (req.log) {
      req.log.error({ error: error.message }, 'Get content progress error');
    }
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

module.exports = router;
