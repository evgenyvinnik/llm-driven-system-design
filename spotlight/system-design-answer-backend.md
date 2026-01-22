# Spotlight - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

## Opening Statement (1 minute)

"I'll design Spotlight, Apple's universal search system that provides instant results across files, apps, contacts, messages, and the web. From a backend perspective, the core challenge is building an on-device indexing system with real-time file watching, efficient content extraction, and a high-performance inverted index that delivers sub-100ms search latency.

The backend architecture centers on three pillars: an incremental indexing service that watches file system events and processes them during idle time, a SQLite-based inverted index with trie-augmented prefix matching for typeahead, and a multi-source query engine that routes requests to local index, app providers, and cloud services in parallel. Privacy is paramount - all data stays on-device with no search telemetry sent to servers."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Indexing**: Real-time file watching with incremental updates
- **Content Extraction**: Parse PDFs, documents, images, HTML for searchable text
- **Search API**: Query local index, app providers, and cloud in parallel
- **Special Queries**: Math expressions, unit conversions, definitions
- **Siri Suggestions**: Time/location-based proactive recommendations

### Non-Functional Requirements
- **Latency**: < 100ms for local search results
- **Efficiency**: < 5% CPU during background indexing
- **Storage**: Minimal index size (100MB - 1GB depending on content)
- **Privacy**: All indexing on-device, no cloud telemetry

### Scale Estimates (Per Device)
- **Files indexed**: 1M+ (documents, photos, media)
- **Apps**: 100+ with their searchable data
- **Tokens per file**: Up to 10,000
- **Index size**: 100MB - 1GB

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                     Spotlight UI                                │
│              (Search bar, Results list, Previews)               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Query Engine                                 │
│         (Parse, Route, Rank, Merge results)                    │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│  Local Index  │    │ App Providers │    │  Cloud Search │
│               │    │               │    │               │
│ - Files       │    │ - Contacts    │    │ - iCloud      │
│ - Apps        │    │ - Calendar    │    │ - Mail        │
│ - Messages    │    │ - Notes       │    │ - Safari      │
└───────────────┘    └───────────────┘    └───────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Indexing Service                             │
│       (File watcher, Content extraction, Tokenization)         │
└─────────────────────────────────────────────────────────────────┘
```

### Core Backend Components

1. **Indexing Service**: File watcher, content extractors, tokenization pipeline
2. **Search Index**: SQLite with inverted index and trie for prefixes
3. **Query Engine**: Multi-source routing, parallel execution, result merging
4. **App Provider API**: Interface for apps to register searchable content
5. **Siri Suggestions**: Usage pattern tracking in SQLite

## Deep Dive: Indexing Service Architecture (8 minutes)

### File System Watcher

The indexing service uses FSEvents (macOS) to monitor file system changes with minimal overhead.

```javascript
class IndexingService {
  constructor() {
    this.index = new SearchIndex();
    this.contentExtractors = new Map();
    this.pendingQueue = [];
    this.isIndexing = false;
  }

  async initialize() {
    // Register content extractors per file type
    this.registerExtractor('pdf', new PDFExtractor());
    this.registerExtractor('docx', new WordExtractor());
    this.registerExtractor('txt', new TextExtractor());
    this.registerExtractor('html', new HTMLExtractor());
    this.registerExtractor('image', new ImageMetadataExtractor());

    // Watch file system for changes (FSEvents on macOS)
    this.fileWatcher = new FileWatcher({
      paths: ['/Users', '/Applications'],
      ignorePaths: ['Library/Caches', 'node_modules', '.git']
    });

    this.fileWatcher.on('created', (path) => this.queueForIndexing(path, 'add'));
    this.fileWatcher.on('modified', (path) => this.queueForIndexing(path, 'update'));
    this.fileWatcher.on('deleted', (path) => this.removeFromIndex(path));

    this.startBackgroundIndexing();
  }

  async queueForIndexing(path, action) {
    this.pendingQueue.push({ path, action, queuedAt: Date.now() });

    // Process immediately if not busy
    if (!this.isIndexing) {
      this.processQueue();
    }
  }

  async processQueue() {
    this.isIndexing = true;

    while (this.pendingQueue.length > 0) {
      // Check system load before processing
      if (await this.isSystemBusy()) {
        await this.sleep(5000); // Wait 5 seconds
        continue;
      }

      const item = this.pendingQueue.shift();
      await this.indexFile(item.path);

      // Yield to other processes
      await this.sleep(10);
    }

    this.isIndexing = false;
  }
}
```

### Idle-Time Scheduling

```javascript
async isSystemBusy() {
  const cpuUsage = await getCPUUsage();
  const userActivity = await getLastUserInput();

  // Only index when:
  // - CPU usage is below 30%
  // - User hasn't typed/clicked in 5+ seconds
  // - Battery is not critically low (or plugged in)
  return cpuUsage > 0.3 ||
         userActivity < 5000 ||
         (getBatteryLevel() < 0.2 && !isPluggedIn());
}
```

### Content Extraction Pipeline

```javascript
async indexFile(path) {
  const stats = await fs.stat(path);

  // Skip large files (index metadata only)
  if (stats.size > 50 * 1024 * 1024) return; // > 50MB

  const ext = this.getExtension(path);
  const extractor = this.contentExtractors.get(ext) ||
                    this.contentExtractors.get('txt');

  try {
    // Extract searchable content
    const content = await extractor.extract(path);

    // Tokenize for indexing
    const tokens = this.tokenize(content.text);

    // Create index entry
    const entry = {
      path,
      name: content.name || path.split('/').pop(),
      type: content.type || 'file',
      content: tokens,
      metadata: content.metadata || {},
      modifiedAt: stats.mtime,
      size: stats.size
    };

    await this.index.upsert(path, entry);
  } catch (error) {
    console.error(`Failed to index ${path}:`, error);
  }
}

tokenize(text) {
  if (!text) return [];

  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
    .slice(0, 10000); // Limit tokens per file
}
```

## Deep Dive: Inverted Index with Trie (7 minutes)

### Data Structure Design

The search index uses a hybrid approach: inverted index for exact term lookup and trie for prefix matching.

```javascript
class SearchIndex {
  constructor() {
    this.invertedIndex = new Map();   // term -> Set<docId>
    this.documents = new Map();        // docId -> document
    this.prefixIndex = new Trie();     // For prefix matching
  }

  async upsert(docId, document) {
    // Remove old entry if exists
    await this.remove(docId);

    // Store document
    this.documents.set(docId, document);

    // Index each token
    for (const token of document.content) {
      // Full term index
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set());
      }
      this.invertedIndex.get(token).add(docId);

      // Prefix index (for typeahead)
      this.prefixIndex.insert(token, docId);
    }

    // Index name specially (higher weight in ranking)
    const nameTokens = document.name.toLowerCase().split(/[\s._-]+/);
    for (const token of nameTokens) {
      this.prefixIndex.insert(token, docId);
    }
  }

  async search(query, options = {}) {
    const { limit = 20, types = null } = options;
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);

    if (tokens.length === 0) return [];

    // Get matching docs for each token
    const matchingSets = tokens.map((token, i) => {
      // Last token: prefix match (user is still typing)
      if (i === tokens.length - 1 && token.length < 4) {
        return this.prefixIndex.getDocsWithPrefix(token);
      }
      // Other tokens: exact match
      return this.invertedIndex.get(token) || new Set();
    });

    // Intersect for AND semantics
    let resultSet = matchingSets[0];
    for (let i = 1; i < matchingSets.length; i++) {
      resultSet = new Set([...resultSet].filter(x => matchingSets[i].has(x)));
    }

    // Score and rank results
    const results = [];
    for (const docId of resultSet) {
      const doc = this.documents.get(docId);
      if (!doc) continue;
      if (types && !types.includes(doc.type)) continue;

      const score = this.calculateScore(doc, tokens);
      results.push({ ...doc, score });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
```

### Ranking Algorithm

```javascript
calculateScore(doc, queryTokens) {
  let score = 0;

  // Name match is most important
  const nameLower = doc.name.toLowerCase();
  for (const token of queryTokens) {
    if (nameLower.includes(token)) {
      score += 10;
      if (nameLower.startsWith(token)) {
        score += 5; // Prefix match bonus
      }
    }
  }

  // Recency boost
  const daysSinceModified = (Date.now() - doc.modifiedAt) / (24 * 60 * 60 * 1000);
  score += Math.max(0, 5 - daysSinceModified * 0.1);

  // Type boost (apps and contacts higher than random files)
  const typeBoost = {
    'application': 3,
    'contact': 2,
    'message': 2,
    'file': 1
  };
  score += typeBoost[doc.type] || 1;

  return score;
}
```

### Why Trie for Prefixes?

| Structure | Prefix Lookup | Insert | Space |
|-----------|---------------|--------|-------|
| Trie | O(prefix_len) | O(word_len) | High |
| Sorted Array | O(log n) | O(n) | Low |
| Hash Map | O(n) | O(1) | Medium |

Trie is optimal for prefix matching - the core use case for typeahead search.

## Deep Dive: SQLite Schema and Storage (5 minutes)

### Database Schema

```sql
-- File Index (on-device SQLite)
CREATE TABLE indexed_files (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  content_hash TEXT,
  tokens TEXT, -- JSON array of tokens
  metadata TEXT, -- JSON
  size INTEGER,
  modified_at INTEGER,
  indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_files_name ON indexed_files(name);
CREATE INDEX idx_files_type ON indexed_files(type);

-- Inverted Index (on-device)
CREATE TABLE inverted_index (
  term TEXT,
  doc_path TEXT,
  position INTEGER,
  PRIMARY KEY (term, doc_path, position)
);

CREATE INDEX idx_inverted_term ON inverted_index(term);

-- App Usage Patterns (for Siri Suggestions)
CREATE TABLE app_usage_patterns (
  bundle_id TEXT,
  hour INTEGER,
  day_of_week INTEGER,
  count INTEGER DEFAULT 0,
  last_used INTEGER,
  PRIMARY KEY (bundle_id, hour, day_of_week)
);

-- Recent Activity
CREATE TABLE recent_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT, -- 'file', 'app', 'contact', 'url'
  item_id TEXT,
  item_name TEXT,
  timestamp INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_activity_time ON recent_activity(timestamp DESC);

-- Audit Log
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  event_type TEXT NOT NULL,
  user_id INTEGER,
  ip_address TEXT,
  details TEXT -- JSON
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_type ON audit_log(event_type);
```

### Why SQLite?

- **Battle-tested**: Optimized for mobile/desktop, handles concurrent access
- **FTS5 support**: Built-in full-text search extension
- **ACID guarantees**: Safe for incremental updates
- **Zero-config**: No separate server process

## Deep Dive: Query Engine and Multi-Source Routing (5 minutes)

### Query Engine

```javascript
class QueryEngine {
  constructor() {
    this.localIndex = new SearchIndex();
    this.providers = new Map();
    this.specialHandlers = new Map();
  }

  async query(queryString, options = {}) {
    const parsedQuery = this.parseQuery(queryString);

    // Check for special queries first
    const specialResult = await this.handleSpecialQuery(parsedQuery);
    if (specialResult) {
      return specialResult;
    }

    // Query all sources in parallel
    const [localResults, providerResults, cloudResults] = await Promise.all([
      this.localIndex.search(queryString, options),
      this.queryProviders(queryString),
      this.queryCloud(queryString)
    ]);

    // Merge and rank across sources
    const merged = this.mergeResults([
      ...localResults,
      ...providerResults,
      ...cloudResults
    ]);

    // Add web search fallback if few results
    if (merged.length < 3) {
      merged.push({
        type: 'web_search',
        name: `Search the web for "${queryString}"`,
        action: { type: 'open_url', url: `https://google.com/search?q=${encodeURIComponent(queryString)}` }
      });
    }

    return merged;
  }

  parseQuery(queryString) {
    const query = {
      raw: queryString,
      tokens: queryString.toLowerCase().split(/\s+/),
      type: 'search'
    };

    // Detect math expression
    if (/^[\d\s+\-*/().%^]+$/.test(queryString)) {
      query.type = 'math';
      query.expression = queryString;
    }

    // Detect unit conversion
    const conversionMatch = queryString.match(/^([\d.]+)\s*(\w+)\s+(?:to|in)\s+(\w+)$/i);
    if (conversionMatch) {
      query.type = 'conversion';
      query.value = parseFloat(conversionMatch[1]);
      query.fromUnit = conversionMatch[2];
      query.toUnit = conversionMatch[3];
    }

    return query;
  }
}
```

### Circuit Breaker for Providers

```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 3;
    this.timeout = options.timeout || 30000; // 30 seconds

    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.successes = 0;
    this.lastFailure = null;
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.timeout) {
        this.state = 'HALF_OPEN';
        this.successes = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }
}

// Per-provider circuit breakers
const providerBreakers = new Map();

async function queryProviderWithBreaker(providerName, query) {
  if (!providerBreakers.has(providerName)) {
    providerBreakers.set(providerName, new CircuitBreaker({
      failureThreshold: 3,
      timeout: 60000
    }));
  }

  const breaker = providerBreakers.get(providerName);

  try {
    return await breaker.execute(() =>
      providers.get(providerName).search(query, { timeout: 2000 })
    );
  } catch (error) {
    if (error.message === 'Circuit breaker is OPEN') {
      return []; // Return empty results, don't fail the whole search
    }
    throw error;
  }
}
```

## Deep Dive: Rate Limiting and Authentication (4 minutes)

### Token Bucket Rate Limiting

```javascript
const rateLimits = {
  user: {
    search: { tokens: 100, refillRate: 10, refillInterval: 1000 },
    suggestions: { tokens: 30, refillRate: 5, refillInterval: 1000 },
    reindex: { tokens: 5, refillRate: 1, refillInterval: 60000 }
  },
  global: {
    search: { tokens: 500, refillRate: 50, refillInterval: 1000 },
    cloudQuery: { tokens: 20, refillRate: 2, refillInterval: 1000 }
  }
};

async function rateLimit(category, identifier) {
  const key = `ratelimit:${category}:${identifier}`;
  const config = rateLimits.user[category];

  const tokens = await valkey.decr(key);
  if (tokens < 0) {
    await valkey.incr(key); // Restore the token
    return false; // Rate limited
  }
  return true;
}
```

### Session-Based Authentication

```javascript
const sessionConfig = {
  store: new RedisStore({ client: valkeyClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'strict'
  }
};

// RBAC Middleware
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
```

## Observability (3 minutes)

### Prometheus Metrics

```javascript
const promClient = require('prom-client');

// Search metrics
const searchLatency = new promClient.Histogram({
  name: 'spotlight_search_latency_seconds',
  help: 'Search query latency',
  labelNames: ['source'],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5]
});

// Indexing metrics
const indexingQueueSize = new promClient.Gauge({
  name: 'spotlight_indexing_queue_size',
  help: 'Number of files pending indexing'
});

const indexedFilesTotal = new promClient.Counter({
  name: 'spotlight_indexed_files_total',
  help: 'Total files indexed',
  labelNames: ['type', 'status']
});

// Provider metrics
const providerErrors = new promClient.Counter({
  name: 'spotlight_provider_errors_total',
  help: 'Provider query errors',
  labelNames: ['provider', 'error_type']
});
```

### Alert Rules

```yaml
groups:
  - name: spotlight_alerts
    rules:
      - alert: HighSearchLatency
        expr: histogram_quantile(0.95, rate(spotlight_search_latency_seconds_bucket[5m])) > 0.1
        for: 2m
        labels:
          severity: warning

      - alert: IndexingQueueBacklog
        expr: spotlight_indexing_queue_size > 5000
        for: 5m
        labels:
          severity: warning
```

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Storage | SQLite with FTS5 | Custom binary format | Battle-tested, built-in FTS, ACID |
| Indexing | Incremental with file watching | Periodic full scan | Real-time updates, lower resource usage |
| Prefix Match | Trie | Sorted array + binary search | O(prefix_len) lookup optimal for typeahead |
| Multi-source | Parallel query + merge | Sequential fallback | Lower latency, graceful degradation |
| Privacy | On-device only | Cloud hybrid | Complete privacy, works offline |

## Future Enhancements (Backend)

1. **Vector Embeddings**: On-device ML for semantic similarity search
2. **Content-Addressed Deduplication**: Hash-based dedup for similar files
3. **Smart Compaction**: Merge index segments during idle time
4. **Natural Language Understanding**: Parse queries like "emails from John last week"
5. **Distributed Index Sync**: Secure cross-device index sharing via iCloud Keychain

## Closing Summary

"Spotlight's backend architecture is built around three principles:

1. **Privacy-first on-device indexing**: File system watching with FSEvents, idle-time processing to minimize battery impact, and pluggable content extractors for different file types.

2. **Hybrid index structure**: Inverted index for exact term lookup combined with trie for O(prefix_len) typeahead matching, all stored in SQLite for ACID guarantees.

3. **Fault-tolerant query routing**: Parallel queries to local index, app providers, and cloud with per-provider circuit breakers and graceful degradation when sources fail.

The main trade-off is privacy vs. cross-device features. By keeping everything on-device, we sacrifice cloud-powered intelligence and index sync, but we achieve complete user privacy and offline functionality."
