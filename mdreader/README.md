# MD Reader - Markdown PWA

A Progressive Web App (PWA) for editing and previewing Markdown in your browser with offline support and persistent storage.

**Live Demo:** [evgenyvinnik.github.io/mdreader](https://evgenyvinnik.github.io/mdreader/)

**Source Code:** [github.com/evgenyvinnik/mdreader](https://github.com/evgenyvinnik/mdreader)

## Features

- **Monaco Editor** - VS Code's powerful editor with full Markdown syntax highlighting
- **Live Preview** - Real-time Markdown rendering as you type
- **GitHub Flavored Markdown** - Full support for tables, task lists, code fences, and more
- **Syntax Highlighting** - Code blocks with language-specific highlighting via highlight.js
- **PWA Capabilities** - Offline support, installable as standalone app
- **Persistent Storage** - Documents saved to IndexedDB with auto-save
- **Theme Support** - Light/dark mode toggle
- **View Modes** - Editor only, split view, or preview only

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (PWA Container)                   │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐     ┌─────────────────────────┐    │
│  │   Monaco Editor     │     │    Markdown Preview     │    │
│  │   (React 19)        │────▶│    (markdown-it)        │    │
│  └─────────────────────┘     └─────────────────────────┘    │
│               │                          │                   │
│               ▼                          ▼                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              State Management (Zustand)              │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                   │
│                          ▼                                   │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           IndexedDB (Document Persistence)           │    │
│  └─────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│           Service Worker (Workbox - Offline Support)         │
└─────────────────────────────────────────────────────────────┘
```

See [architecture.md](./architecture.md) for detailed design documentation.

## Tech Stack

- **Framework:** React 19 + TypeScript (strict mode)
- **Build:** Vite with Rolldown bundler
- **Editor:** Monaco Editor (VS Code's editor component)
- **Markdown Parser:** markdown-it with plugins (anchor, task-lists, emoji)
- **Syntax Highlighting:** highlight.js
- **Security:** DOMPurify for HTML sanitization
- **Storage:** IndexedDB (via idb library)
- **PWA:** Workbox for service worker and offline support

## System Design Concepts Demonstrated

This project demonstrates several system design concepts:

1. **Offline-First Architecture** - Service workers and caching strategies
2. **Local Persistence** - IndexedDB for client-side document storage
3. **Real-time Preview** - Efficient markdown parsing and rendering pipeline
4. **Progressive Web Apps** - Installability, offline support, and native-like experience
5. **Security** - HTML sanitization to prevent XSS attacks

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview

# Run linting
npm run lint
```

## Notes

This is an external project. The full source code and implementation details are available in the [MDReader repository](https://github.com/evgenyvinnik/mdreader).
