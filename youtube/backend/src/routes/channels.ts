import express from 'express';
import { authenticate, optionalAuth } from '../middleware/auth.js';
import {
  getChannel,
  updateChannel,
  subscribe,
  unsubscribe,
  isSubscribed,
  getSubscriptions,
} from '../services/metadata.js';
import { getVideos } from '../services/metadata.js';

const router = express.Router();

// Get channel by ID or username
router.get('/:identifier', optionalAuth, async (req, res) => {
  try {
    const { identifier } = req.params;
    const channel = await getChannel(identifier);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Check if current user is subscribed
    let subscribed = false;
    if (req.user) {
      subscribed = await isSubscribed(req.user.id, channel.id);
    }

    res.json({
      ...channel,
      isSubscribed: subscribed,
    });
  } catch (error) {
    console.error('Get channel error:', error);
    res.status(500).json({ error: 'Failed to get channel' });
  }
});

// Get channel videos
router.get('/:identifier/videos', optionalAuth, async (req, res) => {
  try {
    const { identifier } = req.params;
    const { page, limit, orderBy, order } = req.query;

    const channel = await getChannel(identifier);

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    const result = await getVideos({
      channelId: channel.id,
      page: parseInt(page, 10) || 1,
      limit: Math.min(parseInt(limit, 10) || 20, 50),
      orderBy,
      order,
    });

    res.json(result);
  } catch (error) {
    console.error('Get channel videos error:', error);
    res.status(500).json({ error: 'Failed to get channel videos' });
  }
});

// Update own channel
router.patch('/me', authenticate, async (req, res) => {
  try {
    const { channelName, channelDescription, avatarUrl } = req.body;

    const channel = await updateChannel(req.user.id, {
      channelName,
      channelDescription,
      avatarUrl,
    });

    if (!channel) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    res.json(channel);
  } catch (error) {
    console.error('Update channel error:', error);
    res.status(500).json({ error: 'Failed to update channel' });
  }
});

// Subscribe to channel
router.post('/:channelId/subscribe', authenticate, async (req, res) => {
  try {
    const { channelId } = req.params;
    const result = await subscribe(req.user.id, channelId);
    res.json(result);
  } catch (error) {
    console.error('Subscribe error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Unsubscribe from channel
router.delete('/:channelId/subscribe', authenticate, async (req, res) => {
  try {
    const { channelId } = req.params;
    const result = await unsubscribe(req.user.id, channelId);
    res.json(result);
  } catch (error) {
    console.error('Unsubscribe error:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// Get user's subscriptions
router.get('/me/subscriptions', authenticate, async (req, res) => {
  try {
    const { page, limit } = req.query;

    const result = await getSubscriptions(
      req.user.id,
      parseInt(page, 10) || 1,
      Math.min(parseInt(limit, 10) || 20, 50)
    );

    res.json(result);
  } catch (error) {
    console.error('Get subscriptions error:', error);
    res.status(500).json({ error: 'Failed to get subscriptions' });
  }
});

export default router;
