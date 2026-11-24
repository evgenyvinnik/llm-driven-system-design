/**
 * @fileoverview Robots.txt Service for respecting web crawling policies.
 *
 * This service implements the Robots Exclusion Protocol (robots.txt) which is
 * the standard way for websites to communicate their crawling preferences.
 * A well-behaved crawler must check and respect robots.txt before crawling any URL.
 *
 * Key responsibilities:
 * - Fetching robots.txt from domains (with HTTP fallback)
 * - Parsing robot directives using the robots-parser library
 * - Multi-level caching (in-memory, Redis, PostgreSQL)
 * - Extracting crawl delay and sitemap information
 * - Checking if specific URLs are allowed to be crawled
 *
 * Caching strategy:
 * 1. In-memory cache (fastest, process-local, lost on restart)
 * 2. Redis cache (fast, shared across workers, with TTL)
 * 3. PostgreSQL (durable, survives restarts, for historical reference)
 *
 * @module services/robots
 */

import axios from 'axios';
import robotsParser from 'robots-parser';
import { redis, REDIS_KEYS } from '../models/redis.js';
import { pool } from '../models/database.js';
import { config } from '../config.js';

/** RFC 9309 requires parsing at least 500 KiB; anything larger is truncated/ignored. */
const MAX_ROBOTS_BYTES = 512 * 1024;
/** How long an unreachable robots.txt is negatively cached in memory. */
const UNREACHABLE_CACHE_MS = 60 * 1000;
/** Upper bound on honored Crawl-delay values (seconds). */
const MAX_CRAWL_DELAY_SECONDS = 60;

export type RobotsFetchResult =
  | { kind: 'ok'; body: string }
  | { kind: 'missing' }
  | { kind: 'unreachable' };

export type RobotsAccess = 'allowed' | 'disallowed' | 'unavailable';

/**
 * Robots.txt Service - fetches, parses, and caches robots.txt for domains.
 *
 * This service is critical for "crawl politeness" - ensuring the crawler
 * respects website owners' wishes about what should and shouldn't be crawled.
 * Ignoring robots.txt can lead to being blocked or legal issues.
 *
 * @example
 * ```typescript
 * import { robotsService } from './services/robots';
 *
 * // Check if a URL is allowed before crawling
 * const allowed = await robotsService.isAllowed('https://example.com/page', 'example.com');
 * if (allowed) {
 *   // Proceed with crawling
 * }
 *
 * // Get the crawl delay for a domain
 * const delay = await robotsService.getCrawlDelay('example.com');
 * ```
 */
export class RobotsService {
  /**
   * In-memory cache for robots.txt parsers.
   * Provides O(1) access for frequently accessed domains without any network/Redis calls.
   * Cache entries include the parser and fetch timestamp for TTL-based invalidation.
   */
  private cache: Map<
    string,
    {
      /** Raw robots.txt body; null = unreachable (negative cache entry) */
      content: string | null;
      /** Parsers built from `content`, keyed by URL scheme (see parserFor) */
      parsers: Map<string, ReturnType<typeof robotsParser>>;
      expiresAt: number;
    }
  > = new Map();

  /**
   * Fetches robots.txt for a domain, following RFC 9309 status semantics.
   *
   * - 2xx: rules apply                         -> { kind: 'ok', body }
   * - 4xx (incl. 404): no restrictions         -> { kind: 'missing' }
   * - 5xx / network error on both schemes:     -> { kind: 'unreachable' }
   *
   * "Unreachable" must NOT be treated as "allow everything": a server that
   * is erroring is exactly the one we should not be hammering. The crawler
   * defers URLs for such domains and retries later.
   *
   * HTTPS is tried first; HTTP is tried only if HTTPS could not be reached at
   * all (connection error), not when HTTPS answered with a status code.
   */
  async fetchRobotsTxt(domain: string): Promise<RobotsFetchResult> {
    const attempt = async (scheme: 'https' | 'http'): Promise<RobotsFetchResult | null> => {
      try {
        const response = await axios.get(`${scheme}://${domain}/robots.txt`, {
          timeout: 10000,
          maxRedirects: 5,
          maxContentLength: MAX_ROBOTS_BYTES,
          responseType: 'text',
          headers: { 'User-Agent': config.crawler.userAgent },
          validateStatus: () => true,
        });
        if (response.status >= 200 && response.status < 300) {
          const body = typeof response.data === 'string' ? response.data : '';
          return { kind: 'ok', body };
        }
        if (response.status >= 400 && response.status < 500) {
          return { kind: 'missing' };
        }
        return { kind: 'unreachable' };
      } catch {
        return null; // could not connect on this scheme
      }
    };

    return (await attempt('https')) ?? (await attempt('http')) ?? { kind: 'unreachable' };
  }

  /**
   * Gets or fetches a robots.txt parser for a domain.
   *
   * Cache hierarchy: in-memory (per worker) -> Redis (shared, TTL) -> network.
   * On a successful or 4xx fetch the result is cached for `robotsTxtCacheTtl`,
   * persisted to PostgreSQL, and the Crawl-delay is published to Redis for
   * the frontier's politeness lock.
   *
   * @returns Parser, or null if robots.txt is currently unreachable (5xx/network)
   */
  async getParser(
    domain: string,
    scheme: 'http' | 'https' = 'https'
  ): Promise<ReturnType<typeof robotsParser> | null> {
    const now = Date.now();

    const cached = this.cache.get(domain);
    if (cached && now < cached.expiresAt) {
      return cached.content === null ? null : this.parserFor(cached, domain, scheme);
    }

    const redisCached = await redis.get(REDIS_KEYS.DOMAIN_ROBOTS(domain));
    if (redisCached !== null) {
      const entry = {
        content: redisCached,
        parsers: new Map(),
        expiresAt: now + config.crawler.robotsTxtCacheTtl * 1000,
      };
      this.cache.set(domain, entry);
      return this.parserFor(entry, domain, scheme);
    }

    const fetched = await this.fetchRobotsTxt(domain);
    if (fetched.kind === 'unreachable') {
      // Negative-cache briefly so every URL of a down domain doesn't trigger
      // its own robots.txt fetch.
      this.cache.set(domain, {
        content: null,
        parsers: new Map(),
        expiresAt: now + UNREACHABLE_CACHE_MS,
      });
      return null;
    }

    const robotsContent = fetched.kind === 'ok' ? fetched.body : '';
    const entry = {
      content: robotsContent,
      parsers: new Map(),
      expiresAt: now + config.crawler.robotsTxtCacheTtl * 1000,
    };
    const parser = this.parserFor(entry, domain, scheme);

    await redis.setex(
      REDIS_KEYS.DOMAIN_ROBOTS(domain),
      config.crawler.robotsTxtCacheTtl,
      robotsContent
    );
    this.cache.set(domain, entry);

    // Crawl-delay from robots.txt, falling back to the configured default.
    // Capped so a hostile/mistaken "Crawl-delay: 86400" can't pin a worker lock for a day.
    const declared = parser.getCrawlDelay(config.crawler.userAgent);
    const crawlDelay = Math.min(
      MAX_CRAWL_DELAY_SECONDS,
      declared && declared > 0 ? declared : config.crawler.defaultDelay / 1000
    );
    await redis.set(REDIS_KEYS.DOMAIN_DELAY(domain), crawlDelay.toString());

    await pool.query(
      `INSERT INTO domains (domain, robots_txt, robots_fetched_at, crawl_delay)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (domain) DO UPDATE SET
         robots_txt = EXCLUDED.robots_txt,
         robots_fetched_at = NOW(),
         crawl_delay = EXCLUDED.crawl_delay,
         updated_at = NOW()`,
      [domain, robotsContent, crawlDelay]
    );

    return parser;
  }

  /**
   * Returns (and memoizes) a parser for one scheme.
   *
   * robots-parser only answers for URLs on the same origin as the robots.txt
   * URL it was constructed with - for any other origin `isAllowed()` returns
   * undefined. The original code always constructed it with `https://`, so
   * every `http://` page got `undefined`, which was treated as "allowed":
   * robots.txt was silently ignored for all plain-HTTP sites.
   */
  private parserFor(
    entry: { content: string | null; parsers: Map<string, ReturnType<typeof robotsParser>> },
    domain: string,
    scheme: 'http' | 'https'
  ): ReturnType<typeof robotsParser> {
    let parser = entry.parsers.get(scheme);
    if (!parser) {
      parser = robotsParser(`${scheme}://${domain}/robots.txt`, entry.content ?? '');
      entry.parsers.set(scheme, parser);
    }
    return parser;
  }

  /**
   * Three-way robots.txt check used by the crawler.
   *
   * @returns 'allowed', 'disallowed', or 'unavailable' (robots.txt could not
   *          be fetched due to 5xx/network errors - caller should retry later)
   */
  async checkAccess(url: string, domain: string): Promise<RobotsAccess> {
    const scheme = url.startsWith('http:') ? 'http' : 'https';
    const parser = await this.getParser(domain, scheme);
    if (!parser) return 'unavailable';
    return parser.isAllowed(url, config.crawler.userAgent) === false ? 'disallowed' : 'allowed';
  }

  /**
   * Boolean convenience wrapper: true only if robots.txt was fetched and
   * allows the URL. Unavailable robots.txt counts as not allowed (fail closed).
   */
  async isAllowed(url: string, domain: string): Promise<boolean> {
    try {
      return (await this.checkAccess(url, domain)) === 'allowed';
    } catch (error) {
      console.error(`Error checking robots.txt for ${url}:`, error);
      return false;
    }
  }

  /**
   * Gets the crawl delay for a domain.
   *
   * Crawl delay specifies the minimum time (in seconds) between requests
   * to the same domain. This is extracted from the robots.txt Crawl-delay
   * directive if present, otherwise the default delay is used.
   *
   * @param domain - The domain to get crawl delay for
   * @returns Crawl delay in seconds
   *
   * @example
   * ```typescript
   * const delay = await robotsService.getCrawlDelay('example.com');
   * console.log(`Wait ${delay} seconds between requests`);
   * ```
   */
  async getCrawlDelay(domain: string): Promise<number> {
    // Check Redis cache first
    const cached = await redis.get(REDIS_KEYS.DOMAIN_DELAY(domain));
    if (cached) {
      return parseFloat(cached);
    }

    // Fetch robots.txt if not cached
    const parser = await this.getParser(domain);
    if (parser) {
      const delay = parser.getCrawlDelay(config.crawler.userAgent);
      if (delay) {
        await redis.set(REDIS_KEYS.DOMAIN_DELAY(domain), delay.toString());
        return delay;
      }
    }

    return config.crawler.defaultDelay / 1000; // Convert ms to seconds
  }

  /**
   * Gets sitemap URLs declared in robots.txt.
   *
   * Many robots.txt files declare sitemap locations which provide a list
   * of all URLs on the site. This can be used to seed the crawler with
   * a complete list of pages without having to discover them through crawling.
   *
   * @param domain - The domain to get sitemaps for
   * @returns Array of sitemap URLs declared in robots.txt
   *
   * @example
   * ```typescript
   * const sitemaps = await robotsService.getSitemaps('example.com');
   * // Returns: ['https://example.com/sitemap.xml']
   * ```
   */
  async getSitemaps(domain: string): Promise<string[]> {
    const parser = await this.getParser(domain);
    if (!parser) {
      return [];
    }

    return parser.getSitemaps();
  }

  /**
   * Clears cached robots.txt data for a domain.
   *
   * Use this to force a fresh fetch of robots.txt, for example when:
   * - The site owner has updated their robots.txt
   * - Cache data appears stale or corrupt
   * - Debugging crawl permission issues
   *
   * @param domain - The domain to clear cache for
   */
  async clearCache(domain: string): Promise<void> {
    this.cache.delete(domain);
    // Awaited so a getParser() call right after this cannot read the old Redis copy
    await redis.del(REDIS_KEYS.DOMAIN_ROBOTS(domain), REDIS_KEYS.DOMAIN_DELAY(domain));
  }
}

/**
 * Singleton instance of the RobotsService.
 * Use this export for all robots.txt operations to share the in-memory cache.
 */
export const robotsService = new RobotsService();
