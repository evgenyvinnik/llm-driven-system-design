import { query, queryOne, execute } from '../utils/db.js';
import { haversineDistance } from '../utils/geo.js';
import type { Merchant, MerchantWithDistance, MenuItem, Location } from '../types/index.js';

export async function getMerchantById(id: string): Promise<Merchant | null> {
  return queryOne<Merchant>(`SELECT * FROM merchants WHERE id = $1`, [id]);
}

export async function getMerchantsByCategory(category: string): Promise<Merchant[]> {
  return query<Merchant>(
    `SELECT * FROM merchants WHERE category = $1 AND is_open = true ORDER BY rating DESC`,
    [category]
  );
}

export async function getNearbyMerchants(
  location: Location,
  radiusKm: number = 10,
  category?: string
): Promise<MerchantWithDistance[]> {
  let sql = `SELECT * FROM merchants WHERE is_open = true`;
  const params: unknown[] = [];

  if (category) {
    params.push(category);
    sql += ` AND category = $${params.length}`;
  }

  const merchants = await query<Merchant>(sql, params);

  // Calculate distance and filter by radius
  const merchantsWithDistance = merchants
    .map((merchant) => ({
      ...merchant,
      distance: haversineDistance(location, { lat: merchant.lat, lng: merchant.lng }),
    }))
    .filter((m) => m.distance <= radiusKm);

  // Sort by distance
  return merchantsWithDistance.sort((a, b) => a.distance - b.distance);
}

export async function getMerchantMenu(merchantId: string): Promise<MenuItem[]> {
  return query<MenuItem>(
    `SELECT * FROM menu_items
     WHERE merchant_id = $1 AND is_available = true
     ORDER BY category, name`,
    [merchantId]
  );
}

export async function getMenuItem(id: string): Promise<MenuItem | null> {
  return queryOne<MenuItem>(`SELECT * FROM menu_items WHERE id = $1`, [id]);
}

export async function getMenuItemsByIds(ids: string[]): Promise<MenuItem[]> {
  return query<MenuItem>(
    `SELECT * FROM menu_items WHERE id = ANY($1)`,
    [ids]
  );
}

export async function updateMerchantOpenStatus(
  id: string,
  isOpen: boolean
): Promise<Merchant | null> {
  return queryOne<Merchant>(
    `UPDATE merchants SET is_open = $1 WHERE id = $2 RETURNING *`,
    [isOpen, id]
  );
}

export async function updateMerchantRating(id: string): Promise<void> {
  const result = await queryOne<{ avg: number }>(
    `SELECT AVG(r.rating)::DECIMAL(3,2) as avg
     FROM ratings r
     WHERE r.rated_merchant_id = $1`,
    [id]
  );

  if (result?.avg) {
    await execute(`UPDATE merchants SET rating = $1 WHERE id = $2`, [result.avg, id]);
  }
}

export async function createMerchant(
  data: Omit<Merchant, 'id' | 'created_at' | 'updated_at' | 'rating'>
): Promise<Merchant> {
  const result = await queryOne<Merchant>(
    `INSERT INTO merchants (owner_id, name, description, address, lat, lng, category, avg_prep_time_minutes, is_open, opens_at, closes_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      data.owner_id,
      data.name,
      data.description,
      data.address,
      data.lat,
      data.lng,
      data.category,
      data.avg_prep_time_minutes,
      data.is_open,
      data.opens_at,
      data.closes_at,
    ]
  );

  if (!result) {
    throw new Error('Failed to create merchant');
  }

  return result;
}

export async function createMenuItem(
  data: Omit<MenuItem, 'id' | 'created_at' | 'updated_at'>
): Promise<MenuItem> {
  const result = await queryOne<MenuItem>(
    `INSERT INTO menu_items (merchant_id, name, description, price, category, image_url, is_available)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.merchant_id,
      data.name,
      data.description,
      data.price,
      data.category,
      data.image_url,
      data.is_available,
    ]
  );

  if (!result) {
    throw new Error('Failed to create menu item');
  }

  return result;
}

export async function updateMenuItem(
  id: string,
  updates: Partial<Pick<MenuItem, 'name' | 'description' | 'price' | 'category' | 'is_available'>>
): Promise<MenuItem | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push(`description = $${paramIndex++}`);
    values.push(updates.description);
  }
  if (updates.price !== undefined) {
    fields.push(`price = $${paramIndex++}`);
    values.push(updates.price);
  }
  if (updates.category !== undefined) {
    fields.push(`category = $${paramIndex++}`);
    values.push(updates.category);
  }
  if (updates.is_available !== undefined) {
    fields.push(`is_available = $${paramIndex++}`);
    values.push(updates.is_available);
  }

  if (fields.length === 0) {
    return getMenuItem(id);
  }

  values.push(id);

  return queryOne<MenuItem>(
    `UPDATE menu_items SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );
}

export async function deleteMenuItem(id: string): Promise<boolean> {
  const count = await execute(`DELETE FROM menu_items WHERE id = $1`, [id]);
  return count > 0;
}

export async function searchMerchants(
  searchTerm: string,
  location?: Location,
  radiusKm: number = 10
): Promise<MerchantWithDistance[]> {
  const merchants = await query<Merchant>(
    `SELECT * FROM merchants
     WHERE is_open = true
     AND (name ILIKE $1 OR category ILIKE $1 OR description ILIKE $1)`,
    [`%${searchTerm}%`]
  );

  if (!location) {
    return merchants.map((m) => ({ ...m, distance: 0 }));
  }

  const merchantsWithDistance = merchants
    .map((merchant) => ({
      ...merchant,
      distance: haversineDistance(location, { lat: merchant.lat, lng: merchant.lng }),
    }))
    .filter((m) => m.distance <= radiusKm);

  return merchantsWithDistance.sort((a, b) => a.distance - b.distance);
}

export async function getCategories(): Promise<string[]> {
  const result = await query<{ category: string }>(
    `SELECT DISTINCT category FROM merchants WHERE is_open = true ORDER BY category`
  );
  return result.map((r) => r.category);
}
