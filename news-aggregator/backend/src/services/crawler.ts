/**
 * RSS feed crawler service.
 * Fetches feeds politely, ingests new articles, and clusters them into stories.
 *
 * Crawling:
 * - Sources are claimed under a lease (FOR UPDATE SKIP LOCKED), so several API
 *   instances can run the scheduler without crawling the same feed twice, and
 *   a crawler that dies mid-fetch releases its sources when the lease expires.
 * - Fetches are conditional GETs (If-None-Match / If-Modified-Since); a 304
 *   ends the crawl without parsing anything.
 * - Failures back off per source (interval x 2^failures, honoring Retry-After),
 *   persisted in crawl_schedule so the backoff survives restarts and is shared
 *   by every instance. Requests to one domain are spaced by a minimum delay.
 *
 * Ingestion and clustering:
 * - Each article is inserted, assigned to a story and counted in ONE
 *   transaction; ON CONFLICT (url) makes re-crawls and concurrent crawlers safe.
 * - Candidate stories come from the SimHash band index (four 16-bit bands),
 *   not a scan of every recent story, and advisory locks on those bands keep
 *   two crawlers from creating two stories for the same event.
 * @module services/crawler
 */

import type pg from 'pg';
import { query, queryOne, withTransaction } from '../db/postgres.js';
import { parseRSS, stripHtml, extractSummary, RSSItem } from '../utils/rss.js';
import {
  computeSimHash,
  fingerprintBands,
  hammingDistance,
  SIMHASH_MATCH_THRESHOLD,
} from '../utils/simhash.js';
import { extractTopics, extractEntities } from '../utils/topics.js';
import { indexArticle } from '../db/elasticsearch.js';
import { v4 as uuid } from 'uuid';

// Shared modules
import { logger } from '../shared/logger.js';
import { config } from '../shared/config.js';
import { createCircuitBreaker } from '../shared/circuit-breaker.js';
import { withRetry, RetryStrategies } from '../shared/retry.js';
import {
  articlesFetchedTotal,
  articlesStoredTotal,
  crawlerFetchTotal,
  crawlerFetchDuration,
  activeCrawlJobs,
  storyAssignmentsTotal,
} from '../shared/metrics.js';
import { invalidateGlobalCaches } from '../shared/cache.js';
import {
  classifyStatus,
  conditionalHeaders,
  nextCrawlDelaySeconds,
  parseRetryAfter,
  type FetchOutcomeKind,
} from './crawl-policy.js';

/** Represents a news source configuration */
interface Source {
  id: string;
  name: string;
  domain: string;
  feed_url: string;
  category: string;
  crawl_frequency_minutes: number;
}

/** A source claimed under a lease, with the state needed for a polite fetch. */
export interface ClaimedSource extends Source {
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
  /** Fencing token: completing the crawl only applies while it still matches */
  lease_token: string;
}

/** Result of one HTTP attempt against a feed. */
export interface FeedFetchResult {
  kind: FetchOutcomeKind;
  /** HTTP status, or null for network errors, timeouts and an open breaker */
  status: number | null;
  body?: string;
  etag: string | null;
  lastModified: string | null;
  retryAfterSeconds: number | null;
  error?: string;
}

/** Result of crawling a single source */
export interface CrawlResult {
  source_id: string;
  outcome: FetchOutcomeKind;
  status: number | null;
  articles_found: number;
  articles_new: number;
  /** Seconds until the next scheduled attempt (null if the lease was lost) */
  next_crawl_in_seconds: number | null;
  errors: string[];
}

/** How a single feed item was handled. */
type ItemResult = 'inserted' | 'duplicate' | 'skipped';

/** Thrown inside the circuit breaker for responses that mean "server trouble". */
class FeedHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | null
  ) {
    super(`HTTP ${status}`);
  }
}

/** Namespace for clustering advisory locks (first key of the two-int form). */
const CLUSTER_LOCK_NAMESPACE = 20817;

/** Column limits from init.sql; longer feed values are truncated, not rejected. */
const MAX_TITLE_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 255;
const MAX_URL_LENGTH = 1000;

/** Minimum delay in milliseconds between requests to the same domain */
const CRAWL_DELAY_MS = config.crawler.domainDelayMs;

/** Next free request slot per domain, in epoch milliseconds. */
const domainNextSlot: Map<string, number> = new Map();

/** Per-source circuit breakers for isolating failures */
const sourceCircuitBreakers: Map<string, ReturnType<typeof createCircuitBreaker>> = new Map();

/**
 * Get or create a circuit breaker for a specific source.
 * The wrapped call returns the Response for 2xx, 304 and 4xx, and throws for
 * 429 and 5xx so that only server trouble counts toward opening the breaker.
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
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          throw new FeedHttpError(response.status, parseRetryAfter(response.headers.get('retry-after')));
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
 * Wait for this domain's next request slot.
 * The slot is reserved before sleeping, so concurrent crawls of the same
 * domain queue up one delay apart instead of all waking at the same moment.
 * @param domain - The domain to rate limit
 */
async function waitForDomainSlot(domain: string): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, domainNextSlot.get(domain) ?? 0);
  domainNextSlot.set(domain, slot + CRAWL_DELAY_MS);
  if (slot > now) {
    await new Promise(resolve => setTimeout(resolve, slot - now));
  }
}

/**
 * Fetch a feed with a conditional GET through the source's circuit breaker.
 * Never throws: every way a fetch can end is reported as a FeedFetchResult,
 * because the scheduler needs the outcome to decide when to come back.
 * @param source - The claimed source, including stored validators
 * @returns Outcome, status, body (for 200) and the response's validators
 */
export async function fetchFeed(source: ClaimedSource): Promise<FeedFetchResult> {
  await waitForDomainSlot(new URL(source.feed_url).hostname);

  const breaker = getSourceCircuitBreaker(source.id, source.name);
  const fetchStart = Date.now();

  try {
    const response = await breaker.fire(source.feed_url, {
      headers: {
        'User-Agent': config.crawler.userAgent,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
        ...conditionalHeaders({ etag: source.etag, lastModified: source.last_modified }),
      },
      signal: AbortSignal.timeout(config.crawler.requestTimeoutMs),
    }) as Response;

    const kind = classifyStatus(response.status);
    const result: FeedFetchResult = {
      kind,
      status: response.status,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    };

    if (kind === 'fetched') {
      result.body = await response.text();
      crawlerFetchTotal.inc({ status: 'success' });
    } else if (kind === 'not_modified') {
      crawlerFetchTotal.inc({ status: 'not_modified' });
    } else {
      await response.body?.cancel().catch(() => undefined);
      result.error = `HTTP ${response.status}`;
      crawlerFetchTotal.inc({ status: 'error' });
    }
    return result;
  } catch (error) {
    // Opossum's own timeout and open-circuit rejections are already counted
    // by the breaker's event handlers; count everything else here.
    const code = (error as { code?: string }).code;
    if (code !== 'ETIMEDOUT' && code !== 'EOPENBREAKER') {
      crawlerFetchTotal.inc({ status: 'error' });
    }
    logger.warn({ sourceId: source.id, sourceName: source.name, error: (error as Error).message }, 'Feed fetch failed');

    if (error instanceof FeedHttpError) {
      return {
        kind: 'failed',
        status: error.status,
        etag: null,
        lastModified: null,
        retryAfterSeconds: error.retryAfterSeconds,
        error: error.message,
      };
    }
    return {
      kind: 'failed',
      status: null,
      etag: null,
      lastModified: null,
      retryAfterSeconds: null,
      error: (error as Error).message,
    };
  } finally {
    crawlerFetchDuration.observe({ source_id: source.id }, (Date.now() - fetchStart) / 1000);
  }
}

/**
 * Crawl a single claimed source: conditional fetch, parse, ingest, reschedule.
 * The source must have been claimed with claimDueSources() or claimSource().
 * @param source - The claimed source
 * @returns Outcome, article counts, next attempt delay and any item errors
 */
export async function crawlSource(source: ClaimedSource): Promise<CrawlResult> {
  const result: CrawlResult = {
    source_id: source.id,
    outcome: 'failed',
    status: null,
    articles_found: 0,
    articles_new: 0,
    next_crawl_in_seconds: null,
    errors: [],
  };

  const childLogger = logger.child({ sourceId: source.id, sourceName: source.name });
  activeCrawlJobs.inc();

  try {
    const fetched = await fetchFeed(source);
    result.status = fetched.status;
    let outcome = fetched.kind;
    let lastError = fetched.error ?? null;

    // Validators describe the representation we successfully processed. Keep
    // the old ones on a 304 (unless the server sent fresh ones) and on
    // failures; replace them only after a 200 we could actually parse.
    let etag = source.etag;
    let lastModified = source.last_modified;

    if (fetched.kind === 'fetched') {
      try {
        const feed = parseRSS(fetched.body ?? '');
        result.articles_found = feed.items.length;
        articlesFetchedTotal.inc({ source_id: source.id, status: 'success' }, feed.items.length);

        for (const item of feed.items) {
          try {
            const itemResult = await processArticle(source, item);
            if (itemResult === 'inserted') {
              result.articles_new++;
              articlesStoredTotal.inc();
            }
          } catch (err) {
            result.errors.push(`Article "${item.title}": ${(err as Error).message}`);
            childLogger.warn({ article: item.title, error: (err as Error).message }, 'Failed to process article');
          }
        }
        // Advance the validators only if every item was stored: otherwise the
        // next conditional GET would get a 304 and never retry the failed ones.
        if (result.errors.length === 0) {
          etag = fetched.etag;
          lastModified = fetched.lastModified;
        }
      } catch (err) {
        outcome = 'failed';
        lastError = `Parse error: ${(err as Error).message}`;
        articlesFetchedTotal.inc({ source_id: source.id, status: 'error' });
      }
    } else if (fetched.kind === 'not_modified') {
      etag = fetched.etag ?? source.etag;
      lastModified = fetched.lastModified ?? source.last_modified;
    }

    if (lastError && outcome === 'failed') {
      result.errors.push(`Feed error: ${lastError}`);
    }

    const failures = outcome === 'failed' ? source.consecutive_failures + 1 : 0;
    const delaySeconds = nextCrawlDelaySeconds({
      outcome,
      intervalMinutes: source.crawl_frequency_minutes,
      consecutiveFailures: failures,
      retryAfterSeconds: fetched.retryAfterSeconds,
      maxBackoffMinutes: config.crawler.maxBackoffMinutes,
    });

    const applied = await completeCrawl(source, {
      outcome,
      status: fetched.status,
      etag,
      lastModified,
      failures,
      delaySeconds,
      error: outcome === 'failed' ? lastError : null,
    });

    result.outcome = outcome;
    result.next_crawl_in_seconds = applied ? delaySeconds : null;
    if (!applied) {
      childLogger.warn('Crawl lease expired or was taken over; schedule update discarded');
    }

    childLogger.info({
      outcome,
      status: fetched.status,
      articlesFound: result.articles_found,
      articlesNew: result.articles_new,
      consecutiveFailures: failures,
      nextCrawlInSeconds: delaySeconds,
    }, 'Crawl completed');
  } catch (err) {
    // Only database trouble lands here. The lease stays in place, so the
    // source simply becomes due again when it expires.
    result.errors.push(`Crawl error: ${(err as Error).message}`);
    childLogger.error({ error: (err as Error).message }, 'Crawl failed');
  } finally {
    activeCrawlJobs.dec();
  }

  return result;
}

/** What completeCrawl writes back to crawl_schedule. */
interface CrawlCompletion {
  outcome: FetchOutcomeKind;
  status: number | null;
  etag: string | null;
  lastModified: string | null;
  failures: number;
  delaySeconds: number;
  error: string | null;
}

/**
 * Release the lease and schedule the next attempt.
 * Guarded by the lease token (a fencing token): if this crawl outlived its
 * lease and another crawler claimed the source, the update matches no row.
 * @param source - The claimed source
 * @param completion - Outcome, validators, failure count and delay
 * @returns True if the update applied, false if the lease had been lost
 */
async function completeCrawl(source: ClaimedSource, completion: CrawlCompletion): Promise<boolean> {
  const rows = await query<{ source_id: string }>(
    `WITH done AS (
       UPDATE crawl_schedule SET
         next_crawl = NOW() + make_interval(secs => $3::int),
         lease_token = NULL,
         etag = $4,
         last_modified = $5,
         consecutive_failures = $6::int,
         last_status = $7::int,
         last_error = $8
       WHERE source_id = $1 AND lease_token = $2
       RETURNING source_id
     ), touched AS (
       UPDATE sources s SET last_crawled_at = NOW(), updated_at = NOW()
       FROM done
       WHERE s.id = done.source_id AND $9::boolean
       RETURNING s.id
     )
     SELECT source_id FROM done`,
    [
      source.id,
      source.lease_token,
      completion.delaySeconds,
      completion.etag,
      completion.lastModified,
      completion.failures,
      completion.status,
      completion.error?.slice(0, 1000) ?? null,
      completion.outcome !== 'failed',
    ]
  );
  return rows.length > 0;
}

/**
 * Keep only absolute http(s) links. Feed content is third-party input, and a
 * stored javascript: or data: URL would end up in an href in every client.
 * @param link - Raw link from the feed item
 * @returns The normalized URL, or null if it must not be stored
 */
export function normalizeArticleUrl(link: string | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const href = url.toString();
    return href.length <= MAX_URL_LENGTH ? href : null;
  } catch {
    return null;
  }
}

/**
 * Process a single feed item: clean it, fingerprint it, and store it together
 * with its story assignment in one transaction. Re-crawled items hit the
 * unique URL and return 'duplicate' without side effects.
 * @param source - The source this article came from
 * @param item - The parsed RSS item
 * @returns Whether the item was inserted, already known, or skipped
 */
async function processArticle(source: Source, item: RSSItem): Promise<ItemResult> {
  const url = normalizeArticleUrl(item.link);
  const title = stripHtml(item.title).slice(0, MAX_TITLE_LENGTH);
  if (!url || !title) {
    return 'skipped';
  }

  const body = stripHtml(item.content || item.description || '');
  const summary = extractSummary(body);
  const fingerprint = computeSimHash(`${title} ${body}`);
  const topics = extractTopics(title, body);
  const entities = extractEntities(`${title} ${body}`);

  let publishedAt = new Date();
  if (item.pubDate) {
    const parsed = new Date(item.pubDate);
    if (!isNaN(parsed.getTime())) {
      publishedAt = parsed;
    }
  }

  const stored = await withTransaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO articles (id, source_id, url, title, summary, body, author, published_at, fingerprint, topics, entities)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (url) DO NOTHING
       RETURNING id`,
      [
        uuid(),
        source.id,
        url,
        title,
        summary,
        body,
        (item.author || '').slice(0, MAX_AUTHOR_LENGTH),
        publishedAt,
        // As a string, not Number(): a JS number is exact only to 2^53, so
        // Number(fingerprint) would corrupt the low bits that Hamming distance
        // is computed over. node-postgres passes the string through to NUMERIC.
        fingerprint.toString(),
        topics,
        JSON.stringify(entities),
      ]
    );
    if (inserted.rowCount === 0) {
      return null;
    }
    const articleId = inserted.rows[0].id;
    const storyId = await assignToStory(client, { articleId, fingerprint, title, summary, topics, entities });
    return { articleId, storyId };
  });

  if (!stored) {
    return 'duplicate';
  }

  // Elasticsearch is a derived index: index after the commit, best effort.
  try {
    await withRetry(
      () => indexArticle({
        id: stored.articleId,
        title,
        summary,
        body,
        topics,
        entities,
        published_at: publishedAt,
        source_id: source.id,
        story_id: stored.storyId,
      }),
      {
        ...RetryStrategies.fast,
        operationName: 'index-article',
      }
    );
  } catch (err) {
    logger.error({ articleId: stored.articleId, error: (err as Error).message }, 'Failed to index article after retries');
  }

  return 'inserted';
}

/** Data needed to place one freshly inserted article into a story. */
interface StoryAssignmentInput {
  articleId: string;
  fingerprint: bigint;
  title: string;
  summary: string;
  topics: string[];
  entities: { name: string; type: string }[];
}

/**
 * Pick the closest candidate story within the SimHash threshold.
 * @param fingerprint - The new article's fingerprint
 * @param candidates - Stories sharing at least one band, fingerprints as decimal strings
 * @returns The closest match under the threshold, or null
 */
export function closestStory(
  fingerprint: bigint,
  candidates: { id: string; fingerprint: string }[]
): { id: string; distance: number } | null {
  let best: { id: string; distance: number } | null = null;
  for (const candidate of candidates) {
    const distance = hammingDistance(fingerprint, BigInt(candidate.fingerprint));
    if (distance < SIMHASH_MATCH_THRESHOLD && (!best || distance < best.distance)) {
      best = { id: candidate.id, distance };
    }
  }
  return best;
}

/**
 * Advisory-lock keys for a fingerprint's bands, in ascending order.
 * Key = band index * 65536 + band value, so each (band, value) bucket is one
 * lock. Taking all four in a fixed order means two transactions can never
 * wait on each other in a cycle.
 * @param bands - The four 16-bit band values
 * @returns Lock keys, ascending
 */
export function bandLockKeys(bands: number[]): number[] {
  return bands.map((value, index) => index * 65536 + value);
}

/**
 * Recompute a story's counters from its articles and flag it as breaking when
 * enough distinct sources covered it within the velocity window. Runs after
 * the story row is locked, so the counts include concurrent assignments.
 * Article time is the earlier of publication and arrival, so a newly added
 * source's backlog does not look like a burst of fresh coverage.
 */
const STORY_AGGREGATE_SQL = `
  UPDATE stories s SET
    article_count = agg.article_count,
    source_count = agg.source_count,
    velocity = agg.recent_articles::numeric / $2::int,
    last_article_at = NOW(),
    is_breaking = s.is_breaking OR agg.recent_sources >= $3::int,
    breaking_started_at = CASE
      WHEN s.is_breaking THEN s.breaking_started_at
      WHEN agg.recent_sources >= $3::int THEN NOW()
      ELSE s.breaking_started_at
    END,
    updated_at = NOW()
  FROM (
    SELECT
      COUNT(*) AS article_count,
      COUNT(DISTINCT source_id) AS source_count,
      COUNT(*) FILTER (
        WHERE LEAST(published_at, created_at) > NOW() - make_interval(mins => $2::int)
      ) AS recent_articles,
      COUNT(DISTINCT source_id) FILTER (
        WHERE LEAST(published_at, created_at) > NOW() - make_interval(mins => $2::int)
      ) AS recent_sources
    FROM articles
    WHERE story_id = $1
  ) agg
  WHERE s.id = $1`;

/**
 * Assign an article to a story inside the caller's transaction.
 *
 * 1. Lock the four band buckets this fingerprint could match through, so a
 *    concurrent crawler ingesting a near-duplicate waits and then sees our
 *    story instead of creating its own.
 * 2. Look up candidates by band equality (indexed), within the window.
 * 3. Join the closest story under the threshold, or create a new one.
 * 4. Recompute the story's counters, velocity and breaking flag.
 * @param client - Transaction client
 * @param input - The inserted article's id, fingerprint and metadata
 * @returns The story id the article now belongs to
 */
async function assignToStory(client: pg.PoolClient, input: StoryAssignmentInput): Promise<string> {
  const { windowHours, velocityWindowMinutes, breakingMinSources } = config.clustering;
  let storyId: string | null = null;

  // An all-zero fingerprint means the text had no usable tokens; matching on
  // it would merge every empty item into one story.
  if (input.fingerprint !== 0n) {
    const bands = fingerprintBands(input.fingerprint);
    for (const key of bandLockKeys(bands)) {
      await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [CLUSTER_LOCK_NAMESPACE, key]);
    }

    const candidates = await client.query<{ id: string; fingerprint: string }>(
      `SELECT id, fingerprint::text AS fingerprint
       FROM stories
       WHERE (fp_band0 = $1 OR fp_band1 = $2 OR fp_band2 = $3 OR fp_band3 = $4)
         AND last_article_at > NOW() - make_interval(hours => $5::int)`,
      [...bands, windowHours]
    );

    const match = closestStory(input.fingerprint, candidates.rows);
    if (match) {
      // Lock the story row so the counters below see every committed article.
      await client.query('SELECT id FROM stories WHERE id = $1 FOR UPDATE', [match.id]);
      storyId = match.id;
      storyAssignmentsTotal.inc({ result: 'joined' });
    }
  }

  if (!storyId) {
    const created = await client.query<{ id: string }>(
      `INSERT INTO stories (title, summary, primary_topic, topics, entities, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.title,
        input.summary,
        input.topics[0] || 'general',
        input.topics,
        JSON.stringify(input.entities),
        input.fingerprint.toString(),
      ]
    );
    storyId = created.rows[0].id;
    storyAssignmentsTotal.inc({ result: 'created' });
  }

  await client.query('UPDATE articles SET story_id = $1 WHERE id = $2', [storyId, input.articleId]);
  await client.query(STORY_AGGREGATE_SQL, [storyId, velocityWindowMinutes, breakingMinSources]);
  return storyId;
}

/** Columns returned when a source is claimed. */
const CLAIMED_SOURCE_COLUMNS = `
  s.id, s.name, s.domain, s.feed_url, s.category, s.crawl_frequency_minutes,
  cs.etag, cs.last_modified, cs.consecutive_failures, cs.lease_token`;

/**
 * Claim due sources under a lease.
 * FOR UPDATE SKIP LOCKED lets several instances claim concurrently without
 * blocking each other or claiming the same row; pushing next_crawl forward by
 * the lease length is the lease itself.
 * @param limit - Maximum number of sources to claim
 * @returns Claimed sources with their crawl state and lease token
 */
export async function claimDueSources(limit: number = config.crawler.claimBatchSize): Promise<ClaimedSource[]> {
  return query<ClaimedSource>(
    `WITH due AS (
       SELECT cs.source_id
       FROM crawl_schedule cs
       JOIN sources s ON s.id = cs.source_id
       WHERE s.is_active = true AND cs.next_crawl <= NOW()
       ORDER BY cs.priority DESC, cs.next_crawl ASC
       LIMIT $1
       FOR UPDATE OF cs SKIP LOCKED
     )
     UPDATE crawl_schedule cs
     SET next_crawl = NOW() + make_interval(secs => $2::int), lease_token = $3
     FROM due, sources s
     WHERE cs.source_id = due.source_id AND s.id = cs.source_id
     RETURNING ${CLAIMED_SOURCE_COLUMNS}`,
    [limit, config.crawler.leaseSeconds, uuid()]
  );
}

/** Why a single-source claim failed. */
export type ClaimSourceResult =
  | { status: 'claimed'; source: ClaimedSource }
  | { status: 'not_found' }
  | { status: 'busy' };

/**
 * Claim one source for an immediate (admin-triggered) crawl, whether or not
 * it is due. Fails with 'busy' while another crawler holds a live lease.
 * @param sourceId - The source to claim
 * @returns The claimed source, or why it could not be claimed
 */
export async function claimSource(sourceId: string): Promise<ClaimSourceResult> {
  const rows = await query<ClaimedSource>(
    `UPDATE crawl_schedule cs
     SET next_crawl = NOW() + make_interval(secs => $2::int), lease_token = $3
     FROM sources s
     WHERE cs.source_id = $1 AND s.id = cs.source_id
       AND (cs.lease_token IS NULL OR cs.next_crawl <= NOW())
     RETURNING ${CLAIMED_SOURCE_COLUMNS}`,
    [sourceId, config.crawler.leaseSeconds, uuid()]
  );
  if (rows.length > 0) {
    return { status: 'claimed', source: rows[0] };
  }
  const exists = await queryOne<{ id: string }>(
    'SELECT source_id AS id FROM crawl_schedule WHERE source_id = $1',
    [sourceId]
  );
  return exists ? { status: 'busy' } : { status: 'not_found' };
}

/**
 * Run an async function over items with bounded concurrency.
 * @param items - Work items
 * @param concurrency - Maximum in-flight calls
 * @param fn - Worker
 * @returns Results in input order
 */
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Claim and crawl every due source, a few at a time.
 * Invalidates feed caches after crawling new articles.
 * @returns Array of crawl results for all claimed sources
 */
export async function crawlAllDueSources(): Promise<CrawlResult[]> {
  const sources = await claimDueSources();
  logger.info({ sourceCount: sources.length }, 'Claimed due sources');

  const results = await mapWithConcurrency(sources, config.crawler.maxConcurrentCrawls, crawlSource);
  const totalNew = results.reduce((sum, r) => sum + r.articles_new, 0);

  if (totalNew > 0) {
    await invalidateGlobalCaches();
    logger.info({ newArticles: totalNew }, 'Invalidated global caches after crawl');
  }

  logger.info({
    sourcesCount: results.length,
    notModified: results.filter(r => r.outcome === 'not_modified').length,
    failed: results.filter(r => r.outcome === 'failed').length,
    totalArticlesFound: results.reduce((sum, r) => sum + r.articles_found, 0),
    totalArticlesNew: totalNew,
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
 * Add a new news source and schedule it for an immediate crawl.
 * The source row and its schedule row are written in one transaction.
 * @param name - Human-readable name for the source
 * @param feedUrl - Absolute http(s) URL of the RSS/Atom feed
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

  const crawlFrequency = await withTransaction(async (client) => {
    const inserted = await client.query<{ crawl_frequency_minutes: number }>(
      `INSERT INTO sources (id, name, domain, feed_url, category)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING crawl_frequency_minutes`,
      [id, name, domain, feedUrl, category]
    );
    await client.query(
      'INSERT INTO crawl_schedule (source_id, next_crawl) VALUES ($1, NOW())',
      [id]
    );
    return inserted.rows[0].crawl_frequency_minutes;
  });

  logger.info({ sourceId: id, sourceName: name, feedUrl }, 'Added new source');

  return {
    id,
    name,
    domain,
    feed_url: feedUrl,
    category,
    crawl_frequency_minutes: crawlFrequency,
  };
}
