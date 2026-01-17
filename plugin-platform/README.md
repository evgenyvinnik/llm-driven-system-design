# Pluggable Text Editor

A minimalist text editor where **everything is a plugin**. The core application provides only a plugin host and slot system—even the text input area itself is provided by a plugin.

## Overview

This project demonstrates:
- **Plugin Architecture**: Slot system, event bus, shared state
- **Plugin Marketplace**: Backend API for distributing plugins
- **Standalone Plugins**: Each plugin is an independent project

## Quick Start

### Option A: Docker Compose (Recommended)

```bash
# Start infrastructure (PostgreSQL, Redis, MinIO)
docker-compose up -d

# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Build the SDK
npm run build:sdk

# Start backend (port 3000)
npm run dev:backend

# Start frontend (port 5173)
npm run dev:frontend
```

### Option B: Frontend Only

If you just want to run the frontend with bundled plugins:

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 to see the editor.

## Project Structure

```
plugin-platform/
├── frontend/           # React frontend with plugin host
├── backend/            # Express API for marketplace
├── packages/
│   └── plugin-sdk/     # Shared SDK for plugin development
├── plugins/            # Standalone plugin projects
│   ├── paper-background/
│   ├── font-selector/
│   ├── text-editor/
│   ├── word-count/
│   └── theme/
├── scripts/
│   └── plugin-cli.ts   # Plugin development CLI
└── docker-compose.yml  # PostgreSQL, Redis, MinIO
```

## Bundled Plugins

| Plugin | Description | Slots |
|--------|-------------|-------|
| **paper-background** | Paper styles (plain, ruled, checkered, dotted, graph, legal) | canvas, toolbar |
| **font-selector** | Font family and size selection | toolbar |
| **text-editor** | The actual text editing area | canvas |
| **word-count** | Word, character, and line counts | statusbar |
| **theme** | Light/dark mode toggle | toolbar |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Frontend (React)                          │
│  ┌────────────────┐  ┌───────────────────────────────────┐   │
│  │  Plugin Host   │  │       Marketplace UI              │   │
│  │  - Slot System │  │  - Browse, Search, Install        │   │
│  │  - Event Bus   │  │  - Auth (optional)                │   │
│  └────────────────┘  └───────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    Backend (Express)                          │
│  - Plugin Registry    - User Auth     - Developer Portal     │
└──────────────────────────────────────────────────────────────┘
         │                   │                    │
         ▼                   ▼                    ▼
    PostgreSQL            Redis               MinIO
    (metadata)           (cache)           (bundles)
```

## Creating a Plugin

### Initialize a New Plugin

```bash
npm run plugin-cli init my-plugin
cd plugins/my-plugin
npm install
npm run build
```

### Plugin Structure

```
plugins/my-plugin/
├── package.json        # Includes pluginManifest
├── vite.config.ts      # Library build config
├── src/
│   └── index.tsx       # Plugin entry point
└── dist/
    └── index.js        # Built bundle
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
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  contributes: {
    slots: [{ slot: 'toolbar', component: 'MyComponent', order: 50 }],
  },
};

export function MyComponent({ context }: PluginProps): React.ReactElement {
  return (
    <button onClick={() => context.events.emit('my-event')}>
      Click me
    </button>
  );
}

export function activate(context: PluginContext): void {
  console.log('[my-plugin] Activated');
}

export default definePlugin({
  manifest,
  activate,
  MyComponent,
});
```

### Publish to Marketplace

```bash
npm run plugin-cli publish
```

## Plugin API

Plugins receive a context object with these APIs:

```typescript
// Events - for transient notifications
context.events.emit('my-event', data);
context.events.on('other-event', handler);

// State - for persistent values with subscriptions
context.state.get('key');
context.state.set('key', value);
context.state.subscribe('key', handler);

// Storage - plugin-specific persistence
context.storage.get('key');
context.storage.set('key', value);

// Commands - registered actions
context.commands.register('cmd', handler);
context.commands.execute('plugin.cmd');
```

### Standard State Keys

```typescript
import { STATE_KEYS } from '@plugin-platform/sdk';

STATE_KEYS.CONTENT       // 'editor.content'
STATE_KEYS.FONT_FAMILY   // 'format.fontFamily'
STATE_KEYS.FONT_SIZE     // 'format.fontSize'
STATE_KEYS.PAPER         // 'theme.paper'
STATE_KEYS.THEME_MODE    // 'theme.mode'
```

### Standard Events

```typescript
import { EVENTS } from '@plugin-platform/sdk';

EVENTS.CONTENT_CHANGED   // 'editor:content-changed'
EVENTS.FONT_CHANGED      // 'format:font-changed'
EVENTS.PAPER_CHANGED     // 'theme:paper-changed'
EVENTS.THEME_CHANGED     // 'theme:mode-changed'
```

## Slot System

Slots are named regions where plugins contribute UI:

| Slot | Layout | Purpose |
|------|--------|---------|
| `toolbar` | Horizontal | Controls, selectors, buttons |
| `canvas` | Stacked | Paper background, text editor |
| `sidebar` | Vertical | Settings, info panels |
| `statusbar` | Horizontal | Stats, status info |
| `modal` | Single | Dialog overlays |

```
┌─────────────────────────────────────────────────────────────────┐
│                        [toolbar slot]                            │
│  Font Selector  │  Paper Selector  │         │  Plugins │ Auth  │
├─────────────────────────────────────────────────────────────────┤
│                        [canvas slot]                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ Paper Background (z-index: 0)                             │  │
│  │ Text Editor (z-index: 1)                                  │  │
│  └───────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                      [statusbar slot]                            │
│  Words: 42  |  Characters: 256  |  Lines: 5                     │
└─────────────────────────────────────────────────────────────────┘
```

## Available Scripts

### Root

```bash
npm run dev:frontend      # Start frontend dev server
npm run dev:backend       # Start backend dev server
npm run build             # Build SDK, plugins, and apps
npm run build:plugins     # Build all plugins
npm run db:migrate        # Run database migrations
npm run docker:up         # Start infrastructure
npm run docker:down       # Stop infrastructure
npm run plugin-cli        # Plugin development CLI
```

### Plugin Development

```bash
cd plugins/my-plugin
npm run dev               # Watch mode
npm run build             # Build bundle
npm run type-check        # TypeScript check
```

## Environment Variables

### Backend

```bash
DATABASE_URL=postgresql://plugin_user:plugin_pass@localhost:5432/plugin_platform
REDIS_URL=redis://localhost:6379
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
SESSION_SECRET=your-session-secret
```

### Frontend

```bash
VITE_API_URL=http://localhost:3000
```

## Documentation

- [architecture.md](./architecture.md) - Detailed design documentation
- [claude.md](./claude.md) - Development history and decisions

## License

MIT
