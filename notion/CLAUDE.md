# Design Notion - Development with Claude

## Project Context

Building a block-based collaboration tool to understand real-time sync, flexible data models, and workspace hierarchy.

**Key Learning Goals:**
- Implement CRDT-based real-time collaboration
- Design flexible block data structures
- Build hierarchical page organization
- Handle offline-first editing

---

## Key Challenges to Explore

### 1. Conflict Resolution

**Scenario**: Two users edit same block simultaneously

**CRDT Solution:**
- Operations are commutative (order doesn't matter)
- Each operation has unique ID + timestamp
- Last-write-wins for properties
- Text uses sequence CRDT

### 2. Large Documents

**Problem**: Page with 10,000+ blocks

**Solutions:**
- Virtual scrolling in UI
- Lazy loading of blocks
- Pagination for deeply nested

### 3. Database Relations

**Challenge**: Linking between databases

**Implementation:**
- Relation property type
- Rollup for aggregation
- Bidirectional sync

---

## Development Phases

### Phase 1: Block Editor - COMPLETED
- [x] Basic block types (text, headings, lists, code, quote, callout, divider)
- [x] Rich text editing (basic implementation)
- [x] Block operations (add, delete, move)
- [x] Slash commands for block type conversion
- [x] Toggle blocks with collapse/expand

### Phase 2: Real-Time - IN PROGRESS
- [x] WebSocket connection with authentication
- [x] Operation broadcasting
- [x] Presence indicators (who is viewing)
- [x] Hybrid Logical Clock for ordering
- [ ] Full CRDT implementation for text
- [ ] Cursor position sync
- [ ] Offline queue and sync

### Phase 3: Hierarchy - COMPLETED
- [x] Workspaces with members
- [x] Nested pages (recursive structure)
- [x] Sidebar navigation with tree
- [ ] Granular permissions (view/edit per page)
- [ ] Share links

### Phase 4: Databases - COMPLETED
- [x] Properties schema (title, text, select, date, checkbox, etc.)
- [x] Table view
- [x] Board view (Kanban)
- [x] List view
- [ ] Calendar view
- [ ] Gallery view
- [x] Filtering and sorting per view

---

## Implementation Decisions

### Fractional Indexing for Block Order

Instead of integer positions that require reindexing, we use string-based fractional indexes:

```typescript
// Positions are lexicographically sortable strings
// Insert between 'a' and 'b' -> 'aU'
// This allows O(1) insertions without reindexing siblings
function generatePosition(before: string, after: string): string
```

### Hybrid Logical Clock

For operation ordering across distributed clients:

```typescript
interface HLC {
  timestamp: number;  // Physical wall clock
  counter: number;    // Logical counter for same-ms events
  nodeId: string;     // Unique identifier for this client/server
}
```

### WebSocket Sync Protocol

1. Client connects with auth token
2. Client subscribes to a page
3. Server sends current presence list
4. Operations are applied locally first (optimistic)
5. Operations sent to server, broadcast to other clients
6. Server acknowledges each operation

### Database Views

Views are saved configurations that define:
- View type (table, board, list, etc.)
- Filters (which rows to show)
- Sorts (row ordering)
- Group by (for board view)
- Property visibility and width

Same data, different presentations.

---

## What's Next

### Immediate Improvements
1. Full CRDT for text content (character-level)
2. Drag-and-drop block reordering
3. Image and file uploads
4. Page permissions UI

### Future Features
1. Templates
2. Comments on blocks
3. Version history
4. Export (Markdown, PDF)
5. Import from Notion
6. Mobile-responsive design

---

## Resources

- [CRDTs Explained](https://crdt.tech/)
- [Notion Data Model](https://www.notion.so/blog/data-model-behind-notion)
- [Fractional Indexing](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)
- [Yjs CRDT Library](https://yjs.dev/)
