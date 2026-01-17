import { Router, Request, Response } from 'express';
import { query } from '../../shared/db.js';
import { cacheDelete } from '../../shared/cache.js';

export const userPluginsRouter = Router();

// Get user's installed plugins
userPluginsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId;
    const anonymousId = req.session.anonymousId;

    let sql: string;
    let params: unknown[];

    if (userId) {
      // Authenticated user
      sql = `
        SELECT
          up.plugin_id,
          up.version,
          up.enabled,
          up.settings,
          up.installed_at,
          p.name,
          p.description,
          p.category,
          p.icon_url,
          p.is_official,
          pv.manifest,
          pv.bundle_url
        FROM user_plugins up
        JOIN plugins p ON p.id = up.plugin_id
        JOIN plugin_versions pv ON pv.plugin_id = p.id AND pv.version = up.version
        WHERE up.user_id = $1
        ORDER BY up.installed_at DESC
      `;
      params = [userId];
    } else if (anonymousId) {
      // Anonymous user
      sql = `
        SELECT
          ai.plugin_id,
          ai.version,
          ai.enabled,
          ai.settings,
          ai.installed_at,
          p.name,
          p.description,
          p.category,
          p.icon_url,
          p.is_official,
          pv.manifest,
          pv.bundle_url
        FROM anonymous_installs ai
        JOIN plugins p ON p.id = ai.plugin_id
        JOIN plugin_versions pv ON pv.plugin_id = p.id AND pv.version = ai.version
        WHERE ai.session_id = $1
        ORDER BY ai.installed_at DESC
      `;
      params = [anonymousId];
    } else {
      res.json({ plugins: [] });
      return;
    }

    const result = await query<{
      plugin_id: string;
      version: string;
      enabled: boolean;
      settings: object;
      installed_at: Date;
      name: string;
      description: string;
      category: string;
      icon_url: string;
      is_official: boolean;
      manifest: object;
      bundle_url: string;
    }>(sql, params);

    const plugins = result.rows.map((p) => ({
      pluginId: p.plugin_id,
      version: p.version,
      enabled: p.enabled,
      settings: p.settings,
      installedAt: p.installed_at,
      name: p.name,
      description: p.description,
      category: p.category,
      iconUrl: p.icon_url,
      isOfficial: p.is_official,
      manifest: p.manifest,
      bundleUrl: p.bundle_url,
    }));

    res.json({ plugins });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get installed plugins' });
  }
});

// Install a plugin
userPluginsRouter.post('/:pluginId/install', async (req: Request, res: Response) => {
  try {
    const { pluginId } = req.params;
    const { version } = req.body;
    const userId = req.session.userId;
    const anonymousId = req.session.anonymousId;

    // Get the plugin version
    let versionQuery = 'ORDER BY published_at DESC LIMIT 1';
    const versionParams: unknown[] = [pluginId];

    if (version) {
      versionQuery = 'AND version = $2';
      versionParams.push(version);
    }

    const versionResult = await query<{ version: string; manifest: object; bundle_url: string }>(
      `SELECT version, manifest, bundle_url
       FROM plugin_versions
       WHERE plugin_id = $1 ${versionQuery}`,
      versionParams
    );

    if (versionResult.rows.length === 0) {
      res.status(404).json({ error: 'Plugin version not found' });
      return;
    }

    const pluginVersion = versionResult.rows[0];

    if (userId) {
      // Authenticated user
      await query(
        `INSERT INTO user_plugins (user_id, plugin_id, version, enabled)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (user_id, plugin_id) DO UPDATE SET
           version = EXCLUDED.version,
           enabled = true,
           updated_at = NOW()`,
        [userId, pluginId, pluginVersion.version]
      );
    } else if (anonymousId) {
      // Anonymous user
      await query(
        `INSERT INTO anonymous_installs (session_id, plugin_id, version, enabled)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (session_id, plugin_id) DO UPDATE SET
           version = EXCLUDED.version,
           enabled = true`,
        [anonymousId, pluginId, pluginVersion.version]
      );
    } else {
      res.status(400).json({ error: 'No session found' });
      return;
    }

    // Increment install count
    await query(
      'UPDATE plugins SET install_count = install_count + 1 WHERE id = $1',
      [pluginId]
    );

    // Invalidate cache
    await cacheDelete(`plugins:detail:${pluginId}`);

    res.json({
      message: 'Plugin installed',
      pluginId,
      version: pluginVersion.version,
      manifest: pluginVersion.manifest,
      bundleUrl: pluginVersion.bundle_url,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to install plugin' });
  }
});

// Uninstall a plugin
userPluginsRouter.delete('/:pluginId', async (req: Request, res: Response) => {
  try {
    const { pluginId } = req.params;
    const userId = req.session.userId;
    const anonymousId = req.session.anonymousId;

    if (userId) {
      await query(
        'DELETE FROM user_plugins WHERE user_id = $1 AND plugin_id = $2',
        [userId, pluginId]
      );
    } else if (anonymousId) {
      await query(
        'DELETE FROM anonymous_installs WHERE session_id = $1 AND plugin_id = $2',
        [anonymousId, pluginId]
      );
    } else {
      res.status(400).json({ error: 'No session found' });
      return;
    }

    res.json({ message: 'Plugin uninstalled', pluginId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to uninstall plugin' });
  }
});

// Enable/disable a plugin
userPluginsRouter.patch('/:pluginId', async (req: Request, res: Response) => {
  try {
    const { pluginId } = req.params;
    const { enabled, settings } = req.body;
    const userId = req.session.userId;
    const anonymousId = req.session.anonymousId;

    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (typeof enabled === 'boolean') {
      updates.push(`enabled = $${paramIndex}`);
      params.push(enabled);
      paramIndex++;
    }

    if (settings) {
      updates.push(`settings = $${paramIndex}`);
      params.push(JSON.stringify(settings));
      paramIndex++;
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No updates provided' });
      return;
    }

    if (userId) {
      params.push(userId, pluginId);
      await query(
        `UPDATE user_plugins SET ${updates.join(', ')}, updated_at = NOW()
         WHERE user_id = $${paramIndex} AND plugin_id = $${paramIndex + 1}`,
        params
      );
    } else if (anonymousId) {
      params.push(anonymousId, pluginId);
      await query(
        `UPDATE anonymous_installs SET ${updates.join(', ')}
         WHERE session_id = $${paramIndex} AND plugin_id = $${paramIndex + 1}`,
        params
      );
    } else {
      res.status(400).json({ error: 'No session found' });
      return;
    }

    res.json({ message: 'Plugin updated', pluginId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update plugin' });
  }
});
