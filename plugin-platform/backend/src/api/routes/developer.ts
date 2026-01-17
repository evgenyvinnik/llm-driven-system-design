import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { query } from '../../shared/db.js';
import { cacheDelete, cacheDeletePattern } from '../../shared/cache.js';

export const developerRouter = Router();

// Configure multer for plugin bundle uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/javascript' || file.originalname.endsWith('.js')) {
      cb(null, true);
    } else {
      cb(new Error('Only JavaScript bundles are allowed'));
    }
  },
});

// Become a developer
developerRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId;

    await query(
      'UPDATE users SET is_developer = true WHERE id = $1',
      [userId]
    );

    res.json({ message: 'Developer registration successful' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register as developer' });
  }
});

// Get my plugins
developerRouter.get('/plugins', async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId;

    const result = await query<{
      id: string;
      name: string;
      description: string;
      status: string;
      install_count: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, name, description, status, install_count, created_at, updated_at
       FROM plugins
       WHERE author_id = $1
       ORDER BY updated_at DESC`,
      [userId]
    );

    res.json({ plugins: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get plugins' });
  }
});

// Create a new plugin
developerRouter.post('/plugins', async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId;
    const {
      id,
      name,
      description,
      category,
      license = 'MIT',
      repositoryUrl,
      homepageUrl,
      tags = [],
    } = req.body;

    if (!id || !name) {
      res.status(400).json({ error: 'Plugin ID and name are required' });
      return;
    }

    // Validate plugin ID format
    if (!/^[a-z0-9-]+$/.test(id)) {
      res.status(400).json({ error: 'Plugin ID must be lowercase alphanumeric with hyphens' });
      return;
    }

    // Check if plugin ID already exists
    const existing = await query('SELECT id FROM plugins WHERE id = $1', [id]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'Plugin ID already exists' });
      return;
    }

    // Create plugin
    await query(
      `INSERT INTO plugins (id, author_id, name, description, category, license, repository_url, homepage_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, userId, name, description, category, license, repositoryUrl, homepageUrl]
    );

    // Add tags
    for (const tag of tags) {
      await query(
        'INSERT INTO plugin_tags (plugin_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, tag]
      );
    }

    res.status(201).json({ message: 'Plugin created', pluginId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create plugin' });
  }
});

// Publish a new version
developerRouter.post(
  '/plugins/:pluginId/versions',
  upload.single('bundle'),
  async (req: Request, res: Response) => {
    try {
      const userId = req.session.userId;
      const { pluginId } = req.params;
      const { version, changelog, minPlatformVersion } = req.body;
      const manifestJson = req.body.manifest;

      if (!version || !manifestJson) {
        res.status(400).json({ error: 'Version and manifest are required' });
        return;
      }

      // Verify ownership
      const plugin = await query<{ author_id: string }>(
        'SELECT author_id FROM plugins WHERE id = $1',
        [pluginId]
      );

      if (plugin.rows.length === 0) {
        res.status(404).json({ error: 'Plugin not found' });
        return;
      }

      if (plugin.rows[0].author_id !== userId) {
        res.status(403).json({ error: 'Not authorized to publish this plugin' });
        return;
      }

      // Parse manifest
      let manifest: object;
      try {
        manifest = JSON.parse(manifestJson);
      } catch {
        res.status(400).json({ error: 'Invalid manifest JSON' });
        return;
      }

      // Check if version already exists
      const existingVersion = await query(
        'SELECT id FROM plugin_versions WHERE plugin_id = $1 AND version = $2',
        [pluginId, version]
      );

      if (existingVersion.rows.length > 0) {
        res.status(409).json({ error: 'Version already exists' });
        return;
      }

      // In a real system, we'd upload the bundle to S3/MinIO
      // For now, we'll store a reference to the plugins folder
      const bundleUrl = `/plugins/${pluginId}/bundle.js`;
      const fileSize = req.file?.size || 0;
      const checksum = req.file
        ? crypto.createHash('sha256').update(req.file.buffer).digest('hex')
        : null;

      // Create version
      await query(
        `INSERT INTO plugin_versions (plugin_id, version, bundle_url, manifest, changelog, min_platform_version, file_size, checksum)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [pluginId, version, bundleUrl, JSON.stringify(manifest), changelog, minPlatformVersion, fileSize, checksum]
      );

      // Update plugin status to published if it was draft
      await query(
        `UPDATE plugins SET status = 'published', updated_at = NOW() WHERE id = $1`,
        [pluginId]
      );

      // Invalidate caches
      await cacheDelete(`plugins:detail:${pluginId}`);
      await cacheDeletePattern('plugins:list:*');

      res.status(201).json({
        message: 'Version published',
        pluginId,
        version,
        bundleUrl,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to publish version' });
    }
  }
);

// Update plugin metadata
developerRouter.patch('/plugins/:pluginId', async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId;
    const { pluginId } = req.params;
    const { name, description, category, license, repositoryUrl, homepageUrl, tags } = req.body;

    // Verify ownership
    const plugin = await query<{ author_id: string }>(
      'SELECT author_id FROM plugins WHERE id = $1',
      [pluginId]
    );

    if (plugin.rows.length === 0) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }

    if (plugin.rows[0].author_id !== userId) {
      res.status(403).json({ error: 'Not authorized to update this plugin' });
      return;
    }

    // Build update query
    const updates: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    const fields = { name, description, category, license, repository_url: repositoryUrl, homepage_url: homepageUrl };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        updates.push(`${key} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    if (updates.length > 0) {
      params.push(pluginId);
      await query(
        `UPDATE plugins SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex}`,
        params
      );
    }

    // Update tags if provided
    if (tags) {
      await query('DELETE FROM plugin_tags WHERE plugin_id = $1', [pluginId]);
      for (const tag of tags) {
        await query(
          'INSERT INTO plugin_tags (plugin_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [pluginId, tag]
        );
      }
    }

    // Invalidate caches
    await cacheDelete(`plugins:detail:${pluginId}`);
    await cacheDeletePattern('plugins:list:*');

    res.json({ message: 'Plugin updated', pluginId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update plugin' });
  }
});

// Delete plugin (or unpublish)
developerRouter.delete('/plugins/:pluginId', async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId;
    const { pluginId } = req.params;

    // Verify ownership
    const plugin = await query<{ author_id: string; install_count: number }>(
      'SELECT author_id, install_count FROM plugins WHERE id = $1',
      [pluginId]
    );

    if (plugin.rows.length === 0) {
      res.status(404).json({ error: 'Plugin not found' });
      return;
    }

    if (plugin.rows[0].author_id !== userId) {
      res.status(403).json({ error: 'Not authorized to delete this plugin' });
      return;
    }

    // If plugin has installs, just unpublish it (soft delete)
    if (plugin.rows[0].install_count > 0) {
      await query(
        `UPDATE plugins SET status = 'suspended' WHERE id = $1`,
        [pluginId]
      );
      res.json({ message: 'Plugin unpublished (has existing installs)', pluginId });
    } else {
      // No installs, safe to hard delete
      await query('DELETE FROM plugins WHERE id = $1', [pluginId]);
      res.json({ message: 'Plugin deleted', pluginId });
    }

    // Invalidate caches
    await cacheDelete(`plugins:detail:${pluginId}`);
    await cacheDeletePattern('plugins:list:*');
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete plugin' });
  }
});
