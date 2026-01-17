# Design Notion - Architecture

## System Overview

Notion is a block-based collaborative workspace. Core challenges involve real-time editing, flexible block structures, and hierarchical organization.

**Learning Goals:**
- Implement real-time collaboration (CRDT/OT)
- Design flexible block-based data models
- Build hierarchical permission systems
- Handle offline-first architecture

---

## Requirements

### Functional Requirements

1. **Edit**: Block-based document editing
2. **Collaborate**: Real-time multi-user editing
3. **Organize**: Pages, databases, workspaces
4. **Share**: Granular permissions
5. **Database**: Structured data with views

### Non-Functional Requirements

- **Latency**: < 100ms for local edits
- **Sync**: < 500ms for cross-user sync
- **Offline**: Full editing capability offline
- **Scale**: 10M workspaces, 1B blocks

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│       React + Block Editor + CRDT Runtime + IndexedDB           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ WebSocket
┌─────────────────────────────────────────────────────────────────┐
│                   Sync Server Cluster                           │
│         (Real-time operation broadcast + conflict resolution)   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Server                                   │
│         - Workspaces - Pages - Permissions - Search             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────────────────────────────────┤
│   PostgreSQL    │              Elasticsearch                    │
│   - Blocks      │              - Full-text search               │
│   - Pages       │              - Block content                  │
│   - Workspaces  │                                               │
└─────────────────┴───────────────────────────────────────────────┘
```

---

## Core Components

### 1. Block Data Model

**Block Structure:**
```typescript
interface Block {
  id: string
  type: BlockType
  parentId: string | null
  pageId: string
  properties: Record<string, any>
  content: RichText[]
  children: string[] // Ordered child block IDs
  createdAt: Date
  updatedAt: Date
  createdBy: string
}

type BlockType =
  | 'text'
  | 'heading_1' | 'heading_2' | 'heading_3'
  | 'bulleted_list' | 'numbered_list' | 'toggle'
  | 'code' | 'quote' | 'callout'
  | 'image' | 'video' | 'embed'
  | 'table' | 'database'
```

**Rich Text:**
```typescript
interface RichText {
  text: string
  annotations: {
    bold?: boolean
    italic?: boolean
    underline?: boolean
    strikethrough?: boolean
    code?: boolean
    color?: string
  }
  link?: string
}
```

### 2. Real-Time Collaboration

**CRDT Approach (Conflict-Free):**
```typescript
// Each block operation is a CRDT operation
interface Operation {
  id: string
  type: 'insert' | 'delete' | 'update'
  blockId: string
  parentId?: string
  position?: FractionalIndex // For ordering
  properties?: Partial<Block>
  timestamp: HybridLogicalClock
  author: string
}

// Fractional indexing for ordering
// Allows inserting between any two blocks without reindexing
function insertBetween(before: string, after: string): string {
  // Returns a string that sorts between 'before' and 'after'
  // e.g., insertBetween('a', 'b') → 'aU'
}
```

**Sync Protocol:**
```typescript
// Client maintains local operation log
class SyncClient {
  private pendingOps: Operation[] = []
  private confirmedVersion: number = 0

  async applyLocal(op: Operation) {
    // Apply immediately to local state
    this.applyOp(op)
    this.pendingOps.push(op)

    // Send to server
    this.ws.send({ type: 'operation', op })
  }

  handleServerOp(op: Operation) {
    // Apply remote operation, handling conflicts
    if (!this.hasOp(op.id)) {
      this.applyOp(op)
    }
  }

  handleAck(opId: string) {
    this.pendingOps = this.pendingOps.filter(op => op.id !== opId)
  }
}
```

### 3. Page Hierarchy

**Recursive Page Structure:**
```sql
-- Pages can contain other pages
CREATE TABLE pages (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  parent_id UUID REFERENCES pages(id), -- NULL for root pages
  title VARCHAR(500),
  icon VARCHAR(100),
  cover_image VARCHAR(500),
  is_database BOOLEAN DEFAULT FALSE,
  properties_schema JSONB, -- For databases
  created_at TIMESTAMP DEFAULT NOW()
);

-- Blocks belong to pages
CREATE TABLE blocks (
  id UUID PRIMARY KEY,
  page_id UUID REFERENCES pages(id),
  parent_block_id UUID REFERENCES blocks(id), -- NULL for top-level
  type VARCHAR(50) NOT NULL,
  properties JSONB,
  content JSONB, -- Rich text array
  position VARCHAR(100), -- Fractional index
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 4. Database Views

**View Types:**
```typescript
interface DatabaseView {
  id: string
  databaseId: string
  type: 'table' | 'board' | 'list' | 'calendar' | 'gallery'
  name: string
  filter: Filter[]
  sort: Sort[]
  properties: PropertyVisibility[]
}

// Board view groups by a select property
interface BoardView extends DatabaseView {
  type: 'board'
  groupBy: string // Property ID (select type)
}

// Calendar view requires a date property
interface CalendarView extends DatabaseView {
  type: 'calendar'
  dateProperty: string // Property ID (date type)
}
```

---

## Database Schema

```sql
-- Workspaces
CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  owner_id UUID REFERENCES users(id),
  settings JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Workspace members
CREATE TABLE workspace_members (
  workspace_id UUID REFERENCES workspaces(id),
  user_id UUID REFERENCES users(id),
  role VARCHAR(20) DEFAULT 'member',
  PRIMARY KEY (workspace_id, user_id)
);

-- Pages (recursive)
CREATE TABLE pages (
  id UUID PRIMARY KEY,
  workspace_id UUID REFERENCES workspaces(id),
  parent_id UUID REFERENCES pages(id),
  title VARCHAR(500) DEFAULT 'Untitled',
  icon VARCHAR(100),
  is_database BOOLEAN DEFAULT FALSE,
  properties_schema JSONB,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Blocks
CREATE TABLE blocks (
  id UUID PRIMARY KEY,
  page_id UUID REFERENCES pages(id),
  parent_block_id UUID REFERENCES blocks(id),
  type VARCHAR(50) NOT NULL,
  properties JSONB,
  content JSONB,
  position VARCHAR(100),
  version INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_blocks_page ON blocks(page_id);
CREATE INDEX idx_blocks_parent ON blocks(parent_block_id);
```

---

## Key Design Decisions

### 1. CRDT for Collaboration

**Decision**: Use CRDTs instead of OT for conflict resolution

**Rationale**:
- No central authority needed
- Better offline support
- Deterministic merge
- Simpler server logic

**Trade-off**: Slightly larger operation payloads

### 2. Fractional Indexing for Order

**Decision**: Use string-based fractional indexes for block ordering

**Rationale**:
- Insert between any two blocks
- No reindexing of siblings
- Naturally sortable strings

### 3. Blocks as Core Primitive

**Decision**: Everything is a block (text, images, databases)

**Rationale**:
- Unified data model
- Composable structures
- Consistent editing experience

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Sync | CRDT | OT | Offline support |
| Ordering | Fractional index | Array index | No reindexing |
| Storage | PostgreSQL | Document DB | Relational queries |
| Real-time | WebSocket | SSE | Bidirectional |
