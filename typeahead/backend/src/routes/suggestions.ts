import express, { Router, Request, Response } from 'express';
import type CircuitBreaker from 'opossum';
import { suggestionRateLimiter, logRateLimiter } from '../shared/rate-limiter.js';
import { createCircuitBreaker } from '../shared/circuit-breaker.js';
import {
  suggestionLatency,
  suggestionRequests,
  queryAnalytics,
  recordCacheHit,
  recordCacheMiss,
} from '../shared/metrics.js';
import logger from '../shared/logger.js';
import {
  conditionalCache,
  cacheTrending,
  cacheUserSpecific,
  cacheSuggestions,
  noCache,
} from '../shared/cache-headers.js';
import type { SuggestionService, SuggestionOptions } from '../services/suggestion-service.js';
import type { RankingService, RankedSuggestion } from '../services/ranking-service.js';
import type { AggregationService } from '../services/aggregation-service.js';

// Extend Express Request locals
declare module 'express-serve-static-core' {
  interface Locals {
    cacheHit?: boolean;
    suggestionCount?: number;
  }
}

const router: Router = express.Router();

// phrase_counts.phrase is VARCHAR(200): longer input can't match, and bounds fuzzy/log work
const MAX_QUERY_LENGTH = 200;
// query_logs.session_id is VARCHAR(100); also bounds the per-user history key
const MAX_ID_LENGTH = 100;
const MAX_LIMIT = 100;

/**
 * Suggestions plus whether they came from the circuit-breaker fallback.
 */
interface CircuitResult {
  suggestions: RankedSuggestion[];
  cached: boolean;
  degraded: boolean;
}

/**
 * Parse an integer query parameter, clamped to [min, max].
 * Missing or non-integer values (abc, 1.5, repeated params) get the fallback.
 */
function parseIntParam(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string' || !/^\s*-?\d+\s*$/.test(value)) {
    return fallback;
  }
  return Math.min(Math.max(Number(value), min), max);
}

/**
 * An optional client identifier: absent, or a string short enough to store.
 */
function isOptionalId(value: unknown): value is string | null | undefined {
  return value == null || (typeof value === 'string' && value.length <= MAX_ID_LENGTH);
}

// Circuit breaker for suggestion service
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let suggestionCircuit: CircuitBreaker<any> | null = null;

/**
 * Initialize circuit breaker lazily (needs access to suggestionService)
 */
function getSuggestionCircuit(
  suggestionService: SuggestionService
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): CircuitBreaker<any> {
  if (!suggestionCircuit) {
    suggestionCircuit = createCircuitBreaker<CircuitResult>(
      'suggestions',
      async (prefix: string, options: SuggestionOptions) => {
        const result = await suggestionService.getSuggestionsWithMeta(prefix, options);
        return { ...result, degraded: false };
      },
      {
        timeout: 100, // 100ms timeout for suggestions
        errorThresholdPercentage: 30,
        resetTimeout: 5000,
        volumeThreshold: 10,
      },
      // Fallback when the circuit is open or the call failed or timed out: an empty result
      // marked degraded, so the route keeps it out of HTTP caches.
      // opossum passes the fire() arguments followed by the error.
      async (_prefix: string, _options: SuggestionOptions, error?: Error & { code?: string }) => {
        const reason =
          error?.code === 'EOPENBREAKER'
            ? 'circuit_open'
            : error?.code === 'ETIMEDOUT'
              ? 'timeout'
              : 'error';
        logger.warn({ event: 'suggestion_fallback', reason, error: error?.message });
        return { suggestions: [], cached: false, degraded: true };
      }
    );
  }
  return suggestionCircuit;
}

/**
 * GET /api/v1/suggestions
 * Get autocomplete suggestions for a prefix.
 *
 * WHY rate limiting: Prevents abuse from bots/scrapers
 * WHY circuit breaker: Protects trie from cascading failures
 * WHY metrics: Enables ranking optimization and SLO monitoring
 *
 * Query params:
 * - q: The search prefix (required; longer than 200 characters returns an empty list)
 * - limit: Max number of suggestions (default: 5, max: 100)
 * - userId: User ID for personalization (optional)
 * - fuzzy: Enable fuzzy matching (default: false)
 *
 * meta.cached reports whether the base list came from Redis. meta.degraded marks a
 * circuit-breaker fallback, which is sent with Cache-Control: no-store.
 */
router.get('/', suggestionRateLimiter, conditionalCache('suggestions'), async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();
  const startTime = Date.now();
  let cacheHit = false;
  let suggestionCount = 0;

  try {
    const { q: prefix, userId, fuzzy = 'false' } = req.query;

    if (!prefix || typeof prefix !== 'string') {
      timer({ endpoint: 'suggestions', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'suggestions', status: 'validation_error' });
      res.status(400).json({
        error: 'Missing or invalid query parameter "q"',
      });
      return;
    }

    // No stored phrase is longer than MAX_QUERY_LENGTH, so a longer prefix simply has no
    // matches. Answer like any other empty result (a 400 would surface as an error in the UI).
    if (prefix.length > MAX_QUERY_LENGTH) {
      timer({ endpoint: 'suggestions', cache_hit: 'false', status: 'success' });
      suggestionRequests.inc({ endpoint: 'suggestions', status: 'too_long' });
      res.json({
        prefix,
        suggestions: [],
        meta: { count: 0, responseTimeMs: Date.now() - startTime, cached: false, degraded: false },
      });
      return;
    }

    const limit = parseIntParam(req.query.limit, 5, 1, MAX_LIMIT);
    // Personalize only for a single, storable id (a repeated ?userId= arrives as an array)
    const personalUserId =
      typeof userId === 'string' && userId.length > 0 && userId.length <= MAX_ID_LENGTH
        ? userId
        : undefined;

    // Track query prefix length for analytics
    queryAnalytics.prefixLength.observe(prefix.length);

    const suggestionService = req.app.get('suggestionService') as SuggestionService;
    const circuit = getSuggestionCircuit(suggestionService);

    let suggestions: RankedSuggestion[];
    let degraded = false;

    if (fuzzy === 'true') {
      // Fuzzy matching bypasses circuit breaker (less critical); it reports no cache status
      suggestions = (await suggestionService.getFuzzySuggestions(prefix, {
        userId: personalUserId,
        limit,
      })) as RankedSuggestion[];
    } else {
      // Use circuit breaker for regular suggestions
      try {
        const result = (await circuit.fire(prefix, {
          userId: personalUserId,
          limit,
        })) as CircuitResult;
        suggestions = result.suggestions;
        cacheHit = result.cached;
        degraded = result.degraded;
      } catch (circuitError) {
        // Only reached if the fallback itself failed
        suggestions = [];
        degraded = true;

        logger.warn({
          event: 'circuit_breaker_triggered',
          prefix: prefix.substring(0, 3),
          error: (circuitError as Error).message,
        });
      }

      // A fallback never reached the cache, so it counts as neither hit nor miss
      if (!degraded) {
        if (cacheHit) {
          recordCacheHit();
        } else {
          recordCacheMiss();
        }
      }
    }

    if (degraded) {
      // Don't let browsers or CDNs keep a fallback's empty list after the service recovers
      res.locals.noStore = true;
    }

    suggestionCount = suggestions.length;
    const responseTime = Date.now() - startTime;

    // Track suggestion count distribution
    queryAnalytics.suggestionCount.observe(suggestionCount);

    // Record metrics
    timer({ endpoint: 'suggestions', cache_hit: String(cacheHit), status: 'success' });
    suggestionRequests.inc({ endpoint: 'suggestions', status: degraded ? 'degraded' : 'success' });

    // Store for HTTP logging
    res.locals.suggestionCount = suggestionCount;
    res.locals.cacheHit = cacheHit;

    res.json({
      prefix,
      suggestions,
      meta: {
        count: suggestionCount,
        responseTimeMs: responseTime,
        cached: cacheHit,
        degraded,
      },
    });
  } catch (error) {
    timer({ endpoint: 'suggestions', cache_hit: String(cacheHit), status: 'error' });
    suggestionRequests.inc({ endpoint: 'suggestions', status: 'error' });

    logger.error({
      event: 'suggestion_error',
      error: (error as Error).message,
      stack: (error as Error).stack,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/v1/suggestions/log
 * Log a completed search (user selected a suggestion or pressed enter).
 * This updates popularity counts and personalization data.
 *
 * Body:
 * - query: The completed search query (required, at most 200 characters)
 * - userId: User ID (optional, at most 100 characters)
 * - sessionId: Session ID (optional, at most 100 characters)
 *
 * Low-quality or blocked queries get 200 with accepted: false and are not counted or
 * added to the user's history.
 */
router.post('/log', logRateLimiter, noCache, async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { query, userId, sessionId } = (req.body ?? {}) as {
      query?: unknown;
      userId?: unknown;
      sessionId?: unknown;
    };

    if (!query || typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) {
      timer({ endpoint: 'log', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'log', status: 'validation_error' });
      res.status(400).json({
        error: `Missing or invalid "query" in request body (at most ${MAX_QUERY_LENGTH} characters)`,
      });
      return;
    }

    if (!isOptionalId(userId) || !isOptionalId(sessionId)) {
      timer({ endpoint: 'log', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'log', status: 'validation_error' });
      res.status(400).json({
        error: `"userId" and "sessionId" must be strings of at most ${MAX_ID_LENGTH} characters`,
      });
      return;
    }

    const aggregationService = req.app.get('aggregationService') as AggregationService;
    const rankingService = req.app.get('rankingService') as RankingService;

    // Process the query (updates counts, trending, logs)
    const { accepted, reason } = await aggregationService.processQuery(
      query,
      userId || null,
      sessionId || null
    );

    // Only queries that were counted go into the user's history
    if (accepted && userId) {
      await rankingService.recordUserSearch(userId, query);
    }

    timer({ endpoint: 'log', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'log', status: accepted ? 'success' : 'rejected' });

    logger.debug({
      event: 'query_logged',
      queryLength: query.length,
      hasUserId: !!userId,
      accepted,
      reason,
    });

    res.json({
      success: true,
      accepted,
      ...(reason ? { reason } : {}),
      message: accepted ? 'Query logged successfully' : 'Query not counted',
    });
  } catch (error) {
    timer({ endpoint: 'log', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'log', status: 'error' });

    logger.error({
      event: 'log_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/v1/suggestions/trending
 * Get currently trending queries.
 *
 * Query params:
 * - limit: Max number of trending queries (default: 10, max: 100)
 */
router.get('/trending', cacheTrending, async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const limit = parseIntParam(req.query.limit, 10, 1, MAX_LIMIT);

    const rankingService = req.app.get('rankingService') as RankingService;
    const { trending, degraded } = await rankingService.getTopTrendingWithStatus(limit);

    if (degraded) {
      // Redis was unreadable: don't let browsers keep this empty list once it recovers
      res.locals.noStore = true;
    }

    timer({ endpoint: 'trending', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'trending', status: degraded ? 'degraded' : 'success' });

    res.json({
      trending,
      meta: {
        count: trending.length,
        degraded,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    timer({ endpoint: 'trending', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'trending', status: 'error' });

    logger.error({
      event: 'trending_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/v1/suggestions/popular
 * Get most popular queries overall.
 *
 * Query params:
 * - limit: Max number of queries (default: 10, max: 100)
 */
router.get('/popular', cacheSuggestions, async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const limit = parseIntParam(req.query.limit, 10, 1, MAX_LIMIT);

    // An empty prefix returns the trie root's top-k: the most popular phrases overall
    const suggestionService = req.app.get('suggestionService') as SuggestionService;
    const popular = await suggestionService.getSuggestions('', { limit });

    timer({ endpoint: 'popular', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'popular', status: 'success' });

    res.json({
      popular,
      meta: {
        count: popular.length,
      },
    });
  } catch (error) {
    timer({ endpoint: 'popular', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'popular', status: 'error' });

    logger.error({
      event: 'popular_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * GET /api/v1/suggestions/history
 * Get user's search history.
 *
 * Query params:
 * - userId: User ID (required, at most 100 characters)
 * - limit: Max number of history items (default: 10, max: 100)
 */
router.get('/history', cacheUserSpecific, async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { userId } = req.query;

    if (!userId || typeof userId !== 'string' || userId.length > MAX_ID_LENGTH) {
      timer({ endpoint: 'history', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'history', status: 'validation_error' });
      res.status(400).json({
        error: 'Missing or invalid userId parameter',
      });
      return;
    }

    const limit = parseIntParam(req.query.limit, 10, 1, MAX_LIMIT);
    const rankingService = req.app.get('rankingService') as RankingService;
    const history = await rankingService.getUserHistory(userId, limit);

    timer({ endpoint: 'history', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'history', status: 'success' });

    res.json({
      history,
      meta: {
        count: history.length,
        userId,
      },
    });
  } catch (error) {
    timer({ endpoint: 'history', cache_hit: 'false', status: 'error' });
    suggestionRequests.inc({ endpoint: 'history', status: 'error' });

    logger.error({
      event: 'history_error',
      error: (error as Error).message,
    });

    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

export default router;
