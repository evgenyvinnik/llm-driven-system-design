# Pluggable Text Editor - Architecture

## System Overview

A minimalist text editor where **everything is a plugin**. The core application provides only a plugin host and slot system—even the text input area itself is provided by a plugin. This extreme modularity demonstrates plugin architecture patterns and allows complete customization.

**Learning Goals:**
- Design a plugin slot/contribution system
- Build loosely-coupled plugin communication
- Implement plugin lifecycle management
- Create composable UI from independent plugins

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
5. **Plugin Settings**: Each plugin can have configurable options

### Non-Functional Requirements

- **Isolation**: Plugin failures don't crash the host
- **Performance**: Lazy loading, minimal overhead
- **Developer Experience**: Hot reload, easy debugging
- **Composability**: Plugins work independently and together

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

### Plugin API

Plugins receive a context object with available APIs:

```typescript
interface PluginContext {
  // Unique plugin ID
  pluginId: string;

  // Event bus for inter-plugin communication
  events: {
    emit: (event: string, data?: any) => void;
    on: (event: string, handler: (data: any) => void) => () => void;
  };

  // Shared editor state
  state: {
    get: <T>(key: string) => T | undefined;
    set: (key: string, value: any) => void;
    subscribe: (key: string, handler: (value: any) => void) => () => void;
  };

  // Plugin-specific storage (persisted)
  storage: {
    get: <T>(key: string) => Promise<T | undefined>;
    set: (key: string, value: any) => Promise<void>;
  };

  // Command registration
  commands: {
    register: (id: string, handler: () => void) => void;
    execute: (id: string) => void;
  };
}
```

---

## Core Components

### 1. Plugin Host

The host manages plugin lifecycle and provides infrastructure:

```typescript
class PluginHost {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private slots: Map<string, SlotRenderer> = new Map();
  private eventBus: EventBus;
  private stateManager: StateManager;

  async loadPlugin(manifest: PluginManifest): Promise<void> {
    // 1. Validate manifest
    this.validateManifest(manifest);

    // 2. Load plugin module
    const module = await import(`/plugins/${manifest.id}/index.js`);

    // 3. Create plugin context
    const context = this.createContext(manifest.id);

    // 4. Initialize plugin
    if (module.activate) {
      await module.activate(context);
    }

    // 5. Register contributions
    this.registerContributions(manifest, module);

    this.plugins.set(manifest.id, { manifest, module, context });
  }

  private registerContributions(manifest: PluginManifest, module: any): void {
    // Register slot contributions
    for (const slot of manifest.contributes.slots || []) {
      const component = module[slot.component];
      if (component) {
        this.slots.get(slot.slot)?.register({
          pluginId: manifest.id,
          component,
          order: slot.order ?? 100
        });
      }
    }

    // Register commands
    for (const cmd of manifest.contributes.commands || []) {
      this.commandRegistry.register(cmd.id, module[cmd.handler]);
    }
  }
}
```

### 2. Slot System

Slots are named regions where plugins contribute UI:

```typescript
interface SlotDefinition {
  id: string;
  layout: 'horizontal' | 'vertical' | 'stack' | 'single';
  allowMultiple: boolean;
}

const SLOTS: SlotDefinition[] = [
  { id: 'toolbar', layout: 'horizontal', allowMultiple: true },
  { id: 'canvas', layout: 'stack', allowMultiple: true },
  { id: 'sidebar', layout: 'vertical', allowMultiple: true },
  { id: 'statusbar', layout: 'horizontal', allowMultiple: true },
  { id: 'modal', layout: 'single', allowMultiple: false }
];

// React component for rendering a slot
function Slot({ id }: { id: string }) {
  const contributions = useSlotContributions(id);
  const layout = SLOTS.find(s => s.id === id)?.layout;

  return (
    <div className={`slot slot-${id} layout-${layout}`}>
      {contributions
        .sort((a, b) => a.order - b.order)
        .map(contrib => (
          <contrib.component
            key={contrib.pluginId}
            context={contrib.context}
          />
        ))}
    </div>
  );
}
```

### 3. Event Bus

Decoupled plugin communication:

```typescript
class EventBus {
  private handlers: Map<string, Set<EventHandler>> = new Map();

  emit(event: string, data?: any): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(data);
        } catch (error) {
          console.error(`Event handler error for ${event}:`, error);
          // Don't let one plugin crash others
        }
      });
    }
  }

  on(event: string, handler: EventHandler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);

    // Return unsubscribe function
    return () => this.handlers.get(event)?.delete(handler);
  }
}

// Standard events that plugins can emit/subscribe to
const STANDARD_EVENTS = {
  // Editor content
  'editor:content-changed': { content: string },
  'editor:selection-changed': { start: number, end: number },

  // Formatting
  'format:font-changed': { fontFamily: string },
  'format:size-changed': { fontSize: number },

  // Theme
  'theme:paper-changed': { paperId: string },

  // Commands
  'command:execute': { commandId: string }
};
```

### 4. State Manager

Shared reactive state:

```typescript
class StateManager {
  private state: Map<string, any> = new Map();
  private subscribers: Map<string, Set<(value: any) => void>> = new Map();

  get<T>(key: string): T | undefined {
    return this.state.get(key);
  }

  set(key: string, value: any): void {
    const oldValue = this.state.get(key);
    if (oldValue !== value) {
      this.state.set(key, value);
      this.notifySubscribers(key, value);
    }
  }

  subscribe(key: string, handler: (value: any) => void): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(handler);

    // Immediately call with current value
    if (this.state.has(key)) {
      handler(this.state.get(key));
    }

    return () => this.subscribers.get(key)?.delete(handler);
  }
}

// Standard state keys
const STANDARD_STATE = {
  'editor.content': '',           // Current text content
  'editor.selection': null,       // Selection range
  'format.fontFamily': 'system',  // Current font
  'format.fontSize': 16,          // Font size in px
  'theme.paper': 'plain',         // Paper background style
};
```

---

## Bundled Plugins

The editor ships with these plugins enabled by default:

### 1. Text Editor Plugin (`@plugins/text-editor`)

Provides the actual text editing area:

```typescript
// manifest.json
{
  "id": "text-editor",
  "name": "Text Editor",
  "version": "1.0.0",
  "description": "Core text editing functionality",
  "contributes": {
    "slots": [
      { "slot": "canvas", "component": "TextEditor", "order": 50 }
    ]
  },
  "requires": {
    "state": ["format.fontFamily", "format.fontSize", "theme.paper"]
  }
}

// index.tsx
export function TextEditor({ context }: PluginProps) {
  const [content, setContent] = useState('');
  const fontFamily = useStateValue(context, 'format.fontFamily');
  const fontSize = useStateValue(context, 'format.fontSize');

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    context.state.set('editor.content', e.target.value);
    context.events.emit('editor:content-changed', { content: e.target.value });
  };

  return (
    <textarea
      className="editor-textarea"
      style={{ fontFamily, fontSize: `${fontSize}px` }}
      value={content}
      onChange={handleChange}
      placeholder="Start typing..."
    />
  );
}
```

### 2. Paper Background Plugin (`@plugins/paper-background`)

Provides different paper styles as backgrounds:

```typescript
// manifest.json
{
  "id": "paper-background",
  "name": "Paper Background",
  "version": "1.0.0",
  "description": "Choose different paper styles for your editor",
  "contributes": {
    "slots": [
      { "slot": "canvas", "component": "PaperBackground", "order": 0 },
      { "slot": "toolbar", "component": "PaperSelector", "order": 100 }
    ],
    "settings": [
      {
        "id": "defaultPaper",
        "type": "select",
        "default": "plain",
        "options": ["plain", "ruled", "checkered", "dotted"]
      }
    ]
  }
}

// Papers available
const PAPERS = {
  plain: {
    name: 'Plain',
    background: '#fff',
    pattern: 'none'
  },
  ruled: {
    name: 'Ruled',
    background: '#fffef0',
    pattern: 'repeating-linear-gradient(transparent, transparent 27px, #e0e0e0 28px)'
  },
  checkered: {
    name: 'Checkered',
    background: '#fff',
    pattern: `
      linear-gradient(90deg, #f0f0f0 1px, transparent 1px),
      linear-gradient(#f0f0f0 1px, transparent 1px)
    `,
    patternSize: '20px 20px'
  },
  dotted: {
    name: 'Dotted',
    background: '#fff',
    pattern: 'radial-gradient(#ccc 1px, transparent 1px)',
    patternSize: '20px 20px'
  }
};
```

### 3. Font Selector Plugin (`@plugins/font-selector`)

Provides font family and size selection:

```typescript
// manifest.json
{
  "id": "font-selector",
  "name": "Font Selector",
  "version": "1.0.0",
  "description": "Choose fonts and sizes for your text",
  "contributes": {
    "slots": [
      { "slot": "toolbar", "component": "FontSelector", "order": 10 }
    ],
    "settings": [
      { "id": "defaultFont", "type": "string", "default": "system-ui" },
      { "id": "defaultSize", "type": "number", "default": 16 }
    ]
  }
}

// Available fonts
const FONTS = [
  { id: 'system', name: 'System', value: 'system-ui, sans-serif' },
  { id: 'serif', name: 'Serif', value: 'Georgia, serif' },
  { id: 'mono', name: 'Monospace', value: 'Monaco, monospace' },
  { id: 'comic', name: 'Comic', value: 'Comic Sans MS, cursive' },
  { id: 'handwriting', name: 'Handwriting', value: 'Brush Script MT, cursive' }
];

const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48];
```

### 4. Word Count Plugin (`@plugins/word-count`)

Shows word and character count in statusbar:

```typescript
// manifest.json
{
  "id": "word-count",
  "name": "Word Count",
  "version": "1.0.0",
  "description": "Display word and character counts",
  "contributes": {
    "slots": [
      { "slot": "statusbar", "component": "WordCount", "order": 100 }
    ]
  },
  "requires": {
    "events": ["editor:content-changed"]
  }
}
```

### 5. Theme Plugin (`@plugins/theme`)

Provides light/dark mode toggle:

```typescript
// manifest.json
{
  "id": "theme",
  "name": "Theme Switcher",
  "version": "1.0.0",
  "description": "Toggle between light and dark mode",
  "contributes": {
    "slots": [
      { "slot": "toolbar", "component": "ThemeToggle", "order": 200 }
    ]
  }
}
```

---

## Application Layout

The host application defines the slot layout:

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
│  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  │
│  │ ░ Paper Background (z-index: 0)                         ░│  │
│  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│  │
│  │  ┌─────────────────────────────────────────────────────┐ │  │
│  │  │ Text Editor (z-index: 1)                            │ │  │
│  │  │                                                     │ │  │
│  │  │ The quick brown fox jumps over the lazy dog...     │ │  │
│  │  │                                                     │ │  │
│  │  └─────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                      [statusbar slot]                            │
│  Words: 9  |  Characters: 44                                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Plugin Communication Patterns

### Pattern 1: State-Based Communication

Plugins read/write shared state:

```typescript
// Font plugin sets font
context.state.set('format.fontFamily', 'Georgia, serif');

// Editor plugin reacts
context.state.subscribe('format.fontFamily', (fontFamily) => {
  textareaRef.current.style.fontFamily = fontFamily;
});
```

### Pattern 2: Event-Based Communication

For transient notifications:

```typescript
// Editor emits content changes
context.events.emit('editor:content-changed', { content: newContent });

// Word count plugin listens
context.events.on('editor:content-changed', ({ content }) => {
  setWordCount(content.split(/\s+/).filter(Boolean).length);
});
```

### Pattern 3: Command Execution

For user actions:

```typescript
// Theme plugin registers command
context.commands.register('theme.toggle', () => {
  const current = context.state.get('theme.mode');
  context.state.set('theme.mode', current === 'dark' ? 'light' : 'dark');
});

// Toolbar can execute it
<button onClick={() => context.commands.execute('theme.toggle')}>
  Toggle Theme
</button>
```

---

## Key Design Decisions

### 1. In-Process Plugins (No Web Workers)

**Decision**: Plugins run in the main thread, not Web Workers

**Rationale**:
- Plugins need direct DOM access for UI rendering
- React components can't easily run in workers
- Trust boundary is different (bundled plugins vs. user-installed)
- Performance acceptable for this use case

**Trade-off**: Less isolation, but simpler development

### 2. Slot System vs. Component Injection

**Decision**: Named slots with declarative contributions

**Rationale**:
- Plugins don't need to know about each other
- Order can be controlled via manifest
- Easy to reason about where UI appears
- Familiar pattern (similar to Vue slots, Web Components)

### 3. Event Bus + Shared State

**Decision**: Use both events and shared state

**Rationale**:
- State: For persistent values (font, theme, content)
- Events: For notifications (content changed, selection moved)
- Plugins choose appropriate mechanism
- Reactive state updates via subscriptions

---

## File Structure

```
plugin-platform/
├── frontend/
│   ├── src/
│   │   ├── core/
│   │   │   ├── PluginHost.tsx      # Plugin loading and management
│   │   │   ├── SlotRenderer.tsx    # Renders slot contributions
│   │   │   ├── EventBus.ts         # Pub/sub event system
│   │   │   ├── StateManager.ts     # Shared reactive state
│   │   │   └── types.ts            # TypeScript interfaces
│   │   ├── plugins/
│   │   │   ├── text-editor/        # Core text editing
│   │   │   ├── paper-background/   # Paper styles
│   │   │   ├── font-selector/      # Font controls
│   │   │   ├── word-count/         # Word statistics
│   │   │   └── theme/              # Dark/light mode
│   │   ├── App.tsx                 # Main layout with slots
│   │   └── main.tsx                # Entry point
│   └── package.json
├── architecture.md                  # This file
├── README.md                        # Setup instructions
└── claude.md                        # Development notes
```

---

## Future Plugin Ideas

- **Markdown Preview**: Render markdown as you type
- **Spell Check**: Highlight misspelled words
- **Auto Save**: Periodically save to localStorage
- **Export**: Download as .txt, .md, .pdf
- **Focus Mode**: Dim everything except current paragraph
- **Typewriter Sounds**: Play keyboard sounds
- **Reading Time**: Estimate time to read content
- **Find & Replace**: Search functionality
