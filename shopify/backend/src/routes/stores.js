import { query, queryWithTenant } from '../services/db.js';
import { getDomainMapping, setDomainMapping } from '../services/redis.js';

// Resolve store from subdomain or custom domain
export async function resolveStore(req, res, next) {
  const host = req.get('host');
  const subdomain = req.query.subdomain || req.headers['x-store-subdomain'];

  let storeId = null;

  // Check for subdomain parameter (for local development)
  if (subdomain) {
    const result = await query(
      'SELECT id FROM stores WHERE subdomain = $1 AND status = $2',
      [subdomain, 'active']
    );
    if (result.rows.length > 0) {
      storeId = result.rows[0].id;
    }
  } else {
    // Try to resolve from custom domain cache first
    storeId = await getDomainMapping(host);

    if (!storeId) {
      // Check if it's a subdomain pattern (e.g., demo.shopify.local)
      const subdomainMatch = host.match(/^([^.]+)\./);
      if (subdomainMatch) {
        const subdomain = subdomainMatch[1];
        const result = await query(
          'SELECT id FROM stores WHERE subdomain = $1 AND status = $2',
          [subdomain, 'active']
        );
        if (result.rows.length > 0) {
          storeId = result.rows[0].id;
          await setDomainMapping(host, storeId);
        }
      }

      // Check custom domains
      if (!storeId) {
        const result = await query(
          'SELECT store_id FROM custom_domains WHERE domain = $1 AND verified = true',
          [host]
        );
        if (result.rows.length > 0) {
          storeId = result.rows[0].store_id;
          await setDomainMapping(host, storeId);
        }
      }
    }
  }

  req.storeId = storeId;
  next();
}

// Require store context to be resolved
export function requireStore(req, res, next) {
  if (!req.storeId) {
    return res.status(404).json({ error: 'Store not found' });
  }
  next();
}

// Get store details
export async function getStore(req, res) {
  const { storeId } = req.params;

  const result = await query(
    `SELECT id, name, subdomain, custom_domain, description, logo_url,
            currency, theme, settings, status, created_at
     FROM stores WHERE id = $1`,
    [storeId]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Store not found' });
  }

  res.json({ store: result.rows[0] });
}

// Get store by subdomain (for storefront)
export async function getStoreBySubdomain(req, res) {
  const { subdomain } = req.params;

  const result = await query(
    `SELECT id, name, subdomain, description, logo_url, currency, theme, settings
     FROM stores WHERE subdomain = $1 AND status = $2`,
    [subdomain, 'active']
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Store not found' });
  }

  res.json({ store: result.rows[0] });
}

// List stores for authenticated user
export async function listStores(req, res) {
  const userId = req.user.id;

  const result = await query(
    `SELECT id, name, subdomain, custom_domain, logo_url, status, created_at
     FROM stores WHERE owner_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );

  res.json({ stores: result.rows });
}

// Create new store
export async function createStore(req, res) {
  const { name, subdomain, description } = req.body;
  const userId = req.user.id;

  if (!name || !subdomain) {
    return res.status(400).json({ error: 'Name and subdomain required' });
  }

  // Validate subdomain format
  if (!/^[a-z0-9-]+$/.test(subdomain)) {
    return res.status(400).json({
      error: 'Subdomain must contain only lowercase letters, numbers, and hyphens'
    });
  }

  // Check subdomain availability
  const existing = await query('SELECT id FROM stores WHERE subdomain = $1', [subdomain]);
  if (existing.rows.length > 0) {
    return res.status(400).json({ error: 'Subdomain already taken' });
  }

  const result = await query(
    `INSERT INTO stores (owner_id, name, subdomain, description)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, subdomain, description, currency, theme, settings, status, created_at`,
    [userId, name, subdomain, description || null]
  );

  res.status(201).json({ store: result.rows[0] });
}

// Update store
export async function updateStore(req, res) {
  const { storeId } = req;
  const { name, description, logo_url, currency, theme, settings } = req.body;

  const updates = [];
  const values = [];
  let paramCount = 1;

  if (name !== undefined) {
    updates.push(`name = $${paramCount++}`);
    values.push(name);
  }
  if (description !== undefined) {
    updates.push(`description = $${paramCount++}`);
    values.push(description);
  }
  if (logo_url !== undefined) {
    updates.push(`logo_url = $${paramCount++}`);
    values.push(logo_url);
  }
  if (currency !== undefined) {
    updates.push(`currency = $${paramCount++}`);
    values.push(currency);
  }
  if (theme !== undefined) {
    updates.push(`theme = $${paramCount++}`);
    values.push(JSON.stringify(theme));
  }
  if (settings !== undefined) {
    updates.push(`settings = $${paramCount++}`);
    values.push(JSON.stringify(settings));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push(`updated_at = NOW()`);
  values.push(storeId);

  const result = await query(
    `UPDATE stores SET ${updates.join(', ')} WHERE id = $${paramCount}
     RETURNING id, name, subdomain, description, logo_url, currency, theme, settings, status`,
    values
  );

  res.json({ store: result.rows[0] });
}

// Get store analytics
export async function getStoreAnalytics(req, res) {
  const { storeId } = req;

  // Get order stats
  const orderStats = await queryWithTenant(
    storeId,
    `SELECT
       COUNT(*) as total_orders,
       COALESCE(SUM(total), 0) as total_revenue,
       COUNT(CASE WHEN payment_status = 'paid' THEN 1 END) as paid_orders,
       COUNT(CASE WHEN fulfillment_status = 'unfulfilled' THEN 1 END) as unfulfilled_orders
     FROM orders`
  );

  // Get product stats
  const productStats = await queryWithTenant(
    storeId,
    `SELECT COUNT(*) as total_products FROM products WHERE status = 'active'`
  );

  // Get customer stats
  const customerStats = await queryWithTenant(
    storeId,
    `SELECT COUNT(*) as total_customers FROM customers`
  );

  // Get recent orders
  const recentOrders = await queryWithTenant(
    storeId,
    `SELECT id, order_number, customer_email, total, payment_status, fulfillment_status, created_at
     FROM orders ORDER BY created_at DESC LIMIT 5`
  );

  res.json({
    analytics: {
      orders: {
        total: parseInt(orderStats.rows[0].total_orders),
        revenue: parseFloat(orderStats.rows[0].total_revenue),
        paid: parseInt(orderStats.rows[0].paid_orders),
        unfulfilled: parseInt(orderStats.rows[0].unfulfilled_orders),
      },
      products: {
        total: parseInt(productStats.rows[0].total_products),
      },
      customers: {
        total: parseInt(customerStats.rows[0].total_customers),
      },
      recentOrders: recentOrders.rows,
    },
  });
}
