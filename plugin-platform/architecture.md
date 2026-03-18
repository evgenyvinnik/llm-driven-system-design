# Pluggable Text Editor - Architecture

## System Overview

A minimalist text editor where **everything is a plugin**. The core application provides only a plugin host and slot system -- even the text input area itself is provided by a plugin. This extreme modularity demonstrates plugin architecture patterns: slot-based UI composition, event-driven inter-plugin communication, shared state management, and a marketplace for plugin distribution.

The system consists of three parts:
1. **Frontend**: React-based plugin host with slot system and marketplace UI
2. **Backend**: Marketplace API for plugin distribution, versioning, and user management
3. **Standalone Plugins**: Independent projects built by different developers, published to the marketplace

**Learning Goals:**
- Design a plugin slot/contribution system where the host has zero built-in features
- Build loosely-coupled plugin communication via events and shared state
- Implement plugin lifecycle management (load, activate, deactivate)
- Create a marketplace for plugin discovery, installation, and publishing
- Handle both authenticated and anonymous users with session migration

## Requirements

### Functional Requirements

1. **Plugin Loading**: Dynamically load plugins at runtime from bundled sources or marketplace
2. **Slot System**: Plugins register UI components to named layout slots (toolbar, canvas, sidebar, statusbar, modal)
3. **Event Bus**: Plugins communicate via publish/subscribe events without direct dependencies
4. **State Sharing**: Plugins can read/write shared editor state with reactive subscriptions
5. **Plugin Marketplace**: Browse, search, and install plugins by category
6. **User Authentication**: Session-based auth supporting both authenticated and anonymous users
7. **Plugin Publishing**: Developers can publish plugins with versioning, changelogs, and bundle uploads

### Non-Functional Requirements (Production Scale)

- **Plugin isolation**: A failing plugin must not crash the host application or other plugins
- **Load performance**: Lazy-load plugins on demand; initial page load under 2 seconds with 20+ installed plugins
- **Marketplace availability**: 99.9% uptime for plugin discovery and download
- **Bundle delivery**: p99 < 200ms for plugin bundle download (CDN-cached)
- **Developer experience**: CLI tools for scaffolding, building, and publishing plugins
- **Composability**: Plugins work independently and in combination without coordination

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                              CDN                                     │
│          (Plugin bundles, frontend assets, cache headers)             │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         API Gateway                                  │
│             (Rate limiting, auth, TLS termination)                   │
└──────────┬──────────────────────────────────┬────────────────────────┘
           │                                  │
           ▼                                  ▼
┌────────────────────┐           ┌──────────────────────┐
│  Marketplace API   │           │  Plugin Bundle CDN   │
│  (Browse, Install, │           │  (S3 / CloudFront)   │
│   Publish, Review) │           │  Public read access  │
└────────┬───────────┘           └──────────────────────┘
         │
    ┌────┼────────────┐
    ▼    ▼            ▼
┌──────┐ ┌──────┐ ┌──────┐
│  PG  │ │Redis │ │  S3  │
│Users │ │Cache │ │Bundles│
│Plugin│ │Sessn │ │      │
│Review│ │      │ │      │
└──────┘ └──────┘ └──────┘
```

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Frontend (React)                              │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                     Plugin Host                                │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │  │
│  │  │ EventBus │  │ StateMgr │  │  Slot    │  │ Plugin       │  │  │
│  │  │ pub/sub  │  │ reactive │  │ Renderer │  │ Loader       │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│         ┌────────────────────┼────────────────────┐                  │
│         ▼                    ▼                    ▼                  │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐           │
│  │ Font Plugin │     │Editor Plugin│     │Paper Plugin  │           │
│  │ (toolbar)   │     │ (canvas)    │     │ (canvas)     │           │
│  └─────────────┘     └─────────────┘     └─────────────┘           │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                   Marketplace UI                               │  │
│  │           Browse, Install, Uninstall, Auth                     │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## Core Concept: Everything is a Plugin

Unlike traditional editors where plugins extend a core feature set, this editor has no core functionality -- only infrastructure. The plugin host provides:

- **Slot system**: Named regions where plugins contribute React components
- **Event bus**: Publish/subscribe for transient notifications between plugins
- **State manager**: Reactive shared state with key-value subscriptions
- **Plugin context API**: Standardized interface for plugin lifecycle and capabilities

Even the text editing area is a plugin (`text-editor`), not a built-in feature. Removing all plugins leaves an empty shell with just the slot layout.

### Slot System

Slots are named regions in the layout where plugins contribute UI components:

| Slot | Layout | Purpose | Z-index |
|------|--------|---------|---------|
| `toolbar` | Horizontal | Controls, selectors, buttons | N/A |
| `canvas` | Stacked | Paper background, text editor | Background: 0, Editor: 1 |
| `sidebar` | Vertical | Settings, info panels | N/A |
| `statusbar` | Horizontal | Stats, status info | N/A |
| `modal` | Single overlay | Dialog overlays | Highest |

```
┌─────────────────────────────────────────────────────────────────┐
│                        [toolbar slot]                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐           ┌──────────┐ │
│  │ Font     │ │ Size     │ │ Paper    │           │ Theme    │ │
│  │ Selector │ │ Selector │ │ Selector │           │ Toggle   │ │
│  └──────────┘ └──────────┘ └──────────┘           └──────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│                      [canvas slot]                               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ ░ Paper Background (z-index: 0)                         ░│  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │ Text Editor (z-index: 1)                            │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                      [statusbar slot]                            │
│  Words: 9  |  Characters: 44  |  Lines: 1                       │
└─────────────────────────────────────────────────────────────────┘
```

Plugins declare which slots they contribute to via their manifest. The `order` property controls render order within a slot. The canvas slot is special: it stacks contributions using z-index, allowing a background plugin to render behind the editor plugin.

### Plugin Manifest

Each plugin declares its capabilities through a manifest:

```typescript
interface PluginManifest {
  id: string;                    // Unique identifier (e.g., 'font-selector')
  name: string;                  // Display name
  version: string;               // Semver version
  description: string;           // What this plugin does
  category?: string;             // formatting, appearance, utilities, etc.

  contributes: {
    slots?: SlotContribution[];  // UI components to named slots
    commands?: Command[];        // Executable commands
    settings?: Setting[];        // Configurable options
  };

  requires?: {
    events?: string[];           // Events it subscribes to
    state?: string[];            // State keys it reads
  };
}

interface SlotContribution {
  slot: 'toolbar' | 'canvas' | 'sidebar' | 'statusbar' | 'modal';
  component: string;             // Component export name
  order?: number;                // Render order within slot
}
```

### Plugin Context API

Plugins receive a context object providing four namespaced APIs:

```typescript
interface PluginContext {
  pluginId: string;

  events: {
    emit: (event: string, data?: unknown) => void;
    on: (event: string, handler: (data: unknown) => void) => () => void;
  };

  state: {
    get: <T>(key: string) => T | undefined;
    set: (key: string, value: unknown) => void;
    subscribe: (key: string, handler: (value: unknown) => void) => () => void;
  };

  storage: {
    get: <T>(key: string) => T | undefined;
    set: (key: string, value: unknown) => void;
  };

  commands: {
    register: (id: string, handler: () => void) => void;
    execute: (id: string) => void;
  };
}
```

**Events** are for transient notifications -- "the content just changed." **State** is for persistent values -- "the current font is Arial." Plugins choose the appropriate mechanism: font changes are state (the editor needs to read the current value at any time), while content-changed notifications are events (word-count only needs to react, not poll).

### Standard Events and State Keys

```typescript
// Events (transient notifications)
CONTENT_CHANGED:    'editor:content-changed'
SELECTION_CHANGED:  'editor:selection-changed'
FONT_CHANGED:       'format:font-changed'
SIZE_CHANGED:       'format:size-changed'
PAPER_CHANGED:      'theme:paper-changed'
THEME_CHANGED:      'theme:mode-changed'

// State keys (persistent values)
CONTENT:     'editor.content'
SELECTION:   'editor.selection'
FONT_FAMILY: 'format.fontFamily'
FONT_SIZE:   'format.fontSize'
PAPER:       'theme.paper'
THEME_MODE:  'theme.mode'
```

### Inter-Plugin Communication

Plugins communicate without knowing about each other:

```
Font Selector                    Text Editor
    │                                │
    ├── state.set('format.font')────▶│
    │                                │ subscribe('format.font')
    │                                │     └── Update textarea style

Text Editor                      Word Count
    │                                │
    ├── state.set('editor.content')─▶│
    │                                │ subscribe('editor.content')
    │                                │     └── Recalculate counts
```

This decoupling means the font selector works whether or not the text editor is installed, and the word count plugin works with any future editor plugin that writes to `editor.content`.

## Backend Architecture

### Database Schema

```sql
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100),
    is_developer BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugins (
    id VARCHAR(100) PRIMARY KEY,  -- e.g., 'font-selector'
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    category VARCHAR(50),
    license VARCHAR(50) DEFAULT 'MIT',
    repository_url TEXT,
    homepage_url TEXT,
    icon_url TEXT,
    is_official BOOLEAN DEFAULT false,
    status VARCHAR(20) DEFAULT 'draft',  -- draft, published, suspended
    install_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS plugin_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    version VARCHAR(20) NOT NULL,
    bundle_url TEXT NOT NULL,
    manifest JSONB NOT NULL,
    changelog TEXT,
    min_platform_version VARCHAR(20),
    file_size INTEGER,
    checksum VARCHAR(64),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(plugin_id, version)
);

CREATE TABLE IF NOT EXISTS plugin_tags (
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    tag VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (plugin_id, tag)
);

CREATE TABLE IF NOT EXISTS user_plugins (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    version_installed VARCHAR(20),
    is_enabled BOOLEAN DEFAULT true,
    settings JSONB DEFAULT '{}',
    installed_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS anonymous_installs (
    session_id VARCHAR(255) NOT NULL,
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    version_installed VARCHAR(20),
    is_enabled BOOLEAN DEFAULT true,
    settings JSONB DEFAULT '{}',
    installed_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (session_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS plugin_reviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(200),
    content TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(plugin_id, user_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_plugins_author ON plugins(author_id);
CREATE INDEX IF NOT EXISTS idx_plugins_category ON plugins(category);
CREATE INDEX IF NOT EXISTS idx_plugins_status ON plugins(status);
CREATE INDEX IF NOT EXISTS idx_plugin_versions_plugin ON plugin_versions(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_tags_tag ON plugin_tags(tag);
CREATE INDEX IF NOT EXISTS idx_plugin_reviews_plugin ON plugin_reviews(plugin_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
```

### Schema Design Rationale

**Plugin ID as human-readable string**: The `plugins.id` column uses a slug (`font-selector`) rather than a UUID. This makes URLs readable (`/plugins/font-selector`), enables natural naming in manifests, and matches npm package naming conventions. The trade-off is that IDs must be globally unique strings, requiring validation on publish.

**Separate anonymous_installs table**: Anonymous users (no account) can install plugins, tracked by session ID. When a user later registers, their anonymous installs can be migrated to `user_plugins`. The alternative (requiring registration before installing) would add friction to the first-use experience.

**JSONB manifest in plugin_versions**: The full plugin manifest is stored as JSONB alongside each version. This allows the API to serve manifest data without fetching and parsing the plugin bundle, and enables querying plugins by manifest properties (slot contributions, required state keys).

**Install count denormalization**: `plugins.install_count` is denormalized from a `COUNT(*)` on `user_plugins` + `anonymous_installs`. This avoids expensive joins on every marketplace browse query. The count is incremented atomically on install and decremented on uninstall.

### Caching Strategy

```
plugins:list:{hash}     → Browse results      (5 min TTL)
plugins:detail:{id}     → Plugin details       (10 min TTL)
plugins:categories      → Category list         (30 min TTL)
```

Cache invalidation happens on:
- **Version publish**: Delete `detail:{id}` + all `list:*` patterns
- **Plugin update**: Delete `detail:{id}` + all `list:*` patterns
- **Install/uninstall**: Increment/decrement `install_count` (no full cache invalidation)

### API Design

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/auth/register` | POST | None | Create account |
| `/api/v1/auth/login` | POST | None | Login, set session cookie |
| `/api/v1/auth/logout` | POST | Session | Destroy session |
| `/api/v1/auth/me` | GET | Session | Get current user |
| `/api/v1/plugins` | GET | Optional | Browse/search plugins with category filter |
| `/api/v1/plugins/:id` | GET | Optional | Plugin details with versions and reviews |
| `/api/v1/plugins/categories` | GET | None | List available categories |
| `/api/v1/user/plugins` | GET | Optional | List installed plugins (session or user) |
| `/api/v1/user/plugins/install` | POST | Optional | Install plugin |
| `/api/v1/user/plugins/:id` | DELETE | Optional | Uninstall plugin |
| `/api/v1/developer/register` | POST | Required | Upgrade account to developer |
| `/api/v1/developer/plugins` | GET/POST | Required | List/create plugins |
| `/api/v1/developer/plugins/:id/versions` | POST | Required | Publish new version with bundle upload |

"Optional" auth means the endpoint works for both anonymous (session-tracked) and authenticated users, with different storage backends.

## Key Design Decisions

### In-Process Plugins (No Web Workers)

Plugins run in the main thread, not in Web Workers or iframes. This is because plugins need direct DOM access for rendering React components into slots. Running React in a Web Worker would require a virtual DOM bridge to the main thread, adding latency and complexity that defeats the purpose of a learning project.

The trade-off is less isolation -- a plugin that throws an unhandled error could crash the host. We mitigate this with React error boundaries around each slot contribution. At production scale with untrusted third-party plugins, iframe sandboxing or Web Component isolation would be necessary, accepting the performance and API complexity costs.

### Event Bus + Shared State (Dual Communication)

Two communication mechanisms serve different purposes:
- **State** (`state.get`/`state.set`/`state.subscribe`): For persistent values that plugins need to read at any time (current font, current theme, editor content). State is reactive -- subscribers are notified on change.
- **Events** (`events.emit`/`events.on`): For transient notifications that don't need persistence (content changed, selection changed). Events are fire-and-forget.

The alternative (events only, or state only) would force one mechanism to serve both purposes poorly. Events-only would require every plugin to maintain its own copy of shared values. State-only would require polling for change detection.

### Session-Based Auth with Anonymous Support

Anonymous users can browse the marketplace and install plugins, tracked by session ID in `anonymous_installs`. When they register, installs migrate to `user_plugins`. This reduces friction -- users can try the editor immediately without creating an account.

The trade-off is session storage: anonymous sessions consume Redis memory. A 24-hour session TTL bounds this cost while giving users a day to decide whether to register.

### MinIO for Plugin Storage

Plugin bundles (JavaScript ES modules) are stored in MinIO (S3-compatible object storage) rather than in PostgreSQL or the filesystem. This separates compute from storage, allows bundles to be served directly to browsers with public read access, and scales independently from the API server.

At production scale, a CDN (CloudFront) would front the MinIO/S3 bucket, caching bundles at edge locations for sub-100ms download worldwide.

### Monorepo with npm Workspaces

The frontend, backend, plugin SDK, and standalone plugins all live in one repository with npm workspaces. This allows the SDK to be developed alongside the plugins that consume it, with shared TypeScript configuration. Plugins can still be published independently to npm.

The alternative (separate repositories per plugin) would provide stronger isolation but make cross-cutting SDK changes painful -- every plugin would need a separate PR.

## Consistency and Idempotency

- **Plugin installation** is idempotent -- installing an already-installed plugin updates the version if different, or is a no-op if the same.
- **Install count** uses atomic SQL increment (`install_count = install_count + 1`) rather than read-modify-write, preventing lost updates under concurrent installs.
- **Version publishing** uses a `UNIQUE(plugin_id, version)` constraint -- attempting to publish the same version twice returns an error, not a duplicate.

## Security

- Session-based authentication with Redis-backed store (connect-redis)
- Password hashing with bcrypt
- CORS restricted to frontend origin
- Plugin bundles are validated (checksum verification) before serving
- Developer registration requires authentication -- only registered users can publish
- At production scale: Content Security Policy headers, plugin code review process, sandboxed execution for untrusted plugins

## Observability

- **Structured logging** with Pino (pino-http) -- request method, path, status, and duration logged as JSON
- **Health checks** for PostgreSQL, Redis, and MinIO connectivity
- At production scale: download metrics per plugin, error tracking per plugin activation, marketplace browse/install conversion funnel

## Failure Handling

- **Plugin error boundaries**: React error boundaries around each slot prevent a single plugin crash from taking down the host
- **Plugin activation failures**: Logged and skipped -- remaining plugins continue loading
- **Redis unavailability**: Sessions fall back to in-memory store (single-instance only, not production-safe)
- **MinIO unavailability**: Bundle downloads fail gracefully with error messages; already-loaded plugins continue working
- **Graceful shutdown**: Database and Redis connections closed cleanly on SIGTERM

## Scalability Considerations

### What breaks first
1. **Plugin bundle downloads** -- Without a CDN, the backend serves every bundle download. Solution: S3/CloudFront with aggressive cache headers (bundles are immutable per version).
2. **Marketplace browse queries** -- Full-text search across plugin names/descriptions degrades with thousands of plugins. Solution: Elasticsearch for search, PostgreSQL for structured queries.
3. **Anonymous session storage** -- Without cleanup, sessions accumulate in Redis. Solution: TTL-based expiry (24 hours), session count monitoring.
4. **Plugin count per slot** -- Rendering 50+ plugins in a single slot impacts paint performance. Solution: lazy rendering with intersection observer, priority-based loading.

### Scaling path
- **CDN for bundles**: Cache immutable plugin bundles at edge locations
- **Search engine**: Elasticsearch for marketplace full-text search
- **Read replicas**: Route browse/search queries to replicas
- **Plugin lazy loading**: Load plugins on-demand based on viewport visibility
- **Web Worker isolation**: For untrusted third-party plugins at scale

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Plugin execution | In-process (main thread) | Web Workers / iframes | Plugins need direct DOM access for React rendering |
| Communication | Event bus + shared state | Events only | State provides persistent values; events provide notifications |
| Auth | Session with anonymous support | Require registration | Reduces friction, anonymous users can try immediately |
| Plugin storage | MinIO (S3-compatible) | PostgreSQL / filesystem | Scales independently, direct browser access, CDN-ready |
| Project structure | Monorepo (npm workspaces) | Separate repos | SDK and plugins evolve together, single install |
| Plugin ID | Human-readable slug | UUID | Readable URLs, natural naming, matches npm conventions |

## Implementation Notes

### Local Setup Diagram

```
┌────────────────────────────────────────────┐
│  React Frontend (Vite :5173)               │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │  Plugin Host (PluginHost.tsx)        │  │
│  │  ├── EventBus.ts                    │  │
│  │  ├── StateManager.ts               │  │
│  │  └── SlotRenderer.tsx              │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │  Bundled Plugins (5)                 │  │
│  │  paper-background | font-selector   │  │
│  │  text-editor | word-count | theme   │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │  Marketplace UI                      │  │
│  │  MarketplaceModal | AuthModal        │  │
│  └──────────────────────────────────────┘  │
└─────────────────┬──────────────────────────┘
                  │ HTTP /api/v1/*
                  ▼
┌────────────────────────────────────────────┐
│  Express Backend (:3000)                   │
│  Routes: auth, plugins, user-plugins,      │
│          developer                         │
│  Pino logging, multer file upload          │
└──────┬──────────┬──────────┬───────────────┘
       │          │          │
       ▼          ▼          ▼
┌──────────┐ ┌────────┐ ┌────────┐
│PostgreSQL│ │ Valkey │ │ MinIO  │
│  :5432   │ │ :6379  │ │ :9000  │
│plugin_   │ │(cache +│ │(plugin │
│platform  │ │session)│ │bundles)│
│ (8 tbl)  │ │        │ │:9001   │
└──────────┘ └────────┘ │console │
                         └────────┘
```

Docker Compose runs PostgreSQL, Valkey (Redis-compatible), and MinIO. A `minio-init` container creates the `plugins` bucket with public download access on startup.

### Production-Grade Patterns Implemented

| Pattern | File Path | Purpose |
|---------|-----------|---------|
| Event bus (pub/sub) | `frontend/src/core/EventBus.ts` | Decoupled inter-plugin communication for transient events |
| Reactive state manager | `frontend/src/core/StateManager.ts` | Shared state with key-based subscriptions for persistent values |
| Slot-based composition | `frontend/src/core/SlotRenderer.tsx` | Named UI regions where plugins contribute React components |
| Plugin lifecycle | `frontend/src/core/PluginHost.tsx` | Load, activate, deactivate plugins with context injection |
| Structured logging | `backend/src/shared/logger.ts` | Pino JSON logs for request tracing |
| Object storage | `backend/src/shared/storage.ts` | MinIO client for plugin bundle upload/download |
| Redis caching | `backend/src/shared/cache.ts` | TTL-based caching for marketplace browse/detail queries |
| Session auth | `backend/src/api/routes/auth.ts` | Redis-backed sessions with anonymous user support |
| File upload | `backend/src/api/routes/developer.ts` | Multer-based bundle upload with MinIO storage |
| Plugin SDK | `packages/plugin-sdk/src/index.ts` | Shared types and helpers for plugin development |

### Bundled Plugins

| Plugin | Category | Slots | Description |
|--------|----------|-------|-------------|
| `paper-background` | appearance | canvas, toolbar | 6 paper styles (plain, ruled, checkered, dotted, graph, legal) |
| `font-selector` | formatting | toolbar | 7 font families + size selector |
| `text-editor` | core | canvas | Textarea with auto-save to localStorage |
| `word-count` | utilities | statusbar | Real-time word, character, line counts |
| `theme` | appearance | toolbar | Light/dark mode with system preference detection |

### What Was Simplified

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| CDN for plugin bundles | MinIO direct download | Higher latency, no edge caching |
| Plugin sandboxing (iframe/WC) | In-process, main thread | No isolation between plugins |
| npm registry integration | Local monorepo plugins | No real package publishing |
| OAuth for developer auth | Session auth with bcrypt | No GitHub/Google SSO |
| Plugin code review pipeline | Direct publish | No security vetting of plugin code |
| Remote plugin loading (URL) | Bundled plugins in frontend | All plugins must be part of the build |

### What Was Omitted

- CDN and edge caching for plugin bundles
- Plugin sandboxing (Web Workers, iframes, Web Components)
- Remote plugin loading from URL at runtime
- Plugin dependency management (plugin A depends on plugin B)
- Plugin analytics (usage tracking, error rates)
- Plugin monetization (paid plugins, Stripe integration)
- Collaborative real-time editing via WebSocket
- Markdown preview, export, spell check plugins
- Plugin version auto-update mechanism
- Rate limiting on API endpoints
- Prometheus metrics and health check endpoints
