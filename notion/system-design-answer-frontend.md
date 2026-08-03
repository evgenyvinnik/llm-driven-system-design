# Design Notion (Frontend Focus)

## 45-Minute Frontend Interview Answer

### 1. Requirements Clarification (3 minutes)

**Interviewer:** Design a block-based collaboration tool like Notion.

**Candidate:** I'll focus on the frontend architecture. Let me clarify the requirements:

**User-Facing Requirements:**
- Block-based rich text editor with multiple content types
- Real-time collaborative editing with presence indicators
- Hierarchical page navigation in sidebar
- Database views (table, board, list, calendar, gallery)
- Keyboard shortcuts and slash commands

**Technical Requirements:**
- Optimistic updates with instant feedback
- Virtual scrolling for large documents (10,000+ blocks)
- Offline-first with local persistence
- Responsive design for desktop and mobile
- Accessible to screen readers and keyboard users

**Key Interactions:**
- Typing and formatting text
- Drag-and-drop block reordering
- Slash command menu for block type conversion
- Real-time cursor and selection visibility

---

### 2. Component Architecture (5 minutes)

```
┌──────────────────────────────────────────────────────────────────────┐
│                            App Shell                                  │
├─────────────────────┬────────────────────────────────────────────────┤
│                     │                                                │
│      Sidebar        │              Main Content                      │
│  ┌──────────────┐   │  ┌────────────────────────────────────────┐   │
│  │ WorkspaceNav │   │  │           PageHeader                   │   │
│  ├──────────────┤   │  │  (title, icon, cover, breadcrumbs)     │   │
│  │  PageTree    │   │  ├────────────────────────────────────────┤   │
│  │  (recursive) │   │  │           BlockEditor                  │   │
│  ├──────────────┤   │  │  ┌──────────────────────────────────┐  │   │
│  │ QuickFind    │   │  │  │  VirtualizedBlockList            │  │   │
│  ├──────────────┤   │  │  │  ┌────────────────────────────┐  │  │   │
│  │ Favorites    │   │  │  │  │     BlockComponent         │  │  │   │
│  ├──────────────┤   │  │  │  │  (text/heading/list/...)   │  │  │   │
│  │ RecentPages  │   │  │  │  └────────────────────────────┘  │  │   │
│  └──────────────┘   │  │  └──────────────────────────────────┘  │   │
│                     │  ├────────────────────────────────────────┤   │
│                     │  │       PresenceIndicators               │   │
│                     │  └────────────────────────────────────────┘   │
└─────────────────────┴────────────────────────────────────────────────┘

Overlay Components:
┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
│   SlashCommandMenu │  │  BlockDragOverlay  │  │    ShareModal      │
└────────────────────┘  └────────────────────┘  └────────────────────┘
```

---

### 3. Block Editor Deep Dive (8 minutes)

#### Block Component Architecture

**Block Type Delegation Pattern:**
```
┌─────────────────────────────────────────────────────────────┐
│                     BlockComponent                           │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Focus management (useEffect on isSelected)              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           │                                  │
│                           v                                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │           Switch on block.type                          │ │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │ │
│  │  │  text   │ │ heading │ │  list   │ │  code   │  ...  │ │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           │                                  │
│                           v                                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Drag handle (visible on hover)                          │ │
│  │ Child blocks (indented, if present)                     │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Supported Block Types:**
| Type | Component | Description |
|------|-----------|-------------|
| text | TextBlock | Plain paragraph |
| heading1/2/3 | HeadingBlock | Section headings |
| bulleted_list | ListBlock | Bullet points |
| numbered_list | ListBlock | Numbered items |
| toggle | ToggleBlock | Collapsible content |
| code | CodeBlock | Syntax highlighted code |
| quote | QuoteBlock | Block quote |
| callout | CalloutBlock | Highlighted note |
| divider | DividerBlock | Horizontal rule |
| image | ImageBlock | Image upload |
| database | DatabaseBlock | Inline database |

#### Rich Text Editor

**RichText Data Structure:**
| Field | Type | Description |
|-------|------|-------------|
| text | string | The actual text content |
| annotations.bold | boolean | Bold formatting |
| annotations.italic | boolean | Italic formatting |
| annotations.underline | boolean | Underline formatting |
| annotations.strikethrough | boolean | Strikethrough |
| annotations.code | boolean | Inline code |
| annotations.color | string | Text color |
| href | string | Link URL (optional) |

**Editor Flow:**
```
┌────────────────┐     ┌────────────────┐     ┌────────────────┐
│ contentEditable│────>│ Convert HTML   │────>│ RichText[]     │
│ div            │     │ to RichText    │     │ onChange       │
└────────────────┘     └────────────────┘     └────────────────┘
        │
        v
┌────────────────┐     ┌────────────────┐
│ "/" keystroke  │────>│ Show Slash     │
│ detected       │     │ Command Menu   │
└────────────────┘     └────────────────┘
```

**Keyboard Shortcuts:**
| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl + B | Bold |
| Cmd/Ctrl + I | Italic |
| Cmd/Ctrl + U | Underline |
| / | Open slash command menu |

#### Slash Command Menu

**Available Commands:**
| Type | Label | Description |
|------|-------|-------------|
| text | Text | Just start writing with plain text |
| heading1 | Heading 1 | Big section heading |
| heading2 | Heading 2 | Medium section heading |
| heading3 | Heading 3 | Small section heading |
| bulleted_list | Bulleted List | Simple bulleted list |
| numbered_list | Numbered List | List with numbers |
| toggle | Toggle | Collapsible content |
| quote | Quote | Capture a quote |
| code | Code | Code snippet with syntax highlighting |
| callout | Callout | Make writing stand out |
| divider | Divider | Visual divider line |
| image | Image | Upload or embed an image |
| database | Database | Create a new database |

**Menu Behavior:**
- Filter commands as user types after "/"
- Arrow keys navigate selection
- Enter selects current command
- Escape closes menu
- Mouse hover updates selection

---

### 4. Virtual Scrolling for Large Documents (6 minutes)

**Architecture:**
```
┌─────────────────────────────────────────────────────────────┐
│                   VirtualizedBlockList                       │
├─────────────────────────────────────────────────────────────┤
│  1. Flatten nested blocks with depth tracking               │
│                                                              │
│  2. Configure @tanstack/react-virtual:                       │
│     - estimateSize based on block type                      │
│     - measureElement for actual heights                      │
│     - overscan: 5 items                                      │
│                                                              │
│  3. Render only visible items with transforms               │
└─────────────────────────────────────────────────────────────┘
```

**Height Estimates by Block Type:**
| Block Type | Estimated Height |
|------------|-----------------|
| heading1 | 48px |
| heading2 | 40px |
| heading3 | 36px |
| code | 80px + (lines * 24px) |
| image | 300px |
| divider | 24px |
| default | 32px |

**Keyboard Navigation (in block list):**
| Key | Action |
|-----|--------|
| Enter | Create new block after current |
| Backspace (empty block) | Delete block, focus previous |
| Arrow Up | Focus previous block |
| Arrow Down | Focus next block |
| Tab | Indent block |
| Shift + Tab | Outdent block |

---

### 5. Database Views (6 minutes)

#### Table View

**Structure:**
```
┌──────────────────────────────────────────────────────────────┐
│  Property Header Row                                          │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌───┐         │
│  │ Name │ │Status│ │ Date │ │ Tags │ │Person│ │ + │         │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └───┘         │
├──────────────────────────────────────────────────────────────┤
│  Data Rows (filtered and sorted)                              │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐               │
│  │ Task1│ │ Done │ │ 1/15 │ │ Tag1 │ │ @Bob │               │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘               │
│  ...                                                          │
├──────────────────────────────────────────────────────────────┤
│  [+ New]                                                      │
└──────────────────────────────────────────────────────────────┘
```

**View Configuration:**
- Visible properties (column selection)
- Property widths
- Sort configurations
- Filter rules

#### Board View (Kanban)

**Structure:**
```
┌───────────────────────────────────────────────────────────────────────┐
│  Board View                                                            │
├───────────┬───────────┬───────────┬───────────┬─────────────────────┤
│  To Do    │  In Prog  │  Review   │  Done     │  [+ Add Group]      │
│  (3)      │  (2)      │  (1)      │  (5)      │                     │
├───────────┼───────────┼───────────┼───────────┤                     │
│ ┌───────┐ │ ┌───────┐ │ ┌───────┐ │ ┌───────┐ │                     │
│ │ Card  │ │ │ Card  │ │ │ Card  │ │ │ Card  │ │                     │
│ └───────┘ │ └───────┘ │ └───────┘ │ └───────┘ │                     │
│ ┌───────┐ │ ┌───────┐ │           │ ┌───────┐ │                     │
│ │ Card  │ │ │ Card  │ │           │ │ Card  │ │                     │
│ └───────┘ │ └───────┘ │           │ └───────┘ │                     │
│ [+ New]   │ [+ New]   │ [+ New]   │ [+ New]   │                     │
└───────────┴───────────┴───────────┴───────────┴─────────────────────┘
```

**Features:**
- Group by select property
- Drag-and-drop between columns (via @dnd-kit)
- Drop zone highlighting
- Column-specific add button (pre-fills group value)

#### List View

**Structure:**
```
┌─────────────────────────────────────────────────────────────┐
│  List View                                                   │
├─────────────────────────────────────────────────────────────┤
│  [x] Task 1 Title                   @Alice  Jan 15  High    │
├─────────────────────────────────────────────────────────────┤
│  [ ] Task 2 Title                   @Bob    Jan 16  Low     │
├─────────────────────────────────────────────────────────────┤
│  [x] Task 3 Title                   @Carol  Jan 17  Medium  │
└─────────────────────────────────────────────────────────────┘
```

**Features:**
- Optional checkbox column
- Title as primary content
- Preview properties on right
- Click to open row detail modal

---

### 6. State Management with Zustand (5 minutes)

#### Block Store

| Field | Type | Description |
|-------|------|-------------|
| blocks | Map<string, Block> | All blocks by ID |
| selectedBlockId | string or null | Currently selected block |
| focusedBlockId | string or null | Block with cursor focus |

**Actions:**
| Action | Description |
|--------|-------------|
| setBlocks(blocks) | Initialize blocks from API |
| updateBlock(id, updates) | Partial update, set updatedAt |
| deleteBlock(id) | Remove block, clear selection if needed |
| addBlock(afterId, position) | Create new block with generated position |
| moveBlock(id, targetId, position) | Reorder or nest block |
| selectBlock(id) | Set selection |
| focusBlock(id) | Set cursor focus |

**Uses immer middleware for immutable updates.**

#### Presence Store

| Field | Type | Description |
|-------|------|-------------|
| users | Map<string, UserPresence> | Active users |

**UserPresence Structure:**
| Field | Type | Description |
|-------|------|-------------|
| name | string | Display name |
| color | string | Cursor color |
| cursor | {blockId, offset} | Current position (optional) |

**Actions:**
- `setUsers(users)` - Initialize presence list
- `updateCursor(userId, cursor)` - Update cursor position
- `removeUser(userId)` - Remove user on disconnect

#### Page Tree Store

| Field | Type | Description |
|-------|------|-------------|
| pages | Map<string, Page> | All pages by ID |
| expandedPages | Set<string> | Expanded page IDs |

**Actions:**
- `toggleExpanded(pageId)` - Expand/collapse in sidebar
- `setPages(pages)` - Initialize page tree

**Persisted to localStorage:** expandedPages (survives page reload)

---

### 7. Presence and Cursors (4 minutes)

**Remote Cursor Display:**
```
┌─────────────────────────────────────────────────────────────┐
│  Block Content                                               │
│                                                              │
│  The quick brown fox jum│ps over the lazy dog.              │
│                         ↑                                    │
│                   ┌─────────┐                                │
│                   │ Alice   │  (colored cursor + label)      │
│                   └─────────┘                                │
└─────────────────────────────────────────────────────────────┘
```

**Cursor Positioning Algorithm:**
1. Find block element by data-block-id attribute
2. Find contenteditable element within block
3. Create range at specified offset
4. Get bounding rect for cursor position
5. Render fixed-position cursor overlay

**Presence Avatars (in page header):**
```
┌────────────────────────────────────────────────────────────┐
│  Page Title                        [A][B][C][D][E] [+3]   │
└────────────────────────────────────────────────────────────┘
```

- Show first 5 users as avatar circles
- "+N" badge for additional users
- Hover for name tooltip
- Color matches cursor color

---

### 8. Sidebar Navigation (4 minutes)

**Sidebar Structure:**
```
┌──────────────────────────────────────┐
│  [Workspace Name ▼]                  │  <- Workspace switcher
├──────────────────────────────────────┤
│  🔍 Quick Find           Cmd+K      │
│  ⚙️ Settings                         │
├──────────────────────────────────────┤
│  Favorites                           │
│    📄 Important Doc                  │
│    📊 Project Dashboard              │
├──────────────────────────────────────┤
│  Private                             │  <- Page tree root
│    ▸ 📁 Project A                    │
│    ▾ 📁 Project B                    │
│        📄 Notes                       │
│        📄 Tasks                       │
│    📄 Quick Note                     │
├──────────────────────────────────────┤
│  [+ New page]                        │
└──────────────────────────────────────┘
   ║  <- Resize handle
```

**Page Tree Item Features:**
- Expand/collapse toggle (if has children)
- Page icon (emoji or default)
- Page title (truncated)
- Hover actions: Add child, More options
- Recursive rendering for nested pages
- Indent based on depth

**Sidebar Features:**
- Resizable width (drag handle on right edge)
- Collapsible
- Quick Find opens search modal
- Favorites section (starred pages)
- Page tree with recursive structure

---

## RADIO Data Model and Interfaces

The page editor should not treat the rendered block tree as the persistence model. The server stores blocks and relationships; the client derives a render tree, maintains local drafts, and tracks collaboration state separately.

| Entity | Owner | Important fields | Update semantics |
|---|---|---|---|
| `Page` | Page store | page ID, parent ID, title, permissions, updated time | server state |
| `Block` | Block store | block ID, type, parent ID, order key, content, version | normalized and persisted |
| `BlockTree` | Selector layer | ordered visible block IDs and descendants | derived client state |
| `EditorDraft` | Block editor | active block, selection, composition text, dirty state | ephemeral client state |
| `Presence` | Presence store | user ID, page ID, cursor/block, last seen | lossy realtime state |
| `SearchResult` | Search data layer | page/block ID, snippet, score, cursor | paginated server state |

### Server-facing API

```
GET  /api/pages/:pageId                    → page metadata and block snapshot
POST /api/pages/:pageId/blocks             → create a block
PATCH /api/blocks/:blockId                 → update content or block properties
POST /api/pages/:pageId/reorder            → move blocks with an ordering version
GET  /api/search?q=...&cursor=...           → paginated page/block results
WSS  /api/pages/:pageId/presence           → collaborator cursors and presence
```

Block mutations carry a version or operation ID. A stale reorder response should preserve the user’s draft and ask the page store to reconcile the sibling order; it should not reset the entire editor tree. Search results are independent server state and should not be copied into the page block store.

### Client interfaces

| Interface | Inputs | Output/event | Responsibility |
|---|---|---|---|
| `BlockRenderer` | block type, block data, child slot | rendered block | type-specific presentation |
| `BlockEditor` | block draft, selection, schema | validated block mutation | local editing and validation |
| `PageStore` | normalized block operations | block/page selectors | shared document state |
| `SyncCoordinator` | mutations, versions, retry signals | ack, conflict, resync | persistence and reconciliation |
| `PresenceChannel` | cursor and active-user updates | remote presence | non-authoritative collaboration UI |

The component registry should resolve block types through a descriptor rather than a single growing switch. That lets new block types add their renderer and editor while the page store, sync coordinator, and accessibility shell remain stable.

### 9. Trade-offs and Decisions

| Decision | Chosen Approach | Alternative | Rationale |
|----------|----------------|-------------|-----------|
| Rich text editing | contentEditable | ProseMirror/Slate | Simpler for MVP, custom control |
| Block rendering | Component delegation | Single switch | Easier to extend, isolated logic |
| Virtualization | @tanstack/react-virtual | react-window | Better dynamic height support |
| State management | Zustand + immer | Redux Toolkit | Simpler API, less boilerplate |
| Drag and drop | @dnd-kit | react-beautiful-dnd | More flexible, better for nested |
| Styling | Tailwind CSS | CSS Modules | Faster iteration, consistent design |

---

### 10. Future Frontend Enhancements

1. **Full ProseMirror/Slate integration** - Production-grade rich text editing
2. **Collaborative cursors with Yjs** - Character-level cursor sync
3. **Offline with IndexedDB** - Full offline-first with background sync
4. **Mobile-responsive** - Touch gestures for block manipulation
5. **Keyboard accessibility** - Full screen reader support
6. **Animation polish** - Smooth block transitions with Framer Motion
