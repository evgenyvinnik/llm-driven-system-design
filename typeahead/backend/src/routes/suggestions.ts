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
    suggestionCircuit = createCircuitBreaker<RankedSuggestion[]>(
      'suggestions',
      async (prefix: string, options: SuggestionOptions) => {
        return suggestionService.getSuggestions(prefix, options);
      },
      {
        timeout: 100, // 100ms timeout for suggestions
        errorThresholdPercentage: 30,
        resetTimeout: 5000,
        volumeThreshold: 10,
      },
      // Fallback: return empty array when circuit is open
      async () => {
        logger.warn({ event: 'suggestion_fallback', reason: 'circuit_open' });
        return [];
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
 * - q: The search prefix (required)
 * - limit: Max number of suggestions (default: 5)
 * - userId: User ID for personalization (optional)
 * - fuzzy: Enable fuzzy matching (default: false)
 */
router.get('/', suggestionRateLimiter, conditionalCache('suggestions'), async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();
  const startTime = Date.now();
  let cacheHit = false;
  let suggestionCount = 0;

  try {
    const { q: prefix, limit = '5', userId, fuzzy = 'false' } = req.query;

    if (!prefix || typeof prefix !== 'string') {
      timer({ endpoint: 'suggestions', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'suggestions', status: 'validation_error' });
      res.status(400).json({
        error: 'Missing or invalid query parameter "q"',
      });
      return;
    }

    // Track query prefix length for analytics
    queryAnalytics.prefixLength.observe(prefix.length);

    const suggestionService = req.app.get('suggestionService') as SuggestionService;
    const circuit = getSuggestionCircuit(suggestionService);

    let suggestions: RankedSuggestion[];

    if (fuzzy === 'true') {
      // Fuzzy matching bypasses circuit breaker (less critical)
      suggestions = (await suggestionService.getFuzzySuggestions(prefix, {
        userId: userId as string | undefined,
        limit: parseInt(limit as string),
      })) as RankedSuggestion[];
    } else {
      // Use circuit breaker for regular suggestions
      try {
        suggestions = await circuit.fire(
          prefix,
          { userId: userId as string | undefined, limit: parseInt(limit as string) }
        ) as RankedSuggestion[];
      } catch (circuitError) {
        // Circuit breaker fallback already triggered
        suggestions = [];

        logger.warn({
          event: 'circuit_breaker_triggered',
          prefix: prefix.substring(0, 3),
          error: (circuitError as Error).message,
        });
      }
    }

    // Track if we got a cache hit (from suggestion service internals)
    // This is approximated - in production, the service would report this
    cacheHit = res.locals.cacheHit || false;
    if (cacheHit) {
      recordCacheHit();
    } else {
      recordCacheMiss();
    }

    suggestionCount = suggestions.length;
    const responseTime = Date.now() - startTime;

    // Track suggestion count distribution
    queryAnalytics.suggestionCount.observe(suggestionCount);

    // Record metrics
    timer({ endpoint: 'suggestions', cache_hit: String(cacheHit), status: 'success' });
    suggestionRequests.inc({ endpoint: 'suggestions', status: 'success' });

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
      message: (error as Error).message,
    });
  }
});

/**
 * POST /api/v1/suggestions/log
 * Log a completed search (user selected a suggestion or pressed enter).
 * This updates popularity counts and personalization data.
 *
 * Body:
 * - query: The completed search query (required)
 * - userId: User ID (optional)
 * - sessionId: Session ID (optional)
 */
router.post('/log', logRateLimiter, noCache, async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { query, userId, sessionId } = req.body as {
      query?: string;
      userId?: string;
      sessionId?: string;
    };

    if (!query || typeof query !== 'string') {
      timer({ endpoint: 'log', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'log', status: 'validation_error' });
      res.status(400).json({
        error: 'Missing or invalid "query" in request body',
      });
      return;
    }

    const aggregationService = req.app.get('aggregationService') as AggregationService;
    const rankingService = req.app.get('rankingService') as RankingService;

    // Process the query (updates counts, trending, logs)
    await aggregationService.processQuery(query, userId || null, sessionId || null);

    // Update user history if userId provided
    if (userId) {
      await rankingService.recordUserSearch(userId, query);
    }

    timer({ endpoint: 'log', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'log', status: 'success' });

    logger.debug({
      event: 'query_logged',
      queryLength: query.length,
      hasUserId: !!userId,
    });

    res.json({
      success: true,
      message: 'Query logged successfully',
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
      message: (error as Error).message,
    });
  }
});

/**
 * GET /api/v1/suggestions/trending
 * Get currently trending queries.
 *
 * Query params:
 * - limit: Max number of trending queries (default: 10)
 */
router.get('/trending', cacheTrending, async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { limit = '10' } = req.query;

    const rankingService = req.app.get('rankingService') as RankingService;
    const trending = await rankingService.getTopTrending(parseInt(limit as string));

    timer({ endpoint: 'trending', cache_hit: 'false', status: 'success' });
    suggestionRequests.inc({ endpoint: 'trending', status: 'success' });

    res.json({
      trending,
      meta: {
        count: trending.length,
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
      message: (error as Error).message,
    });
  }
});

/**
 * GET /api/v1/suggestions/popular
 * Get most popular queries overall.
 *
 * Query params:
 * - limit: Max number of queries (default: 10)
 */
router.get('/popular', cacheSuggestions, async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { limit = '10' } = req.query;

    const suggestionService = req.app.get('suggestionService') as SuggestionService;
    const popular = await suggestionService.getSuggestions('', {
      limit: parseInt(limit as string),
    });

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
      message: (error as Error).message,
    });
  }
});

/**
 * GET /api/v1/suggestions/history
 * Get user's search history.
 *
 * Query params:
 * - userId: User ID (required)
 * - limit: Max number of history items (default: 10)
 */
router.get('/history', cacheUserSpecific, async (req: Request, res: Response) => {
  const timer = suggestionLatency.startTimer();

  try {
    const { userId, limit = '10' } = req.query;

    if (!userId) {
      timer({ endpoint: 'history', cache_hit: 'false', status: 'error' });
      suggestionRequests.inc({ endpoint: 'history', status: 'validation_error' });
      res.status(400).json({
        error: 'Missing userId parameter',
      });
      return;
    }

    const rankingService = req.app.get('rankingService') as RankingService;
    const history = await rankingService.getUserHistory(userId as string, parseInt(limit as string));

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
      message: (error as Error).message,
    });
  }
});

export default router;
