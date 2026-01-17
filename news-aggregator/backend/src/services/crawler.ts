/**
 * RSS feed crawler service.
 * Responsible for fetching RSS feeds from news sources, parsing articles,
 * detecting duplicates via SimHash, and clustering articles into stories.
 *
 * Features:
 * - Circuit breaker pattern for protecting against slow/unavailable sources
 * - Retry logic with exponential backoff for transient failures
 * - Rate limiting per domain to be a good citizen
 * - Metrics for observability
 * @module services/crawler
 */

import { query, queryOne, execute } from '../db/postgres.js';
import { parseRSS, stripHtml, extractSummary, RSSItem } from '../utils/rss.js';
import { computeSimHash } from '../utils/simhash.js';
import { extractTopics, extractEntities } from '../utils/topics.js';
import { indexArticle } from '../db/elasticsearch.js';
import { v4 as uuid } from 'uuid';

// Shared modules
import { logger } from '../shared/logger.js';
import { config } from '../shared/config.js';
import { createCircuitBreaker, globalFetchBreaker } from '../shared/circuit-breaker.js';
import { withRetry, RetryStrategies } from '../shared/retry.js';
import {
  articlesFetchedTotal,
  articlesStoredTotal,
  crawlerFetchTotal,
  crawlerFetchDuration,
  activeCrawlJobs,
} from '../shared/metrics.js';
import { invalidateGlobalCaches } from '../shared/cache.js';

/** Represents a news source configuration */
interface Source {
  id: string;
  name: string;
  domain: string;
  feed_url: string;
  category: string;
  crawl_frequency_minutes: number;
}

/** Represents an article stored in the database */
interface Article {
  id: string;
  source_id: string;
  story_id: string | null;
  url: string;
  title: string;
  summary: string;
  body: string;
  author: string;
  image_url: string | null;
  published_at: Date;
  fingerprint: bigint;
  topics: string[];
}

/** Result of crawling a single source */
interface CrawlResult {
  source_id: string;
  articles_found: number;
  articles_new: number;
  errors: string[];
}

/** Tracks last crawl time per domain for rate limiting */
const domainLastCrawl: Map<string, number> = new Map();

/** Minimum delay in milliseconds between requests to the same domain */
const CRAWL_DELAY_MS = config.crawler.domainDelayMs;

/** Per-source circuit breakers for isolating failures */
const sourceCircuitBreakers: Map<string, ReturnType<typeof createCircuitBreaker>> = new Map();

/**
 * Get or create a circuit breaker for a specific source.
 * Each source gets its own breaker to isolate failures.
 * @param sourceId - The source ID
 * @param sourceName - The source name for logging
 * @returns Circuit breaker for the source
 */
function getSourceCircuitBreaker(sourceId: string, sourceName: string) {
  let breaker = sourceCircuitBreakers.get(sourceId);
  if (!breaker) {
    breaker = createCircuitBreaker(
      async (url: string, options?: RequestInit) => {
        const response = await fetch(url, options);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response;
      },
      {
        name: `source:${sourceName}`,
        timeout: config.circuitBreaker.timeoutMs,
        errorThresholdPercentage: config.circuitBreaker.errorThresholdPercentage,
        resetTimeout: config.circuitBreaker.resetTimeoutMs,
        volumeThreshold: config.circuitBreaker.volumeThreshold,
      }
    );
    sourceCircuitBreakers.set(sourceId, breaker);
  }
  return breaker;
}

/**
 * Enforce rate limiting per domain.
 * Waits if necessary to respect the minimum delay between requests.
 * @param domain - The domain to rate limit
 */
async function respectRateLimit(domain: string): Promise<void> {
  const lastCrawl = domainLastCrawl.get(domain) || 0;
  const elapsed = Date.now() - lastCrawl;

  if (elapsed < CRAWL_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, CRAWL_DELAY_MS - elapsed));
  }

  domainLastCrawl.set(domain, Date.now());
}

/**
 * Fetch RSS feed with circuit breaker and retry logic.
 * Provides resilient fetching with proper failure handling.
 * @param source - The source to fetch
 * @returns XML content of the feed
 */
async function fetchFeedWithResilience(source: Source): Promise<string> {
  const domain = new URL(source.feed_url).hostname;
  await respectRateLimit(domain);

  const breaker = getSourceCircuitBreaker(source.id, source.name);
  const fetchStart = Date.now();

  try {
    // Use circuit breaker with retry logic inside
    const response = await breaker.fire(
      source.feed_url,
      {
        headers: {
          'User-Agent': config.crawler.userAgent,
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        },
        signal: AbortSignal.timeout(config.crawler.requestTimeoutMs),
      }
    ) as Response;

    const duration = (Date.now() - fetchStart) / 1000;
    crawlerFetchDuration.observe({ source_id: source.id }, duration);
    crawlerFetchTotal.inc({ status: 'success' });

    return await response.text();
  } catch (error) {
    const duration = (Date.now() - fetchStart) / 1000;
    crawlerFetchDuration.observe({ source_id: source.id }, duration);

    // Log the failure
    logger.warn({
      sourceId: source.id,
      sourceName: source.name,
      error: (error as Error).message,
    }, 'Feed fetch failed');

    // If circuit is open, retry with exponential backoff using global breaker
    if ((error as Error).message?.includes('circuit open')) {
      logger.info({ sourceId: source.id }, 'Circuit open, trying with retry strategy');

      return withRetry(
        async () => {
          const response = await globalFetchBreaker.fire(
            source.feed_url,
            {
              headers: {
                'User-Agent': config.crawler.userAgent,
                'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
              },
              signal: AbortSignal.timeout(config.crawler.requestTimeoutMs),
            }
          ) as Response;

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.text();
        },
        {
          ...RetryStrategies.rssFeed,
          operationName: `fetch:${source.name}`,
        }
      );
    }

    crawlerFetchTotal.inc({ status: 'error' });
    throw error;
  }
}

/**
 * Crawl a single news source.
 * Fetches the RSS feed, parses articles, deduplicates, and stores new content.
 * Uses circuit breaker and retry logic for resilience.
 * @param source - The source configuration to crawl
 * @returns Result containing counts of found/new articles and any errors
 */
export async function crawlSource(source: Source): Promise<CrawlResult> {
  const result: CrawlResult = {
    source_id: source.id,
    articles_found: 0,
    articles_new: 0,
    errors: [],
  };

  const childLogger = logger.child({ sourceId: source.id, sourceName: source.name });
  activeCrawlJobs.inc();

  try {
    childLogger.info('Starting crawl');

    // Fetch the feed with resilience
    const xml = await fetchFeedWithResilience(source);
    const feed = parseRSS(xml);

    result.articles_found = feed.items.length;
    articlesFetchedTotal.inc({ source_id: source.id, status: 'success' }, feed.items.length);

    childLogger.info({ articlesFound: feed.items.length }, 'Feed parsed');

    // Process each item
    for (const item of feed.items) {
      try {
        const inserted = await processArticle(source, item);
        if (inserted) {
          result.articles_new++;
          articlesStoredTotal.inc();
        }
      } catch (err) {
        const errorMsg = `Article "${item.title}": ${err}`;
        result.errors.push(errorMsg);
        childLogger.warn({ article: item.title, error: err }, 'Failed to process article');
      }
    }

    // Update last crawled timestamp
    await execute(
      'UPDATE sources SET last_crawled_at = NOW(), updated_at = NOW() WHERE id = $1',
      [source.id]
    );

    // Update next crawl time
    await execute(
      'UPDATE crawl_schedule SET next_crawl = NOW() + ($1 || \' minutes\')::interval WHERE source_id = $2',
      [source.crawl_frequency_minutes, source.id]
    );

    childLogger.info({
      articlesFound: result.articles_found,
      articlesNew: result.articles_new,
      errors: result.errors.length,
    }, 'Crawl completed');

  } catch (err) {
    const errorMsg = `Feed error: ${err}`;
    result.errors.push(errorMsg);
    articlesFetchedTotal.inc({ source_id: source.id, status: 'error' });
    childLogger.error({ error: err }, 'Crawl failed');
  } finally {
    activeCrawlJobs.dec();
  }

  return result;
}

/**
 * Process a single article from a feed item.
 * Cleans content, computes fingerprint, extracts topics, and stores the article.
 * @param source - The source this article came from
 * @param item - The parsed RSS item
 * @returns True if the article was new and inserted, false if it already existed
 */
async function processArticle(source: Source, item: RSSItem): Promise<boolean> {
  // Check if article already exists by URL
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM articles WHERE url = $1',
    [item.link]
  );

  if (existing) {
    return false;
  }

  // Clean and extract content
  const title = stripHtml(item.title);
  const body = stripHtml(item.content || item.description || '');
  const summary = extractSummary(body);

  // Compute fingerprint for deduplication
  const fingerprint = computeSimHash(`${title} ${body}`);

  // Extract topics and entities
  const topics = extractTopics(title, body);
  const entities = extractEntities(`${title} ${body}`);

  // Parse publication date
  let publishedAt = new Date();
  if (item.pubDate) {
    const parsed = new Date(item.pubDate);
    if (!isNaN(parsed.getTime())) {
      publishedAt = parsed;
    }
  }

  // Insert article
  const articleId = uuid();
  await execute(
    `INSERT INTO articles (id, source_id, url, title, summary, body, author, published_at, fingerprint, topics, entities)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      articleId,
      source.id,
      item.link,
      title,
      summary,
      body,
      item.author || '',
      publishedAt,
      Number(fingerprint),
      topics,
      JSON.stringify(entities),
    ]
  );

  // Assign to story (deduplication)
  await assignToStory(articleId, fingerprint, title, summary, topics, entities);

  // Index in Elasticsearch with retry
  try {
    await withRetry(
      () => indexArticle({
        id: articleId,
        title,
        summary,
        body,
        topics,
        entities,
        published_at: publishedAt,
        source_id: source.id,
        fingerprint,
      }),
      {
        ...RetryStrategies.fast,
        operationName: 'index-article',
      }
    );
  } catch (err) {
    logger.error({ articleId, error: err }, 'Failed to index article after retries');
  }

  return true;
}

/**
 * Assign an article to a story cluster based on content similarity.
 * Uses SimHash fingerprints to find matching stories from the last 48 hours.
 * Creates a new story if no similar story exists.
 * @param articleId - The ID of the article to assign
 * @param fingerprint - The article's SimHash fingerprint
 * @param title - Article title (used if creating a new story)
 * @param summary - Article summary (used if creating a new story)
 * @param topics - Article topics (used if creating a new story)
 * @param entities - Extracted entities (used if creating a new story)
 */
async function assignToStory(
  articleId: string,
  fingerprint: bigint,
  title: string,
  summary: string,
  topics: string[],
  entities: { name: string; type: string }[]
): Promise<void> {
  // Find similar stories from the last 48 hours
  const recentStories = await query<{ id: string; fingerprint: bigint }>(
    `SELECT id, fingerprint FROM stories
     WHERE created_at > NOW() - INTERVAL '48 hours'
     AND fingerprint IS NOT NULL`,
    []
  );

  // Convert fingerprints and find similar
  for (const story of recentStories) {
    const storyFp = BigInt(story.fingerprint);
    const distance = hammingDistance(fingerprint, storyFp);

    if (distance < 3) {
      // Add to existing story
      await execute(
        'UPDATE articles SET story_id = $1 WHERE id = $2',
        [story.id, articleId]
      );

      // Update story counts and velocity
      await execute(
        `UPDATE stories SET
          article_count = article_count + 1,
          source_count = (SELECT COUNT(DISTINCT source_id) FROM articles WHERE story_id = $1),
          velocity = (SELECT COUNT(*) FROM articles WHERE story_id = $1 AND created_at > NOW() - INTERVAL '30 minutes') / 30.0,
          updated_at = NOW()
         WHERE id = $1`,
        [story.id]
      );

      return;
    }
  }

  // Create new story
  const storyId = uuid();
  await execute(
    `INSERT INTO stories (id, title, summary, primary_topic, topics, entities, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      storyId,
      title,
      summary,
      topics[0] || 'general',
      topics,
      JSON.stringify(entities),
      Number(fingerprint),
    ]
  );

  await execute('UPDATE articles SET story_id = $1 WHERE id = $2', [storyId, articleId]);
}

/**
 * Calculate Hamming distance between two fingerprints.
 * Used internally for story matching.
 * @param a - First fingerprint
 * @param b - Second fingerprint
 * @returns Number of differing bits
 */
function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

/**
 * Get all sources that are due for crawling.
 * Returns sources ordered by priority and scheduled crawl time.
 * @returns Array of sources ready to be crawled (max 50)
 */
export async function getSourcesToCrawl(): Promise<Source[]> {
  return query<Source>(
    `SELECT s.id, s.name, s.domain, s.feed_url, s.category, s.crawl_frequency_minutes
     FROM sources s
     JOIN crawl_schedule cs ON s.id = cs.source_id
     WHERE s.is_active = true
     AND cs.next_crawl <= NOW()
     ORDER BY cs.priority DESC, cs.next_crawl ASC
     LIMIT 50`,
    []
  );
}

/**
 * Crawl all sources that are due for refresh.
 * Logs progress and returns results for each source.
 * Invalidates feed caches after crawling new articles.
 * @returns Array of crawl results for all processed sources
 */
export async function crawlAllDueSources(): Promise<CrawlResult[]> {
  const sources = await getSourcesToCrawl();
  logger.info({ sourceCount: sources.length }, 'Starting crawl of due sources');

  const results: CrawlResult[] = [];
  let totalNew = 0;

  for (const source of sources) {
    const result = await crawlSource(source);
    results.push(result);
    totalNew += result.articles_new;
  }

  // Invalidate caches if we got new articles
  if (totalNew > 0) {
    await invalidateGlobalCaches();
    logger.info({ newArticles: totalNew }, 'Invalidated global caches after crawl');
  }

  logger.info({
    sourcesCount: results.length,
    totalArticlesFound: results.reduce((sum, r) => sum + r.articles_found, 0),
    totalArticlesNew: totalNew,
    totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
  }, 'Crawl batch completed');

  return results;
}

/**
 * Get all active news sources.
 * @returns Array of all active source configurations sorted by name
 */
export async function getAllSources(): Promise<Source[]> {
  return query<Source>(
    `SELECT id, name, domain, feed_url, category, crawl_frequency_minutes
     FROM sources
     WHERE is_active = true
     ORDER BY name`,
    []
  );
}

/**
 * Add a new news source to the system.
 * Creates the source record and schedules it for immediate crawling.
 * @param name - Human-readable name for the source
 * @param feedUrl - URL of the RSS/Atom feed
 * @param category - Default category for articles from this source
 * @returns The created source configuration
 */
export async function addSource(
  name: string,
  feedUrl: string,
  category: string
): Promise<Source> {
  const domain = new URL(feedUrl).hostname;
  const id = uuid();

  await execute(
    `INSERT INTO sources (id, name, domain, feed_url, category)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, name, domain, feedUrl, category]
  );

  await execute(
    'INSERT INTO crawl_schedule (source_id, next_crawl) VALUES ($1, NOW())',
    [id]
  );

  logger.info({ sourceId: id, sourceName: name, feedUrl }, 'Added new source');

  return {
    id,
    name,
    domain,
    feed_url: feedUrl,
    category,
    crawl_frequency_minutes: config.crawler.defaultCrawlIntervalMinutes,
  };
}
