const express = require('express');
const { query } = require('../services/database');
const { getSession } = require('../services/redis');

const router = express.Router();

// Get all live channels
router.get('/', async (req, res) => {
  try {
    const { category, limit = 20, offset = 0 } = req.query;

    let sql = `
      SELECT c.id, c.name, c.title, c.is_live, c.current_viewers,
             c.follower_count, c.thumbnail_url,
             u.username, u.display_name, u.avatar_url,
             cat.name as category_name, cat.slug as category_slug
      FROM channels c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN categories cat ON c.category_id = cat.id
    `;

    const params = [];
    const conditions = [];

    if (category) {
      params.push(category);
      conditions.push(`cat.slug = $${params.length}`);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY c.is_live DESC, c.current_viewers DESC';

    params.push(parseInt(limit));
    sql += ` LIMIT $${params.length}`;

    params.push(parseInt(offset));
    sql += ` OFFSET $${params.length}`;

    const result = await query(sql, params);

    res.json({
      channels: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        title: row.title,
        isLive: row.is_live,
        viewerCount: row.current_viewers,
        followerCount: row.follower_count,
        thumbnailUrl: row.thumbnail_url,
        user: {
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url
        },
        category: row.category_name ? {
          name: row.category_name,
          slug: row.category_slug
        } : null
      }))
    });
  } catch (error) {
    console.error('Get channels error:', error);
    res.status(500).json({ error: 'Failed to get channels' });
  }
});

// Get live channels only
router.get('/live', async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const result = await query(`
      SELECT c.id, c.name, c.title, c.is_live, c.current_viewers,
             c.follower_count, c.thumbnail_url,
             u.username, u.display_name, u.avatar_url,
             cat.name as category_name, cat.slug as category_slug
      FROM channels c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE c.is_live = TRUE
      ORDER BY c.current_viewers DESC
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), parseInt(offset)]);

    res.json({
      channels: result.rows.map(row => ({
        id: row.id,
        name: row.name,
        title: row.title,
        isLive: row.is_live,
        viewerCount: row.current_viewers,
        followerCount: row.follower_count,
        thumbnailUrl: row.thumbnail_url,
        user: {
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url
        },
        category: row.category_name ? {
          name: row.category_name,
          slug: row.category_slug
        } : null
      }))
    });
  } catch (error) {
    console.error('Get live channels error:', error);
    res.status(500).json({ error: 'Failed to get live channels' });
  }
});

// Get single channel by name
router.get('/:name', async (req, res) => {
  try {
    const { name } = req.params;

    const result = await query(`
      SELECT c.id, c.name, c.title, c.description, c.is_live, c.current_viewers,
             c.follower_count, c.subscriber_count, c.thumbnail_url, c.offline_banner_url,
             c.stream_key, c.user_id, c.created_at,
             u.username, u.display_name, u.avatar_url, u.bio,
             cat.id as category_id, cat.name as category_name, cat.slug as category_slug
      FROM channels c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE c.name = $1
    `, [name]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const row = result.rows[0];

    // Check if current user follows this channel
    let isFollowing = false;
    let isSubscribed = false;

    const sessionId = req.cookies.session;
    if (sessionId) {
      const userId = await getSession(sessionId);
      if (userId) {
        const followCheck = await query(
          'SELECT 1 FROM followers WHERE user_id = $1 AND channel_id = $2',
          [userId, row.id]
        );
        isFollowing = followCheck.rows.length > 0;

        const subCheck = await query(
          'SELECT tier FROM subscriptions WHERE user_id = $1 AND channel_id = $2 AND expires_at > NOW()',
          [userId, row.id]
        );
        isSubscribed = subCheck.rows.length > 0;
      }
    }

    res.json({
      channel: {
        id: row.id,
        name: row.name,
        title: row.title,
        description: row.description,
        isLive: row.is_live,
        viewerCount: row.current_viewers,
        followerCount: row.follower_count,
        subscriberCount: row.subscriber_count,
        thumbnailUrl: row.thumbnail_url,
        offlineBannerUrl: row.offline_banner_url,
        createdAt: row.created_at,
        user: {
          id: row.user_id,
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          bio: row.bio
        },
        category: row.category_id ? {
          id: row.category_id,
          name: row.category_name,
          slug: row.category_slug
        } : null,
        isFollowing,
        isSubscribed
      }
    });
  } catch (error) {
    console.error('Get channel error:', error);
    res.status(500).json({ error: 'Failed to get channel' });
  }
});

// Follow a channel
router.post('/:name/follow', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { name } = req.params;

    const channelResult = await query('SELECT id FROM channels WHERE name = $1', [name]);
    if (channelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const channelId = channelResult.rows[0].id;

    // Check if already following
    const existing = await query(
      'SELECT 1 FROM followers WHERE user_id = $1 AND channel_id = $2',
      [userId, channelId]
    );

    if (existing.rows.length > 0) {
      return res.json({ success: true, message: 'Already following' });
    }

    await query(
      'INSERT INTO followers (user_id, channel_id) VALUES ($1, $2)',
      [userId, channelId]
    );

    await query(
      'UPDATE channels SET follower_count = follower_count + 1 WHERE id = $1',
      [channelId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Follow channel error:', error);
    res.status(500).json({ error: 'Failed to follow channel' });
  }
});

// Unfollow a channel
router.delete('/:name/follow', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { name } = req.params;

    const channelResult = await query('SELECT id FROM channels WHERE name = $1', [name]);
    if (channelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const channelId = channelResult.rows[0].id;

    const result = await query(
      'DELETE FROM followers WHERE user_id = $1 AND channel_id = $2 RETURNING id',
      [userId, channelId]
    );

    if (result.rows.length > 0) {
      await query(
        'UPDATE channels SET follower_count = GREATEST(0, follower_count - 1) WHERE id = $1',
        [channelId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Unfollow channel error:', error);
    res.status(500).json({ error: 'Failed to unfollow channel' });
  }
});

// Subscribe to a channel
router.post('/:name/subscribe', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { name } = req.params;
    const { tier = 1 } = req.body;

    const channelResult = await query('SELECT id FROM channels WHERE name = $1', [name]);
    if (channelResult.rows.length === 0) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const channelId = channelResult.rows[0].id;

    // Check if already subscribed
    const existing = await query(
      'SELECT id FROM subscriptions WHERE user_id = $1 AND channel_id = $2 AND expires_at > NOW()',
      [userId, channelId]
    );

    if (existing.rows.length > 0) {
      return res.json({ success: true, message: 'Already subscribed' });
    }

    // Create subscription (expires in 30 days)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await query(`
      INSERT INTO subscriptions (user_id, channel_id, tier, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, channel_id)
      DO UPDATE SET tier = $3, expires_at = $4, started_at = NOW()
    `, [userId, channelId, tier, expiresAt]);

    await query(
      'UPDATE channels SET subscriber_count = subscriber_count + 1 WHERE id = $1',
      [channelId]
    );

    res.json({ success: true, expiresAt });
  } catch (error) {
    console.error('Subscribe channel error:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Update channel (for owner)
router.patch('/:name', async (req, res) => {
  try {
    const sessionId = req.cookies.session;
    if (!sessionId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = await getSession(sessionId);
    if (!userId) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { name } = req.params;
    const { title, description, categoryId } = req.body;

    // Check ownership
    const channelResult = await query(
      'SELECT id FROM channels WHERE name = $1 AND user_id = $2',
      [name, userId]
    );

    if (channelResult.rows.length === 0) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (title !== undefined) {
      params.push(title);
      updates.push(`title = $${paramIndex++}`);
    }

    if (description !== undefined) {
      params.push(description);
      updates.push(`description = $${paramIndex++}`);
    }

    if (categoryId !== undefined) {
      params.push(categoryId);
      updates.push(`category_id = $${paramIndex++}`);
    }

    if (updates.length === 0) {
      return res.json({ success: true, message: 'Nothing to update' });
    }

    params.push(channelResult.rows[0].id);
    await query(`
      UPDATE channels
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${paramIndex}
    `, params);

    res.json({ success: true });
  } catch (error) {
    console.error('Update channel error:', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

module.exports = router;
