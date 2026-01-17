# Design Google Search - Architecture

## System Overview

Google Search is a web search engine with distributed crawling and ranking. Core challenges involve scale, freshness, relevance, and low-latency serving.

**Learning Goals:**
- Build web crawling infrastructure
- Design inverted index systems
- Implement PageRank algorithm
- Handle query processing at scale

---

## Requirements

### Functional Requirements

1. **Crawl**: Discover and fetch web pages
2. **Index**: Build searchable index of content
3. **Query**: Process user search queries
4. **Rank**: Order results by relevance
5. **Serve**: Return results with low latency

### Non-Functional Requirements

- **Scale**: Index 100B+ pages
- **Latency**: < 200ms for queries
- **Freshness**: Update popular pages daily
- **Relevance**: High precision and recall

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Crawl System                                │
│     URL Frontier │ Fetcher │ Parser │ Deduplication            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Indexing Pipeline                             │
│     Tokenizer │ Index Builder │ PageRank │ Sharding            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Serving System                                │
│       Query Parser │ Index Servers │ Ranking │ Cache           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   Bigtable      │   Colossus (GFS)  │      Redis                │
│   - URL DB      │   - Documents     │      - Query cache        │
│   - PageRank    │   - Index files   │      - Suggestions        │
│   - Crawl state │   - Crawl data    │      - Hot results        │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Web Crawler

**URL Frontier & Politeness:**
```javascript
class URLFrontier {
  constructor() {
    this.frontQueues = new Map() // Per-host queues
    this.backQueue = new PriorityQueue() // Priority by importance
    this.hostLastFetch = new Map() // Politeness timing
  }

  async addURL(url, priority) {
    const host = new URL(url).hostname

    // Check robots.txt
    if (!await this.isAllowed(url)) {
      return
    }

    // Check if already crawled or in queue
    if (await this.isDuplicate(url)) {
      return
    }

    // Add to host-specific queue
    if (!this.frontQueues.has(host)) {
      this.frontQueues.set(host, [])
    }
    this.frontQueues.get(host).push({ url, priority })

    // Track in back queue for scheduling
    this.backQueue.enqueue({ host, priority })
  }

  async getNextURL() {
    while (true) {
      const { host } = this.backQueue.dequeue()

      // Check politeness (1 request per host per second)
      const lastFetch = this.hostLastFetch.get(host) || 0
      const now = Date.now()

      if (now - lastFetch < 1000) {
        // Re-queue and try another host
        this.backQueue.enqueue({ host, priority: 0 })
        continue
      }

      const queue = this.frontQueues.get(host)
      if (queue && queue.length > 0) {
        const { url } = queue.shift()
        this.hostLastFetch.set(host, now)
        return url
      }
    }
  }

  async isAllowed(url) {
    const host = new URL(url).hostname
    const robots = await this.getRobotsTxt(host)
    return robots.isAllowed(url, 'Googlebot')
  }
}

class Crawler {
  async crawl(url) {
    // Fetch page
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Googlebot/2.1' },
      timeout: 10000
    })

    if (!response.ok) {
      await this.recordCrawlError(url, response.status)
      return
    }

    const html = await response.text()

    // Check for duplicate content
    const contentHash = this.hashContent(html)
    if (await this.isContentDuplicate(contentHash)) {
      return
    }

    // Parse and extract
    const parsed = this.parseHTML(html)

    // Store document
    await this.storeDocument(url, {
      content: parsed.text,
      title: parsed.title,
      links: parsed.links,
      fetchTime: Date.now()
    })

    // Add discovered links to frontier
    for (const link of parsed.links) {
      const absoluteUrl = new URL(link, url).href
      await this.frontier.addURL(absoluteUrl, this.calculatePriority(absoluteUrl))
    }
  }

  calculatePriority(url) {
    // Higher priority for:
    // - Known important domains
    // - Pages linked from many sources
    // - Fresh content (news sites)
    const host = new URL(url).hostname
    let priority = 0.5

    if (this.importantDomains.has(host)) priority += 0.3
    if (this.highInlinkCount(url)) priority += 0.2

    return priority
  }
}
```

### 2. Inverted Index

**Index Construction:**
```javascript
class IndexBuilder {
  async buildIndex(documents) {
    const invertedIndex = new Map() // term -> [{docId, positions, score}]

    for (const doc of documents) {
      const tokens = this.tokenize(doc.content)

      for (let position = 0; position < tokens.length; position++) {
        const term = this.normalize(tokens[position])

        if (!invertedIndex.has(term)) {
          invertedIndex.set(term, [])
        }

        // Find or create posting for this doc
        let posting = invertedIndex.get(term).find(p => p.docId === doc.id)
        if (!posting) {
          posting = {
            docId: doc.id,
            positions: [],
            termFreq: 0,
            fieldWeights: { title: 0, body: 0, anchor: 0 }
          }
          invertedIndex.get(term).push(posting)
        }

        posting.positions.push(position)
        posting.termFreq++
      }

      // Boost for terms in title
      const titleTokens = this.tokenize(doc.title)
      for (const term of titleTokens) {
        const normalized = this.normalize(term)
        const posting = invertedIndex.get(normalized)?.find(p => p.docId === doc.id)
        if (posting) {
          posting.fieldWeights.title++
        }
      }
    }

    // Calculate IDF and final scores
    const docCount = documents.length
    for (const [term, postings] of invertedIndex) {
      const idf = Math.log(docCount / postings.length)

      for (const posting of postings) {
        const tf = 1 + Math.log(posting.termFreq)
        posting.tfidf = tf * idf

        // Boost for field matches
        posting.score = posting.tfidf *
          (1 + posting.fieldWeights.title * 3) *
          (1 + posting.fieldWeights.anchor * 2)
      }
    }

    return invertedIndex
  }

  tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !this.stopwords.has(t))
  }

  normalize(term) {
    // Stemming (Porter stemmer)
    return this.stemmer.stem(term)
  }
}

class IndexSharder {
  async shardIndex(invertedIndex, numShards) {
    const shards = Array.from({ length: numShards }, () => new Map())

    for (const [term, postings] of invertedIndex) {
      // Hash-based sharding by term
      const shardId = this.hashTerm(term) % numShards
      shards[shardId].set(term, postings)
    }

    // Write shards to storage
    for (let i = 0; i < numShards; i++) {
      await this.writeShardToStorage(i, shards[i])
    }
  }
}
```

### 3. PageRank

**Iterative PageRank:**
```javascript
class PageRank {
  constructor(dampingFactor = 0.85, iterations = 100) {
    this.d = dampingFactor
    this.iterations = iterations
  }

  async calculate(linkGraph) {
    const pages = Object.keys(linkGraph)
    const n = pages.length

    // Initialize uniform PageRank
    let ranks = {}
    for (const page of pages) {
      ranks[page] = 1 / n
    }

    // Iterative calculation
    for (let i = 0; i < this.iterations; i++) {
      const newRanks = {}

      for (const page of pages) {
        // Sum of PageRank from linking pages
        let sum = 0

        const inlinks = this.getInlinks(linkGraph, page)
        for (const inlink of inlinks) {
          const outDegree = linkGraph[inlink]?.length || 1
          sum += ranks[inlink] / outDegree
        }

        // PageRank formula
        newRanks[page] = (1 - this.d) / n + this.d * sum
      }

      // Check convergence
      const diff = this.maxDiff(ranks, newRanks)
      ranks = newRanks

      if (diff < 0.0001) {
        console.log(`Converged after ${i + 1} iterations`)
        break
      }
    }

    return ranks
  }

  getInlinks(linkGraph, targetPage) {
    const inlinks = []
    for (const [page, outlinks] of Object.entries(linkGraph)) {
      if (outlinks.includes(targetPage)) {
        inlinks.push(page)
      }
    }
    return inlinks
  }

  maxDiff(ranks1, ranks2) {
    let max = 0
    for (const page of Object.keys(ranks1)) {
      max = Math.max(max, Math.abs(ranks1[page] - ranks2[page]))
    }
    return max
  }
}
```

### 4. Query Processing

**Query Parser & Expansion:**
```javascript
class QueryProcessor {
  async process(queryString) {
    // Parse query
    const parsed = this.parseQuery(queryString)

    // Spell correction
    const corrected = await this.spellCorrect(parsed.terms)

    // Query expansion (synonyms)
    const expanded = await this.expandQuery(corrected)

    // Execute search
    const results = await this.search(expanded)

    // Rank results
    const ranked = await this.rankResults(results, parsed)

    return {
      results: ranked,
      correctedQuery: corrected.join(' '),
      totalResults: results.length
    }
  }

  parseQuery(query) {
    const terms = []
    const phrases = []
    const excluded = []

    // Handle quoted phrases
    const phraseRegex = /"([^"]+)"/g
    let match
    while ((match = phraseRegex.exec(query)) !== null) {
      phrases.push(match[1])
    }

    // Handle exclusions (-term)
    const excludeRegex = /-(\w+)/g
    while ((match = excludeRegex.exec(query)) !== null) {
      excluded.push(match[1])
    }

    // Remaining terms
    const remaining = query
      .replace(/"[^"]+"/g, '')
      .replace(/-\w+/g, '')
      .split(/\s+/)
      .filter(t => t.length > 0)

    terms.push(...remaining)

    return { terms, phrases, excluded }
  }

  async spellCorrect(terms) {
    return Promise.all(terms.map(async term => {
      if (await this.isValidTerm(term)) {
        return term
      }

      // Find closest match using edit distance
      const candidates = await this.getCandidates(term)
      const scored = candidates.map(c => ({
        term: c,
        distance: this.editDistance(term, c),
        frequency: this.getTermFrequency(c)
      }))

      scored.sort((a, b) => {
        if (a.distance !== b.distance) return a.distance - b.distance
        return b.frequency - a.frequency
      })

      return scored[0]?.term || term
    }))
  }

  async search(query) {
    const { terms, phrases, excluded } = query

    // Get postings for each term
    const postingLists = await Promise.all(
      terms.map(term => this.getPostings(term))
    )

    // Intersect for AND semantics
    let docIds = this.intersectPostings(postingLists)

    // Filter out excluded terms
    for (const term of excluded) {
      const excludePostings = await this.getPostings(term)
      docIds = docIds.filter(id => !excludePostings.has(id))
    }

    // Filter for phrase matches
    for (const phrase of phrases) {
      docIds = await this.filterByPhrase(docIds, phrase)
    }

    return docIds
  }
}
```

### 5. Ranking System

**Multi-Signal Ranking:**
```javascript
class Ranker {
  async rankResults(docIds, query) {
    const scoredDocs = await Promise.all(
      docIds.map(async docId => {
        const doc = await this.getDocument(docId)

        // Multiple ranking signals
        const textScore = this.calculateTextScore(doc, query)
        const pageRank = await this.getPageRank(docId)
        const freshness = this.calculateFreshness(doc.lastModified)
        const clickScore = await this.getClickScore(docId, query)

        // Combine signals (learned weights)
        const finalScore =
          textScore * 0.35 +
          pageRank * 0.25 +
          freshness * 0.15 +
          clickScore * 0.25

        return {
          docId,
          url: doc.url,
          title: doc.title,
          snippet: this.generateSnippet(doc.content, query),
          score: finalScore
        }
      })
    )

    // Sort by score
    scoredDocs.sort((a, b) => b.score - a.score)

    return scoredDocs.slice(0, 10) // Top 10 results
  }

  calculateTextScore(doc, query) {
    let score = 0

    for (const term of query.terms) {
      // BM25 scoring
      const tf = this.getTermFrequency(doc, term)
      const dl = doc.length
      const avgdl = this.avgDocLength
      const k1 = 1.2
      const b = 0.75

      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl))
      const idf = this.getIDF(term)

      score += tfNorm * idf
    }

    // Boost for exact title match
    if (doc.title.toLowerCase().includes(query.terms.join(' '))) {
      score *= 1.5
    }

    return score
  }

  calculateFreshness(lastModified) {
    const ageInDays = (Date.now() - lastModified) / (1000 * 60 * 60 * 24)

    if (ageInDays < 1) return 1.0
    if (ageInDays < 7) return 0.9
    if (ageInDays < 30) return 0.7
    if (ageInDays < 365) return 0.5
    return 0.3
  }

  generateSnippet(content, query) {
    // Find best passage containing query terms
    const sentences = content.split(/[.!?]+/)
    let bestScore = 0
    let bestSentence = sentences[0]

    for (const sentence of sentences) {
      const score = query.terms.filter(t =>
        sentence.toLowerCase().includes(t.toLowerCase())
      ).length

      if (score > bestScore) {
        bestScore = score
        bestSentence = sentence
      }
    }

    // Truncate and highlight
    let snippet = bestSentence.slice(0, 200)
    for (const term of query.terms) {
      const regex = new RegExp(`(${term})`, 'gi')
      snippet = snippet.replace(regex, '<b>$1</b>')
    }

    return snippet + '...'
  }
}
```

---

## Database Schema

```sql
-- URL Database (crawl state)
CREATE TABLE urls (
  url_hash BIGINT PRIMARY KEY, -- Hash of URL
  url TEXT NOT NULL,
  last_crawl TIMESTAMP,
  last_modified TIMESTAMP,
  crawl_status VARCHAR(20),
  content_hash BIGINT,
  page_rank DECIMAL,
  inlink_count INTEGER DEFAULT 0
);

-- Documents
CREATE TABLE documents (
  id BIGINT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  content TEXT,
  fetch_time TIMESTAMP,
  content_length INTEGER,
  language VARCHAR(10)
);

-- Link Graph
CREATE TABLE links (
  source_url_hash BIGINT,
  target_url_hash BIGINT,
  anchor_text TEXT,
  PRIMARY KEY (source_url_hash, target_url_hash)
);

-- Query Logs (for learning)
CREATE TABLE query_logs (
  id BIGSERIAL PRIMARY KEY,
  query TEXT NOT NULL,
  results_clicked JSONB,
  timestamp TIMESTAMP DEFAULT NOW(),
  session_id VARCHAR(100)
);
```

---

## Key Design Decisions

### 1. Inverted Index Sharding

**Decision**: Shard by term hash, not document

**Rationale**:
- All postings for a term on one shard
- Simple query routing
- Good load balance

### 2. Two-Phase Ranking

**Decision**: Cheap first pass, expensive re-ranking

**Rationale**:
- Latency constraints
- Only compute expensive signals for top candidates
- Progressive refinement

### 3. PageRank Pre-computation

**Decision**: Batch compute PageRank offline

**Rationale**:
- Expensive to compute
- Relatively stable
- Update periodically (weekly)

---

## Consistency and Idempotency

### Consistency Model by Component

| Component | Consistency Level | Rationale |
|-----------|-------------------|-----------|
| URL Frontier | Eventual | Duplicate URLs acceptable; deduped during crawl |
| Crawl State (PostgreSQL) | Strong (per-URL) | Uses row-level locks to prevent concurrent crawls of same URL |
| Document Store | Eventual | Newer crawls overwrite older; content hash prevents duplicates |
| Inverted Index (Elasticsearch) | Eventual | Near real-time indexing with refresh interval |
| PageRank | Batch consistent | Computed atomically; swapped in during index rebuild |
| Query Cache (Redis) | Eventual | Stale reads acceptable; TTL-based invalidation |

### Idempotency Patterns

**URL Crawling**:
```javascript
// Each crawl job carries an idempotency key
const crawlJob = {
  idempotencyKey: `crawl:${urlHash}:${scheduledAt}`,
  url: 'https://example.com/page',
  attempt: 1
}

async function processCrawlJob(job) {
  // Check if already processed (Redis SET with NX)
  const acquired = await redis.set(
    job.idempotencyKey,
    'processing',
    'EX', 3600,  // 1 hour expiry
    'NX'         // Only set if not exists
  )

  if (!acquired) {
    console.log(`Job ${job.idempotencyKey} already processed, skipping`)
    return
  }

  try {
    await crawl(job.url)
    await redis.set(job.idempotencyKey, 'completed', 'EX', 86400)
  } catch (error) {
    await redis.del(job.idempotencyKey)  // Allow retry
    throw error
  }
}
```

**Document Indexing**:
```javascript
// Elasticsearch uses document ID for upsert semantics
async function indexDocument(doc) {
  const docId = hashUrl(doc.url)  // Deterministic ID from URL

  await elasticsearch.index({
    index: 'documents',
    id: docId,           // Same URL always gets same ID
    body: doc,
    refresh: false       // Batch refresh for performance
  })
}
```

**PageRank Updates**:
```javascript
// Atomic swap pattern for PageRank updates
async function updatePageRanks(newRanks) {
  const batchId = Date.now()

  // Write new ranks to staging table
  await db.query(`
    INSERT INTO pagerank_staging (url_hash, rank, batch_id)
    SELECT url_hash, rank, $1 FROM unnest($2::pagerank_row[])
  `, [batchId, newRanks])

  // Atomic swap within transaction
  await db.query(`
    BEGIN;
    DELETE FROM pagerank_active;
    INSERT INTO pagerank_active SELECT url_hash, rank FROM pagerank_staging WHERE batch_id = $1;
    DELETE FROM pagerank_staging WHERE batch_id < $1;
    COMMIT;
  `, [batchId])
}
```

### Conflict Resolution

| Scenario | Resolution Strategy |
|----------|---------------------|
| Concurrent crawls of same URL | First-writer-wins via Redis lock |
| Duplicate content from different URLs | Canonical URL detection; keep highest PageRank |
| Stale index entries | Periodic index rebuild from document store |
| Query cache vs fresh results | TTL expiry (5 min for trending, 1 hour standard) |

---

## Observability

### Metrics (Prometheus)

**Crawl System Metrics**:
```yaml
# prometheus/crawl_metrics.yml
- name: crawl_urls_fetched_total
  type: counter
  help: Total URLs fetched by crawler
  labels: [status_code, content_type]

- name: crawl_latency_seconds
  type: histogram
  help: Time to fetch and process a URL
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30]

- name: crawl_frontier_size
  type: gauge
  help: Number of URLs waiting in frontier

- name: crawl_robots_cache_hits_total
  type: counter
  help: robots.txt cache hit/miss ratio
  labels: [cache_result]

- name: crawl_errors_total
  type: counter
  help: Crawl failures by error type
  labels: [error_type]  # timeout, dns_failure, http_error, parse_error
```

**Index System Metrics**:
```yaml
- name: index_documents_total
  type: counter
  help: Documents indexed

- name: index_bulk_latency_seconds
  type: histogram
  help: Time for bulk index operations
  buckets: [0.5, 1, 2, 5, 10, 30]

- name: elasticsearch_index_size_bytes
  type: gauge
  help: Size of Elasticsearch index

- name: pagerank_computation_seconds
  type: gauge
  help: Time for last PageRank computation
```

**Query System Metrics**:
```yaml
- name: query_latency_seconds
  type: histogram
  help: End-to-end query latency
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2]

- name: query_cache_hit_ratio
  type: gauge
  help: Percentage of queries served from cache

- name: query_results_count
  type: histogram
  help: Number of results returned per query
  buckets: [0, 1, 5, 10, 50, 100, 1000]

- name: query_error_rate
  type: gauge
  help: Percentage of queries returning errors
```

### Structured Logging

```javascript
// Structured log format for all components
const logger = {
  info: (event, data) => console.log(JSON.stringify({
    level: 'info',
    timestamp: new Date().toISOString(),
    service: process.env.SERVICE_NAME,
    event,
    ...data
  })),

  error: (event, error, data) => console.log(JSON.stringify({
    level: 'error',
    timestamp: new Date().toISOString(),
    service: process.env.SERVICE_NAME,
    event,
    error: { message: error.message, stack: error.stack },
    ...data
  }))
}

// Crawl logging
logger.info('crawl_complete', {
  url: 'https://example.com',
  statusCode: 200,
  contentLength: 45000,
  parseTimeMs: 45,
  linksExtracted: 23,
  traceId: request.traceId
})

// Query logging
logger.info('query_executed', {
  query: 'javascript tutorial',
  resultCount: 1500,
  latencyMs: 85,
  cacheHit: false,
  userId: 'anonymous',
  traceId: request.traceId
})
```

### Distributed Tracing

```javascript
// OpenTelemetry trace context propagation
const { trace, context, propagation } = require('@opentelemetry/api')

async function handleSearch(req, res) {
  const tracer = trace.getTracer('search-service')

  return tracer.startActiveSpan('search_query', async (span) => {
    span.setAttribute('query.text', req.query.q)
    span.setAttribute('query.page', req.query.page || 1)

    try {
      // Parse query (child span)
      const parsed = await tracer.startActiveSpan('parse_query', async (parseSpan) => {
        const result = queryProcessor.parse(req.query.q)
        parseSpan.setAttribute('query.terms_count', result.terms.length)
        parseSpan.end()
        return result
      })

      // Search index (child span)
      const results = await tracer.startActiveSpan('search_index', async (searchSpan) => {
        const result = await elasticsearch.search(parsed)
        searchSpan.setAttribute('results.count', result.hits.total)
        searchSpan.end()
        return result
      })

      // Rank results (child span)
      const ranked = await tracer.startActiveSpan('rank_results', async (rankSpan) => {
        const result = await ranker.rank(results, parsed)
        rankSpan.end()
        return result
      })

      span.setStatus({ code: 0 })
      return ranked
    } catch (error) {
      span.setStatus({ code: 2, message: error.message })
      span.recordException(error)
      throw error
    } finally {
      span.end()
    }
  })
}
```

### SLI Dashboard (Grafana)

**Key Panels for Local Development**:

```yaml
# grafana/dashboards/search-sli.json
panels:
  - title: "Query Latency (p50/p95/p99)"
    type: graph
    targets:
      - expr: histogram_quantile(0.50, rate(query_latency_seconds_bucket[5m]))
      - expr: histogram_quantile(0.95, rate(query_latency_seconds_bucket[5m]))
      - expr: histogram_quantile(0.99, rate(query_latency_seconds_bucket[5m]))
    thresholds:
      - value: 0.2
        color: green
      - value: 0.5
        color: yellow
      - value: 1.0
        color: red

  - title: "Crawl Rate (URLs/min)"
    type: stat
    targets:
      - expr: rate(crawl_urls_fetched_total[5m]) * 60

  - title: "Index Freshness (avg age)"
    type: gauge
    targets:
      - expr: avg(time() - document_last_indexed_timestamp)

  - title: "Error Rate by Component"
    type: bargauge
    targets:
      - expr: rate(crawl_errors_total[5m])
      - expr: rate(index_errors_total[5m])
      - expr: rate(query_errors_total[5m])
```

### Alert Thresholds

```yaml
# prometheus/alerts.yml
groups:
  - name: search-alerts
    rules:
      - alert: HighQueryLatency
        expr: histogram_quantile(0.95, rate(query_latency_seconds_bucket[5m])) > 0.5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Query latency p95 exceeds 500ms"

      - alert: CrawlFrontierBacklog
        expr: crawl_frontier_size > 100000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Crawl frontier has large backlog"

      - alert: ElasticsearchClusterRed
        expr: elasticsearch_cluster_health_status{color="red"} == 1
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Elasticsearch cluster is red"

      - alert: QueryCacheHitRateLow
        expr: query_cache_hit_ratio < 0.3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Query cache hit rate below 30%"

      - alert: CrawlErrorRateHigh
        expr: rate(crawl_errors_total[5m]) / rate(crawl_urls_fetched_total[5m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Crawl error rate exceeds 10%"
```

### Audit Logging

```javascript
// Audit log for admin operations and data access
const auditLogger = {
  log: async (action, details) => {
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      actor: details.actor || 'system',
      resource: details.resource,
      resourceId: details.resourceId,
      outcome: details.outcome,  // success, failure, denied
      metadata: details.metadata,
      ipAddress: details.ipAddress,
      traceId: details.traceId
    }

    // Write to dedicated audit table (immutable, append-only)
    await db.query(`
      INSERT INTO audit_log (timestamp, action, actor, resource, resource_id, outcome, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [entry.timestamp, action, entry.actor, entry.resource, entry.resourceId, entry.outcome, entry.metadata])

    // Also log to stdout for centralized collection
    console.log(JSON.stringify({ type: 'audit', ...entry }))
  }
}

// Usage examples
await auditLogger.log('index_rebuild', {
  actor: 'admin@example.com',
  resource: 'elasticsearch_index',
  resourceId: 'documents_v2',
  outcome: 'success',
  metadata: { documentCount: 150000, durationSeconds: 3600 }
})

await auditLogger.log('crawl_config_change', {
  actor: 'admin@example.com',
  resource: 'crawl_config',
  outcome: 'success',
  metadata: { field: 'politeness_delay', oldValue: 1000, newValue: 500 }
})
```

---

## Failure Handling

### Retry Strategy with Idempotency

```javascript
// Exponential backoff with jitter and idempotency
class RetryHandler {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3
    this.baseDelayMs = options.baseDelayMs || 1000
    this.maxDelayMs = options.maxDelayMs || 30000
  }

  async execute(operation, idempotencyKey) {
    let lastError

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        // Check if already completed (idempotent)
        const cached = await redis.get(`result:${idempotencyKey}`)
        if (cached) {
          return JSON.parse(cached)
        }

        const result = await operation()

        // Cache successful result
        await redis.set(
          `result:${idempotencyKey}`,
          JSON.stringify(result),
          'EX', 3600
        )

        return result
      } catch (error) {
        lastError = error

        // Don't retry non-retryable errors
        if (this.isNonRetryable(error)) {
          throw error
        }

        if (attempt < this.maxRetries) {
          const delay = this.calculateDelay(attempt)
          console.log(`Retry ${attempt}/${this.maxRetries} after ${delay}ms: ${error.message}`)
          await this.sleep(delay)
        }
      }
    }

    throw lastError
  }

  calculateDelay(attempt) {
    // Exponential backoff with jitter
    const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt - 1)
    const jitter = Math.random() * 0.3 * exponentialDelay
    return Math.min(exponentialDelay + jitter, this.maxDelayMs)
  }

  isNonRetryable(error) {
    // Don't retry client errors or validation failures
    return error.statusCode >= 400 && error.statusCode < 500
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Usage in crawler
const retryHandler = new RetryHandler({ maxRetries: 3 })

async function fetchWithRetry(url) {
  const idempotencyKey = `fetch:${hashUrl(url)}:${Date.now()}`

  return retryHandler.execute(
    () => fetch(url, { timeout: 10000 }),
    idempotencyKey
  )
}
```

### Circuit Breaker

```javascript
// Circuit breaker for external dependencies
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeoutMs = options.resetTimeoutMs || 30000
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts || 3

    this.state = 'CLOSED'  // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0
    this.lastFailureTime = null
    this.halfOpenAttempts = 0
  }

  async execute(operation, fallback = null) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN'
        this.halfOpenAttempts = 0
      } else {
        if (fallback) return fallback()
        throw new Error('Circuit breaker is OPEN')
      }
    }

    try {
      const result = await operation()

      if (this.state === 'HALF_OPEN') {
        this.halfOpenAttempts++
        if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
          this.reset()
        }
      }

      return result
    } catch (error) {
      this.recordFailure()
      throw error
    }
  }

  recordFailure() {
    this.failureCount++
    this.lastFailureTime = Date.now()

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN'
      console.log('Circuit breaker opened')
    }
  }

  reset() {
    this.state = 'CLOSED'
    this.failureCount = 0
    this.halfOpenAttempts = 0
    console.log('Circuit breaker reset to CLOSED')
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime
    }
  }
}

// Circuit breakers for each external service
const circuitBreakers = {
  elasticsearch: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 10000 }),
  postgres: new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30000 }),
  redis: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 })
}

// Usage in query handler
async function searchWithCircuitBreaker(query) {
  return circuitBreakers.elasticsearch.execute(
    () => elasticsearch.search(query),
    () => ({ hits: { total: 0, hits: [] }, fallback: true })  // Graceful degradation
  )
}
```

### Local Development DR Simulation

```yaml
# docker-compose.dr-test.yml
# Simulate failures for disaster recovery testing
version: '3.8'

services:
  elasticsearch:
    image: elasticsearch:8.11.0
    deploy:
      replicas: 2  # Run 2 nodes for failover testing

  postgres-primary:
    image: postgres:16
    environment:
      POSTGRES_DB: search_primary

  postgres-replica:
    image: postgres:16
    environment:
      POSTGRES_DB: search_replica
    depends_on:
      - postgres-primary

  # Chaos testing container
  chaos:
    image: alexei-led/pumba
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: >
      --random
      --interval 30s
      pause --duration 10s
      re2:.*elasticsearch.*
```

**DR Test Scripts**:

```bash
#!/bin/bash
# scripts/dr-test.sh - Test disaster recovery scenarios

echo "=== DR Test Suite ==="

echo "1. Testing Elasticsearch node failure..."
docker stop google-search-elasticsearch-1
sleep 5
# Verify queries still work via remaining node
curl -s "http://localhost:3000/search?q=test" | jq '.error // "OK"'
docker start google-search-elasticsearch-1

echo "2. Testing Redis failure (cache miss fallback)..."
docker stop google-search-redis-1
curl -s "http://localhost:3000/search?q=test" | jq '.cacheHit'  # Should be false
docker start google-search-redis-1

echo "3. Testing PostgreSQL failover..."
docker stop google-search-postgres-primary-1
# Verify crawler handles DB unavailability gracefully
curl -s "http://localhost:3001/health" | jq '.database'
docker start google-search-postgres-primary-1

echo "=== DR Tests Complete ==="
```

### Backup and Restore

**PostgreSQL Backup**:

```bash
#!/bin/bash
# scripts/backup-postgres.sh

BACKUP_DIR="./backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/search_${TIMESTAMP}.sql.gz"

mkdir -p $BACKUP_DIR

# Create compressed backup
docker exec google-search-postgres-1 \
  pg_dump -U postgres search_db | gzip > $BACKUP_FILE

echo "Backup created: $BACKUP_FILE"

# Keep only last 7 daily backups (for local dev)
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete
```

**Elasticsearch Snapshot**:

```bash
#!/bin/bash
# scripts/backup-elasticsearch.sh

BACKUP_DIR="./backups/elasticsearch"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Register snapshot repository (first time only)
curl -X PUT "localhost:9200/_snapshot/local_backup" -H 'Content-Type: application/json' -d'
{
  "type": "fs",
  "settings": {
    "location": "/usr/share/elasticsearch/backup"
  }
}'

# Create snapshot
curl -X PUT "localhost:9200/_snapshot/local_backup/snapshot_${TIMESTAMP}?wait_for_completion=true"

echo "Elasticsearch snapshot created: snapshot_${TIMESTAMP}"

# List snapshots
curl -s "localhost:9200/_snapshot/local_backup/_all" | jq '.snapshots | length'
```

**Restore Procedures**:

```bash
#!/bin/bash
# scripts/restore-postgres.sh

BACKUP_FILE=$1
if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./restore-postgres.sh <backup_file.sql.gz>"
  exit 1
fi

echo "Restoring from $BACKUP_FILE..."

# Drop and recreate database
docker exec -i google-search-postgres-1 psql -U postgres -c "DROP DATABASE IF EXISTS search_db;"
docker exec -i google-search-postgres-1 psql -U postgres -c "CREATE DATABASE search_db;"

# Restore from backup
gunzip -c $BACKUP_FILE | docker exec -i google-search-postgres-1 psql -U postgres search_db

echo "Restore complete. Verify with: docker exec google-search-postgres-1 psql -U postgres -d search_db -c 'SELECT COUNT(*) FROM urls;'"
```

```bash
#!/bin/bash
# scripts/restore-elasticsearch.sh

SNAPSHOT_NAME=$1
if [ -z "$SNAPSHOT_NAME" ]; then
  echo "Usage: ./restore-elasticsearch.sh <snapshot_name>"
  echo "Available snapshots:"
  curl -s "localhost:9200/_snapshot/local_backup/_all" | jq '.snapshots[].snapshot'
  exit 1
fi

echo "Restoring from snapshot $SNAPSHOT_NAME..."

# Close indices before restore
curl -X POST "localhost:9200/documents/_close"

# Restore snapshot
curl -X POST "localhost:9200/_snapshot/local_backup/${SNAPSHOT_NAME}/_restore?wait_for_completion=true"

# Reopen indices
curl -X POST "localhost:9200/documents/_open"

echo "Restore complete."
```

**Backup Testing Schedule**:

```yaml
# For local dev: Run backup tests weekly
backup_test_checklist:
  - Create fresh backup of PostgreSQL and Elasticsearch
  - Spin up separate Docker containers for restore testing
  - Restore backups to test containers
  - Run validation queries:
      - SELECT COUNT(*) FROM urls
      - SELECT COUNT(*) FROM documents
      - curl localhost:9201/_cat/indices
  - Verify crawl state can resume from restored data
  - Document any issues in project claude.md
```

---

## Implementation Notes

This section documents the rationale behind key observability, resilience, and performance features implemented in the backend.

### Why Result Caching Reduces Index Load for Popular Queries

Search queries follow a power-law distribution: a small percentage of queries account for a large percentage of total search volume. By caching search results in Redis:

1. **Popular queries hit cache**: The top 20% of queries (by frequency) often account for 80% of search traffic. These queries are served from Redis (sub-millisecond) instead of hitting Elasticsearch.

2. **Elasticsearch load reduction**: Each cached query avoids:
   - Network round-trip to Elasticsearch cluster
   - Query parsing and analysis
   - Index segment reads and scoring
   - Result aggregation and highlighting

3. **Cost efficiency**: Elasticsearch cluster sizing can be based on unique query volume rather than total query volume. A 70% cache hit rate effectively reduces required ES capacity by 70%.

4. **Freshness trade-off**: Cached results may be up to 5 minutes stale (configurable via `SEARCH_CACHE_TTL`). For most searches, slightly stale results are acceptable. Time-sensitive queries can bypass cache.

**Implementation**: See `src/shared/rateLimiter.js` for Redis-backed caching and `src/services/search.js` for cache-aside pattern.

### Why Rate Limiting Prevents Resource Exhaustion

Rate limiting protects the search infrastructure from both malicious attacks and accidental overload:

1. **Elasticsearch protection**: ES queries are expensive operations:
   - Each query consumes CPU for scoring
   - Memory for loading segments and building results
   - Network bandwidth for cluster coordination
   - Too many concurrent queries can cause GC pressure and cluster instability

2. **Fair resource allocation**: Without rate limits, a single misbehaving client could:
   - Exhaust connection pools
   - Queue up requests causing latency spikes for all users
   - Trigger circuit breakers affecting legitimate traffic

3. **Defense in depth**: Multiple rate limit layers:
   - Per-endpoint limits (search: 60/min, autocomplete: 120/min)
   - Per-IP global limit (200/min total)
   - Admin endpoints more restrictive (10/min)

4. **Graceful degradation**: Rate-limited requests get 429 responses with `Retry-After` headers, allowing clients to back off gracefully.

**Implementation**: See `src/shared/rateLimiter.js` using Redis for distributed rate limiting across multiple backend instances.

### Why Circuit Breakers Protect Index Availability

Circuit breakers prevent cascading failures when Elasticsearch or other dependencies are struggling:

1. **Fail-fast pattern**: When ES is overloaded:
   - Without circuit breaker: Requests queue up, timeout, retry, making overload worse
   - With circuit breaker: After N failures, immediately reject new requests, letting ES recover

2. **States explained**:
   - **CLOSED** (normal): All requests pass through
   - **OPEN** (failing): Requests fail immediately without hitting ES
   - **HALF-OPEN** (testing): Allow limited requests to test if ES has recovered

3. **Prevent cascade failures**:
   - If indexing circuit breaker trips, search can still work
   - Separate breakers for bulk indexing vs. single document operations
   - Granular failure isolation

4. **Metrics integration**: Circuit breaker state is exposed via Prometheus metrics:
   - `search_circuit_breaker_state` (0=closed, 1=half_open, 2=open)
   - `search_circuit_breaker_trips_total` (count of times breaker opened)

**Implementation**: See `src/shared/circuitBreaker.js` using opossum library, integrated into `src/services/indexer.js`.

### Why Query Metrics Enable Ranking Optimization

Prometheus metrics on queries provide signals for improving search quality:

1. **Latency analysis**:
   - `search_query_latency_seconds` histogram with cache hit/miss labels
   - Identify slow queries for index optimization
   - Track p50/p95/p99 for SLO monitoring

2. **Zero-result queries**:
   - `search_query_results_count` histogram
   - High zero-result rate indicates index gaps or query parsing issues
   - Can drive crawl prioritization for missing content

3. **Cache effectiveness**:
   - `search_cache_hit_ratio` gauge
   - Low hit rate may indicate TTL too short or query diversity too high
   - High hit rate validates caching strategy

4. **Query patterns**:
   - Audit logs capture query text and result counts
   - Enable analysis of popular queries for pre-warming cache
   - Identify queries where ranking could be improved

5. **Ranking feedback loop**:
   - Track which queries return few results
   - Correlate with user behavior (if click tracking added)
   - Inform BM25 parameter tuning and boost factor adjustments

**Implementation**: See `src/shared/metrics.js` for Prometheus metrics and `src/routes/search.js` for metric collection.

### Endpoint Summary

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Comprehensive health check with dependency status |
| `GET /healthz` | Kubernetes liveness probe |
| `GET /ready` | Kubernetes readiness probe |
| `GET /metrics` | Prometheus metrics scraping endpoint |

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Index sharding | By term | By document | Query efficiency |
| Ranking | Multi-phase | Single phase | Latency |
| Freshness | Crawl priority | Real-time | Cost, scale |
| PageRank | Batch | Incremental | Simplicity |
| Consistency | Eventual (reads) | Strong | Performance; stale acceptable |
| Idempotency | Redis locks + content hash | DB transactions | Speed; acceptable for crawl dedup |
| Circuit breakers | Per-service | Global | Granular failure isolation |
| Backups | Daily local snapshots | Continuous replication | Simpler for learning project |
