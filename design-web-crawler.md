# System Design: Distributed Web Crawler

## Overview

Design a scalable, distributed web crawler that can efficiently crawl millions of web pages while respecting politeness policies, handling failures gracefully, and extracting structured data for indexing.

## Functional Requirements

### Core Features
1. **URL Discovery & Crawling**
   - Accept seed URLs to start crawling
   - Follow links discovered on pages
   - Crawl depth control (max depth from seed URL)
   - Domain-specific crawling (stay within domain or follow external links)

2. **Politeness & Compliance**
   - Respect `robots.txt` rules
   - Implement rate limiting per domain (avoid overwhelming servers)
   - Honor `Crawl-Delay` directives
   - Support for `nofollow` and `noindex` meta tags

3. **Content Extraction**
   - Download HTML content
   - Extract links (hrefs) for further crawling
   - Extract metadata (title, description, keywords)
   - Store page content and metadata

4. **Duplicate Detection**
   - Avoid crawling the same URL multiple times
   - URL normalization (handle URL parameters, trailing slashes, fragments)
   - Content deduplication (detect near-duplicate pages)

### User Personas

#### End User (Developer/Researcher)
- Submit crawl jobs with seed URLs
- Configure crawl parameters (depth, domain restrictions, rate limits)
- View crawl progress and status
- Query and search crawled data
- Export crawled data (JSON, CSV)

#### Admin/Operator
- Monitor system health and performance
- View crawl statistics (pages/sec, queue size, error rates)
- Manage crawler politeness policies globally
- Blacklist domains (spam, illegal content)
- Pause/resume/cancel crawl jobs
- View resource utilization (CPU, memory, network)
- Configure crawler instances (add/remove workers)

## Non-Functional Requirements

### Scale
- **Crawl Rate:** 100-1000 pages per second
- **URL Frontier:** Support millions of URLs in queue
- **Storage:** Billions of crawled pages
- **Concurrent Crawls:** Support multiple independent crawl jobs

### Performance
- **Latency:** Minimal delay between URL discovery and crawling
- **Throughput:** Maximize pages crawled per second while respecting politeness
- **Efficiency:** Minimize duplicate work (URL deduplication)

### Reliability
- **Fault Tolerance:** Handle worker failures gracefully
- **Resumability:** Resume crawls after crashes
- **Data Integrity:** Ensure no data loss during failures

### Operational
- **Monitoring:** Real-time visibility into crawl progress and health
- **Configurability:** Adjust crawl parameters without code changes
- **Scalability:** Horizontally scale crawler workers

## Key Technical Challenges

1. **URL Frontier Management**
   - How to efficiently store and prioritize millions of URLs?
   - How to ensure politeness (rate limiting per domain)?
   - How to handle priority (crawl important pages first)?

2. **Distributed Coordination**
   - How to distribute URLs across multiple crawler workers?
   - How to avoid duplicate crawls when scaling horizontally?
   - How to ensure even load distribution across workers?

3. **Robots.txt Handling**
   - Cache robots.txt to avoid re-fetching on every request
   - Handle robots.txt fetch failures gracefully
   - Respect expiration and refetch periodically

4. **Content Processing**
   - Extract links efficiently (HTML parsing)
   - Handle malformed HTML gracefully
   - Process JavaScript-rendered pages (optional: headless browser)

5. **Storage & Retrieval**
   - Store billions of pages efficiently
   - Support fast lookups for duplicate detection
   - Enable search and analytics on crawled data

## Architecture Approaches

### Approach 1: Single-Server Crawler (Simple, Educational)

**How it works:**
- Single Node.js process with in-memory URL queue
- Sequential crawling with async/await
- Local storage (PostgreSQL for metadata, file system for HTML)

**Pros:**
- Simple to implement and understand
- Easy to test and debug locally
- No distributed systems complexity

**Cons:**
- Limited throughput (single process bottleneck)
- Cannot scale beyond one machine
- Queue lost on crash (unless persisted)

**When to use:**
- Learning basic crawler concepts
- Small crawl jobs (<100k pages)
- Development and testing

### Approach 2: Multi-Worker Crawler with Shared Queue (Intermediate)

**How it works:**
- Redis as shared URL frontier (queue)
- Multiple Node.js worker processes pull URLs from queue
- PostgreSQL for metadata storage
- Workers coordinate via Redis

**Pros:**
- Horizontal scalability (add more workers)
- Shared queue ensures no duplicate work
- Workers can run on different machines
- Fault tolerance (workers can crash, queue persists)

**Cons:**
- Redis becomes single point of failure (mitigated with replication)
- Queue can grow very large (memory limits)
- Politeness enforcement requires coordination

**When to use:**
- Medium-scale crawls (100k-10M pages)
- Learning distributed systems concepts
- Production-ready for most use cases

### Approach 3: Fully Distributed Crawler with Partitioned Frontier (Advanced)

**How it works:**
- URL frontier partitioned by domain (consistent hashing)
- Each worker owns a subset of domains
- Kafka for URL distribution and job coordination
- Separate queue per domain for politeness
- Distributed storage (Cassandra or S3 for page content)

**Pros:**
- Massive scalability (crawl billions of pages)
- Natural politeness enforcement (one queue per domain)
- No single point of contention
- Efficient use of resources

**Cons:**
- Complex implementation (partitioning, rebalancing)
- Requires Kafka or similar distributed queue
- Operational overhead (monitoring, debugging)

**When to use:**
- Large-scale crawls (>10M pages)
- Building a search engine or data platform
- Learning advanced distributed systems

## Recommended Approach: Multi-Worker Crawler with Shared Queue (Approach 2)

**Rationale:**
- Balances scalability with implementation complexity
- Can run locally (3-5 workers) for testing
- Teaches core distributed crawler concepts
- Sufficient for most real-world use cases
- Can evolve to Approach 3 if needed

**Trade-offs:**
- Not as scalable as Approach 3 (but handles millions of pages)
- Redis memory limits (can partition queue if needed)
- Still need to implement politeness coordination

## Technology Stack

### Core Stack (following CLAUDE.md defaults)
- **Backend:** Node.js + Express
- **Queue:** Redis (or Valkey) for URL frontier
- **Database:** PostgreSQL for URL metadata, crawl jobs, statistics
- **Search/Analytics:** Elasticsearch for full-text search of crawled content
- **Storage:** File system (local development), S3 (production) for HTML content

### Why Node.js for Web Crawling?

**Pros:**
- Excellent async I/O (crawler is I/O-bound, not CPU-bound)
- Rich ecosystem for HTTP requests (`axios`, `node-fetch`)
- HTML parsing libraries (`cheerio`, `jsdom`)
- Event-driven architecture fits crawler workflow
- Can run many concurrent requests efficiently

**Cons:**
- Not ideal for CPU-intensive parsing (can offload to workers if needed)
- Single-threaded (mitigated by running multiple worker processes)

**Alternatives to consider:**
- **Go:** Faster, better concurrency primitives, but less ecosystem for HTML parsing
- **Python (Scrapy):** Rich crawler framework, but slower than Node.js/Go
- **Rust:** Maximum performance, but steeper learning curve

**Decision:** Stick with Node.js + Express for educational consistency. Performance is sufficient for crawler use case (I/O-bound).

### Key Libraries
- **HTTP Client:** `axios` or `node-fetch` (with retry logic)
- **HTML Parser:** `cheerio` (jQuery-like API, fast)
- **URL Parsing:** `url` (Node.js built-in) + custom normalization
- **Robots.txt Parser:** `robots-parser` npm package
- **Rate Limiting:** Custom implementation using Redis
- **Job Queue:** `bull` (Redis-backed job queue for Node.js)

## Detailed Design

### URL Frontier (Priority Queue with Politeness)

**Data Structures:**

```
Redis:
1. urls:pending (sorted set, score = priority/timestamp)
   - Stores URLs to be crawled
   - Score determines order (higher score = higher priority)

2. urls:visited (set)
   - Stores URL hashes to prevent duplicates
   - Use SHA256(normalized_url) for compact storage

3. domain:{domain}:last_crawl (key-value, TTL)
   - Tracks last crawl time per domain for rate limiting
   - TTL = crawl_delay (e.g., 1 second)

4. robots:{domain} (key-value, TTL)
   - Cache robots.txt rules per domain
   - TTL = 24 hours (re-fetch daily)

PostgreSQL:
1. crawl_jobs (id, seed_urls[], config, status, created_at)
   - Tracks crawl jobs submitted by users

2. crawled_pages (id, url, title, content_hash, job_id, crawled_at)
   - Metadata for each crawled page

3. crawl_stats (job_id, pages_crawled, errors, bytes_downloaded, updated_at)
   - Real-time statistics for each crawl job
```

**Politeness Algorithm:**

```typescript
async function canCrawlDomain(domain: string): Promise<boolean> {
  const lastCrawl = await redis.get(`domain:${domain}:last_crawl`);
  if (lastCrawl) {
    return false; // Too soon, respect crawl delay
  }
  return true;
}

async function markDomainCrawled(domain: string, delaySeconds: number = 1) {
  await redis.setex(`domain:${domain}:last_crawl`, delaySeconds, Date.now().toString());
}

async function getNextUrl(): Promise<string | null> {
  while (true) {
    // Get highest priority URL
    const urls = await redis.zrevrange('urls:pending', 0, 10); // Get top 10

    for (const url of urls) {
      const domain = new URL(url).hostname;

      if (await canCrawlDomain(domain)) {
        // Remove from queue
        await redis.zrem('urls:pending', url);
        await markDomainCrawled(domain);
        return url;
      }
    }

    // No URLs ready to crawl, wait briefly
    await sleep(100);
  }
}
```

### URL Normalization

**Why?** Same content can be accessible via different URLs:
- `http://example.com` vs `https://example.com`
- `example.com/page` vs `example.com/page/`
- `example.com/page?a=1&b=2` vs `example.com/page?b=2&a=1`

**Normalization Rules:**
```typescript
function normalizeUrl(url: string): string {
  const parsed = new URL(url);

  // 1. Convert to lowercase
  parsed.hostname = parsed.hostname.toLowerCase();

  // 2. Remove default ports
  if ((parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')) {
    parsed.port = '';
  }

  // 3. Remove trailing slash (unless root)
  if (parsed.pathname !== '/') {
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
  }

  // 4. Sort query parameters alphabetically
  const params = Array.from(parsed.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b));
  parsed.search = new URLSearchParams(params).toString();

  // 5. Remove fragment (not sent to server)
  parsed.hash = '';

  return parsed.toString();
}
```

### Robots.txt Handling

**Caching Strategy:**
```typescript
async function getRobotsRules(domain: string): Promise<RobotsParser> {
  // Check cache
  const cached = await redis.get(`robots:${domain}`);
  if (cached) {
    return parseRobots(cached);
  }

  // Fetch robots.txt
  try {
    const response = await axios.get(`https://${domain}/robots.txt`, {
      timeout: 5000,
      validateStatus: () => true // Accept all status codes
    });

    const robotsTxt = response.status === 200 ? response.data : '';

    // Cache for 24 hours
    await redis.setex(`robots:${domain}`, 86400, robotsTxt);

    return parseRobots(robotsTxt);
  } catch (error) {
    // On error, allow crawling (be permissive)
    console.error(`Failed to fetch robots.txt for ${domain}:`, error);
    return parseRobots(''); // Empty = allow all
  }
}

async function isAllowedByRobots(url: string): Promise<boolean> {
  const domain = new URL(url).hostname;
  const rules = await getRobotsRules(domain);
  return rules.isAllowed(url, 'MyBotName');
}
```

### Crawler Worker Implementation

```typescript
class CrawlerWorker {
  private workerId: string;
  private running: boolean = false;

  constructor(workerId: string) {
    this.workerId = workerId;
  }

  async start() {
    this.running = true;
    console.log(`Worker ${this.workerId} started`);

    while (this.running) {
      try {
        const url = await getNextUrl();
        if (!url) {
          await sleep(1000); // No URLs ready, wait
          continue;
        }

        await this.crawlUrl(url);
      } catch (error) {
        console.error(`Worker ${this.workerId} error:`, error);
      }
    }
  }

  async crawlUrl(url: string) {
    console.log(`[${this.workerId}] Crawling: ${url}`);

    // Check robots.txt
    if (!await isAllowedByRobots(url)) {
      console.log(`[${this.workerId}] Blocked by robots.txt: ${url}`);
      return;
    }

    // Fetch page
    const response = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'MyBotName/1.0 (+https://example.com/bot)'
      }
    });

    const html = response.data;
    const contentType = response.headers['content-type'] || '';

    // Only process HTML
    if (!contentType.includes('text/html')) {
      return;
    }

    // Parse HTML
    const $ = cheerio.load(html);

    // Extract metadata
    const title = $('title').text();
    const metaDescription = $('meta[name="description"]').attr('content') || '';

    // Store page
    await this.storePage(url, title, html);

    // Extract links
    const links = this.extractLinks($, url);

    // Add links to frontier
    await this.addLinksToFrontier(links);

    console.log(`[${this.workerId}] Crawled: ${url} (${links.length} links found)`);
  }

  extractLinks($: cheerio.Root, baseUrl: string): string[] {
    const links: string[] = [];

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;

      try {
        // Resolve relative URLs
        const absoluteUrl = new URL(href, baseUrl).toString();
        const normalizedUrl = normalizeUrl(absoluteUrl);

        // Filter unwanted URLs (images, PDFs, etc.)
        if (this.shouldCrawl(normalizedUrl)) {
          links.push(normalizedUrl);
        }
      } catch (error) {
        // Invalid URL, skip
      }
    });

    return links;
  }

  shouldCrawl(url: string): boolean {
    const parsed = new URL(url);

    // Skip non-HTTP protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    // Skip common non-HTML files
    const path = parsed.pathname.toLowerCase();
    const skipExtensions = ['.pdf', '.jpg', '.png', '.gif', '.zip', '.mp4'];
    if (skipExtensions.some(ext => path.endsWith(ext))) {
      return false;
    }

    return true;
  }

  async addLinksToFrontier(links: string[]) {
    for (const link of links) {
      const urlHash = crypto.createHash('sha256').update(link).digest('hex');

      // Check if already visited
      const visited = await redis.sismember('urls:visited', urlHash);
      if (visited) continue;

      // Add to frontier
      await redis.zadd('urls:pending', Date.now(), link);
    }
  }

  async storePage(url: string, title: string, html: string) {
    const contentHash = crypto.createHash('sha256').update(html).digest('hex');
    const urlHash = crypto.createHash('sha256').update(url).digest('hex');

    // Mark as visited
    await redis.sadd('urls:visited', urlHash);

    // Store metadata in PostgreSQL
    await db.query(
      'INSERT INTO crawled_pages (url, title, content_hash, crawled_at) VALUES ($1, $2, $3, NOW())',
      [url, title, contentHash]
    );

    // Store HTML content (file system or S3)
    await fs.writeFile(`./crawled/${contentHash}.html`, html);
  }

  stop() {
    this.running = false;
    console.log(`Worker ${this.workerId} stopping`);
  }
}
```

### Running Multiple Workers Locally

**`package.json` scripts:**
```json
{
  "scripts": {
    "worker1": "WORKER_ID=worker1 ts-node src/worker.ts",
    "worker2": "WORKER_ID=worker2 ts-node src/worker.ts",
    "worker3": "WORKER_ID=worker3 ts-node src/worker.ts",
    "api": "ts-node src/api.ts"
  }
}
```

**Terminal setup:**
```bash
# Terminal 1: Start Redis
docker run -p 6379:6379 redis:latest

# Terminal 2: Start PostgreSQL
docker run -p 5432:5432 -e POSTGRES_PASSWORD=password postgres:latest

# Terminal 3: Start API server
npm run api

# Terminal 4: Start Worker 1
npm run worker1

# Terminal 5: Start Worker 2
npm run worker2

# Terminal 6: Start Worker 3
npm run worker3
```

## End-User API Endpoints

### Submit Crawl Job
```
POST /api/crawl/jobs
Content-Type: application/json

{
  "seedUrls": ["https://example.com"],
  "maxDepth": 3,
  "maxPages": 10000,
  "domainRestriction": "same-domain", // or "none"
  "crawlDelay": 1 // seconds between requests to same domain
}

Response:
{
  "jobId": "uuid",
  "status": "pending",
  "createdAt": "2024-01-15T10:00:00Z"
}
```

### Get Job Status
```
GET /api/crawl/jobs/:jobId

Response:
{
  "jobId": "uuid",
  "status": "running", // pending, running, completed, failed
  "pagesCrawled": 1523,
  "urlsInQueue": 3421,
  "errors": 12,
  "startedAt": "2024-01-15T10:00:00Z",
  "estimatedCompletion": "2024-01-15T11:30:00Z"
}
```

### Search Crawled Pages
```
GET /api/crawl/search?q=keyword&jobId=uuid&limit=10

Response:
{
  "results": [
    {
      "url": "https://example.com/page1",
      "title": "Example Page",
      "snippet": "...keyword in context...",
      "crawledAt": "2024-01-15T10:05:23Z"
    }
  ],
  "total": 145
}
```

### Export Crawled Data
```
GET /api/crawl/jobs/:jobId/export?format=json

Response: (streaming)
[
  {
    "url": "https://example.com/page1",
    "title": "Example Page",
    "contentHash": "sha256...",
    "crawledAt": "2024-01-15T10:05:23Z"
  },
  ...
]
```

## Admin Dashboard & API

### Dashboard Metrics

**System Overview:**
```
GET /api/admin/stats

Response:
{
  "workers": {
    "active": 3,
    "total": 5
  },
  "queue": {
    "pendingUrls": 15234,
    "visitedUrls": 1234567
  },
  "throughput": {
    "pagesPerSecond": 12.5,
    "last1min": 750,
    "last5min": 3600
  },
  "errors": {
    "last1hour": 23,
    "errorRate": 0.02 // 2%
  },
  "storage": {
    "totalPages": 1234567,
    "totalSizeGB": 45.6
  }
}
```

**Worker Health:**
```
GET /api/admin/workers

Response:
[
  {
    "workerId": "worker1",
    "status": "active",
    "currentUrl": "https://example.com/page123",
    "pagesCrawled": 5234,
    "uptimeSeconds": 3600,
    "lastHeartbeat": "2024-01-15T10:30:45Z"
  },
  ...
]
```

### Admin Operations

**Pause/Resume Crawl Job:**
```
POST /api/admin/jobs/:jobId/pause
POST /api/admin/jobs/:jobId/resume
```

**Blacklist Domain:**
```
POST /api/admin/blacklist
{
  "domain": "spam-site.com",
  "reason": "spam"
}
```

**Adjust Global Rate Limit:**
```
POST /api/admin/config/rate-limit
{
  "defaultCrawlDelay": 2 // seconds
}
```

**View Error Logs:**
```
GET /api/admin/errors?limit=100

Response:
[
  {
    "timestamp": "2024-01-15T10:25:34Z",
    "workerId": "worker2",
    "url": "https://broken-site.com",
    "error": "ETIMEDOUT",
    "retries": 3
  },
  ...
]
```

## Implementation Phases

### Phase 1: Single-Worker Crawler (Core Functionality)
**Goal:** Get basic crawling working locally

**Tasks:**
1. Implement URL frontier (Redis sorted set)
2. Implement URL normalization
3. Implement robots.txt fetching and parsing
4. Implement single crawler worker
5. Implement politeness (rate limiting per domain)
6. Store crawled pages (PostgreSQL + file system)
7. Test with a small seed URL

**Success Criteria:**
- Can crawl 100 pages from a seed URL
- Respects robots.txt
- No duplicate URLs crawled
- Rate limiting works (1 request/sec per domain)

### Phase 2: Multi-Worker Distributed Crawling
**Goal:** Scale horizontally with multiple workers

**Tasks:**
1. Run 3 crawler workers in parallel
2. Implement worker coordination via Redis
3. Verify no duplicate work across workers
4. Implement worker health checks (heartbeat)
5. Test with multiple seed URLs

**Success Criteria:**
- 3 workers crawl simultaneously without conflicts
- Throughput scales linearly (3x faster than 1 worker)
- Workers can be added/removed dynamically

### Phase 3: End-User API
**Goal:** Allow users to submit crawl jobs and query results

**Tasks:**
1. Create crawl jobs table (PostgreSQL)
2. Implement job submission API
3. Implement job status API
4. Implement search API (Elasticsearch integration)
5. Implement export API

**Success Criteria:**
- Users can submit crawl jobs via REST API
- Users can view crawl progress in real-time
- Users can search crawled content
- Users can export data as JSON/CSV

### Phase 4: Admin Dashboard
**Goal:** Operational visibility and control

**Tasks:**
1. Implement admin statistics API
2. Implement worker monitoring
3. Build admin UI (React + Tailwind)
4. Implement domain blacklisting
5. Implement crawl job management (pause/resume/cancel)

**Success Criteria:**
- Real-time dashboard shows system health
- Can pause/resume crawl jobs
- Can view and blacklist problematic domains
- Can monitor worker performance

### Phase 5: Optimization & Advanced Features
**Goal:** Handle large-scale crawls efficiently

**Tasks:**
1. Implement content deduplication (SimHash or MinHash)
2. Add priority queue (crawl important pages first)
3. Implement URL frontier partitioning (scale beyond single Redis)
4. Add incremental crawling (re-crawl pages periodically)
5. Implement distributed storage (S3 for HTML content)
6. Load test (simulate 1M URLs)

**Success Criteria:**
- Can handle 1M+ URLs in queue
- Duplicate content detected and skipped
- High-priority URLs crawled first
- System can scale to 10+ workers

## Distributed System Challenges

### Challenge 1: Duplicate URL Detection Across Workers

**Problem:** Multiple workers might try to crawl the same URL simultaneously.

**Solutions:**

**Option A: Check-and-Set with Redis (Optimistic)**
```typescript
async function claimUrl(url: string): Promise<boolean> {
  const urlHash = crypto.createHash('sha256').update(url).digest('hex');

  // Atomic operation: add to visited set, returns 1 if new, 0 if exists
  const added = await redis.sadd('urls:visited', urlHash);
  return added === 1; // True if we claimed it first
}

// In worker:
const url = await getNextUrl();
if (await claimUrl(url)) {
  await crawlUrl(url);
} else {
  // Another worker claimed it, skip
}
```

**Option B: Distributed Lock (Pessimistic)**
```typescript
async function crawlUrlWithLock(url: string) {
  const lock = await redisLock.acquire(`lock:${url}`, 60000); // 60s timeout

  try {
    if (!await isVisited(url)) {
      await crawlUrl(url);
    }
  } finally {
    await lock.release();
  }
}
```

**Recommendation:** Option A (check-and-set) is simpler and faster for this use case.

### Challenge 2: Politeness Coordination

**Problem:** If Worker A is crawling `example.com/page1` and Worker B picks `example.com/page2`, we might violate crawl delay.

**Solutions:**

**Option A: Distributed Rate Limiting with Redis**
```typescript
async function canCrawlDomain(domain: string, delaySeconds: number = 1): Promise<boolean> {
  const key = `domain:${domain}:last_crawl`;

  // Atomic check-and-set: only one worker can set this at a time
  const result = await redis.set(key, Date.now(), 'EX', delaySeconds, 'NX');
  return result === 'OK'; // True if we got the lock
}

// In worker:
const url = await getNextUrl();
const domain = new URL(url).hostname;

if (await canCrawlDomain(domain)) {
  await crawlUrl(url);
} else {
  // Another worker is crawling this domain, re-queue URL
  await redis.zadd('urls:pending', Date.now() + 1000, url);
}
```

**Option B: Domain-Partitioned Workers (Advanced)**
- Each worker is responsible for specific domains (consistent hashing)
- No coordination needed (only one worker per domain)
- Requires rebalancing when workers are added/removed

**Recommendation:** Option A for simplicity. Option B for maximum scalability.

### Challenge 3: Queue Grows Unbounded

**Problem:** Fast crawlers can discover millions of URLs, overwhelming Redis memory.

**Solutions:**

**Option A: Depth Limiting**
```typescript
// Store depth with each URL
await redis.zadd('urls:pending', Date.now(), JSON.stringify({ url, depth: 2 }));

// In worker:
const data = JSON.parse(urlData);
if (data.depth > MAX_DEPTH) {
  return; // Skip URLs beyond max depth
}
```

**Option B: Priority Queue with Eviction**
```typescript
// Keep only top N URLs in queue
const queueSize = await redis.zcard('urls:pending');
if (queueSize > MAX_QUEUE_SIZE) {
  // Remove lowest priority URLs
  await redis.zremrangebyrank('urls:pending', 0, queueSize - MAX_QUEUE_SIZE - 1);
}
```

**Option C: Spill to Disk**
- Keep hot URLs in Redis (1M most recent)
- Spill old URLs to PostgreSQL or Kafka
- Backfill Redis queue when it empties

**Recommendation:** Combine Option A (depth limiting) with Option B (queue size cap).

### Challenge 4: Worker Failures

**Problem:** Worker crashes while crawling a URL. URL is lost from queue but not crawled.

**Solutions:**

**Option A: Heartbeat + Job Timeout**
```typescript
// Worker claims URL with timeout
await redis.setex(`job:${url}`, 300, workerId); // 5 min timeout

// Monitor process:
setInterval(async () => {
  const jobs = await redis.keys('job:*');
  for (const jobKey of jobs) {
    const workerId = await redis.get(jobKey);
    const lastHeartbeat = await redis.get(`heartbeat:${workerId}`);

    if (!lastHeartbeat || Date.now() - lastHeartbeat > 60000) {
      // Worker dead, re-queue URL
      const url = jobKey.replace('job:', '');
      await redis.zadd('urls:pending', Date.now(), url);
      await redis.del(jobKey);
    }
  }
}, 30000); // Check every 30 seconds
```

**Option B: Job Queue with Acknowledgment (Bull)**
```typescript
// Use Bull queue with retries
const queue = new Bull('crawler', { redis: redisConfig });

queue.process(async (job) => {
  await crawlUrl(job.data.url);
});

// Add URL to queue
await queue.add({ url }, { attempts: 3, backoff: 10000 });
```

**Recommendation:** Option B (Bull queue) provides built-in retry logic and failure handling.

## Monitoring & Observability

### Key Metrics to Track

**Throughput:**
- Pages crawled per second
- URLs added to queue per second
- Queue size over time

**Latency:**
- Time to fetch a page (p50, p95, p99)
- Time in queue before crawling

**Errors:**
- HTTP errors (4xx, 5xx) rate
- Timeout rate
- Robots.txt fetch failures

**Resource Utilization:**
- Redis memory usage
- PostgreSQL disk usage
- Worker CPU/memory usage

### Logging Strategy

```typescript
// Structured logging with Winston
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'crawler.log' }),
    new winston.transports.Console()
  ]
});

// Log crawl events
logger.info('url_crawled', {
  url,
  workerId,
  duration: 123,
  linksFound: 45,
  statusCode: 200
});

// Log errors
logger.error('crawl_failed', {
  url,
  workerId,
  error: error.message,
  retryCount: 2
});
```

## Testing Strategy

### Unit Tests
- URL normalization logic
- Robots.txt parsing
- Link extraction
- Rate limiting logic

### Integration Tests
- Worker can fetch and parse real web pages
- Redis queue operations work correctly
- PostgreSQL storage works correctly

### End-to-End Tests
```typescript
// Test: Crawl a small site (10 pages) and verify all pages found
test('crawl small site completely', async () => {
  // Setup: Create test site with known structure
  const seedUrl = 'http://test-site.local/index.html';

  // Submit crawl job
  const job = await submitCrawlJob({ seedUrls: [seedUrl], maxPages: 20 });

  // Wait for completion
  await waitForJobCompletion(job.id, 60000);

  // Verify all pages crawled
  const pages = await getCrawledPages(job.id);
  expect(pages.length).toBe(10);
  expect(pages.map(p => p.url)).toContain('http://test-site.local/about.html');
});
```

### Load Testing
```bash
# Simulate 10k URLs in queue
for i in {1..10000}; do
  redis-cli ZADD urls:pending $i "https://example.com/page$i"
done

# Measure throughput with 5 workers
# Expected: ~50-100 pages/sec (depending on network and site speed)
```

## Local Development Setup

### Docker Compose
```yaml
version: '3.8'
services:
  redis:
    image: redis:7
    ports:
      - "6379:6379"

  postgres:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: password
      POSTGRES_DB: crawler
    ports:
      - "5432:5432"

  elasticsearch:
    image: elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    ports:
      - "9200:9200"
```

### Running the System
```bash
# 1. Start infrastructure
docker-compose up -d

# 2. Run database migrations
npm run migrate

# 3. Start API server
npm run api

# 4. Start 3 crawler workers (in separate terminals)
npm run worker1
npm run worker2
npm run worker3

# 5. Submit a crawl job
curl -X POST http://localhost:3000/api/crawl/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "seedUrls": ["https://example.com"],
    "maxDepth": 2,
    "maxPages": 100
  }'

# 6. Monitor progress
curl http://localhost:3000/api/crawl/jobs/{jobId}
```

## Learning Outcomes

By implementing this web crawler, you will learn:

1. **Distributed Systems Concepts**
   - Horizontal scaling (multiple workers)
   - Shared state (Redis as coordination layer)
   - Fault tolerance (handling worker failures)
   - Rate limiting in distributed systems

2. **Data Structures**
   - Priority queue (URL frontier)
   - Bloom filters (duplicate detection at scale)
   - Hash maps (URL normalization, caching)

3. **Operational Concerns**
   - Politeness policies (respect for servers)
   - Monitoring and observability
   - Configuration management
   - Resource management (memory, network)

4. **Software Engineering**
   - Async/await patterns in Node.js
   - HTML parsing and link extraction
   - Error handling and retries
   - Testing distributed systems

## Next Steps / Extensions

Once the basic crawler works, explore:

1. **JavaScript Rendering**
   - Use Puppeteer/Playwright for SPAs
   - Handle dynamic content loaded via AJAX

2. **Content Extraction**
   - Extract structured data (JSON-LD, microdata)
   - Detect article content vs boilerplate
   - Extract images, videos, metadata

3. **Incremental Crawling**
   - Re-crawl pages periodically (freshness)
   - Detect page changes (diff previous version)
   - Prioritize frequently-updated pages

4. **Focused Crawling**
   - Crawl only pages matching a topic (ML classifier)
   - Skip irrelevant pages early

5. **Large-Scale Optimizations**
   - URL frontier partitioning (consistent hashing)
   - Distributed storage (S3, HDFS)
   - Crawl budget optimization

## References

- [Mercator: A Scalable, Extensible Web Crawler](https://www.semanticscholar.org/paper/Mercator%3A-A-scalable%2C-extensible-Web-crawler-Heydon-Najork/5c5f1f4f1f5f0c8e2c4a9b8a1a8b8f1f5f0c8e2c)
- [The Anatomy of a Large-Scale Hypertextual Web Search Engine (Google)](http://infolab.stanford.edu/~backrub/google.html)
- [Web Crawling (Stanford CS276)](https://web.stanford.edu/class/cs276/handouts/lecture15-crawling.pdf)
- [Robots.txt Specification](https://developers.google.com/search/docs/crawling-indexing/robots/intro)
- [URL Normalization (RFC 3986)](https://www.rfc-editor.org/rfc/rfc3986)
