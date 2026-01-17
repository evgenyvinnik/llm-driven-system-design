# Design Spotlight - Architecture

## System Overview

Spotlight is a universal search system with on-device indexing and intelligent suggestions. Core challenges involve real-time indexing, content extraction, and privacy-preserving search.

**Learning Goals:**
- Build incremental indexing systems
- Design multi-source search ranking
- Implement content extraction pipelines
- Handle on-device ML for suggestions

---

## Requirements

### Functional Requirements

1. **Search**: Find files, apps, contacts, messages
2. **Index**: Real-time content indexing
3. **Suggest**: Proactive app and content suggestions
4. **Calculate**: Math, conversions, definitions
5. **Web**: Fall back to web search

### Non-Functional Requirements

- **Latency**: < 100ms for local results
- **Privacy**: All indexing on-device
- **Efficiency**: < 5% CPU during indexing
- **Storage**: Minimal index size

---

## High-Level Architecture

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

---

## Core Components

### 1. Indexing Service

**Real-Time File Indexing:**
```javascript
class IndexingService {
  constructor() {
    this.index = new SearchIndex()
    this.contentExtractors = new Map()
    this.pendingQueue = []
    this.isIndexing = false
  }

  async initialize() {
    // Register content extractors
    this.registerExtractor('pdf', new PDFExtractor())
    this.registerExtractor('docx', new WordExtractor())
    this.registerExtractor('txt', new TextExtractor())
    this.registerExtractor('html', new HTMLExtractor())
    this.registerExtractor('image', new ImageMetadataExtractor())

    // Watch file system for changes
    this.fileWatcher = new FileWatcher({
      paths: ['/Users', '/Applications'],
      ignorePaths: ['Library/Caches', 'node_modules', '.git']
    })

    this.fileWatcher.on('created', (path) => this.queueForIndexing(path, 'add'))
    this.fileWatcher.on('modified', (path) => this.queueForIndexing(path, 'update'))
    this.fileWatcher.on('deleted', (path) => this.removeFromIndex(path))

    // Start background processing
    this.startBackgroundIndexing()
  }

  async queueForIndexing(path, action) {
    this.pendingQueue.push({ path, action, queuedAt: Date.now() })

    // Process immediately if not busy
    if (!this.isIndexing) {
      this.processQueue()
    }
  }

  async processQueue() {
    this.isIndexing = true

    while (this.pendingQueue.length > 0) {
      // Check system load before processing
      if (await this.isSystemBusy()) {
        await this.sleep(5000) // Wait 5 seconds
        continue
      }

      const item = this.pendingQueue.shift()
      await this.indexFile(item.path)

      // Yield to other processes
      await this.sleep(10)
    }

    this.isIndexing = false
  }

  async indexFile(path) {
    const stats = await fs.stat(path)

    // Skip large files
    if (stats.size > 50 * 1024 * 1024) return // > 50MB

    // Get file extension
    const ext = this.getExtension(path)
    const extractor = this.contentExtractors.get(ext) || this.contentExtractors.get('txt')

    try {
      // Extract content
      const content = await extractor.extract(path)

      // Tokenize
      const tokens = this.tokenize(content.text)

      // Create index entry
      const entry = {
        path,
        name: content.name || path.split('/').pop(),
        type: content.type || 'file',
        content: tokens,
        metadata: content.metadata || {},
        modifiedAt: stats.mtime,
        size: stats.size
      }

      // Add to index
      await this.index.upsert(path, entry)

    } catch (error) {
      console.error(`Failed to index ${path}:`, error)
    }
  }

  tokenize(text) {
    if (!text) return []

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1)
      .slice(0, 10000) // Limit tokens per file
  }
}
```

### 2. Search Index

**Inverted Index with Prefix Support:**
```javascript
class SearchIndex {
  constructor() {
    this.invertedIndex = new Map() // term -> Set<docId>
    this.documents = new Map() // docId -> document
    this.prefixIndex = new Trie() // For prefix matching
  }

  async upsert(docId, document) {
    // Remove old entry if exists
    await this.remove(docId)

    // Store document
    this.documents.set(docId, document)

    // Index each token
    for (const token of document.content) {
      // Full term index
      if (!this.invertedIndex.has(token)) {
        this.invertedIndex.set(token, new Set())
      }
      this.invertedIndex.get(token).add(docId)

      // Prefix index (for typeahead)
      this.prefixIndex.insert(token, docId)
    }

    // Index name specially (higher weight)
    const nameTokens = document.name.toLowerCase().split(/[\s._-]+/)
    for (const token of nameTokens) {
      this.prefixIndex.insert(token, docId)
    }
  }

  async remove(docId) {
    const doc = this.documents.get(docId)
    if (!doc) return

    // Remove from inverted index
    for (const token of doc.content) {
      const docSet = this.invertedIndex.get(token)
      if (docSet) {
        docSet.delete(docId)
        if (docSet.size === 0) {
          this.invertedIndex.delete(token)
        }
      }
    }

    // Remove from prefix index
    this.prefixIndex.removeDoc(docId)

    // Remove document
    this.documents.delete(docId)
  }

  async search(query, options = {}) {
    const { limit = 20, types = null } = options
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0)

    if (tokens.length === 0) return []

    // Get matching docs for each token
    const matchingSets = tokens.map(token => {
      // Check for prefix match (last token)
      if (token === tokens[tokens.length - 1] && token.length < 4) {
        return this.prefixIndex.getDocsWithPrefix(token)
      }
      return this.invertedIndex.get(token) || new Set()
    })

    // Intersect for AND semantics
    let resultSet = matchingSets[0]
    for (let i = 1; i < matchingSets.length; i++) {
      resultSet = new Set([...resultSet].filter(x => matchingSets[i].has(x)))
    }

    // Get documents and score
    const results = []
    for (const docId of resultSet) {
      const doc = this.documents.get(docId)
      if (!doc) continue

      // Filter by type if specified
      if (types && !types.includes(doc.type)) continue

      const score = this.calculateScore(doc, tokens)
      results.push({ ...doc, score })
    }

    // Sort by score
    results.sort((a, b) => b.score - a.score)

    return results.slice(0, limit)
  }

  calculateScore(doc, queryTokens) {
    let score = 0

    // Name match is most important
    const nameLower = doc.name.toLowerCase()
    for (const token of queryTokens) {
      if (nameLower.includes(token)) {
        score += 10
        if (nameLower.startsWith(token)) {
          score += 5 // Prefix match bonus
        }
      }
    }

    // Recency boost
    const daysSinceModified = (Date.now() - doc.modifiedAt) / (24 * 60 * 60 * 1000)
    score += Math.max(0, 5 - daysSinceModified * 0.1)

    // Type boost (apps and contacts higher than random files)
    const typeBoost = {
      'application': 3,
      'contact': 2,
      'message': 2,
      'file': 1
    }
    score += typeBoost[doc.type] || 1

    return score
  }
}
```

### 3. Query Router

**Multi-Source Query Processing:**
```javascript
class QueryEngine {
  constructor() {
    this.localIndex = new SearchIndex()
    this.providers = new Map()
    this.specialHandlers = new Map()
  }

  async query(queryString, options = {}) {
    const parsedQuery = this.parseQuery(queryString)

    // Check for special queries first
    const specialResult = await this.handleSpecialQuery(parsedQuery)
    if (specialResult) {
      return specialResult
    }

    // Query all sources in parallel
    const [localResults, providerResults, cloudResults] = await Promise.all([
      this.localIndex.search(queryString, options),
      this.queryProviders(queryString),
      this.queryCloud(queryString)
    ])

    // Merge and rank
    const merged = this.mergeResults([
      ...localResults,
      ...providerResults,
      ...cloudResults
    ])

    // Add web search fallback
    if (merged.length < 3) {
      merged.push({
        type: 'web_search',
        name: `Search the web for "${queryString}"`,
        action: { type: 'open_url', url: `https://www.google.com/search?q=${encodeURIComponent(queryString)}` }
      })
    }

    return merged
  }

  parseQuery(queryString) {
    // Detect query type
    const query = {
      raw: queryString,
      tokens: queryString.toLowerCase().split(/\s+/),
      type: 'search'
    }

    // Math expression
    if (/^[\d\s+\-*/().%^]+$/.test(queryString)) {
      query.type = 'math'
      query.expression = queryString
    }

    // Unit conversion
    const conversionMatch = queryString.match(/^([\d.]+)\s*(\w+)\s+(?:to|in)\s+(\w+)$/i)
    if (conversionMatch) {
      query.type = 'conversion'
      query.value = parseFloat(conversionMatch[1])
      query.fromUnit = conversionMatch[2]
      query.toUnit = conversionMatch[3]
    }

    // Date query
    if (/photos?\s+from\s+/i.test(queryString)) {
      query.type = 'date_filter'
      query.dateFilter = this.parseDateFilter(queryString)
    }

    return query
  }

  async handleSpecialQuery(query) {
    if (query.type === 'math') {
      try {
        const result = this.safeEval(query.expression)
        return [{
          type: 'calculation',
          name: `${query.expression} = ${result}`,
          score: 100
        }]
      } catch (e) {
        return null
      }
    }

    if (query.type === 'conversion') {
      const result = this.convert(query.value, query.fromUnit, query.toUnit)
      if (result) {
        return [{
          type: 'conversion',
          name: `${query.value} ${query.fromUnit} = ${result.value} ${result.unit}`,
          score: 100
        }]
      }
    }

    return null
  }

  async queryProviders(queryString) {
    const results = []

    for (const [name, provider] of this.providers) {
      try {
        const providerResults = await provider.search(queryString)
        results.push(...providerResults)
      } catch (error) {
        console.error(`Provider ${name} failed:`, error)
      }
    }

    return results
  }

  mergeResults(results) {
    // Deduplicate by path/id
    const seen = new Set()
    const unique = []

    for (const result of results) {
      const key = result.path || result.id || result.name
      if (!seen.has(key)) {
        seen.add(key)
        unique.push(result)
      }
    }

    // Sort by score
    unique.sort((a, b) => (b.score || 0) - (a.score || 0))

    return unique
  }
}
```

### 4. Siri Suggestions

**Proactive Intelligence:**
```javascript
class SiriSuggestions {
  constructor() {
    this.usagePatterns = new Map()
    this.timeOfDayPatterns = new Map()
  }

  async getSuggestions(context) {
    const { timeOfDay, location, recentActivity } = context
    const suggestions = []

    // Time-based app suggestions
    const timeApps = await this.getTimeBasedApps(timeOfDay)
    suggestions.push(...timeApps.map(app => ({
      type: 'app_suggestion',
      name: app.name,
      reason: 'Based on your routine',
      score: app.score
    })))

    // Location-based suggestions
    if (location) {
      const locationSuggestions = await this.getLocationSuggestions(location)
      suggestions.push(...locationSuggestions)
    }

    // Recent contacts (likely to contact)
    const frequentContacts = await this.getFrequentContacts()
    suggestions.push(...frequentContacts.slice(0, 4).map(contact => ({
      type: 'contact_suggestion',
      name: contact.name,
      reason: 'Frequently contacted',
      score: contact.score
    })))

    // Continue reading/watching
    const continueItems = await this.getContinueItems(recentActivity)
    suggestions.push(...continueItems)

    // Sort and return top suggestions
    suggestions.sort((a, b) => b.score - a.score)
    return suggestions.slice(0, 8)
  }

  async getTimeBasedApps(timeOfDay) {
    const hour = new Date().getHours()
    const dayOfWeek = new Date().getDay()

    // Get app usage patterns for this time
    const patterns = await this.getUsagePatterns()

    // Score apps based on historical usage at this time
    const scored = patterns.map(pattern => {
      const hourlyUsage = pattern.hourlyUsage[hour] || 0
      const dayUsage = pattern.dailyUsage[dayOfWeek] || 0

      return {
        name: pattern.appName,
        bundleId: pattern.bundleId,
        score: hourlyUsage * 0.6 + dayUsage * 0.4
      }
    })

    return scored.filter(s => s.score > 0.1).slice(0, 4)
  }

  async recordAppLaunch(bundleId, context) {
    const hour = new Date().getHours()
    const dayOfWeek = new Date().getDay()

    // Update usage patterns
    await db.query(`
      INSERT INTO app_usage_patterns
        (bundle_id, hour, day_of_week, count, last_used)
      VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (bundle_id, hour, day_of_week)
      DO UPDATE SET count = app_usage_patterns.count + 1, last_used = NOW()
    `, [bundleId, hour, dayOfWeek])
  }
}
```

---

## Database Schema

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
```

---

## Key Design Decisions

### 1. On-Device Indexing

**Decision**: All indexing and search happens locally

**Rationale**:
- Privacy protection (no search logs sent)
- Works offline
- Low latency

### 2. Incremental Indexing

**Decision**: Watch for file changes, index incrementally

**Rationale**:
- No need for full re-index
- Lower resource usage
- Real-time updates

### 3. Multi-Source Fusion

**Decision**: Query multiple sources and merge results

**Rationale**:
- Unified search experience
- Apps provide their own data
- Consistent ranking

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Indexing | On-device | Cloud | Privacy |
| Storage | SQLite FTS | Custom | Simplicity, proven |
| Ranking | Multi-signal | Pure text match | Relevance |
| Updates | Incremental | Full re-index | Performance |

---

## Authentication and Authorization

### Authentication Strategy

For this local learning project, we use session-based authentication with Valkey/Redis for session storage.

**Session-Based Auth Flow:**
```javascript
// Session configuration
const sessionConfig = {
  store: new RedisStore({ client: valkeyClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'strict'
  }
}

// Login endpoint
app.post('/api/v1/auth/login', async (req, res) => {
  const { username, password } = req.body

  const user = await db.query(
    'SELECT id, username, password_hash, role FROM users WHERE username = $1',
    [username]
  )

  if (!user || !await bcrypt.compare(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }

  req.session.userId = user.id
  req.session.role = user.role
  req.session.createdAt = Date.now()

  res.json({ user: { id: user.id, username: user.username, role: user.role } })
})
```

**Session Schema (Valkey):**
```
# Session key structure
sess:{session_id}
  userId: string
  role: "user" | "admin"
  createdAt: timestamp
  lastActivity: timestamp

# TTL: 24 hours, refreshed on activity
```

### Role-Based Access Control (RBAC)

Two roles with distinct permissions:

| Operation | User | Admin |
|-----------|------|-------|
| Search local index | Yes | Yes |
| View own usage patterns | Yes | Yes |
| Query app providers | Yes | Yes |
| Re-index own directories | Yes | Yes |
| View all users' patterns | No | Yes |
| Force full re-index | No | Yes |
| Manage content extractors | No | Yes |
| View system metrics | No | Yes |
| Modify rate limits | No | Yes |

**RBAC Middleware:**
```javascript
// Authentication middleware
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  next()
}

// Admin-only middleware
function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' })
  }
  next()
}

// Route definitions
app.get('/api/v1/search', requireAuth, searchHandler)
app.get('/api/v1/suggestions', requireAuth, suggestionsHandler)
app.post('/api/v1/admin/reindex', requireAuth, requireAdmin, reindexHandler)
app.get('/api/v1/admin/metrics', requireAuth, requireAdmin, metricsHandler)
```

### Rate Limiting

Token bucket algorithm implemented in Valkey for local development:

**Rate Limit Configuration:**
```javascript
const rateLimits = {
  // Per-user limits
  user: {
    search: { tokens: 100, refillRate: 10, refillInterval: 1000 }, // 100 req/10s burst, 10/sec sustained
    suggestions: { tokens: 30, refillRate: 5, refillInterval: 1000 },
    reindex: { tokens: 5, refillRate: 1, refillInterval: 60000 } // 5 burst, 1/min sustained
  },
  // Global limits (all users combined)
  global: {
    search: { tokens: 500, refillRate: 50, refillInterval: 1000 },
    cloudQuery: { tokens: 20, refillRate: 2, refillInterval: 1000 }
  }
}

// Rate limit middleware
async function rateLimit(category, identifier) {
  const key = `ratelimit:${category}:${identifier}`
  const config = rateLimits.user[category]

  const tokens = await valkey.decr(key)
  if (tokens < 0) {
    await valkey.incr(key) // Restore the token
    return false // Rate limited
  }
  return true
}

// Refill tokens periodically (background job)
async function refillTokens() {
  for (const [category, config] of Object.entries(rateLimits.user)) {
    // Scan all keys matching pattern and refill
    const keys = await valkey.keys(`ratelimit:${category}:*`)
    for (const key of keys) {
      const current = await valkey.get(key)
      const newValue = Math.min(config.tokens, parseInt(current) + config.refillRate)
      await valkey.set(key, newValue, 'EX', 3600)
    }
  }
}
```

**Rate Limit Response Headers:**
```javascript
// Add to responses
res.set({
  'X-RateLimit-Limit': config.tokens,
  'X-RateLimit-Remaining': remainingTokens,
  'X-RateLimit-Reset': Math.ceil(Date.now() / 1000) + config.refillInterval / 1000
})
```

---

## Observability

### Metrics (Prometheus)

**Key Application Metrics:**
```javascript
const promClient = require('prom-client')

// Request metrics
const httpRequestDuration = new promClient.Histogram({
  name: 'spotlight_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5]
})

// Search metrics
const searchLatency = new promClient.Histogram({
  name: 'spotlight_search_latency_seconds',
  help: 'Search query latency',
  labelNames: ['source'], // 'local', 'provider', 'cloud'
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5]
})

const searchResultCount = new promClient.Histogram({
  name: 'spotlight_search_result_count',
  help: 'Number of results returned per search',
  buckets: [0, 1, 5, 10, 20, 50, 100]
})

// Indexing metrics
const indexingQueueSize = new promClient.Gauge({
  name: 'spotlight_indexing_queue_size',
  help: 'Number of files pending indexing'
})

const indexedFilesTotal = new promClient.Counter({
  name: 'spotlight_indexed_files_total',
  help: 'Total files indexed',
  labelNames: ['type', 'status'] // status: 'success', 'error', 'skipped'
})

const indexSize = new promClient.Gauge({
  name: 'spotlight_index_size_bytes',
  help: 'Size of the search index in bytes'
})

// Provider metrics
const providerLatency = new promClient.Histogram({
  name: 'spotlight_provider_latency_seconds',
  help: 'App provider query latency',
  labelNames: ['provider'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1]
})

const providerErrors = new promClient.Counter({
  name: 'spotlight_provider_errors_total',
  help: 'Provider query errors',
  labelNames: ['provider', 'error_type']
})

// Expose metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType)
  res.send(await promClient.register.metrics())
})
```

### Structured Logging

**Log Format (JSON):**
```javascript
const logger = {
  info: (message, context = {}) => log('INFO', message, context),
  warn: (message, context = {}) => log('WARN', message, context),
  error: (message, context = {}) => log('ERROR', message, context)
}

function log(level, message, context) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: 'spotlight',
    ...context
  }
  console.log(JSON.stringify(entry))
}

// Example log entries
logger.info('Search completed', {
  query: 'photos from last week',
  userId: 'u123',
  resultCount: 15,
  latencyMs: 45,
  sources: ['local', 'provider:photos']
})

logger.error('Provider timeout', {
  provider: 'contacts',
  timeoutMs: 5000,
  requestId: 'req-abc123'
})
```

**Log Categories:**
| Category | Log Level | Retention | Purpose |
|----------|-----------|-----------|---------|
| Search queries | INFO | 7 days | Performance analysis |
| Indexing events | INFO | 3 days | Debug file watching |
| Auth events | INFO | 30 days | Security audit |
| Provider errors | WARN | 14 days | Provider health |
| System errors | ERROR | 30 days | Incident response |

### Distributed Tracing

**Trace Propagation:**
```javascript
const { trace, context, SpanStatusCode } = require('@opentelemetry/api')

async function handleSearch(req, res) {
  const tracer = trace.getTracer('spotlight')

  return tracer.startActiveSpan('search', async (span) => {
    span.setAttribute('query', req.query.q)
    span.setAttribute('userId', req.session.userId)

    try {
      // Trace local index search
      const localResults = await tracer.startActiveSpan('search.local', async (localSpan) => {
        const results = await localIndex.search(req.query.q)
        localSpan.setAttribute('resultCount', results.length)
        localSpan.end()
        return results
      })

      // Trace provider queries (parallel)
      const providerResults = await tracer.startActiveSpan('search.providers', async (provSpan) => {
        const results = await queryProviders(req.query.q)
        provSpan.setAttribute('providerCount', providers.size)
        provSpan.end()
        return results
      })

      span.setStatus({ code: SpanStatusCode.OK })
      return mergeResults([...localResults, ...providerResults])
    } catch (error) {
      span.recordException(error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
      throw error
    } finally {
      span.end()
    }
  })
}
```

### SLI Dashboards and Alert Thresholds

**Service Level Indicators (SLIs):**
| SLI | Target | Measurement |
|-----|--------|-------------|
| Search latency p95 | < 100ms | `histogram_quantile(0.95, spotlight_search_latency_seconds)` |
| Search latency p99 | < 250ms | `histogram_quantile(0.99, spotlight_search_latency_seconds)` |
| Search availability | 99.5% | `1 - (rate(spotlight_http_requests_total{status=~"5.."}[5m]) / rate(spotlight_http_requests_total[5m]))` |
| Indexing queue depth | < 1000 | `spotlight_indexing_queue_size` |
| Provider success rate | > 95% | `1 - (rate(spotlight_provider_errors_total[5m]) / rate(spotlight_provider_requests_total[5m]))` |

**Alert Rules (Prometheus Alertmanager):**
```yaml
groups:
  - name: spotlight_alerts
    rules:
      - alert: HighSearchLatency
        expr: histogram_quantile(0.95, rate(spotlight_search_latency_seconds_bucket[5m])) > 0.1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Search latency p95 above 100ms"

      - alert: SearchErrorRate
        expr: rate(spotlight_http_requests_total{route="/api/v1/search",status=~"5.."}[5m]) / rate(spotlight_http_requests_total{route="/api/v1/search"}[5m]) > 0.01
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Search error rate above 1%"

      - alert: IndexingQueueBacklog
        expr: spotlight_indexing_queue_size > 5000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Indexing queue has {{ $value }} pending files"

      - alert: ProviderDown
        expr: rate(spotlight_provider_errors_total[5m]) / rate(spotlight_provider_requests_total[5m]) > 0.5
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Provider {{ $labels.provider }} failing > 50%"
```

### Audit Logging

**Security-Relevant Events:**
```javascript
async function auditLog(event) {
  await db.query(`
    INSERT INTO audit_log (timestamp, event_type, user_id, ip_address, details)
    VALUES (NOW(), $1, $2, $3, $4)
  `, [event.type, event.userId, event.ip, JSON.stringify(event.details)])
}

// Events to audit
const auditEvents = {
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILURE: 'login_failure',
  LOGOUT: 'logout',
  ADMIN_REINDEX: 'admin_reindex',
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',
  PERMISSION_DENIED: 'permission_denied',
  CONFIG_CHANGE: 'config_change'
}

// Example: audit login attempts
app.post('/api/v1/auth/login', async (req, res) => {
  const { username } = req.body
  const ip = req.ip

  try {
    const user = await authenticate(username, req.body.password)
    await auditLog({
      type: auditEvents.LOGIN_SUCCESS,
      userId: user.id,
      ip,
      details: { username }
    })
    // ... set session
  } catch (error) {
    await auditLog({
      type: auditEvents.LOGIN_FAILURE,
      userId: null,
      ip,
      details: { username, reason: error.message }
    })
    // ... return error
  }
})
```

**Audit Log Schema:**
```sql
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  ip_address INET,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_user ON audit_log(user_id);
CREATE INDEX idx_audit_type ON audit_log(event_type);

-- Retention: keep 90 days
-- Run daily: DELETE FROM audit_log WHERE timestamp < NOW() - INTERVAL '90 days';
```

---

## Failure Handling

### Retry Strategy with Idempotency Keys

**Idempotent Operations:**
```javascript
// Client generates idempotency key for operations that modify state
async function reindexDirectory(directory, idempotencyKey) {
  // Check if this request was already processed
  const existing = await valkey.get(`idempotency:${idempotencyKey}`)
  if (existing) {
    return JSON.parse(existing) // Return cached result
  }

  // Process the request
  const result = await performReindex(directory)

  // Cache the result for 24 hours
  await valkey.setex(
    `idempotency:${idempotencyKey}`,
    86400,
    JSON.stringify(result)
  )

  return result
}

// Middleware to extract idempotency key
function idempotencyMiddleware(req, res, next) {
  req.idempotencyKey = req.headers['idempotency-key'] || null
  next()
}
```

**Retry with Exponential Backoff:**
```javascript
async function withRetry(operation, options = {}) {
  const {
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    retryableErrors = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']
  } = options

  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      // Check if error is retryable
      const isRetryable = retryableErrors.includes(error.code) ||
                          error.status >= 500 ||
                          error.message.includes('timeout')

      if (!isRetryable || attempt === maxAttempts) {
        throw error
      }

      // Exponential backoff with jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100,
        maxDelayMs
      )

      logger.warn('Retrying operation', {
        attempt,
        maxAttempts,
        delayMs: delay,
        error: error.message
      })

      await sleep(delay)
    }
  }

  throw lastError
}

// Usage for provider queries
async function queryProvider(providerName, query) {
  return withRetry(
    () => providers.get(providerName).search(query, { timeout: 2000 }),
    { maxAttempts: 2, baseDelayMs: 50 }
  )
}
```

### Circuit Breakers

**Circuit Breaker Implementation:**
```javascript
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5
    this.successThreshold = options.successThreshold || 3
    this.timeout = options.timeout || 30000 // 30 seconds

    this.state = 'CLOSED' // CLOSED, OPEN, HALF_OPEN
    this.failures = 0
    this.successes = 0
    this.lastFailure = null
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      // Check if timeout has passed
      if (Date.now() - this.lastFailure > this.timeout) {
        this.state = 'HALF_OPEN'
        this.successes = 0
      } else {
        throw new Error('Circuit breaker is OPEN')
      }
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failures = 0
    if (this.state === 'HALF_OPEN') {
      this.successes++
      if (this.successes >= this.successThreshold) {
        this.state = 'CLOSED'
        logger.info('Circuit breaker closed')
      }
    }
  }

  onFailure() {
    this.failures++
    this.lastFailure = Date.now()
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      logger.warn('Circuit breaker opened', { failures: this.failures })
    }
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure
    }
  }
}

// Per-provider circuit breakers
const providerBreakers = new Map()

async function queryProviderWithBreaker(providerName, query) {
  if (!providerBreakers.has(providerName)) {
    providerBreakers.set(providerName, new CircuitBreaker({
      failureThreshold: 3,
      timeout: 60000 // 1 minute
    }))
  }

  const breaker = providerBreakers.get(providerName)

  try {
    return await breaker.execute(() =>
      providers.get(providerName).search(query, { timeout: 2000 })
    )
  } catch (error) {
    if (error.message === 'Circuit breaker is OPEN') {
      logger.info('Skipping provider due to circuit breaker', { provider: providerName })
      return [] // Return empty results, don't fail the whole search
    }
    throw error
  }
}
```

### Graceful Degradation

**Fallback Strategies:**
```javascript
async function search(query) {
  const results = []

  // Local index is always available (critical path)
  const localResults = await localIndex.search(query)
  results.push(...localResults)

  // Provider queries are best-effort
  const providerPromises = Array.from(providers.entries()).map(
    async ([name, provider]) => {
      try {
        return await queryProviderWithBreaker(name, query)
      } catch (error) {
        logger.warn('Provider failed, degrading gracefully', {
          provider: name,
          error: error.message
        })
        return [] // Empty array on failure
      }
    }
  )

  // Wait for providers with timeout
  const providerResults = await Promise.race([
    Promise.all(providerPromises),
    sleep(3000).then(() => {
      logger.warn('Provider timeout, returning partial results')
      return []
    })
  ])

  results.push(...providerResults.flat())

  return mergeResults(results)
}
```

### Backup and Restore (Local Development)

**Database Backup Strategy:**
```bash
# PostgreSQL backup (run daily via cron in development)
#!/bin/bash
BACKUP_DIR="/Users/$USER/spotlight-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Dump database
pg_dump -h localhost -U spotlight_user spotlight_db \
  --format=custom \
  --file="$BACKUP_DIR/spotlight_$TIMESTAMP.dump"

# Keep only last 7 backups
ls -t "$BACKUP_DIR"/spotlight_*.dump | tail -n +8 | xargs -r rm

echo "Backup completed: spotlight_$TIMESTAMP.dump"
```

**SQLite Index Backup:**
```javascript
// On-device index backup (before major operations)
async function backupIndex() {
  const backupPath = `${indexPath}.backup.${Date.now()}`
  await fs.copyFile(indexPath, backupPath)

  // Keep only last 3 backups
  const backups = await glob(`${indexPath}.backup.*`)
  backups.sort().reverse().slice(3).forEach(f => fs.unlink(f))

  return backupPath
}

// Restore from backup
async function restoreIndex(backupPath) {
  await fs.copyFile(backupPath, indexPath)
  await reinitializeIndex()
}
```

**Restore Testing (Manual Runbook):**
```markdown
## Restore Test Procedure (Run Monthly)

1. Stop the Spotlight service
   ```bash
   npm run stop
   ```

2. Backup current database
   ```bash
   pg_dump -Fc spotlight_db > pre_restore_backup.dump
   ```

3. Restore from backup
   ```bash
   pg_restore -d spotlight_db --clean spotlight_backup.dump
   ```

4. Verify data integrity
   ```bash
   # Check row counts
   psql -d spotlight_db -c "SELECT COUNT(*) FROM indexed_files;"
   psql -d spotlight_db -c "SELECT COUNT(*) FROM app_usage_patterns;"

   # Run health check
   npm run health-check
   ```

5. Run smoke tests
   ```bash
   npm run test:smoke
   ```

6. Document results in `restore_test_log.md`
```

### Multi-Region Considerations

For this local learning project, true multi-region DR is out of scope. However, we document the pattern for educational purposes:

**Local Simulation of Multi-Region:**
```javascript
// Simulate region failover with multiple service instances
const regions = {
  primary: { host: 'localhost', port: 3001 },
  secondary: { host: 'localhost', port: 3002 }
}

async function queryWithFailover(query) {
  try {
    return await fetch(`http://${regions.primary.host}:${regions.primary.port}/search?q=${query}`)
  } catch (error) {
    logger.warn('Primary region failed, failing over to secondary')
    return await fetch(`http://${regions.secondary.host}:${regions.secondary.port}/search?q=${query}`)
  }
}
```

**Replication Considerations (Educational):**
| Component | Strategy | RPO | RTO |
|-----------|----------|-----|-----|
| PostgreSQL | Streaming replication to standby | < 1 min | 5 min manual failover |
| SQLite index | File copy to backup location | Hourly | 15 min rebuild |
| Valkey sessions | No replication (sessions recreated on login) | N/A | Immediate |

For local development, focus on:
1. Regular backups (daily for PostgreSQL, before major changes for SQLite)
2. Tested restore procedures (monthly manual test)
3. Service health checks to detect failures quickly
