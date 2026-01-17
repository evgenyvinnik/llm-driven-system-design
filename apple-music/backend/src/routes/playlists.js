import { Router } from 'express';
import { pool } from '../db/index.js';
import { authenticate, optionalAuth, requirePermission } from '../middleware/auth.js';
import { idempotentMiddleware, getIdempotentResponse, setIdempotentResponse } from '../shared/idempotency.js';
import { playlistOperations, libraryOperations } from '../shared/metrics.js';
import { logger, auditLog } from '../shared/logger.js';
import { playlistCreateLimiter } from '../shared/rateLimit.js';

const router = Router();

/**
 * Playlist routes with idempotency and metrics.
 *
 * Idempotency is implemented for:
 * - POST /playlists (create playlist)
 * - POST /playlists/:id/tracks (add track)
 *
 * These operations use X-Idempotency-Key header to prevent
 * duplicate creations from retried requests.
 */

// Get user's playlists
router.get('/', authenticate, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT * FROM playlists
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    const countResult = await pool.query(
      'SELECT COUNT(*) FROM playlists WHERE user_id = $1',
      [userId]
    );

    res.json({
      playlists: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Get playlists error');
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Get public playlists
router.get('/public', optionalAuth, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const result = await pool.query(
      `SELECT p.*, u.username as owner_username, u.display_name as owner_name
       FROM playlists p
       JOIN users u ON p.user_id = u.id
       WHERE p.is_public = true
       ORDER BY p.updated_at DESC
       LIMIT $1 OFFSET $2`,
      [parseInt(limit), parseInt(offset)]
    );

    res.json({ playlists: result.rows });
  } catch (error) {
    logger.error({ err: error }, 'Get public playlists error');
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Get single playlist with tracks
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const playlistResult = await pool.query(
      `SELECT p.*, u.username as owner_username, u.display_name as owner_name
       FROM playlists p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`,
      [id]
    );

    if (playlistResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const playlist = playlistResult.rows[0];

    // Check access
    if (!playlist.is_public && (!req.user || req.user.id !== playlist.user_id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const tracksResult = await pool.query(
      `SELECT pt.position, pt.added_at, t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM playlist_tracks pt
       JOIN tracks t ON pt.track_id = t.id
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE pt.playlist_id = $1
       ORDER BY pt.position`,
      [id]
    );

    res.json({
      ...playlist,
      tracks: tracksResult.rows
    });
  } catch (error) {
    logger.error({ err: error, playlistId: req.params.id }, 'Get playlist error');
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});

/**
 * Create playlist - with idempotency support.
 *
 * Client should send X-Idempotency-Key header to prevent duplicates.
 * Example: X-Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000
 */
router.post('/',
  authenticate,
  playlistCreateLimiter,
  idempotentMiddleware,
  async (req, res) => {
    try {
      const { name, description, isPublic, type } = req.body;
      const userId = req.user.id;
      const idempotencyKey = req.headers['x-idempotency-key'];

      if (!name) {
        return res.status(400).json({ error: 'Playlist name required' });
      }

      // Track metrics
      playlistOperations.inc({
        operation: 'create',
        idempotent: idempotencyKey ? 'true' : 'false'
      });

      const result = await pool.query(
        `INSERT INTO playlists (user_id, name, description, is_public, type)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [userId, name, description || '', isPublic || false, type || 'regular']
      );

      const playlist = result.rows[0];

      // Add to library
      await pool.query(
        `INSERT INTO library_items (user_id, item_type, item_id)
         VALUES ($1, 'playlist', $2)
         ON CONFLICT DO NOTHING`,
        [userId, playlist.id]
      );

      libraryOperations.inc({ operation: 'add', item_type: 'playlist' });

      logger.info({
        userId,
        playlistId: playlist.id,
        playlistName: name,
        idempotencyKey
      }, 'Playlist created');

      res.status(201).json(playlist);
    } catch (error) {
      logger.error({ err: error, userId: req.user?.id }, 'Create playlist error');
      res.status(500).json({ error: 'Failed to create playlist' });
    }
  }
);

// Update playlist
router.patch('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isPublic } = req.body;
    const userId = req.user.id;

    // Check ownership
    const checkResult = await pool.query(
      'SELECT user_id FROM playlists WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    if (checkResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (isPublic !== undefined) {
      updates.push(`is_public = $${paramCount++}`);
      values.push(isPublic);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE playlists SET ${updates.join(', ')}
       WHERE id = $${paramCount}
       RETURNING *`,
      values
    );

    playlistOperations.inc({ operation: 'update', idempotent: 'false' });

    logger.info({ userId, playlistId: id }, 'Playlist updated');

    res.json(result.rows[0]);
  } catch (error) {
    logger.error({ err: error, playlistId: req.params.id }, 'Update playlist error');
    res.status(500).json({ error: 'Failed to update playlist' });
  }
});

// Delete playlist
router.delete('/:id',
  authenticate,
  auditLog('playlist.delete'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.user.id;

      const result = await pool.query(
        'DELETE FROM playlists WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Playlist not found or access denied' });
      }

      // Remove from library
      await pool.query(
        `DELETE FROM library_items WHERE user_id = $1 AND item_type = 'playlist' AND item_id = $2`,
        [userId, id]
      );

      playlistOperations.inc({ operation: 'delete', idempotent: 'false' });
      libraryOperations.inc({ operation: 'remove', item_type: 'playlist' });

      logger.info({ userId, playlistId: id }, 'Playlist deleted');

      res.json({ message: 'Playlist deleted' });
    } catch (error) {
      logger.error({ err: error, playlistId: req.params.id }, 'Delete playlist error');
      res.status(500).json({ error: 'Failed to delete playlist' });
    }
  }
);

/**
 * Add track to playlist - with idempotency support.
 *
 * Idempotency ensures that retried requests don't add duplicate tracks.
 * Uses combination of X-Idempotency-Key + user_id for cache key.
 */
router.post('/:id/tracks',
  authenticate,
  idempotentMiddleware,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { trackId } = req.body;
      const userId = req.user.id;
      const idempotencyKey = req.headers['x-idempotency-key'];

      // Check ownership
      const checkResult = await pool.query(
        'SELECT user_id FROM playlists WHERE id = $1',
        [id]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Playlist not found' });
      }

      if (checkResult.rows[0].user_id !== userId) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Get next position
      const positionResult = await pool.query(
        'SELECT COALESCE(MAX(position), 0) + 1 as next_position FROM playlist_tracks WHERE playlist_id = $1',
        [id]
      );

      await pool.query(
        `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [id, trackId, positionResult.rows[0].next_position, userId]
      );

      playlistOperations.inc({
        operation: 'add_track',
        idempotent: idempotencyKey ? 'true' : 'false'
      });

      logger.info({
        userId,
        playlistId: id,
        trackId,
        idempotencyKey
      }, 'Track added to playlist');

      res.status(201).json({ message: 'Track added to playlist' });
    } catch (error) {
      logger.error({
        err: error,
        playlistId: req.params.id,
        trackId: req.body.trackId
      }, 'Add track to playlist error');
      res.status(500).json({ error: 'Failed to add track' });
    }
  }
);

// Remove track from playlist
router.delete('/:id/tracks/:trackId', authenticate, async (req, res) => {
  try {
    const { id, trackId } = req.params;
    const userId = req.user.id;

    // Check ownership
    const checkResult = await pool.query(
      'SELECT user_id FROM playlists WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    if (checkResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query(
      'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
      [id, trackId]
    );

    // Reorder remaining tracks
    await pool.query(
      `WITH numbered AS (
         SELECT id, ROW_NUMBER() OVER (ORDER BY position) as new_position
         FROM playlist_tracks WHERE playlist_id = $1
       )
       UPDATE playlist_tracks pt
       SET position = n.new_position
       FROM numbered n
       WHERE pt.id = n.id`,
      [id]
    );

    playlistOperations.inc({ operation: 'remove_track', idempotent: 'false' });

    logger.info({ userId, playlistId: id, trackId }, 'Track removed from playlist');

    res.json({ message: 'Track removed from playlist' });
  } catch (error) {
    logger.error({
      err: error,
      playlistId: req.params.id,
      trackId: req.params.trackId
    }, 'Remove track from playlist error');
    res.status(500).json({ error: 'Failed to remove track' });
  }
});

// Reorder playlist tracks
router.put('/:id/tracks/reorder', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { trackIds } = req.body;
    const userId = req.user.id;

    // Check ownership
    const checkResult = await pool.query(
      'SELECT user_id FROM playlists WHERE id = $1',
      [id]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    if (checkResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update positions in a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < trackIds.length; i++) {
        await client.query(
          'UPDATE playlist_tracks SET position = $1 WHERE playlist_id = $2 AND track_id = $3',
          [i + 1, id, trackIds[i]]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    playlistOperations.inc({ operation: 'reorder', idempotent: 'false' });

    logger.info({ userId, playlistId: id, trackCount: trackIds.length }, 'Playlist reordered');

    res.json({ message: 'Playlist reordered' });
  } catch (error) {
    logger.error({ err: error, playlistId: req.params.id }, 'Reorder playlist error');
    res.status(500).json({ error: 'Failed to reorder playlist' });
  }
});

export default router;
