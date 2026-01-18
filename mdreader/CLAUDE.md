# MD Reader - Development Notes

## Project Context

This document tracks design decisions and system design concepts explored in MDReader, a Progressive Web App for Markdown editing.

**External Repository:** [github.com/evgenyvinnik/mdreader](https://github.com/evgenyvinnik/mdreader)

## System Design Concepts Explored

### 1. Progressive Web App Architecture

MDReader implements the PWA pattern with:
- **Service Worker** for offline caching and asset management
- **Web App Manifest** for installability
- **IndexedDB** for persistent local storage

**Key Learning:** PWAs bridge the gap between web and native apps, providing offline functionality without app store distribution.

### 2. Client-Side Persistence Strategies

Explored multiple storage options:
- **IndexedDB:** Primary storage for documents (large capacity, async)
- **localStorage:** Fallback and preferences storage
- **sessionStorage:** Temporary state

**Key Learning:** IndexedDB is essential for structured data beyond 5MB localStorage limit. The `idb` library provides a cleaner Promise-based API.

### 3. Real-Time Text Processing Pipeline

The markdown rendering pipeline demonstrates:
- **Debouncing:** Prevent excessive re-renders during typing
- **Streaming Parsing:** markdown-it processes text incrementally
- **Sanitization:** Security layer before DOM insertion

### 4. Offline-First Design

Implemented Workbox strategies:
- **Cache-First:** Static assets (fast loads)
- **Network-First:** Dynamic content (fresh data)
- **Stale-While-Revalidate:** Background updates

**Key Learning:** Caching strategies significantly impact user experience. Cache-first for static assets, network-first for data.

## Design Decisions Log

### 1. Monaco vs CodeMirror

**Decision:** Monaco Editor

**Rationale:**
- VS Code familiarity for developers
- Excellent TypeScript/language support
- Rich API for extensions

**Trade-off:** Larger bundle size (~2MB vs ~400KB for CodeMirror)

### 2. markdown-it vs remark

**Decision:** markdown-it

**Rationale:**
- Faster parsing
- Smaller bundle
- Rich plugin ecosystem
- GFM support built-in

### 3. Zustand vs Context API

**Decision:** Zustand for state management

**Rationale:**
- Simpler API than Redux
- No provider nesting
- Built-in persistence middleware
- Better TypeScript support

### 4. IndexedDB vs localStorage

**Decision:** IndexedDB as primary, localStorage as fallback

**Rationale:**
- IndexedDB: 50MB+ quota, async, structured data
- localStorage: 5MB limit, sync (blocks UI), string only

## Iterations and Learnings

### Iteration 1: Basic Editor + Preview

- Implemented split view with Monaco Editor
- Added markdown-it for rendering
- Basic theme switching

**Learning:** Monaco Editor's React wrapper has quirks - need to handle resize events manually.

### Iteration 2: Persistence Layer

- Added IndexedDB storage
- Implemented auto-save with debouncing
- Document management (create, delete, switch)

**Learning:** IndexedDB transactions are tricky - use a wrapper library like `idb`.

### Iteration 3: PWA Features

- Added service worker with Workbox
- Implemented offline support
- Added install prompt handling

**Learning:** Service worker caching requires careful cache invalidation strategy for updates.

### Iteration 4: Polish

- Synchronized scrolling between panes
- Multiple view modes
- Performance optimizations

**Learning:** Scroll synchronization needs proportional mapping, not 1:1 pixel matching.

## Technical Challenges

### Challenge 1: Scroll Sync

**Problem:** Editor and preview have different heights due to rendering differences.

**Solution:** Use proportional scrolling: `previewScroll = (editorScroll / editorMaxScroll) * previewMaxScroll`

### Challenge 2: Large Document Performance

**Problem:** Real-time preview lag with 10K+ line documents.

**Solution:** 
- Debounce preview updates (150ms)
- Consider virtual rendering for preview (future)

### Challenge 3: Service Worker Updates

**Problem:** Users see stale content after deployment.

**Solution:** 
- Workbox `skipWaiting()` for immediate activation
- Show "New version available" toast

## Performance Metrics

| Metric | Target | Achieved |
|--------|--------|----------|
| First Contentful Paint | < 1.5s | ~1.2s |
| Time to Interactive | < 3s | ~2.5s |
| Lighthouse PWA Score | > 90 | 100 |
| Bundle Size (gzipped) | < 500KB | ~450KB |

## Resources

- [Monaco Editor Documentation](https://microsoft.github.io/monaco-editor/)
- [markdown-it Documentation](https://github.com/markdown-it/markdown-it)
- [Workbox PWA Guide](https://developer.chrome.com/docs/workbox/)
- [IndexedDB Best Practices](https://web.dev/indexeddb-best-practices/)

---

*This document captures design insights from the MDReader project for system design learning purposes.*
