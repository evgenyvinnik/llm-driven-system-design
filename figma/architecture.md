# Figma - Collaborative Design and Prototyping Platform - Architecture Design

## System Overview

A collaborative design and prototyping platform with real-time multiplayer editing, featuring vector graphics creation, version history, and presence tracking.

## Requirements

### Functional Requirements

- Real-time collaborative editing with multiplayer cursors
- Vector graphics editing (rectangles, ellipses, text)
- Layers panel with visibility and lock controls
- Properties panel for object manipulation
- Version control and history
- File management (create, browse, delete)

### Non-Functional Requirements

- **Scalability**: Designed for local development with 2-5 concurrent users per file
- **Availability**: Handles server reconnection gracefully
- **Latency**: < 100ms for local operations, < 200ms for sync to collaborators
- **Consistency**: Last-Writer-Wins (LWW) for conflict resolution

## Capacity Estimation

For local development:

- Concurrent users: 2-5 per file
- Operations per second: ~10-50 per active session
- Storage: PostgreSQL with JSONB for canvas data
- WebSocket connections: 1 per user per file

## High-Level Architecture

```
                           ┌─────────────────────────────────┐
                           │       Frontend (React 19)       │
                           │   Canvas Editor + Zustand Store │
                           └──────────────┬──────────────────┘
                                          │
                                          │ HTTP + WebSocket
                                          ▼
                           ┌─────────────────────────────────┐
                           │    Backend (Express + WS)       │
                           │                                 │
                           │  ┌───────────┐ ┌─────────────┐ │
                           │  │ REST API  │ │  WebSocket  │ │
                           │  │ (Files,   │ │  (Real-time │ │
                           │  │ Versions) │ │  sync)      │ │
                           │  └───────────┘ └─────────────┘ │
                           └──────────────┬──────────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
           ┌────────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
           │   PostgreSQL    │   │      Redis      │   │     Redis       │
           │   (Files,       │   │    (Presence,   │   │   (Pub/Sub)     │
           │    Versions)    │   │     Sessions)   │   │                 │
           └─────────────────┘   └─────────────────┘   └─────────────────┘
```

### Core Components

1. **Frontend (React 19 + Vite + Zustand + Tailwind CSS)**
   - Canvas-based editor with 2D rendering
   - Zustand for state management
   - WebSocket hook for real-time sync
   - File browser and version history UI

2. **Backend (Node.js + Express + WebSocket)**
   - REST API for file and version management
   - WebSocket server for real-time collaboration
   - Operation processing and broadcasting

3. **PostgreSQL**
   - Files with JSONB canvas data
   - Version history with snapshots
   - Operations log for CRDT

4. **Redis**
   - Presence tracking (cursor positions, selections)
   - Pub/Sub for cross-server coordination

## Data Model

### Database Schema

```sql
-- Files
CREATE TABLE files (
  id UUID PRIMARY KEY,
  name VARCHAR(255),
  owner_id UUID,
  project_id UUID,
  team_id UUID,
  thumbnail_url VARCHAR(500),
  canvas_data JSONB,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- File versions
CREATE TABLE file_versions (
  id UUID PRIMARY KEY,
  file_id UUID REFERENCES files(id),
  version_number INTEGER,
  name VARCHAR(255),
  canvas_data JSONB,
  created_by UUID,
  created_at TIMESTAMP,
  is_auto_save BOOLEAN
);

-- Operations log
CREATE TABLE operations (
  id UUID PRIMARY KEY,
  file_id UUID REFERENCES files(id),
  user_id UUID,
  operation_type VARCHAR(100),
  object_id VARCHAR(100),
  property_path VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  timestamp BIGINT,
  client_id VARCHAR(100),
  created_at TIMESTAMP
);
```

### Canvas Data Structure

```typescript
interface CanvasData {
  objects: DesignObject[];
  pages: Page[];
}

interface DesignObject {
  id: string;
  type: 'rectangle' | 'ellipse' | 'text' | 'frame' | 'group' | 'image';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  // Text-specific
  text?: string;
  fontSize?: number;
  fontFamily?: string;
}
```

## API Design

### REST Endpoints

```
GET    /api/files                    - List all files
POST   /api/files                    - Create new file
GET    /api/files/:id                - Get file details
PATCH  /api/files/:id                - Update file name
DELETE /api/files/:id                - Delete file
GET    /api/files/:id/versions       - List version history
POST   /api/files/:id/versions       - Create named version
POST   /api/files/:id/versions/:versionId/restore - Restore version
```

### WebSocket Protocol

```typescript
// Client -> Server
{ type: "subscribe", payload: { fileId, userId, userName } }
{ type: "operation", payload: { operations: [...] } }
{ type: "presence", payload: { cursor: {x, y}, selection: [...] } }

// Server -> Client
{ type: "sync", payload: { file, presence, yourColor } }
{ type: "operation", payload: { operations: [...] } }
{ type: "presence", payload: { presence: [...], removed: [...] } }
{ type: "ack", payload: { operationIds: [...] } }
```

## Key Design Decisions

### Real-time Collaboration (Simplified CRDT)

Using Last-Writer-Wins (LWW) registers for object properties:
- Each property update includes a timestamp
- When merging, highest timestamp wins
- Ties broken by client ID

### Vector Graphics Storage

Canvas data stored as JSONB in PostgreSQL:
- Allows for flexible schema evolution
- Supports indexing for specific queries
- Simple to serialize/deserialize

### Version Control and History

- Periodic snapshots stored as full JSONB documents
- Operations logged for fine-grained history
- Named versions for user bookmarks

### Conflict Resolution

- LWW for property updates
- Server as authority for operation ordering
- Clients optimistically apply changes, reconcile on sync

## Technology Stack

- **Frontend**: React 19, Vite, Zustand, Tailwind CSS
- **Backend**: Node.js, Express, ws (WebSocket)
- **Data Layer**: PostgreSQL 16
- **Caching/Presence**: Redis 7
- **Real-time**: Native WebSocket

## Scalability Considerations

### Single Server (Current)

- All WebSocket connections to one server
- Direct database access
- In-memory operation batching

### Multi-Server (Future)

- Sticky sessions by file_id
- Redis pub/sub for presence synchronization
- Consistent hashing for file assignment

## Monitoring and Observability

- Health check endpoint at `/health`
- Console logging for connections and operations
- Redis key TTL for presence expiration

## Security Considerations

- CORS configured for frontend origin
- Input validation on API endpoints
- Parameterized SQL queries (pg library)

## Future Optimizations

1. **WebGL Rendering**: For performance with thousands of objects
2. **CRDT Library**: Yjs or Automerge for robust conflict resolution
3. **Viewport Culling**: Only sync objects in view
4. **Delta Compression**: Send only changed properties
5. **Offline Support**: IndexedDB for local persistence
