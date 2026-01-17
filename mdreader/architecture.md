# MD Reader - Architecture Design

## System Overview

A Progressive Web App (PWA) for editing and previewing Markdown in the browser, featuring offline support, persistent local storage, and real-time rendering.

## Requirements

### Functional Requirements

- Markdown editing with syntax highlighting
- Live preview with GitHub Flavored Markdown support
- Document persistence across sessions
- Multiple view modes (editor, preview, split)
- Theme support (light/dark)
- File import/export

### Non-Functional Requirements

- **Offline Support:** Full functionality without internet connection
- **Performance:** Real-time preview without lag
- **Security:** Safe rendering of user-provided markdown
- **Persistence:** Documents survive browser restarts and updates

## High-Level Architecture

### Component Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Application Shell                         │
├──────────────────────────┬──────────────────────────────────────┤
│                          │                                       │
│  ┌────────────────────┐  │  ┌────────────────────────────────┐  │
│  │      Toolbar       │  │  │          View Container        │  │
│  │  ┌──────────────┐  │  │  │  ┌────────────┬─────────────┐  │  │
│  │  │ New/Open/Save│  │  │  │  │   Editor   │   Preview   │  │  │
│  │  │ Theme Toggle │  │  │  │  │  (Monaco)  │ (markdown-  │  │  │
│  │  │ View Mode    │  │  │  │  │            │    it)      │  │  │
│  │  │ Scroll Lock  │  │  │  │  └────────────┴─────────────┘  │  │
│  │  └──────────────┘  │  │  │                                │  │
│  └────────────────────┘  │  └────────────────────────────────┘  │
│                          │                                       │
├──────────────────────────┴──────────────────────────────────────┤
│                      Document Selector                           │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Dropdown with search, delete, and document list           │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ User Input   │────▶│  Monaco Editor   │────▶│ Markdown Parser │
│ (Keystrokes) │     │ (State Update)   │     │ (markdown-it)   │
└──────────────┘     └────────┬─────────┘     └────────┬────────┘
                              │                        │
                              ▼                        ▼
                     ┌──────────────────┐     ┌─────────────────┐
                     │   Zustand Store  │     │   DOMPurify     │
                     │ (Document State) │     │ (Sanitization)  │
                     └────────┬─────────┘     └────────┬────────┘
                              │                        │
                              ▼                        ▼
                     ┌──────────────────┐     ┌─────────────────┐
                     │   IndexedDB      │     │  Preview Pane   │
                     │  (Persistence)   │     │  (HTML Render)  │
                     └──────────────────┘     └─────────────────┘
```

## Core Components

### 1. Monaco Editor Integration

The editor component wraps Microsoft's Monaco Editor (the same editor used in VS Code):

- **Syntax Highlighting:** Built-in Markdown language support
- **Features:** Line numbers, word wrap, code folding, minimap
- **Theming:** Light and dark themes matching VS Code
- **Performance:** Virtual scrolling for large documents

### 2. Markdown Processing Pipeline

```
Raw Markdown → markdown-it parser → HTML AST → DOMPurify → Safe HTML → DOM
                     │
                     ├── markdown-it-anchor (header links)
                     ├── markdown-it-task-lists (checkboxes)
                     ├── markdown-it-emoji (shortcodes)
                     └── highlight.js (code blocks)
```

### 3. Persistence Layer

**Primary Storage: IndexedDB**
- Stores documents as structured objects
- Supports multiple documents
- Auto-generated titles from content

**Fallback: localStorage**
- Used if IndexedDB unavailable
- Single document limit

**Schema:**
```javascript
{
  id: string,           // UUID
  title: string,        // First 5 words of content
  content: string,      // Raw markdown
  createdAt: Date,
  updatedAt: Date
}
```

### 4. Service Worker (PWA)

**Caching Strategy:**
- **App Shell:** Cache-first for static assets (HTML, CSS, JS)
- **Fonts/Icons:** Cache-first with background update
- **Runtime:** Network-first for API calls (if any)

**Offline Capabilities:**
- Full app functionality without network
- Document editing and saving
- Theme and preference persistence

## Key Design Decisions

### 1. Client-Side Only Architecture

**Decision:** No backend server required.

**Rationale:**
- Privacy: Documents never leave the user's device
- Simplicity: No server infrastructure to maintain
- Offline: Works completely offline
- Cost: Free hosting via GitHub Pages

**Trade-offs:**
- No cross-device sync
- No collaboration features
- Storage limited to browser quota

### 2. IndexedDB for Document Storage

**Decision:** Use IndexedDB with idb wrapper library.

**Rationale:**
- Large storage quota (typically 50MB+)
- Structured data support
- Async API (doesn't block UI)
- Better than localStorage for multiple documents

**Trade-offs:**
- More complex than localStorage
- Browser support varies slightly
- Need fallback strategy

### 3. Monaco Editor over CodeMirror

**Decision:** Use Monaco Editor for the editing experience.

**Rationale:**
- Familiar VS Code experience
- Excellent TypeScript support
- Rich Markdown language features
- Well-maintained by Microsoft

**Trade-offs:**
- Larger bundle size (~2MB)
- More memory usage
- Longer initial load

### 4. DOMPurify for Security

**Decision:** Sanitize all HTML output before rendering.

**Rationale:**
- Markdown can contain raw HTML
- Prevents XSS attacks
- Configurable allowlist

**Implementation:**
```javascript
const clean = DOMPurify.sanitize(html, {
  ALLOWED_TAGS: ['h1', 'h2', ...],
  ALLOWED_ATTR: ['href', 'class', ...]
});
```

## Technology Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| UI Framework | React 19 | Component architecture |
| Type Safety | TypeScript (strict) | Compile-time checks |
| Build Tool | Vite + Rolldown | Fast builds, HMR |
| Editor | Monaco Editor | Code editing |
| Markdown | markdown-it | Parsing and rendering |
| Highlighting | highlight.js | Code block syntax |
| Security | DOMPurify | HTML sanitization |
| Storage | IndexedDB (idb) | Document persistence |
| PWA | Workbox | Service worker, caching |
| Styling | CSS Modules | Scoped styles |

## Performance Considerations

### Rendering Pipeline Optimization

1. **Debounced Preview:** Wait 150ms after typing stops before re-rendering
2. **Virtual Scrolling:** Monaco handles large documents efficiently
3. **Incremental Parsing:** Only re-parse changed sections (future optimization)

### Bundle Size Optimization

- Monaco Editor: Loaded lazily
- highlight.js: Only include needed languages
- Tree-shaking: Remove unused code

### Memory Management

- Document autosave batching
- Preview HTML cleanup on unmount
- Editor instance reuse

## Security Considerations

1. **Content Security Policy:** Restrict script execution
2. **HTML Sanitization:** DOMPurify on all user content
3. **Raw HTML Disabled:** markdown-it configured to escape HTML
4. **No Remote Resources:** No external image/script loading by default

## Capacity Planning and Traffic Model

Since MDReader is a client-side PWA, "traffic" refers to local operations within the browser rather than server requests. This section quantifies expected usage patterns to size local storage, cache strategies, and processing budgets.

### Usage Model (Local Development Context)

| Metric | Target Value | Rationale |
|--------|--------------|-----------|
| **Active Documents** | 50-100 documents | Typical user working set |
| **Document Size** | Avg: 10 KB, Max: 500 KB | ~2,000 words avg, large docs up to 100K words |
| **Typing Rate** | 5-10 keystrokes/sec peak | Fast typist during active editing |
| **Preview Renders** | 6-10 per second (raw) | Before debouncing |
| **Auto-save Operations** | 1 per 2 seconds max | After 2s idle, batched |
| **Session Duration** | 30-120 minutes | Typical writing session |

### Storage Sizing

Based on the usage model:

| Storage Layer | Capacity Budget | Calculation |
|---------------|-----------------|-------------|
| **IndexedDB Total** | 50 MB | 100 docs x 500 KB max = 50 MB worst case |
| **Active Document Cache** | 2 MB | Current doc + 3 recent docs in memory |
| **Service Worker Cache** | 10 MB | App shell + Monaco Editor + fonts |
| **localStorage Fallback** | 5 MB | Browser limit, single doc only |

### Processing Budgets

| Operation | Budget | Target |
|-----------|--------|--------|
| **Keystroke to Editor State** | < 16ms | 60 FPS frame budget |
| **Markdown Parse + Render** | < 50ms | Debounced, 20 FPS feels smooth |
| **IndexedDB Write** | < 100ms | Background, non-blocking |
| **Document Load** | < 200ms | Including parse and initial render |

### Throughput Limits

For future cloud sync or collaboration features:

| Operation | Local Rate | Sync Rate (Future) |
|-----------|------------|-------------------|
| **Document Saves** | 30 per minute max | 1 per 5 seconds to server |
| **Payload Size** | Up to 500 KB | Compressed diff only |
| **Concurrent Documents** | 10 open tabs | 1 active sync per tab |

---

## SLO/SLA Targets and Error Budgets

While MDReader runs entirely client-side, defining performance and reliability targets helps guide implementation decisions.

### Latency Targets

| Operation | p50 | p95 | p99 | Error Budget |
|-----------|-----|-----|-----|--------------|
| **Keystroke Response** | 8ms | 16ms | 32ms | 0.1% frames dropped |
| **Preview Update** | 30ms | 80ms | 150ms | 1% delayed renders OK |
| **Document Save** | 20ms | 50ms | 100ms | 0.1% save failures |
| **Document Load** | 100ms | 200ms | 500ms | 0% data loss |
| **App Cold Start** | 1.0s | 1.5s | 3.0s | First Contentful Paint |
| **Service Worker Install** | 2s | 5s | 10s | Background, non-blocking |

### Availability Targets

| Scenario | Target | Implementation |
|----------|--------|----------------|
| **Offline Mode** | 100% | Service worker caches entire app shell |
| **Document Recovery** | 99.9% | Auto-save every 2s, localStorage backup |
| **Cross-Session Persistence** | 99.99% | IndexedDB survives browser restarts |
| **PWA Installability** | 100% | Manifest + service worker always present |

### Error Budget Allocation

Monthly error budget breakdown (for future monitoring):

| Category | Budget | Trigger Action |
|----------|--------|----------------|
| **Render Failures** | 1% of sessions | Add fallback markdown renderer |
| **Storage Quota Exceeded** | 0.1% of users | Implement document archival/export |
| **Service Worker Stale** | 5% of loads | Skip waiting + update toast |
| **IndexedDB Unavailable** | 0.5% of browsers | localStorage fallback active |

### How SLOs Drive Design Choices

| Target | Design Decision |
|--------|-----------------|
| p95 keystroke < 16ms | Use Monaco's built-in debouncing, avoid synchronous operations |
| p99 preview < 150ms | Debounce preview to 150ms, cache parsed AST for unchanged sections |
| 0% document loss | Dual-write to IndexedDB + localStorage for critical saves |
| 100% offline | Cache-first strategy for all app assets in service worker |
| < 3s cold start | Lazy-load Monaco Editor, inline critical CSS |

---

## Consistency and Idempotency Semantics

MDReader uses local-first storage, but consistency semantics matter for reliability, future sync features, and handling edge cases.

### Write Semantics

#### Document Saves (IndexedDB)

| Property | Behavior | Implementation |
|----------|----------|----------------|
| **Consistency** | Strong local consistency | Single IndexedDB transaction per save |
| **Atomicity** | All-or-nothing per document | Transaction rollback on error |
| **Durability** | Persisted immediately | `readwrite` transaction commits sync |
| **Isolation** | Read-your-writes | Single-threaded JS event loop |

#### Auto-Save Behavior

```
Keystroke → Debounce (2s) → Save Queue → IndexedDB Transaction
                              │
                              └── If pending save exists, skip (coalesce)
```

- **Coalescing:** Multiple rapid saves are collapsed into one
- **Last-Write-Wins:** Latest content always overwrites previous
- **No Versioning:** No history preserved (future enhancement)

### Idempotency Handling

| Operation | Idempotency Key | Behavior |
|-----------|-----------------|----------|
| **Create Document** | `id` (UUID v4) | Reject if ID exists, client generates |
| **Update Document** | `id` + `updatedAt` | Compare timestamps, reject stale writes |
| **Delete Document** | `id` | No-op if already deleted |
| **Import File** | Content hash (SHA-256) | Warn on duplicate content |

#### Replay Handling

For future sync scenarios:

```typescript
interface SyncOperation {
  operationId: string;    // UUID for deduplication
  documentId: string;
  operation: 'create' | 'update' | 'delete';
  timestamp: number;      // Client clock
  vectorClock?: number;   // For conflict detection
  payload: string;        // Compressed content or diff
}
```

- **At-Least-Once Delivery:** Operations may replay; use `operationId` for dedup
- **Operation Log:** Future: maintain append-only log for sync replay

### Conflict Resolution

Current (single-user):
- No conflicts possible - single writer per document

Future (multi-device sync):

| Conflict Type | Resolution Strategy |
|---------------|---------------------|
| **Concurrent Edits** | Last-Write-Wins by timestamp (simple) |
| **Create-Create** | Merge with suffix: "Document (2)" |
| **Update-Delete** | Resurrection: update wins, deleted flag cleared |
| **Offline Divergence** | Three-way merge or manual resolution UI |

#### Conflict Detection

```typescript
// Vector clock for future multi-device sync
interface DocumentVersion {
  deviceId: string;
  counter: number;
}

// Conflict exists if neither version dominates
function hasConflict(local: DocumentVersion[], remote: DocumentVersion[]): boolean {
  const localDominates = local.every((l, i) => l.counter >= (remote[i]?.counter ?? 0));
  const remoteDominates = remote.every((r, i) => r.counter >= (local[i]?.counter ?? 0));
  return !localDominates && !remoteDominates;
}
```

### Transaction Semantics

| Layer | Transaction Model | Failure Handling |
|-------|-------------------|------------------|
| **IndexedDB** | ACID per transaction | Auto-rollback, retry once, then error toast |
| **localStorage** | Synchronous, atomic per key | Try-catch, fallback to memory-only |
| **In-Memory (Zustand)** | Immediate, no rollback | Re-sync from IndexedDB on error |

### Data Integrity Guarantees

| Guarantee | Implementation |
|-----------|----------------|
| **No Partial Writes** | Complete document saved or nothing |
| **Read-Your-Writes** | Zustand updated before IndexedDB write returns |
| **Monotonic Reads** | Always read from Zustand (single source of truth) |
| **Session Consistency** | Document state survives page refresh |

### Edge Cases and Recovery

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| **Browser Crash Mid-Save** | `updatedAt` stale on reload | Prompt: restore from localStorage backup |
| **IndexedDB Quota Exceeded** | `QuotaExceededError` caught | Delete old docs, export to file |
| **Corrupted Document** | JSON parse fails | Fallback to raw string, manual recovery |
| **Service Worker Conflict** | Version mismatch | Force refresh, clear caches |

---

## Future Optimizations

- [ ] Multi-document tabs
- [ ] Collaborative editing (WebRTC)
- [ ] Cloud sync (optional)
- [ ] Custom themes
- [ ] Vim/Emacs keybindings
- [ ] Export to PDF/HTML
- [ ] Markdown linting
