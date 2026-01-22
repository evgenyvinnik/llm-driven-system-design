# Web Crawler - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Introduction (2 minutes)

"Thank you for having me. Today I'll design a distributed web crawler for indexing the internet at scale. This system is fascinating from a backend perspective because it requires:

1. **Two-level URL frontier** with priority queues and per-domain rate limiting
2. **Distributed coordination** across crawler workers using consistent hashing
3. **Massive deduplication** using Bloom filters for URLs and SimHash for content
4. **Politeness enforcement** respecting robots.txt and rate limits per domain

The core backend challenge is crawling billions of pages while being a good citizen of the web. Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our distributed crawler:

1. **URL Discovery**: Extract and queue links from crawled pages
2. **Page Fetching**: Download pages respecting robots.txt and rate limits
3. **Content Storage**: Store crawled content for indexing
4. **Duplicate Detection**: Avoid re-crawling identical URLs and content
5. **Prioritization**: Crawl important pages first based on domain authority

I'll focus on the URL frontier design, distributed crawling, and deduplication since those are the most challenging backend problems."

### Non-Functional Requirements

"Key constraints:

- **Scale**: 10 billion pages, 1 billion unique domains
- **Throughput**: 10,000 pages/second across all workers
- **Freshness**: Re-crawl important pages within 24 hours
- **Politeness**: Maximum 1 request per second per domain
- **Storage**: Efficient storage for page content and metadata

The politeness constraint is critical - we must be good citizens or risk getting blocked."

---

## High-Level Design (8 minutes)

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Seed URL Ingestion                              │
│                    (Admin API, Sitemaps, External)                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           URL Frontier                                  │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Front Queues (Priority)                       │   │
│  │         High ──────► Medium ──────► Low                          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│                                    ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                  Back Queues (Per-Domain)                        │   │
│  │    Domain A │ Domain B │ Domain C │ ... │ Domain N               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │ Worker 1  │   │ Worker 2  │   │ Worker N  │
            │           │   │           │   │           │
            │ - Fetch   │   │ - Fetch   │   │ - Fetch   │
            │ - Parse   │   │ - Parse   │   │ - Parse   │
            │ - Extract │   │ - Extract │   │ - Extract │
            └───────────┘   └───────────┘   └───────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Storage Layer                                   │
├─────────────────┬─────────────────┬─────────────────────────────────────┤
│   PostgreSQL    │      Redis      │           Object Store              │
│  - URL frontier │  - Bloom filter │         - Page content              │
│  - Crawl state  │  - Rate limits  │         - Robots.txt                │
│  - Domain meta  │  - URL dedup    │         - Screenshots               │
└─────────────────┴─────────────────┴─────────────────────────────────────┘
```

### Two-Level Queue Design

"The URL frontier uses a two-level queue architecture inspired by the Mercator paper:

**Front Queues (Priority-based)**:
- High: Seed URLs, homepages, important pages
- Medium: Content pages, blog posts
- Low: Pagination, archives, less important

**Back Queues (Domain-based)**:
- One queue per domain
- Enforces per-domain rate limiting
- Prevents any single domain from dominating

This separation ensures priority is respected while maintaining politeness."

---

## Deep Dive: URL Frontier Implementation (10 minutes)

### PostgreSQL Schema for Frontier

```sql
-- URL frontier with priority and domain separation
CREATE TABLE url_frontier (
    id              BIGSERIAL PRIMARY KEY,
    url             TEXT NOT NULL,
    url_hash        CHAR(64) NOT NULL,  -- SHA-256 for dedup
    domain          TEXT NOT NULL,
    priority        SMALLINT NOT NULL DEFAULT 1,  -- 0=high, 1=medium, 2=low
    depth           SMALLINT NOT NULL DEFAULT 0,
    discovered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scheduled_at    TIMESTAMPTZ,  -- When eligible for crawling
    status          TEXT NOT NULL DEFAULT 'pending',
    worker_id       TEXT,
    locked_until    TIMESTAMPTZ,
    retry_count     SMALLINT NOT NULL DEFAULT 0,
    parent_url_id   BIGINT REFERENCES url_frontier(id),

    CONSTRAINT url_frontier_url_hash_unique UNIQUE (url_hash)
);

-- Indexes for efficient queue operations
CREATE INDEX idx_frontier_pending ON url_frontier (priority, scheduled_at)
    WHERE status = 'pending' AND scheduled_at <= NOW();
CREATE INDEX idx_frontier_domain ON url_frontier (domain, status);
CREATE INDEX idx_frontier_worker ON url_frontier (worker_id, locked_until)
    WHERE status = 'processing';

-- Domain metadata for rate limiting and robots.txt
CREATE TABLE domains (
    id              SERIAL PRIMARY KEY,
    domain          TEXT NOT NULL UNIQUE,
    robots_txt      TEXT,
    robots_fetched_at TIMESTAMPTZ,
    crawl_delay     INTEGER DEFAULT 1000,  -- milliseconds
    last_crawl_at   TIMESTAMPTZ,
    total_pages     INTEGER DEFAULT 0,
    avg_page_size   INTEGER,
    is_blocked      BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Crawled pages for content storage
CREATE TABLE crawled_pages (
    id              BIGSERIAL PRIMARY KEY,
    url_id          BIGINT REFERENCES url_frontier(id),
    url             TEXT NOT NULL,
    domain          TEXT NOT NULL,
    status_code     SMALLINT,
    content_type    TEXT,
    content_hash    CHAR(64),  -- SimHash for near-duplicate detection
    content_length  INTEGER,
    title           TEXT,
    crawled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    response_time_ms INTEGER,
    storage_path    TEXT  -- S3/MinIO path for content
);
```

### Fetching URLs with Distributed Locking

```typescript
interface FrontierURL {
  id: number;
  url: string;
  domain: string;
  priority: number;
  depth: number;
}

async function fetchNextBatch(workerId: string, batchSize: number = 10): Promise<FrontierURL[]> {
  const lockDuration = 300; // 5 minutes

  return await pool.query(`
    WITH eligible_domains AS (
      -- Find domains that are ready for crawling (respecting rate limits)
      SELECT DISTINCT domain
      FROM url_frontier uf
      JOIN domains d ON uf.domain = d.domain
      WHERE uf.status = 'pending'
        AND uf.scheduled_at <= NOW()
        AND (d.last_crawl_at IS NULL OR
             d.last_crawl_at + (d.crawl_delay || ' milliseconds')::INTERVAL <= NOW())
        AND d.is_blocked = FALSE
      LIMIT $2
    ),
    selected_urls AS (
      -- Select one URL per eligible domain, ordered by priority
      SELECT DISTINCT ON (uf.domain)
        uf.id, uf.url, uf.domain, uf.priority, uf.depth
      FROM url_frontier uf
      JOIN eligible_domains ed ON uf.domain = ed.domain
      WHERE uf.status = 'pending'
        AND uf.scheduled_at <= NOW()
      ORDER BY uf.domain, uf.priority, uf.discovered_at
    )
    UPDATE url_frontier
    SET
      status = 'processing',
      worker_id = $1,
      locked_until = NOW() + INTERVAL '${lockDuration} seconds'
    FROM selected_urls
    WHERE url_frontier.id = selected_urls.id
    RETURNING url_frontier.id, url_frontier.url, url_frontier.domain,
              url_frontier.priority, url_frontier.depth
  `, [workerId, batchSize]);
}
```

### Redis for Fast URL Deduplication

```typescript
import { createHash } from 'crypto';

class URLDeduplicator {
  private redis: Redis;
  private bloomFilterKey = 'crawler:url_bloom';

  constructor(redis: Redis) {
    this.redis = redis;
  }

  // Check if URL was already seen using Bloom filter
  async isURLSeen(url: string): Promise<boolean> {
    const hash = this.hashURL(url);

    // Use multiple hash functions for Bloom filter
    const positions = this.getBloomPositions(hash, 10);

    const pipeline = this.redis.pipeline();
    for (const pos of positions) {
      pipeline.getbit(this.bloomFilterKey, pos);
    }

    const results = await pipeline.exec();

    // If all bits are set, URL is probably seen
    return results?.every(([err, bit]) => bit === 1) ?? false;
  }

  // Mark URL as seen in Bloom filter
  async markURLSeen(url: string): Promise<void> {
    const hash = this.hashURL(url);
    const positions = this.getBloomPositions(hash, 10);

    const pipeline = this.redis.pipeline();
    for (const pos of positions) {
      pipeline.setbit(this.bloomFilterKey, pos, 1);
    }
    await pipeline.exec();
  }

  private hashURL(url: string): string {
    // Normalize URL before hashing
    const normalized = this.normalizeURL(url);
    return createHash('sha256').update(normalized).digest('hex');
  }

  private normalizeURL(url: string): string {
    const parsed = new URL(url);
    // Remove fragments, normalize trailing slashes, lowercase
    parsed.hash = '';
    let path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`.toLowerCase();
  }

  private getBloomPositions(hash: string, count: number): number[] {
    const positions: number[] = [];
    const filterSize = 10_000_000_000; // 10 billion bits = ~1.25GB

    for (let i = 0; i < count; i++) {
      const subHash = createHash('md5')
        .update(hash + i.toString())
        .digest('hex');
      const position = parseInt(subHash.substring(0, 15), 16) % filterSize;
      positions.push(position);
    }

    return positions;
  }
}
```

---

## Deep Dive: Politeness and Rate Limiting (8 minutes)

### robots.txt Caching

```typescript
import robotsParser from 'robots-parser';

interface RobotsTxt {
  content: string;
  fetchedAt: Date;
  crawlDelay: number;
}

class RobotsCache {
  private redis: Redis;
  private cacheTTL = 3600; // 1 hour

  async getRobots(domain: string): Promise<RobotsTxt | null> {
    // Check Redis cache first
    const cached = await this.redis.get(`robots:${domain}`);
    if (cached) {
      return JSON.parse(cached);
    }

    // Fetch from origin
    try {
      const robotsUrl = `https://${domain}/robots.txt`;
      const response = await fetch(robotsUrl, {
        headers: { 'User-Agent': 'MyCrawler/1.0' },
        signal: AbortSignal.timeout(10000)
      });

      if (response.ok) {
        const content = await response.text();
        const parser = robotsParser(robotsUrl, content);

        const robots: RobotsTxt = {
          content,
          fetchedAt: new Date(),
          crawlDelay: parser.getCrawlDelay('MyCrawler') || 1
        };

        // Cache in Redis
        await this.redis.setex(
          `robots:${domain}`,
          this.cacheTTL,
          JSON.stringify(robots)
        );

        // Also update PostgreSQL for persistence
        await pool.query(`
          INSERT INTO domains (domain, robots_txt, robots_fetched_at, crawl_delay)
          VALUES ($1, $2, NOW(), $3)
          ON CONFLICT (domain) DO UPDATE
          SET robots_txt = $2, robots_fetched_at = NOW(), crawl_delay = $3
        `, [domain, content, robots.crawlDelay * 1000]);

        return robots;
      }

      return null;
    } catch (error) {
      // If fetch fails, allow crawling with default delay
      return { content: '', fetchedAt: new Date(), crawlDelay: 1 };
    }
  }

  isURLAllowed(robotsContent: string, url: string): boolean {
    const parser = robotsParser(url, robotsContent);
    return parser.isAllowed(url, 'MyCrawler') ?? true;
  }
}
```

### Distributed Rate Limiting with Redis

```typescript
class DomainRateLimiter {
  private redis: Redis;

  // Sliding window rate limiter per domain
  async acquireSlot(domain: string, crawlDelayMs: number): Promise<boolean> {
    const key = `ratelimit:${domain}`;
    const now = Date.now();

    // Use Redis transaction for atomicity
    const result = await this.redis
      .multi()
      .get(key)
      .exec();

    const lastCrawl = result?.[0]?.[1] as string | null;

    if (lastCrawl) {
      const elapsed = now - parseInt(lastCrawl, 10);
      if (elapsed < crawlDelayMs) {
        return false; // Rate limit not satisfied
      }
    }

    // Acquire slot with distributed lock
    const lockKey = `lock:domain:${domain}`;
    const lockAcquired = await this.redis.set(
      lockKey,
      'locked',
      'PX', crawlDelayMs,
      'NX'
    );

    if (lockAcquired) {
      await this.redis.set(key, now.toString(), 'PX', crawlDelayMs * 2);
      return true;
    }

    return false;
  }

  // Adaptive rate limiting based on response times
  async adjustCrawlDelay(domain: string, responseTimeMs: number): Promise<void> {
    const key = `crawldelay:${domain}`;

    // If server is slow, increase delay
    if (responseTimeMs > 5000) {
      await this.redis.incrbyfloat(key, 0.5);
    } else if (responseTimeMs < 500) {
      // Fast server, can slightly decrease (but respect robots.txt minimum)
      const current = await this.redis.get(key);
      if (current && parseFloat(current) > 1) {
        await this.redis.incrbyfloat(key, -0.1);
      }
    }
  }
}
```

---

## Deep Dive: Content Deduplication with SimHash (6 minutes)

### Near-Duplicate Detection

```typescript
class SimHasher {
  private featureWeights: Map<string, number> = new Map();

  // Generate SimHash for content
  computeSimHash(content: string): bigint {
    // Extract features (shingles)
    const shingles = this.getShingles(content, 3);
    const hashBits = 64;
    const vector = new Array(hashBits).fill(0);

    for (const shingle of shingles) {
      const hash = this.hashShingle(shingle);
      const weight = 1; // Could use TF-IDF weights

      for (let i = 0; i < hashBits; i++) {
        if ((hash >> BigInt(i)) & 1n) {
          vector[i] += weight;
        } else {
          vector[i] -= weight;
        }
      }
    }

    // Convert to final hash
    let simhash = 0n;
    for (let i = 0; i < hashBits; i++) {
      if (vector[i] > 0) {
        simhash |= (1n << BigInt(i));
      }
    }

    return simhash;
  }

  // Check if two pages are near-duplicates
  areNearDuplicates(hash1: bigint, hash2: bigint, threshold: number = 3): boolean {
    const hammingDistance = this.hammingDistance(hash1, hash2);
    return hammingDistance <= threshold;
  }

  private getShingles(text: string, k: number): Set<string> {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    const words = normalized.split(' ');
    const shingles = new Set<string>();

    for (let i = 0; i <= words.length - k; i++) {
      shingles.add(words.slice(i, i + k).join(' '));
    }

    return shingles;
  }

  private hashShingle(shingle: string): bigint {
    // Use a 64-bit hash
    const hash = createHash('md5').update(shingle).digest('hex');
    return BigInt('0x' + hash.substring(0, 16));
  }

  private hammingDistance(a: bigint, b: bigint): number {
    let xor = a ^ b;
    let distance = 0;
    while (xor > 0n) {
      distance += Number(xor & 1n);
      xor >>= 1n;
    }
    return distance;
  }
}

// Find near-duplicates in database
async function findNearDuplicates(newHash: string): Promise<number[]> {
  // For efficiency, use locality-sensitive hashing (LSH)
  // Split hash into bands and query by band matches

  const bandSize = 8; // 8 bands of 8 bits each
  const duplicateIds: number[] = [];

  for (let band = 0; band < 8; band++) {
    const bandHash = newHash.substring(band * 2, (band + 1) * 2);

    const results = await pool.query(`
      SELECT id, content_hash
      FROM crawled_pages
      WHERE SUBSTRING(content_hash FROM $1 FOR 2) = $2
      LIMIT 100
    `, [band * 2 + 1, bandHash]);

    for (const row of results.rows) {
      const distance = hammingDistance(newHash, row.content_hash);
      if (distance <= 3) {
        duplicateIds.push(row.id);
      }
    }
  }

  return duplicateIds;
}
```

---

## Deep Dive: Distributed Crawling with Consistent Hashing (5 minutes)

### Worker Assignment

```typescript
import { createHash } from 'crypto';

class ConsistentHashRing {
  private ring: Map<number, string> = new Map();
  private sortedKeys: number[] = [];
  private virtualNodes = 150;

  addWorker(workerId: string): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const key = this.hash(`${workerId}:${i}`);
      this.ring.set(key, workerId);
    }
    this.sortedKeys = Array.from(this.ring.keys()).sort((a, b) => a - b);
  }

  removeWorker(workerId: string): void {
    for (let i = 0; i < this.virtualNodes; i++) {
      const key = this.hash(`${workerId}:${i}`);
      this.ring.delete(key);
    }
    this.sortedKeys = Array.from(this.ring.keys()).sort((a, b) => a - b);
  }

  // Get worker responsible for a domain
  getWorkerForDomain(domain: string): string {
    if (this.sortedKeys.length === 0) {
      throw new Error('No workers available');
    }

    const domainHash = this.hash(domain);

    // Binary search for the first key >= domainHash
    let left = 0;
    let right = this.sortedKeys.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.sortedKeys[mid] >= domainHash) {
        right = mid;
      } else {
        left = mid + 1;
      }
    }

    // Wrap around to first key if needed
    const keyIndex = left === this.sortedKeys.length ? 0 : left;
    return this.ring.get(this.sortedKeys[keyIndex])!;
  }

  private hash(key: string): number {
    const hash = createHash('md5').update(key).digest('hex');
    return parseInt(hash.substring(0, 8), 16);
  }
}

// Worker coordinator using consistent hashing
class CrawlerCoordinator {
  private hashRing: ConsistentHashRing;
  private redis: Redis;

  async assignDomainsToWorkers(): Promise<Map<string, string[]>> {
    // Get all pending domains
    const domains = await pool.query(`
      SELECT DISTINCT domain
      FROM url_frontier
      WHERE status = 'pending'
      LIMIT 10000
    `);

    const assignments = new Map<string, string[]>();

    for (const row of domains.rows) {
      const worker = this.hashRing.getWorkerForDomain(row.domain);

      if (!assignments.has(worker)) {
        assignments.set(worker, []);
      }
      assignments.get(worker)!.push(row.domain);
    }

    // Store assignments in Redis for workers to read
    for (const [worker, domains] of assignments) {
      await this.redis.sadd(`worker:${worker}:domains`, ...domains);
      await this.redis.expire(`worker:${worker}:domains`, 300);
    }

    return assignments;
  }
}
```

---

## Deep Dive: Circuit Breaker per Domain (4 minutes)

```typescript
enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

class DomainCircuitBreaker {
  private redis: Redis;
  private failureThreshold = 5;
  private recoveryTimeout = 300000; // 5 minutes

  async recordSuccess(domain: string): Promise<void> {
    const key = `circuit:${domain}`;
    await this.redis
      .multi()
      .hset(key, 'failures', '0')
      .hset(key, 'state', CircuitState.CLOSED)
      .expire(key, 3600)
      .exec();
  }

  async recordFailure(domain: string): Promise<void> {
    const key = `circuit:${domain}`;

    const failures = await this.redis.hincrby(key, 'failures', 1);

    if (failures >= this.failureThreshold) {
      await this.redis
        .multi()
        .hset(key, 'state', CircuitState.OPEN)
        .hset(key, 'openedAt', Date.now().toString())
        .expire(key, 3600)
        .exec();

      // Block domain temporarily
      await pool.query(`
        UPDATE domains
        SET is_blocked = TRUE
        WHERE domain = $1
      `, [domain]);
    }
  }

  async canRequest(domain: string): Promise<boolean> {
    const key = `circuit:${domain}`;
    const state = await this.redis.hget(key, 'state');

    if (state === CircuitState.CLOSED || !state) {
      return true;
    }

    if (state === CircuitState.OPEN) {
      const openedAt = await this.redis.hget(key, 'openedAt');
      if (openedAt && Date.now() - parseInt(openedAt) > this.recoveryTimeout) {
        // Transition to half-open
        await this.redis.hset(key, 'state', CircuitState.HALF_OPEN);
        return true;
      }
      return false;
    }

    // Half-open: allow one request
    return true;
  }
}
```

---

## API Design (3 minutes)

### RESTful Endpoints

```typescript
// Seed URL management
POST   /api/v1/urls/seed          // Add seed URLs
GET    /api/v1/urls/pending       // Get pending URL count
DELETE /api/v1/urls/:id           // Remove URL from frontier

// Domain management
GET    /api/v1/domains            // List all domains
GET    /api/v1/domains/:domain    // Get domain stats
PUT    /api/v1/domains/:domain/block    // Block domain
DELETE /api/v1/domains/:domain/block    // Unblock domain

// Crawl results
GET    /api/v1/pages              // Search crawled pages
GET    /api/v1/pages/:id          // Get page content
GET    /api/v1/pages/:id/links    // Get outbound links

// Worker management
GET    /api/v1/workers            // List active workers
GET    /api/v1/workers/:id/stats  // Worker statistics

// System stats
GET    /api/v1/stats              // Overall crawl statistics
GET    /api/v1/stats/throughput   // Pages per second over time
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| URL Storage | PostgreSQL + Redis Bloom | Cassandra | PostgreSQL for learning; Cassandra for 10B+ URLs |
| Rate Limiting | Redis locks | Token bucket | Simpler, lock-based is sufficient at this scale |
| Content Dedup | SimHash | MinHash | SimHash is simpler, works well for documents |
| Worker Coordination | Consistent hashing | Kafka partitions | More control over domain assignment |
| Queue Design | Two-level (priority + domain) | Single priority queue | Ensures politeness and priority balance |

---

## Future Enhancements

With more time, I would add:

1. **JavaScript rendering** with Puppeteer for SPA content
2. **Kafka integration** for higher throughput URL frontier
3. **Machine learning** for page importance scoring
4. **Sitemap parsing** for efficient discovery
5. **Content extraction** pipeline for structured data

---

## Summary

"I've designed a distributed web crawler with:

1. **Two-level URL frontier** separating priority from per-domain politeness
2. **Bloom filter deduplication** for O(1) URL seen checks at scale
3. **SimHash content deduplication** for near-duplicate detection
4. **Consistent hashing** for domain-to-worker assignment
5. **Circuit breakers** for graceful handling of problematic domains
6. **robots.txt caching** with Redis and PostgreSQL persistence

The architecture respects web politeness while maximizing crawl throughput through distributed coordination."
