import express from 'express';
import { pool } from '../index.js';
import { indexDocument, deleteDocument } from '../services/elasticsearch.js';

const router = express.Router();

// Index a file
router.post('/files', async (req, res) => {
  try {
    const { path, name, content, type = 'file', size, modified_at, metadata = {} } = req.body;

    if (!path || !name) {
      return res.status(400).json({ error: 'Path and name are required' });
    }

    // Store in PostgreSQL
    await pool.query(`
      INSERT INTO indexed_files (path, name, type, size, modified_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (path) DO UPDATE SET
        name = $2, type = $3, size = $4, modified_at = $5, metadata = $6, indexed_at = NOW()
    `, [path, name, type, size, modified_at, JSON.stringify(metadata)]);

    // Index in Elasticsearch
    await indexDocument('files', path, {
      path,
      name,
      content: content || '',
      type,
      size,
      modified_at,
      indexed_at: new Date().toISOString(),
      metadata
    });

    res.json({ success: true, path });
  } catch (error) {
    console.error('Index file error:', error);
    res.status(500).json({ error: 'Failed to index file' });
  }
});

// Delete a file from index
router.delete('/files/:path(*)', async (req, res) => {
  try {
    const { path } = req.params;

    // Remove from PostgreSQL
    await pool.query('DELETE FROM indexed_files WHERE path = $1', [path]);

    // Remove from Elasticsearch
    await deleteDocument('files', path);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete file error:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Index an application
router.post('/apps', async (req, res) => {
  try {
    const { bundle_id, name, path, category } = req.body;

    if (!bundle_id || !name) {
      return res.status(400).json({ error: 'Bundle ID and name are required' });
    }

    // Store in PostgreSQL
    const result = await pool.query(`
      INSERT INTO applications (bundle_id, name, path, category)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (bundle_id) DO UPDATE SET
        name = $2, path = $3, category = $4
      RETURNING id
    `, [bundle_id, name, path, category]);

    // Index in Elasticsearch
    await indexDocument('apps', bundle_id, {
      bundle_id,
      name,
      path,
      category,
      usage_count: 0,
      last_used: null
    });

    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Index app error:', error);
    res.status(500).json({ error: 'Failed to index app' });
  }
});

// Index a contact
router.post('/contacts', async (req, res) => {
  try {
    const { name, email, phone, company, notes } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Store in PostgreSQL
    const result = await pool.query(`
      INSERT INTO contacts (name, email, phone, company, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [name, email, phone, company, notes]);

    const id = result.rows[0].id;

    // Index in Elasticsearch
    await indexDocument('contacts', id.toString(), {
      name,
      email,
      phone,
      company,
      notes
    });

    res.json({ success: true, id });
  } catch (error) {
    console.error('Index contact error:', error);
    res.status(500).json({ error: 'Failed to index contact' });
  }
});

// Index a web item (bookmark/history)
router.post('/web', async (req, res) => {
  try {
    const { url, title, description, favicon_url } = req.body;

    if (!url || !title) {
      return res.status(400).json({ error: 'URL and title are required' });
    }

    // Store in PostgreSQL
    const result = await pool.query(`
      INSERT INTO web_items (url, title, description, favicon_url)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (url) DO UPDATE SET
        title = $2, description = $3, favicon_url = $4,
        visited_count = web_items.visited_count + 1,
        last_visited = NOW()
      RETURNING id, visited_count
    `, [url, title, description, favicon_url]);

    // Index in Elasticsearch
    await indexDocument('web', url, {
      url,
      title,
      description,
      visited_count: result.rows[0].visited_count,
      last_visited: new Date().toISOString()
    });

    res.json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error('Index web error:', error);
    res.status(500).json({ error: 'Failed to index web item' });
  }
});

// Bulk index files
router.post('/bulk/files', async (req, res) => {
  try {
    const { files } = req.body;

    if (!Array.isArray(files)) {
      return res.status(400).json({ error: 'Files array is required' });
    }

    let indexed = 0;
    let failed = 0;

    for (const file of files) {
      try {
        await pool.query(`
          INSERT INTO indexed_files (path, name, type, size, modified_at, metadata)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (path) DO UPDATE SET
            name = $2, type = $3, size = $4, modified_at = $5, metadata = $6, indexed_at = NOW()
        `, [file.path, file.name, file.type || 'file', file.size, file.modified_at, JSON.stringify(file.metadata || {})]);

        await indexDocument('files', file.path, {
          path: file.path,
          name: file.name,
          content: file.content || '',
          type: file.type || 'file',
          size: file.size,
          modified_at: file.modified_at,
          indexed_at: new Date().toISOString(),
          metadata: file.metadata || {}
        });

        indexed++;
      } catch {
        failed++;
      }
    }

    res.json({ success: true, indexed, failed });
  } catch (error) {
    console.error('Bulk index error:', error);
    res.status(500).json({ error: 'Bulk indexing failed' });
  }
});

export default router;
