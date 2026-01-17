import { queryWithTenant } from '../services/db.js';

// List collections
export async function listCollections(req, res) {
  const { storeId } = req;

  const result = await queryWithTenant(
    storeId,
    `SELECT c.*,
            (SELECT COUNT(*) FROM collection_products cp WHERE cp.collection_id = c.id) as product_count
     FROM collections c
     ORDER BY c.created_at DESC`
  );

  res.json({ collections: result.rows });
}

// Get single collection with products
export async function getCollection(req, res) {
  const { storeId } = req;
  const { collectionId } = req.params;

  const result = await queryWithTenant(
    storeId,
    `SELECT c.*,
            (SELECT json_agg(json_build_object(
              'id', p.id,
              'handle', p.handle,
              'title', p.title,
              'images', p.images,
              'variants', (SELECT json_agg(v.*) FROM variants v WHERE v.product_id = p.id)
            ) ORDER BY cp.position) FROM collection_products cp
            JOIN products p ON p.id = cp.product_id
            WHERE cp.collection_id = c.id) as products
     FROM collections c
     WHERE c.id = $1`,
    [collectionId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Collection not found' });
  }

  res.json({ collection: result.rows[0] });
}

// Create collection
export async function createCollection(req, res) {
  const { storeId } = req;
  const { title, description, handle, image_url, productIds } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const collectionHandle = handle || title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const result = await queryWithTenant(
    storeId,
    `INSERT INTO collections (store_id, title, description, handle, image_url)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [storeId, title, description || null, collectionHandle, image_url || null]
  );

  const collection = result.rows[0];

  // Add products if provided
  if (productIds && productIds.length > 0) {
    for (let i = 0; i < productIds.length; i++) {
      await queryWithTenant(
        storeId,
        `INSERT INTO collection_products (collection_id, product_id, position)
         VALUES ($1, $2, $3)
         ON CONFLICT (collection_id, product_id) DO UPDATE SET position = $3`,
        [collection.id, productIds[i], i]
      );
    }
  }

  res.status(201).json({ collection });
}

// Update collection
export async function updateCollection(req, res) {
  const { storeId } = req;
  const { collectionId } = req.params;
  const { title, description, handle, image_url, productIds } = req.body;

  const updates = [];
  const values = [];
  let paramCount = 1;

  if (title !== undefined) {
    updates.push(`title = $${paramCount++}`);
    values.push(title);
  }
  if (description !== undefined) {
    updates.push(`description = $${paramCount++}`);
    values.push(description);
  }
  if (handle !== undefined) {
    updates.push(`handle = $${paramCount++}`);
    values.push(handle);
  }
  if (image_url !== undefined) {
    updates.push(`image_url = $${paramCount++}`);
    values.push(image_url);
  }

  if (updates.length > 0) {
    updates.push(`updated_at = NOW()`);
    values.push(collectionId);

    await queryWithTenant(
      storeId,
      `UPDATE collections SET ${updates.join(', ')} WHERE id = $${paramCount}`,
      values
    );
  }

  // Update products if provided
  if (productIds !== undefined) {
    // Remove existing
    await queryWithTenant(
      storeId,
      'DELETE FROM collection_products WHERE collection_id = $1',
      [collectionId]
    );

    // Add new
    for (let i = 0; i < productIds.length; i++) {
      await queryWithTenant(
        storeId,
        `INSERT INTO collection_products (collection_id, product_id, position)
         VALUES ($1, $2, $3)`,
        [collectionId, productIds[i], i]
      );
    }
  }

  // Fetch updated collection
  const result = await queryWithTenant(
    storeId,
    'SELECT * FROM collections WHERE id = $1',
    [collectionId]
  );

  res.json({ collection: result.rows[0] });
}

// Delete collection
export async function deleteCollection(req, res) {
  const { storeId } = req;
  const { collectionId } = req.params;

  const result = await queryWithTenant(
    storeId,
    'DELETE FROM collections WHERE id = $1 RETURNING id',
    [collectionId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Collection not found' });
  }

  res.json({ success: true });
}

// === Storefront Routes ===

// List collections (storefront)
export async function listStorefrontCollections(req, res) {
  const { storeId } = req;

  if (!storeId) {
    return res.status(404).json({ error: 'Store not found' });
  }

  const result = await queryWithTenant(
    storeId,
    `SELECT c.id, c.handle, c.title, c.description, c.image_url,
            (SELECT COUNT(*) FROM collection_products cp
             JOIN products p ON p.id = cp.product_id
             WHERE cp.collection_id = c.id AND p.status = 'active') as product_count
     FROM collections c
     ORDER BY c.title`
  );

  res.json({ collections: result.rows });
}

// Get collection by handle (storefront)
export async function getStorefrontCollection(req, res) {
  const { storeId } = req;
  const { handle } = req.params;

  if (!storeId) {
    return res.status(404).json({ error: 'Store not found' });
  }

  const result = await queryWithTenant(
    storeId,
    `SELECT c.*,
            (SELECT json_agg(json_build_object(
              'id', p.id,
              'handle', p.handle,
              'title', p.title,
              'images', p.images,
              'variants', (SELECT json_agg(json_build_object(
                'id', v.id,
                'title', v.title,
                'price', v.price,
                'compare_at_price', v.compare_at_price
              )) FROM variants v WHERE v.product_id = p.id)
            ) ORDER BY cp.position) FROM collection_products cp
            JOIN products p ON p.id = cp.product_id
            WHERE cp.collection_id = c.id AND p.status = 'active') as products
     FROM collections c
     WHERE c.handle = $1`,
    [handle]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Collection not found' });
  }

  res.json({ collection: result.rows[0] });
}
