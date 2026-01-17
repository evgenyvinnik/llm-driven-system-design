# Pluggable Text Editor

A minimalist text editor where **everything is a plugin**. The core application provides only a plugin host and slot system—even the text input area itself is provided by a plugin.

## Overview

This project demonstrates plugin architecture patterns:
- **Slot System**: Named UI regions where plugins contribute components
- **Event Bus**: Decoupled communication between plugins
- **Shared State**: Reactive state that plugins can read/write/subscribe to
- **Plugin Lifecycle**: Activation, storage, and command registration

## Quick Start

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 to see the editor.

## Bundled Plugins

The editor ships with 5 plugins:

| Plugin | Description | Slots |
|--------|-------------|-------|
| **paper-background** | Different paper styles (plain, ruled, checkered, dotted, graph, legal) | canvas, toolbar |
| **font-selector** | Font family and size selection | toolbar |
| **text-editor** | The actual text editing area | canvas |
| **word-count** | Word, character, and line counts | statusbar |
| **theme** | Light/dark mode toggle | toolbar |

## Plugin Architecture

### Slots

The host application defines named slots where plugins contribute UI:

```
┌─────────────────────────────────────────────────────────────────┐
│                        [toolbar slot]                            │
│  Font Selector  │  Paper Selector  │              │  Theme      │
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

### Plugin Manifest

Each plugin declares its contributions:

```typescript
const manifest = {
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  description: 'What this plugin does',
  contributes: {
    slots: [
      { slot: 'toolbar', component: 'MyToolbar', order: 50 }
    ]
  }
};
```

### Plugin Context API

Plugins receive a context object with these APIs:

```typescript
context.events.emit('my-event', data);     // Emit events
context.events.on('other-event', handler); // Subscribe to events

context.state.get('key');                  // Read shared state
context.state.set('key', value);           // Write shared state
context.state.subscribe('key', handler);   // React to changes

context.storage.get('key');                // Read plugin-specific storage
context.storage.set('key', value);         // Write plugin-specific storage

context.commands.register('cmd', handler); // Register a command
context.commands.execute('plugin.cmd');    // Execute a command
```

## Creating a New Plugin

1. Create a folder under `src/plugins/`:

```
src/plugins/my-plugin/
├── manifest.ts    # Plugin metadata
├── MyComponent.tsx # UI component
└── index.ts       # Exports and activate function
```

2. Define your manifest:

```typescript
// manifest.ts
export const manifest = {
  id: 'my-plugin',
  name: 'My Plugin',
  version: '1.0.0',
  description: 'Does something cool',
  contributes: {
    slots: [
      { slot: 'toolbar', component: 'MyComponent', order: 150 }
    ]
  }
};
```

3. Create your component:

```typescript
// MyComponent.tsx
import { PluginProps } from '../../core/types';

export function MyComponent({ context }: PluginProps) {
  return <button onClick={() => context.events.emit('my-event')}>Click me</button>;
}
```

4. Export and activate:

```typescript
// index.ts
export { manifest } from './manifest';
export { MyComponent } from './MyComponent';

export function activate(context) {
  console.log('[my-plugin] Activated');
}
```

5. Register in `App.tsx`:

```typescript
import * as myPlugin from './plugins/my-plugin';

const PLUGINS = [
  // ... existing plugins
  { manifest: myPlugin.manifest, module: myPlugin },
];
```

## Key Concepts

### State vs Events

- **State**: For persistent values (font, theme, content). Use `subscribe` to react to changes.
- **Events**: For transient notifications (content changed, selection moved). Fire-and-forget.

### Slot Order

Components in a slot are rendered in order. Lower numbers appear first:
- `order: 10` - Font selector (left of toolbar)
- `order: 100` - Paper selector (middle)
- `order: 200` - Theme toggle (right)

### Storage

Each plugin gets isolated localStorage. The key is automatically prefixed with `plugin:{pluginId}:`.

## File Structure

```
frontend/
├── src/
│   ├── core/
│   │   ├── types.ts          # TypeScript interfaces
│   │   ├── EventBus.ts       # Pub/sub system
│   │   ├── StateManager.ts   # Reactive state
│   │   ├── PluginHost.tsx    # Plugin loading
│   │   └── SlotRenderer.tsx  # Slot components
│   ├── plugins/
│   │   ├── paper-background/ # Paper styles plugin
│   │   ├── font-selector/    # Font controls plugin
│   │   ├── text-editor/      # Text editing plugin
│   │   ├── word-count/       # Statistics plugin
│   │   └── theme/            # Dark mode plugin
│   ├── App.tsx               # Main layout
│   ├── main.tsx              # Entry point
│   └── index.css             # Base styles
└── package.json
```

## Architecture

See [architecture.md](./architecture.md) for detailed design documentation.

## Development Notes

See [claude.md](./claude.md) for development history and decisions.
