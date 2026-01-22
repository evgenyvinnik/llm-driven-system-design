# Typeahead - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

---

## 📋 Introduction

"Today I'll be designing the frontend architecture for a typeahead/autocomplete system. This is the component users see when they start typing in a search box and suggestions appear below. Think of Google Search suggestions or the command palette in VS Code. The frontend is critical here because we're dealing with real-time user input, and any perceived lag will make the product feel broken."

---

## 🎯 Requirements

### Functional Requirements

1. **Instant Suggestions** - Show results as user types each character
2. **Multiple Widget Types** - Search box, command palette, form autocomplete, rich suggestions with images
3. **History Integration** - Merge user's recent searches with API suggestions
4. **Offline Support** - Work without network using cached data
5. **Keyboard Navigation** - Full keyboard accessibility for power users

### Non-Functional Requirements

1. **Perceived Latency** - Under 50ms from keypress to suggestions visible
2. **Cache Hit Rate** - Over 80% to reduce server load
3. **Bundle Size** - Under 5KB gzipped for core typeahead module
4. **Accessibility** - WCAG 2.1 AA compliant
5. **Offline** - Functional with stale data when network unavailable

### Scale Estimates

"Let me think about the frontend-specific scale here."

- Keystrokes per session: 50-100
- API calls per session: 10-20 (with effective caching)
- Memory cache size: Around 500 entries
- IndexedDB storage: Approximately 5MB for offline trie

---

## 🏗️ High-Level Design

"Let me draw the browser-side architecture. The key insight is that we need multiple caching layers to hit that 50ms latency target."

```
+------------------------------------------------------------------------+
|                          BROWSER ENVIRONMENT                            |
+------------------------------------------------------------------------+
|                                                                         |
|   +--------------+     +----------------+     +-----------------+       |
|   | Search Box   |     | Command Palette|     | Rich Typeahead  |       |
|   | Widget       |     | Widget         |     | Widget          |       |
|   +------+-------+     +-------+--------+     +--------+--------+       |
|          |                     |                       |                |
|          +---------------------+-----------------------+                |
|                                |                                        |
|                                v                                        |
|   +----------------------------------------------------------------+   |
|   |                    TYPEAHEAD CORE MODULE                        |   |
|   |                                                                 |   |
|   |  +------------------+  +------------------+  +---------------+  |   |
|   |  | Request Manager  |  | Cache Coordinator|  | Source Merger |  |   |
|   |  | (debounce,abort) |  | (multi-layer)    |  | (API+history) |  |   |
|   |  +------------------+  +------------------+  +---------------+  |   |
|   +----------------------------------------------------------------+   |
|                                |                                        |
|          +---------------------+---------------------+                  |
|          |                     |                     |                  |
|          v                     v                     v                  |
|   +-------------+     +-----------------+     +----------------+        |
|   | Memory Cache|     | Service Worker  |     | IndexedDB      |        |
|   | (0ms)       |     | (1-5ms)         |     | (5-20ms)       |        |
|   | ~500 items  |     | stale-while-    |     | offline trie   |        |
|   +-------------+     | revalidate      |     | user history   |        |
|                       +-----------------+     +----------------+        |
|                                |                                        |
+--------------------------------|----------------------------------------+
                                 |
                                 v
+------------------------------------------------------------------------+
|                           NETWORK LAYER                                 |
+------------------------------------------------------------------------+
|   CDN Edge Cache (10-50ms)  ---->  Origin API (50-200ms)               |
+------------------------------------------------------------------------+
```

"The core insight here is the cascade of caching layers, each with different latency characteristics. Memory cache gives us 0ms response for repeated queries. Service Worker survives page refreshes. IndexedDB provides offline capability."

---

## 🔍 Deep Dive

### Widget Architecture

"Before diving into the technical decisions, let me describe the different widget types we need to support."

**Search Box Widget** - The classic typeahead with API-backed suggestions. Uses 150ms debounce, shows 8 suggestions maximum, merges with recent searches.

**Command Palette Widget** - Like VS Code's Cmd+K. Local-first with fuzzy matching, 50ms debounce since data is in-memory, shows all commands initially when empty.

**Rich Suggestions Widget** - Like Google showing artist cards with images. Requires additional metadata and layout complexity.

**Mobile Typeahead** - Full-screen overlay, larger touch targets of 48px minimum, separate section for recent searches.

---

### Trade-off 1: Why Debounce Over Throttle?

"This is a critical decision for request management. Let me explain why I'm choosing debounce."

```
User typing "weather":

Timeline (ms):    0     50    100   150   200   250   300   350   400
Keystroke:        w     e     a     t     h     e     r
                  |     |     |     |     |     |     |

DEBOUNCE (150ms): [-----wait-----] [-----wait-----] [-----wait-----][FIRE]
                                                            Only fires for "weather"

THROTTLE (150ms): [FIRE] [----] [FIRE] [----] [FIRE] [----] [FIRE]
                    w            eat           eather       weather
                  Fires at 0, 150, 300, 450 regardless of typing pace
```

| Approach | API Requests | User Experience | Best For |
|----------|--------------|-----------------|----------|
| Debounce (150ms) | 1 per typing pause | Shows final prefix only | Typeahead |
| Throttle (150ms) | Regular intervals | Progressive results | Scroll tracking, resize |
| Neither | Every keystroke | Immediate but expensive | Local-only data |

**Decision: Debounce at 150ms**

"I'm choosing debounce because the user typically wants suggestions for their final intended prefix, not intermediate states. For the word 'weather', debounce makes 1 request while throttle would make 4. The 150ms value is the sweet spot - fast enough to feel responsive but slow enough to batch rapid typing. Users rarely notice this delay because they're focused on their own typing."

---

### Trade-off 2: Why Multi-Layer Cache?

"Let me break down the caching strategy and why we need multiple layers."

```
CACHE LAYER DIAGRAM:

                Query: "weat"
                      |
                      v
+---------------------|---------------------+
|              Memory Cache                 |
|  Map<prefix, {suggestions, timestamp}>    |
|  Latency: 0ms  |  Size: ~500 entries      |
|  TTL: 60 seconds                          |
+---------------------|---------------------+
                      | MISS
                      v
+---------------------|---------------------+
|            Service Worker Cache           |
|  Cache API with stale-while-revalidate    |
|  Latency: 1-5ms  |  Survives refresh      |
|  TTL: 5 min (popular) / 1 min (long-tail) |
+---------------------|---------------------+
                      | MISS
                      v
+---------------------|---------------------+
|               IndexedDB                   |
|  Larger dataset, user history, trie       |
|  Latency: 5-20ms  |  Persists forever     |
|  Used for offline fallback                |
+---------------------|---------------------+
                      | MISS
                      v
+---------------------|---------------------+
|                 Network                   |
|  CDN: 10-50ms  |  Origin: 50-200ms        |
+---------------------------------------------+
```

| Strategy | Latency | Survives Refresh | Offline | Complexity |
|----------|---------|------------------|---------|------------|
| Memory only | 0ms | No | No | Low |
| Memory + Service Worker | 0-5ms | Yes | Partial | Medium |
| Memory + SW + IndexedDB | 0-20ms | Yes | Yes | High |
| Memory + LocalStorage | 0-1ms | Yes | Limited 5MB | Low |

**Decision: Memory + Service Worker + IndexedDB**

"I'm choosing the full three-layer approach because typeahead is one of those features where every millisecond matters to user perception. Memory gives instant response for the current session. Service Worker survives page navigation and refreshes, which is common in single-page apps. IndexedDB provides true offline capability - the user can search even when disconnected. Yes, it's more complex, but the latency improvement justifies it. We can lazy-load the IndexedDB layer so it doesn't block initial page load."

---

### Trade-off 3: Why Stale-While-Revalidate?

"The Service Worker uses the stale-while-revalidate pattern. Let me explain why."

```
STALE-WHILE-REVALIDATE FLOW:

User types "wea"
      |
      v
+------------------+
| Check SW Cache   |
+--------+---------+
         |
    +----+----+
    |         |
  FRESH     STALE
    |         |
    v         v
Return     Return cached immediately
immediately   +
              |
              v
          Fetch fresh in background
              |
              v
          Update cache for next request
```

| Strategy | First Response | Freshness | When to Use |
|----------|---------------|-----------|-------------|
| Cache-first | Instant | May be stale | Static assets |
| Network-first | 50-200ms | Always fresh | Critical data |
| Stale-while-revalidate | Instant | Fresh on next request | Typeahead suggestions |
| Network-only | 50-200ms | Always fresh | Personalized data |

**Decision: Stale-While-Revalidate**

"I'm choosing stale-while-revalidate because typeahead suggestions don't need to be perfectly fresh - showing yesterday's top suggestions for 'wea' is fine. What matters is speed. This pattern gives us the best of both worlds: instant response from cache while quietly updating in the background. For popular prefixes we use a 5-minute TTL with 1-hour stale tolerance. For long-tail queries we use 1-minute TTL since they're less likely to be cached anyway."

---

### Trade-off 4: Why IndexedDB Over LocalStorage?

"For offline storage, we have a choice between IndexedDB and LocalStorage."

| Feature | LocalStorage | IndexedDB |
|---------|--------------|-----------|
| Storage limit | 5-10MB | 50MB+ (browser dependent) |
| Data structure | String key-value only | Objects, arrays, binary |
| Indexing | None | Yes, queryable |
| Async API | No (blocks main thread) | Yes (non-blocking) |
| Transaction support | No | Yes |
| Browser support | Universal | Universal |

**Decision: IndexedDB**

"I'm choosing IndexedDB because we need to store structured data - the trie for offline prefix matching, user search history with counts and timestamps, and popular query datasets. LocalStorage's 5MB limit is too restrictive, and its synchronous API would block the main thread during reads. IndexedDB lets us store our entire offline trie, which could be several megabytes, and query it efficiently. The async API means we never block the UI thread during storage operations."

---

### Trade-off 5: Why Zustand Over Redux or Context?

"For state management, I need to choose between several options."

| Library | Bundle Size | Boilerplate | Learning Curve | Persistence |
|---------|-------------|-------------|----------------|-------------|
| Zustand | 1.1KB | Minimal | Low | Built-in |
| Redux Toolkit | 11KB | Medium | Medium | Requires middleware |
| React Context | 0KB | Medium | Low | Manual |
| Jotai | 2.5KB | Minimal | Low | Built-in |
| MobX | 16KB | Low | Medium | Manual |

**Decision: Zustand**

"I'm choosing Zustand because typeahead state is relatively simple - query string, suggestions array, loading state, active index, and recent searches. Redux would be overkill here with its actions, reducers, and middleware. React Context alone would work but doesn't have built-in persistence for recent searches. Zustand gives us a tiny bundle, simple API, and built-in persist middleware to save recent searches to localStorage. The store is literally a single function call with no providers needed."

---

### Trade-off 6: Why AbortController for Request Cancellation?

"When users type quickly, we get overlapping requests. We need a strategy to handle this."

```
USER TYPES FAST:

Request 1: "w"   --> starts
Request 2: "we"  --> starts
Request 3: "wea" --> starts

WITHOUT CANCELLATION:
  Response 3 arrives (fast server)  --> shows "wea" results
  Response 1 arrives (slow network) --> OVERWRITES with "w" results [BUG!]

WITH ABORTCONTROLLER:
  Request 1: aborted when Request 2 starts
  Request 2: aborted when Request 3 starts
  Only Response 3 can update the UI
```

| Strategy | Stale Response Risk | Network Waste | Complexity |
|----------|---------------------|---------------|------------|
| No cancellation | High - race conditions | High | Low |
| AbortController | None | Low | Low |
| Request ID tracking | Low | High | Medium |
| RxJS switchMap | None | Low | High |

**Decision: AbortController**

"I'm choosing AbortController because it solves the stale response problem with minimal complexity. Before firing each request, we abort the previous pending request. This prevents the race condition where an old response arrives late and overwrites newer data. It also saves bandwidth by cancelling network requests the user no longer cares about. The API is simple - create a controller, pass its signal to fetch, call abort when needed. Browser support is universal in modern browsers."

---

### Trade-off 7: Why Full ARIA Pattern Over Basic Keyboard?

"Accessibility isn't optional, but we have choices in how deep to go."

| Approach | Effort | Screen Reader Support | WCAG Level |
|----------|--------|----------------------|------------|
| Basic keyboard (arrows, enter, escape) | Low | Poor | A |
| ARIA combobox pattern | Medium | Good | AA |
| Full ARIA with live regions | High | Excellent | AA+ |

ARIA attributes needed for full combobox pattern:
- Input: role="combobox", aria-expanded, aria-controls, aria-activedescendant, aria-autocomplete="list"
- Listbox: role="listbox", aria-labelledby
- Options: role="option", aria-selected
- Status: role="status", aria-live="polite" for announcing suggestion count

**Decision: Full ARIA Pattern with Live Regions**

"I'm choosing the full ARIA pattern because typeahead is a common interaction pattern and screen reader users deserve an equal experience. The combobox pattern is well-documented in WAI-ARIA authoring practices. We'll use aria-activedescendant to communicate the currently focused suggestion, aria-expanded to indicate dropdown state, and a live region to announce when suggestions load. Yes, it's more work, but it's the right thing to do and often required for enterprise customers."

---

## 📊 Data Flow

"Let me trace through the complete flow when a user types a character."

```
USER TYPES "a"
     |
     v
+--------------------+
| onInput fires      |
+--------------------+
     |
     v
+--------------------+
| Clear debounce     |
| timer if exists    |
+--------------------+
     |
     v
+--------------------+
| Check memory cache |-----> HIT: Return immediately, done
+--------------------+
     | MISS
     v
+--------------------+
| Start 150ms timer  |
+--------------------+
     |
     | (user stops typing)
     v
+--------------------+
| Timer fires        |
+--------------------+
     |
     v
+--------------------+
| Abort previous     |
| pending request    |
+--------------------+
     |
     v
+--------------------+
| Create new         |
| AbortController    |
+--------------------+
     |
     v
+--------------------+
| Check SW cache     |-----> HIT: Return stale, revalidate in background
+--------------------+
     | MISS
     v
+--------------------+
| Check IndexedDB    |-----> HIT: Return offline results
+--------------------+
     | MISS
     v
+--------------------+
| Fetch from CDN     |
| /api/v1/suggest?q= |
+--------------------+
     |
     v
+--------------------+
| Response received  |
+--------------------+
     |
     v
+--------------------+
| Merge with recent  |
| searches           |
+--------------------+
     |
     v
+--------------------+
| Rank and limit     |
| to 8 suggestions   |
+--------------------+
     |
     v
+--------------------+
| Update all cache   |
| layers             |
+--------------------+
     |
     v
+--------------------+
| Render suggestions |
| Update ARIA state  |
+--------------------+
```

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Request pattern | Debounce 150ms | Throttle | Fewer requests, final prefix only |
| Caching | Multi-layer | Memory only | Offline support, survives refresh |
| SW strategy | Stale-while-revalidate | Network-first | Speed over perfect freshness |
| Offline storage | IndexedDB | LocalStorage | Larger capacity, structured queries |
| State management | Zustand | Redux | Simpler API, smaller bundle |
| Request cancellation | AbortController | None | Prevent stale response overwrites |
| Accessibility | Full ARIA | Basic keyboard | Screen reader support, WCAG compliance |

---

## 🚀 Future Enhancements

"If we have more time or resources, here's what I'd prioritize next."

1. **WebSocket Streaming** - Real-time suggestion updates as user types without polling
2. **Voice Input** - Speech-to-text integration, especially valuable on mobile
3. **Rich Previews** - Inline preview cards when hovering over suggestions
4. **Gesture Navigation** - Swipe to delete recent searches on mobile
5. **Smart Prefetch** - ML-based prediction of next likely prefix based on user behavior
6. **Theme Support** - Dark mode with proper contrast ratios maintained
7. **Internationalization** - RTL language support, locale-specific sorting

---

## 📝 Summary

"To wrap up, I've designed a frontend typeahead system with these key characteristics:

First, sub-50ms perceived latency through a three-layer caching strategy - memory for instant session hits, Service Worker for cross-navigation persistence, and IndexedDB for offline capability.

Second, robust request management using debouncing to reduce server load and AbortController to prevent race conditions with stale responses.

Third, full accessibility compliance with the ARIA combobox pattern, live regions for screen reader announcements, and proper keyboard navigation.

Fourth, multiple widget types supported through a configurable core module - search boxes, command palettes, and rich suggestion displays all share the same underlying engine.

The main trade-off I made was complexity - three cache layers is more to maintain than one. But for a typeahead where every keystroke matters, the latency improvement is worth it."
