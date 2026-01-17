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

## Future Optimizations

- [ ] Multi-document tabs
- [ ] Collaborative editing (WebRTC)
- [ ] Cloud sync (optional)
- [ ] Custom themes
- [ ] Vim/Emacs keybindings
- [ ] Export to PDF/HTML
- [ ] Markdown linting
