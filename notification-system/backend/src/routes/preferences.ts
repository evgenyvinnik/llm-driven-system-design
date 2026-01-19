import { Router, Request, Response } from 'express';
import { preferencesService, ChannelPreference } from '../services/preferences.js';

const router: Router = Router();

interface UpdatePreferencesRequest {
  channels?: Record<string, ChannelPreference>;
  categories?: Record<string, boolean>;
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
  timezone?: string;
}

interface UpdateChannelRequest {
  enabled: boolean;
}

interface SetQuietHoursRequest {
  start?: string | number;
  end?: string | number;
  enabled: boolean;
}

// Get current user's preferences
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const preferences = await preferencesService.getPreferences(req.user!.id);
    res.json(preferences);
  } catch (error) {
    console.error('Get preferences error:', error);
    res.status(500).json({ error: 'Failed to get preferences' });
  }
});

// Update preferences
router.patch('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const { channels, categories, quietHoursStart, quietHoursEnd, timezone } = req.body as UpdatePreferencesRequest;

    // Validate quiet hours
    if (quietHoursStart !== undefined || quietHoursEnd !== undefined) {
      if (quietHoursStart !== null && quietHoursStart !== undefined && (quietHoursStart < 0 || quietHoursStart >= 1440)) {
        res.status(400).json({ error: 'quietHoursStart must be between 0 and 1439 (minutes from midnight)' });
        return;
      }
      if (quietHoursEnd !== null && quietHoursEnd !== undefined && (quietHoursEnd < 0 || quietHoursEnd >= 1440)) {
        res.status(400).json({ error: 'quietHoursEnd must be between 0 and 1439 (minutes from midnight)' });
        return;
      }
    }

    const preferences = await preferencesService.updatePreferences(req.user!.id, {
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
router.patch('/channels/:channel', async (req: Request, res: Response): Promise<void> => {
  try {
    const channel = req.params.channel as string;
    const { enabled } = req.body as UpdateChannelRequest;

    if (!['push', 'email', 'sms'].includes(channel)) {
      res.status(400).json({ error: 'Invalid channel' });
      return;
    }

    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }

    const currentPrefs = await preferencesService.getPreferences(req.user!.id);
    const updatedChannels = {
      ...currentPrefs.channels,
      [channel]: { ...currentPrefs.channels[channel], enabled },
    };

    const preferences = await preferencesService.updatePreferences(req.user!.id, {
      channels: updatedChannels,
    });

    res.json(preferences);
  } catch (error) {
    console.error('Update channel preference error:', error);
    res.status(500).json({ error: 'Failed to update channel preference' });
  }
});

// Set quiet hours
router.put('/quiet-hours', async (req: Request, res: Response): Promise<void> => {
  try {
    const { start, end, enabled } = req.body as SetQuietHoursRequest;

    let quietHoursStart: number | null = null;
    let quietHoursEnd: number | null = null;

    if (enabled) {
      if (start === undefined || end === undefined) {
        res.status(400).json({ error: 'start and end are required when enabled is true' });
        return;
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

    const preferences = await preferencesService.updatePreferences(req.user!.id, {
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
