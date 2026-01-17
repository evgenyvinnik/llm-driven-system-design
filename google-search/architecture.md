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

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Index sharding | By term | By document | Query efficiency |
| Ranking | Multi-phase | Single phase | Latency |
| Freshness | Crawl priority | Real-time | Cost, scale |
| PageRank | Batch | Incremental | Simplicity |
