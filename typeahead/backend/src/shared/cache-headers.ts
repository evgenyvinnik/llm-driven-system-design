/**
 * Cache headers middleware for HTTP caching.
 * Provides different caching strategies for various endpoint types.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';

declare module 'express-serve-static-core' {
  interface Locals {
    // Set by a route to keep this response out of every HTTP cache (e.g. a degraded fallback)
    noStore?: boolean;
  }
}

/**
 * Cache strategies for different endpoint types.
 */
export type CacheStrategy =
  | 'suggestions' // Public, short TTL, stale-while-revalidate
  | 'trending' // Public, very short TTL
  | 'user-specific' // Private, revalidated on every use
  | 'no-cache'; // No caching (mutations)

/**
 * Cache configuration for each strategy.
 */
const CACHE_CONFIGS: Record<
  CacheStrategy,
  {
    cacheControl: string;
    addETag: boolean;
  }
> = {
  suggestions: {
    cacheControl: 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
    addETag: true,
  },
  trending: {
    cacheControl: 'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    addETag: true,
  },
  // Personalized responses change as soon as the user logs a search, so the browser may keep
  // a copy but must revalidate it each time (a 304 when the ETag still matches)
  'user-specific': {
    cacheControl: 'private, no-cache',
    addETag: true,
  },
  'no-cache': {
    cacheControl: 'no-cache, no-store, must-revalidate',
    addETag: false,
  },
};

/**
 * Sent instead of the strategy's header for errors and for routes that set res.locals.noStore.
 */
const NO_STORE = 'no-store';

/**
 * The part of a response body that identifies its content. Per-request envelope fields
 * (top-level timestamp; meta.responseTimeMs, meta.cached, meta.timestamp) are dropped, and
 * fractional numbers are rounded, since ranking scores include a recency term computed from
 * Date.now() that differs in the last digits on every request.
 */
function stableContent(body: unknown): string {
  let content = body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { timestamp: _timestamp, ...rest } = body as Record<string, unknown>;
    const meta = rest.meta;
    if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
      const {
        responseTimeMs: _responseTimeMs,
        cached: _cached,
        timestamp: _metaTimestamp,
        ...stableMeta
      } = meta as Record<string, unknown>;
      rest.meta = stableMeta;
    }
    content = rest;
  }

  return JSON.stringify(content, (_key, value: unknown) =>
    typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 1000) / 1000 : value
  );
}

/**
 * Generate a weak ETag from the stable content of a response body. Weak (W/) because two
 * responses with the same tag are equivalent, not byte-identical.
 */
function generateETag(body: unknown): string {
  const hash = crypto.createHash('md5').update(stableContent(body)).digest('hex');
  return `W/"${hash}"`;
}

/**
 * Create cache headers middleware for a specific strategy.
 */
export function cacheHeaders(strategy: CacheStrategy): RequestHandler {
  const config = CACHE_CONFIGS[strategy];

  return (_req: Request, res: Response, next: NextFunction): void => {
    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json to add cache headers
    res.json = (body: unknown): Response => {
      // Only successful responses are cacheable: a cached 4xx/5xx or a degraded fallback
      // would keep being served after the problem is gone
      if (res.statusCode < 200 || res.statusCode >= 300 || res.locals.noStore) {
        res.set('Cache-Control', NO_STORE);
        res.removeHeader('ETag');
        return originalJson(body);
      }

      // Set Cache-Control header
      res.set('Cache-Control', config.cacheControl);

      // Add ETag if configured. Express's res.send compares it with If-None-Match
      // (req.fresh, weak comparison, lists of tags) and answers 304 without a body.
      if (config.addETag && body) {
        res.set('ETag', generateETag(body));
      }

      // Add Vary header for proper cache key differentiation. res.vary appends, keeping the
      // Vary: Origin that cors sets for its per-origin Access-Control-Allow-Origin.
      if (strategy === 'user-specific') {
        res.vary('Authorization').vary('Cookie');
      } else {
        res.vary('Accept-Encoding');
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * Middleware to set cache headers for suggestions endpoint.
 */
export const cacheSuggestions: RequestHandler = cacheHeaders('suggestions');

/**
 * Middleware to set cache headers for trending endpoint.
 */
export const cacheTrending: RequestHandler = cacheHeaders('trending');

/**
 * Middleware to set cache headers for user-specific endpoints.
 */
export const cacheUserSpecific: RequestHandler = cacheHeaders('user-specific');

/**
 * Middleware to prevent caching for mutation endpoints.
 */
export const noCache: RequestHandler = cacheHeaders('no-cache');

/**
 * Conditional caching based on request parameters.
 * Uses user-specific caching when userId is present, otherwise public caching.
 */
export function conditionalCache(
  publicStrategy: CacheStrategy,
  privateStrategy: CacheStrategy = 'user-specific'
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const hasUserContext = req.query.userId || req.headers.authorization;
    const strategy = hasUserContext ? privateStrategy : publicStrategy;
    cacheHeaders(strategy)(req, res, next);
  };
}
