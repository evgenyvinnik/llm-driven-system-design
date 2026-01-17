import { Router } from 'express';
import { pool } from '../db/index.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Get user library
router.get('/', authenticate, async (req, res) => {
  try {
    const { type, limit = 50, offset = 0 } = req.query;
    const userId = req.user.id;

    let query;
    let params = [userId, parseInt(limit), parseInt(offset)];

    if (type === 'tracks') {
      query = `
        SELECT li.added_at, t.*, a.name as artist_name, al.title as album_title, al.artwork_url
        FROM library_items li
        JOIN tracks t ON li.item_id = t.id
        JOIN artists a ON t.artist_id = a.id
        JOIN albums al ON t.album_id = al.id
        WHERE li.user_id = $1 AND li.item_type = 'track'
        ORDER BY li.added_at DESC
        LIMIT $2 OFFSET $3
      `;
    } else if (type === 'albums') {
      query = `
        SELECT li.added_at, al.*, a.name as artist_name
        FROM library_items li
        JOIN albums al ON li.item_id = al.id
        JOIN artists a ON al.artist_id = a.id
        WHERE li.user_id = $1 AND li.item_type = 'album'
        ORDER BY li.added_at DESC
        LIMIT $2 OFFSET $3
      `;
    } else if (type === 'artists') {
      query = `
        SELECT li.added_at, ar.*
        FROM library_items li
        JOIN artists ar ON li.item_id = ar.id
        WHERE li.user_id = $1 AND li.item_type = 'artist'
        ORDER BY li.added_at DESC
        LIMIT $2 OFFSET $3
      `;
    } else {
      // Get all types summary
      const [tracks, albums, artists] = await Promise.all([
        pool.query(
          `SELECT li.added_at, t.*, a.name as artist_name, al.title as album_title, al.artwork_url
           FROM library_items li
           JOIN tracks t ON li.item_id = t.id
           JOIN artists a ON t.artist_id = a.id
           JOIN albums al ON t.album_id = al.id
           WHERE li.user_id = $1 AND li.item_type = 'track'
           ORDER BY li.added_at DESC
           LIMIT 20`,
          [userId]
        ),
        pool.query(
          `SELECT li.added_at, al.*, a.name as artist_name
           FROM library_items li
           JOIN albums al ON li.item_id = al.id
           JOIN artists a ON al.artist_id = a.id
           WHERE li.user_id = $1 AND li.item_type = 'album'
           ORDER BY li.added_at DESC
           LIMIT 20`,
          [userId]
        ),
        pool.query(
          `SELECT li.added_at, ar.*
           FROM library_items li
           JOIN artists ar ON li.item_id = ar.id
           WHERE li.user_id = $1 AND li.item_type = 'artist'
           ORDER BY li.added_at DESC
           LIMIT 20`,
          [userId]
        )
      ]);

      // Get counts
      const counts = await pool.query(
        `SELECT item_type, COUNT(*) as count
         FROM library_items
         WHERE user_id = $1
         GROUP BY item_type`,
        [userId]
      );

      const countMap = {};
      counts.rows.forEach(row => {
        countMap[row.item_type] = parseInt(row.count);
      });

      return res.json({
        tracks: tracks.rows,
        albums: albums.rows,
        artists: artists.rows,
        counts: {
          tracks: countMap.track || 0,
          albums: countMap.album || 0,
          artists: countMap.artist || 0
        }
      });
    }

    const result = await pool.query(query, params);

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM library_items WHERE user_id = $1 AND item_type = $2`,
      [userId, type.slice(0, -1)] // Remove 's' from type
    );

    res.json({
      items: result.rows,
      total: parseInt(countResult.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    console.error('Get library error:', error);
    res.status(500).json({ error: 'Failed to fetch library' });
  }
});

// Add item to library
router.post('/', authenticate, async (req, res) => {
  try {
    const { itemType, itemId } = req.body;
    const userId = req.user.id;

    if (!itemType || !itemId) {
      return res.status(400).json({ error: 'Item type and ID required' });
    }

    if (!['track', 'album', 'artist', 'playlist'].includes(itemType)) {
      return res.status(400).json({ error: 'Invalid item type' });
    }

    // Add to library
    await pool.query(
      `INSERT INTO library_items (user_id, item_type, item_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [userId, itemType, itemId]
    );

    // Record change for sync
    await pool.query(
      `INSERT INTO library_changes (user_id, change_type, item_type, item_id)
       VALUES ($1, 'add', $2, $3)`,
      [userId, itemType, itemId]
    );

    res.status(201).json({ message: 'Added to library' });
  } catch (error) {
    console.error('Add to library error:', error);
    res.status(500).json({ error: 'Failed to add to library' });
  }
});

// Remove item from library
router.delete('/:itemType/:itemId', authenticate, async (req, res) => {
  try {
    const { itemType, itemId } = req.params;
    const userId = req.user.id;

    await pool.query(
      `DELETE FROM library_items
       WHERE user_id = $1 AND item_type = $2 AND item_id = $3`,
      [userId, itemType, itemId]
    );

    // Record change for sync
    await pool.query(
      `INSERT INTO library_changes (user_id, change_type, item_type, item_id)
       VALUES ($1, 'remove', $2, $3)`,
      [userId, itemType, itemId]
    );

    res.json({ message: 'Removed from library' });
  } catch (error) {
    console.error('Remove from library error:', error);
    res.status(500).json({ error: 'Failed to remove from library' });
  }
});

// Check if item is in library
router.get('/check/:itemType/:itemId', authenticate, async (req, res) => {
  try {
    const { itemType, itemId } = req.params;
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT 1 FROM library_items
       WHERE user_id = $1 AND item_type = $2 AND item_id = $3`,
      [userId, itemType, itemId]
    );

    res.json({ inLibrary: result.rows.length > 0 });
  } catch (error) {
    console.error('Check library error:', error);
    res.status(500).json({ error: 'Failed to check library' });
  }
});

// Sync library (get changes since last sync)
router.get('/sync', authenticate, async (req, res) => {
  try {
    const { lastSyncToken } = req.query;
    const userId = req.user.id;

    const changes = await pool.query(
      `SELECT * FROM library_changes
       WHERE user_id = $1 AND sync_token > $2
       ORDER BY sync_token ASC`,
      [userId, parseInt(lastSyncToken) || 0]
    );

    // Get current sync token
    const tokenResult = await pool.query(
      `SELECT COALESCE(MAX(sync_token), 0) as current_token
       FROM library_changes WHERE user_id = $1`,
      [userId]
    );

    res.json({
      changes: changes.rows.map(c => ({
        type: c.change_type,
        itemType: c.item_type,
        itemId: c.item_id,
        timestamp: c.created_at
      })),
      syncToken: parseInt(tokenResult.rows[0].current_token)
    });
  } catch (error) {
    console.error('Sync library error:', error);
    res.status(500).json({ error: 'Failed to sync library' });
  }
});

// Record listening history
router.post('/history', authenticate, async (req, res) => {
  try {
    const { trackId, durationPlayedMs, contextType, contextId, completed } = req.body;
    const userId = req.user.id;

    await pool.query(
      `INSERT INTO listening_history
       (user_id, track_id, duration_played_ms, context_type, context_id, completed)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, trackId, durationPlayedMs, contextType, contextId, completed || false]
    );

    // Update track play count if completed
    if (completed) {
      await pool.query(
        'UPDATE tracks SET play_count = play_count + 1 WHERE id = $1',
        [trackId]
      );

      // Update genre preferences
      const genresResult = await pool.query(
        'SELECT genre FROM track_genres WHERE track_id = $1',
        [trackId]
      );

      for (const { genre } of genresResult.rows) {
        await pool.query(
          `INSERT INTO user_genre_preferences (user_id, genre, score, updated_at)
           VALUES ($1, $2, 1, NOW())
           ON CONFLICT (user_id, genre) DO UPDATE SET
             score = user_genre_preferences.score + 1,
             updated_at = NOW()`,
          [userId, genre]
        );
      }
    }

    res.status(201).json({ message: 'History recorded' });
  } catch (error) {
    console.error('Record history error:', error);
    res.status(500).json({ error: 'Failed to record history' });
  }
});

// Get listening history
router.get('/history', authenticate, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT lh.*, t.title, t.duration_ms, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM listening_history lh
       JOIN tracks t ON lh.track_id = t.id
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE lh.user_id = $1
       ORDER BY lh.played_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, parseInt(limit), parseInt(offset)]
    );

    res.json({ history: result.rows });
  } catch (error) {
    console.error('Get history error:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get recently played
router.get('/recently-played', authenticate, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const userId = req.user.id;

    const result = await pool.query(
      `SELECT DISTINCT ON (t.id) lh.played_at, t.*, a.name as artist_name, al.title as album_title, al.artwork_url
       FROM listening_history lh
       JOIN tracks t ON lh.track_id = t.id
       JOIN artists a ON t.artist_id = a.id
       JOIN albums al ON t.album_id = al.id
       WHERE lh.user_id = $1
       ORDER BY t.id, lh.played_at DESC
       LIMIT $2`,
      [userId, parseInt(limit)]
    );

    // Re-sort by played_at after DISTINCT ON
    result.rows.sort((a, b) => new Date(b.played_at) - new Date(a.played_at));

    res.json({ tracks: result.rows });
  } catch (error) {
    console.error('Get recently played error:', error);
    res.status(500).json({ error: 'Failed to fetch recently played' });
  }
});

export default router;
