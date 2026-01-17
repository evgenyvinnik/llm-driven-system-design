# Web Crawler System Design Interview Answer

## Opening Statement

"I'll be designing a distributed web crawler that can index billions of web pages across the internet. This is a fascinating problem because it combines distributed systems challenges with politeness constraints and duplicate detection. Let me start by clarifying the scope."

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

1. **URL Discovery**
   - Start from seed URLs and discover new links
   - Extract and normalize all links from pages
   - Handle different URL formats and protocols

2. **Page Fetching**
   - Download HTML content from web servers
   - Handle various content types (HTML, PDF, images)
   - Follow redirects appropriately

3. **Content Processing**
   - Parse HTML and extract text content
   - Store page content for indexing
   - Extract metadata (title, description, keywords)

4. **Politeness and Compliance**
   - Respect robots.txt directives
   - Rate limit requests per domain
   - Honor crawl-delay specifications

5. **Duplicate Detection**
   - Avoid re-crawling the same URL
   - Detect near-duplicate content
   - Handle URL canonicalization

### Non-Functional Requirements

- **Scale**: Crawl 1 billion pages per month (~400 pages/second)
- **Freshness**: Re-crawl important pages within 24-48 hours
- **Efficiency**: Minimize wasted bandwidth on duplicates
- **Resilience**: Continue operating despite individual failures

---

## 2. Scale Estimation (2-3 minutes)

Let me work through the numbers:

**Crawl Rate**
- Target: 1 billion pages/month
- = 33 million pages/day
- = 1.4 million pages/hour
- = ~400 pages/second

**Storage Requirements**
- Average page size: 100KB (compressed: 20KB)
- 1 billion pages x 20KB = 20 TB for content
- URL frontier: 10 billion URLs x 100 bytes = 1 TB
- Metadata: 1 billion x 500 bytes = 500 GB

**Bandwidth**
- 400 pages/sec x 100KB = 40 MB/sec = 320 Mbps outbound
- Need to distribute across many crawler instances

**Crawler Instances**
- If each crawler fetches 5 pages/second
- Need: 400 / 5 = 80 crawler instances minimum
- With redundancy: ~100-150 crawlers

---

## 3. High-Level Architecture (8-10 minutes)

```
                              ┌─────────────────────────────┐
                              │     Seed URL Injector       │
                              └──────────────┬──────────────┘
                                             │
                                             ▼
                              ┌─────────────────────────────┐
                              │       URL Frontier          │
                              │    (Priority Queues)        │
                              │                             │
                              │  - Domain-sharded queues    │
                              │  - Priority by importance   │
                              │  - Scheduling/rate limiting │
                              └──────────────┬──────────────┘
                                             │
              ┌──────────────────────────────┼──────────────────────────────┐
              │                              │                              │
              ▼                              ▼                              ▼
    ┌─────────────────┐            ┌─────────────────┐            ┌─────────────────┐
    │  Crawler Pod 1  │            │  Crawler Pod 2  │            │  Crawler Pod N  │
    │                 │            │                 │            │                 │
    │ - Fetch pages   │            │ - Fetch pages   │            │ - Fetch pages   │
    │ - Parse HTML    │            │ - Parse HTML    │            │ - Parse HTML    │
    │ - Extract links │            │ - Extract links │            │ - Extract links │
    └────────┬────────┘            └────────┬────────┘            └────────┬────────┘
             │                              │                              │
             └──────────────────────────────┼──────────────────────────────┘
                                            │
                         ┌──────────────────┴──────────────────┐
                         │                                     │
                         ▼                                     ▼
              ┌─────────────────────┐              ┌─────────────────────┐
              │   Link Extractor    │              │   Content Store     │
              │                     │              │                     │
              │ - Normalize URLs    │              │ - Store HTML        │
              │ - Filter duplicates │              │ - Store metadata    │
              │ - Add to frontier   │              │ - Feed to indexer   │
              └──────────┬──────────┘              └─────────────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  Duplicate Detector │
              │                     │
              │ - URL fingerprints  │
              │ - Content hashing   │
              │ - Bloom filters     │
              └──────────┬──────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │   robots.txt Cache  │
              │                     │
              │ - Per-domain rules  │
              │ - Crawl delays      │
              │ - Refresh hourly    │
              └─────────────────────┘
```

### Core Components

**1. URL Frontier**
- Central queue of URLs to crawl
- Sharded by domain to enable per-domain rate limiting
- Priority-based to crawl important pages first
- Distributed across multiple nodes for scale

**2. Crawler Pods**
- Stateless workers that fetch and parse pages
- Pull URLs from frontier based on domain assignment
- Respect politeness constraints per domain
- Horizontally scalable

**3. Link Extractor**
- Processes discovered links from crawled pages
- Normalizes URLs (remove fragments, canonicalize)
- Filters out already-seen URLs
- Prioritizes and adds new URLs to frontier

**4. Duplicate Detector**
- Bloom filter for fast URL existence checks
- SimHash or MinHash for content similarity
- Prevents wasted work on duplicates

**5. Content Store**
- Stores raw HTML and extracted content
- Distributed storage (S3, HDFS, or Cassandra)
- Feeds downstream indexing pipeline

---

## 4. Deep Dive: URL Frontier Design (7-8 minutes)

The URL frontier is the heart of the crawler. Let me explain its design.

### Requirements for Frontier

1. **Politeness**: Max 1 request per second per domain
2. **Priority**: Important pages crawled first
3. **Freshness**: Recently-changed pages get re-crawled
4. **Distribution**: Work spread across crawler instances

### Two-Level Queue Architecture

```
                    ┌─────────────────────────────────┐
                    │        Front Queue (Priority)    │
                    │                                  │
                    │  High Priority ──► Medium ──► Low│
                    └───────────────┬─────────────────┘
                                    │
                                    ▼
        ┌───────────────────────────────────────────────────────┐
        │                  Back Queues (Per-Domain)              │
        │                                                        │
        │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
        │  │domain1  │  │domain2  │  │domain3  │  │domain N  │  │
        │  │ queue   │  │ queue   │  │ queue   │  │ queue    │  │
        │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  │
        │       │            │            │            │        │
        │       └────────────┴─────┬──────┴────────────┘        │
        └──────────────────────────┼────────────────────────────┘
                                   │
                                   ▼
                        ┌─────────────────────┐
                        │   Domain Selector   │
                        │                     │
                        │ Round-robin with    │
                        │ rate limit checking │
                        └──────────┬──────────┘
                                   │
                                   ▼
                              To Crawlers
```

### Front Queue (Priority Assignment)

```python
def calculate_priority(url, page_metadata=None):
    score = 0

    # Domain authority (from external signals)
    domain = extract_domain(url)
    score += domain_authority.get(domain, 0) * 100

    # Page depth (shallow = higher priority)
    depth = url.count('/') - 2
    score -= depth * 10

    # Freshness need (if re-crawling)
    if page_metadata:
        age_hours = (now - page_metadata.last_crawl).hours
        change_rate = page_metadata.change_frequency
        score += age_hours * change_rate

    # URL patterns (homepage > category > article)
    if url.endswith('/'):
        score += 50
    elif '/category/' in url:
        score += 25

    return score
```

### Back Queue (Per-Domain Rate Limiting)

```python
class DomainQueue:
    def __init__(self, domain):
        self.domain = domain
        self.urls = []
        self.last_access = 0
        self.delay = 1.0  # seconds between requests

    def can_fetch(self):
        return time.time() - self.last_access >= self.delay

    def get_next(self):
        if self.can_fetch() and self.urls:
            self.last_access = time.time()
            return self.urls.pop(0)
        return None
```

### Domain Assignment to Crawlers

Use consistent hashing to assign domains to crawlers:

```python
def assign_domain_to_crawler(domain, num_crawlers):
    # Hash domain to get consistent assignment
    domain_hash = hash(domain) % num_crawlers
    return domain_hash

# Each crawler only requests URLs from its assigned domains
# This prevents multiple crawlers hitting same domain
```

---

## 5. Deep Dive: Politeness and robots.txt (5-6 minutes)

### robots.txt Handling

```python
class RobotsCache:
    def __init__(self):
        self.cache = {}  # domain -> (rules, expiry)
        self.default_ttl = 3600  # 1 hour

    async def can_crawl(self, url):
        domain = extract_domain(url)

        if domain not in self.cache or self.cache[domain][1] < time.time():
            await self.refresh_robots(domain)

        rules, _ = self.cache[domain]
        return rules.can_fetch('*', url)

    def get_crawl_delay(self, domain):
        if domain in self.cache:
            rules, _ = self.cache[domain]
            return rules.crawl_delay('*') or 1.0
        return 1.0  # default 1 second
```

### Rate Limiting Implementation

```python
class PolitenessEnforcer:
    def __init__(self):
        self.domain_timestamps = {}  # domain -> last request time
        self.domain_delays = {}       # domain -> required delay

    async def wait_for_domain(self, domain):
        delay = self.domain_delays.get(domain, 1.0)
        last_request = self.domain_timestamps.get(domain, 0)

        wait_time = delay - (time.time() - last_request)
        if wait_time > 0:
            await asyncio.sleep(wait_time)

        self.domain_timestamps[domain] = time.time()
```

### Distributed Rate Limiting

With multiple crawlers, we need coordinated rate limiting:

```python
# Use Redis for distributed rate limiting
async def acquire_domain_slot(domain, crawler_id):
    key = f"crawl:domain:{domain}"

    # Try to acquire a slot (atomic operation)
    result = await redis.set(
        key,
        crawler_id,
        nx=True,  # Only if not exists
        ex=2      # Expires in 2 seconds
    )

    return result is not None
```

---

## 6. Deep Dive: Duplicate Detection (5-6 minutes)

### URL-Level Deduplication

**Challenge**: With billions of URLs, we can't store all in memory

**Solution**: Bloom Filter

```python
from pybloom_live import BloomFilter

class URLDeduplicator:
    def __init__(self, capacity=10_000_000_000, error_rate=0.001):
        # 10 billion URLs with 0.1% false positive rate
        # Uses about 18 GB of memory
        self.bloom = BloomFilter(capacity, error_rate)
        self.disk_backup = RocksDB("url_seen")

    def is_seen(self, url):
        url_normalized = normalize_url(url)

        # Bloom filter says "maybe" or "definitely not"
        if url_normalized not in self.bloom:
            return False

        # Double-check with disk storage for "maybe" cases
        return self.disk_backup.exists(url_normalized)

    def mark_seen(self, url):
        url_normalized = normalize_url(url)
        self.bloom.add(url_normalized)
        self.disk_backup.put(url_normalized, True)
```

### URL Normalization

```python
def normalize_url(url):
    # Parse URL
    parsed = urlparse(url)

    # Lowercase scheme and host
    scheme = parsed.scheme.lower()
    host = parsed.netloc.lower()

    # Remove default ports
    if ':80' in host and scheme == 'http':
        host = host.replace(':80', '')
    if ':443' in host and scheme == 'https':
        host = host.replace(':443', '')

    # Remove fragment
    path = parsed.path

    # Sort query parameters
    query = sorted(parse_qsl(parsed.query))
    query_str = urlencode(query)

    # Remove trailing slash (except for root)
    if path != '/' and path.endswith('/'):
        path = path.rstrip('/')

    return f"{scheme}://{host}{path}?{query_str}" if query_str else f"{scheme}://{host}{path}"
```

### Content-Level Deduplication (Near-Duplicates)

Use SimHash to detect similar content:

```python
from simhash import Simhash

class ContentDeduplicator:
    def __init__(self):
        self.simhash_index = {}  # simhash -> [url_ids]
        self.hamming_threshold = 3  # bits difference threshold

    def compute_simhash(self, text):
        # Tokenize and compute simhash
        words = text.lower().split()
        return Simhash(words)

    def is_near_duplicate(self, text):
        new_hash = self.compute_simhash(text)

        # Check against existing hashes
        for existing_hash in self.simhash_index:
            if self.hamming_distance(new_hash, existing_hash) <= self.hamming_threshold:
                return True

        return False

    def hamming_distance(self, hash1, hash2):
        return bin(hash1.value ^ hash2.value).count('1')
```

---

## 7. Deep Dive: Crawler Worker Design (5 minutes)

### Async Crawler Implementation

```python
import aiohttp
import asyncio

class CrawlerWorker:
    def __init__(self, frontier, content_store, robots_cache):
        self.frontier = frontier
        self.content_store = content_store
        self.robots_cache = robots_cache
        self.session = None

    async def run(self):
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=30),
            headers={'User-Agent': 'MyBot/1.0'}
        )

        while True:
            url = await self.frontier.get_next_url()
            if url:
                await self.crawl_url(url)
            else:
                await asyncio.sleep(0.1)

    async def crawl_url(self, url):
        try:
            # Check robots.txt
            if not await self.robots_cache.can_crawl(url):
                return

            # Fetch page
            async with self.session.get(url) as response:
                if response.status != 200:
                    return

                content_type = response.headers.get('Content-Type', '')
                if 'text/html' not in content_type:
                    return

                html = await response.text()

            # Parse and extract
            links = self.extract_links(html, url)
            content = self.extract_content(html)

            # Store content
            await self.content_store.save(url, content)

            # Add discovered links to frontier
            for link in links:
                await self.frontier.add_url(link)

        except Exception as e:
            logging.error(f"Failed to crawl {url}: {e}")
```

### Link Extraction

```python
from bs4 import BeautifulSoup
from urllib.parse import urljoin

def extract_links(html, base_url):
    soup = BeautifulSoup(html, 'html.parser')
    links = []

    for anchor in soup.find_all('a', href=True):
        href = anchor['href']

        # Convert relative to absolute
        absolute_url = urljoin(base_url, href)

        # Filter out unwanted URLs
        if should_crawl(absolute_url):
            links.append(absolute_url)

    return links

def should_crawl(url):
    # Skip non-HTTP
    if not url.startswith(('http://', 'https://')):
        return False

    # Skip common non-content extensions
    skip_extensions = ['.jpg', '.png', '.gif', '.pdf', '.zip', '.mp4']
    if any(url.lower().endswith(ext) for ext in skip_extensions):
        return False

    return True
```

---

## 8. Data Model (3-4 minutes)

### URL Frontier (Redis + Kafka)

```python
# Redis for hot data (per-domain queues)
LPUSH domain:queue:{domain} {url_json}
BRPOP domain:queue:{domain}

# Kafka for durable queue and replay
# Topic: url-frontier
# Partitioned by domain hash
```

### Crawl Metadata (PostgreSQL)

```sql
CREATE TABLE crawled_pages (
    url_hash VARCHAR(64) PRIMARY KEY,
    url TEXT NOT NULL,
    domain VARCHAR(255) NOT NULL,
    last_crawl TIMESTAMP,
    last_modified TIMESTAMP,
    content_hash VARCHAR(64),
    status_code INTEGER,
    crawl_count INTEGER DEFAULT 0
);

CREATE INDEX idx_domain ON crawled_pages(domain);
CREATE INDEX idx_last_crawl ON crawled_pages(last_crawl);

CREATE TABLE domains (
    domain VARCHAR(255) PRIMARY KEY,
    robots_txt TEXT,
    robots_fetched_at TIMESTAMP,
    crawl_delay FLOAT DEFAULT 1.0,
    page_count INTEGER DEFAULT 0
);
```

### Content Store (Distributed Storage)

```python
# S3 or HDFS structure:
# s3://content-store/{year}/{month}/{day}/{url_hash}.html.gz

# Metadata in Cassandra:
# Table: page_content
# - url_hash (partition key)
# - crawl_time (clustering key)
# - content_compressed (blob)
# - extracted_text (text)
# - title, description, keywords (text)
```

---

## 9. Trade-offs and Alternatives (4-5 minutes)

### Frontier Implementation

| Option | Pros | Cons |
|--------|------|------|
| In-memory queues | Fastest | Limited by RAM, lost on crash |
| Redis | Fast, persistent | Memory-bound for huge scale |
| Kafka | Durable, replayable | Higher latency |
| RocksDB | Persistent, large capacity | Slower than memory |

**Decision**: Redis for hot queues (active domains), Kafka for persistence and overflow

### Duplicate Detection

| Option | Pros | Cons |
|--------|------|------|
| Bloom Filter | Memory-efficient | False positives, no deletion |
| Hash Set | Exact | Memory-intensive |
| Database | Persistent, queryable | Slower lookups |
| Cuckoo Filter | Supports deletion | Slightly more memory |

**Decision**: Bloom filter for first check, database for confirmation

### Distributed Coordination

| Option | Pros | Cons |
|--------|------|------|
| Domain partitioning | Simple, no coordination | Uneven load |
| Work stealing | Balanced load | Complex coordination |
| Central scheduler | Optimal assignment | Single point of failure |

**Decision**: Domain partitioning with consistent hashing, with rebalancing for hot domains

---

## 10. Handling Failures (3 minutes)

### Crawler Failure

- Crawler workers are stateless
- In-flight URLs returned to frontier on timeout
- Health checks restart unhealthy workers
- Kubernetes deployment ensures pod count

### Frontier Failure

- Kafka provides durability for URL queue
- Redis with replication for hot data
- Periodic checkpoint to persistent storage

### Politeness on Retry

```python
def retry_with_backoff(url, attempts):
    delay = min(300, 2 ** attempts)  # Max 5 minutes
    schedule_crawl(url, after=delay)
```

---

## 11. Monitoring (2 minutes)

Key metrics:
- **Crawl rate**: Pages per second overall and per crawler
- **Frontier size**: Total URLs pending
- **Duplicate rate**: Percentage of URLs already seen
- **Error rate**: 4xx, 5xx, timeouts by domain
- **Politeness violations**: Any robots.txt violations

Alerts:
- Crawl rate drops below threshold
- Frontier growing faster than drain rate
- Any crawler instance stuck

---

## Summary

The key insights for a distributed web crawler are:

1. **Two-level frontier**: Priority queues for importance, domain queues for politeness

2. **Politeness is non-negotiable**: Rate limiting per domain, robots.txt compliance

3. **Bloom filters for scale**: Can't store 10 billion URLs in memory as a hash set

4. **Horizontal scaling via domain partitioning**: Each crawler owns specific domains

5. **Eventual consistency**: URL deduplication can have small gaps; acceptable trade-off

The system achieves 1 billion pages/month through careful coordination of stateless crawler workers, distributed queues, and efficient duplicate detection.
