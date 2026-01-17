import express from 'express';
import { getSuggestions, recordAppLaunch, recordActivity } from '../services/suggestions.js';

const router = express.Router();

// Get suggestions based on context
router.get('/', async (req, res) => {
  try {
    const suggestions = await getSuggestions({
      hour: req.query.hour ? parseInt(req.query.hour) : undefined,
      dayOfWeek: req.query.day ? parseInt(req.query.day) : undefined
    });

    res.json({ suggestions });
  } catch (error) {
    console.error('Suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

// Record app launch for pattern learning
router.post('/app-launch', async (req, res) => {
  try {
    const { bundleId } = req.body;

    if (!bundleId) {
      return res.status(400).json({ error: 'Bundle ID is required' });
    }

    await recordAppLaunch(bundleId);

    res.json({ success: true });
  } catch (error) {
    console.error('Record app launch error:', error);
    res.status(500).json({ error: 'Failed to record app launch' });
  }
});

// Record activity
router.post('/activity', async (req, res) => {
  try {
    const { type, itemId, itemName, metadata } = req.body;

    if (!type || !itemId || !itemName) {
      return res.status(400).json({ error: 'Type, itemId, and itemName are required' });
    }

    await recordActivity(type, itemId, itemName, metadata);

    res.json({ success: true });
  } catch (error) {
    console.error('Record activity error:', error);
    res.status(500).json({ error: 'Failed to record activity' });
  }
});

export default router;
