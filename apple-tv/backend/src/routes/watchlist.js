const express = require('express');
const db = require('../db');
const { isAuthenticated } = require('../middleware/auth');
const router = express.Router();

// Get watchlist (My List)
router.get('/', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const result = await db.query(`
      SELECT
        c.id,
        c.title,
        c.description,
        c.thumbnail_url,
        c.banner_url,
        c.content_type,
        c.duration,
        c.rating,
        c.genres,
        c.release_date,
        w.added_at
      FROM watchlist w
      JOIN content c ON c.id = w.content_id
      WHERE w.profile_id = $1
      ORDER BY w.added_at DESC
    `, [req.session.profileId]);

    res.json(result.rows);
  } catch (error) {
    console.error('Get watchlist error:', error);
    res.status(500).json({ error: 'Failed to get watchlist' });
  }
});

// Add to watchlist
router.post('/:contentId', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { contentId } = req.params;

    // Verify content exists
    const content = await db.query(`
      SELECT id FROM content WHERE id = $1
    `, [contentId]);

    if (content.rows.length === 0) {
      return res.status(404).json({ error: 'Content not found' });
    }

    await db.query(`
      INSERT INTO watchlist (profile_id, content_id, added_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (profile_id, content_id) DO NOTHING
    `, [req.session.profileId, contentId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Add to watchlist error:', error);
    res.status(500).json({ error: 'Failed to add to watchlist' });
  }
});

// Remove from watchlist
router.delete('/:contentId', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { contentId } = req.params;

    await db.query(`
      DELETE FROM watchlist
      WHERE profile_id = $1 AND content_id = $2
    `, [req.session.profileId, contentId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Remove from watchlist error:', error);
    res.status(500).json({ error: 'Failed to remove from watchlist' });
  }
});

// Check if content is in watchlist
router.get('/check/:contentId', isAuthenticated, async (req, res) => {
  try {
    if (!req.session.profileId) {
      return res.status(400).json({ error: 'Profile not selected' });
    }

    const { contentId } = req.params;

    const result = await db.query(`
      SELECT 1 FROM watchlist
      WHERE profile_id = $1 AND content_id = $2
    `, [req.session.profileId, contentId]);

    res.json({ inWatchlist: result.rows.length > 0 });
  } catch (error) {
    console.error('Check watchlist error:', error);
    res.status(500).json({ error: 'Failed to check watchlist' });
  }
});

module.exports = router;
