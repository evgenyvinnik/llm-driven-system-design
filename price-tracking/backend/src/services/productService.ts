import { query, queryOne, transaction } from '../db/pool.js';
import { cacheGet, cacheSet, cacheDelete } from '../db/redis.js';
import { Product, ProductWithTracking, UserProduct, PriceHistory, DailyPriceSummary } from '../types/index.js';
import { extractDomain } from '../utils/helpers.js';
import logger from '../utils/logger.js';

export async function createProduct(url: string, userId: string, targetPrice?: number, notifyAnyDrop: boolean = false): Promise<ProductWithTracking> {
  const domain = extractDomain(url);

  return transaction(async (client) => {
    // Check if product already exists
    let product = (await client.query(
      'SELECT * FROM products WHERE url = $1',
      [url]
    ))[0] as Product | undefined;

    if (!product) {
      // Create new product
      const result = await client.query(
        `INSERT INTO products (url, domain, status, scrape_priority)
         VALUES ($1, $2, 'active', 5)
         RETURNING *`,
        [url, domain]
      );
      product = result[0] as Product;
      logger.info(`Created new product: ${product.id}`);
    }

    // Check if user already tracks this product
    const existingSubscription = (await client.query(
      'SELECT * FROM user_products WHERE user_id = $1 AND product_id = $2',
      [userId, product.id]
    ))[0] as UserProduct | undefined;

    if (existingSubscription) {
      throw new Error('You are already tracking this product');
    }

    // Create user subscription
    const subscription = (await client.query(
      `INSERT INTO user_products (user_id, product_id, target_price, notify_any_drop)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [userId, product.id, targetPrice || null, notifyAnyDrop]
    ))[0] as UserProduct;

    // Update product priority based on watcher count
    await updateProductPriority(product.id);

    // Clear cache
    await cacheDelete(`user:${userId}:products`);

    return {
      ...product,
      target_price: subscription.target_price,
      notify_any_drop: subscription.notify_any_drop,
      subscription_id: subscription.id,
    };
  });
}

export async function getProductById(productId: string): Promise<Product | null> {
  const cached = await cacheGet<Product>(`product:${productId}`);
  if (cached) return cached;

  const product = await queryOne<Product>('SELECT * FROM products WHERE id = $1', [productId]);
  if (product) {
    await cacheSet(`product:${productId}`, product, 300);
  }
  return product;
}

export async function getProductByUrl(url: string): Promise<Product | null> {
  return queryOne<Product>('SELECT * FROM products WHERE url = $1', [url]);
}

export async function getUserProducts(userId: string): Promise<ProductWithTracking[]> {
  const cached = await cacheGet<ProductWithTracking[]>(`user:${userId}:products`);
  if (cached) return cached;

  const products = await query<ProductWithTracking>(
    `SELECT p.*, up.target_price, up.notify_any_drop, up.id as subscription_id,
            (SELECT COUNT(*) FROM user_products WHERE product_id = p.id) as watcher_count
     FROM products p
     JOIN user_products up ON p.id = up.product_id
     WHERE up.user_id = $1
     ORDER BY up.created_at DESC`,
    [userId]
  );

  await cacheSet(`user:${userId}:products`, products, 60);
  return products;
}

export async function updateUserProduct(
  userId: string,
  productId: string,
  updates: { target_price?: number | null; notify_any_drop?: boolean }
): Promise<UserProduct | null> {
  const result = await query<UserProduct>(
    `UPDATE user_products
     SET target_price = COALESCE($3, target_price),
         notify_any_drop = COALESCE($4, notify_any_drop)
     WHERE user_id = $1 AND product_id = $2
     RETURNING *`,
    [userId, productId, updates.target_price, updates.notify_any_drop]
  );

  if (result.length > 0) {
    await cacheDelete(`user:${userId}:products`);
    return result[0];
  }
  return null;
}

export async function deleteUserProduct(userId: string, productId: string): Promise<boolean> {
  const result = await query(
    'DELETE FROM user_products WHERE user_id = $1 AND product_id = $2 RETURNING id',
    [userId, productId]
  );

  if (result.length > 0) {
    await cacheDelete(`user:${userId}:products`);
    await updateProductPriority(productId);
    return true;
  }
  return false;
}

export async function updateProductPrice(
  productId: string,
  price: number,
  title?: string,
  imageUrl?: string,
  availability: boolean = true
): Promise<Product | null> {
  return transaction(async (client) => {
    // Get current product data
    const current = (await client.query(
      'SELECT * FROM products WHERE id = $1',
      [productId]
    ))[0] as Product | undefined;

    if (!current) return null;

    // Insert price history
    await client.query(
      `INSERT INTO price_history (product_id, price, currency, availability)
       VALUES ($1, $2, $3, $4)`,
      [productId, price, current.currency, availability]
    );

    // Update product
    const result = await client.query(
      `UPDATE products
       SET current_price = $2,
           title = COALESCE($3, title),
           image_url = COALESCE($4, image_url),
           last_scraped = NOW(),
           status = $5,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [productId, price, title, imageUrl, availability ? 'active' : 'unavailable']
    );

    const updated = result[0] as Product;
    await cacheDelete(`product:${productId}`);

    return updated;
  });
}

export async function getPriceHistory(
  productId: string,
  startDate?: Date,
  endDate?: Date,
  limit: number = 1000
): Promise<PriceHistory[]> {
  const params: unknown[] = [productId];
  let sql = `
    SELECT * FROM price_history
    WHERE product_id = $1
  `;

  if (startDate) {
    params.push(startDate);
    sql += ` AND recorded_at >= $${params.length}`;
  }

  if (endDate) {
    params.push(endDate);
    sql += ` AND recorded_at <= $${params.length}`;
  }

  sql += ` ORDER BY recorded_at ASC LIMIT ${limit}`;

  return query<PriceHistory>(sql, params);
}

export async function getDailyPrices(
  productId: string,
  days: number = 90
): Promise<DailyPriceSummary[]> {
  const cacheKey = `product:${productId}:daily:${days}`;
  const cached = await cacheGet<DailyPriceSummary[]>(cacheKey);
  if (cached) return cached;

  const result = await query<DailyPriceSummary>(
    `SELECT
       time_bucket('1 day', recorded_at) AS day,
       MIN(price) as min_price,
       MAX(price) as max_price,
       AVG(price)::numeric(12,2) as avg_price,
       COUNT(*)::integer as data_points
     FROM price_history
     WHERE product_id = $1
       AND recorded_at >= NOW() - INTERVAL '${days} days'
     GROUP BY time_bucket('1 day', recorded_at)
     ORDER BY day ASC`,
    [productId]
  );

  await cacheSet(cacheKey, result, 3600); // Cache for 1 hour
  return result;
}

export async function getProductsToScrape(limit: number = 100): Promise<Product[]> {
  // Get products that need scraping based on their priority
  return query<Product>(
    `SELECT p.*
     FROM products p
     WHERE p.status = 'active'
       AND (
         p.last_scraped IS NULL
         OR p.last_scraped < NOW() - (
           CASE p.scrape_priority
             WHEN 1 THEN INTERVAL '30 minutes'
             WHEN 2 THEN INTERVAL '1 hour'
             WHEN 3 THEN INTERVAL '2 hours'
             WHEN 4 THEN INTERVAL '4 hours'
             WHEN 5 THEN INTERVAL '6 hours'
             WHEN 6 THEN INTERVAL '8 hours'
             WHEN 7 THEN INTERVAL '12 hours'
             WHEN 8 THEN INTERVAL '1 day'
             WHEN 9 THEN INTERVAL '2 days'
             ELSE INTERVAL '7 days'
           END
         )
       )
     ORDER BY p.scrape_priority ASC, p.last_scraped ASC NULLS FIRST
     LIMIT $1`,
    [limit]
  );
}

export async function updateProductPriority(productId: string): Promise<void> {
  // Calculate priority based on watcher count
  await query(
    `UPDATE products
     SET scrape_priority = CASE
       WHEN (SELECT COUNT(*) FROM user_products WHERE product_id = $1) > 100 THEN 1
       WHEN (SELECT COUNT(*) FROM user_products WHERE product_id = $1) > 50 THEN 2
       WHEN (SELECT COUNT(*) FROM user_products WHERE product_id = $1) > 20 THEN 3
       WHEN (SELECT COUNT(*) FROM user_products WHERE product_id = $1) > 10 THEN 4
       WHEN (SELECT COUNT(*) FROM user_products WHERE product_id = $1) > 5 THEN 5
       WHEN (SELECT COUNT(*) FROM user_products WHERE product_id = $1) > 0 THEN 6
       ELSE 10
     END,
     updated_at = NOW()
     WHERE id = $1`,
    [productId]
  );
}

export async function setProductError(productId: string, error: string): Promise<void> {
  await query(
    `UPDATE products
     SET status = 'error',
         last_scraped = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [productId]
  );
  logger.error(`Product ${productId} scrape error: ${error}`);
}

export async function getAllProducts(
  page: number = 1,
  limit: number = 50,
  status?: string
): Promise<{ products: Product[]; total: number }> {
  const offset = (page - 1) * limit;
  const params: unknown[] = [limit, offset];

  let whereClause = '';
  if (status) {
    params.push(status);
    whereClause = `WHERE status = $${params.length}`;
  }

  const products = await query<Product>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM user_products WHERE product_id = p.id) as watcher_count
     FROM products p
     ${whereClause}
     ORDER BY p.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  const countResult = await query<{ count: number }>(
    `SELECT COUNT(*)::integer as count FROM products ${whereClause}`,
    status ? [status] : []
  );

  return {
    products,
    total: countResult[0]?.count || 0,
  };
}
