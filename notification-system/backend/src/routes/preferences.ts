import { Router } from 'express';
import { preferencesService } from '../services/preferences.js';

const router = Router();

// Get current user's preferences
router.get('/', async (req, res) => {
  try {
    const preferences = await preferencesService.getPreferences(req.user.id);
    res.json(preferences);
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

// Update preferences
router.patch('/', async (req, res) => {
  try {
    const { channels, categories, quietHoursStart, quietHoursEnd, timezone } = req.body;

    // Validate quiet hours
    if (quietHoursStart !== undefined || quietHoursEnd !== undefined) {
      if (quietHoursStart !== null && (quietHoursStart < 0 || quietHoursStart >= 1440)) {
        return res.status(400).json({ error: 'quietHoursStart must be between 0 and 1439 (minutes from midnight)' });
      }
      if (quietHoursEnd !== null && (quietHoursEnd < 0 || quietHoursEnd >= 1440)) {
        return res.status(400).json({ error: 'quietHoursEnd must be between 0 and 1439 (minutes from midnight)' });
      }
    }

    const preferences = await preferencesService.updatePreferences(req.user.id, {
      channels,
      categories,
      quietHoursStart,
      quietHoursEnd,
      timezone,
    });

    res.json(preferences);
  } catch (error) {
    console.error('Update preferences error:', error);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Enable/disable a specific channel
router.patch('/channels/:channel', async (req, res) => {
  try {
    const { channel } = req.params;
    const { enabled } = req.body;

    if (!['push', 'email', 'sms'].includes(channel)) {
      return res.status(400).json({ error: 'Invalid channel' });
    }

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }

    const currentPrefs = await preferencesService.getPreferences(req.user.id);
    const updatedChannels = {
      ...currentPrefs.channels,
      [channel]: { ...currentPrefs.channels[channel], enabled },
    };

    const preferences = await preferencesService.updatePreferences(req.user.id, {
      channels: updatedChannels,
    });

    res.json(preferences);
  } catch (error) {
    console.error('Update channel preference error:', error);
    res.status(500).json({ error: 'Failed to update channel preference' });
  }
});

// Set quiet hours
router.put('/quiet-hours', async (req, res) => {
  try {
    const { start, end, enabled } = req.body;

    let quietHoursStart = null;
    let quietHoursEnd = null;

    if (enabled) {
      if (start === undefined || end === undefined) {
        return res.status(400).json({ error: 'start and end are required when enabled is true' });
      }

      // Parse time strings (e.g., "22:00") or minutes
      if (typeof start === 'string') {
        const [hours, minutes] = start.split(':').map(Number);
        quietHoursStart = hours * 60 + minutes;
      } else {
        quietHoursStart = start;
      }

      if (typeof end === 'string') {
        const [hours, minutes] = end.split(':').map(Number);
        quietHoursEnd = hours * 60 + minutes;
      } else {
        quietHoursEnd = end;
      }
    }

    const preferences = await preferencesService.updatePreferences(req.user.id, {
      quietHoursStart,
      quietHoursEnd,
    });

    res.json(preferences);
  } catch (error) {
    console.error('Set quiet hours error:', error);
    res.status(500).json({ error: 'Failed to set quiet hours' });
  }
});

export default router;
