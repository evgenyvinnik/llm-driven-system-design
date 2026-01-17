# Design Collaborative Editor - Development with Claude

## Project Context

Building a real-time collaborative document editor to understand distributed editing, conflict resolution, and synchronization.

**Key Learning Goals:**
- Implement operational transformation algorithms
- Design real-time sync protocols
- Handle concurrent edits gracefully
- Build offline-first editing experience

---

## Key Challenges to Explore

### 1. Conflict Resolution

**Challenge**: Multiple users editing same location

**Approaches:**
- Operational Transformation (OT) [CHOSEN]
- Conflict-free Replicated Data Types (CRDT)
- Last-write-wins (simple but lossy)
- Intent preservation

**Why OT over CRDT:**
- Simpler to understand and implement for learning
- More efficient for text editing (smaller operation size)
- Well-established in production systems (Google Docs)
- CRDTs have higher memory overhead for unique character IDs

### 2. Real-Time Sync

**Problem**: Minimize latency while maintaining consistency

**Solutions:**
- Optimistic local updates [IMPLEMENTED]
- WebSocket persistent connections [IMPLEMENTED]
- Operation buffering [IMPLEMENTED]
- Acknowledgment protocol [IMPLEMENTED]

### 3. Offline Support

**Challenge**: Enable editing without connectivity

**Solutions:**
- Local operation queue
- Sync on reconnect
- Conflict visualization
- Automatic merge

---

## Development Phases

### Phase 1: Core OT - COMPLETED
- [x] Operation types (insert, delete, retain)
- [x] Transform function
- [x] Compose function
- [x] Apply to text

### Phase 2: Sync Protocol - IN PROGRESS
- [x] WebSocket server
- [x] Client sync engine
- [x] Version tracking
- [x] Acknowledgment flow
- [x] Pending operation queue
- [x] Server-side OT

### Phase 3: Editor - IN PROGRESS
- [x] Text editor component
- [x] Cursor tracking (basic)
- [x] Presence indicators
- [ ] Selection sync
- [ ] Rich text formatting

### Phase 4: Features - PENDING
- [ ] Version history UI
- [ ] Comments
- [ ] Access control
- [ ] Offline mode

---

## Implementation Details

### TextOperation Class

The core data structure for representing text changes:

```typescript
class TextOperation {
  ops: Op[];           // Array of retain/insert/delete operations
  baseLength: number;  // Length of document before applying
  targetLength: number; // Length of document after applying

  retain(n: number): this;
  insert(str: string): this;
  delete(n: number): this;
  apply(str: string): string;
}
```

### OT Transform

The transform function takes two operations that were both applied to the same document state and returns transformed versions that can be applied in sequence:

```
transform(op1, op2) => [op1', op2']

Such that: apply(apply(doc, op1), op2') === apply(apply(doc, op2), op1')
```

This property ensures convergence regardless of the order operations arrive.

### Client State Machine

Each client maintains:
- `content`: Current local document content
- `serverVersion`: Last acknowledged server version
- `inflightOp`: Operation sent to server, awaiting ack
- `pendingOps`: Operations applied locally but not yet sent

When receiving a remote operation:
1. Transform it against inflight operation
2. Transform it against all pending operations
3. Apply transformed operation to local content

### WebSocket Protocol

Messages exchanged between client and server:

**Client -> Server:**
- `operation { version, operation }` - Submit an operation
- `cursor { position }` - Update cursor position

**Server -> Client:**
- `init { clientId, version, content, clients }` - Initial state
- `ack { version }` - Operation acknowledged
- `operation { clientId, version, operation }` - Remote operation
- `cursor { clientId, position }` - Remote cursor update
- `client_join/client_leave` - Presence updates
- `resync { version, content }` - Full resync on error

---

## Design Decisions

### 1. Server-Authoritative Ordering

All operations go through the server which assigns the canonical order. This simplifies conflict resolution compared to peer-to-peer approaches.

### 2. Snapshot + Op Log

Documents are stored as periodic snapshots plus an operation log. This provides:
- Fast loading (latest snapshot + recent ops)
- Complete history (all operations preserved)
- Storage efficiency (snapshots every 50 ops)

### 3. Presence in Redis

User presence (online status, cursor positions) is stored in Redis for:
- Fast access (in-memory)
- Automatic expiration
- Multi-server scalability

### 4. Simple Text Editing First

Started with plain text before rich text to focus on core OT algorithm. Rich text formatting can be added by extending operation attributes.

---

## Lessons Learned

1. **OT is tricky**: The transform function has many edge cases. Testing with concurrent operations is essential.

2. **Latency matters**: Optimistic local updates are critical for a good UX. Users should see their changes immediately.

3. **Version numbers simplify**: Using monotonic version numbers makes it easy to determine which operations need transformation.

4. **Presence adds life**: Seeing other users' cursors and avatars makes the experience feel collaborative even when no one is editing.

---

## Resources

- [Operational Transformation (Wikipedia)](https://en.wikipedia.org/wiki/Operational_transformation)
- [Google Wave OT Paper](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/operational-transform/operational-transform.html)
- [Yjs CRDT](https://docs.yjs.dev/)
- [Quill Editor](https://quilljs.com/) - Rich text OT implementation
