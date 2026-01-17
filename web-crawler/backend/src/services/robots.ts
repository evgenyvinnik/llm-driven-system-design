import axios from 'axios';
import robotsParser from 'robots-parser';
import { redis, REDIS_KEYS } from '../models/redis.js';
import { pool } from '../models/database.js';
import { config } from '../config.js';

/**
 * Robots.txt Service
 * Fetches, parses, and caches robots.txt for domains
 */
export class RobotsService {
  private cache: Map<
    string,
    {
      parser: ReturnType<typeof robotsParser>;
      fetchedAt: number;
    }
  > = new Map();

  /**
   * Fetch and parse robots.txt for a domain
   */
  async fetchRobotsTxt(domain: string): Promise<string | null> {
    try {
      const url = `https://${domain}/robots.txt`;
      const response = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': config.crawler.userAgent,
        },
        validateStatus: (status) => status < 500,
      });

      if (response.status === 200) {
        return response.data;
      }

      // Try HTTP if HTTPS fails
      try {
        const httpUrl = `http://${domain}/robots.txt`;
        const httpResponse = await axios.get(httpUrl, {
          timeout: 10000,
          headers: {
            'User-Agent': config.crawler.userAgent,
          },
          validateStatus: (status) => status < 500,
        });

        if (httpResponse.status === 200) {
          return httpResponse.data;
        }
      } catch {
        // HTTP also failed, continue with null
      }

      return null;
    } catch (error) {
      console.error(`Failed to fetch robots.txt for ${domain}:`, error);
      return null;
    }
  }

  /**
   * Get or fetch robots.txt parser for a domain
   */
  async getParser(
    domain: string
  ): Promise<ReturnType<typeof robotsParser> | null> {
    const now = Date.now();

    // Check in-memory cache first
    const cached = this.cache.get(domain);
    if (cached && now - cached.fetchedAt < config.crawler.robotsTxtCacheTtl * 1000) {
      return cached.parser;
    }

    // Check Redis cache
    const redisCached = await redis.get(REDIS_KEYS.DOMAIN_ROBOTS(domain));
    if (redisCached) {
      const parser = robotsParser(`https://${domain}/robots.txt`, redisCached);
      this.cache.set(domain, { parser, fetchedAt: now });
      return parser;
    }

    // Fetch from network
    const robotsTxt = await this.fetchRobotsTxt(domain);
    const robotsContent = robotsTxt || '';

    const parser = robotsParser(
      `https://${domain}/robots.txt`,
      robotsContent
    );

    // Cache in Redis
    await redis.setex(
      REDIS_KEYS.DOMAIN_ROBOTS(domain),
      config.crawler.robotsTxtCacheTtl,
      robotsContent
    );

    // Cache in memory
    this.cache.set(domain, { parser, fetchedAt: now });

    // Extract crawl delay and store
    const crawlDelay = parser.getCrawlDelay(config.crawler.userAgent) || 1.0;
    await redis.set(REDIS_KEYS.DOMAIN_DELAY(domain), crawlDelay.toString());

    // Update database
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
   * Check if a URL is allowed to be crawled according to robots.txt
   */
  async isAllowed(url: string, domain: string): Promise<boolean> {
    try {
      const parser = await this.getParser(domain);
      if (!parser) {
        // If we can't get robots.txt, assume allowed
        return true;
      }

      return parser.isAllowed(url, config.crawler.userAgent) ?? true;
    } catch (error) {
      console.error(`Error checking robots.txt for ${url}:`, error);
      return true;
    }
  }

  /**
   * Get crawl delay for a domain
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
   * Get sitemap URLs from robots.txt
   */
  async getSitemaps(domain: string): Promise<string[]> {
    const parser = await this.getParser(domain);
    if (!parser) {
      return [];
    }

    return parser.getSitemaps();
  }

  /**
   * Clear cache for a domain
   */
  clearCache(domain: string): void {
    this.cache.delete(domain);
    redis.del(REDIS_KEYS.DOMAIN_ROBOTS(domain));
    redis.del(REDIS_KEYS.DOMAIN_DELAY(domain));
  }
}

export const robotsService = new RobotsService();
