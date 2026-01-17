# Figma - System Design Interview Answer

## Opening Statement

"Today I'll design Figma, a real-time collaborative design platform. The core challenge here is enabling multiple designers to edit the same canvas simultaneously while seeing each other's cursors and changes in real-time, all while maintaining consistency and handling complex vector graphics efficiently."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Real-time collaborative editing** - Multiple users editing the same design file simultaneously
2. **Vector graphics canvas** - Create, edit, and manipulate vector shapes, text, images
3. **Component system** - Reusable design components with overrides
4. **Version history** - Full revision history with ability to restore
5. **Comments and feedback** - Threaded comments pinned to design elements
6. **Prototyping** - Interactive prototypes with transitions
7. **Export** - Export to PNG, SVG, PDF at various resolutions
8. **Multiplayer presence** - See collaborators' cursors and selections

### Non-Functional Requirements

- **Latency**: < 50ms for local operations, < 200ms for sync to collaborators
- **Consistency**: All users must converge to the same state
- **Availability**: 99.9% uptime
- **Scale**: 10M+ active files, 50+ concurrent editors per file
- **Performance**: Handle files with 10,000+ objects smoothly

### Out of Scope

- Dev mode / code generation
- FigJam whiteboarding (separate product)
- Plugin ecosystem

---

## Step 2: Scale Estimation (2-3 minutes)

**User base:**
- 10 million monthly active users
- 1 million concurrent users at peak
- Average session: 2 hours

**File characteristics:**
- 50 million design files
- Average file: 5MB (can be 500MB+ for complex files)
- 50 operations per user per minute during active editing

**Traffic:**
- 1M concurrent users * 50 ops/min = 50M operations/minute = ~830K ops/second at peak
- Read-heavy for viewing, write-heavy during editing sessions

**Storage:**
- 50M files * 5MB average = 250 TB primary storage
- Version history multiplier: 5x = 1.25 PB total

**Key insight**: The challenge is not raw throughput but coordinating thousands of concurrent edits on shared documents while maintaining consistency.

---

## Step 3: High-Level Architecture (10 minutes)

```
                               ┌─────────────────────────────────┐
                               │          Client Apps            │
                               │  (Web/Desktop - WebGL Canvas)   │
                               └──────────────┬──────────────────┘
                                              │
                                              │ WebSocket + HTTPS
                                              ▼
                               ┌─────────────────────────────────┐
                               │        Load Balancer            │
                               │   (Sticky sessions by file_id)  │
                               └──────────────┬──────────────────┘
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              │                               │                               │
    ┌─────────▼─────────┐          ┌─────────▼─────────┐          ┌─────────▼─────────┐
    │ Collaboration     │          │ Collaboration     │          │ Collaboration     │
    │ Server (File A)   │          │ Server (File B)   │          │ Server (File C)   │
    │                   │          │                   │          │                   │
    │ - CRDT Engine     │          │ - CRDT Engine     │          │ - CRDT Engine     │
    │ - Presence        │          │ - Presence        │          │ - Presence        │
    │ - Operations Log  │          │ - Operations Log  │          │ - Operations Log  │
    └─────────┬─────────┘          └─────────┬─────────┘          └─────────┬─────────┘
              │                               │                               │
              └───────────────────────────────┼───────────────────────────────┘
                                              │
           ┌──────────────────────────────────┼──────────────────────────────────┐
           │                                  │                                  │
  ┌────────▼────────┐              ┌─────────▼─────────┐              ┌─────────▼────────┐
  │   PostgreSQL    │              │       Redis       │              │  Object Storage  │
  │   (Metadata)    │              │   (Presence/      │              │  (File Blobs,    │
  │                 │              │    Sessions)      │              │   Images)        │
  └─────────────────┘              └───────────────────┘              └──────────────────┘
                                              │
                               ┌──────────────┼──────────────┐
                               │              │              │
                      ┌────────▼────┐  ┌──────▼──────┐  ┌────▼────────┐
                      │ Version     │  │  Export     │  │  Thumbnail  │
                      │ History     │  │  Service    │  │  Service    │
                      │ Service     │  │             │  │             │
                      └─────────────┘  └─────────────┘  └─────────────┘
```

### Core Components

1. **Client Application**
   - WebGL-based canvas renderer (GPU accelerated)
   - Local CRDT replica for instant feedback
   - WebSocket connection for real-time sync
   - IndexedDB for offline caching

2. **Collaboration Server**
   - Stateful server managing one or more files
   - Maintains authoritative CRDT state in memory
   - Broadcasts operations to connected clients
   - Handles conflict resolution

3. **Presence Service**
   - Tracks cursor positions, selections, viewport
   - Low-latency updates (fire-and-forget, no persistence)
   - Redis pub/sub for cross-server coordination

4. **File Storage Layer**
   - PostgreSQL: File metadata, permissions, user data
   - Object Storage (S3): Binary file data, uploaded images
   - Version snapshots stored as deltas

5. **Supporting Services**
   - Export Service: Render to PNG/SVG/PDF
   - Thumbnail Service: Generate previews
   - Version History: Store and retrieve snapshots

---

## Step 4: Deep Dive - Real-Time Collaboration with CRDTs (10 minutes)

This is the heart of Figma. Let me explain why we choose CRDTs and how they work.

### The Problem

When User A and User B simultaneously edit:
- A moves Rectangle1 to position (100, 100)
- B deletes Rectangle1

What should happen? We need:
1. Operations to be applied in any order and converge
2. No central locking (would kill latency)
3. Offline support

### Why CRDT over Operational Transformation (OT)?

| Factor | CRDT | OT |
|--------|------|-----|
| Server complexity | Simpler (no transformation) | Complex transformation functions |
| Peer-to-peer | Possible | Requires central server |
| Correctness | Mathematically proven | Easy to have bugs |
| Memory overhead | Higher | Lower |

Figma's choice: **CRDT** for correctness and simpler implementation.

### CRDT Design for Design Files

We model the design file as a tree of objects:

```
Document
├── Page 1
│   ├── Frame "Header"
│   │   ├── Rectangle (id: abc123)
│   │   └── Text (id: def456)
│   └── Frame "Body"
│       └── ...
└── Page 2
    └── ...
```

**Each object is a CRDT map:**

```typescript
interface DesignObject {
  id: string;                    // Unique identifier
  parent_id: string;             // Parent in tree
  type: 'FRAME' | 'RECTANGLE' | 'TEXT' | ...;
  properties: CRDTMap<string, CRDTValue>;
  // Properties: x, y, width, height, fill, stroke, etc.
}
```

**Operations are structured as:**

```typescript
interface Operation {
  id: string;              // Unique operation ID (timestamp + client_id)
  object_id: string;       // Target object
  property: string;        // e.g., "x", "fill.color"
  value: any;              // New value
  timestamp: LamportClock; // For ordering
}
```

### Last-Writer-Wins Register (LWW)

For most properties, we use LWW-Register CRDT:
- Each property has a value and a timestamp
- When merging, highest timestamp wins
- Ties broken by client_id

```typescript
class LWWRegister<T> {
  value: T;
  timestamp: number;
  client_id: string;

  merge(other: LWWRegister<T>) {
    if (other.timestamp > this.timestamp ||
        (other.timestamp === this.timestamp &&
         other.client_id > this.client_id)) {
      this.value = other.value;
      this.timestamp = other.timestamp;
    }
  }
}
```

### Handling Deletions

Deletions are tricky with CRDTs. We use "tombstones":
- Deleted objects aren't removed, just marked deleted
- Tombstones kept for 30 days, then garbage collected
- Allows undo of deletions

### Tree Structure (Parent-Child)

For tree operations (reparenting), we use a Tree CRDT:
- Each node has a parent reference with a timestamp
- Cycle detection: reject operations that create cycles
- Position ordering: Fractional indexing for sibling order

### Example Conflict Resolution

```
Initial: Rectangle at (50, 50)

User A: Move to (100, 100) at t=1001
User B: Move to (200, 200) at t=1000

Resolution:
- A's operation has higher timestamp
- Both users converge to (100, 100)
```

### Optimizations

1. **Operation batching**: Group operations within 50ms windows
2. **Delta compression**: Only send changed properties
3. **Binary encoding**: Use MessagePack instead of JSON (50% smaller)

---

## Step 5: Deep Dive - Vector Graphics Storage (7 minutes)

### The Challenge

Design files contain complex vector graphics:
- Bezier curves with control points
- Boolean operations (union, subtract, intersect)
- Effects (shadows, blurs)
- Constraints and auto-layout
- Nested components with overrides

### File Format

We use a custom binary format optimized for:
- Fast random access (don't need to parse entire file)
- Incremental updates (append operations)
- Efficient rendering data

```
┌─────────────────────────────────────┐
│            File Header              │
│  - Version, checksum, object count  │
├─────────────────────────────────────┤
│          Object Index               │
│  - Object ID → Offset mapping       │
├─────────────────────────────────────┤
│         Object Data Blocks          │
│  - Serialized CRDT states           │
├─────────────────────────────────────┤
│         Embedded Resources          │
│  - Images, fonts (or references)    │
├─────────────────────────────────────┤
│         Operations Log              │
│  - Recent uncompacted operations    │
└─────────────────────────────────────┘
```

### Rendering Pipeline

Client-side rendering using WebGL:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  CRDT State  │────▶│  Scene Graph │────▶│   Tessellation│────▶│  GPU Render  │
│              │     │  Tree        │     │   (to triangles)   │  (WebGL)     │
└──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
```

1. **Scene Graph**: Hierarchical representation of all objects
2. **Tessellation**: Convert curves to triangle meshes for GPU
3. **GPU Rendering**: WebGL shader programs for each effect type

### Large File Handling

For files with 10,000+ objects:

1. **Viewport culling**: Only render visible objects
2. **Level of detail**: Simplify objects when zoomed out
3. **Lazy loading**: Load object details on demand
4. **Background workers**: Tessellation in Web Workers

### Image Handling

- Images uploaded to object storage (S3)
- Multiple resolutions generated (thumbnail, preview, full)
- Content-addressed storage (deduplication by hash)
- Client caches images in IndexedDB

---

## Step 6: Deep Dive - Version History (5 minutes)

### Requirements

- Full version history (every auto-save point)
- Named versions (user-created snapshots)
- Efficient storage (not full copies)
- Fast restoration

### Implementation: Operation Log + Snapshots

```
         t=0          t=100        t=200        t=300        t=400
          │             │            │            │            │
          ▼             ▼            ▼            ▼            ▼
     [Snapshot 0] ─── ops ─── [Snapshot 1] ─── ops ─── [Snapshot 2]
          │             │            │            │            │
          └─────────────┴────────────┴────────────┴────────────┘
                               Operations Log
```

**Strategy:**
1. Store periodic snapshots (every 100 operations or 5 minutes)
2. Store all operations between snapshots
3. To restore version at t=250: Load Snapshot 1, replay ops 100-250

### Delta Compression

Snapshots are stored as deltas from previous snapshot:
- Only changed objects are stored
- Typical compression: 10-50x reduction

### Branching (Future Feature)

Could support branches for design exploration:
- Fork creates new branch with shared history
- Merge brings changes back

---

## Step 7: Component System (5 minutes)

### Components and Instances

```
┌─────────────────┐         ┌─────────────────┐
│   Component     │         │    Instance     │
│   (Master)      │◀────────│   (Copy)        │
│                 │         │                 │
│   - Button      │         │   - overrides:  │
│   - width: 100  │         │     text: "OK"  │
│   - text: "Btn" │         │                 │
└─────────────────┘         └─────────────────┘
```

**Instance Storage:**
- Reference to component ID
- Override map (only changed properties)
- Inherits all non-overridden properties

**Propagation:**
- Component change → All instances update
- Implemented via reactive dependency graph
- Circular dependency detection

### Variant System

Components can have variants (states):

```typescript
interface Component {
  id: string;
  variants: {
    "default": { ... },
    "hover": { fill: "blue" },
    "pressed": { fill: "darkblue" }
  };
}
```

Instances select which variant to display.

---

## Step 8: Presence and Multiplayer (3 minutes)

### Cursor and Selection Tracking

```typescript
interface PresenceState {
  user_id: string;
  cursor: { x: number; y: number } | null;
  selection: string[];  // Selected object IDs
  viewport: { x: number; y: number; zoom: number };
  color: string;        // Assigned cursor color
}
```

### Architecture

- Presence updates sent via WebSocket (fire-and-forget)
- Not persisted - ephemeral state
- Throttled to 30 updates/second per user
- Redis pub/sub for cross-server distribution

### Optimization

- Aggregate cursor positions before broadcast
- Only send changes (delta compression)
- Clients interpolate between updates for smooth cursors

---

## Step 9: Data Model and Storage (3 minutes)

### PostgreSQL Schema

```sql
-- Files
CREATE TABLE files (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  owner_id UUID REFERENCES users(id),
  team_id UUID REFERENCES teams(id),
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  thumbnail_url VARCHAR(500)
);

-- File versions
CREATE TABLE file_versions (
  id UUID PRIMARY KEY,
  file_id UUID REFERENCES files(id),
  version_number INTEGER,
  created_at TIMESTAMP,
  created_by UUID REFERENCES users(id),
  snapshot_url VARCHAR(500),
  operations_url VARCHAR(500),
  is_named BOOLEAN DEFAULT FALSE,
  name VARCHAR(255)
);

-- Comments
CREATE TABLE comments (
  id UUID PRIMARY KEY,
  file_id UUID REFERENCES files(id),
  user_id UUID REFERENCES users(id),
  object_id VARCHAR(100),  -- Pinned to design object
  position_x FLOAT,
  position_y FLOAT,
  content TEXT,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP
);
```

### Object Storage (S3)

- `/files/{file_id}/snapshots/{version_id}.bin` - File snapshots
- `/files/{file_id}/operations/{chunk_id}.bin` - Operation logs
- `/images/{hash}.{format}` - Uploaded images

---

## Step 10: API Design (2 minutes)

### WebSocket Protocol

```typescript
// Client → Server
{ type: "OPERATION", payload: { operations: [...] } }
{ type: "PRESENCE", payload: { cursor: {x, y}, selection: [...] } }
{ type: "SUBSCRIBE", payload: { file_id: "..." } }

// Server → Client
{ type: "OPERATION", payload: { operations: [...], from_user: "..." } }
{ type: "PRESENCE", payload: { user_id: "...", cursor: {...} } }
{ type: "ACK", payload: { operation_ids: [...] } }
```

### REST API

```
GET  /api/files                    - List user's files
POST /api/files                    - Create new file
GET  /api/files/{id}               - Get file metadata
GET  /api/files/{id}/versions      - List versions
POST /api/files/{id}/versions      - Create named version
POST /api/files/{id}/export        - Export to PNG/SVG/PDF
```

---

## Step 11: Scalability and Reliability (3 minutes)

### Scaling Strategy

1. **Collaboration Servers**: Shard by file_id
   - Each file assigned to specific server
   - Consistent hashing for assignment
   - Hot files can be isolated

2. **Horizontal Scaling**: Add servers for more concurrent files

3. **Connection Limits**: Max 100 concurrent editors per file

### Failure Handling

- **Server crash**: Clients reconnect to new server, reload CRDT state
- **Network partition**: Clients continue local edits, sync on reconnect
- **Persistence lag**: Operations logged to disk before ack

### Auto-Save

- Save triggered every 30 seconds of activity
- Or every 10 operations, whichever comes first
- Background persistence doesn't block editing

---

## Step 12: Trade-offs and Alternatives (2 minutes)

### Key Trade-offs

| Decision | Trade-off |
|----------|-----------|
| CRDTs over OT | More memory for simpler correctness |
| WebGL rendering | Requires GPU, but enables 60fps performance |
| Stateful servers | Requires sticky sessions, but enables real-time |
| Binary format | Less readable, but smaller and faster |

### Alternatives Considered

1. **Server-side rendering**
   - Would work for view-only
   - Unacceptable latency for editing

2. **Peer-to-peer sync**
   - Would reduce server load
   - Harder to ensure consistency, handle offline

3. **Database-backed CRDT (like Yjs + MongoDB)**
   - Easier to implement
   - Higher latency, chose in-memory for speed

---

## Closing Summary

"I've designed a real-time collaborative design platform with:

1. **CRDT-based collaboration** enabling multiple users to edit simultaneously with automatic conflict resolution
2. **WebGL rendering** for high-performance vector graphics on any device
3. **Efficient storage** using binary formats and delta compression for version history
4. **Multiplayer presence** showing cursors and selections in real-time

The core insight is treating the design file as a distributed data structure (CRDT tree) that can be edited concurrently and merged automatically. Happy to dive deeper into any component."

---

## Potential Follow-up Questions

1. **How would you handle a file with 100 concurrent editors?**
   - Partitioning: Split into regions, each handled separately
   - Operational batching with conflict detection

2. **How would you implement offline support?**
   - Full CRDT state in IndexedDB
   - Queue operations, sync on reconnect
   - Conflict resolution on sync

3. **How would you build the plugin system?**
   - Sandboxed iframes with postMessage API
   - Defined plugin API surface
   - Rate limiting for operations
