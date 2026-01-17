# MD Reader - System Design Interview Answer

## Introduction (2 minutes)

"Today I'll design MD Reader, a Progressive Web App for editing and previewing Markdown. This is an interesting problem because it combines:

1. Real-time text processing with live preview
2. Offline-first architecture for PWA capabilities
3. Client-side persistence without a backend
4. Security considerations for rendering user-provided content

Let me start by clarifying the requirements."

---

## Requirements Clarification (3 minutes)

### Functional Requirements

"For the core product:

1. **Editing**: Full-featured Markdown editor with syntax highlighting
2. **Live Preview**: Real-time rendering as the user types
3. **Persistence**: Documents saved locally across sessions
4. **Document Management**: Create, switch, delete documents
5. **Offline Support**: Full functionality without internet

I'll focus on the editor-preview pipeline and the persistence architecture."

### Non-Functional Requirements

"For a good user experience:

- **Latency**: Preview updates under 50ms from keystroke
- **Reliability**: Zero data loss - documents must survive browser restarts
- **Offline**: Works 100% without network connection
- **Security**: Safe rendering of user Markdown (XSS prevention)

The offline and persistence requirements make this primarily a client-side architecture problem."

---

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────┐
│                      Browser (PWA Container)                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   Application Shell                      │   │
│   ├──────────────────────┬──────────────────────────────────┤   │
│   │                      │                                   │   │
│   │   ┌──────────────┐   │   ┌────────────────────────────┐ │   │
│   │   │   Monaco     │   │   │       Markdown Preview     │ │   │
│   │   │   Editor     │───┼──▶│       (markdown-it)        │ │   │
│   │   │              │   │   │                            │ │   │
│   │   └──────────────┘   │   └────────────────────────────┘ │   │
│   │                      │                                   │   │
│   └──────────────────────┴──────────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    State (Zustand)                       │   │
│   └─────────────────────────────────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │               IndexedDB (Persistence)                    │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│              Service Worker (Workbox - Offline Support)          │
└─────────────────────────────────────────────────────────────────┘
```

"The architecture is entirely client-side:

**Monaco Editor**: VS Code's editor component for the writing experience
**Markdown Preview**: Real-time rendering using markdown-it
**Zustand**: Lightweight state management
**IndexedDB**: Persistent local storage for documents
**Service Worker**: Caches the app shell for offline access"

---

## Deep Dive: Real-time Preview Pipeline (8 minutes)

### Processing Flow

"When the user types:

```
Keystroke → Debounce (150ms) → markdown-it Parse → DOMPurify Sanitize → DOM Update
```

The key insight is debouncing - we don't re-render on every keystroke, but wait for a pause in typing."

### Why Debounce?

"Consider a user typing 'Hello World':
- Without debounce: 11 parse operations (one per character)
- With 150ms debounce: 1 parse operation (after typing stops)

This is critical for large documents where parsing could take 10-50ms."

### Implementation

```javascript
const [content, setContent] = useState('')
const [preview, setPreview] = useState('')

// Debounced preview update
useEffect(() => {
  const timer = setTimeout(() => {
    const html = markdownIt.render(content)
    const safe = DOMPurify.sanitize(html)
    setPreview(safe)
  }, 150)
  
  return () => clearTimeout(timer)
}, [content])
```

### Security: Why DOMPurify?

"Markdown can contain raw HTML. Without sanitization:

```markdown
Check this out: <script>stealCredentials()</script>
```

Would execute JavaScript. DOMPurify removes dangerous elements while preserving safe formatting."

---

## Deep Dive: Persistence Layer (8 minutes)

### Why IndexedDB over localStorage?

| Feature | localStorage | IndexedDB |
|---------|-------------|-----------|
| Capacity | ~5MB | ~50MB+ |
| API | Synchronous (blocks UI) | Async (non-blocking) |
| Data types | Strings only | Structured data |
| Querying | Key-value only | Indexed queries |

"For a Markdown editor with multiple documents, IndexedDB is the clear choice."

### Document Schema

```typescript
interface Document {
  id: string           // UUID
  title: string        // First 5 words of content
  content: string      // Raw markdown
  createdAt: number    // Timestamp
  updatedAt: number    // Timestamp
}
```

### Auto-Save Strategy

"Documents auto-save as the user types:

```javascript
// Debounced save (500ms - longer than preview update)
useEffect(() => {
  const timer = setTimeout(async () => {
    await db.put('documents', {
      ...currentDoc,
      content,
      updatedAt: Date.now()
    })
  }, 500)
  
  return () => clearTimeout(timer)
}, [content])
```

Note the 500ms debounce - longer than preview - because database writes are more expensive than DOM updates."

### Handling Storage Quotas

"IndexedDB has limits. We handle this gracefully:

```javascript
async function saveDocument(doc) {
  try {
    await db.put('documents', doc)
  } catch (error) {
    if (error.name === 'QuotaExceededError') {
      // Show warning to user
      // Optionally: offer to delete old documents
      notifyUser('Storage full. Consider exporting or deleting old documents.')
    }
  }
}
```"

---

## Deep Dive: PWA & Offline Support (5 minutes)

### Service Worker Caching Strategy

"We use Workbox for service worker management:

```javascript
// Cache the app shell
workbox.precaching.precacheAndRoute([
  { url: '/index.html', revision: '1234' },
  { url: '/app.js', revision: '5678' },
  { url: '/styles.css', revision: '9abc' }
])

// Runtime caching for fonts
workbox.routing.registerRoute(
  /fonts\.googleapis\.com/,
  new workbox.strategies.StaleWhileRevalidate()
)
```"

### Caching Strategies Used

| Resource | Strategy | Rationale |
|----------|----------|-----------|
| App Shell (HTML, CSS, JS) | Precache | Always available offline |
| Fonts | Stale-While-Revalidate | Fast load, background refresh |
| Static assets | Cache-First | Never change once deployed |

### Installability

"PWA requirements we meet:
- HTTPS (GitHub Pages provides this)
- Service Worker with fetch handler
- Web App Manifest with icons
- Lighthouse PWA score: 100

Users see 'Install' prompt on mobile Chrome and desktop."

---

## Deep Dive: Monaco Editor Integration (3 minutes)

### Why Monaco?

"Monaco is VS Code's editor. Benefits:
- Familiar experience for developers
- Excellent Markdown syntax highlighting
- Built-in features: find/replace, keyboard shortcuts, code folding

Trade-off: Bundle size is ~2MB, but acceptable for a rich editor experience."

### Configuration

```javascript
const editorOptions = {
  language: 'markdown',
  wordWrap: 'on',
  lineNumbers: 'on',
  minimap: { enabled: false },
  fontSize: 14,
  theme: isDarkMode ? 'vs-dark' : 'vs'
}
```

### Handling Large Documents

"Monaco uses virtual scrolling - only visible lines are rendered. This means:
- 10,000 line document performs same as 100 lines
- Memory usage stays constant regardless of document size"

---

## Trade-offs and Decisions (3 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Editor | Monaco | CodeMirror | VS Code familiarity, TypeScript support |
| Parser | markdown-it | remark | Faster, smaller, GFM support |
| State | Zustand | Redux/Context | Lightweight, simple API |
| Storage | IndexedDB | localStorage | Capacity, async, structured |
| Sanitizer | DOMPurify | Allowlist | Industry standard, well-maintained |

### What I'd Add With More Time

1. **Multi-tab editing**: Switch between open documents like tabs
2. **Cloud sync**: Optional sync to Google Drive or Dropbox
3. **Collaborative editing**: WebRTC or Yjs for real-time collaboration
4. **Export options**: PDF, HTML, DOCX export

---

## Summary

"To summarize, I've designed MD Reader with:

1. **Monaco Editor** for a professional editing experience
2. **Debounced preview pipeline** with markdown-it and DOMPurify
3. **IndexedDB persistence** for large document storage
4. **PWA architecture** with Workbox for offline support
5. **No backend required** - everything runs in the browser

The key insight is that a rich document editor can be entirely client-side when you leverage modern browser APIs like IndexedDB and Service Workers.

What aspects would you like to explore further?"
