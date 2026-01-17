const express = require('express');
const { query } = require('../services/database');

const router = express.Router();

// Get global emotes
router.get('/global', async (req, res) => {
  try {
    const result = await query(`
      SELECT id, code, image_url, tier
      FROM emotes
      WHERE is_global = TRUE
      ORDER BY code ASC
    `);

    res.json({
      emotes: result.rows.map(row => ({
        id: row.id,
        code: row.code,
        imageUrl: row.image_url,
        tier: row.tier,
        isGlobal: true
      }))
    });
  } catch (error) {
    console.error('Get global emotes error:', error);
    res.status(500).json({ error: 'Failed to get emotes' });
  }
});

// Get channel emotes
router.get('/channel/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;

    const result = await query(`
      SELECT id, code, image_url, tier
      FROM emotes
      WHERE channel_id = $1
      ORDER BY tier ASC, code ASC
    `, [channelId]);

    res.json({
      emotes: result.rows.map(row => ({
        id: row.id,
        code: row.code,
        imageUrl: row.image_url,
        tier: row.tier,
        isGlobal: false
      }))
    });
  } catch (error) {
    console.error('Get channel emotes error:', error);
    res.status(500).json({ error: 'Failed to get emotes' });
  }
});

// Get all available emotes for a user in a channel
router.get('/available/:channelId', async (req, res) => {
  try {
    const { channelId } = req.params;

    // Get global emotes
    const globalResult = await query(`
      SELECT id, code, image_url, tier, TRUE as is_global
      FROM emotes
      WHERE is_global = TRUE
    `);

    // Get channel emotes
    const channelResult = await query(`
      SELECT id, code, image_url, tier, FALSE as is_global
      FROM emotes
      WHERE channel_id = $1
    `, [channelId]);

    const allEmotes = [...globalResult.rows, ...channelResult.rows];

    res.json({
      emotes: allEmotes.map(row => ({
        id: row.id,
        code: row.code,
        imageUrl: row.image_url,
        tier: row.tier,
        isGlobal: row.is_global
      }))
    });
  } catch (error) {
    console.error('Get available emotes error:', error);
    res.status(500).json({ error: 'Failed to get emotes' });
  }
});

module.exports = router;
