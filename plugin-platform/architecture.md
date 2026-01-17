# Pluggable Text Editor - Architecture

## System Overview

A minimalist text editor where **everything is a plugin**. The core application provides only a plugin host and slot system—even the text input area itself is provided by a plugin. This extreme modularity demonstrates plugin architecture patterns and allows complete customization.

**The system consists of three main parts:**
1. **Frontend**: React-based plugin host with slot system
2. **Backend**: Marketplace API for plugin distribution
3. **Standalone Plugins**: Independent projects built by different developers

**Learning Goals:**
- Design a plugin slot/contribution system
- Build loosely-coupled plugin communication
- Implement plugin lifecycle management
- Create a marketplace for plugin distribution
- Handle both authenticated and anonymous users

---

## System Architecture

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
│                           Backend (Express.js)                               │
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
    │PostgreSQL│           │  Redis  │            │  MinIO  │
    │ - Users │           │ - Cache │            │ Plugin  │
    │ - Plugins│           │ - Session│           │ Bundles │
    │ - Reviews│           └─────────┘            └─────────┘
    └─────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                        Standalone Plugin Projects                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │paper-background│ │font-selector │  │text-editor   │  │word-count    │   │
│  │ - package.json │ │ - package.json│ │ - package.json│ │ - package.json│  │
│  │ - vite.config │ │ - vite.config │ │ - vite.config │ │ - vite.config │   │
│  │ - src/index.tsx│ │ - src/index.tsx││ - src/index.tsx││ - src/index.tsx│  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Concept: Everything is a Plugin

Unlike traditional editors where plugins extend a core, this editor has no core functionality—only infrastructure:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Plugin Host                               │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                      Slot System                             │ │
│  │  ┌─────────┐  ┌─────────────────────────┐  ┌─────────────┐  │ │
│  │  │ toolbar │  │        canvas           │  │   sidebar   │  │ │
│  │  │  slot   │  │         slot            │  │    slot     │  │ │
│  │  └────┬────┘  └────────────┬────────────┘  └──────┬──────┘  │ │
│  └───────┼────────────────────┼──────────────────────┼─────────┘ │
│          │                    │                      │           │
│  ┌───────┴────────────────────┴──────────────────────┴─────────┐ │
│  │                      Event Bus                               │ │
│  └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
            │                    │                      │
    ┌───────┴───────┐   ┌───────┴───────┐      ┌───────┴───────┐
    │  Font Plugin  │   │ Editor Plugin │      │ Paper Plugin  │
    │               │   │               │      │               │
    │ - Font picker │   │ - Textarea    │      │ - Checkered   │
    │ - Size slider │   │ - Text state  │      │ - Ruled       │
    │               │   │ - Cursor      │      │ - Plain       │
    └───────────────┘   └───────────────┘      └───────────────┘
```

---

## Requirements

### Functional Requirements

1. **Plugin Loading**: Dynamically load plugins at runtime
2. **Slot System**: Plugins register UI components to named slots
3. **Event Bus**: Plugins communicate via publish/subscribe events
4. **State Sharing**: Plugins can read/write shared editor state
5. **Plugin Marketplace**: Browse, search, and install plugins
6. **User Authentication**: Session-based auth (optional for users)
7. **Plugin Publishing**: Developers can publish and manage plugins

### Non-Functional Requirements

- **Isolation**: Plugin failures don't crash the host
- **Performance**: Lazy loading, Redis caching
- **Developer Experience**: CLI tools, hot reload
- **Composability**: Plugins work independently and together

---

## Backend Architecture

### Database Schema

```sql
-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_developer BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Plugins table
CREATE TABLE plugins (
  id VARCHAR(100) PRIMARY KEY,  -- e.g., 'font-selector'
  author_id UUID REFERENCES users(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  category VARCHAR(50),
  license VARCHAR(50) DEFAULT 'MIT',
  repository_url TEXT,
  homepage_url TEXT,
  icon_url TEXT,
  status VARCHAR(20) DEFAULT 'draft',  -- draft, published, suspended
  install_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Plugin versions
CREATE TABLE plugin_versions (
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

-- User installed plugins
CREATE TABLE user_plugins (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  version_installed VARCHAR(20),
  is_enabled BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  installed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, plugin_id)
);

-- Anonymous user installs (tracked by session)
CREATE TABLE anonymous_installs (
  session_id VARCHAR(255) NOT NULL,
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  version_installed VARCHAR(20),
  is_enabled BOOLEAN DEFAULT true,
  settings JSONB DEFAULT '{}',
  installed_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (session_id, plugin_id)
);

-- Plugin reviews
CREATE TABLE plugin_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id VARCHAR(100) REFERENCES plugins(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(200),
  content TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(plugin_id, user_id)
);
```

### API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/v1/auth/register` | POST | None | Create account |
| `/api/v1/auth/login` | POST | None | Login |
| `/api/v1/auth/logout` | POST | Session | Logout |
| `/api/v1/auth/me` | GET | Session | Get current user |
| `/api/v1/plugins` | GET | Optional | Browse/search plugins |
| `/api/v1/plugins/:id` | GET | Optional | Plugin details |
| `/api/v1/plugins/categories` | GET | None | List categories |
| `/api/v1/user/plugins` | GET | Optional | Installed plugins |
| `/api/v1/user/plugins/install` | POST | Optional | Install plugin |
| `/api/v1/user/plugins/:id` | DELETE | Optional | Uninstall |
| `/api/v1/developer/register` | POST | Required | Become developer |
| `/api/v1/developer/plugins` | GET/POST | Required | Manage plugins |
| `/api/v1/developer/plugins/:id/versions` | POST | Required | Publish version |

### Caching Strategy

```typescript
// Redis cache keys
plugins:list:{hash}     // Browse results (5 min TTL)
plugins:detail:{id}     // Plugin details (10 min TTL)
plugins:categories      // Category list (30 min TTL)

// Cache invalidation
- On version publish: delete detail + list patterns
- On plugin update: delete detail + list patterns
- On install/uninstall: increment install_count
```

---

## Plugin Architecture

### Plugin Manifest

Each plugin declares its capabilities:

```typescript
interface PluginManifest {
  id: string;                    // Unique identifier
  name: string;                  // Display name
  version: string;               // Semver version
  description: string;           // What this plugin does
  category?: string;             // formatting, appearance, utilities, etc.

  // What this plugin provides
  contributes: {
    slots?: SlotContribution[];  // UI components to slots
    commands?: Command[];        // Executable commands
    settings?: Setting[];        // Configurable options
  };

  // What this plugin needs
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

Plugins receive a context object with available APIs:

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

### Standard Events

```typescript
const EVENTS = {
  CONTENT_CHANGED: 'editor:content-changed',
  SELECTION_CHANGED: 'editor:selection-changed',
  FONT_CHANGED: 'format:font-changed',
  SIZE_CHANGED: 'format:size-changed',
  PAPER_CHANGED: 'theme:paper-changed',
  THEME_CHANGED: 'theme:mode-changed',
};
```

### Standard State Keys

```typescript
const STATE_KEYS = {
  CONTENT: 'editor.content',
  SELECTION: 'editor.selection',
  FONT_FAMILY: 'format.fontFamily',
  FONT_SIZE: 'format.fontSize',
  PAPER: 'theme.paper',
  THEME_MODE: 'theme.mode',
};
```

---

## Slot System

Slots are named regions where plugins contribute UI:

| Slot | Layout | Purpose |
|------|--------|---------|
| `toolbar` | Horizontal | Controls, selectors, buttons |
| `canvas` | Stacked (z-index) | Paper background, text editor |
| `sidebar` | Vertical | Settings, info panels |
| `statusbar` | Horizontal | Stats, status info |
| `modal` | Single | Dialog overlays |

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

---

## Standalone Plugin Development

### Plugin Project Structure

Each plugin is an independent npm project:

```
plugins/font-selector/
├── package.json          # Plugin metadata + manifest
├── tsconfig.json         # TypeScript config
├── vite.config.ts        # Build config (library mode)
├── src/
│   └── index.tsx         # Plugin entry point
├── dist/
│   ├── index.js          # Built bundle (ES module)
│   └── index.js.map      # Source map
└── README.md             # Plugin documentation
```

### package.json

```json
{
  "name": "@plugins/font-selector",
  "version": "1.0.0",
  "type": "module",
  "main": "dist/index.js",
  "peerDependencies": {
    "react": "^19.0.0"
  },
  "pluginManifest": {
    "id": "font-selector",
    "name": "Font Selector",
    "category": "formatting",
    "contributes": {
      "slots": [
        { "slot": "toolbar", "component": "FontSelector", "order": 10 }
      ]
    }
  }
}
```

### Plugin Entry Point

```typescript
// src/index.tsx
import React from 'react';
import {
  definePlugin,
  useStateValue,
  STATE_KEYS,
  type PluginProps,
  type PluginManifest,
  type PluginContext,
} from '@plugin-platform/sdk';

export const manifest: PluginManifest = {
  id: 'font-selector',
  name: 'Font Selector',
  version: '1.0.0',
  contributes: {
    slots: [{ slot: 'toolbar', component: 'FontSelector', order: 10 }],
  },
};

export function FontSelector({ context }: PluginProps): React.ReactElement {
  const currentFont = useStateValue<string>(context, STATE_KEYS.FONT_FAMILY);
  // ... component implementation
}

export function activate(context: PluginContext): void {
  console.log('[font-selector] Plugin activated');
}

export default definePlugin({
  manifest,
  activate,
  FontSelector,
});
```

### Build Configuration

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [react(), dts({ include: ['src'] })],
  build: {
    lib: {
      entry: 'src/index.tsx',
      name: 'FontSelectorPlugin',
      fileName: 'index',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
    },
  },
});
```

### Plugin CLI

```bash
# Initialize new plugin
npm run plugin-cli init my-plugin

# Build plugin
cd plugins/my-plugin && npm run build

# Publish to marketplace
npm run plugin-cli publish
```

---

## Bundled Plugins

The editor ships with 5 plugins enabled by default:

| Plugin | Category | Slots | Description |
|--------|----------|-------|-------------|
| `paper-background` | appearance | canvas, toolbar | Paper styles (ruled, checkered, dotted) |
| `font-selector` | formatting | toolbar | Font family and size selection |
| `text-editor` | core | canvas | The actual text editing area |
| `word-count` | utilities | statusbar | Word, character, line counts |
| `theme` | appearance | toolbar | Light/dark mode toggle |

---

## File Structure

```
plugin-platform/
├── frontend/                     # React frontend
│   ├── src/
│   │   ├── core/                 # Plugin infrastructure
│   │   │   ├── PluginHost.tsx
│   │   │   ├── SlotRenderer.tsx
│   │   │   ├── EventBus.ts
│   │   │   ├── StateManager.ts
│   │   │   └── types.ts
│   │   ├── plugins/              # Bundled plugins (dev mode)
│   │   ├── components/           # UI components
│   │   │   ├── MarketplaceModal.tsx
│   │   │   └── AuthModal.tsx
│   │   ├── services/             # API client
│   │   │   └── api.ts
│   │   ├── stores/               # State management
│   │   │   └── auth.ts
│   │   ├── App.tsx
│   │   └── main.tsx
│   └── package.json
│
├── backend/                      # Express API
│   ├── src/
│   │   ├── api/
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts
│   │   │   │   ├── plugins.ts
│   │   │   │   ├── user-plugins.ts
│   │   │   │   └── developer.ts
│   │   │   ├── app.ts
│   │   │   └── index.ts
│   │   ├── shared/
│   │   │   ├── db.ts
│   │   │   ├── cache.ts
│   │   │   ├── storage.ts
│   │   │   └── logger.ts
│   │   └── db/
│   │       ├── migrations/
│   │       ├── migrate.ts
│   │       └── seed.ts
│   └── package.json
│
├── packages/
│   └── plugin-sdk/               # Shared SDK for plugins
│       ├── src/index.ts
│       └── package.json
│
├── plugins/                      # Standalone plugin projects
│   ├── paper-background/
│   ├── font-selector/
│   ├── text-editor/
│   ├── word-count/
│   └── theme/
│
├── scripts/
│   └── plugin-cli.ts             # Plugin development CLI
│
├── docker-compose.yml            # PostgreSQL, Redis, MinIO
├── package.json                  # Monorepo workspace
├── architecture.md               # This file
├── README.md                     # Setup instructions
└── claude.md                     # Development notes
```

---

## Key Design Decisions

### 1. In-Process Plugins (No Web Workers)

**Decision**: Plugins run in the main thread, not Web Workers

**Rationale**:
- Plugins need direct DOM access for UI rendering
- React components can't easily run in workers
- Bundled plugins from marketplace are vetted
- Performance acceptable for this use case

**Trade-off**: Less isolation, but simpler development

### 2. Session-Based Auth with Anonymous Support

**Decision**: Use Express sessions with Redis, supporting both authenticated and anonymous users

**Rationale**:
- Anonymous users can install plugins (stored by session ID)
- When user logs in, installs can be migrated to their account
- Simpler than JWT for this use case
- Works well with server-rendered admin pages

### 3. MinIO for Plugin Storage

**Decision**: Store plugin bundles in MinIO (S3-compatible)

**Rationale**:
- Scales independently from database
- Can serve bundles directly to browsers
- Public read access for installed plugins
- Easy local development with docker-compose

### 4. Monorepo with npm Workspaces

**Decision**: Single repo with workspace packages

**Rationale**:
- Easy to develop SDK and plugins together
- Shared TypeScript config
- Single install for all dependencies
- Plugins can still be published independently

---

## Running the System

### Prerequisites

- Node.js 20+
- Docker and Docker Compose

### Quick Start

```bash
# Start infrastructure
docker-compose up -d

# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Build SDK
npm run build:sdk

# Start backend (port 3000)
npm run dev:backend

# Start frontend (port 5173)
npm run dev:frontend
```

### Environment Variables

```bash
# Backend
DATABASE_URL=postgresql://plugin_user:plugin_pass@localhost:5432/plugin_platform
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
SESSION_SECRET=your-session-secret

# Frontend
VITE_API_URL=http://localhost:3000
```

---

## Future Ideas

- **Remote Plugin Loading**: Load plugins from URL at runtime
- **Plugin Dependencies**: Allow plugins to depend on other plugins
- **Plugin Sandboxing**: Use iframes or Web Components for isolation
- **Collaborative Editing**: Real-time sync via WebSocket
- **Plugin Analytics**: Track usage, errors, performance
- **Plugin Monetization**: Paid plugins with Stripe integration
