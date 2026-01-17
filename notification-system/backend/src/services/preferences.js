import { query } from '../utils/database.js';
import { redis, cacheGet, cacheSet, cacheDelete } from '../utils/redis.js';

const DEFAULT_PREFERENCES = {
  channels: {
    push: { enabled: true },
    email: { enabled: true },
    sms: { enabled: false },
  },
  categories: {},
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: 'UTC',
};

export class PreferencesService {
  async getPreferences(userId) {
    // Check cache first
    const cached = await cacheGet(`prefs:${userId}`);
    if (cached) {
      return this.normalizePreferences(cached);
    }

    // Load from database
    const result = await query(
      `SELECT * FROM notification_preferences WHERE user_id = $1`,
      [userId]
    );

    const prefs = result.rows[0];

    if (!prefs) {
      // Create default preferences
      await this.createDefaultPreferences(userId);
      return DEFAULT_PREFERENCES;
    }

    const preferences = this.normalizePreferences(prefs);

    // Cache for 5 minutes
    await cacheSet(`prefs:${userId}`, preferences, 300);

    return preferences;
  }

  async createDefaultPreferences(userId) {
    await query(
      `INSERT INTO notification_preferences (user_id, channels, categories, timezone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        userId,
        JSON.stringify(DEFAULT_PREFERENCES.channels),
        JSON.stringify(DEFAULT_PREFERENCES.categories),
        DEFAULT_PREFERENCES.timezone,
      ]
    );
  }

  async updatePreferences(userId, updates) {
    const current = await this.getPreferences(userId);

    const mergedChannels = updates.channels
      ? { ...current.channels, ...updates.channels }
      : current.channels;

    const mergedCategories = updates.categories
      ? { ...current.categories, ...updates.categories }
      : current.categories;

    await query(
      `INSERT INTO notification_preferences
         (user_id, channels, categories, quiet_hours_start, quiet_hours_end, timezone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         channels = $2,
         categories = $3,
         quiet_hours_start = $4,
         quiet_hours_end = $5,
         timezone = $6,
         updated_at = NOW()`,
      [
        userId,
        JSON.stringify(mergedChannels),
        JSON.stringify(mergedCategories),
        updates.quietHoursStart ?? current.quietHoursStart,
        updates.quietHoursEnd ?? current.quietHoursEnd,
        updates.timezone ?? current.timezone,
      ]
    );

    // Invalidate cache
    await cacheDelete(`prefs:${userId}`);

    return this.getPreferences(userId);
  }

  filterChannels(requestedChannels, preferences) {
    return requestedChannels.filter((channel) => {
      const channelPref = preferences.channels[channel];
      return channelPref?.enabled !== false;
    });
  }

  isQuietHours(preferences) {
    if (
      preferences.quietHoursStart === null ||
      preferences.quietHoursEnd === null
    ) {
      return false;
    }

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const start = preferences.quietHoursStart;
    const end = preferences.quietHoursEnd;

    if (start < end) {
      return currentMinutes >= start && currentMinutes < end;
    } else {
      // Quiet hours span midnight
      return currentMinutes >= start || currentMinutes < end;
    }
  }

  normalizePreferences(prefs) {
    return {
      channels: prefs.channels || DEFAULT_PREFERENCES.channels,
      categories: prefs.categories || DEFAULT_PREFERENCES.categories,
      quietHoursStart: prefs.quiet_hours_start,
      quietHoursEnd: prefs.quiet_hours_end,
      timezone: prefs.timezone || 'UTC',
    };
  }
}

export const preferencesService = new PreferencesService();
