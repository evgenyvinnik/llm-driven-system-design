import axios, { AxiosResponse } from 'axios';
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
  hashUrl,
  hashContent,
} from '../utils/url.js';
import { config } from '../config.js';

export interface CrawlResult {
  url: string;
  urlHash: string;
  statusCode: number;
  contentType: string;
  contentLength: number;
  contentHash: string;
  title: string;
  description: string;
  linksFound: string[];
  crawlDurationMs: number;
  error?: string;
}

/**
 * Crawler Worker Service
 * Fetches pages, extracts content and links, respects politeness rules
 */
export class CrawlerService {
  private workerId: string;
  private isRunning: boolean = false;
  private crawlCount: number = 0;
  private startTime: number = 0;

  constructor(workerId: string) {
    this.workerId = workerId;
  }

  /**
   * Start the crawler worker
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    this.isRunning = true;
    this.startTime = Date.now();
    console.log(`Crawler worker ${this.workerId} starting...`);

    // Register worker
    await this.registerWorker();

    // Start heartbeat
    this.startHeartbeat();

    // Main crawl loop
    while (this.isRunning) {
      try {
        await this.crawlNext();
      } catch (error) {
        console.error(`Crawler ${this.workerId} error:`, error);
        await this.sleep(1000);
      }
    }
  }

  /**
   * Stop the crawler worker
   */
  async stop(): Promise<void> {
    console.log(`Crawler worker ${this.workerId} stopping...`);
    this.isRunning = false;
    await this.unregisterWorker();
  }

  /**
   * Register this worker as active
   */
  private async registerWorker(): Promise<void> {
    await redis.sadd(REDIS_KEYS.ACTIVE_WORKERS, this.workerId);
    await redis.set(
      REDIS_KEYS.WORKER_HEARTBEAT(this.workerId),
      Date.now().toString()
    );
  }

  /**
   * Unregister this worker
   */
  private async unregisterWorker(): Promise<void> {
    await redis.srem(REDIS_KEYS.ACTIVE_WORKERS, this.workerId);
    await redis.del(REDIS_KEYS.WORKER_HEARTBEAT(this.workerId));
  }

  /**
   * Send periodic heartbeat
   */
  private startHeartbeat(): void {
    setInterval(async () => {
      if (this.isRunning) {
        await redis.set(
          REDIS_KEYS.WORKER_HEARTBEAT(this.workerId),
          Date.now().toString()
        );
      }
    }, 5000);
  }

  /**
   * Crawl the next available URL
   */
  async crawlNext(): Promise<void> {
    // Get next URL from frontier
    const frontierUrl = await frontierService.getNextUrl(this.workerId);

    if (!frontierUrl) {
      // No URLs available, wait a bit
      await this.sleep(500);
      return;
    }

    try {
      const result = await this.crawlUrl(frontierUrl);

      // Store results
      await this.storeCrawlResult(result);

      // Add discovered links to frontier
      if (result.linksFound.length > 0) {
        await frontierService.addUrls(result.linksFound, {
          depth: (frontierUrl.depth || 0) + 1,
        });
      }

      // Mark as completed
      await frontierService.markCompleted(frontierUrl.urlHash);

      // Update stats
      await redis.incr(REDIS_KEYS.STATS_PAGES_CRAWLED);
      await redis.incrby(REDIS_KEYS.STATS_BYTES_DOWNLOADED, result.contentLength);

      this.crawlCount++;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error(`Failed to crawl ${frontierUrl.url}:`, errorMessage);

      await frontierService.markFailed(frontierUrl.urlHash, errorMessage);
      await redis.incr(REDIS_KEYS.STATS_PAGES_FAILED);
    }
  }

  /**
   * Crawl a single URL
   */
  async crawlUrl(frontierUrl: FrontierUrl): Promise<CrawlResult> {
    const { url, urlHash, domain } = frontierUrl;
    const startTime = Date.now();

    // Check robots.txt
    const isAllowed = await robotsService.isAllowed(url, domain);
    if (!isAllowed) {
      return {
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
        error: 'Blocked by robots.txt',
      };
    }

    // Fetch the page
    let response: AxiosResponse;
    try {
      response = await axios.get(url, {
        timeout: config.crawler.requestTimeout,
        maxContentLength: config.crawler.maxPageSize,
        headers: {
          'User-Agent': config.crawler.userAgent,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'keep-alive',
        },
        responseType: 'text',
        validateStatus: () => true, // Accept all status codes
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Request failed';
      return {
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
        error: errorMessage,
      };
    }

    const statusCode = response.status;
    const contentType = response.headers['content-type'] || '';

    // Only process HTML content
    if (!contentType.includes('text/html')) {
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
        error: 'Not HTML content',
      };
    }

    const html = typeof response.data === 'string' ? response.data : '';
    const contentLength = Buffer.byteLength(html, 'utf8');
    const contentHash = hashContent(html);

    // Parse HTML
    const $ = cheerio.load(html);

    // Extract metadata
    const title =
      $('title').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      '';
    const description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') ||
      '';

    // Extract links
    const linksFound: string[] = [];
    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (href) {
        const absoluteUrl = resolveUrl(url, href);
        if (absoluteUrl && shouldCrawl(absoluteUrl)) {
          const normalized = normalizeUrl(absoluteUrl);
          if (!linksFound.includes(normalized)) {
            linksFound.push(normalized);
          }
        }
      }
    });

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
    };
  }

  /**
   * Store crawl result in database
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

    // Update domain page count
    await pool.query(
      `UPDATE domains SET page_count = page_count + 1, updated_at = NOW() WHERE domain = $1`,
      [domain]
    );
  }

  /**
   * Get worker statistics
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

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
