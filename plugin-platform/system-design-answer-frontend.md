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

---

## High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Plugin Host                                 │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                        Slot System                              │  │
│  │  ┌─────────┐  ┌─────────────────────────┐  ┌─────────────────┐ │  │
│  │  │ toolbar │  │        canvas           │  │     sidebar     │ │  │
│  │  │  slot   │  │         slot            │  │      slot       │ │  │
│  │  └────┬────┘  └────────────┬────────────┘  └────────┬────────┘ │  │
│  └───────┼────────────────────┼────────────────────────┼──────────┘  │
│          │                    │                        │             │
│  ┌───────┴────────────────────┴────────────────────────┴──────────┐  │
│  │                    Event Bus + State Manager                    │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
            │                    │                        │
    ┌───────┴───────┐   ┌───────┴───────┐      ┌─────────┴─────────┐
    │  Font Plugin  │   │ Editor Plugin │      │    Paper Plugin   │
    │               │   │               │      │                   │
    │ - Font picker │   │ - Textarea    │      │ - Checkered       │
    │ - Size slider │   │ - Text state  │      │ - Ruled / Plain   │
    └───────────────┘   └───────────────┘      └───────────────────┘
```

---

## Deep Dive 1: Slot System Architecture (8 minutes)

### Named Slot Regions

```
┌─────────────────────────────────────────────────────────────────────┐
│                          [toolbar slot]                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐             ┌──────────┐   │
│  │ Font     │ │ Size     │ │ Paper    │             │ Theme    │   │
│  │ Selector │ │ Selector │ │ Selector │             │ Toggle   │   │
│  └──────────┘ └──────────┘ └──────────┘             └──────────┘   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                         [canvas slot]                                │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │ Paper Background (z-index: 0)                                 │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │ Text Editor (z-index: 1)                                │  │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
├─────────────────────────────────────────────────────────────────────┤
│                        [statusbar slot]                              │
│  Words: 9  |  Characters: 44  |  Lines: 1                           │
└─────────────────────────────────────────────────────────────────────┘
```

### Slot Configuration

| Slot | Layout | Purpose |
|------|--------|---------|
| `toolbar` | Horizontal flexbox | Controls, selectors, buttons |
| `canvas` | Stacked (z-index) | Paper background, text editor |
| `sidebar` | Vertical flexbox | Settings, info panels |
| `statusbar` | Horizontal flexbox | Stats, status info |
| `modal` | Portal overlay | Dialog overlays |

### SlotRenderer Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       SlotRenderer Component                         │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  1. Collect contributions from loadedPlugins                   │  │
│  │     - Filter by slotName                                        │  │
│  │     - Sort by order (lower = first)                            │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  2. Apply slot-specific layout styles                          │  │
│  │     - toolbar: flex-row, gap, border-b                         │  │
│  │     - canvas: relative, flex-1                                  │  │
│  │     - sidebar: flex-col, fixed width                           │  │
│  │     - statusbar: flex-row, text-sm                              │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                              │                                       │
│                              ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  3. Render each contribution wrapped in ErrorBoundary          │  │
│  │     - Isolate plugin failures                                   │  │
│  │     - Pass context to each component                            │  │
│  │     - Display error message if plugin crashes                   │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deep Dive 2: Plugin Host and Context API (8 minutes)

### PluginHost React Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                     PluginHostProvider                               │
│                                                                      │
│  ┌──────────────────────────────┬───────────────────────────────┐   │
│  │          State               │           Refs                │   │
│  ├──────────────────────────────┼───────────────────────────────┤   │
│  │  loadedPlugins: Map          │  eventBusRef: EventBus        │   │
│  │  isLoading: boolean          │  stateManagerRef: StateManager│   │
│  └──────────────────────────────┴───────────────────────────────┘   │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    Provided Methods                             │  │
│  │                                                                 │  │
│  │  loadPlugin(manifest, module)                                   │  │
│  │    1. Create context for plugin                                 │  │
│  │    2. Call module.activate(context)                             │  │
│  │    3. Collect slot contributions                                │  │
│  │    4. Add to loadedPlugins Map                                  │  │
│  │                                                                 │  │
│  │  unloadPlugin(pluginId)                                         │  │
│  │    1. Call module.deactivate()                                  │  │
│  │    2. Remove from loadedPlugins                                 │  │
│  │                                                                 │  │
│  │  getContext(pluginId) ──▶ PluginContext                        │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### PluginContext API

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PluginContext                                 │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐  │
│  │     events      │  │      state      │  │      storage        │  │
│  ├─────────────────┤  ├─────────────────┤  ├─────────────────────┤  │
│  │ emit(event,     │  │ get(key)        │  │ get(key)            │  │
│  │      data)      │  │ set(key, value) │  │ set(key, value)     │  │
│  │ on(event,       │  │ subscribe(key,  │  │                     │  │
│  │    handler)     │  │    handler)     │  │ localStorage-backed │  │
│  │                 │  │                 │  │ per-plugin namespace│  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │                        commands                                  │ │
│  │  register(id, handler)     execute(id)                          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

"I designed the PluginContext to provide plugins with a sandboxed set of capabilities - events for notifications, state for shared data, and storage for persistence."

---

## Deep Dive 3: Event Bus and State Manager (6 minutes)

### Event Bus Implementation

```
┌─────────────────────────────────────────────────────────────────────┐
│                          EventBus                                    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  handlers: Map<string, Set<EventHandler>>                       │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  emit(event, data)                                               │ │
│  │    - Get handlers for event                                      │ │
│  │    - Execute each via queueMicrotask (async, non-blocking)      │ │
│  │    - Catch errors per handler (don't break others)              │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  on(event, handler) ──▶ returns unsubscribe function            │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### State Manager with Reactive Subscriptions

```
┌─────────────────────────────────────────────────────────────────────┐
│                        StateManager                                  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  state: Map<string, unknown>                                    │  │
│  │  subscribers: Map<string, Set<StateHandler>>                    │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  set(key, value)                                                 │ │
│  │    - Skip if value unchanged (===)                              │ │
│  │    - Update state Map                                            │ │
│  │    - Notify subscribers via queueMicrotask                      │ │
│  │    - Pass (newValue, oldValue) to handlers                      │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  batch(updates) - Apply multiple state changes at once          │ │
│  │  getSnapshot() - Return full state for debugging/persistence   │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Plugin Communication Flow

```
┌────────────────────┐     state.set('format.font')     ┌────────────────────┐
│    Font Plugin     │─────────────────────────────────▶│    State Manager   │
│                    │                                  │                    │
│  FontSelector.tsx  │                                  │  state: Map        │
└────────────────────┘                                  │  subscribers: Map  │
                                                        └─────────┬──────────┘
                                                                  │
                                                        notify subscribers
                                                                  │
                                                                  ▼
┌────────────────────┐     subscribe('format.font')     ┌────────────────────┐
│   Editor Plugin    │◀─────────────────────────────────│   State Manager    │
│                    │                                  │                    │
│  TextEditor.tsx    │     callback(newFont)            │                    │
│  - Update style    │                                  │                    │
└────────────────────┘                                  └────────────────────┘
```

---

## Deep Dive 4: Marketplace UI (6 minutes)

### Marketplace Modal Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      MarketplaceModal                                │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Header: "Plugin Marketplace" + Close button                   │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Search & Filters                                               │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │  <input type="search" placeholder="Search plugins..." /> │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  │  ┌────────────┐ ┌─────────────┐ ┌────────────┐                 │  │
│  │  │ formatting │ │ appearance  │ │ utilities  │  (category btns)│  │
│  │  └────────────┘ └─────────────┘ └────────────┘                 │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Plugin List (scrollable)                                       │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │  ┌────┐                                                  │  │  │
│  │  │  │icon│ Plugin Name          [Install] / [Installed]    │  │  │
│  │  │  └────┘ Description text...                              │  │  │
│  │  │         500 installs | v1.2.0                            │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │  (repeat for each plugin)                                 │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Install Flow

```
┌────────────────┐   click Install   ┌────────────────┐
│  PluginCard    │──────────────────▶│  handleInstall │
└────────────────┘                   └───────┬────────┘
                                             │
                    ┌────────────────────────┤
                    │                        │
                    ▼                        ▼
           ┌────────────────┐      ┌────────────────────┐
           │ api.install()  │      │  dynamic import()  │
           │ Get bundleUrl  │─────▶│  Load ES module    │
           └────────────────┘      └─────────┬──────────┘
                                             │
                                             ▼
                                   ┌────────────────────┐
                                   │ loadPlugin(        │
                                   │   module.manifest, │
                                   │   module)          │
                                   └────────────────────┘
```

---

## Deep Dive 5: Dynamic Plugin Loading (5 minutes)

### PluginLoader Class

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PluginLoader                                  │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  loadingPlugins: Map<string, Promise<PluginModule>>             │  │
│  │  (prevents duplicate concurrent loads)                          │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  loadFromUrl(bundleUrl, pluginId)                                │ │
│  │    1. Check if already loading ──▶ return existing promise      │ │
│  │    2. Start load, add to Map                                     │ │
│  │    3. await import(bundleUrl)                                    │ │
│  │    4. Validate module.manifest exists                            │ │
│  │    5. Remove from Map, return module                             │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  preload(bundleUrls: string[])                                   │ │
│  │    - Create <link rel="modulepreload"> for each URL             │ │
│  │    - Speeds up subsequent activation                             │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### Loading State Machine

```
┌─────────┐     load      ┌───────────┐    activate    ┌─────────────┐
│  idle   │──────────────▶│  loading  │───────────────▶│  activating │
└─────────┘               └───────────┘                └──────┬──────┘
                               │                              │
                               │ error                        │ success
                               ▼                              ▼
                          ┌─────────┐                  ┌────────────┐
                          │  error  │                  │   active   │
                          └─────────┘                  └────────────┘
```

---

## Deep Dive 6: Accessibility (3 minutes)

### ARIA Landmarks by Slot

| Slot | Role | aria-label |
|------|------|------------|
| toolbar | toolbar | "Editor tools" |
| canvas | main | "Editor canvas" |
| sidebar | complementary | "Plugin sidebar" |
| statusbar | status | (aria-live="polite") |
| modal | dialog | (aria-modal="true") |

### Keyboard Navigation Utilities

```
┌─────────────────────────────────────────────────────────────────────┐
│                      KeyboardUtils.trapFocus                         │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Query all focusable elements in container                       │ │
│  │  (button, [href], input, select, textarea, [tabindex])          │ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  On Tab keydown:                                                 │ │
│  │    - If Shift+Tab on first element ──▶ focus last               │ │
│  │    - If Tab on last element ──▶ focus first                     │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Trade-offs Summary

| Decision | Chose | Alternative | Rationale |
|----------|-------|-------------|-----------|
| Plugin Execution | In-process (main thread) | Web Workers | Direct DOM access, simpler React rendering |
| Communication | Event Bus + State Manager | Single mechanism | Different patterns for different needs |
| Component Rendering | React Context | Web Components | Consistent with host app, familiar DX |
| Plugin Loading | Dynamic import() | Script tags | ES module support, tree shaking |
| Slot Positioning | Named slots | Free-form injection | Predictable layout, plugin isolation |
| Error Handling | Error Boundaries | Try-catch wrappers | React-native, graceful degradation |

---

## Future Frontend Enhancements

1. **Plugin Settings UI**: Auto-generated settings forms from manifest schema
2. **Drag & Drop Reordering**: Allow users to reorder toolbar items
3. **Plugin Hot Reload**: Update plugins without full page refresh
4. **Keyboard Shortcuts**: Register and manage plugin keybindings
5. **Theme Integration**: Plugin components inherit theme tokens
6. **Undo/Redo Integration**: Plugin actions participate in global undo stack
7. **Mobile Responsive**: Collapsible sidebar, touch-friendly toolbar
