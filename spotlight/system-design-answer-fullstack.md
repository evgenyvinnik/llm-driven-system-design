# Spotlight - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

---

## 📋 Introduction (1 minute)

"I'll design Spotlight, Apple's universal search system that provides instant results across files, apps, contacts, messages, and the web. From a full-stack perspective, the core challenge is building an end-to-end system where the frontend delivers instant typeahead feedback while the backend maintains real-time indexes - all while keeping data on-device for privacy.

The architecture integrates three key flows: a search flow where keystrokes trigger debounced API calls that query multiple sources in parallel, an indexing flow where file system events propagate through content extractors to the inverted index, and a suggestions flow where usage patterns feed proactive recommendations. The full stack works together to deliver sub-100ms latency from keystroke to rendered results."

---

## 🎯 Requirements (3 minutes)

### Functional Requirements

- **Search**: Instant results from files, apps, contacts, messages
- **Indexing**: Real-time file watching with incremental updates
- **Special Queries**: Math expressions, unit conversions, definitions
- **Suggestions**: Proactive Siri Suggestions based on usage patterns
- **Web Fallback**: Search the web when local results are sparse

### Non-Functional Requirements

- **End-to-End Latency**: Less than 100ms from keystroke to rendered results
- **Privacy**: All indexing on-device, no cloud telemetry
- **Efficiency**: Less than 5% CPU during background indexing
- **Accessibility**: Full keyboard navigation, screen reader support

### Data Flow Overview

1. User types in search bar
2. Frontend debounces (50ms) and sends API request
3. Backend queries local index, app providers, cloud in parallel
4. Results merged, ranked, and returned
5. Frontend renders grouped results with selection state

---

## 🏗️ High-Level Design (5 minutes)

```
+-------------------------------------------------------------------------+
|                              FRONTEND                                    |
|                                                                          |
|   +-------------+      +-------------+      +-------------+             |
|   | SearchBar   |----->| SearchStore |----->| ResultsList |             |
|   | (debounce)  |      | (Zustand)   |      | (keyboard   |             |
|   +-------------+      +-------------+      |  navigation)|             |
|         |                    ^              +-------------+             |
|         |                    |                                          |
|         v                    |                                          |
|   +-------------------------------------+                               |
|   |           API Client                |                               |
|   |  GET /api/v1/search?q=...           |                               |
|   |  GET /api/v1/suggestions            |                               |
|   +-------------------------------------+                               |
+-------------------------------------------------------------------------+
                               |
                               v
+-------------------------------------------------------------------------+
|                              BACKEND                                     |
|                                                                          |
|   +---------------------------------------------------------------+     |
|   |                      Query Engine                              |     |
|   |         (Parse, Route, Rank, Merge results)                   |     |
|   +---------------------------------------------------------------+     |
|          |                     |                     |                  |
|          v                     v                     v                  |
|   +---------------+    +---------------+    +---------------+           |
|   |  Local Index  |    | App Providers |    |  Cloud Search |           |
|   |  (SQLite)     |    |               |    |               |           |
|   +---------------+    +---------------+    +---------------+           |
|          ^                                                              |
|          |                                                              |
|   +---------------------------------------------------------------+     |
|   |                   Indexing Service                             |     |
|   |       (File watcher, Content extraction, Tokenization)        |     |
|   +---------------------------------------------------------------+     |
+-------------------------------------------------------------------------+
```

---

## 🔍 Deep Dive (25 minutes)

### Frontend State Management

The frontend needs to manage search query state, results, loading indicators, selection state for keyboard navigation, and preview visibility. The key challenge is keeping the UI responsive while making API calls.

#### Why Zustand Over Redux?

| Aspect | Zustand | Redux | Context API |
|--------|---------|-------|-------------|
| Boilerplate | Minimal | Heavy | Medium |
| Bundle Size | ~1KB | ~7KB | Built-in |
| Learning Curve | Low | High | Low |
| DevTools | Yes | Yes | Limited |
| TypeScript DX | Excellent | Good | Good |
| Async Actions | Built-in | Middleware needed | Manual |

✅ Decision: Zustand

"I'm choosing Zustand because Spotlight's state is focused and localized - we have a single search store managing query, results, selection, and loading state. Redux's ceremonies like action creators, reducers, and middleware would add complexity without proportional benefit. Zustand gives us the same predictable state updates with hooks-based access, but with 80% less code. The minimal bundle size also matters since Spotlight needs to feel instant."

The store manages immediate query updates for responsive typing while debouncing the actual API calls. Selection state enables full keyboard navigation with up/down arrows wrapping at list boundaries.

---

### Input Debouncing Strategy

When users type rapidly, we need to balance responsiveness with network efficiency. Too aggressive debouncing feels sluggish; too little creates request floods.

#### Why 50ms Debounce Over Other Values?

| Debounce Time | User Perception | Network Impact | Use Case |
|---------------|-----------------|----------------|----------|
| 0ms (none) | Instant | Request per keystroke | Not viable |
| 50ms | Near-instant | Batches fast typing | Spotlight |
| 150ms | Slight lag | Efficient | Traditional search |
| 300ms | Noticeable wait | Minimal requests | Mobile/slow network |

✅ Decision: 50ms debounce

"I'm choosing 50ms because Spotlight's core promise is instant feedback. At 50ms, users perceive no delay - the 100ms threshold for 'instant' perception gives us 50ms of budget remaining for the API round-trip and render. This debounce still batches rapid keystrokes (average typing speed produces ~150ms between keys, but bursts can hit 30-50ms), reducing network calls by 60% compared to no debouncing while maintaining perceived instantaneity."

The implementation uses immediate UI updates (query text shows instantly) while debouncing the API call, giving users visual feedback that their input was received.

---

### Multi-Source Query Architecture

Spotlight queries multiple data sources: local file index, app providers (Calendar, Mail, Notes), contacts, and cloud fallback. The challenge is aggregating results without creating a latency bottleneck.

#### Why Parallel Multi-Source Query Over Sequential?

| Approach | Latency | Complexity | Graceful Degradation | Resource Usage |
|----------|---------|------------|---------------------|----------------|
| Sequential | O(sum of all sources) | Low | Single point failure | Low |
| Parallel | O(max single source) | Medium | Per-source fallback | Higher |
| Hybrid | Medium | High | Best of both | Variable |

✅ Decision: Parallel with timeouts

"I'm choosing parallel execution because the 100ms latency target requires it mathematically. If local index takes 20ms, contacts 15ms, calendar 25ms, and cloud 40ms, sequential execution would take 100ms minimum - leaving zero margin. Parallel execution caps at the slowest source (40ms), giving us 60ms for network overhead and rendering. Each source gets its own circuit breaker, so a failing calendar service doesn't block file search results."

The query engine fires all source queries simultaneously using Promise.all with a 3-second timeout fallback. Results are merged as they arrive, with the response sent once all sources complete or timeout.

---

### On-Device Storage

Spotlight indexes files, apps, contacts, and usage patterns. The storage choice affects query performance, privacy, and system integration.

#### Why SQLite Over PostgreSQL?

| Factor | SQLite | PostgreSQL | Elasticsearch |
|--------|--------|------------|---------------|
| Deployment | Embedded, zero-config | Separate server | Separate cluster |
| Privacy | On-device by design | Requires local install | Cloud-tempting |
| FTS Support | FTS5 built-in | pg_trgm extension | Native |
| Resource Usage | ~500KB | 100MB+ | 200MB+ |
| Backup/Sync | File copy | pg_dump | Snapshots |
| Concurrent Writes | WAL mode | Native | Native |

✅ Decision: SQLite with FTS5

"I'm choosing SQLite because Spotlight's core promise is privacy through on-device processing. SQLite is the only option that's truly embedded - no daemon, no ports, no network surface. FTS5 provides full-text search with prefix matching, tokenization, and ranking built-in. The 50MB index of 100,000 files fits comfortably in memory for lightning queries. PostgreSQL would require users to run a database server, fundamentally changing the user experience from 'it just works' to 'configure your database.'"

The schema includes tables for indexed files (with content hash for deduplication), an inverted index for token-to-document mapping, app usage patterns for suggestions, and recent activity for ranking boosts.

---

### Authentication and Session Management

The demo implementation needs auth for the admin interface to view indexing status and configure providers.

#### Why Session-Based Auth with Valkey Over JWT?

| Aspect | Session + Valkey | JWT | Cookie-only |
|--------|------------------|-----|-------------|
| Revocation | Instant (delete session) | Wait for expiry | Delete cookie |
| Server State | Required | Stateless | Stateless |
| Token Size | Small session ID | Large (claims embedded) | Medium |
| Role Changes | Immediate | Re-issue token | Re-issue cookie |
| XSS Risk | HttpOnly cookies | Often localStorage | HttpOnly possible |

✅ Decision: Session-based auth with Valkey

"I'm choosing session-based auth because Spotlight's admin interface needs instant session revocation - if an admin's laptop is compromised, we need to invalidate their session immediately. JWT's stateless nature means we'd have to wait for token expiry or maintain a blocklist (negating the stateless benefit). Valkey gives us sub-millisecond session lookups with automatic expiry, and sessions are HttpOnly cookies so they're immune to XSS attacks that plague localStorage JWT patterns."

Sessions store user ID, role, and creation timestamp. The auth middleware checks session validity on each request, with role-based access control for admin-only endpoints.

---

### Frontend-Backend Type Sharing

With TypeScript on both ends, we need to keep API contracts synchronized to catch type mismatches at compile time.

#### Why Shared TypeScript Types Over OpenAPI Codegen?

| Approach | Type Safety | Setup Complexity | Runtime Overhead | Flexibility |
|----------|-------------|------------------|------------------|-------------|
| Shared types file | Compile-time | Minimal | None | High |
| OpenAPI codegen | Compile-time | High (toolchain) | None | Medium |
| Zod runtime validation | Runtime | Medium | Small | High |
| No sharing | None | None | None | Maximum |

✅ Decision: Shared TypeScript types

"I'm choosing a shared types file because Spotlight is a single-team project with co-located frontend and backend. OpenAPI codegen adds a build step, generator config, and template maintenance - overhead justified for large teams or public APIs, but friction for us. A shared types directory with SearchResult, SearchRequest, and Suggestion interfaces gives us compile-time safety with zero tooling complexity. If we later expose a public API, we can add OpenAPI on top of these types."

The shared types include result type unions (application, file, contact, calculation, web_search), search request/response shapes, and suggestion structures for Siri-style recommendations.

---

### Provider Resilience

External providers (Calendar, Mail, cloud search) can fail. The system must degrade gracefully rather than failing entirely.

#### Why Circuit Breaker Pattern?

| Pattern | Failure Handling | Recovery | Implementation |
|---------|------------------|----------|----------------|
| No protection | Cascade failures | Manual restart | None |
| Retry with backoff | Repeated attempts | Eventually succeeds | Simple |
| Circuit breaker | Fast-fail when broken | Auto-recovery probe | Medium |
| Bulkhead | Isolated failure domains | Per-domain | Complex |

✅ Decision: Circuit breaker with per-provider isolation

"I'm choosing circuit breakers because repeated failures to a slow provider would accumulate latency debt - each search waiting for timeout on a known-bad service. The circuit breaker trips after 5 consecutive failures, immediately returning empty results instead of waiting. After 30 seconds in 'open' state, it allows one probe request - if successful, the circuit closes and normal traffic resumes. Combined with parallel queries, this means one provider's outage has zero impact on results from healthy sources."

Each provider gets its own breaker instance. The state machine transitions: CLOSED (normal) -> OPEN (after threshold failures) -> HALF_OPEN (probe) -> CLOSED (if probe succeeds) or OPEN (if probe fails).

---

### Indexing Architecture

Spotlight must maintain a real-time index of files, apps, and contacts without impacting system performance.

#### Why On-Device Indexing Over Cloud Hybrid?

| Approach | Privacy | Offline | Resource Cost | Intelligence |
|----------|---------|---------|---------------|--------------|
| On-device only | Complete | Full | Local CPU/storage | Limited |
| Cloud hybrid | Partial | Degraded | Network + cloud | AI-powered |
| Cloud primary | None | None | Minimal local | Full AI |

✅ Decision: On-device indexing with idle-time processing

"I'm choosing on-device indexing because Spotlight's differentiation is privacy. Users trust that their documents, messages, and photos aren't being sent to servers for indexing. This means we forfeit cloud-powered semantic search and cross-device sync, but we gain complete offline functionality and zero data leakage. The indexing service monitors file system events and queues work, but only processes during idle time (when CPU usage drops below threshold) to stay under the 5% background CPU budget."

The indexing service uses pluggable content extractors for different file types (PDF, DOCX, TXT), tokenizes extracted text, and updates the inverted index with position information for phrase matching.

---

## 📊 Data Flow (3 minutes)

### Search Flow

```
User Types "doc"
      |
      v
+------------------+
| SearchBar        |
| - Update UI      |
| - Start debounce |
+------------------+
      | 50ms
      v
+------------------+
| API Client       |
| GET /search?q=   |
+------------------+
      |
      v
+------------------+
| Query Engine     |
| - Parse query    |
| - Check special  |
+------------------+
      |
      +--------------------+--------------------+
      |                    |                    |
      v                    v                    v
+----------+        +----------+        +----------+
| SQLite   |        | App      |        | Cloud    |
| Index    |        | Providers|        | Search   |
+----------+        +----------+        +----------+
      |                    |                    |
      +--------------------+--------------------+
      |
      v
+------------------+
| Result Merger    |
| - Rank by score  |
| - Group by type  |
| - Add web fallback|
+------------------+
      |
      v
+------------------+
| SearchStore      |
| - Update results |
| - Reset selection|
+------------------+
      |
      v
+------------------+
| ResultsList      |
| - Render grouped |
| - Keyboard nav   |
+------------------+
```

### Indexing Flow

```
File System Event (create/modify/delete)
      |
      v
+------------------+
| File Watcher     |
| - Filter paths   |
| - Debounce rapid |
+------------------+
      |
      v
+------------------+
| Index Queue      |
| - Priority order |
| - Wait for idle  |
+------------------+
      |
      v
+------------------+
| Content Extractor|
| - Detect type    |
| - Extract text   |
| - Get metadata   |
+------------------+
      |
      v
+------------------+
| Tokenizer        |
| - Lowercase      |
| - Stem words     |
| - Remove stops   |
+------------------+
      |
      v
+------------------+
| SQLite FTS5      |
| - Upsert doc     |
| - Update index   |
+------------------+
```

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Rationale |
|----------|-----------|----------------|-----------|
| State Management | Zustand | Redux | Simpler for focused scope, less boilerplate, smaller bundle |
| Input Debounce | 50ms | 150ms | Prioritize perceived speed within 100ms budget |
| Data Storage | SQLite | PostgreSQL | On-device privacy, zero-config, embedded FTS5 |
| Session Storage | Valkey sessions | JWT tokens | Instant revocation, HttpOnly security, role changes |
| Multi-source Query | Parallel | Sequential | Meet 100ms target with graceful degradation |
| Type Sharing | Shared TS file | OpenAPI codegen | Minimal tooling for single-team project |
| Provider Resilience | Circuit breaker | Simple retry | Fast-fail prevents latency accumulation |
| Indexing Location | On-device | Cloud hybrid | Complete privacy, full offline support |

---

## 🚀 Future Enhancements

1. **Natural Language Queries**: Parse "emails from John last week" using on-device NLP models to extract entities and temporal constraints
2. **Vector Embeddings**: Semantic similarity search using on-device transformer models, enabling "find documents about our Q3 strategy" without exact keyword matches
3. **Cross-Device Sync**: Secure index sharing via iCloud Keychain with end-to-end encryption, maintaining privacy while enabling search across devices
4. **Voice Input**: Integration with Web Speech API for "Hey Siri, search for..." allowing hands-free search activation
5. **Custom Extractors**: Plugin system for third-party content types (Figma files, Notion exports, Slack messages) with sandboxed extraction

---

## 📝 Summary

"Spotlight's full-stack architecture is built around three integrated flows:

**Search flow**: 50ms debounced frontend input triggers parallel backend queries to local index, app providers, and cloud, with results merged and ranked before rendering in a keyboard-navigable list. Zustand manages UI state with minimal boilerplate while circuit breakers ensure provider failures don't cascade.

**Indexing flow**: File system events trigger content extraction and tokenization during idle time, updating the SQLite inverted index. The on-device approach sacrifices cloud intelligence but guarantees complete privacy and offline functionality.

**Suggestions flow**: Usage patterns are recorded by time-of-day and day-of-week, analyzed to provide Siri-style suggestions displayed when the search bar is empty - 'Based on your routine, here's what you might need.'

The main trade-off is privacy versus cloud features. By keeping everything on-device with SQLite and file system watching, we sacrifice cross-device sync and AI-powered semantic search but achieve complete user privacy and instant offline access. Session-based auth with Valkey provides secure admin access with instant revocation capability. The full stack works together through shared TypeScript types to deliver sub-100ms perceived latency from keystroke to rendered results."
