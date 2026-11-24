/**
 * @fileoverview Crawler Worker Service for fetching and processing web pages.
 *
 * This service contains the core crawling logic for a distributed web crawler worker.
 * Each worker runs independently, fetching URLs from the frontier, downloading pages,
 * extracting content and links, and storing results.
 *
 * Key responsibilities:
 * - Main crawl loop with error recovery
 * - HTTP request handling with timeouts and size limits
 * - HTML parsing and link extraction using Cheerio
 * - Content hashing for duplicate detection
 * - Worker registration and heartbeat for health monitoring
 * - Statistics tracking via Redis counters
 * - Circuit breaker for failing domains
 * - Retry with exponential backoff for transient failures
 * - Structured logging for observability
 * - Prometheus metrics for monitoring
 *
 * A typical crawl cycle:
 * 1. Get next URL from frontier (respects priority and rate limits)
 * 2. Check if domain circuit breaker is open (skip if failing)
 * 3. Check robots.txt permissions
 * 4. Fetch page content via HTTP with retry/circuit breaker
 * 5. Parse HTML and extract metadata (title, description)
 * 6. Extract and normalize links for the frontier
 * 7. Store results in PostgreSQL
 * 8. Mark URL as completed and update stats/metrics
 *
 * @module services/crawler
 */

import axios, { AxiosResponse, AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import { pool } from '../models/database.js';
import { redis, REDIS_KEYS } from '../models/redis.js';
import { frontierService, FrontierUrl } from './frontier.js';
import { robotsService } from './robots.js';
import {
  extractDomain,
  resolveUrl,
  shouldCrawl,
  normalizeUrl,
  hashContent,
} from '../utils/url.js';
import { config } from '../config.js';
import { createWorkerLogger } from '../shared/logger.js';
import {
  recordCrawl,
  recordError,
  activeWorkersGauge,
} from '../shared/metrics.js';
import {
  withResilience,
  isCircuitOpen,
  isCircuitOpenError,
  isRetryableError,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
} from '../shared/resilience.js';
import type pino from 'pino';

/** How long a graceful stop waits for the in-flight crawl before giving up. */
const STOP_TIMEOUT_MS = 45000;
/** Upper bound on how long an in-process retry waits for the domain lock. */
const POLITENESS_WAIT_MS = 15000;

/**
 * Result of crawling a single URL.
 * Contains all extracted data and metadata about the crawl operation.
 */
export interface CrawlResult {
  /** The original URL that was crawled */
  url: string;
  /** SHA-256 hash of the normalized URL */
  urlHash: string;
  /** HTTP status code (0 if request failed) */
  statusCode: number;
  /** Content-Type header value */
  contentType: string;
  /** Size of the content in bytes */
  contentLength: number;
  /** SHA-256 hash of the content for duplicate detection */
  contentHash: string;
  /** Extracted page title */
  title: string;
  /** Extracted meta description */
  description: string;
  /** Array of normalized URLs extracted from the page */
  linksFound: string[];
  /** Time taken to crawl in milliseconds */
  crawlDurationMs: number;
  /** Error message if crawl failed */
  error?: string;
  /** Number of retry attempts made */
  retryAttempts?: number;
  /**
   * True if the failure is transient (timeout, connection reset, 5xx, 429,
   * robots.txt unreachable) and the URL should be rescheduled rather than
   * marked permanently failed.
   */
  retryable?: boolean;
  /** Minimum delay before retrying (from a Retry-After header) */
  retryAfterMs?: number;
  /** Absolute redirect target for 3xx responses */
  redirectTo?: string;
}

/**
 * Crawler Worker Service - the workhorse of the distributed web crawler.
 *
 * Each CrawlerService instance represents a single worker process that:
 * - Runs continuously, fetching and processing URLs
 * - Registers itself with Redis for monitoring
 * - Sends periodic heartbeats to indicate health
 * - Respects politeness rules (robots.txt, rate limiting)
 * - Uses circuit breakers to skip failing domains
 * - Retries transient failures with exponential backoff
 * - Emits structured logs and Prometheus metrics
 *
 * Workers are stateless and horizontally scalable - you can run as many
 * as needed to increase crawl throughput.
 *
 * @example
 * ```typescript
 * import { CrawlerService } from './services/crawler';
 *
 * const crawler = new CrawlerService('worker-1');
 * await crawler.start();
 *
 * // On shutdown
 * await crawler.stop();
 * ```
 */
export class CrawlerService {
  /** Unique identifier for this worker instance */
  private workerId: string;
  /** Whether the crawl loop is running */
  private isRunning: boolean = false;
  /** Total number of pages crawled by this worker */
  private crawlCount: number = 0;
  /** Unix timestamp when worker started */
  private startTime: number = 0;
  /** Structured logger for this worker */
  private logger: pino.Logger;
  /** Heartbeat interval handle */
  private heartbeatInterval: NodeJS.Timeout | null = null;
  /** Resolves when the crawl loop has exited (used for graceful shutdown) */
  private loopDone: Promise<void> | null = null;

  /**
   * Creates a new CrawlerService instance.
   *
   * @param workerId - Unique identifier for this worker (e.g., 'worker-1')
   */
  constructor(workerId: string) {
    this.workerId = workerId;
    this.logger = createWorkerLogger(workerId);
  }

  /**
   * Starts the crawler worker.
   *
   * Registers the worker, starts the heartbeat, and runs the crawl loop until
   * stop() is called. Resolves once the loop has exited.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.startTime = Date.now();
    this.logger.info('Crawler worker starting');

    await this.registerWorker();
    this.startHeartbeat();

    this.loopDone = this.runLoop();
    await this.loopDone;
  }

  private async runLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.crawlNext();
      } catch (error) {
        this.logger.error({ err: error }, 'Crawler loop error');
        recordError(this.workerId, 'loop_error');
        await this.sleep(1000);
      }
    }
  }

  /**
   * Stops the crawler worker gracefully.
   *
   * Clears the running flag and **waits for the in-flight crawl to finish**
   * (bounded by STOP_TIMEOUT_MS) before unregistering. Without the wait, the
   * caller would close the DB pool mid-crawl, the final status UPDATE would
   * fail, and the URL would sit in in_progress until lease recovery.
   */
  async stop(): Promise<void> {
    this.logger.info('Crawler worker stopping');
    this.isRunning = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.loopDone) {
      await Promise.race([this.loopDone, this.sleep(STOP_TIMEOUT_MS)]);
    }

    await this.unregisterWorker();
    this.logger.info({ crawlCount: this.crawlCount }, 'Crawler worker stopped');
  }

  /**
   * Registers this worker as active in Redis.
   */
  private async registerWorker(): Promise<void> {
    await redis.sadd(REDIS_KEYS.ACTIVE_WORKERS, this.workerId);
    await redis.set(REDIS_KEYS.WORKER_HEARTBEAT(this.workerId), Date.now().toString());

    const workerCount = await redis.scard(REDIS_KEYS.ACTIVE_WORKERS);
    activeWorkersGauge.set(workerCount);

    this.logger.debug('Worker registered');
  }

  /**
   * Unregisters this worker from Redis.
   */
  private async unregisterWorker(): Promise<void> {
    await redis.srem(REDIS_KEYS.ACTIVE_WORKERS, this.workerId);
    await redis.del(REDIS_KEYS.WORKER_HEARTBEAT(this.workerId));

    const workerCount = await redis.scard(REDIS_KEYS.ACTIVE_WORKERS);
    activeWorkersGauge.set(workerCount);

    this.logger.debug('Worker unregistered');
  }

  /**
   * Updates the heartbeat timestamp every 5 seconds.
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(async () => {
      if (this.isRunning) {
        try {
          await redis.set(REDIS_KEYS.WORKER_HEARTBEAT(this.workerId), Date.now().toString());
        } catch (error) {
          this.logger.warn({ err: error }, 'Heartbeat update failed');
        }
      }
    }, 5000);
  }

  /**
   * Main crawl cycle - claims the next URL and drives it to a terminal or
   * rescheduled state.
   *
   * Outcome handling:
   * - success              -> markCompleted, enqueue links (unless duplicate content)
   * - 3xx redirect         -> markCompleted, enqueue the redirect target as a new
   *                           URL so it goes through dedup, robots and politeness
   * - transient failure    -> scheduleRetry (exponential backoff, then failed)
   * - permanent failure    -> markFailed (404, robots disallow, non-HTML, ...)
   * - circuit open         -> deferUrl (no attempt counted; nothing was fetched)
   */
  async crawlNext(): Promise<void> {
    const frontierUrl = await frontierService.getNextUrl(this.workerId);

    if (!frontierUrl) {
      await this.sleep(500);
      return;
    }

    const { url, urlHash, domain, priority } = frontierUrl;
    const crawlLogger = this.logger.child({ url, domain, urlHash });

    // Another worker opened this domain's breaker: put the URL back instead of
    // failing it permanently - the domain is expected to recover.
    try {
      if (await isCircuitOpen(domain)) {
        crawlLogger.debug('Domain circuit breaker is open, deferring');
        await frontierService.deferUrl(
          urlHash,
          priority,
          DEFAULT_CIRCUIT_BREAKER_CONFIG.resetTimeoutMs
        );
        recordCrawl(this.workerId, 'blocked', 0, 0, 0);
        return;
      }
    } catch (error) {
      crawlLogger.warn({ err: error }, 'Failed to check circuit breaker');
    }

    try {
      crawlLogger.debug('Starting crawl');
      const result = await this.crawlUrl(frontierUrl);

      const metricStatus = result.error
        ? result.error.startsWith('Blocked')
          ? 'blocked'
          : 'failed'
        : 'success';
      recordCrawl(
        this.workerId,
        metricStatus,
        result.crawlDurationMs,
        result.contentLength,
        result.linksFound.length,
        result.statusCode || undefined
      );

      await this.storeCrawlResult(result);

      if (result.error) {
        if (result.retryable) {
          const outcome = await frontierService.scheduleRetry(
            urlHash,
            result.error,
            result.retryAfterMs ?? 0
          );
          if (outcome === 'failed') {
            await redis.incr(REDIS_KEYS.STATS_PAGES_FAILED);
          }
          crawlLogger.warn({ error: result.error, outcome }, 'Transient crawl failure');
        } else {
          await frontierService.markFailed(urlHash, result.error);
          await redis.incr(REDIS_KEYS.STATS_PAGES_FAILED);
          crawlLogger.warn({ error: result.error }, 'Crawl failed');
        }
        this.crawlCount++;
        return;
      }

      if (result.redirectTo) {
        // A redirect hop does not add depth: it is the same logical page.
        await frontierService.addUrls([result.redirectTo], {
          depth: frontierUrl.depth,
          priority,
        });
        await frontierService.markCompleted(urlHash);
        crawlLogger.info(
          { statusCode: result.statusCode, redirectTo: result.redirectTo },
          'Redirect followed via frontier'
        );
        this.crawlCount++;
        return;
      }

      // Exact-duplicate content (mirrors, URL aliases, session-id variants):
      // the page is recorded, but its links were already enqueued from the
      // first copy, so don't pay to re-insert them.
      let duplicateContent = false;
      if (result.contentHash) {
        const isNew = await redis.sadd(REDIS_KEYS.CONTENT_HASHES, result.contentHash);
        duplicateContent = isNew === 0;
        if (duplicateContent) {
          await redis.incr(REDIS_KEYS.STATS_DUPLICATE_CONTENT);
        }
      }

      if (!duplicateContent && result.linksFound.length > 0) {
        await frontierService.addUrls(result.linksFound, {
          depth: (frontierUrl.depth || 0) + 1,
        });
      }

      await frontierService.markCompleted(urlHash);
      await redis.incr(REDIS_KEYS.STATS_PAGES_CRAWLED);
      await redis.incrby(REDIS_KEYS.STATS_BYTES_DOWNLOADED, result.contentLength);
      crawlLogger.info(
        {
          statusCode: result.statusCode,
          contentLength: result.contentLength,
          linksFound: result.linksFound.length,
          duplicateContent,
          durationMs: result.crawlDurationMs,
        },
        'Crawl completed'
      );

      this.crawlCount++;
    } catch (error) {
      // Unexpected error (DB/Redis hiccup, parser crash): treat as transient.
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorType = isCircuitOpenError(error)
        ? 'circuit_open'
        : isRetryableError(error)
          ? 'network_error'
          : 'unknown_error';

      crawlLogger.error({ err: error, errorType }, 'Crawl failed with exception');
      recordError(this.workerId, errorType);

      try {
        const outcome = await frontierService.scheduleRetry(urlHash, errorMessage);
        if (outcome === 'failed') {
          await redis.incr(REDIS_KEYS.STATS_PAGES_FAILED);
        }
      } catch (rescheduleError) {
        // Leave it in_progress; lease recovery will return it to the queue.
        crawlLogger.error({ err: rescheduleError }, 'Failed to reschedule URL');
      }
    }
  }

  /**
   * Crawls a single URL and extracts content.
   *
   * 1. Operator block + robots.txt check
   * 2. HTTP GET with retry/circuit breaker and **no automatic redirects**
   * 3. Classify the response (2xx / 3xx / 4xx / 429 / non-HTML)
   * 4. Parse HTML, extract metadata and links (honoring <base>, nofollow)
   */
  async crawlUrl(frontierUrl: FrontierUrl): Promise<CrawlResult> {
    const { url, urlHash, domain } = frontierUrl;
    const startTime = Date.now();

    const fail = (
      error: string,
      extra: Partial<CrawlResult> = {}
    ): CrawlResult => ({
      url,
      urlHash,
      statusCode: 0,
      contentType: '',
      contentLength: 0,
      contentHash: '',
      title: '',
      description: '',
      linksFound: [],
      crawlDurationMs: Date.now() - startTime,
      error,
      ...extra,
    });

    if (await redis.exists(REDIS_KEYS.DOMAIN_BLOCKED(domain))) {
      return fail('Blocked by operator');
    }

    const access = await robotsService.checkAccess(url, domain);
    if (access === 'disallowed') {
      return fail('Blocked by robots.txt');
    }
    if (access === 'unavailable') {
      // RFC 9309: an unreachable robots.txt (5xx / network) means "assume
      // complete disallow for now" - retry later rather than crawl blind.
      return fail('robots.txt unavailable', { retryable: true });
    }

    let response: AxiosResponse;
    let retryAttempts = 0;

    try {
      response = await withResilience(
        domain,
        async () => {
          retryAttempts++;
          // A retry is a new request to the host, so it must wait for the
          // domain's politeness slot like any other fetch. (Without this, the
          // retry fired after cockatiel's jittered backoff - sometimes a few ms
          // after another worker's request to the same host.)
          if (retryAttempts > 1) {
            await this.waitForDomainSlot(domain);
          }
          return axios.get(url, {
            timeout: config.crawler.requestTimeout,
            maxContentLength: config.crawler.maxPageSize,
            // Redirects are surfaced to the frontier instead of being followed
            // here. axios would otherwise follow up to 5 hops to *any* host,
            // bypassing robots.txt and politeness for the target, and we would
            // resolve relative links against the wrong base URL.
            maxRedirects: 0,
            headers: {
              'User-Agent': config.crawler.userAgent,
              Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
              'Accept-Language': 'en-US,en;q=0.5',
              'Accept-Encoding': 'gzip, deflate',
            },
            responseType: 'text',
            validateStatus: (status) => status < 500, // 5xx throws -> retried
          });
        },
        // cockatiel's maxAttempts counts *retries*: 1 => at most 2 requests.
        // One quick in-process retry absorbs blips; longer outages are handled
        // by frontier-level backoff, which releases the worker and respects
        // the domain's politeness lock between attempts.
        { ...DEFAULT_RETRY_CONFIG, maxAttempts: 1 },
        DEFAULT_CIRCUIT_BREAKER_CONFIG
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      const errorCode = (error as AxiosError)?.code;
      return fail(errorCode ? `${errorMessage} (${errorCode})` : errorMessage, {
        statusCode: (error as AxiosError)?.response?.status ?? 0,
        retryAttempts,
        retryable:
          isRetryableError(error) ||
          isCircuitOpenError(error) ||
          (error as { code?: string })?.code === 'EPOLITENESS',
      });
    }

    const statusCode = response.status;
    // Axios types headers loosely; normalize to string.
    const contentType = String(response.headers['content-type'] ?? '');

    if (statusCode >= 300 && statusCode < 400) {
      const location = response.headers['location'];
      const target = typeof location === 'string' ? resolveUrl(url, location) : null;
      if (!target || normalizeUrl(target) === url) {
        return fail(`HTTP ${statusCode} without usable Location`, { statusCode, retryAttempts });
      }
      return {
        url,
        urlHash,
        statusCode,
        contentType,
        contentLength: 0,
        contentHash: '',
        title: '',
        description: '',
        linksFound: [],
        crawlDurationMs: Date.now() - startTime,
        retryAttempts,
        redirectTo: target,
      };
    }

    if (statusCode === 429 || statusCode === 408) {
      return fail(`HTTP ${statusCode}`, {
        statusCode,
        contentType,
        retryAttempts,
        retryable: true,
        retryAfterMs: parseRetryAfter(response.headers['retry-after']),
      });
    }

    if (statusCode >= 400) {
      return fail(`HTTP ${statusCode}`, { statusCode, contentType, retryAttempts });
    }

    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return fail('Not HTML content', { statusCode, contentType, retryAttempts });
    }

    const html = typeof response.data === 'string' ? response.data : '';
    const contentLength = Buffer.byteLength(html, 'utf8');
    const contentHash = hashContent(html);

    const $ = cheerio.load(html);

    const title =
      $('title').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      '';
    const description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      '';

    const linksFound = extractLinks($, url);

    return {
      url,
      urlHash,
      statusCode,
      contentType,
      contentLength,
      contentHash,
      title: title.substring(0, 500),
      description: description.substring(0, 1000),
      linksFound,
      crawlDurationMs: Date.now() - startTime,
      retryAttempts,
    };
  }

  /**
   * Stores crawl results in the PostgreSQL database.
   *
   * Inserts or updates the crawled_pages table with all extracted metadata.
   * Uses ON CONFLICT to handle re-crawls of the same URL.
   * Also increments the domain's page count.
   *
   * @param result - The CrawlResult to store
   */
  async storeCrawlResult(result: CrawlResult): Promise<void> {
    const domain = extractDomain(result.url);

    await pool.query(
      `INSERT INTO crawled_pages
       (url, url_hash, domain, status_code, content_type, content_length, content_hash, title, description, links_count, crawl_duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (url_hash) DO UPDATE SET
         status_code = EXCLUDED.status_code,
         content_type = EXCLUDED.content_type,
         content_length = EXCLUDED.content_length,
         content_hash = EXCLUDED.content_hash,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         links_count = EXCLUDED.links_count,
         crawled_at = NOW(),
         crawl_duration_ms = EXCLUDED.crawl_duration_ms,
         error_message = EXCLUDED.error_message`,
      [
        result.url,
        result.urlHash,
        domain,
        result.statusCode,
        result.contentType,
        result.contentLength,
        result.contentHash,
        result.title,
        result.description,
        result.linksFound.length,
        result.crawlDurationMs,
        result.error || null,
      ]
    );

    // Update domain page count (only for successful crawls)
    if (!result.error) {
      await pool.query(
        `UPDATE domains SET page_count = page_count + 1, updated_at = NOW() WHERE domain = $1`,
        [domain]
      );
    }
  }

  /**
   * Gets current statistics for this worker.
   *
   * Returns performance metrics useful for monitoring and debugging.
   *
   * @returns Worker statistics including crawl count, uptime, and throughput
   */
  getStats(): {
    workerId: string;
    isRunning: boolean;
    crawlCount: number;
    uptimeMs: number;
    crawlsPerSecond: number;
  } {
    const uptimeMs = this.startTime ? Date.now() - this.startTime : 0;
    const crawlsPerSecond =
      uptimeMs > 0 ? (this.crawlCount / uptimeMs) * 1000 : 0;

    return {
      workerId: this.workerId,
      isRunning: this.isRunning,
      crawlCount: this.crawlCount,
      uptimeMs,
      crawlsPerSecond,
    };
  }

  /**
   * Blocks until this worker wins the domain's politeness lock, i.e. at least
   * one crawl-delay has passed since the last request any worker made to it.
   * Gives up after POLITENESS_WAIT_MS with a transient EPOLITENESS error so the
   * frontier reschedules the URL instead of the worker spinning.
   */
  private async waitForDomainSlot(domain: string): Promise<void> {
    const deadline = Date.now() + POLITENESS_WAIT_MS;
    while (!(await frontierService.acquireDomainLock(domain, this.workerId))) {
      if (Date.now() > deadline) {
        throw Object.assign(new Error(`Politeness wait timed out for ${domain}`), {
          code: 'EPOLITENESS',
        });
      }
      await this.sleep(100);
    }
  }

  /**
   * Utility function for async sleep.
   *
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Extracts crawlable outbound links from a parsed page.
 *
 * - Resolves relative hrefs against `<base href>` when present, else the page URL
 * - Honors `<meta name="robots" content="nofollow">` (no links at all) and
 *   per-link `rel="nofollow"` / `rel="sponsored"` / `rel="ugc"`
 * - Normalizes and de-duplicates with a Set (O(n), the old array scan was O(n^2))
 * - Caps the result at `maxLinksPerPage` to bound fan-out from link farms
 */
export function extractLinks($: cheerio.CheerioAPI, pageUrl: string): string[] {
  const robotsMeta = ($('meta[name="robots" i]').attr('content') || '').toLowerCase();
  if (/\b(nofollow|none)\b/.test(robotsMeta)) {
    return [];
  }

  const baseHref = $('base[href]').first().attr('href');
  const baseUrl = (baseHref && resolveUrl(pageUrl, baseHref)) || pageUrl;

  const links = new Set<string>();
  $('a[href]').each((_, element) => {
    if (links.size >= config.crawler.maxLinksPerPage) return false;

    const rel = ($(element).attr('rel') || '').toLowerCase();
    if (/\b(nofollow|sponsored|ugc)\b/.test(rel)) return;

    const href = $(element).attr('href')?.trim();
    if (!href) return;

    const absoluteUrl = resolveUrl(baseUrl, href);
    if (absoluteUrl && shouldCrawl(absoluteUrl)) {
      const normalized = normalizeUrl(absoluteUrl);
      if (normalized !== pageUrl) links.add(normalized);
    }
  });

  return [...links];
}

/**
 * Parses a Retry-After header (delta-seconds or HTTP-date) into milliseconds.
 * Returns undefined if absent or unparseable; capped at 1 hour.
 */
export function parseRetryAfter(header: unknown): number | undefined {
  if (typeof header !== 'string' || header.trim() === '') return undefined;
  const seconds = Number(header);
  let ms: number;
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const date = Date.parse(header);
    if (Number.isNaN(date)) return undefined;
    ms = date - Date.now();
  }
  return Math.min(Math.max(0, ms), 60 * 60 * 1000);
}
