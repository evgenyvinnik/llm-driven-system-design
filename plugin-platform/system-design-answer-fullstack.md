# Plugin Platform - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Problem Statement

Design a web-based plugin platform that enables developers to build, publish, and distribute extensions that extend core application functionality. The core challenge is designing a flexible plugin architecture that balances capability with maintainability.

## Requirements Clarification (3 minutes)

### Functional Requirements
- **Install**: Users can add extensions from a marketplace
- **Run**: Execute extensions with access to plugin APIs
- **Publish**: Developers can submit extensions for review
- **Manage**: Enable, disable, update, configure extensions
- **Discover**: Browse, search, and review extensions

### Non-Functional Requirements
- **Composability**: Plugins work independently and together
- **Performance**: < 500ms extension activation
- **Scale**: 10,000+ extensions, 1M+ users
- **Developer Experience**: Easy to build and debug plugins

### Scale Requirements
- **Extensions**: 10,000+
- **Daily active users**: 1M+
- **Extension installations**: 100M+ total
- **API calls/day**: 100M+

---

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Frontend (React)                                │
│  ┌────────────────────┐  ┌─────────────────────────────────────────────────┐│
│  │   Plugin Host      │  │              Marketplace UI                      ││
│  │  ┌──────────────┐  │  │  ┌───────────┐ ┌───────────┐ ┌───────────────┐ ││
│  │  │ Event Bus    │  │  │  │ Browse    │ │ Install   │ │ Auth Modal    │ ││
│  │  │ State Mgr    │  │  │  │ Plugins   │ │ Uninstall │ │ Login/Register│ ││
│  │  │ Slot System  │  │  │  └───────────┘ └───────────┘ └───────────────┘ ││
│  │  └──────────────┘  │  └─────────────────────────────────────────────────┘│
│  └────────────────────┘                                                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      │ HTTP/REST
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Backend Services (Express.js)                      │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌──────────────┐ │
│  │ Auth Routes   │  │ Plugin Routes │  │ User Plugins  │  │ Developer    │ │
│  │ - Register    │  │ - Browse      │  │ - Install     │  │ - Publish    │ │
│  │ - Login       │  │ - Search      │  │ - Uninstall   │  │ - Versions   │ │
│  │ - Session     │  │ - Details     │  │ - Settings    │  │ - Manage     │ │
│  └───────────────┘  └───────────────┘  └───────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
         │                      │                      │
         ▼                      ▼                      ▼
    ┌─────────┐           ┌─────────┐            ┌─────────┐
    │PostgreSQL│          │  Redis  │            │  MinIO  │
    │ - Users │           │ - Cache │            │ Plugin  │
    │ - Plugins│          │ - Session│           │ Bundles │
    │ - Reviews│          └─────────┘            └─────────┘
    └─────────┘
```

---

## Deep Dive 1: End-to-End Plugin Installation Flow (8 minutes)

### Complete Installation Sequence

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Frontend   │      │   Backend    │      │  PostgreSQL  │      │    MinIO     │
└──────┬───────┘      └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
       │                     │                     │                     │
       │  POST /api/v1/user/plugins/install        │                     │
       │─────────────────────▶                     │                     │
       │  { pluginId, version }                    │                     │
       │                     │                     │                     │
       │                     │  SELECT plugin      │                     │
       │                     │─────────────────────▶                     │
       │                     │                     │                     │
       │                     │  plugin + bundleUrl │                     │
       │                     │◀─────────────────────                     │
       │                     │                     │                     │
       │                     │  INSERT user_plugins│                     │
       │                     │─────────────────────▶                     │
       │                     │                     │                     │
       │                     │  UPDATE install_count                     │
       │                     │─────────────────────▶                     │
       │                     │                     │                     │
       │  { bundleUrl }      │                     │                     │
       │◀─────────────────────                     │                     │
       │                     │                     │                     │
       │  import(bundleUrl)  │                     │                     │
       │─────────────────────────────────────────────────────────────────▶
       │                     │                     │                     │
       │  ES Module bundle   │                     │                     │
       │◀─────────────────────────────────────────────────────────────────
       │                     │                     │                     │
       │  loadPlugin(manifest, module)             │                     │
       │  ────────────────▶  │                     │                     │
```

### Backend Install Handler

"I chose to support both authenticated and anonymous users. Anonymous users get their plugins tracked by session ID, which migrates to their account when they log in. This prevents losing installed plugins during the conversion flow."

**Key operations:**
1. Verify plugin exists and is published (join plugins + plugin_versions)
2. Record installation (authenticated users in user_plugins, anonymous in anonymous_installs with session_id)
3. Increment install_count on plugins table
4. Invalidate relevant caches
5. Return bundleUrl for frontend dynamic import

### Frontend Install Handler

**Installation flow:**
1. Call backend to record installation and get bundleUrl
2. Dynamically import the plugin bundle using ES modules
3. Load into plugin host via loadPlugin(manifest, module)
4. Persist to localStorage for offline startup

**Startup flow:**
- Load previously installed plugins from localStorage
- Fetch current bundle URLs from backend
- Import and activate each plugin (with error isolation)

---

## Deep Dive 2: Plugin SDK and API Contract (8 minutes)

### Plugin Manifest Schema

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PluginManifest                                   │
├─────────────────────────────────────────────────────────────────────────┤
│ id: string                    │ Unique identifier: 'font-selector'      │
│ name: string                  │ Display name: 'Font Selector'           │
│ version: string               │ Semver: '1.0.0'                         │
│ description: string           │                                         │
│ author?: string               │                                         │
│ category?: 'formatting' | 'appearance' | 'utilities' | 'core'          │
├─────────────────────────────────────────────────────────────────────────┤
│                         contributes                                      │
├─────────────────────────────────────────────────────────────────────────┤
│ slots?: SlotContribution[]    │ Where plugin renders UI                 │
│ commands?: Command[]          │ Keyboard shortcuts / actions            │
│ settings?: Setting[]          │ User-configurable options               │
├─────────────────────────────────────────────────────────────────────────┤
│                         requires                                         │
├─────────────────────────────────────────────────────────────────────────┤
│ events?: string[]             │ Events it subscribes to                 │
│ state?: string[]              │ State keys it reads                     │
│ platformVersion?: string      │ Minimum platform version                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Slot Contribution System

```
┌───────────────────────────────────────────────────────────────────────┐
│                        Slot-Based UI Rendering                         │
├───────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐    │
│   │  TOOLBAR SLOT                                                 │    │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐                      │    │
│   │  │ Plugin A │ │ Plugin B │ │ Plugin C │  (ordered by order)  │    │
│   │  └──────────┘ └──────────┘ └──────────┘                      │    │
│   └──────────────────────────────────────────────────────────────┘    │
│                                                                        │
│   ┌──────────┐  ┌───────────────────────────────────────┐             │
│   │ SIDEBAR  │  │  CANVAS SLOT                          │             │
│   │ SLOT     │  │  ┌─────────────────────────────────┐  │             │
│   │          │  │  │  Text Editor Plugin             │  │             │
│   │ Plugin D │  │  │  (contributes to 'canvas')      │  │             │
│   │          │  │  └─────────────────────────────────┘  │             │
│   └──────────┘  └───────────────────────────────────────┘             │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐    │
│   │  STATUSBAR SLOT                                               │    │
│   │  ┌──────────────┐ ┌──────────────┐                           │    │
│   │  │ Word Count   │ │ Theme Toggle │                           │    │
│   │  └──────────────┘ └──────────────┘                           │    │
│   └──────────────────────────────────────────────────────────────┘    │
│                                                                        │
└───────────────────────────────────────────────────────────────────────┘
```

Available slots: toolbar, canvas, sidebar, statusbar, modal

### Plugin Context API

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PluginContext                                   │
├──────────────────────┬──────────────────────────────────────────────────┤
│ pluginId: string     │ Unique identifier for this plugin instance       │
├──────────────────────┼──────────────────────────────────────────────────┤
│ events               │                                                   │
│   .emit(event, data) │ Broadcast event to other plugins                 │
│   .on(event, fn)     │ Subscribe to events (returns unsubscribe fn)     │
├──────────────────────┼──────────────────────────────────────────────────┤
│ state                │                                                   │
│   .get<T>(key)       │ Read shared state value                          │
│   .set(key, value)   │ Write shared state value                         │
│   .subscribe(key,fn) │ React to state changes (returns unsubscribe fn)  │
├──────────────────────┼──────────────────────────────────────────────────┤
│ storage              │                                                   │
│   .get<T>(key)       │ Read plugin-scoped persistent storage            │
│   .set(key, value)   │ Write plugin-scoped persistent storage           │
├──────────────────────┼──────────────────────────────────────────────────┤
│ commands             │                                                   │
│   .register(id, fn)  │ Register command handler                         │
│   .execute(id)       │ Trigger command by ID                            │
└──────────────────────┴──────────────────────────────────────────────────┘
```

### Plugin Communication Patterns

**Font Plugin to Editor Plugin:**
```
Font Selector                    Text Editor
    │                                │
    ├── state.set('format.font')────▶│
    │                                │ subscribe('format.font')
    │                                │     └── Update textarea style
```

**Editor Plugin to Word Count Plugin:**
```
Text Editor                      Word Count
    │                                │
    ├── state.set('editor.content')─▶│
    │                                │ subscribe('editor.content')
    │                                │     └── Recalculate counts
```

### Standard State Keys and Events

| Type | Key | Purpose |
|------|-----|---------|
| State | editor.content | Current document text |
| State | editor.selection | Selected text range |
| State | format.fontFamily | Active font family |
| State | format.fontSize | Active font size |
| State | theme.paper | Paper background style |
| State | theme.mode | Light/dark mode |
| Event | editor:content-changed | Document was modified |
| Event | editor:selection-changed | Selection moved |
| Event | format:font-changed | Font settings updated |

---

## Deep Dive 3: Session Management Across Auth States (6 minutes)

### Unified Session Handling

"I implemented session management that works for both anonymous and authenticated users. This is critical for the plugin platform because users should be able to try plugins before signing up."

**Session configuration:**
- Store: Redis with connect-redis
- saveUninitialized: true (creates session for anonymous users)
- Cookie: httpOnly, sameSite lax, 7-day maxAge
- Secure: true in production

### Auth Flow with Plugin Migration

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     Anonymous to Authenticated Flow                       │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  1. Anonymous User                                                        │
│     ┌──────────────────────────────────────────────────────────────┐     │
│     │ Session: { id: 'sess_abc123' }                                │     │
│     │ anonymous_installs: [ plugin_A, plugin_B ]                    │     │
│     └──────────────────────────────────────────────────────────────┘     │
│                              │                                            │
│                              ▼ User clicks "Sign Up"                      │
│                                                                           │
│  2. Registration/Login                                                    │
│     ┌──────────────────────────────────────────────────────────────┐     │
│     │ Verify credentials                                            │     │
│     │ SELECT * FROM anonymous_installs WHERE session_id = $1        │     │
│     │ INSERT INTO user_plugins SELECT ... FROM anonymous_installs   │     │
│     │ DELETE FROM anonymous_installs WHERE session_id = $1          │     │
│     └──────────────────────────────────────────────────────────────┘     │
│                              │                                            │
│                              ▼                                            │
│  3. Authenticated User                                                    │
│     ┌──────────────────────────────────────────────────────────────┐     │
│     │ Session: { id: 'sess_abc123', userId: 'user_42' }             │     │
│     │ user_plugins: [ plugin_A, plugin_B ] (migrated!)              │     │
│     └──────────────────────────────────────────────────────────────┘     │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Frontend Auth State

**Zustand store with persist middleware:**
- user: User | null
- isLoading: boolean
- login(username, password): Authenticates, then reloads to merge plugins
- logout(): Clears session, removes localStorage plugins, reloads
- checkSession(): Called on app startup to restore auth state

---

## Deep Dive 4: Plugin Publishing Flow (6 minutes)

### Developer Publishing Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Plugin Publishing Sequence                         │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Developer Dashboard                                                      │
│         │                                                                 │
│         │ 1. Upload bundle.js (multipart form)                           │
│         │    + version, changelog, minPlatformVersion                     │
│         ▼                                                                 │
│  ┌─────────────────┐                                                      │
│  │  Backend API    │                                                      │
│  │  /developer/    │                                                      │
│  │  plugins/:id/   │                                                      │
│  │  versions       │                                                      │
│  └────────┬────────┘                                                      │
│           │                                                               │
│           │ 2. Verify plugin ownership (author_id = session.userId)       │
│           │                                                               │
│           │ 3. Check version doesn't exist                                │
│           │                                                               │
│           │ 4. Extract & validate manifest from bundle                    │
│           │    ┌───────────────────────────────────────────┐              │
│           │    │ - id matches plugin                       │              │
│           │    │ - version is valid semver                 │              │
│           │    │ - required fields present                 │              │
│           │    │ - contributes.slots are valid             │              │
│           │    └───────────────────────────────────────────┘              │
│           │                                                               │
│           │ 5. Upload to MinIO: /plugins/{pluginId}/{version}/bundle.js   │
│           ▼                                                               │
│  ┌─────────────────┐                                                      │
│  │     MinIO       │──▶ Returns CDN-friendly bundleUrl                    │
│  └─────────────────┘                                                      │
│           │                                                               │
│           │ 6. Insert plugin_versions record                              │
│           │                                                               │
│           │ 7. Update plugins.status = 'published' if first version       │
│           │                                                               │
│           │ 8. Invalidate caches (plugins:*)                              │
│           ▼                                                               │
│  ┌─────────────────┐                                                      │
│  │   Response      │ { success: true, bundleUrl }                         │
│  └─────────────────┘                                                      │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Developer Dashboard Features

| Feature | Description |
|---------|-------------|
| Plugin List | All plugins owned by developer with status badges |
| Install Count | Real-time installation metrics per plugin |
| Version History | List of published versions with timestamps |
| Publish Button | Upload new bundle.js with version info |
| Analytics | (Future) Usage patterns and error rates |

---

## Deep Dive 5: Caching and Performance (5 minutes)

### Multi-Layer Caching Strategy

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Caching Architecture                               │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Frontend (Browser)                                                       │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ sessionStorage: SWR pattern (stale-while-revalidate)                 │ │
│  │   - plugins:list (60s TTL)                                           │ │
│  │   - plugin:detail:{id} (60s TTL)                                     │ │
│  │                                                                      │ │
│  │ localStorage: Installed plugins list for offline startup             │ │
│  │                                                                      │ │
│  │ Browser Cache: Plugin bundles (immutable, 1-year max-age)            │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                            │
│                              ▼                                            │
│  Backend (Redis)                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ plugins:list          │ 5 min TTL  │ Paginated plugin catalog        │ │
│  │ plugins:detail:{id}   │ 10 min TTL │ Full plugin with versions       │ │
│  │ plugins:categories    │ 30 min TTL │ Category list with counts       │ │
│  │ user:{id}:plugins     │ 5 min TTL  │ User's installed plugins        │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                              │                                            │
│                              ▼                                            │
│  CDN (MinIO with caching headers)                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ Plugin Bundles: Cache-Control: public, max-age=31536000, immutable  │ │
│  │ (Versioned URLs make this safe: /plugins/word-count/1.0.0/bundle.js)│ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### Plugin Bundle Optimization

**Preloading strategy:**
1. On app startup, fetch user's installed plugins list
2. Use modulepreload link tags to hint browser
3. Load plugins sequentially for deterministic activation order
4. Each plugin's bundle is versioned and immutable

**Cache invalidation triggers:**
- Plugin update: Clear plugins:detail:{id}
- New version published: Clear plugins:* pattern
- User installs/uninstalls: Clear user:{id}:plugins

---

## Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| Plugin Execution | In-process (main thread) | Web Workers | Direct DOM access needed for React |
| Auth Pattern | Session-based with anonymous | JWT-only | Supports both guest and registered users |
| Plugin Storage | MinIO (S3-compatible) | PostgreSQL BLOB | CDN-friendly, scales independently |
| State Sharing | Event Bus + State Manager | Single store | Loose coupling between plugins |
| Bundle Format | ES Modules | UMD/CommonJS | Native browser support, tree-shaking |
| Monorepo | npm workspaces | Separate repos | Easier SDK development, shared config |

---

## Design Decisions Rationale

### In-Process Plugins (No Web Workers)

"I chose to run plugins in the main thread rather than Web Workers for several reasons:
- Plugins need direct DOM access for React component rendering
- React components can't easily run in workers
- This is a learning project with bundled plugins (no untrusted code)
- Simpler development and debugging experience

The trade-off is less isolation, but acceptable for our use case."

### Slot System

"I designed a slot system with declarative contributions because:
- Plugins don't need to know about each other
- Order can be controlled via manifest configuration
- It's a familiar pattern (Vue slots, Web Components)
- Adding new slots requires no plugin changes"

### Event Bus + Shared State

"I use both mechanisms for different purposes:
- **State**: For persistent values that need reactivity (font, theme, content)
- **Events**: For transient notifications (content changed, selection moved)
- Plugins choose the appropriate mechanism based on their needs"

---

## Future Fullstack Enhancements

1. **Plugin Dependencies**: Resolve and load plugin dependencies automatically
2. **Hot Module Replacement**: Update plugins without full page reload
3. **Usage Analytics**: Track plugin feature usage for developers
4. **A/B Testing**: Developers can test plugin variations
5. **Plugin Settings Sync**: Sync plugin settings across devices
6. **WebSocket Updates**: Real-time plugin update notifications
7. **Plugin Sandboxing**: Optional iframe isolation for untrusted plugins
