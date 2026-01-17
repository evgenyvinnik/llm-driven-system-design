const express = require('express');
const db = require('../db');
const { isAuthenticated } = require('../middleware/auth');
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
    console.error('Get progress error:', error);
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
    console.error('Get continue watching error:', error);
    res.status(500).json({ error: 'Failed to get continue watching' });
  }
});

// Update watch progress
router.post('/progress/:contentId', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { contentId } = req.params;
    const { position, duration } = req.body;

    if (typeof position !== 'number' || typeof duration !== 'number') {
      return res.status(400).json({ error: 'Position and duration are required' });
    }

    // Check if completed (> 90%)
    const completed = position / duration > 0.9;

    await db.query(`
      INSERT INTO watch_progress (user_id, profile_id, content_id, position, duration, completed, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (profile_id, content_id)
      DO UPDATE SET
        position = $4,
        duration = $5,
        completed = $6,
        updated_at = NOW()
    `, [req.session.userId, req.session.profileId, contentId, position, duration, completed]);

    // If completed, add to history
    if (completed) {
      await db.query(`
        INSERT INTO watch_history (user_id, profile_id, content_id, watched_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT DO NOTHING
      `, [req.session.userId, req.session.profileId, contentId]);
    }

    res.json({ success: true, completed });
  } catch (error) {
    console.error('Update progress error:', error);
    res.status(500).json({ error: 'Failed to update progress' });
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
    console.error('Get history error:', error);
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

    res.json({ success: true });
  } catch (error) {
    console.error('Clear history error:', error);
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
      SELECT position, duration, completed, updated_at
      FROM watch_progress
      WHERE profile_id = $1 AND content_id = $2
    `, [req.session.profileId, contentId]);

    if (result.rows.length === 0) {
      return res.json({ position: 0, duration: 0, completed: false });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get content progress error:', error);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

module.exports = router;
