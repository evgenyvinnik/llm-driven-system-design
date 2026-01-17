# Spotlight - System Design Interview Answer

## Opening Statement (1 minute)

"I'll design Spotlight, Apple's universal search system that provides instant results across files, apps, contacts, messages, and the web. The core challenge is building an on-device indexing system that maintains real-time indexes while being efficient enough to run in the background without impacting battery life or user experience.

This involves three key technical challenges: designing an incremental indexing system that updates in real-time as files change, building a multi-source query engine that ranks results from heterogeneous content types, and implementing proactive suggestions based on usage patterns while preserving privacy by keeping all data on-device."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Search**: Find files, apps, contacts, messages, emails instantly
- **Index**: Real-time content indexing with incremental updates
- **Suggest**: Proactive app and content suggestions (Siri Suggestions)
- **Calculate**: Math expressions, unit conversions, definitions
- **Web Fallback**: Search the web when local results are insufficient

### Non-Functional Requirements
- **Latency**: < 100ms for local results
- **Privacy**: All indexing happens on-device (no cloud)
- **Efficiency**: < 5% CPU during background indexing
- **Storage**: Minimal index size relative to content

### Scale Estimates (Per Device)
- **Files indexed**: 1M+ (documents, photos, media)
- **Apps**: 100+ with their data
- **Contacts/Messages**: 1000s of records
- **Index size**: 100MB - 1GB depending on content

### Key Questions I'd Ask
1. What content types are highest priority for indexing?
2. How fresh should the index be after file changes?
3. Should we index file contents or just metadata?

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

### Core Components

1. **Query Engine**: Parses queries, routes to sources, merges and ranks results
2. **Local Index**: Inverted index with prefix support for instant search
3. **App Providers**: APIs for apps to provide searchable content
4. **Indexing Service**: Background process that watches for changes and updates index
5. **Siri Suggestions**: Usage pattern tracking for proactive recommendations

## Deep Dive: Real-Time Incremental Indexing (8 minutes)

The indexing system must be efficient enough to run continuously without impacting user experience.

### File System Watcher

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

  async processQueue() {
    this.isIndexing = true;

    while (this.pendingQueue.length > 0) {
      // Yield to user activity - only index when system is idle
      if (await this.isSystemBusy()) {
        await this.sleep(5000);
        continue;
      }

      const item = this.pendingQueue.shift();
      await this.indexFile(item.path);

      // Small delay to prevent CPU spikes
      await this.sleep(10);
    }

    this.isIndexing = false;
  }

  async indexFile(path) {
    const stats = await fs.stat(path);

    // Skip large files (index metadata only)
    if (stats.size > 50 * 1024 * 1024) return;

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
}
```

### Idle-Time Indexing

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

## Deep Dive: Inverted Index with Prefix Support (7 minutes)

The search index must support instant prefix matching for typeahead behavior.

### Index Data Structure

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
}
```

### Why Trie for Prefixes?

| Structure | Prefix Lookup | Insert | Space |
|-----------|---------------|--------|-------|
| Trie | O(prefix_len) | O(word_len) | High |
| Sorted Array | O(log n) | O(n) | Low |
| Hash Map | O(n) | O(1) | Medium |

Trie is optimal for prefix matching - the core use case for typeahead search.

## Deep Dive: Multi-Source Query Routing (5 minutes)

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

  async handleSpecialQuery(query) {
    if (query.type === 'math') {
      try {
        const result = this.safeEval(query.expression);
        return [{
          type: 'calculation',
          name: `${query.expression} = ${result}`,
          score: 100
        }];
      } catch (e) {
        return null;
      }
    }

    if (query.type === 'conversion') {
      const result = this.convert(query.value, query.fromUnit, query.toUnit);
      if (result) {
        return [{
          type: 'conversion',
          name: `${query.value} ${query.fromUnit} = ${result.value} ${result.unit}`,
          score: 100
        }];
      }
    }

    return null;
  }
}
```

### Siri Suggestions (Proactive Intelligence)

```javascript
class SiriSuggestions {
  async getSuggestions(context) {
    const { timeOfDay, location, recentActivity } = context;
    const suggestions = [];

    // Time-based app suggestions
    const timeApps = await this.getTimeBasedApps(timeOfDay);
    suggestions.push(...timeApps.map(app => ({
      type: 'app_suggestion',
      name: app.name,
      reason: 'Based on your routine',
      score: app.score
    })));

    // Frequent contacts (likely to contact at this time)
    const frequentContacts = await this.getFrequentContacts();
    suggestions.push(...frequentContacts.slice(0, 4).map(contact => ({
      type: 'contact_suggestion',
      name: contact.name,
      reason: 'Frequently contacted',
      score: contact.score
    })));

    return suggestions.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  async recordAppLaunch(bundleId, context) {
    const hour = new Date().getHours();
    const dayOfWeek = new Date().getDay();

    // Update usage patterns in local database
    await db.query(`
      INSERT INTO app_usage_patterns (bundle_id, hour, day_of_week, count, last_used)
      VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (bundle_id, hour, day_of_week)
      DO UPDATE SET count = app_usage_patterns.count + 1, last_used = NOW()
    `, [bundleId, hour, dayOfWeek]);
  }
}
```

## Trade-offs and Alternatives (5 minutes)

### 1. On-Device vs. Cloud Indexing

**Chose: On-device only**
- Pro: Complete privacy - no search data leaves device
- Pro: Works offline
- Pro: Low latency (no network)
- Con: No cross-device index sharing
- Trade-off: Privacy is worth the duplication

### 2. Storage Format

**Chose: SQLite with FTS5**
- Pro: Battle-tested, optimized for mobile
- Pro: Built-in full-text search
- Pro: ACID guarantees
- Alternative: Custom binary format (smaller, more complex)

### 3. Indexing Strategy

**Chose: Incremental with file watching**
- Pro: Real-time updates
- Pro: Lower resource usage than full re-index
- Con: File watcher complexity
- Alternative: Periodic full scan (simpler, less fresh)

### 4. Ranking Algorithm

**Chose: Multi-signal (name match, recency, type)**
- Pro: Relevance across heterogeneous content
- Con: Weights need tuning
- Alternative: Pure text match (simpler, less relevant)

### 5. Content Extraction

**Chose: Pluggable extractors per file type**
- Pro: Deep content search for supported types
- Con: Maintenance burden for extractors
- Trade-off: Extract metadata only for unsupported types

### Privacy Considerations

```javascript
// All data stays on device
// No search queries sent to cloud
// Usage patterns only used locally for suggestions
// User can clear search history/suggestions
```

### Database Schema (SQLite)

```sql
-- File Index
CREATE TABLE indexed_files (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  content_hash TEXT,
  tokens TEXT,  -- JSON array
  metadata TEXT, -- JSON
  size INTEGER,
  modified_at INTEGER,
  indexed_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_files_name ON indexed_files(name);

-- Inverted Index
CREATE TABLE inverted_index (
  term TEXT,
  doc_path TEXT,
  position INTEGER,
  PRIMARY KEY (term, doc_path, position)
);

CREATE INDEX idx_inverted_term ON inverted_index(term);

-- App Usage Patterns
CREATE TABLE app_usage_patterns (
  bundle_id TEXT,
  hour INTEGER,
  day_of_week INTEGER,
  count INTEGER DEFAULT 0,
  last_used INTEGER,
  PRIMARY KEY (bundle_id, hour, day_of_week)
);
```

## Closing Summary (1 minute)

"Spotlight's architecture is built around three key principles:

1. **Privacy-first on-device indexing** - All content extraction and indexing happens locally, with file system watching for real-time updates. We only index during idle time to avoid impacting user experience.

2. **Trie-based prefix matching** - The inverted index is augmented with a trie structure for instant typeahead results, critical for the <100ms latency requirement.

3. **Multi-source query fusion** - The query engine routes to local index, app providers, and cloud services in parallel, then merges and ranks results using multiple signals (name match, recency, type).

The main trade-off is privacy vs. features. By keeping everything on-device, we give up cross-device index sync and cloud-powered intelligence, but we gain complete user privacy. For future improvements, I'd focus on smarter content extraction using on-device ML and implementing natural language query understanding."
