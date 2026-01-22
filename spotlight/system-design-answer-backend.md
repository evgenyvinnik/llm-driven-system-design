# Spotlight - System Design Answer (Backend Focus)

*45-minute system design interview format - Backend Engineer Position*

---

## 📋 Introduction (1 minute)

"I'll design Spotlight, Apple's universal search system that provides instant results across files, apps, contacts, messages, and the web. From a backend perspective, the core challenge is building an on-device indexing system with real-time file watching, efficient content extraction, and a high-performance inverted index that delivers sub-100ms search latency.

The backend architecture centers on three pillars: an incremental indexing service that watches file system events and processes them during idle time, a SQLite-based inverted index with trie-augmented prefix matching for typeahead, and a multi-source query engine that routes requests to local index, app providers, and cloud services in parallel. Privacy is paramount - all data stays on-device with no search telemetry sent to servers."

---

## 🎯 Requirements (3 minutes)

### Functional Requirements
- **Indexing**: Real-time file watching with incremental updates
- **Content Extraction**: Parse PDFs, documents, images, HTML for searchable text
- **Search API**: Query local index, app providers, and cloud in parallel
- **Special Queries**: Math expressions, unit conversions, definitions
- **Siri Suggestions**: Time/location-based proactive recommendations

### Non-Functional Requirements
- **Latency**: Less than 100ms for local search results
- **Efficiency**: Less than 5% CPU during background indexing
- **Storage**: Minimal index size (100MB to 1GB depending on content)
- **Privacy**: All indexing on-device, no cloud telemetry

### Scale Estimates (Per Device)
- **Files indexed**: 1M+ (documents, photos, media)
- **Apps**: 100+ with their searchable data
- **Tokens per file**: Up to 10,000
- **Index size**: 100MB to 1GB

---

## 🏗️ High-Level Design (5 minutes)

```
+---------------------------------------------------------------+
|                       Spotlight UI                             |
|            (Search bar, Results list, Previews)                |
+---------------------------------------------------------------+
                              |
                              v
+---------------------------------------------------------------+
|                      Query Engine                              |
|           (Parse, Route, Rank, Merge results)                  |
+---------------------------------------------------------------+
        |                     |                     |
        v                     v                     v
+---------------+    +---------------+    +---------------+
|  Local Index  |    | App Providers |    | Cloud Search  |
|               |    |               |    |               |
| - Files       |    | - Contacts    |    | - iCloud      |
| - Apps        |    | - Calendar    |    | - Mail        |
| - Messages    |    | - Notes       |    | - Safari      |
+---------------+    +---------------+    +---------------+
        |
        v
+---------------------------------------------------------------+
|                     Indexing Service                           |
|        (File watcher, Content extraction, Tokenization)        |
+---------------------------------------------------------------+
```

### Core Backend Components

1. **Indexing Service**: File watcher, content extractors, tokenization pipeline
2. **Search Index**: SQLite with inverted index and trie for prefixes
3. **Query Engine**: Multi-source routing, parallel execution, result merging
4. **App Provider API**: Interface for apps to register searchable content
5. **Siri Suggestions**: Usage pattern tracking in SQLite

---

## 🔍 Deep Dive: On-Device Storage (8 minutes)

### Why SQLite with FTS5 Over PostgreSQL or Custom Binary Format?

| Approach | Deployment | Complexity | Full-Text | ACID | Size Overhead |
|----------|------------|------------|-----------|------|---------------|
| SQLite + FTS5 | Embedded, zero-config | Low | Native FTS5 | Yes | Medium |
| PostgreSQL | Requires daemon process | High | GIN indexes | Yes | High |
| Custom Binary | Fully custom | Very High | Build from scratch | Manual | Low |
| LevelDB/RocksDB | Embedded key-value | Medium | No native FTS | No | Low |

**Decision**: SQLite with FTS5

"I'm choosing SQLite with FTS5 because this is an on-device system that must work without any server processes. PostgreSQL would require running a separate daemon, which adds complexity and resource usage for a desktop search feature. A custom binary format would give us the smallest footprint, but we'd need to implement our own full-text search, crash recovery, and concurrent access handling. SQLite gives us battle-tested ACID guarantees, built-in FTS5 for efficient text search with prefix matching, and zero configuration. Apple has shipped SQLite on every device for over a decade, so users already have the dependency."

### Database Design

The schema consists of four main tables:

**Indexed Files Table**: Stores file paths as primary keys with name, type, content hash, tokens as a JSON array, metadata as JSON, file size, modification time, and indexing timestamp. Indexed on name and type for fast filtering.

**Inverted Index Table**: Maps terms to document paths with position information. The primary key is a composite of term, document path, and position. Indexed on term for fast lookups.

**App Usage Patterns Table**: Tracks usage by bundle ID, hour, and day of week. Stores count and last used timestamp. Primary key is bundle ID plus hour plus day of week for Siri Suggestions.

**Recent Activity Table**: Auto-incrementing ID with type (file, app, contact, url), item ID, item name, and timestamp. Indexed on timestamp descending for recency queries.

---

## 🔍 Deep Dive: File System Monitoring (6 minutes)

### Why FSEvents Over Periodic Scanning?

| Approach | Latency | CPU Usage | Battery Impact | Reliability |
|----------|---------|-----------|----------------|-------------|
| FSEvents (macOS) | Real-time | Near zero | Minimal | High (kernel-level) |
| Periodic Scan | Minutes | High during scan | Significant | High |
| inotify (Linux) | Real-time | Near zero | Minimal | High |
| Polling | Seconds | Constant overhead | Moderate | High |

**Decision**: FSEvents file watcher

"I'm choosing FSEvents because it's a kernel-level notification system that Apple specifically designed for this use case. The kernel already tracks file system changes, so FSEvents just lets us subscribe to those events at near-zero CPU cost. Periodic scanning would require traversing millions of files every few minutes, which would drain battery and spike CPU usage. FSEvents gives us real-time notifications, historical event replay after sleep/wake, and coalescing of rapid changes. The main trade-off is that FSEvents is macOS-specific, but since Spotlight is an Apple product, that's acceptable."

### File Watcher Architecture

The indexing service registers to watch the Users and Applications directories while ignoring paths like Library/Caches, node_modules, and .git directories. When files are created or modified, they're added to a pending queue with the action type and timestamp. When files are deleted, they're immediately removed from the index.

The key insight is that we don't process changes immediately. Instead, we queue them and process during idle time to avoid impacting user activities.

### Why Idle-Time Scheduling Over Immediate Indexing?

| Approach | User Experience | Indexing Speed | Resource Usage | Complexity |
|----------|-----------------|----------------|----------------|------------|
| Idle-Time | Excellent | Delayed | Low when user active | Medium |
| Immediate | May lag during heavy writes | Fast | Potentially high | Low |
| Batched Periodic | Good | Delayed | Predictable spikes | Low |
| Priority Queue | Good | Fast for important files | Medium | High |

**Decision**: Idle-time scheduling with priority hints

"I'm choosing idle-time scheduling because Spotlight should be invisible to the user. If someone is writing a document or compiling code, they shouldn't notice any slowdown from indexing. The system checks CPU usage (must be below 30%), time since last user input (must be over 5 seconds), and battery state (not critically low unless plugged in). We sacrifice indexing speed for user experience. A file saved right now might not be searchable for 30 seconds, but the user's active work is never interrupted. For important files like the currently open document, we can add priority hints to index them sooner."

### Content Extraction Pipeline

Files under 50MB are processed through type-specific extractors:
- PDFs use a PDF extractor to pull text content
- DOCX files use a Word document extractor
- Plain text uses a simple text extractor
- HTML uses an extractor that strips tags
- Images use a metadata extractor for EXIF data and filenames

The extracted text is tokenized by converting to lowercase, removing non-word characters, splitting on whitespace, filtering out single-character tokens, and limiting to 10,000 tokens per file to bound index size.

---

## 🔍 Deep Dive: Inverted Index with Trie (7 minutes)

### Why Inverted Index + Trie Hybrid Over Pure Inverted Index?

| Approach | Exact Match | Prefix Match | Memory | Update Cost |
|----------|-------------|--------------|--------|-------------|
| Inverted Index + Trie | O(1) lookup | O(prefix length) | Medium-High | Medium |
| Pure Inverted Index | O(1) lookup | O(n) scan | Medium | Low |
| Trie Only | O(word length) | O(prefix length) | High | Medium |
| Suffix Array | O(log n) | O(log n + results) | Medium | High |

**Decision**: Inverted index with trie augmentation

"I'm choosing a hybrid approach because Spotlight has two distinct access patterns. When users finish typing a word and press enter, we need exact matching, which is what inverted indexes excel at. But the more common case is typeahead, where users type 'doc' and expect to see 'Documents' immediately. For typeahead, we need prefix matching. A pure inverted index would require scanning all terms starting with 'doc', which is O(n) where n is the vocabulary size. A trie gives us O(prefix length) for prefix lookups, which is constant time relative to vocabulary size. The cost is extra memory for the trie, but on a modern Mac with 8GB+ RAM, a few hundred MB is acceptable."

### Hybrid Data Structure

The search index maintains three structures:
1. **Inverted Index** (term to document IDs): Hash map for O(1) exact term lookup
2. **Documents Map** (document ID to document): Stores full document metadata
3. **Prefix Index** (trie): Stores prefixes pointing to document IDs

When inserting a document, we store it in the documents map, then for each token, we add it to both the inverted index and the prefix trie. File names get special treatment in the prefix index since they're the most common search target.

### Search Algorithm

For a query like "proj rep", we split into tokens and process them differently:
- Non-final tokens use exact matching from the inverted index
- The final token (what the user is currently typing) uses prefix matching from the trie

We intersect the result sets for AND semantics, meaning all terms must match. Then we score and rank the results.

### Ranking Algorithm

The scoring combines multiple signals:

**Name Match (highest weight)**: If query tokens appear in the file name, add 10 points. Prefix matches in the name get an additional 5 points.

**Recency Boost**: Files modified recently get up to 5 points, decaying by 0.1 points per day.

**Type Boost**: Applications get 3 points, contacts and messages get 2 points, regular files get 1 point.

This simple scoring works well because name matches are almost always what users want. A search for "resume" should show resume.pdf before a random document that mentions the word resume in paragraph 15.

---

## 🔍 Deep Dive: Query Engine and Multi-Source Routing (5 minutes)

### Query Engine Architecture

The query engine handles three types of requests:

**Special Queries**: Math expressions (detected by regex for numbers and operators), unit conversions (detected by "X unit to Y unit" pattern), and dictionary lookups. These bypass the search index entirely.

**Local Search**: Queries the on-device inverted index for files, apps, and local messages.

**Provider Queries**: Sends queries in parallel to registered app providers (Contacts, Calendar, Notes, Mail) and cloud services (iCloud, Safari suggestions).

All sources are queried in parallel using Promise.all, then results are merged and re-ranked. If we get fewer than 3 results, we add a web search fallback option.

### Why Circuit Breaker Pattern for App Providers?

| Approach | Failure Handling | Recovery | Latency Impact | Complexity |
|----------|------------------|----------|----------------|------------|
| Circuit Breaker | Fails fast after threshold | Auto-recovery | Minimal | Medium |
| Simple Timeout | Waits for timeout each time | Immediate retry | High during failures | Low |
| Retry with Backoff | Multiple attempts | Gradual | Very high during failures | Medium |
| No Protection | Cascading failures | Manual | Catastrophic | None |

**Decision**: Circuit breaker per provider

"I'm choosing circuit breakers because third-party app providers can fail in unpredictable ways. A buggy Notes extension might hang indefinitely, or a Calendar provider might crash. Without protection, one failing provider would make every search slow. The circuit breaker has three states: CLOSED (normal operation), OPEN (failing fast without calling the provider), and HALF_OPEN (testing if the provider recovered). After 3 consecutive failures, the circuit opens for 60 seconds. This means users see fast results from working providers while the broken one is isolated. When the timeout expires, we try one request to see if it recovered."

The key insight is graceful degradation. If Contacts is failing, searches should still show files and apps instantly. The circuit breaker returns an empty array when open, which gets merged with results from healthy providers.

---

## 🔍 Deep Dive: Rate Limiting (4 minutes)

### Why Token Bucket Over Fixed Window?

| Approach | Burst Handling | Smoothness | Memory | Implementation |
|----------|----------------|------------|--------|----------------|
| Token Bucket | Allows controlled bursts | Smooth over time | O(1) per key | Medium |
| Fixed Window | Edge case double-burst | Choppy at boundaries | O(1) per key | Simple |
| Sliding Window Log | No bursts | Perfectly smooth | O(n) per key | Complex |
| Leaky Bucket | Strict rate | Very smooth | O(1) per key | Medium |

**Decision**: Token bucket rate limiting

"I'm choosing token bucket because it matches real user behavior. A user might type quickly for a few seconds (burst), then pause to read results (refill). Fixed window has the boundary problem where a user could make 100 requests at 11:59:59 and 100 more at 12:00:01, effectively doubling the limit. Token bucket naturally handles this by accumulating tokens during idle periods. For search, we allow 100 tokens with a refill rate of 10 per second. For expensive operations like forcing a re-index, we allow only 5 tokens with 1 refill per minute."

Rate limits are applied per category:
- **Search**: 100 tokens, refills at 10/second
- **Suggestions**: 30 tokens, refills at 5/second
- **Reindex**: 5 tokens, refills at 1/minute

Global limits prevent abuse even if individual limits pass:
- **Global Search**: 500 tokens, refills at 50/second
- **Cloud Query**: 20 tokens, refills at 2/second

---

## 📊 Data Flow

### Indexing Flow
```
File Created/Modified
        |
        v
+------------------+
| FSEvents Watcher |
+------------------+
        |
        v
+------------------+     +------------------+
| Pending Queue    |---->| Idle Check       |
+------------------+     | - CPU < 30%      |
                         | - User idle > 5s |
                         | - Battery OK     |
                         +------------------+
                                 |
                                 v
                         +------------------+
                         | Content Extractor|
                         | - PDF, DOCX, TXT |
                         | - HTML, Images   |
                         +------------------+
                                 |
                                 v
                         +------------------+
                         | Tokenizer        |
                         | - Lowercase      |
                         | - Split words    |
                         | - Limit 10K      |
                         +------------------+
                                 |
                                 v
                         +------------------+
                         | SQLite + Trie    |
                         | - Inverted index |
                         | - Prefix index   |
                         +------------------+
```

### Search Flow
```
User Types "proj"
        |
        v
+------------------+
| Query Parser     |-----> Math? Conversion? Definition?
+------------------+              |
        |                    Special Handler
        v                         |
+-------+-------+-------+         v
|       |       |       |    Direct Result
v       v       v       |
Local   App     Cloud   |
Index   Providers Search|
|       |       |       |
+---(Circuit Breakers)--+
        |
        v
+------------------+
| Result Merger    |
| - Deduplicate    |
| - Score/Rank     |
| - Limit to 20    |
+------------------+
        |
        v
+------------------+
| Spotlight UI     |
| - Instant update |
| - As-you-type    |
+------------------+
```

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Rationale |
|----------|-----------|----------------|-----------|
| Storage | SQLite with FTS5 | PostgreSQL, Custom binary | Zero-config embedded DB with native FTS, ACID guarantees, battle-tested on Apple platforms |
| File Monitoring | FSEvents watcher | Periodic scanning | Real-time at near-zero CPU cost, kernel-level reliability |
| Index Structure | Inverted index + Trie | Pure inverted index | O(prefix) typeahead while keeping O(1) exact match |
| Scheduling | Idle-time processing | Immediate indexing | User experience over indexing speed, invisible to active user |
| Provider Resilience | Circuit breaker pattern | Simple timeout | Fail fast, auto-recovery, graceful degradation |
| Rate Limiting | Token bucket | Fixed window | Handles bursts naturally, no boundary double-burst problem |
| Multi-source Query | Parallel with merge | Sequential fallback | Lower latency, one slow provider doesn't block others |
| Privacy Model | On-device only | Cloud hybrid | Complete privacy, works offline, no telemetry |

---

## 🚀 Future Enhancements

1. **Vector Embeddings**: On-device ML for semantic similarity search using CoreML, enabling queries like "that beach photo from vacation" to find images without exact keyword matches.

2. **Content-Addressed Deduplication**: Hash-based dedup for similar files, reducing index size when users have multiple versions of the same document.

3. **Smart Compaction**: Merge index segments during idle time to reduce fragmentation and improve query performance.

4. **Natural Language Understanding**: Parse queries like "emails from John last week" into structured filters on sender and date range.

5. **Cross-Device Index Sync**: Secure index synchronization via iCloud Keychain, allowing search on one device to find files on another without exposing content to Apple's servers.

---

## 📝 Summary

"Spotlight's backend architecture is built around three principles:

**Privacy-first on-device indexing**: File system watching with FSEvents provides real-time notifications at near-zero CPU cost. Idle-time processing ensures indexing never interferes with user activities. Pluggable content extractors handle diverse file formats from PDFs to images.

**Hybrid index structure**: An inverted index provides O(1) exact term lookup for complete queries, while a trie augmentation gives O(prefix length) typeahead matching as users type. SQLite stores everything with ACID guarantees and built-in FTS5 support.

**Fault-tolerant query routing**: Parallel queries to local index, app providers, and cloud services return the fastest results first. Per-provider circuit breakers isolate failures, ensuring one buggy extension doesn't slow down the entire search experience. Token bucket rate limiting handles natural user bursts while preventing abuse.

The main trade-off is privacy versus cross-device features. By keeping everything on-device, we sacrifice cloud-powered intelligence and automatic index synchronization, but we achieve complete user privacy and full offline functionality. Users can search their files even without an internet connection, and no search queries ever leave the device."
