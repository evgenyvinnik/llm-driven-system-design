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

The trade-off is session storage: anonymous sessions consume Redis memory. The session cookie is set to a 7-day `maxAge` (`api/app.ts`), which bounds this cost while giving users a week to decide whether to register; a shorter TTL would trade lower memory for more lost anonymous carts.

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
3. **Anonymous session storage** -- Without cleanup, sessions accumulate in Redis. Solution: TTL-based expiry (the cookie `maxAge` is 7 days today; a shorter TTL would cap memory), session count monitoring.
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

## Frontend Architecture

### Component Hierarchy

```
App.tsx (root)
└── PluginHostProvider                ← React context that loads and activates plugins
    └── EditorLayout
        ├── header
        │   ├── "Pluggable Editor" title
        │   ├── Slot id="toolbar"     ← Renders toolbar plugin contributions
        │   │   ├── FontSelector      ← (font-selector plugin) font family + size dropdowns
        │   │   ├── PaperSelector     ← (paper-background plugin) paper style dropdown
        │   │   └── ThemeToggle       ← (theme plugin) light/dark mode toggle
        │   ├── PluginIcon button     ← Opens MarketplaceModal
        │   └── Auth (sign in / sign out)
        ├── main
        │   ├── Slot id="canvas"      ← Stacked plugin contributions (z-indexed)
        │   │   ├── PaperBackground   ← (paper-background plugin, z-index: 0)
        │   │   └── TextEditor        ← (text-editor plugin, z-index: 1)
        │   └── aside
        │       └── Slot id="sidebar" ← Currently unused, available for future plugins
        ├── footer
        │   └── Slot id="statusbar"   ← Status bar plugin contributions
        │       └── WordCount         ← (word-count plugin) word/character/line counts
        ├── Slot id="modal"           ← Dialog overlay slot for plugin modals
        ├── MarketplaceModal          ← Browse, search, install/uninstall marketplace plugins
        └── AuthModal                 ← Login/register modal dialog
```

### Core Infrastructure (No Zustand -- Custom Plugin State System)

Unlike other projects in this repository, the plugin platform frontend does not use Zustand for domain state. Instead, it implements a custom plugin infrastructure consisting of four components:

**`EventBus`** (`core/EventBus.ts`) is a publish/subscribe event system for transient notifications between plugins. Plugins call `events.emit('editor:content-changed', data)` to broadcast and `events.on('editor:content-changed', handler)` to subscribe. The `on` method returns an unsubscribe function for cleanup. Events are fire-and-forget -- there is no persistence or replay.

**`StateManager`** (`core/StateManager.ts`) is a reactive key-value store for persistent shared state. Plugins call `state.set('format.fontFamily', 'Arial')` to update and `state.subscribe('format.fontFamily', handler)` to receive change notifications. Unlike the EventBus, the StateManager retains values so plugins can read the current state at any time via `state.get()`. This is the mechanism by which the font selector plugin communicates the chosen font to the text editor plugin without either knowing the other exists.

**`PluginHost`** (`core/PluginHost.tsx`) is a React context provider that manages plugin lifecycle. On mount, it iterates through the PLUGINS array, creates a `PluginContext` for each plugin (giving it access to events, state, storage, and commands), calls each plugin's `activate()` function, and registers slot contributions from the manifest. The `usePluginHost` hook exposes the loaded plugins map and `getSlotContributions()` function. The `useStateValue` hook provides reactive state access from within plugin React components.

**`SlotRenderer`** (`core/SlotRenderer.tsx`) renders the `<Slot id="toolbar">` components. For each slot ID, it looks up registered contributions (sorted by `order` property from manifests), and renders each plugin's React component with a `PluginProps` context object.

**`useAuthStore`** (`stores/auth.ts`) is the only Zustand store, managing user authentication and marketplace plugin installation state. It uses `persist` middleware to save the user and authentication status to localStorage. Beyond standard login/register/logout, it includes `installPlugin`, `uninstallPlugin`, and `togglePlugin` actions that call the marketplace API and re-fetch the installed plugins list. The store loads installed plugins for both authenticated and anonymous users (anonymous installs are tracked by session ID on the backend).

### Routing

This project has no URL-based routing. The application is a single-page editor where the entire UI is composed from plugin slot contributions. The MarketplaceModal and AuthModal are overlay dialogs controlled by local React state (`useState`) in the EditorLayout component. Navigation between views (editor vs marketplace) happens through modal open/close rather than URL changes.

### Data Fetching

API communication is split across two files:

**`services/api.ts`** provides four API client objects: `authApi` (register, login, logout, session check), `pluginsApi` (list, search, get details, categories), `userPluginsApi` (get installed, install, uninstall, toggle, update settings). All clients use a shared `fetchApi<T>()` helper that wraps `fetch()` with `credentials: 'include'` for cookie-based sessions, JSON parsing, and error wrapping into an `ApiResponse<T>` type with `data` and `error` fields. The API base URL defaults to `http://localhost:3000` and is configurable via `VITE_API_URL`.

Plugin data fetching happens in the MarketplaceModal component which directly calls `pluginsApi.list()` and `pluginsApi.getDetails()`. Install/uninstall operations go through the Zustand auth store, which calls `userPluginsApi` and then re-fetches the installed plugins list.

### Key UI Patterns

**Slot-based composition**: The entire UI is assembled from plugin contributions to named slots. The `<Slot id="toolbar">` component in the header renders all plugins that registered a toolbar contribution in their manifest. Removing all plugins leaves an empty shell. This extreme modularity demonstrates the VS Code/Eclipse extension point pattern in a React context.

**Plugin manifest-driven registration**: Each plugin exports a `manifest` object declaring which slots it contributes to, at what order, and which component to render. The PluginHost reads these manifests at load time and populates the slot registry. This decouples plugins from each other and from the host layout.

**Inter-plugin communication without coupling**: The font selector plugin writes to shared state key `format.fontFamily`. The text editor plugin subscribes to `format.fontFamily` and updates its textarea style. Neither plugin imports or references the other. New plugins can participate in the same communication by reading/writing the same state keys.

**Anonymous-to-authenticated session migration**: Anonymous users can browse the marketplace and install plugins (tracked by session ID in `anonymous_installs` table). When they register, the backend migrates their installations to the `user_plugins` table. The auth store handles this transparently by re-fetching installed plugins after login.

**Dark mode via plugin**: Even the theme system is a plugin. The `theme` plugin contributes a toggle to the toolbar slot, detects system preference via `prefers-color-scheme`, and writes `theme.mode` to shared state. Other plugins read this state key to adjust their rendering.

## Deep Pattern Explanations

This section explains the production-grade patterns used in this project from first principles. Each pattern solves a specific operational problem that emerges at scale.

### Structured Logging

Structured logging means writing log entries as machine-parseable data (typically JSON) rather than free-form text strings. Traditional logs look like `"User 123 installed plugin font-selector"` -- a human can read this, but extracting the user ID or plugin ID programmatically requires fragile regex parsing. Structured logs look like `{"event":"plugin_install","userId":"123","pluginId":"font-selector","timestamp":"2025-01-01T00:00:00Z"}` -- every field is a named key-value pair that log aggregation tools (Elasticsearch, Datadog, CloudWatch) can index, search, and alert on.

This project uses Pino via `pino-http` middleware, which automatically logs every HTTP request with method, path, status code, and response duration as JSON fields. At production scale with thousands of plugin installs per hour, structured logging enables queries like "show me all failed plugin bundle downloads in the last hour grouped by plugin ID" -- impossible with unstructured text logs without custom parsing.

**File**: `backend/src/shared/logger.ts`

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks the cache before querying the database. On a cache hit, the cached value is returned immediately (sub-millisecond latency). On a cache miss, the application queries the database, stores the result in the cache with a time-to-live (TTL), and returns it to the caller. Subsequent requests for the same data hit the cache until the TTL expires.

Redis is commonly used as the cache layer because it is an in-memory key-value store with sub-millisecond read latency, built-in TTL support, and atomic operations. In this project, the marketplace browse results are cached for 5 minutes (`plugins:list:{hash}`), plugin details for 10 minutes (`plugins:detail:{id}`), and category lists for 30 minutes (`plugins:categories`). Cache invalidation happens on writes: when a new version is published or a plugin is updated, the relevant detail key and all list keys are deleted.

The most challenging aspect of cache-aside is cache invalidation. This project uses a hybrid approach: TTL-based expiry for natural staleness bounds, plus explicit deletion on known write events. The trade-off is that between a write and TTL expiry, clients may see slightly stale data (e.g., an install count that is off by 1). This is acceptable for a marketplace browse page but would not be acceptable for, say, a payment balance.

**File**: `backend/src/shared/cache.ts`

### Health Checks

A health check is an HTTP endpoint that reports whether the application is functioning correctly. Load balancers, container orchestrators (Kubernetes), and monitoring systems call this endpoint periodically to determine if an instance should receive traffic.

This project checks three dependencies: PostgreSQL (database connectivity), Redis/Valkey (session and cache store), and MinIO (plugin bundle storage). If any dependency is unreachable, the health check returns `503 Service Unavailable` with details about which component is down. This granularity helps operators quickly identify the root cause during an incident -- "MinIO is down, but PostgreSQL and Redis are healthy" narrows the debugging surface immediately.

At production scale, health checks typically distinguish between **liveness** (is the process running and not deadlocked?) and **readiness** (can the process serve traffic?). A failing liveness check restarts the container. A failing readiness check removes the instance from the load balancer without restarting, which is useful during startup when the database connection pool is still warming up or when MinIO becomes temporarily unavailable.

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window, protecting the server from abuse, accidental loops, and denial-of-service attacks. Without rate limiting, a single misbehaving client could consume all server resources and deny service to legitimate users.

This project does not currently implement rate limiting (it is listed under "What Was Omitted"), but the production design would apply it at the API gateway level with endpoint-specific limits. Plugin bundle downloads would have generous limits (users download bundles infrequently but in bursts when installing several plugins). Plugin search/browse endpoints would have tighter limits to prevent scraping. Publishing endpoints would have strict limits to prevent abuse.

Rate limiting algorithms vary in sophistication. **Fixed window** divides time into intervals and counts requests per window -- simple but allows burst-then-starve at boundaries. **Sliding window** smooths the rate by weighting the previous and current windows. **Token bucket** allows controlled bursts by accumulating tokens at a steady rate. For a marketplace API, token bucket is often preferred because legitimate usage patterns involve bursts (browsing multiple plugins quickly) followed by idle periods.

### Prometheus Metrics

Prometheus is a time-series monitoring system that collects numerical measurements (metrics) from applications at regular intervals. The application exposes an HTTP endpoint (`/metrics`) that returns current metric values in a specific text format. A Prometheus server scrapes this endpoint every 15-30 seconds and stores the data, enabling dashboards (Grafana) and alerting rules.

There are four main metric types. **Counters** only go up (total requests served, total plugin installs). **Gauges** go up and down (current memory usage, active sessions). **Histograms** track the distribution of values (request duration buckets for computing p50/p90/p99 latencies). **Summaries** compute quantiles on the client side.

This project does not currently expose Prometheus metrics (listed under "What Was Omitted"), but the production design would track: plugin download counts (counter), bundle download latency (histogram), marketplace search latency (histogram), active WebSocket connections if collaborative editing were added (gauge), and per-plugin error rates during activation (counter). These metrics would feed Grafana dashboards with alerts on download failures and search latency degradation.

### Circuit Breaker

A circuit breaker is a stability pattern that prevents a failing downstream service from dragging down the entire application. The name comes from electrical circuit breakers that trip to prevent a short circuit from causing a fire.

The pattern works through three states. In the **closed** state (normal operation), all requests pass through. When failures cross a threshold, the breaker enters the **open** state -- all requests fail immediately (0ms latency vs 30-second timeouts). After a cooldown period, the breaker enters the **half-open** state, allowing a few test requests through. If those succeed, the breaker closes; if they fail, it reopens.

In this project, circuit breakers would protect MinIO bundle downloads and Redis cache operations. If MinIO goes down, the circuit breaker for storage operations opens, and the marketplace shows "bundle unavailable" errors instantly rather than hanging for 30 seconds per download attempt. Already-loaded plugins continue working because they are loaded into browser memory. Redis failures would cause the session fallback to in-memory storage (single-instance only) while the breaker periodically tests if Redis has recovered.

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. This is critical in distributed systems where network failures cause retries.

In this project, plugin installation is idempotent by design: installing an already-installed plugin updates the version if different, or is a no-op if the same version. The `UNIQUE(plugin_id, version)` constraint on `plugin_versions` prevents duplicate version publishes at the database level. Install count updates use atomic SQL (`install_count = install_count + 1`) rather than read-modify-write, preventing lost updates when two users install the same plugin simultaneously.

For general API idempotency at production scale, the server would accept an `X-Idempotency-Key` header, check it against a Redis cache before processing, and return the cached response for duplicate requests. This guarantees exactly-once semantics even when clients retry after network timeouts.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of granting individual permissions to each user, you define roles and assign permission sets to each role.

This project implements a three-tier authorization model. **Anonymous users** can browse the marketplace and install plugins (tracked by session ID). **Authenticated users** get persistent installations that sync across sessions, plus the ability to leave reviews. **Developers** (users with `is_developer = true`) can additionally publish plugins and upload bundles. The developer upgrade is a one-way operation via `POST /api/v1/developer/register`.

The key design insight is that the plugin marketplace serves two distinct user populations (consumers and publishers) with fundamentally different permission needs. Rather than a complex RBAC table, the project uses a simple boolean `is_developer` flag because there are only two meaningful permission levels beyond basic authentication. At production scale with features like plugin moderation, featured listings, and monetization, a full RBAC system with permissions like `publish_plugin`, `moderate_reviews`, `manage_featured`, and `view_analytics` would become necessary.

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
