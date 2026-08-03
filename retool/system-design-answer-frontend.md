# System Design: No-Code Internal Tool Builder (Frontend Focus)

## 🎯 1. Requirements Clarification

> "We are designing the frontend for a visual tool builder -- think Retool or Appsmith. Users compose internal applications by dragging components from a palette onto a grid canvas, configuring properties through an inspector panel, writing SQL queries, and binding query results to component props. The core frontend challenges are the drag-and-drop system, grid layout engine, binding UI, and widget rendering."

**Functional Requirements:**
- Three-pane editor: component palette, canvas, property inspector
- Drag-and-drop from palette to canvas with grid snapping
- Dynamic widget rendering based on component type
- Binding input with `{{ }}` syntax highlighting
- Query panel with SQL editor and results table
- Preview mode rendering all components with resolved bindings

**Non-Functional Requirements:**
- Smooth drag-and-drop at 60fps
- Editor loads in < 2s
- Support apps with 100+ components without jank
- Auto-save within 500ms of changes

---

## 🏗️ 2. Frontend Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Editor Layout                                │
│  ┌────────────┐  ┌──────────────────────────┐  ┌─────────────────┐  │
│  │ Component   │  │     Canvas Area          │  │  Property       │  │
│  │ Palette     │  │  ┌─────┐  ┌──────────┐  │  │  Inspector      │  │
│  │             │  │  │Table│  │ TextInput │  │  │                 │  │
│  │  Table      │  │  └─────┘  └──────────┘  │  │  [Label]        │  │
│  │  Button     │  │  ┌─────┐                │  │  [Placeholder]  │  │
│  │  TextInput  │  │  │Chart│                │  │  [Default Val]  │  │
│  │  Text       │  │  └─────┘                │  │                 │  │
│  │  Select     │  │                          │  │  {{ binding }}  │  │
│  │  Chart      │  │     (12-column grid)     │  │                 │  │
│  │  ...        │  │                          │  │                 │  │
│  │             │  │                          │  │                 │  │
│  └────────────┘  └──────────────────────────┘  └─────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────┐│
│  │                     Query Panel                                  ││
│  │  [query1] [query2]  │  SQL Editor    │  Results Table            ││
│  └──────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🧠 3. State Management

> "I chose Zustand over Redux for three reasons: less boilerplate, simpler async handling, and easier TypeScript integration. The state is split into three stores."

### Store Architecture

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Auth Store      │  │  Editor Store    │  │  Data Store      │
│                  │  │                  │  │                  │
│  user            │  │  app             │  │  dataSources     │
│  loading         │  │  isDirty         │  │  queryResults    │
│  login()         │  │  selectedId      │  │  queryLoading    │
│  logout()        │  │  addComponent()  │  │  componentValues │
│  checkAuth()     │  │  updateComponent │  │  executeQuery()  │
│                  │  │  moveComponent() │  │  getContext()    │
│                  │  │  selectQuery()   │  │                  │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

**Editor Store**: Owns the app state (components, queries), selection state, and all mutation methods. When a component is added, moved, resized, or its props are updated, the store creates a new immutable app snapshot and marks `isDirty = true`.

**Data Store**: Owns query results, data source list, and component runtime values. The binding context is derived from this store -- it combines query results (`query1.data`) with component values (`textInput1.value`) into a flat context object.

**Why separate stores?** The editor state changes on every user interaction (drag, select, type). The data state changes on query execution. Keeping them separate prevents unnecessary re-renders -- the canvas does not re-render when a query completes unless a component is bound to that query's data.

### Dirty State and Auto-Save

> "The isDirty flag is the trigger for auto-save. When any mutation occurs -- adding a component, changing a prop, moving a widget -- the editor store sets isDirty to true. A debounced save function watches this flag and sends the full app state to the server after 500ms of inactivity. This ensures frequent saves without flooding the API during rapid editing sessions like dragging components around the canvas."

The auto-save callback sends the entire component tree, queries, and layout in one PUT request. If the save fails, isDirty remains true and the save retries on the next debounce cycle. A visual indicator in the toolbar shows "Saving..." during the API call and "Saved" on success, giving users confidence that their work is persisted.

---

## 🖱️ 4. Drag-and-Drop System

> "I chose @dnd-kit/core over react-beautiful-dnd for two reasons: it is actively maintained (react-beautiful-dnd is deprecated), and it supports freeform positioning alongside sortable lists."

### Drag Flow

```
Palette (Draggable)          Canvas (Droppable)
┌──────────────┐             ┌──────────────────────┐
│  [Table]  ───┼── drag ────▶│                      │
│  [Button]    │             │    drop here          │
│  [Input]     │             │                      │
└──────────────┘             └──────────────────────┘
                                     │
                              Calculate grid position
                              from pointer coordinates
                                     │
                              addComponent(definition, { x, y })
```

1. **DragStart**: Identify which component definition is being dragged. Show a `DragOverlay` with the component's icon and label.

2. **DragEnd**: Check if the drop target is the canvas (`over.id === 'canvas'`). Calculate the grid position from the pointer coordinates:
   - `gridCol = Math.floor((pointerX - canvasLeft) / 80)`
   - `gridRow = Math.floor((pointerY - canvasTop) / 40)`

3. **Component creation**: Call `editorStore.addComponent(definition, { x: gridCol, y: gridRow })` which creates an `AppComponent` with default props, the calculated position, and auto-generated width/height based on component type.

### Collision Detection and Overlap Handling

> "Unlike a typical list-based drag-and-drop, a no-code builder canvas permits overlapping components. A button can sit on top of a container, or a text label can overlay a chart. This means we do not implement collision detection to prevent overlap -- instead, the canvas uses z-index ordering based on component creation time. Later components render on top of earlier ones. If we needed strict no-overlap enforcement, we would maintain a grid occupancy matrix and reject placements that collide with existing components."

### Grid Layout

> "The canvas uses a 12-column grid with 80px column width and 40px row height. Components are positioned absolutely within the canvas using CSS."

```
position: absolute;
left: component.position.x * 80px;
top:  component.position.y * 40px;
width: component.position.w * 80px;
height: component.position.h * 40px;
```

**Why absolute positioning over CSS Grid?** Components can overlap in a no-code builder (a button on top of a container). CSS Grid does not support overlapping grid items. Absolute positioning gives us full control over z-ordering and allows components to be placed at any grid coordinate independently.

**Default sizes by component type**:

| Component | Width (cols) | Height (rows) |
|-----------|-------------|---------------|
| Table | 12 | 8 |
| Chart | 6 | 6 |
| Text Input | 4 | 2 |
| Button | 4 | 2 |
| Text | 4 | 2 |
| Container | 6 | 4 |

---

## 🧩 5. Widget Rendering

> "The widget renderer dynamically maps a component's `type` string to a React component. This is the core of the component model -- adding a new widget type requires only a new React component and an entry in the registry."

### Renderer Architecture

```
 WidgetRenderer
  ├── component.type === 'table'    ──▶ TableWidget
  ├── component.type === 'button'   ──▶ ButtonWidget
  ├── component.type === 'textInput'──▶ TextInputWidget
  ├── component.type === 'text'     ──▶ TextWidget
  ├── component.type === 'chart'    ──▶ ChartWidget
  ├── component.type === 'form'     ──▶ FormWidget
  └── component.type === ???        ──▶ "Unknown" fallback
```

Each widget receives:
- `component`: The AppComponent with props, position, and bindings
- `isEditor`: Boolean flag -- in editor mode, inputs are read-only and buttons do not fire actions

### Widget Data Flow

```
Query Result                 Binding Engine           Widget
{ data: [...] }  ──store──▶  {{ query1.data }}  ──▶  TableWidget
                             resolveBindingValue()     renders rows
```

Widgets that display data (Table, Chart, Text) read from the data store's binding context. The `resolveBindingValue()` function evaluates binding expressions like `{{ query1.data }}` and returns the raw value (array for tables, string for text).

Widgets that capture input (TextInput, NumberInput, Select) write to the data store's `componentValues` map, making their values available in the binding context as `{{ textInput1.value }}`.

### Component Binding in the Property Inspector

> "The property inspector is where users connect data to components. Each prop in the component's schema gets a corresponding input control in the inspector. String props get text inputs, boolean props get toggle switches, number props get number inputs. But the critical feature is that any prop marked as `bindable` in the registry gets a BindingInput instead of a plain input."

When a user types `{{ query1.data }}` into a bindable prop field, the inspector stores both the raw expression text (in the component's bindings map) and the expression as the prop value. At render time, the widget renderer resolves the binding expression against the current data context and passes the resolved value to the widget. This two-layer approach -- expression storage plus runtime resolution -- means the inspector always shows the expression the user wrote, while the widget always shows the resolved data.

---

## 🔧 6. Deep Dive: Binding Input UI

> "The binding input is the most nuanced UI component. It must serve as a regular text input for static values AND highlight `{{ }}` expressions to indicate data bindings."

### Highlighting Approach

```
Input value: "Hello {{ query1.data[0].name }}"

Parsed segments:
  [
    { text: "Hello ",                     isBinding: false },
    { text: "{{ query1.data[0].name }}", isBinding: true  }
  ]
```

The `getBindingSegments()` utility splits the input text using a regex and returns segments tagged as binding or plain text. Binding segments are rendered with a purple color and a light purple background, visually distinguishing them from static text.

**Implementation challenge**: HTML inputs cannot have mixed styling within their value. The approach uses a transparent input layered over a styled div that renders the highlighted segments. The user types in the input; the overlay provides visual feedback.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Overlay div + transparent input | Simple, standard input behavior | Scroll sync issues on long text |
| ❌ ContentEditable div | Full styling control | Complex cursor management, XSS risk |
| ❌ Monaco Editor | Full syntax highlighting | Heavy dependency, overkill for single props |
| ❌ Color the entire input | Trivial | Cannot distinguish bound vs unbound text |

> "I chose the overlay approach for its simplicity. The input remains a standard HTML input with full keyboard support (selection, copy/paste, undo). The overlay div provides visual feedback. The trade-off is that very long binding expressions may not scroll in sync with the input, but for typical prop values (under 100 characters) this is not an issue."

---

## 🔧 7. Deep Dive: Canvas Interaction Design

> "The canvas needs to support selecting, moving, resizing, and deleting components. Each interaction must feel immediate and predictable."

### Selection

Clicking a component selects it (blue ring highlight). Clicking the canvas background deselects. The property inspector shows the selected component's props.

### Move and Resize Controls

When a component is selected, arrow buttons appear below it for movement, and +W/-W/+H/-H buttons for resizing. These modify the component's `position` object in the editor store.

**Why button controls instead of drag handles?** Drag handles would be more intuitive but create a conflict with the palette-to-canvas drag-and-drop. @dnd-kit/core uses a single DndContext, and nested draggable behavior (drag to move a component that is inside a droppable canvas) is complex to coordinate. Button controls are simpler and more precise for grid-based layouts.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Button controls | Simple, precise, no DnD conflict | Less intuitive, more clicks |
| ❌ Drag handles | Natural, mouse-driven | Complex DnD nesting, grid snapping math |
| ❌ CSS resize property | Zero JS for resize | Limited styling, no grid snapping |

> "For a learning project, button controls demonstrate the concept clearly. In production Retool, drag handles with throttled grid snapping provide a better UX, but the underlying state management is identical -- both update `component.position` in the store."

### Delete

A red "x" button appears at the top-right corner of selected components. Clicking it calls `removeComponent(id)`, which filters the component from the app's component array.

### Keyboard Shortcuts

> "Beyond mouse-driven interactions, the editor supports keyboard shortcuts for common operations. Arrow keys move the selected component by one grid unit, Delete/Backspace removes the selected component, and Escape deselects. These shortcuts are registered as global key event listeners that check for a selected component before acting. Keyboard support is especially important for accessibility and for power users who prefer keyboard-driven workflows."

---

## 🔧 8. Deep Dive: Query Panel Design

> "The query panel is a mini-IDE at the bottom of the editor. It must support writing SQL, selecting a data source, running queries, and viewing results."

### Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [query1*] [query2]  │  Name: [query1]  Source: [SampleDB v]    │
│                      │  Trigger: [Manual v]  [Run]              │
├──────────────────────┼──────────────────────────────────────────│
│  query list          │  SQL Editor        │  Results Table      │
│                      │  SELECT *          │  id | name | email  │
│  + Add Query         │  FROM customers    │  1  | Alice | ...   │
│  + Data Source       │  LIMIT 10          │  2  | Bob   | ...   │
└──────────────────────┴──────────────────────────────────────────┘
```

The left sidebar lists app queries. The center has a textarea for SQL. The right shows results as a scrollable table.

**Query triggers**: Each query has a trigger mode:
- `manual`: Runs only when the user clicks "Run" or a button triggers it
- `on_load`: Runs automatically when the app loads (preview mode)
- `on_change`: Runs when a bound input value changes

### Live Data Feedback Loop

> "The query panel creates a tight feedback loop for building data-driven apps. A user writes a SELECT query, clicks Run, sees the results in the table, then drags a Table widget onto the canvas and binds its data prop to `{{ query1.data }}`. The table immediately renders the query results. If the user modifies the query and re-runs it, the table updates in real time because the data store's query results change, triggering a re-render of all bound widgets."

This live feedback loop is what makes the no-code builder feel interactive rather than a static form editor. The data store acts as the reactive bridge -- query results flow into it, binding context is derived from it, and widgets subscribe to the slices they need. The entire cycle from query execution to widget re-render happens within a single React render pass after the data store update.

---

## 👁️ 9. Preview Mode

> "Preview mode renders the published app with live data. It differs from the editor in three ways: no selection UI, no property inspector, and input widgets are interactive."

### Preview Rendering Flow

1. Load published app version (or fall back to draft)
2. Load data sources
3. Execute all `on_load` queries automatically
4. Render all components using `WidgetRenderer` with `isEditor=false`
5. Input widgets update `componentValues` in the data store
6. Bound components re-render when query results change

### Component Lifecycle in Preview

```
on_load queries ──execute──▶ queryResults updated
                                  │
                                  ▼
Table (bound to query1.data) ── re-renders with data
Button (onClick: query2)    ── user clicks ── executes query2
                                  │
                                  ▼
Table (bound to query2.data) ── re-renders with new data
```

---

## 🗺️ 10. Routing

```
/                      ── App dashboard (list of apps)
/login                 ── Login page
/register              ── Registration page
/app/:appId/edit       ── Editor view (three-pane layout)
/app/:appId/preview    ── Preview mode (published app)
```

TanStack Router with file-based routing. The editor and preview routes use `$appId` dynamic segment to load the correct app.

---

## ⚡ 11. Performance Considerations

**Re-render optimization**: Zustand's selector pattern ensures components only re-render when their slice of state changes. The TableWidget subscribes to `getBindingContext()` and only re-renders when query results change.

**Canvas with 100+ components**: Each component is absolutely positioned, so the browser does not need to reflow the entire grid on changes. React keys ensure efficient DOM reconciliation.

**Query results**: Large result sets (1000+ rows) are paginated client-side. The TableWidget renders only the current page (default 10 rows).

**Bundle size management**: The component widget map uses static imports rather than dynamic imports because all widget types are loaded in the editor. In a production deployment with hundreds of widget types, code-splitting by widget category (data display, input, layout) would reduce initial bundle size. For the current nine widget types, static imports keep the loading waterfall simple.

**Rendering large JSONB documents**: When an app has hundreds of components, parsing and diffing the entire component array on every state update can become expensive. Zustand's immutable update pattern means React only diffs the virtual DOM for components whose props actually changed. The key optimization is that each WidgetRenderer instance reads its own component from the store using a selector keyed by component ID, so adding or modifying one component does not trigger re-renders for unrelated components.

**Drag-and-drop performance**: During a drag operation, the DragOverlay component renders a lightweight preview (icon and label only, not the full widget). This avoids the cost of rendering a complete TableWidget or ChartWidget during every mouse move event. The canvas droppable area uses pointer events for hit detection, which is more performant than tracking mousemove on every child component.

**Memory management for query results**: Query results can be large (thousands of rows with many columns). The data store holds results in memory for all executed queries. To prevent memory bloat when users run many queries during a session, old query results are evicted when a query is re-executed -- only the most recent result per query name is retained. For preview mode, results are cleared when the user navigates away from the app.

---

## 🧭 RADIO Data Model and Interfaces

The editor has three distinct data categories. The app definition and query configuration are server-originated and persisted. The selected component, dirty drafts, drag preview, and validation messages are client-only. Query results are server state with freshness and execution status, not part of the widget configuration itself.

| Entity | Owner | Important fields | Lifecycle |
|---|---|---|---|
| `AppDefinition` | App store | app ID, name, components, layout version | persisted server state |
| `WidgetConfig` | Canvas/widget registry | component ID, type, position, props, bindings | persisted server state |
| `QueryDefinition` | Query panel/store | query ID, SQL, parameters, trigger policy | persisted server state |
| `QueryResult` | Data layer | query ID, columns, rows, fetched time, error | cached server state |
| `BindingExpression` | Binding editor | source path, expression, validation status | draft then persisted |
| `EditorSession` | Shell | selected ID, dirty state, mode, active panel | ephemeral client state |

### Server-facing API

```
GET  /api/apps/:appId                         → app definition and widget configs
PUT  /api/apps/:appId                         → versioned app/layout update
POST /api/apps/:appId/queries/execute         → execute an authorized query
GET  /api/apps/:appId/queries/:queryId        → query metadata and latest result
POST /api/apps/:appId/publish                 → validate and publish an app version
```

The editor sends a version with layout mutations. A stale version returns a conflict and preserves the local draft. Query execution returns status, columns, rows, elapsed time, and a result version; the client never treats an old result as current merely because it arrived later.

### Client-facing interfaces

| Interface | Inputs | Output/event | Boundary |
|---|---|---|---|
| `WidgetRegistry` | widget type and version | renderer, editor, binding schema | widget code does not own persistence |
| `WidgetRenderer` | resolved props, dimensions, query state | rendered widget, interaction events | preview and edit modes share rendering |
| `BindingEditor` | expression, schema, query context | validated expression change | no arbitrary code execution |
| `QueryCoordinator` | query definition, trigger, cancellation | result or typed error | deduplicates and cancels execution |
| `Canvas` | widget configs, pointer/keyboard events | layout patch | optimistic local layout, debounced save |

This makes the key alternative explicit: a single widget switch is easier for nine widgets, while a registry pays off when teams add widget types independently. The registry is also where code splitting, capability checks, and fallback renderers belong.

## ⚖️ 12. Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| State management | Zustand (3 stores) | Redux, Context | Less boilerplate, selective re-renders |
| Drag-and-drop | @dnd-kit/core | react-beautiful-dnd | Actively maintained, freeform support |
| Grid positioning | Absolute CSS | CSS Grid | Supports overlapping, independent placement |
| Component movement | Button controls | Drag handles | Simpler, no DnD nesting conflicts |
| Binding highlight | Overlay div | ContentEditable, Monaco | Simple, standard input behavior |
| Chart rendering | SVG in React | Chart.js, D3 | Zero dependencies, sufficient for demo |
| Routing | TanStack Router | React Router | File-based, type-safe, integrated devtools |
| Auto-save | Debounced full-state PUT | Incremental patches | Simpler, no merge logic, idempotent |
