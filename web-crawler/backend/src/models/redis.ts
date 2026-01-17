import Redis from 'ioredis';
import { config } from '../config.js';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Keys used in Redis
export const REDIS_KEYS = {
  // Set of all visited URL hashes (for deduplication)
  VISITED_URLS: 'crawler:visited_urls',

  // Per-domain last access timestamp
  DOMAIN_LAST_ACCESS: (domain: string) => `crawler:domain:${domain}:last_access`,

  // Per-domain robots.txt cache
  DOMAIN_ROBOTS: (domain: string) => `crawler:domain:${domain}:robots`,

  // Per-domain crawl delay
  DOMAIN_DELAY: (domain: string) => `crawler:domain:${domain}:delay`,

  // Domain lock for distributed rate limiting
  DOMAIN_LOCK: (domain: string) => `crawler:domain:${domain}:lock`,

  // Worker heartbeat
  WORKER_HEARTBEAT: (workerId: string) => `crawler:worker:${workerId}:heartbeat`,

  // Active workers set
  ACTIVE_WORKERS: 'crawler:active_workers',

  // Stats counters
  STATS_PAGES_CRAWLED: 'crawler:stats:pages_crawled',
  STATS_PAGES_FAILED: 'crawler:stats:pages_failed',
  STATS_BYTES_DOWNLOADED: 'crawler:stats:bytes_downloaded',
  STATS_LINKS_DISCOVERED: 'crawler:stats:links_discovered',
  STATS_DUPLICATES_SKIPPED: 'crawler:stats:duplicates_skipped',

  // Priority queues for URL frontier (using sorted sets)
  PRIORITY_QUEUE_HIGH: 'crawler:queue:high',
  PRIORITY_QUEUE_MEDIUM: 'crawler:queue:medium',
  PRIORITY_QUEUE_LOW: 'crawler:queue:low',
};

export async function closeRedis() {
  await redis.quit();
}
