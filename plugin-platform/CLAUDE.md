# Pluggable Text Editor - Development Notes

## Project Context

Building a pluggable text editor where **everything is a plugin** to explore plugin architecture patterns.

**Key Learning Goals:**
- Design a slot-based contribution system
- Build loosely-coupled plugin communication
- Implement plugin lifecycle management
- Create composable UI from independent plugins

---

## Design Decisions

### 1. In-Process Plugins (No Web Workers)

**Decision**: Plugins run in the main thread, not Web Workers.

**Rationale**:
- Plugins need direct DOM access for UI rendering
- React components can't easily run in workers
- This is a learning project with bundled plugins (no untrusted code)
- Simpler development and debugging

**Trade-off**: Less isolation, but acceptable for this use case.

### 2. Slot System

**Decision**: Named slots with declarative contributions.

**Rationale**:
- Plugins don't need to know about each other
- Order can be controlled via manifest
- Familiar pattern (Vue slots, Web Components)

### 3. Event Bus + Shared State

**Decision**: Use both mechanisms.

**Rationale**:
- **State**: For persistent values (font, theme, content)
- **Events**: For transient notifications (content changed)
- Plugins choose the appropriate mechanism

---

## Implementation History

### Phase 1: Architecture Pivot
- Transformed from VS Code-style extension marketplace to pluggable text editor
- Designed slot system with toolbar, canvas, sidebar, statusbar, modal slots
- Created plugin context API with events, state, storage, commands

### Phase 2: Core Infrastructure
- Implemented `EventBus` class for pub/sub communication
- Implemented `StateManager` class for reactive shared state
- Created `PluginHost` React context for plugin loading
- Created `Slot` component for rendering contributions

### Phase 3: Plugins
Implemented 5 bundled plugins:

1. **paper-background**: 6 paper styles (plain, ruled, checkered, dotted, graph, legal)
2. **font-selector**: 7 font families + size selector
3. **text-editor**: Actual textarea with auto-save to localStorage
4. **word-count**: Real-time word/character/line counts
5. **theme**: Light/dark mode with system preference detection

---

## Plugin Communication Examples

### Font Plugin → Editor Plugin
```
Font Selector                    Text Editor
    │                                │
    ├── state.set('format.font')────▶│
    │                                │ subscribe('format.font')
    │                                │     └── Update textarea style
```

### Editor Plugin → Word Count Plugin
```
Text Editor                      Word Count
    │                                │
    ├── state.set('editor.content')─▶│
    │                                │ subscribe('editor.content')
    │                                │     └── Recalculate counts
```

---

## Future Ideas

- **Markdown Preview Plugin**: Split view with rendered markdown
- **Export Plugin**: Download as .txt, .md, .html
- **Auto-save Plugin**: Periodic save to server/cloud
- **Focus Mode Plugin**: Dim everything except current paragraph
- **Typewriter Sounds Plugin**: Audio feedback while typing
- **Spell Check Plugin**: Highlight misspelled words
- **Find & Replace Plugin**: Search functionality in sidebar

---

## Resources

- [VS Code Extension API](https://code.visualstudio.com/api) - Inspiration for contribution system
- [Zustand](https://github.com/pmndrs/zustand) - State management patterns
- [Web Components Slots](https://developer.mozilla.org/en-US/docs/Web/Web_Components/Using_templates_and_slots) - Slot concept
