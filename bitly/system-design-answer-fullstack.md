# Bitly (URL Shortener) - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design a complete URL shortening service that:
- Provides seamless URL shortening with instant feedback
- Delivers sub-50ms redirect latency at scale
- Tracks and visualizes click analytics in real-time
- Supports custom short codes with live availability checking

## Requirements Clarification

### Functional Requirements
1. **URL Shortening**: Generate 7-character short codes from long URLs
2. **Fast Redirects**: Redirect with < 50ms latency using multi-tier caching
3. **Custom Codes**: User-specified codes with live validation
4. **Analytics**: Click tracking with referrer, device, and geographic data
5. **Link Management**: Dashboard for viewing, searching, and deleting URLs
6. **User Authentication**: Session-based auth with admin capabilities

### Non-Functional Requirements
1. **Performance**: < 50ms redirect latency, < 100ms UI interactions
2. **Scalability**: Handle 100:1 read-to-write ratio
3. **Consistency**: Strong for URL creation, eventual for analytics
4. **Reliability**: 99.99% uptime for redirect service

### Scale Estimates
- 100M URLs/month (40 writes/second)
- 10B redirects/month (4,000 reads/second)
- 100:1 read-to-write ratio

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         React Frontend (Vite)                           │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐        │
│  │ URLShortener│  │  URLList   │  │ Analytics  │  │   Admin    │        │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Load Balancer (nginx)                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
            │ API Server  │ │ API Server  │ │ API Server  │
            │   (Node)    │ │   (Node)    │ │   (Node)    │
            └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
                   │               │               │
            ┌──────┴───────────────┴───────────────┴──────┐
            │                                             │
    ┌───────▼───────┐  ┌───────────────┐  ┌──────────────▼─────┐
    │    Valkey     │  │  PostgreSQL   │  │     RabbitMQ       │
    │ (Cache/Session)│  │  (Primary DB) │  │ (Analytics Queue)  │
    └───────────────┘  └───────────────┘  └────────────────────┘
```

## Deep Dive: Shared Type Definitions

### API Types

```typescript
// shared/types/api.ts

// ============ URL Types ============
export interface ShortenedUrl {
    id: string;
    shortCode: string;
    shortUrl: string;
    longUrl: string;
    userId: string | null;
    isCustom: boolean;
    isActive: boolean;
    expiresAt: string | null;
    clickCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface ShortenRequest {
    long_url: string;
    custom_code?: string;
    expires_at?: string;
}

export interface ShortenResponse {
    short_url: string;
    short_code: string;
    long_url: string;
    expires_at: string | null;
    created_at: string;
}

// ============ Analytics Types ============
export interface ClickEvent {
    id: string;
    urlId: string;
    shortCode: string;
    referrer: string | null;
    userAgent: string | null;
    deviceType: 'mobile' | 'desktop' | 'tablet';
    countryCode: string | null;
    clickedAt: string;
}

export interface AnalyticsData {
    shortCode: string;
    totalClicks: number;
    uniqueVisitors: number;
    clicksByDay: DailyClicks[];
    topReferrers: ReferrerStats[];
    devices: DeviceBreakdown;
    countries: CountryStats[];
}

export interface DailyClicks {
    date: string;
    count: number;
}

export interface ReferrerStats {
    referrer: string;
    count: number;
}

export interface DeviceBreakdown {
    mobile: number;
    desktop: number;
    tablet: number;
}

export interface CountryStats {
    code: string;
    name: string;
    count: number;
}

// ============ Auth Types ============
export interface User {
    id: string;
    email: string;
    role: 'user' | 'admin';
    createdAt: string;
}

export interface AuthState {
    user: User | null;
    isAuthenticated: boolean;
}

export interface LoginRequest {
    email: string;
    password: string;
}

export interface RegisterRequest {
    email: string;
    password: string;
}

// ============ Admin Types ============
export interface SystemStats {
    totalUrls: number;
    totalClicks: number;
    totalUsers: number;
    urlsToday: number;
    clicksToday: number;
    keyPoolAvailable: number;
    cacheHitRate: number;
}

// ============ API Response Wrappers ============
export interface ApiResponse<T> {
    data: T;
    error?: never;
}

export interface ApiError {
    data?: never;
    error: {
        message: string;
        code: string;
        details?: Record<string, string>;
    };
}

export type ApiResult<T> = ApiResponse<T> | ApiError;
```

### Validation Schemas (shared between frontend and backend)

```typescript
// shared/validation/url.ts
import { z } from 'zod';

export const shortenUrlSchema = z.object({
    long_url: z
        .string()
        .url('Please enter a valid URL')
        .max(2048, 'URL is too long (max 2048 characters)')
        .refine(
            (url) => url.startsWith('http://') || url.startsWith('https://'),
            'Only HTTP and HTTPS URLs are supported'
        ),
    custom_code: z
        .string()
        .min(4, 'Custom code must be at least 4 characters')
        .max(20, 'Custom code must be at most 20 characters')
        .regex(/^[a-zA-Z0-9-_]+$/, 'Only letters, numbers, dash, and underscore allowed')
        .optional(),
    expires_at: z
        .string()
        .datetime()
        .refine(
            (date) => new Date(date) > new Date(),
            'Expiration date must be in the future'
        )
        .optional()
});

export type ShortenUrlInput = z.infer<typeof shortenUrlSchema>;

// Reserved words that cannot be used as custom codes
export const RESERVED_CODES = [
    'api', 'admin', 'auth', 'login', 'signup', 'register',
    'logout', 'health', 'metrics', 'static', 'assets'
];

export function isReservedCode(code: string): boolean {
    return RESERVED_CODES.includes(code.toLowerCase());
}
```

## Deep Dive: API Client Layer

### Axios Configuration with Interceptors

```typescript
// frontend/src/services/api.ts
import axios, { AxiosError, AxiosInstance } from 'axios';
import { useAuthStore } from '../stores/authStore';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

class ApiClient {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: API_BASE_URL,
            withCredentials: true,  // Send cookies for session auth
            headers: {
                'Content-Type': 'application/json'
            }
        });

        this.setupInterceptors();
    }

    private setupInterceptors() {
        // Request interceptor - add idempotency key for POST requests
        this.client.interceptors.request.use((config) => {
            if (config.method === 'post' && !config.headers['Idempotency-Key']) {
                config.headers['Idempotency-Key'] = crypto.randomUUID();
            }
            return config;
        });

        // Response interceptor - handle auth errors
        this.client.interceptors.response.use(
            (response) => response,
            (error: AxiosError) => {
                if (error.response?.status === 401) {
                    useAuthStore.getState().clearUser();
                    window.location.href = '/login';
                }
                return Promise.reject(error);
            }
        );
    }

    // Generic request method
    async request<T>(config: Parameters<AxiosInstance['request']>[0]): Promise<T> {
        const response = await this.client.request<T>(config);
        return response.data;
    }

    // Convenience methods
    get<T>(url: string, params?: Record<string, any>): Promise<T> {
        return this.request<T>({ method: 'GET', url, params });
    }

    post<T>(url: string, data?: any): Promise<T> {
        return this.request<T>({ method: 'POST', url, data });
    }

    put<T>(url: string, data?: any): Promise<T> {
        return this.request<T>({ method: 'PUT', url, data });
    }

    delete<T>(url: string): Promise<T> {
        return this.request<T>({ method: 'DELETE', url });
    }
}

export const api = new ApiClient();
```

### URL Service

```typescript
// frontend/src/services/urlService.ts
import { api } from './api';
import { ShortenedUrl, ShortenRequest, ShortenResponse, AnalyticsData } from '../types/api';

export const urlService = {
    // Shorten a URL
    async shorten(request: ShortenRequest): Promise<ShortenResponse> {
        return api.post<ShortenResponse>('/shorten', request);
    },

    // Get user's URLs
    async getUserUrls(): Promise<ShortenedUrl[]> {
        return api.get<ShortenedUrl[]>('/user/urls');
    },

    // Get URL metadata
    async getUrl(shortCode: string): Promise<ShortenedUrl> {
        return api.get<ShortenedUrl>(`/urls/${shortCode}`);
    },

    // Check if custom code is available
    async checkAvailability(code: string): Promise<{ available: boolean }> {
        return api.get<{ available: boolean }>(`/urls/${code}/available`);
    },

    // Get analytics for a URL
    async getAnalytics(
        shortCode: string,
        params?: { start?: string; end?: string }
    ): Promise<AnalyticsData> {
        return api.get<AnalyticsData>(`/urls/${shortCode}/stats`, params);
    },

    // Deactivate a URL
    async deleteUrl(shortCode: string): Promise<void> {
        return api.delete(`/urls/${shortCode}`);
    }
};
```

## Deep Dive: Backend API Routes

### URL Shortening Endpoint

```typescript
// backend/src/routes/urls.ts
import { Router } from 'express';
import { z } from 'zod';
import { shortenUrlSchema, isReservedCode } from '../../shared/validation/url';
import { keyPoolService } from '../services/keyPool';
import { cacheService } from '../services/cache';
import { idempotencyService } from '../services/idempotency';
import { db } from '../shared/db';

const router = Router();

// POST /api/v1/shorten - Create short URL
router.post('/shorten', async (req, res) => {
    const idempotencyKey = req.headers['idempotency-key'] as string
        || generateFingerprint(req.body, req.user?.id);

    // Check for duplicate request
    const existingResult = await idempotencyService.get(idempotencyKey);
    if (existingResult) {
        return res.status(200).json(existingResult);
    }

    // Validate input
    const validation = shortenUrlSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({
            error: {
                message: 'Validation failed',
                code: 'VALIDATION_ERROR',
                details: validation.error.flatten().fieldErrors
            }
        });
    }

    const { long_url, custom_code, expires_at } = validation.data;

    try {
        let shortCode: string;
        let isCustom = false;

        if (custom_code) {
            // Validate custom code
            if (isReservedCode(custom_code)) {
                return res.status(400).json({
                    error: { message: 'This code is reserved', code: 'RESERVED_CODE' }
                });
            }

            // Check availability in both urls and key_pool tables
            const existing = await db.query(
                'SELECT 1 FROM urls WHERE short_code = $1 UNION SELECT 1 FROM key_pool WHERE short_code = $1',
                [custom_code]
            );

            if (existing.rows.length > 0) {
                return res.status(409).json({
                    error: { message: 'This code is already taken', code: 'CODE_TAKEN' }
                });
            }

            shortCode = custom_code;
            isCustom = true;
        } else {
            // Get from pre-generated key pool
            shortCode = await keyPoolService.getShortCode();
        }

        // Insert URL record
        const result = await db.query(`
            INSERT INTO urls (short_code, long_url, user_id, is_custom, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, short_code, long_url, expires_at, created_at
        `, [shortCode, long_url, req.user?.id || null, isCustom, expires_at || null]);

        const url = result.rows[0];

        // Populate cache (write-through)
        await cacheService.setUrl(shortCode, long_url);

        const response = {
            short_url: `${process.env.BASE_URL}/${shortCode}`,
            short_code: shortCode,
            long_url: long_url,
            expires_at: url.expires_at,
            created_at: url.created_at
        };

        // Store for idempotency
        await idempotencyService.set(idempotencyKey, response);

        res.status(201).json(response);

    } catch (error) {
        logger.error('Shorten URL error', { error, long_url });
        res.status(500).json({
            error: { message: 'Failed to create short URL', code: 'INTERNAL_ERROR' }
        });
    }
});

// GET /api/v1/urls/:code/available - Check code availability
router.get('/urls/:code/available', async (req, res) => {
    const { code } = req.params;

    if (isReservedCode(code)) {
        return res.json({ available: false, reason: 'reserved' });
    }

    const existing = await db.query(
        'SELECT 1 FROM urls WHERE short_code = $1 LIMIT 1',
        [code]
    );

    res.json({ available: existing.rows.length === 0 });
});

export default router;
```

### Redirect Endpoint

```typescript
// backend/src/routes/redirect.ts
import { Router } from 'express';
import { redirectService } from '../services/redirect';
import { analyticsService } from '../services/analytics';

const router = Router();

// GET /:shortCode - Redirect to long URL
router.get('/:shortCode', async (req, res) => {
    const { shortCode } = req.params;
    const startTime = Date.now();

    try {
        const result = await redirectService.getLongUrl(shortCode);

        if (!result) {
            metrics.redirectsTotal.inc({ status: 'not_found' });
            return res.status(404).json({ error: 'URL not found' });
        }

        if (result.expired) {
            metrics.redirectsTotal.inc({ status: 'expired' });
            return res.status(410).json({ error: 'URL has expired' });
        }

        // Return redirect immediately (302 for analytics accuracy)
        res.redirect(302, result.longUrl);

        // Track analytics asynchronously (non-blocking)
        setImmediate(() => {
            analyticsService.trackClick({
                shortCode,
                referrer: req.headers.referer || null,
                userAgent: req.headers['user-agent'] || null,
                ip: req.ip
            }).catch(err => logger.error('Analytics tracking failed', err));
        });

        metrics.redirectsTotal.inc({
            status: 'success',
            cached: result.cached ? 'hit' : 'miss'
        });
        metrics.redirectLatency.observe(Date.now() - startTime);

    } catch (error) {
        logger.error('Redirect error', { shortCode, error });
        metrics.redirectsTotal.inc({ status: 'error' });
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
```

### Analytics Endpoint

```typescript
// backend/src/routes/analytics.ts
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { db } from '../shared/db';

const router = Router();

// GET /api/v1/urls/:code/stats - Get URL analytics
router.get('/urls/:code/stats', requireAuth, async (req, res) => {
    const { code } = req.params;
    const { start, end } = req.query;

    // Verify ownership
    const url = await db.query(
        'SELECT id, user_id FROM urls WHERE short_code = $1',
        [code]
    );

    if (url.rows.length === 0) {
        return res.status(404).json({ error: 'URL not found' });
    }

    if (url.rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
    }

    const startDate = start ? new Date(start as string) : subDays(new Date(), 30);
    const endDate = end ? new Date(end as string) : new Date();

    // Parallel queries for analytics data
    const [
        totalStats,
        clicksByDay,
        topReferrers,
        deviceStats,
        countryStats
    ] = await Promise.all([
        // Total clicks and unique visitors
        db.query(`
            SELECT
                COUNT(*) as total_clicks,
                COUNT(DISTINCT ip_hash) as unique_visitors
            FROM click_events
            WHERE short_code = $1
              AND clicked_at BETWEEN $2 AND $3
        `, [code, startDate, endDate]),

        // Clicks by day
        db.query(`
            SELECT
                DATE(clicked_at) as date,
                COUNT(*) as count
            FROM click_events
            WHERE short_code = $1
              AND clicked_at BETWEEN $2 AND $3
            GROUP BY DATE(clicked_at)
            ORDER BY date
        `, [code, startDate, endDate]),

        // Top referrers
        db.query(`
            SELECT
                COALESCE(referrer, 'Direct') as referrer,
                COUNT(*) as count
            FROM click_events
            WHERE short_code = $1
              AND clicked_at BETWEEN $2 AND $3
            GROUP BY referrer
            ORDER BY count DESC
            LIMIT 10
        `, [code, startDate, endDate]),

        // Device breakdown
        db.query(`
            SELECT
                device_type,
                COUNT(*) as count
            FROM click_events
            WHERE short_code = $1
              AND clicked_at BETWEEN $2 AND $3
            GROUP BY device_type
        `, [code, startDate, endDate]),

        // Country stats
        db.query(`
            SELECT
                country_code as code,
                COUNT(*) as count
            FROM click_events
            WHERE short_code = $1
              AND country_code IS NOT NULL
              AND clicked_at BETWEEN $2 AND $3
            GROUP BY country_code
            ORDER BY count DESC
            LIMIT 20
        `, [code, startDate, endDate])
    ]);

    // Transform device stats to breakdown object
    const devices = {
        mobile: 0,
        desktop: 0,
        tablet: 0
    };
    deviceStats.rows.forEach(row => {
        if (row.device_type in devices) {
            devices[row.device_type as keyof typeof devices] = parseInt(row.count);
        }
    });

    res.json({
        shortCode: code,
        totalClicks: parseInt(totalStats.rows[0].total_clicks),
        uniqueVisitors: parseInt(totalStats.rows[0].unique_visitors),
        clicksByDay: clicksByDay.rows.map(r => ({
            date: r.date.toISOString().split('T')[0],
            count: parseInt(r.count)
        })),
        topReferrers: topReferrers.rows.map(r => ({
            referrer: r.referrer,
            count: parseInt(r.count)
        })),
        devices,
        countries: countryStats.rows.map(r => ({
            code: r.code,
            name: getCountryName(r.code),
            count: parseInt(r.count)
        }))
    });
});

export default router;
```

## Deep Dive: Full URL Creation Flow

### Frontend to Backend Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        URL Shortening Flow                              │
└─────────────────────────────────────────────────────────────────────────┘

1. User Input
   ┌────────────────────────────────────────────────────────────────────┐
   │  URLShortener Component                                            │
   │  - User types long URL                                             │
   │  - useUrlValidation hook validates format                          │
   │  - Optional: enters custom code (debounced availability check)     │
   └────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
2. Form Submission
   ┌────────────────────────────────────────────────────────────────────┐
   │  urlStore.shortenUrl()                                             │
   │  - Sets isShortening = true                                        │
   │  - Generates idempotency key                                       │
   │  - Calls urlService.shorten()                                      │
   └────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
3. API Request
   ┌────────────────────────────────────────────────────────────────────┐
   │  POST /api/v1/shorten                                              │
   │  Headers: { Idempotency-Key: <uuid> }                              │
   │  Body: { long_url, custom_code?, expires_at? }                     │
   └────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
4. Backend Processing
   ┌────────────────────────────────────────────────────────────────────┐
   │  a. Check idempotency cache → return if duplicate                  │
   │  b. Validate with Zod schema                                       │
   │  c. Get short code (custom or from key pool)                       │
   │  d. Insert into PostgreSQL                                         │
   │  e. Write-through to Redis cache                                   │
   │  f. Store result in idempotency cache                              │
   └────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
5. Response Handling
   ┌────────────────────────────────────────────────────────────────────┐
   │  urlStore (continued)                                              │
   │  - Adds new URL to urls array (optimistic)                         │
   │  - Sets isShortening = false                                       │
   │  - Returns ShortenedUrl                                            │
   └────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
6. UI Update
   ┌────────────────────────────────────────────────────────────────────┐
   │  ShortenedResult Component                                         │
   │  - Animated entrance (framer-motion)                               │
   │  - Copy button with feedback                                       │
   │  - Screen reader announcement                                      │
   └────────────────────────────────────────────────────────────────────┘
```

### Redirect Flow with Caching

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Redirect Flow                                  │
└─────────────────────────────────────────────────────────────────────────┘

1. User clicks short URL
   GET https://bit.ly/abc1234
                    │
                    ▼
2. Load Balancer routes to API Server
                    │
                    ▼
3. RedirectService.getLongUrl()
   ┌────────────────────────────────────────────────────────────────────┐
   │  Tier 1: Local LRU Cache (in-memory)                               │
   │  ├─ Hit (~0.1ms) → Return immediately                              │
   │  └─ Miss → Continue                                                │
   │                                                                     │
   │  Tier 2: Redis Cache                                               │
   │  ├─ Hit (~1ms) → Populate local cache, return                      │
   │  └─ Miss → Continue                                                │
   │                                                                     │
   │  Tier 3: PostgreSQL (with circuit breaker)                         │
   │  ├─ Found → Check expiration, populate caches, return              │
   │  └─ Not Found → Return null                                        │
   └────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
4. Return 302 Redirect
   Location: https://example.com/original/long/url
                    │
                    ▼
5. Async Analytics (non-blocking)
   ┌────────────────────────────────────────────────────────────────────┐
   │  setImmediate(() => {                                              │
   │    analyticsService.trackClick({                                   │
   │      shortCode, referrer, userAgent, ip                            │
   │    });                                                              │
   │  });                                                                │
   │                                                                     │
   │  → RabbitMQ queue → Analytics Worker → PostgreSQL click_events     │
   └────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: Authentication Flow

### Session-Based Auth Implementation

```typescript
// backend/src/routes/auth.ts
import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from '../shared/db';
import { redis } from '../shared/cache';

const router = Router();
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days

// POST /api/v1/auth/login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    // Find user
    const result = await db.query(
        'SELECT id, email, password_hash, role FROM users WHERE email = $1',
        [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Create session
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL * 1000);

    // Store in database (backup)
    await db.query(
        'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, token, expiresAt]
    );

    // Store in Redis (primary)
    await redis.setex(
        `session:${token}`,
        SESSION_TTL,
        JSON.stringify({ userId: user.id, role: user.role })
    );

    // Set cookie
    res.cookie('bitly_session', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: SESSION_TTL * 1000
    });

    res.json({
        user: {
            id: user.id,
            email: user.email,
            role: user.role
        }
    });
});

// POST /api/v1/auth/logout
router.post('/logout', async (req, res) => {
    const token = req.cookies.bitly_session;

    if (token) {
        // Clear from Redis
        await redis.del(`session:${token}`);

        // Clear from database
        await db.query('DELETE FROM sessions WHERE token = $1', [token]);
    }

    res.clearCookie('bitly_session');
    res.json({ success: true });
});

// GET /api/v1/auth/me
router.get('/me', async (req, res) => {
    const token = req.cookies.bitly_session;

    if (!token) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    // Check Redis first
    const cached = await redis.get(`session:${token}`);
    let session;

    if (cached) {
        session = JSON.parse(cached);
    } else {
        // Fallback to database
        const result = await db.query(`
            SELECT s.user_id, u.email, u.role
            FROM sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.token = $1 AND s.expires_at > NOW()
        `, [token]);

        if (result.rows.length === 0) {
            res.clearCookie('bitly_session');
            return res.status(401).json({ error: 'Session expired' });
        }

        session = result.rows[0];

        // Repopulate Redis
        await redis.setex(`session:${token}`, SESSION_TTL, JSON.stringify({
            userId: session.user_id,
            role: session.role
        }));
    }

    // Get full user data
    const user = await db.query(
        'SELECT id, email, role, created_at FROM users WHERE id = $1',
        [session.userId]
    );

    res.json({ user: user.rows[0] });
});

export default router;
```

### Frontend Auth Integration

```typescript
// frontend/src/App.tsx
import { useEffect } from 'react';
import { useAuthStore } from './stores/authStore';

export function App() {
    const { checkSession, isLoading, user } = useAuthStore();

    useEffect(() => {
        // Check session on app load
        checkSession();
    }, []);

    if (isLoading) {
        return <LoadingScreen />;
    }

    return (
        <Router>
            <Routes>
                {/* Public routes */}
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />

                {/* Protected routes */}
                <Route element={<ProtectedRoute />}>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/urls" element={<URLList />} />
                    <Route path="/analytics/:code" element={<AnalyticsPage />} />
                </Route>

                {/* Admin routes */}
                <Route element={<AdminRoute />}>
                    <Route path="/admin" element={<AdminDashboard />} />
                </Route>
            </Routes>
        </Router>
    );
}

// components/ProtectedRoute.tsx
export function ProtectedRoute() {
    const { isAuthenticated } = useAuthStore();
    const location = useLocation();

    if (!isAuthenticated) {
        return <Navigate to="/login" state={{ from: location }} replace />;
    }

    return <Outlet />;
}
```

## Deep Dive: Custom Code Availability Check

### Debounced Frontend Check

```tsx
// components/CustomCodeInput.tsx
export function CustomCodeInput({ value, onChange }: CustomCodeInputProps) {
    const [isChecking, setIsChecking] = useState(false);
    const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
    const debouncedValue = useDebounce(value, 300);

    useEffect(() => {
        if (!debouncedValue || debouncedValue.length < 4) {
            setIsAvailable(null);
            return;
        }

        // Check reserved words locally first
        if (isReservedCode(debouncedValue)) {
            setIsAvailable(false);
            return;
        }

        const checkAvailability = async () => {
            setIsChecking(true);
            try {
                const result = await urlService.checkAvailability(debouncedValue);
                setIsAvailable(result.available);
            } catch {
                setIsAvailable(null);
            } finally {
                setIsChecking(false);
            }
        };

        checkAvailability();
    }, [debouncedValue]);

    return (
        <div className="relative">
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value.replace(/[^a-zA-Z0-9-_]/g, ''))}
                className={`
                    w-full px-3 py-2 border rounded-md
                    ${isAvailable === false ? 'border-red-500' : ''}
                    ${isAvailable === true ? 'border-green-500' : ''}
                `}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2">
                {isChecking && <Spinner />}
                {!isChecking && isAvailable === true && <CheckIcon className="text-green-500" />}
                {!isChecking && isAvailable === false && <XIcon className="text-red-500" />}
            </span>
        </div>
    );
}
```

### Backend Availability Endpoint

```typescript
// backend/src/routes/urls.ts

// GET /api/v1/urls/:code/available
router.get('/urls/:code/available', async (req, res) => {
    const { code } = req.params;

    // Validate format
    if (!/^[a-zA-Z0-9-_]{4,20}$/.test(code)) {
        return res.json({ available: false, reason: 'invalid_format' });
    }

    // Check reserved words
    if (isReservedCode(code)) {
        return res.json({ available: false, reason: 'reserved' });
    }

    // Check if code exists in URLs table
    const urlExists = await db.query(
        'SELECT 1 FROM urls WHERE short_code = $1 LIMIT 1',
        [code]
    );

    if (urlExists.rows.length > 0) {
        return res.json({ available: false, reason: 'taken' });
    }

    // Check if code exists in key pool (pre-generated)
    const keyExists = await db.query(
        'SELECT 1 FROM key_pool WHERE short_code = $1 LIMIT 1',
        [code]
    );

    if (keyExists.rows.length > 0) {
        return res.json({ available: false, reason: 'reserved_key' });
    }

    res.json({ available: true });
});
```

## Deep Dive: Error Handling

### Unified Error Handling

```typescript
// backend/src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
    constructor(
        public message: string,
        public code: string,
        public statusCode: number = 400,
        public details?: Record<string, string>
    ) {
        super(message);
    }
}

export function errorHandler(
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction
) {
    logger.error('Request error', {
        path: req.path,
        method: req.method,
        error: error.message,
        stack: error.stack
    });

    if (error instanceof AppError) {
        return res.status(error.statusCode).json({
            error: {
                message: error.message,
                code: error.code,
                details: error.details
            }
        });
    }

    // Handle Zod validation errors
    if (error.name === 'ZodError') {
        return res.status(400).json({
            error: {
                message: 'Validation failed',
                code: 'VALIDATION_ERROR',
                details: error.flatten().fieldErrors
            }
        });
    }

    // Default error
    res.status(500).json({
        error: {
            message: 'Internal server error',
            code: 'INTERNAL_ERROR'
        }
    });
}
```

### Frontend Error Display

```tsx
// components/ErrorBoundary.tsx
export function ErrorBoundary({ children }: { children: React.ReactNode }) {
    return (
        <ReactErrorBoundary
            fallbackRender={({ error, resetErrorBoundary }) => (
                <div className="min-h-screen flex items-center justify-center bg-gray-50">
                    <div className="text-center p-8">
                        <h1 className="text-2xl font-bold text-gray-900 mb-4">
                            Something went wrong
                        </h1>
                        <p className="text-gray-600 mb-6">{error.message}</p>
                        <button
                            onClick={resetErrorBoundary}
                            className="px-4 py-2 bg-orange-600 text-white rounded-md"
                        >
                            Try again
                        </button>
                    </div>
                </div>
            )}
        >
            {children}
        </ReactErrorBoundary>
    );
}

// hooks/useApiError.ts
export function useApiError() {
    const { addToast } = useToastStore();

    const handleError = useCallback((error: unknown) => {
        if (axios.isAxiosError(error)) {
            const message = error.response?.data?.error?.message || 'An error occurred';
            addToast({ type: 'error', message });
        } else if (error instanceof Error) {
            addToast({ type: 'error', message: error.message });
        }
    }, [addToast]);

    return { handleError };
}
```

## Trade-offs Summary

| Decision | Pros | Cons |
|----------|------|------|
| Shared Zod schemas | Single source of truth, type-safe | Build complexity |
| Session-based auth | Simple, revocable | Requires Redis |
| Debounced availability check | Reduces API calls | Slight UX delay |
| 302 redirects | Accurate analytics | More server load |
| Optimistic UI updates | Instant feedback | Rollback complexity |
| Write-through cache | Consistent reads | Extra write latency |

## Future Fullstack Enhancements

1. **Real-time Analytics**: WebSocket for live click updates
2. **Bulk Operations**: Create/delete multiple URLs via CSV
3. **Link Previews**: Server-side OG image generation
4. **A/B Testing**: Split traffic between multiple destinations
5. **API Keys**: Third-party integration with rate limits
6. **Webhooks**: Notify on click thresholds
7. **Multi-tenancy**: Organization accounts with team members
8. **Mobile App**: React Native with shared business logic
