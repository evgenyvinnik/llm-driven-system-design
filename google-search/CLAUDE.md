# Design Google Search - Development with Claude

## Project Context

Building a web search engine to understand crawling, indexing, ranking, and query processing at scale.

**Key Learning Goals:**
- Build web crawling infrastructure
- Design inverted index systems
- Implement PageRank algorithm
- Handle query processing at scale

---

## Key Challenges to Explore

### 1. Crawl Efficiency

**Challenge**: Maximize coverage with limited resources

**Approaches:**
- Priority-based URL frontier
- Importance-weighted scheduling
- Incremental crawling
- Focused crawling

### 2. Index Freshness

**Problem**: Web content changes constantly

**Solutions:**
- Change detection (HTTP conditional GETs)
- Adaptive recrawl intervals
- Real-time indexing for news
- Stale content detection

### 3. Query Latency

**Challenge**: Sub-200ms response at scale

**Solutions:**
- Index replication
- Query caching
- Two-phase ranking
- Early termination

---

## Development Phases

### Phase 1: Crawling - COMPLETED
- [x] URL frontier with priority queue
- [x] Politeness policy (per-host rate limiting)
- [x] robots.txt parsing and caching
- [x] Content extraction with Cheerio

### Phase 2: Indexing - IN PROGRESS
- [x] Tokenization with stopword removal and stemming
- [x] Inverted index via Elasticsearch
- [x] TF-IDF/BM25 scoring (Elasticsearch built-in)
- [ ] Index compression (future optimization)

### Phase 3: Ranking - COMPLETED
- [x] PageRank algorithm implementation
- [x] BM25 scoring via Elasticsearch
- [x] Multi-signal ranking (text + PageRank + freshness)
- [ ] Learning to rank (future enhancement)

### Phase 4: Serving - COMPLETED
- [x] Query parsing (phrases, exclusions, site filters)
- [x] Basic spell correction framework
- [x] Result caching with Redis
- [x] Snippet generation with highlighting

---

## Implementation Notes

### Architecture Decisions

1. **Elasticsearch for Inverted Index**: Using Elasticsearch rather than building a custom inverted index. This provides production-grade full-text search with minimal overhead while still demonstrating the concepts.

2. **PostgreSQL for URL State**: Storing crawl state and link graph in PostgreSQL. This allows for efficient PageRank calculation and persistent URL frontier.

3. **Redis for Caching**: Query results and autocomplete suggestions are cached in Redis for low-latency responses.

4. **Cheerio for HTML Parsing**: Server-side HTML parsing without a full browser engine. Efficient for content extraction.

### Key Components

- `crawler.js`: URL frontier management, politeness, robots.txt compliance
- `indexer.js`: Document processing and Elasticsearch indexing
- `pagerank.js`: Iterative PageRank calculation with convergence detection
- `search.js`: Query parsing, execution, and result formatting

### Query Syntax Supported

- Basic terms: `javascript tutorial`
- Exact phrases: `"react hooks"`
- Exclusions: `python -django`
- Site filter: `site:example.com tutorial`

---

## Resources

- [Google Research Publications](https://research.google/pubs/)
- [The Anatomy of a Search Engine](http://infolab.stanford.edu/~backrub/google.html)
- [Introduction to Information Retrieval](https://nlp.stanford.edu/IR-book/)
- [Elasticsearch Documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/index.html)
