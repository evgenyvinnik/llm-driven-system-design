# Plugin Platform - System Design Answer (Frontend Focus)

*45-minute system design interview format - Frontend Engineer Position*

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

### UI/UX Requirements
- Seamless plugin loading without page refresh
- Visual feedback during plugin activation
- Consistent UI across host app and plugin contributions
- Responsive design for various screen sizes
- Accessible plugin marketplace and controls

## High-Level Architecture (5 minutes)

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
│  │                   State Manager                              │ │
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

## Deep Dive 1: Slot System Architecture (8 minutes)

### Named Slot Regions

Slots are named regions where plugins contribute UI components:

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

| Slot | Layout | Purpose |
|------|--------|---------|
| `toolbar` | Horizontal flexbox | Controls, selectors, buttons |
| `canvas` | Stacked (z-index) | Paper background, text editor |
| `sidebar` | Vertical flexbox | Settings, info panels |
| `statusbar` | Horizontal flexbox | Stats, status info |
| `modal` | Portal overlay | Dialog overlays |

### SlotRenderer Component

```typescript
import React, { useMemo } from 'react';
import { usePluginHost } from './PluginHost';
import type { SlotContribution } from './types';

interface SlotRendererProps {
  slotName: string;
  className?: string;
}

export function SlotRenderer({ slotName, className }: SlotRendererProps) {
  const { loadedPlugins, getContext } = usePluginHost();

  // Collect and sort contributions for this slot
  const contributions = useMemo(() => {
    const allContributions: SlotContribution[] = [];

    for (const plugin of loadedPlugins.values()) {
      const matching = plugin.contributions.filter(c => c.slot === slotName);
      allContributions.push(
        ...matching.map(c => ({ ...c, pluginId: plugin.manifest.id }))
      );
    }

    // Sort by order (lower order = rendered first)
    return allContributions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [loadedPlugins, slotName]);

  // Slot-specific layout styles
  const slotStyles = {
    toolbar: 'flex flex-row items-center gap-4 p-2 border-b',
    canvas: 'relative flex-1',
    sidebar: 'flex flex-col gap-2 p-2 w-64',
    statusbar: 'flex flex-row items-center gap-4 p-2 border-t text-sm',
    modal: 'fixed inset-0 z-50',
  };

  return (
    <div className={`slot slot-${slotName} ${slotStyles[slotName] ?? ''} ${className ?? ''}`}>
      {contributions.map((contribution, index) => {
        const Component = contribution.component;
        const context = getContext(contribution.pluginId);

        return (
          <ErrorBoundary key={`${contribution.pluginId}-${index}`} pluginId={contribution.pluginId}>
            <Component context={context} />
          </ErrorBoundary>
        );
      })}
    </div>
  );
}

// Error boundary to isolate plugin failures
class ErrorBoundary extends React.Component<{ pluginId: string; children: React.ReactNode }> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="plugin-error text-red-500 text-sm p-2">
          Plugin "{this.props.pluginId}" failed to render
        </div>
      );
    }
    return this.props.children;
  }
}
```

### CSS Layout for Slots

```css
/* Main application layout */
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* Toolbar slot - horizontal with auto-spacing */
.slot-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 1rem;
  background: var(--toolbar-bg);
  border-bottom: 1px solid var(--border-color);
}

/* Canvas slot - stacked layers with z-index */
.slot-canvas {
  position: relative;
  flex: 1;
  overflow: hidden;
}

.slot-canvas > * {
  position: absolute;
  inset: 0;
}

/* Paper background layer */
.slot-canvas [data-layer="background"] {
  z-index: 0;
}

/* Editor layer */
.slot-canvas [data-layer="editor"] {
  z-index: 1;
}

/* Sidebar slot - vertical scrolling */
.slot-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 16rem;
  padding: 1rem;
  overflow-y: auto;
  border-left: 1px solid var(--border-color);
}

/* Statusbar slot - fixed height */
.slot-statusbar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.25rem 1rem;
  font-size: 0.875rem;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-color);
}

.slot-statusbar > * {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

/* Modal slot - portal overlay */
.slot-modal {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}
```

## Deep Dive 2: Plugin Host and Context API (8 minutes)

### PluginHost React Context

```typescript
import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { EventBus } from './EventBus';
import { StateManager } from './StateManager';
import type { PluginManifest, PluginModule, PluginContext, LoadedPlugin } from './types';

interface PluginHostContextValue {
  loadedPlugins: Map<string, LoadedPlugin>;
  loadPlugin: (manifest: PluginManifest, module: PluginModule) => Promise<void>;
  unloadPlugin: (pluginId: string) => Promise<void>;
  getContext: (pluginId: string) => PluginContext;
  isLoading: boolean;
}

const PluginHostContext = createContext<PluginHostContextValue | null>(null);

export function PluginHostProvider({ children }: { children: React.ReactNode }) {
  const [loadedPlugins, setLoadedPlugins] = useState<Map<string, LoadedPlugin>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  const eventBusRef = useRef(new EventBus());
  const stateManagerRef = useRef(new StateManager());

  const createContext = useCallback((pluginId: string): PluginContext => {
    const eventBus = eventBusRef.current;
    const stateManager = stateManagerRef.current;

    return {
      pluginId,

      events: {
        emit: (event, data) => eventBus.emit(event, data),
        on: (event, handler) => eventBus.on(event, handler),
      },

      state: {
        get: (key) => stateManager.get(key),
        set: (key, value) => stateManager.set(key, value),
        subscribe: (key, handler) => stateManager.subscribe(key, handler),
      },

      storage: {
        get: (key) => {
          const stored = localStorage.getItem(`plugin:${pluginId}:${key}`);
          return stored ? JSON.parse(stored) : undefined;
        },
        set: (key, value) => {
          localStorage.setItem(`plugin:${pluginId}:${key}`, JSON.stringify(value));
        },
      },

      commands: {
        register: (id, handler) => {
          // Command registration handled by separate command manager
        },
        execute: (id) => {
          eventBus.emit(`command:${id}`);
        },
      },
    };
  }, []);

  const loadPlugin = useCallback(async (manifest: PluginManifest, module: PluginModule) => {
    setIsLoading(true);

    try {
      const context = createContext(manifest.id);

      // Call plugin's activate function
      if (module.activate) {
        await module.activate(context);
      }

      // Collect slot contributions
      const contributions = [];
      for (const slot of manifest.contributes?.slots || []) {
        const component = module[slot.component];
        if (component) {
          contributions.push({
            slot: slot.slot,
            component,
            order: slot.order ?? 0,
          });
        }
      }

      setLoadedPlugins(prev => {
        const next = new Map(prev);
        next.set(manifest.id, { manifest, context, contributions, module });
        return next;
      });
    } finally {
      setIsLoading(false);
    }
  }, [createContext]);

  const unloadPlugin = useCallback(async (pluginId: string) => {
    const plugin = loadedPlugins.get(pluginId);
    if (plugin?.module.deactivate) {
      await plugin.module.deactivate();
    }

    setLoadedPlugins(prev => {
      const next = new Map(prev);
      next.delete(pluginId);
      return next;
    });
  }, [loadedPlugins]);

  const getContext = useCallback((pluginId: string) => {
    return loadedPlugins.get(pluginId)?.context ?? createContext(pluginId);
  }, [loadedPlugins, createContext]);

  return (
    <PluginHostContext.Provider value={{ loadedPlugins, loadPlugin, unloadPlugin, getContext, isLoading }}>
      {children}
    </PluginHostContext.Provider>
  );
}

export function usePluginHost() {
  const context = useContext(PluginHostContext);
  if (!context) {
    throw new Error('usePluginHost must be used within PluginHostProvider');
  }
  return context;
}
```

### Plugin State Hook

```typescript
// Custom hook for plugins to subscribe to state
export function useStateValue<T>(context: PluginContext, key: string): T | undefined {
  const [value, setValue] = useState<T | undefined>(() => context.state.get(key));

  useEffect(() => {
    // Subscribe to state changes
    const unsubscribe = context.state.subscribe(key, (newValue) => {
      setValue(newValue as T);
    });

    // Initial sync
    setValue(context.state.get(key));

    return unsubscribe;
  }, [context, key]);

  return value;
}

// Example usage in a plugin component
function FontSelector({ context }: PluginProps) {
  const currentFont = useStateValue<string>(context, 'format.fontFamily');

  const handleFontChange = (font: string) => {
    context.state.set('format.fontFamily', font);
    context.events.emit('format:font-changed', font);
  };

  return (
    <select value={currentFont ?? 'system-ui'} onChange={e => handleFontChange(e.target.value)}>
      <option value="system-ui">System</option>
      <option value="serif">Serif</option>
      <option value="monospace">Monospace</option>
    </select>
  );
}
```

## Deep Dive 3: Event Bus and State Manager (6 minutes)

### Event Bus Implementation

```typescript
type EventHandler = (data: unknown) => void;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  emit(event: string, data?: unknown): void {
    const eventHandlers = this.handlers.get(event);
    if (eventHandlers) {
      for (const handler of eventHandlers) {
        // Execute handlers asynchronously to prevent blocking
        queueMicrotask(() => {
          try {
            handler(data);
          } catch (error) {
            console.error(`Event handler error for "${event}":`, error);
            // Error in one handler doesn't break others
          }
        });
      }
    }
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.handlers.get(event)?.delete(handler);
    };
  }

  // For debugging: list all registered events
  listEvents(): string[] {
    return Array.from(this.handlers.keys());
  }
}
```

### State Manager with Reactive Subscriptions

```typescript
type StateHandler = (value: unknown, oldValue: unknown) => void;

export class StateManager {
  private state = new Map<string, unknown>();
  private subscribers = new Map<string, Set<StateHandler>>();

  get<T>(key: string): T | undefined {
    return this.state.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    const oldValue = this.state.get(key);

    // Only trigger updates if value actually changed
    if (oldValue === value) return;

    this.state.set(key, value);

    // Notify subscribers
    const keySubscribers = this.subscribers.get(key);
    if (keySubscribers) {
      for (const handler of keySubscribers) {
        queueMicrotask(() => {
          try {
            handler(value, oldValue);
          } catch (error) {
            console.error(`State subscriber error for "${key}":`, error);
          }
        });
      }
    }
  }

  subscribe(key: string, handler: StateHandler): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(handler);

    return () => {
      this.subscribers.get(key)?.delete(handler);
    };
  }

  // Batch multiple state updates
  batch(updates: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(updates)) {
      this.set(key, value);
    }
  }

  // Snapshot current state (for debugging/persistence)
  getSnapshot(): Record<string, unknown> {
    return Object.fromEntries(this.state);
  }
}
```

### Plugin Communication Flow

```
┌────────────────────┐     state.set('format.font')     ┌────────────────────┐
│    Font Plugin     │ ─────────────────────────────────▶│    State Manager   │
│                    │                                   │                    │
│  FontSelector.tsx  │                                   │  state: Map        │
└────────────────────┘                                   │  subscribers: Map  │
                                                         └─────────┬──────────┘
                                                                   │
                                                                   │ notify subscribers
                                                                   ▼
┌────────────────────┐     subscribe('format.font')      ┌────────────────────┐
│   Editor Plugin    │ ◀─────────────────────────────────│   State Manager    │
│                    │                                   │                    │
│  TextEditor.tsx    │     callback(newFont)             │                    │
│  - Update style    │                                   │                    │
└────────────────────┘                                   └────────────────────┘
```

## Deep Dive 4: Marketplace UI (6 minutes)

### Marketplace Modal Component

```typescript
import React, { useState, useEffect } from 'react';
import { usePluginHost } from '../core/PluginHost';
import { api } from '../services/api';

interface MarketplaceModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MarketplaceModal({ isOpen, onClose }: MarketplaceModalProps) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { loadPlugin, loadedPlugins } = usePluginHost();

  useEffect(() => {
    if (isOpen) {
      fetchPlugins();
    }
  }, [isOpen, search, category]);

  const fetchPlugins = async () => {
    setIsLoading(true);
    try {
      const result = await api.searchPlugins({ query: search, category });
      setPlugins(result);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInstall = async (plugin: Plugin) => {
    // Install via API
    const { bundleUrl } = await api.installPlugin(plugin.id, plugin.latestVersion);

    // Dynamically import and load the plugin
    const module = await import(/* @vite-ignore */ bundleUrl);
    await loadPlugin(module.manifest, module);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-xl font-semibold">Plugin Marketplace</h2>
          <button onClick={onClose} aria-label="Close">
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Search and Filters */}
        <div className="p-4 border-b">
          <input
            type="search"
            placeholder="Search plugins..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-3 py-2 border rounded-lg"
          />
          <div className="flex gap-2 mt-2">
            {['formatting', 'appearance', 'utilities'].map(cat => (
              <button
                key={cat}
                onClick={() => setCategory(category === cat ? null : cat)}
                className={`px-3 py-1 rounded-full text-sm ${
                  category === cat ? 'bg-blue-500 text-white' : 'bg-gray-100'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Plugin List */}
        <div className="overflow-y-auto max-h-96">
          {isLoading ? (
            <div className="p-8 text-center">Loading...</div>
          ) : (
            <ul className="divide-y">
              {plugins.map(plugin => (
                <PluginCard
                  key={plugin.id}
                  plugin={plugin}
                  isInstalled={loadedPlugins.has(plugin.id)}
                  onInstall={() => handleInstall(plugin)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function PluginCard({ plugin, isInstalled, onInstall }) {
  return (
    <li className="p-4 flex items-start gap-4">
      <img src={plugin.iconUrl} alt="" className="w-12 h-12 rounded" />
      <div className="flex-1 min-w-0">
        <h3 className="font-medium">{plugin.name}</h3>
        <p className="text-sm text-gray-500 truncate">{plugin.description}</p>
        <div className="flex items-center gap-2 mt-1 text-sm text-gray-400">
          <span>{plugin.installCount} installs</span>
          <span>v{plugin.latestVersion}</span>
        </div>
      </div>
      <button
        onClick={onInstall}
        disabled={isInstalled}
        className={`px-4 py-2 rounded-lg ${
          isInstalled
            ? 'bg-green-100 text-green-700'
            : 'bg-blue-500 text-white hover:bg-blue-600'
        }`}
      >
        {isInstalled ? 'Installed' : 'Install'}
      </button>
    </li>
  );
}
```

## Deep Dive 5: Dynamic Plugin Loading (5 minutes)

### Lazy Plugin Loader

```typescript
class PluginLoader {
  private loadingPlugins = new Map<string, Promise<PluginModule>>();

  async loadFromUrl(bundleUrl: string, pluginId: string): Promise<PluginModule> {
    // Prevent duplicate loads
    if (this.loadingPlugins.has(pluginId)) {
      return this.loadingPlugins.get(pluginId)!;
    }

    const loadPromise = this.doLoad(bundleUrl);
    this.loadingPlugins.set(pluginId, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.loadingPlugins.delete(pluginId);
    }
  }

  private async doLoad(bundleUrl: string): Promise<PluginModule> {
    // Dynamic import for ES modules
    const module = await import(/* @vite-ignore */ bundleUrl);

    // Validate module has required exports
    if (!module.manifest) {
      throw new Error('Plugin missing manifest export');
    }

    return module;
  }

  // Preload plugins for faster activation
  preload(bundleUrls: string[]): void {
    bundleUrls.forEach(url => {
      const link = document.createElement('link');
      link.rel = 'modulepreload';
      link.href = url;
      document.head.appendChild(link);
    });
  }
}
```

### Plugin Loading States

```typescript
interface PluginLoadingState {
  status: 'idle' | 'loading' | 'activating' | 'active' | 'error';
  error?: Error;
  progress?: number;
}

function usePluginLoader() {
  const [loadingStates, setLoadingStates] = useState<Map<string, PluginLoadingState>>(new Map());
  const loader = useRef(new PluginLoader());
  const { loadPlugin } = usePluginHost();

  const installPlugin = async (plugin: MarketplacePlugin) => {
    const pluginId = plugin.id;

    // Update state: loading
    setLoadingStates(prev => new Map(prev).set(pluginId, { status: 'loading' }));

    try {
      // Fetch bundle
      const module = await loader.current.loadFromUrl(plugin.bundleUrl, pluginId);

      // Update state: activating
      setLoadingStates(prev => new Map(prev).set(pluginId, { status: 'activating' }));

      // Activate plugin
      await loadPlugin(module.manifest, module);

      // Update state: active
      setLoadingStates(prev => new Map(prev).set(pluginId, { status: 'active' }));
    } catch (error) {
      // Update state: error
      setLoadingStates(prev => new Map(prev).set(pluginId, {
        status: 'error',
        error: error as Error
      }));
      throw error;
    }
  };

  return { installPlugin, loadingStates };
}
```

## Deep Dive 6: Accessibility (3 minutes)

### Plugin Container ARIA Attributes

```typescript
function SlotRenderer({ slotName }: { slotName: string }) {
  // ARIA landmarks based on slot type
  const ariaAttributes: Record<string, object> = {
    toolbar: { role: 'toolbar', 'aria-label': 'Editor tools' },
    canvas: { role: 'main', 'aria-label': 'Editor canvas' },
    sidebar: { role: 'complementary', 'aria-label': 'Plugin sidebar' },
    statusbar: { role: 'status', 'aria-live': 'polite' },
    modal: { role: 'dialog', 'aria-modal': 'true' },
  };

  return (
    <div
      className={`slot slot-${slotName}`}
      {...ariaAttributes[slotName]}
    >
      {/* Plugin contributions */}
    </div>
  );
}
```

### Keyboard Navigation

```typescript
// Plugin SDK provides keyboard navigation utilities
export const KeyboardUtils = {
  trapFocus(container: HTMLElement) {
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;

    container.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  },
};
```

## Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| Plugin Execution | In-process (main thread) | Web Workers | Direct DOM access, simpler React rendering |
| Communication | Event Bus + State Manager | Single mechanism | Different patterns for different needs |
| Component Rendering | React Context | Web Components | Consistent with host app, familiar DX |
| Plugin Loading | Dynamic import() | Script tags | ES module support, tree shaking |
| Slot Positioning | Named slots | Free-form injection | Predictable layout, plugin isolation |
| Error Handling | Error Boundaries | Try-catch wrappers | React-native, graceful degradation |

## Future Frontend Enhancements

1. **Plugin Settings UI**: Auto-generated settings forms from manifest schema
2. **Drag & Drop Reordering**: Allow users to reorder toolbar items
3. **Plugin Hot Reload**: Update plugins without full page refresh
4. **Keyboard Shortcuts**: Register and manage plugin keybindings
5. **Theme Integration**: Plugin components inherit theme tokens
6. **Undo/Redo Integration**: Plugin actions participate in global undo stack
7. **Mobile Responsive**: Collapsible sidebar, touch-friendly toolbar
