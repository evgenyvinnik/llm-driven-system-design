# Design Spotlight - Universal Search

## Codebase Stats

| Metric | Value |
|--------|-------|
| Total SLOC | 3,767 |
| Source Files | 37 |
| .js | 1,356 |
| .md | 1,214 |
| .tsx | 592 |
| .ts | 340 |
| .json | 88 |

## Overview

A simplified Spotlight-like platform demonstrating local and cloud search, indexing, and intelligent suggestions. This educational project focuses on building a universal search system across files, apps, contacts, and web content.

## Key Features

### 1. Multi-Source Search
- Search across files, applications, contacts, and web bookmarks
- Fast prefix matching with Elasticsearch edge n-gram analyzer
- Ranking by recency and usage frequency

### 2. Special Queries
- Math calculations (e.g., `2+2*3`, `sqrt(16)`)
- Unit conversions (e.g., `100 km to miles`, `32 f to c`)
- Web search fallback for unmatched queries

### 3. Siri Suggestions
- Time-based app suggestions
- Recently accessed items
- Frequently contacted people
- Pattern learning from usage

### 4. Modern UI
- macOS Spotlight-inspired design
- Keyboard navigation (arrows, Enter, Escape)
- Cmd+K shortcut to open
- Dark theme with blur effects

## Tech Stack

- **Frontend:** TypeScript, Vite, React 19, Zustand, Tailwind CSS
- **Backend:** Node.js, Express
- **Search:** Elasticsearch 8.11
- **Database:** PostgreSQL 16
- **Containerization:** Docker Compose

## Quick Start

### Prerequisites

- Node.js 18+
- Docker and Docker Compose
- npm or yarn

### 1. Start Infrastructure

```bash
cd spotlight

# Start PostgreSQL and Elasticsearch
docker-compose up -d

# Wait for services to be healthy (about 30 seconds)
docker-compose ps
```

### 2. Start Backend

```bash
cd backend

# Install dependencies
npm install

# Start the server
npm run dev
```

The backend runs on http://localhost:3001

### 3. Seed Sample Data

In a new terminal:

```bash
cd spotlight/backend

# Seed sample files, apps, contacts, and web items
npm run seed
```

### 4. Start Frontend

```bash
cd spotlight/frontend

# Install dependencies
npm install

# Start development server
npm run dev
```

The frontend runs on http://localhost:5173

### 5. Open Spotlight

- Visit http://localhost:5173
- Press `Cmd+K` (or `Ctrl+K` on Windows/Linux) to open Spotlight
- Or click the search button on the page

## Usage

### Search Examples

| Query | Result |
|-------|--------|
| `Safari` | Find Safari app |
| `meeting notes` | Find files with "meeting notes" |
| `alice` | Find contact named Alice |
| `github` | Find GitHub bookmark |
| `2+2*3` | Calculate: 8 |
| `100 km to miles` | Convert: 62.137 miles |
| `32 f to c` | Convert: 0 C |

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+K` | Open/close Spotlight |
| `Escape` | Close Spotlight |
| `Arrow Up/Down` | Navigate results |
| `Enter` | Execute selected result |

## API Endpoints

### Search

```
GET /api/search?q=query
GET /api/search?q=query&types=files,apps
GET /api/search/suggest?q=prefix
```

### Indexing

```
POST /api/index/files
POST /api/index/apps
POST /api/index/contacts
POST /api/index/web
POST /api/index/bulk/files
```

### Suggestions

```
GET /api/suggestions
POST /api/suggestions/app-launch
POST /api/suggestions/activity
```

### Health Check

```
GET /health
```

## Project Structure

```
spotlight/
├── docker-compose.yml     # PostgreSQL and Elasticsearch
├── backend/
│   ├── package.json
│   ├── init.sql          # Database schema
│   └── src/
│       ├── index.js      # Express server
│       ├── seed.js       # Sample data seeder
│       ├── routes/
│       │   ├── search.js
│       │   ├── index.js
│       │   └── suggestions.js
│       └── services/
│           ├── elasticsearch.js
│           ├── queryParser.js
│           └── suggestions.js
└── frontend/
    ├── package.json
    └── src/
        ├── App.tsx
        ├── main.tsx
        ├── index.css
        ├── components/
        │   ├── SpotlightModal.tsx
        │   ├── SearchInput.tsx
        │   ├── SearchResults.tsx
        │   ├── SearchResultItem.tsx
        │   ├── Suggestions.tsx
        │   └── Icons.tsx
        ├── stores/
        │   └── spotlightStore.ts
        ├── services/
        │   └── api.ts
        ├── hooks/
        │   ├── useKeyboardShortcut.ts
        │   └── useDebounce.ts
        └── types/
            └── search.ts
```

## Running Multiple Backend Instances

For testing load balancing:

```bash
# Terminal 1
npm run dev:server1  # Port 3001

# Terminal 2
npm run dev:server2  # Port 3002

# Terminal 3
npm run dev:server3  # Port 3003
```

## Environment Variables

### Backend

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |
| `PG_HOST` | localhost | PostgreSQL host |
| `PG_PORT` | 5432 | PostgreSQL port |
| `PG_DATABASE` | spotlight | Database name |
| `PG_USER` | spotlight | Database user |
| `PG_PASSWORD` | spotlight_password | Database password |
| `ES_URL` | http://localhost:9200 | Elasticsearch URL |

## Implementation Status

- [x] Docker Compose setup (PostgreSQL, Elasticsearch)
- [x] Backend API with Express
- [x] Elasticsearch indexing with prefix matching
- [x] Multi-source search (files, apps, contacts, web)
- [x] Math calculations and unit conversions
- [x] Siri-style suggestions
- [x] Frontend with React + Tailwind
- [x] Keyboard navigation
- [x] Sample data seeding
- [ ] File system watcher for real indexing
- [ ] Content extraction (PDF, DOCX, etc.)
- [ ] Natural language date parsing
- [ ] Cloud integration

## Key Technical Challenges

1. **Fast Prefix Matching**: Elasticsearch edge n-gram tokenizer for instant results
2. **Multi-Source Ranking**: Combine scores from different index types
3. **Usage Pattern Learning**: PostgreSQL aggregations for time-based suggestions
4. **Real-time Updates**: Designed for incremental indexing (watcher not implemented)

## Architecture

See [architecture.md](./architecture.md) for detailed system design documentation.

## Development Notes

See [claude.md](./claude.md) for development insights and design decisions.

## References & Inspiration

- [Core Spotlight Documentation](https://developer.apple.com/documentation/corespotlight) - Apple's framework for indexing app content
- [NSUserActivity Documentation](https://developer.apple.com/documentation/foundation/nsuseractivity) - Making app content searchable
- [Elasticsearch Documentation](https://www.elastic.co/guide/en/elasticsearch/reference/current/index.html) - Distributed search engine for full-text search
- [Apache Lucene](https://lucene.apache.org/) - Core search library powering many search engines
- [SQLite FTS5 Extension](https://www.sqlite.org/fts5.html) - Full-text search for SQLite databases
- [Apache Tika](https://tika.apache.org/) - Content extraction toolkit for diverse file formats
- [Algolia Documentation](https://www.algolia.com/doc/) - Search-as-a-service patterns and ranking algorithms
- [Building a Search Engine from Scratch](https://www.alexmolas.com/2024/02/05/a-search-engine-in-80-lines.html) - Educational search implementation
