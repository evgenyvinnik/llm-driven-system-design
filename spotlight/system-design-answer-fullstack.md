# Spotlight - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement (1 minute)

"I'll design Spotlight, Apple's universal search system that provides instant results across files, apps, contacts, messages, and the web. From a full-stack perspective, the core challenge is building an end-to-end system where the frontend delivers instant typeahead feedback while the backend maintains real-time indexes - all while keeping data on-device for privacy.

The architecture integrates three key flows: a search flow where keystrokes trigger debounced API calls that query multiple sources in parallel, an indexing flow where file system events propagate through content extractors to the inverted index, and a suggestions flow where usage patterns feed proactive recommendations. The full stack works together to deliver sub-100ms latency from keystroke to rendered results."

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Search**: Instant results from files, apps, contacts, messages
- **Indexing**: Real-time file watching with incremental updates
- **Special Queries**: Math expressions, unit conversions, definitions
- **Suggestions**: Proactive Siri Suggestions based on usage patterns
- **Web Fallback**: Search the web when local results are sparse

### Non-Functional Requirements
- **End-to-End Latency**: < 100ms from keystroke to rendered results
- **Privacy**: All indexing on-device, no cloud telemetry
- **Efficiency**: < 5% CPU during background indexing
- **Accessibility**: Full keyboard navigation, screen reader support

### Data Flow Overview
1. User types in search bar
2. Frontend debounces (50ms) and sends API request
3. Backend queries local index, app providers, cloud in parallel
4. Results merged, ranked, and returned
5. Frontend renders grouped results with selection state

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            FRONTEND                                     │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                  │
│  │ SearchBar   │───▶│ SearchStore │───▶│ ResultsList │                  │
│  │ (debounce)  │    │ (Zustand)   │    │ (keyboard   │                  │
│  └─────────────┘    └─────────────┘    │  navigation)│                  │
│         │                  ▲            └─────────────┘                  │
│         │                  │                                             │
│         ▼                  │                                             │
│  ┌─────────────────────────────────────┐                                │
│  │            API Client               │                                │
│  │  GET /api/v1/search?q=...           │                                │
│  │  GET /api/v1/suggestions            │                                │
│  └─────────────────────────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            BACKEND                                      │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                      Query Engine                                │   │
│  │         (Parse, Route, Rank, Merge results)                     │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│          │                     │                     │                  │
│          ▼                     ▼                     ▼                  │
│  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐          │
│  │  Local Index  │    │ App Providers │    │  Cloud Search │          │
│  │  (SQLite)     │    │               │    │               │          │
│  └───────────────┘    └───────────────┘    └───────────────┘          │
│          ▲                                                              │
│          │                                                              │
│  ┌───────────────────────────────────────────────────────────────┐     │
│  │                   Indexing Service                             │     │
│  │       (File watcher, Content extraction, Tokenization)        │     │
│  └───────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Deep Dive: End-to-End Search Flow (8 minutes)

### Frontend: Debounced Search Input

```typescript
// SearchBar.tsx
export function SearchBar() {
  const { query, setQuery, search, clearResults } = useSearchStore();

  // Debounce for API calls but update UI immediately
  const debouncedSearch = useRef(
    debounce((q: string) => search(q), 50)
  ).current;

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;

    // Update query immediately for responsive UI
    setQuery(value);

    if (value.length === 0) {
      clearResults();
      return;
    }

    // Debounce actual search
    debouncedSearch(value);
  }, [setQuery, debouncedSearch, clearResults]);

  return (
    <input
      type="text"
      value={query}
      onChange={handleChange}
      placeholder="Spotlight Search"
      aria-autocomplete="list"
      aria-controls="results-list"
    />
  );
}
```

### Zustand Store with API Integration

```typescript
// stores/searchStore.ts
import { create } from 'zustand';
import { searchAPI } from '../api/searchAPI';

interface SearchResult {
  id: string;
  type: 'application' | 'file' | 'contact' | 'calculation' | 'web_search';
  name: string;
  subtitle?: string;
  icon?: string;
  path?: string;
  score: number;
}

interface SearchState {
  query: string;
  results: SearchResult[];
  isLoading: boolean;
  selectedIndex: number;
  showPreview: boolean;

  setQuery: (query: string) => void;
  search: (query: string) => Promise<void>;
  clearResults: () => void;
  moveSelection: (direction: 'up' | 'down') => void;
  executeSelected: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: [],
  isLoading: false,
  selectedIndex: 0,
  showPreview: false,

  setQuery: (query) => set({ query }),

  search: async (query) => {
    if (query.length === 0) {
      set({ results: [], selectedIndex: 0 });
      return;
    }

    set({ isLoading: true });

    try {
      const results = await searchAPI.search(query);
      set({
        results,
        isLoading: false,
        selectedIndex: 0
      });
    } catch (error) {
      set({ isLoading: false });
    }
  },

  clearResults: () => set({
    query: '',
    results: [],
    selectedIndex: 0
  }),

  moveSelection: (direction) => {
    const { results, selectedIndex } = get();
    if (results.length === 0) return;

    const newIndex = direction === 'up'
      ? (selectedIndex <= 0 ? results.length - 1 : selectedIndex - 1)
      : (selectedIndex >= results.length - 1 ? 0 : selectedIndex + 1);

    set({ selectedIndex: newIndex });
  },

  executeSelected: () => {
    const { results, selectedIndex } = get();
    const selected = results[selectedIndex];
    if (selected) {
      searchAPI.executeAction(selected);
    }
  }
}));
```

### API Client

```typescript
// api/searchAPI.ts
const API_BASE = '/api/v1';

export const searchAPI = {
  async search(query: string): Promise<SearchResult[]> {
    const response = await fetch(
      `${API_BASE}/search?q=${encodeURIComponent(query)}`
    );

    if (!response.ok) {
      throw new Error('Search failed');
    }

    return response.json();
  },

  async getSuggestions(): Promise<Suggestion[]> {
    const response = await fetch(`${API_BASE}/suggestions`);
    return response.json();
  },

  executeAction(result: SearchResult): void {
    switch (result.type) {
      case 'application':
        window.electronAPI?.launchApp(result.id);
        break;
      case 'file':
        window.electronAPI?.openFile(result.path!);
        break;
      case 'calculation':
        navigator.clipboard.writeText(result.name.split('=')[1].trim());
        break;
      case 'web_search':
        window.open(result.path, '_blank');
        break;
    }
  }
};
```

### Backend: Query Engine

```javascript
// QueryEngine.js
class QueryEngine {
  constructor() {
    this.localIndex = new SearchIndex();
    this.providers = new Map();
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
        id: 'web-search',
        type: 'web_search',
        name: `Search the web for "${queryString}"`,
        path: `https://google.com/search?q=${encodeURIComponent(queryString)}`,
        score: 0
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
          id: 'calculation',
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
          id: 'conversion',
          type: 'calculation',
          name: `${query.value} ${query.fromUnit} = ${result.value} ${result.unit}`,
          score: 100
        }];
      }
    }

    return null;
  }
}
```

### Express API Routes

```javascript
// routes/search.js
import express from 'express';
import { queryEngine } from '../services/queryEngine.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Search endpoint
router.get('/search', requireAuth, rateLimit('search'), async (req, res) => {
  const { q: query, types } = req.query;

  if (!query || query.length === 0) {
    return res.json([]);
  }

  try {
    const results = await queryEngine.query(query, {
      types: types ? types.split(',') : null,
      userId: req.session.userId
    });

    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Suggestions endpoint
router.get('/suggestions', requireAuth, async (req, res) => {
  try {
    const suggestions = await siriSuggestions.getSuggestions({
      userId: req.session.userId,
      timeOfDay: new Date().getHours()
    });

    res.json(suggestions);
  } catch (error) {
    console.error('Suggestions error:', error);
    res.status(500).json({ error: 'Failed to get suggestions' });
  }
});

export default router;
```

## Deep Dive: Shared Types and Contracts (5 minutes)

### Shared Type Definitions

```typescript
// shared/types.ts

export type ResultType =
  | 'application'
  | 'file'
  | 'contact'
  | 'message'
  | 'calculation'
  | 'conversion'
  | 'web_search';

export interface SearchResult {
  id: string;
  type: ResultType;
  name: string;
  subtitle?: string;
  icon?: string;
  path?: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface SearchRequest {
  query: string;
  types?: ResultType[];
  limit?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  timing: {
    total: number;
    local: number;
    providers: number;
  };
}

export interface Suggestion {
  id: string;
  type: 'app' | 'contact' | 'continue';
  name: string;
  icon: string;
  reason: string;
  score: number;
}

// Usage pattern for Siri Suggestions
export interface UsagePattern {
  bundleId: string;
  hour: number;
  dayOfWeek: number;
  count: number;
  lastUsed: Date;
}
```

### API Response Envelope

```typescript
// shared/apiTypes.ts

export interface ApiResponse<T> {
  data: T;
  error?: string;
  meta?: {
    timing?: Record<string, number>;
    version?: string;
  };
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    offset: number;
    limit: number;
    total: number;
    hasMore: boolean;
  };
}
```

## Deep Dive: Indexing and Suggestions Flow (7 minutes)

### Indexing Service (Backend)

```javascript
// services/IndexingService.js
class IndexingService {
  constructor() {
    this.index = new SearchIndex();
    this.contentExtractors = new Map();
    this.pendingQueue = [];
    this.isIndexing = false;
  }

  async initialize() {
    // Register content extractors
    this.registerExtractor('pdf', new PDFExtractor());
    this.registerExtractor('docx', new WordExtractor());
    this.registerExtractor('txt', new TextExtractor());

    // Watch file system for changes
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
      // Only index when system is idle
      if (await this.isSystemBusy()) {
        await this.sleep(5000);
        continue;
      }

      const item = this.pendingQueue.shift();
      await this.indexFile(item.path);

      // Yield to other processes
      await this.sleep(10);
    }

    this.isIndexing = false;
  }

  async indexFile(path) {
    const stats = await fs.stat(path);

    // Skip large files
    if (stats.size > 50 * 1024 * 1024) return;

    const ext = this.getExtension(path);
    const extractor = this.contentExtractors.get(ext) ||
                      this.contentExtractors.get('txt');

    try {
      const content = await extractor.extract(path);
      const tokens = this.tokenize(content.text);

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

### Siri Suggestions (Backend)

```javascript
// services/SiriSuggestions.js
class SiriSuggestions {
  async getSuggestions(context) {
    const { timeOfDay, userId } = context;
    const suggestions = [];

    // Time-based app suggestions
    const timeApps = await this.getTimeBasedApps(timeOfDay);
    suggestions.push(...timeApps.map(app => ({
      id: app.bundleId,
      type: 'app',
      name: app.name,
      icon: app.icon,
      reason: 'Based on your routine',
      score: app.score
    })));

    // Frequent contacts
    const frequentContacts = await this.getFrequentContacts(userId);
    suggestions.push(...frequentContacts.slice(0, 4).map(contact => ({
      id: contact.id,
      type: 'contact',
      name: contact.name,
      icon: contact.avatar,
      reason: 'Frequently contacted',
      score: contact.score
    })));

    return suggestions.sort((a, b) => b.score - a.score).slice(0, 8);
  }

  async recordAppLaunch(bundleId, context) {
    const hour = new Date().getHours();
    const dayOfWeek = new Date().getDay();

    await db.query(`
      INSERT INTO app_usage_patterns (bundle_id, hour, day_of_week, count, last_used)
      VALUES ($1, $2, $3, 1, NOW())
      ON CONFLICT (bundle_id, hour, day_of_week)
      DO UPDATE SET count = app_usage_patterns.count + 1, last_used = NOW()
    `, [bundleId, hour, dayOfWeek]);
  }
}
```

### Frontend: Suggestions Display

```typescript
// SiriSuggestions.tsx
export function SiriSuggestions() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const { query } = useSearchStore();

  useEffect(() => {
    if (query.length === 0) {
      fetchSuggestions();
    }
  }, [query]);

  async function fetchSuggestions() {
    const data = await searchAPI.getSuggestions();
    setSuggestions(data);
  }

  if (query.length > 0) return null;

  return (
    <div className="siri-suggestions">
      <h3 className="suggestions-title">Siri Suggestions</h3>
      <div className="suggestions-grid">
        {suggestions.map((suggestion) => (
          <SuggestionCard
            key={suggestion.id}
            suggestion={suggestion}
            onClick={() => searchAPI.executeAction(suggestion)}
          />
        ))}
      </div>
    </div>
  );
}
```

## Deep Dive: Database Schema (5 minutes)

### SQLite Schema

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

-- Inverted Index
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

-- Users (for auth)
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Audit Log
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  event_type TEXT NOT NULL,
  user_id INTEGER,
  ip_address TEXT,
  details TEXT
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
```

## Deep Dive: Authentication and Session Management (4 minutes)

### Session-Based Auth

```javascript
// middleware/auth.js
import session from 'express-session';
import RedisStore from 'connect-redis';
import { valkeyClient } from '../shared/cache.js';

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

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
```

### Frontend Auth Context

```typescript
// context/AuthContext.tsx
interface AuthState {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    checkSession();
  }, []);

  async function checkSession() {
    try {
      const response = await fetch('/api/v1/auth/me');
      if (response.ok) {
        setUser(await response.json());
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function login(username: string, password: string) {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (!response.ok) throw new Error('Login failed');
    setUser(await response.json());
  }

  async function logout() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
```

## Deep Dive: Error Handling and Resilience (4 minutes)

### Backend Circuit Breaker

```javascript
// services/circuitBreaker.js
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.timeout = options.timeout || 30000;
    this.state = 'CLOSED';
    this.failures = 0;
    this.lastFailure = null;
  }

  async execute(operation) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.timeout) {
        this.state = 'HALF_OPEN';
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

  onSuccess() {
    this.failures = 0;
    if (this.state === 'HALF_OPEN') {
      this.state = 'CLOSED';
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
    }
  }
}
```

### Frontend Error Boundary

```typescript
// components/ErrorBoundary.tsx
class ErrorBoundary extends React.Component<Props, State> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Search error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-fallback">
          <p>Something went wrong with search.</p>
          <button onClick={() => this.setState({ hasError: false })}>
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

### Graceful Degradation

```javascript
// Backend: graceful degradation when providers fail
async function search(query) {
  const results = [];

  // Local index is always available (critical path)
  const localResults = await localIndex.search(query);
  results.push(...localResults);

  // Provider queries are best-effort
  const providerPromises = Array.from(providers.entries()).map(
    async ([name, provider]) => {
      try {
        return await queryProviderWithBreaker(name, query);
      } catch (error) {
        console.warn(`Provider ${name} failed, degrading gracefully`);
        return [];
      }
    }
  );

  // Wait for providers with timeout
  const providerResults = await Promise.race([
    Promise.all(providerPromises),
    sleep(3000).then(() => [])
  ]);

  results.push(...providerResults.flat());
  return mergeResults(results);
}
```

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State Management | Zustand | Redux | Simpler for focused scope, less boilerplate |
| Input Debounce | 50ms | 150ms | Prioritize perceived speed |
| Data Storage | SQLite | PostgreSQL | On-device, zero-config, FTS5 support |
| Session Storage | Valkey | Cookie-only | Supports session invalidation, role checks |
| Multi-source Query | Parallel | Sequential | Lower latency with graceful degradation |
| Type Sharing | Shared types file | OpenAPI codegen | Simpler for single-team project |

## Observability (2 minutes)

### Full-Stack Tracing

```javascript
// Backend tracing
async function handleSearch(req, res) {
  const span = tracer.startSpan('search', {
    attributes: { query: req.query.q, userId: req.session.userId }
  });

  try {
    const [localResults, providerResults] = await Promise.all([
      tracer.startActiveSpan('search.local', async (localSpan) => {
        const results = await localIndex.search(req.query.q);
        localSpan.end();
        return results;
      }),
      tracer.startActiveSpan('search.providers', async (provSpan) => {
        const results = await queryProviders(req.query.q);
        provSpan.end();
        return results;
      })
    ]);

    span.setStatus({ code: SpanStatusCode.OK });
    return mergeResults([...localResults, ...providerResults]);
  } finally {
    span.end();
  }
}
```

### Frontend Performance Metrics

```typescript
// Measure search latency
async function search(query: string) {
  const start = performance.now();

  const results = await searchAPI.search(query);

  const duration = performance.now() - start;
  performance.measure('search-latency', { start, duration });

  if (duration > 100) {
    console.warn('Search latency exceeded 100ms:', duration);
  }

  return results;
}
```

## Future Enhancements

1. **Natural Language Queries**: Parse "emails from John last week" using on-device NLP
2. **Vector Embeddings**: Semantic similarity search with on-device ML
3. **Cross-Device Sync**: Secure index sharing via iCloud Keychain
4. **Voice Input**: "Hey Siri, search for..." with Web Speech API
5. **Custom Extractors**: Plugin system for third-party content types

## Closing Summary

"Spotlight's full-stack architecture is built around three integrated flows:

1. **Search flow**: 50ms debounced frontend input triggers parallel backend queries to local index, app providers, and cloud, with results merged and ranked before rendering in a keyboard-navigable list.

2. **Indexing flow**: File system events trigger content extraction and tokenization during idle time, updating the SQLite inverted index with trie-augmented prefix support.

3. **Suggestions flow**: Usage patterns are recorded in SQLite and analyzed to provide time-based Siri Suggestions displayed when the search bar is empty.

The main trade-off is privacy vs. cloud features. By keeping everything on-device with SQLite and file system watching, we sacrifice cross-device sync and cloud-powered intelligence but achieve complete user privacy and offline functionality. The full stack works together to deliver sub-100ms perceived latency from keystroke to rendered results."
