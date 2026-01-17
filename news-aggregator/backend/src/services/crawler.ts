import { query, queryOne, execute } from '../db/postgres.js';
import { parseRSS, stripHtml, extractSummary, RSSItem } from '../utils/rss.js';
import { computeSimHash } from '../utils/simhash.js';
import { extractTopics, extractEntities } from '../utils/topics.js';
import { indexArticle } from '../db/elasticsearch.js';
import { v4 as uuid } from 'uuid';

interface Source {
  id: string;
  name: string;
  domain: string;
  feed_url: string;
  category: string;
  crawl_frequency_minutes: number;
}

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

interface CrawlResult {
  source_id: string;
  articles_found: number;
  articles_new: number;
  errors: string[];
}

// Rate limiting per domain
const domainLastCrawl: Map<string, number> = new Map();
const CRAWL_DELAY_MS = 1000; // Minimum 1 second between requests to same domain

async function respectRateLimit(domain: string): Promise<void> {
  const lastCrawl = domainLastCrawl.get(domain) || 0;
  const elapsed = Date.now() - lastCrawl;

  if (elapsed < CRAWL_DELAY_MS) {
    await new Promise(resolve => setTimeout(resolve, CRAWL_DELAY_MS - elapsed));
  }

  domainLastCrawl.set(domain, Date.now());
}

/**
 * Fetch and parse RSS feed from a source
 */
export async function crawlSource(source: Source): Promise<CrawlResult> {
  const result: CrawlResult = {
    source_id: source.id,
    articles_found: 0,
    articles_new: 0,
    errors: [],
  };

  try {
    // Respect rate limiting
    const domain = new URL(source.feed_url).hostname;
    await respectRateLimit(domain);

    // Fetch the feed
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(source.feed_url, {
      headers: {
        'User-Agent': 'NewsAggregator/1.0 (Learning Project)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xml = await response.text();
    const feed = parseRSS(xml);

    result.articles_found = feed.items.length;

    // Process each item
    for (const item of feed.items) {
      try {
        const inserted = await processArticle(source, item);
        if (inserted) {
          result.articles_new++;
        }
      } catch (err) {
        result.errors.push(`Article "${item.title}": ${err}`);
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
  } catch (err) {
    result.errors.push(`Feed error: ${err}`);
  }

  return result;
}

/**
 * Process a single article from a feed item
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

  // Index in Elasticsearch
  try {
    await indexArticle({
      id: articleId,
      title,
      summary,
      body,
      topics,
      entities,
      published_at: publishedAt,
      source_id: source.id,
      fingerprint,
    });
  } catch (err) {
    console.error('Failed to index article:', err);
  }

  return true;
}

/**
 * Assign an article to a story cluster
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
 * Get all sources due for crawling
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
 * Crawl all sources due for refresh
 */
export async function crawlAllDueSources(): Promise<CrawlResult[]> {
  const sources = await getSourcesToCrawl();
  console.log(`Found ${sources.length} sources due for crawling`);

  const results: CrawlResult[] = [];

  for (const source of sources) {
    console.log(`Crawling: ${source.name} (${source.feed_url})`);
    const result = await crawlSource(source);
    results.push(result);

    console.log(`  Found: ${result.articles_found}, New: ${result.articles_new}`);
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.length}`);
    }
  }

  return results;
}

/**
 * Get all sources
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
 * Add a new source
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

  return {
    id,
    name,
    domain,
    feed_url: feedUrl,
    category,
    crawl_frequency_minutes: 15,
  };
}
