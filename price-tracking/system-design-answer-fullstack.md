# Price Tracking Service - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design a price tracking service similar to CamelCamelCamel or Honey. This system monitors product prices across e-commerce sites, stores historical data, and alerts users when prices drop. The fullstack challenge is building a cohesive system where the scraping backend, time-series storage, and interactive frontend work together seamlessly.

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Product Tracking**: Users add products by URL
- **Price Scraping**: Periodic automated price extraction
- **Historical Charts**: Interactive price history visualization
- **Price Alerts**: Notifications when price drops below threshold
- **Admin Dashboard**: Manage scrapers, view system health

### Non-Functional Requirements
- **Freshness**: Popular products updated hourly
- **Scalability**: Support millions of tracked products
- **Reliability**: Graceful handling of site changes
- **Latency**: Dashboard loads under 2 seconds

### Scale Requirements
- 500,000 DAU, 10 million products
- 1,000 products/second scraping rate
- ~35 TB/year time-series storage

## High-Level Architecture (5 minutes)

```
┌────────────────────────────────────────────────────────────────────────┐
│                         React Frontend                                  │
│   Dashboard  │  Price Charts  │  Alert Manager  │  Admin Panel         │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ REST API
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         Express Backend                                 │
│   Auth  │  Products  │  Alerts  │  Admin  │  Price History             │
└────────────────────────────────────────────────────────────────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
   ┌─────────┐           ┌─────────┐            ┌─────────┐
   │PostgreSQL│          │TimescaleDB│          │  Redis  │
   │(Metadata)│          │ (Prices) │          │ (Cache) │
   └─────────┘           └─────────┘            └─────────┘
                               ▲
                               │
┌────────────────────────────────────────────────────────────────────────┐
│                        RabbitMQ Job Queue                               │
│   scrape.amazon  │  scrape.walmart  │  scrape.ebay  │  alerts.send     │
└────────────────────────────────────────────────────────────────────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
       ┌───────────┐    ┌───────────┐    ┌───────────┐
       │  Scraper  │    │  Scraper  │    │   Alert   │
       │  Worker   │    │  Worker   │    │  Worker   │
       └───────────┘    └───────────┘    └───────────┘
```

## Deep Dive 1: End-to-End Add Product Flow (8 minutes)

### Complete Request Flow

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Frontend   │      │   Backend    │      │  PostgreSQL  │      │   RabbitMQ   │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                     │                     │
       │  POST /api/products │                     │                     │
       │  { url }            │                     │                     │
       │─────────────────────▶                     │                     │
       │                     │                     │                     │
       │                     │  Validate URL       │                     │
       │                     │  Extract domain     │                     │
       │                     │                     │                     │
       │                     │  INSERT product     │                     │
       │                     │─────────────────────▶                     │
       │                     │                     │                     │
       │                     │  product record     │                     │
       │                     │◀─────────────────────                     │
       │                     │                     │                     │
       │                     │  Publish scrape job │                     │
       │                     │─────────────────────────────────────────▶│
       │                     │                     │                     │
       │  { product }        │                     │                     │
       │◀─────────────────────                     │                     │
       │                     │                     │                     │
       │  Add to UI state    │                     │                     │
       │  (optimistic)       │                     │                     │
```

### Backend API Handler

```typescript
// backend/src/api/routes/products.ts
import { Router } from 'express';
import { pool } from '../../shared/db.js';
import { rabbitMQ } from '../../shared/queue.js';
import { z } from 'zod';

const router = Router();

const SUPPORTED_DOMAINS = ['amazon.com', 'walmart.com', 'bestbuy.com', 'target.com', 'ebay.com'];

const addProductSchema = z.object({
  url: z.string().url().refine((url) => {
    const domain = new URL(url).hostname.replace('www.', '');
    return SUPPORTED_DOMAINS.some((d) => domain.includes(d));
  }, 'Unsupported retailer'),
});

router.post('/', async (req, res) => {
  const userId = req.session.userId;

  // 1. Validate input
  const parsed = addProductSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { url } = parsed.data;
  const domain = new URL(url).hostname.replace('www.', '');

  try {
    // 2. Check if product already exists (for any user)
    let product = await pool.query(
      'SELECT * FROM products WHERE url = $1',
      [url]
    );

    if (product.rows.length === 0) {
      // 3. Create new product record
      product = await pool.query(`
        INSERT INTO products (url, domain, status)
        VALUES ($1, $2, 'pending')
        RETURNING *
      `, [url, domain]);

      // 4. Enqueue initial scrape job
      await rabbitMQ.publish(`scrape.${domain.split('.')[0]}`, {
        productId: product.rows[0].id,
        url,
        priority: 1, // High priority for new products
      });
    }

    // 5. Link product to user
    await pool.query(`
      INSERT INTO user_products (user_id, product_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, product_id) DO NOTHING
    `, [userId, product.rows[0].id]);

    res.status(201).json(product.rows[0]);
  } catch (error) {
    console.error('Add product error:', error);
    res.status(500).json({ error: 'Failed to add product' });
  }
});

export default router;
```

### Frontend Integration

```typescript
// frontend/src/services/api.ts
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

export const api = {
  async post<T>(path: string, data: unknown): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Request failed');
    }

    return response.json();
  },
  // ... other methods
};

// frontend/src/stores/priceStore.ts
export const useStore = create<PriceStore>()((set, get) => ({
  products: [],

  addProduct: async (url: string) => {
    // Optimistic UI - add placeholder
    const tempId = `temp-${Date.now()}`;
    const domain = new URL(url).hostname.replace('www.', '');

    set((state) => ({
      products: [
        {
          id: tempId,
          url,
          domain,
          title: 'Loading...',
          currentPrice: null,
          status: 'pending',
          isLoading: true,
        },
        ...state.products,
      ],
    }));

    try {
      const product = await api.post<Product>('/products', { url });

      // Replace temp with real product
      set((state) => ({
        products: state.products.map((p) =>
          p.id === tempId ? { ...product, isLoading: false } : p
        ),
      }));
    } catch (error) {
      // Remove temp on failure
      set((state) => ({
        products: state.products.filter((p) => p.id !== tempId),
      }));
      throw error;
    }
  },
}));
```

## Deep Dive 2: Price History API and Chart Integration (8 minutes)

### Time-Series Query Endpoint

```typescript
// backend/src/api/routes/products.ts
router.get('/:id/history', async (req, res) => {
  const { id } = req.params;
  const { range = '30d', resolution = 'daily' } = req.query;

  // 1. Check cache first
  const cacheKey = `prices:${id}:${range}:${resolution}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.json(JSON.parse(cached));
  }

  // 2. Query based on resolution
  let query: string;
  if (resolution === 'hourly') {
    query = `
      SELECT
        time_bucket('1 hour', scraped_at) AS time,
        AVG(price) AS price,
        MIN(price) AS low,
        MAX(price) AS high
      FROM price_history
      WHERE product_id = $1 AND scraped_at >= NOW() - $2::interval
      GROUP BY time_bucket('1 hour', scraped_at)
      ORDER BY time
    `;
  } else {
    // Use continuous aggregate for daily data
    query = `
      SELECT
        day AS time,
        avg AS price,
        low,
        high
      FROM price_daily
      WHERE product_id = $1 AND day >= NOW() - $2::interval
      ORDER BY day
    `;
  }

  try {
    const result = await pool.query(query, [id, range]);

    const data = result.rows.map((row) => ({
      time: row.time.toISOString(),
      price: parseFloat(row.price),
      low: parseFloat(row.low),
      high: parseFloat(row.high),
    }));

    // 3. Cache result
    await redis.setex(cacheKey, 300, JSON.stringify(data)); // 5 minute TTL

    res.json(data);
  } catch (error) {
    console.error('Price history error:', error);
    res.status(500).json({ error: 'Failed to fetch price history' });
  }
});
```

### Frontend Price Chart

```typescript
// frontend/src/components/PriceChart.tsx
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { useState, useEffect } from 'react';
import { api } from '../services/api';

interface PriceChartProps {
  productId: string;
  targetPrice?: number;
  currency: string;
}

export function PriceChart({ productId, targetPrice, currency }: PriceChartProps) {
  const [data, setData] = useState<PricePoint[]>([]);
  const [range, setRange] = useState<'7d' | '30d' | '90d' | '1y'>('30d');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const prices = await api.get<PricePoint[]>(
          `/products/${productId}/history?range=${range}`
        );
        setData(prices);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [productId, range]);

  const stats = useMemo(() => {
    if (data.length === 0) return null;
    return {
      min: Math.min(...data.map((d) => d.low)),
      max: Math.max(...data.map((d) => d.high)),
      avg: data.reduce((sum, d) => sum + d.price, 0) / data.length,
      current: data[data.length - 1]?.price,
    };
  }, [data]);

  if (isLoading) {
    return <ChartSkeleton />;
  }

  return (
    <div className="p-4">
      {/* Range selector */}
      <div className="flex gap-2 mb-4">
        {(['7d', '30d', '90d', '1y'] as const).map((r) => (
          <button
            key={r}
            onClick={() => setRange(r)}
            className={`px-3 py-1 rounded ${
              range === r ? 'bg-blue-500 text-white' : 'bg-gray-100'
            }`}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Statistics */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-4 text-center">
          <Stat label="Current" value={stats.current} currency={currency} />
          <Stat label="Low" value={stats.min} currency={currency} className="text-green-600" />
          <Stat label="Average" value={stats.avg} currency={currency} />
          <Stat label="High" value={stats.max} currency={currency} className="text-red-600" />
        </div>
      )}

      {/* Chart */}
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <XAxis
            dataKey="time"
            tickFormatter={(t) => new Date(t).toLocaleDateString()}
          />
          <YAxis
            domain={['dataMin - 5', 'dataMax + 5']}
            tickFormatter={(v) => `$${v.toFixed(0)}`}
          />
          <Tooltip content={<PriceTooltip currency={currency} />} />

          {targetPrice && (
            <ReferenceLine
              y={targetPrice}
              stroke="#22c55e"
              strokeDasharray="5 5"
              label={{ value: `Target: $${targetPrice}`, position: 'right' }}
            />
          )}

          <Line
            type="monotone"
            dataKey="price"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

## Deep Dive 3: Alert System End-to-End (6 minutes)

### Backend Alert Triggering

```typescript
// backend/src/worker/scraper.ts
async function handlePriceChange(product: Product, newPrice: number) {
  const oldPrice = product.currentPrice;

  if (oldPrice === null) return; // First scrape, no comparison

  // Only process significant changes
  const changePercent = ((newPrice - oldPrice) / oldPrice) * 100;
  if (Math.abs(changePercent) < 0.5) return;

  // Find all alerts for this product
  const alerts = await pool.query(`
    SELECT a.*, u.email, u.push_token
    FROM alerts a
    JOIN users u ON a.user_id = u.id
    WHERE a.product_id = $1 AND a.is_active = true
  `, [product.id]);

  for (const alert of alerts.rows) {
    let shouldTrigger = false;

    if (alert.alert_type === 'below' && newPrice <= alert.target_price) {
      shouldTrigger = true;
    } else if (alert.alert_type === 'above' && newPrice >= alert.target_price) {
      shouldTrigger = true;
    } else if (alert.alert_type === 'change_pct' && Math.abs(changePercent) >= alert.change_threshold_pct) {
      shouldTrigger = true;
    }

    if (shouldTrigger) {
      await rabbitMQ.publish('alerts.send', {
        alertId: alert.id,
        userId: alert.user_id,
        productId: product.id,
        productTitle: product.title,
        oldPrice,
        newPrice,
        targetPrice: alert.target_price,
        email: alert.email,
        pushToken: alert.push_token,
      });

      // Update last triggered time
      await pool.query(
        'UPDATE alerts SET last_triggered_at = NOW() WHERE id = $1',
        [alert.id]
      );
    }
  }
}
```

### Frontend Alert Management

```typescript
// frontend/src/components/AlertSection.tsx
export function AlertSection({ product }: { product: Product }) {
  const alerts = useStore((s) => s.alerts.filter((a) => a.productId === product.id));
  const [isCreating, setIsCreating] = useState(false);

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-semibold">Price Alerts</h3>
        <button
          onClick={() => setIsCreating(true)}
          className="text-blue-500 hover:text-blue-600"
        >
          + Add Alert
        </button>
      </div>

      {alerts.length === 0 ? (
        <p className="text-gray-500 text-sm">
          No alerts set. Add one to get notified when the price drops!
        </p>
      ) : (
        <ul className="space-y-2">
          {alerts.map((alert) => (
            <AlertItem key={alert.id} alert={alert} product={product} />
          ))}
        </ul>
      )}

      {isCreating && (
        <AlertModal
          product={product}
          isOpen={isCreating}
          onClose={() => setIsCreating(false)}
        />
      )}
    </div>
  );
}

function AlertItem({ alert, product }: { alert: Alert; product: Product }) {
  const deleteAlert = useStore((s) => s.deleteAlert);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteAlert(alert.id);
    } finally {
      setIsDeleting(false);
    }
  };

  const isTriggered = alert.alertType === 'below'
    ? product.currentPrice <= alert.targetPrice
    : product.currentPrice >= alert.targetPrice;

  return (
    <li className={`flex items-center justify-between p-3 rounded-lg ${
      isTriggered ? 'bg-green-50 border border-green-200' : 'bg-gray-50'
    }`}>
      <div>
        <div className="font-medium">
          Alert when {alert.alertType === 'below' ? 'below' : 'above'}{' '}
          {formatPrice(alert.targetPrice, product.currency)}
        </div>
        {isTriggered && (
          <div className="text-sm text-green-600">Target reached!</div>
        )}
      </div>
      <button
        onClick={handleDelete}
        disabled={isDeleting}
        className="text-red-500 hover:text-red-600"
      >
        {isDeleting ? <Spinner size="sm" /> : <TrashIcon className="w-5 h-5" />}
      </button>
    </li>
  );
}
```

## Deep Dive 4: Session Management (5 minutes)

### Backend Session Setup

```typescript
// backend/src/shared/session.ts
import session from 'express-session';
import RedisStore from 'connect-redis';
import { redisClient } from './cache.js';

export const sessionMiddleware = session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET!,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
});

// Auth middleware
export function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

// backend/src/api/routes/auth.ts
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

  if (user.rows.length === 0) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.rows[0].password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.rows[0].id;
  req.session.role = user.rows[0].role;

  res.json({
    user: {
      id: user.rows[0].id,
      email: user.rows[0].email,
      role: user.rows[0].role,
    },
  });
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [
    req.session.userId,
  ]);

  if (user.rows.length === 0) {
    req.session.destroy();
    return res.status(401).json({ error: 'User not found' });
  }

  res.json({ user: user.rows[0] });
});
```

### Frontend Auth State

```typescript
// frontend/src/stores/authStore.ts
import { create } from 'zustand';
import { api } from '../services/api';

interface AuthStore {
  user: User | null;
  isLoading: boolean;
  checkSession: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()((set) => ({
  user: null,
  isLoading: true,

  checkSession: async () => {
    try {
      const { user } = await api.get<{ user: User }>('/auth/me');
      set({ user, isLoading: false });
    } catch {
      set({ user: null, isLoading: false });
    }
  },

  login: async (email, password) => {
    const { user } = await api.post<{ user: User }>('/auth/login', { email, password });
    set({ user });
  },

  logout: async () => {
    await api.post('/auth/logout', {});
    set({ user: null });
  },
}));

// App initialization
function App() {
  const checkSession = useAuthStore((s) => s.checkSession);
  const isLoading = useAuthStore((s) => s.isLoading);

  useEffect(() => {
    checkSession();
  }, []);

  if (isLoading) {
    return <LoadingScreen />;
  }

  return <RouterProvider router={router} />;
}
```

## Deep Dive 5: Admin Dashboard (5 minutes)

### Admin API Endpoints

```typescript
// backend/src/api/routes/admin.ts
router.get('/stats', requireAdmin, async (req, res) => {
  const [products, users, alerts, scrapeStats] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM products'),
    pool.query('SELECT COUNT(*) FROM users'),
    pool.query('SELECT COUNT(*) FROM alerts WHERE is_active = true'),
    pool.query(`
      SELECT
        domain,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        AVG(EXTRACT(EPOCH FROM (NOW() - last_scraped_at))) as avg_age_seconds
      FROM products
      GROUP BY domain
    `),
  ]);

  res.json({
    totalProducts: parseInt(products.rows[0].count),
    totalUsers: parseInt(users.rows[0].count),
    activeAlerts: parseInt(alerts.rows[0].count),
    scraperHealth: scrapeStats.rows,
  });
});

router.get('/scrapers', requireAdmin, async (req, res) => {
  const configs = await pool.query(`
    SELECT sc.*,
           (SELECT COUNT(*) FROM products WHERE domain = sc.domain) as product_count
    FROM scraper_configs sc
    ORDER BY product_count DESC
  `);

  res.json(configs.rows);
});

router.patch('/scrapers/:domain', requireAdmin, async (req, res) => {
  const { domain } = req.params;
  const { priceSelector, titleSelector, requiresJs, rateLimitRpm } = req.body;

  const result = await pool.query(`
    UPDATE scraper_configs
    SET price_selector = COALESCE($2, price_selector),
        title_selector = COALESCE($3, title_selector),
        requires_js = COALESCE($4, requires_js),
        rate_limit_rpm = COALESCE($5, rate_limit_rpm),
        last_updated = NOW()
    WHERE domain = $1
    RETURNING *
  `, [domain, priceSelector, titleSelector, requiresJs, rateLimitRpm]);

  // Invalidate cache
  await redis.del(`scraper_config:${domain}`);

  res.json(result.rows[0]);
});
```

### Admin Dashboard UI

```typescript
// frontend/src/routes/admin.tsx
export function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [scrapers, setScrapers] = useState<ScraperConfig[]>([]);

  useEffect(() => {
    Promise.all([
      api.get<AdminStats>('/admin/stats'),
      api.get<ScraperConfig[]>('/admin/scrapers'),
    ]).then(([statsData, scrapersData]) => {
      setStats(statsData);
      setScrapers(scrapersData);
    });
  }, []);

  if (!stats) return <LoadingScreen />;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Admin Dashboard</h1>

      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <StatCard label="Products" value={stats.totalProducts} />
        <StatCard label="Users" value={stats.totalUsers} />
        <StatCard label="Active Alerts" value={stats.activeAlerts} />
        <StatCard label="Scrape Rate" value={`${stats.scrapeRate}/min`} />
      </div>

      {/* Scraper health table */}
      <div className="bg-white rounded-lg shadow">
        <h2 className="text-lg font-semibold p-4 border-b">Scraper Health by Domain</h2>
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left p-3">Domain</th>
              <th className="text-right p-3">Products</th>
              <th className="text-right p-3">Success Rate</th>
              <th className="text-right p-3">Avg Age</th>
              <th className="text-center p-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {stats.scraperHealth.map((domain) => (
              <tr key={domain.domain} className="border-t">
                <td className="p-3">{domain.domain}</td>
                <td className="text-right p-3">{domain.total}</td>
                <td className="text-right p-3">{domain.successRate.toFixed(1)}%</td>
                <td className="text-right p-3">{formatDuration(domain.avgAgeSeconds)}</td>
                <td className="text-center p-3">
                  <StatusBadge status={domain.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

## Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| API Style | REST | GraphQL | Simpler for CRUD, caching-friendly |
| Time-Series | TimescaleDB | InfluxDB | SQL, joins with relational data |
| Charts | Recharts | D3 | React-native, easier integration |
| State | Zustand | Redux | Simpler API, less boilerplate |
| Sessions | Redis-backed | JWT | Server-side control, easy revocation |
| Queue | RabbitMQ | Redis BullMQ | Dedicated queue, better persistence |

## Future Fullstack Enhancements

1. **WebSocket Price Updates**: Real-time price notifications
2. **Browser Extension**: Quick add while browsing e-commerce
3. **Email Templates**: Rich HTML notifications with price charts
4. **Multi-Currency**: Automatic conversion and display
5. **Price Predictions**: ML model for buy/wait recommendations
6. **Bulk Import**: CSV upload for tracking multiple products
7. **Share Lists**: Public price tracking lists
