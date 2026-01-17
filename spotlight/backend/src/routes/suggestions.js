import express from 'express';
import { getSuggestions, recordAppLaunch, recordActivity } from '../services/suggestions.js';
import { suggestionsRateLimiter } from '../shared/rateLimiter.js';
import { suggestionsLogger } from '../shared/logger.js';

const router = express.Router();

// Apply rate limiting to suggestions routes
router.use(suggestionsRateLimiter);

// Get suggestions based on context
router.get('/', async (req, res) => {
  const requestId = req.requestId;

  try {
    const suggestions = await getSuggestions({
      hour: req.query.hour ? parseInt(req.query.hour) : undefined,
      dayOfWeek: req.query.day ? parseInt(req.query.day) : undefined
    });

    suggestionsLogger.info({
      requestId,
      suggestionCount: suggestions.length,
      hour: req.query.hour,
      dayOfWeek: req.query.day
    }, 'Suggestions retrieved');

    res.json({ suggestions });
  } catch (error) {
    suggestionsLogger.error({
      error: error.message,
      requestId
    }, 'Suggestions error');
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

// Record app launch for pattern learning
router.post('/app-launch', async (req, res) => {
  const requestId = req.requestId;

  try {
    const { bundleId } = req.body;

    if (!bundleId) {
      return res.status(400).json({ error: 'Bundle ID is required' });
    }

    await recordAppLaunch(bundleId);

    suggestionsLogger.info({
      requestId,
      bundleId
    }, 'App launch recorded');

    res.json({ success: true });
  } catch (error) {
    suggestionsLogger.error({
      error: error.message,
      requestId
    }, 'Record app launch error');
    res.status(500).json({ error: 'Failed to record app launch' });
  }
});

// Record activity
router.post('/activity', async (req, res) => {
  const requestId = req.requestId;

  try {
    const { type, itemId, itemName, metadata } = req.body;

    if (!type || !itemId || !itemName) {
      return res.status(400).json({ error: 'Type, itemId, and itemName are required' });
    }

    await recordActivity(type, itemId, itemName, metadata);

    suggestionsLogger.info({
      requestId,
      type,
      itemId,
      itemName
    }, 'Activity recorded');

    res.json({ success: true });
  } catch (error) {
    suggestionsLogger.error({
      error: error.message,
      requestId
    }, 'Record activity error');
    res.status(500).json({ error: 'Failed to record activity' });
  }
});

export default router;
