# MD Reader - Architecture Design

## System Overview

A Progressive Web App (PWA) for editing and previewing Markdown in the browser, featuring offline support, persistent local storage, and real-time rendering. The application runs entirely client-side with no backend server, using IndexedDB for document persistence and a service worker for offline capability.

**Learning goals:** PWA architecture (service workers, caching strategies, installability), client-side persistence with IndexedDB, real-time text processing pipelines, offline-first design patterns.

## Requirements

### Functional Requirements

- Markdown editing with syntax highlighting (Monaco Editor)
- Live preview with GitHub Flavored Markdown support
- Document persistence across sessions with multi-document management
- Multiple view modes (editor only, preview only, split)
- Theme support (light/dark)
- File import/export (Markdown files)

### Non-Functional Requirements

- **Offline Support:** 100% functionality without internet connection after initial load
- **Performance:** Keystroke-to-editor response p95 < 16ms (60 FPS), preview update p95 < 80ms
- **Security:** All user-provided Markdown sanitized before DOM insertion (XSS prevention)
- **Persistence:** Zero document loss -- data survives browser restarts, updates, and service worker transitions
- **Cold Start:** First Contentful Paint < 1.5s, Time to Interactive < 3s
- **Storage:** Support 100 documents up to 500 KB each (~50 MB total IndexedDB budget)

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Browser Environment                            │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                     Application Shell (React)                      │  │
│  │                                                                    │  │
│  │  ┌──────────────────┐  ┌──────────────────────────────────────┐   │  │
│  │  │     Toolbar      │  │           View Container              │   │  │
│  │  │  ┌────────────┐  │  │  ┌──────────────┬─────────────────┐  │   │  │
│  │  │  │ New / Open │  │  │  │    Editor    │    Preview      │  │   │  │
│  │  │  │ Save       │  │  │  │   (Monaco)   │  (markdown-it   │  │   │  │
│  │  │  │ Theme      │  │  │  │              │   + DOMPurify)  │  │   │  │
│  │  │  │ View Mode  │  │  │  └──────────────┴─────────────────┘  │   │  │
│  │  │  └────────────┘  │  └──────────────────────────────────────┘   │  │
│  │  └──────────────────┘                                              │  │
│  │                                                                    │  │
│  │  ┌────────────────────────────────────────────────────────────┐   │  │
│  │  │              Document Selector (dropdown + search)          │   │  │
│  │  └────────────────────────────────────────────────────────────┘   │  │
│  └─────────────────────────────┬──────────────────────────────────────┘  │
│                                │                                         │
│                                ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      Zustand State Store                         │   │
│  │  - Current document content    - Document list                   │   │
│  │  - Editor settings             - Theme preference                │   │
│  └──────────┬──────────────────────────────────┬────────────────────┘   │
│             │                                  │                        │
│             ▼                                  ▼                        │
│  ┌───────────────────────┐          ┌─────────────────────────────┐    │
│  │      IndexedDB        │          │     localStorage            │    │
│  │  (Primary Storage)    │          │  (Fallback + Preferences)   │    │
│  │  - Documents (50 MB)  │          │  - Single doc backup (5 MB) │    │
│  └───────────────────────┘          └─────────────────────────────┘    │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    Service Worker (Workbox)                       │   │
│  │  - Cache-first: App shell, Monaco, fonts (~10 MB)                │   │
│  │  - Network-first: Runtime resources (if any)                     │   │
│  │  - Stale-while-revalidate: Background updates                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Monaco Editor Integration

The editor component wraps Microsoft's Monaco Editor, providing the same editing experience as VS Code:

- **Syntax highlighting:** Built-in Markdown language support with token colorization
- **Features:** Line numbers, word wrap, code folding, minimap, bracket matching
- **Theming:** Light and dark themes matching VS Code's built-in themes
- **Performance:** Virtual scrolling for large documents -- only visible lines are rendered in the DOM
- **Lazy loading:** Monaco's ~2 MB bundle is loaded lazily to keep initial FCP under 1.5s

### 2. Markdown Processing Pipeline

The rendering pipeline transforms raw Markdown text into safe HTML for the preview pane:

```
Raw Markdown
    │
    ▼
┌──────────────────────────────┐
│  markdown-it Parser          │
│  ├── markdown-it-anchor      │ ──▶ Header anchor links
│  ├── markdown-it-task-lists  │ ──▶ Checkbox rendering
│  ├── markdown-it-emoji       │ ──▶ Emoji shortcodes
│  └── highlight.js            │ ──▶ Code block syntax coloring
└──────────────┬───────────────┘
               │ HTML string
               ▼
┌──────────────────────────────┐
│  DOMPurify Sanitization      │
│  - Allowlisted tags/attrs    │
│  - Script injection blocked  │
└──────────────┬───────────────┘
               │ Safe HTML
               ▼
┌──────────────────────────────┐
│  Preview Pane (innerHTML)    │
└──────────────────────────────┘
```

The pipeline is debounced at 150ms after the last keystroke to prevent excessive re-renders during fast typing. At 5-10 keystrokes per second, this reduces preview renders from 10/s to approximately 3-4/s.

### 3. Persistence Layer

**Primary storage: IndexedDB** (via the `idb` wrapper library for Promise-based API)

Documents are stored as structured objects with UUID keys:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID string | Primary key |
| `title` | string | Auto-generated from first 5 words of content |
| `content` | string | Raw Markdown text |
| `createdAt` | Date | Document creation timestamp |
| `updatedAt` | Date | Last modification timestamp |

**Auto-save behavior:** After 2 seconds of idle time (no keystrokes), the current document is written to IndexedDB in a single atomic transaction. Multiple rapid saves within the debounce window are coalesced into one write.

**Fallback: localStorage** -- used if IndexedDB is unavailable (rare, < 0.5% of browsers). Limited to a single document due to the 5 MB storage cap.

### 4. Service Worker (PWA)

Workbox manages the service worker with three caching strategies:

| Strategy | Applied To | Behavior |
|----------|-----------|----------|
| Cache-first | App shell (HTML, CSS, JS), Monaco Editor, fonts | Serve from cache immediately, fast loads |
| Network-first | Any future API calls | Fetch fresh data, fall back to cache |
| Stale-while-revalidate | Non-critical assets | Serve cached version, update in background |

**Offline guarantee:** After the initial visit, the entire application is cached locally. All editing, saving, and document management works without network connectivity.

**Update handling:** When a new version is deployed, Workbox's `skipWaiting()` activates the new service worker immediately. A "New version available" toast prompts the user to refresh.

## Key Design Decisions

### 1. Client-Side Only Architecture

**Decision:** No backend server. The entire application runs in the browser.

This means documents never leave the user's device -- privacy by default. There is no server infrastructure to maintain, no authentication to implement, and no hosting cost beyond static file serving (GitHub Pages, free). The trade-off is no cross-device sync, no collaboration, and storage limited to the browser's IndexedDB quota (typically 50 MB+). For a personal Markdown editor, these limitations are acceptable. A future cloud sync feature could be layered on with an append-only operation log and CRDTs for conflict resolution.

### 2. Monaco Editor over CodeMirror

**Decision:** Use Monaco Editor for the editing experience.

Monaco provides VS Code-level editing with excellent Markdown language support, familiar keybindings, and a rich extension API. The trade-off is a ~2 MB bundle (vs ~400 KB for CodeMirror), higher memory usage, and a longer initial load. This is mitigated by lazy-loading Monaco and caching it aggressively in the service worker. For a developer-focused Markdown editor, the VS Code familiarity and feature set justify the size cost.

### 3. IndexedDB as Primary Storage

**Decision:** Use IndexedDB with the `idb` wrapper library, localStorage as fallback.

IndexedDB provides 50 MB+ of structured, async storage -- essential for managing multiple documents without blocking the UI thread. The `idb` library provides a cleaner Promise-based API over the raw IndexedDB callback interface. localStorage serves as a last-resort fallback (single document only) for the rare browsers where IndexedDB is unavailable. The trade-off is implementation complexity: IndexedDB transactions require careful error handling and the `idb` wrapper adds a small dependency.

### 4. DOMPurify for Security

**Decision:** Sanitize all HTML output before DOM insertion.

Markdown can contain raw HTML, including `<script>` tags and event handlers. DOMPurify runs an allowlist-based sanitization pass on the HTML output from markdown-it, blocking XSS vectors while preserving legitimate formatting tags. This is essential even for a local-only app, because users may paste content from untrusted sources.

## Database Schema

Since MDReader is client-side only, the "database" is IndexedDB. The schema is a single object store:

| Store | Key Path | Indexes | Purpose |
|-------|----------|---------|---------|
| `documents` | `id` (UUID) | `updatedAt` (for sorting) | All user documents |

Each document record contains `id`, `title`, `content`, `createdAt`, and `updatedAt`. No foreign keys or joins -- the data model is a flat collection of documents.

## Consistency and Idempotency

### Write Semantics

| Property | Behavior |
|----------|----------|
| **Consistency** | Strong local consistency -- single IndexedDB transaction per save |
| **Atomicity** | All-or-nothing per document; transaction rolls back on error |
| **Durability** | Committed immediately via `readwrite` transaction |
| **Isolation** | Read-your-writes guaranteed by single-threaded JS event loop |

### Auto-Save Pipeline

```
Keystroke ──▶ Debounce (2s) ──▶ Save Queue ──▶ IndexedDB Transaction
                                    │
                                    └── If pending save exists, coalesce (skip)
```

Multiple rapid saves are collapsed into one. The latest content always overwrites previous -- last-write-wins with no versioning.

### Idempotency

| Operation | Idempotency Key | Behavior |
|-----------|-----------------|----------|
| Create document | `id` (UUID v4) | Reject if ID exists |
| Update document | `id` + `updatedAt` | Compare timestamps, reject stale |
| Delete document | `id` | No-op if already deleted |
| Import file | Content hash (SHA-256) | Warn on duplicate content |

### Conflict Resolution

**Current (single-user):** No conflicts possible -- single writer per document.

**Future (multi-device sync):** Last-write-wins by timestamp (simple strategy). For divergent offline edits, a three-way merge or manual resolution UI would be needed. Vector clocks could detect true conflicts where neither version dominates.

### Edge Cases and Recovery

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Browser crash mid-save | `updatedAt` stale on reload | Prompt: restore from localStorage backup |
| IndexedDB quota exceeded | `QuotaExceededError` | Delete old documents, offer file export |
| Corrupted document | JSON parse failure | Fall back to raw string, manual recovery |
| Service worker conflict | Version mismatch | Force refresh, clear caches |

## Security Considerations

1. **HTML Sanitization:** DOMPurify with allowlisted tags/attributes on all preview output
2. **Content Security Policy:** Restrict inline script execution
3. **Raw HTML disabled:** markdown-it configured to escape HTML by default
4. **No remote resources:** External image and script loading blocked in preview

## Observability

### Performance Monitoring

The `web-vitals` library captures Core Web Vitals (FCP, LCP, CLS, TTFB) and logs them to the console in development. Custom performance marks track:

| Metric | Budget | Measurement |
|--------|--------|-------------|
| Keystroke response | < 16ms (p95) | Frame timing API |
| Preview render | < 80ms (p95) | `performance.mark()` around pipeline |
| Document save | < 50ms (p95) | IndexedDB transaction timing |
| Document load | < 200ms (p99) | Including parse and initial render |
| Cold start FCP | < 1.5s | Lighthouse |

### SLO Targets

| Operation | p50 | p95 | p99 |
|-----------|-----|-----|-----|
| Keystroke response | 8ms | 16ms | 32ms |
| Preview update | 30ms | 80ms | 150ms |
| Document save | 20ms | 50ms | 100ms |
| Document load | 100ms | 200ms | 500ms |
| App cold start | 1.0s | 1.5s | 3.0s |

### Availability Targets

| Scenario | Target |
|----------|--------|
| Offline mode | 100% (service worker caches entire shell) |
| Document recovery | 99.9% (auto-save + localStorage backup) |
| Cross-session persistence | 99.99% (IndexedDB survives restarts) |
| PWA installability | 100% (manifest + service worker always present) |

## Failure Handling

| Failure | Impact | Mitigation |
|---------|--------|------------|
| IndexedDB unavailable | Cannot persist documents | localStorage fallback (single document) |
| IndexedDB quota exceeded | Cannot save new content | Prompt user to delete old documents or export to file |
| Monaco fails to load | No editor | Show fallback `<textarea>` with basic editing |
| Service worker stale | User sees old version | `skipWaiting()` + "Update available" toast |
| Large document (> 100K lines) | Preview lag | Increase debounce to 300ms, consider virtual rendering |

## Scalability Considerations

### Storage Scaling

At 100 documents averaging 10 KB each, IndexedDB usage is ~1 MB -- well within quotas. The hard limit is the browser's IndexedDB quota (typically 50% of available disk space, minimum 50 MB). For users hitting storage limits:
- Document archival: export old documents to `.md` files
- Compression: gzip document content before storage (future enhancement)
- Selective sync: if cloud sync is added, sync only active documents

### Document Size Scaling

Monaco Editor handles documents up to ~100K lines efficiently via virtual scrolling. The bottleneck is the preview pipeline: markdown-it parsing time grows linearly with document size. For very large documents (> 500 KB), mitigation strategies include:
- Increase debounce interval to 300ms
- Parse only the visible portion of the document (viewport-aware rendering)
- Cache the parsed AST and incrementally update changed sections

### Multi-Tab Handling

Currently, each browser tab operates independently. If two tabs edit the same document, the last save wins. A future improvement would use the BroadcastChannel API to synchronize state across tabs and prevent overwrite conflicts.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Architecture | Client-side only | Client + API server | Privacy by default, zero hosting cost, full offline support |
| Editor | Monaco Editor | CodeMirror | VS Code familiarity, richer features; accepts ~2 MB bundle cost |
| Storage | IndexedDB (idb) | localStorage | Structured async storage, 50 MB+ quota, multi-document support |
| Markdown parser | markdown-it | remark | Faster parsing, smaller bundle, rich plugin ecosystem |
| State management | Zustand | React Context | No provider nesting, built-in persistence middleware |
| Sanitization | DOMPurify | Allowlist in markdown-it | Defense in depth; DOMPurify handles edge cases markdown-it misses |
| PWA caching | Workbox | Custom service worker | Declarative caching strategies, automatic precaching |

## Implementation Notes

This project is a **design-only entry** in this repository. The implementation lives in an external repository:

**External Repository:** [github.com/evgenyvinnik/mdreader](https://github.com/evgenyvinnik/mdreader)

### What the External Implementation Covers

Based on the architecture document and the project's CLAUDE.md, the external repository implements:

- **Monaco Editor integration** with React wrapper, including resize handling, syntax highlighting, and light/dark theming
- **Markdown processing pipeline:** markdown-it with anchor, task-list, and emoji plugins, plus highlight.js for code blocks, sanitized through DOMPurify
- **IndexedDB persistence** via the `idb` library with auto-save (2s debounce), multi-document management, and auto-generated titles
- **PWA features:** Workbox service worker with cache-first strategy for app shell, offline support, and install prompt handling
- **Synchronized scrolling** between editor and preview panes using proportional scroll mapping
- **Multiple view modes:** Editor only, preview only, split view
- **Zustand state management** with persistence middleware

### What Is Simplified or Substituted

- **No cloud sync:** Documents exist only in the browser's IndexedDB; no cross-device access
- **No collaboration:** Single-user, single-device editing only
- **No incremental parsing:** Full markdown-it parse on every preview update (debounced); AST caching for changed sections is a future optimization
- **Console-based monitoring:** Performance metrics logged to console, no external observability backend

### What Is Omitted

- Server-side infrastructure (API, database, authentication)
- Cross-device document synchronization
- Collaborative editing (WebRTC/CRDT)
- Vector clocks and conflict resolution for multi-device scenarios
- Export to PDF/HTML
- Vim/Emacs keybindings
- Markdown linting
