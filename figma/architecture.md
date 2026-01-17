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
   - PixiJS-based editor with hardware-accelerated WebGL rendering
   - Zustand for centralized state management (editorStore)
   - WebSocket hook for real-time collaboration sync
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

### Frontend Architecture

The frontend follows a unidirectional data flow pattern with clear component responsibilities:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              App.tsx                                        │
│                    (Route: FileBrowser ↔ Editor)                           │
└────────────────────────────────┬────────────────────────────────────────────┘
                                 │
            ┌────────────────────┴────────────────────┐
            ▼                                         ▼
┌──────────────────────┐               ┌───────────────────────────────────────┐
│    FileBrowser.tsx   │               │              Editor.tsx               │
│  ┌────────────────┐  │               │  (Main workspace container)           │
│  │ File grid      │  │               │                                       │
│  │ Create/Delete  │  │               │  ┌─────────────────────────────────┐  │
│  └────────────────┘  │               │  │           Toolbar.tsx           │  │
└──────────────────────┘               │  │  [Select|Hand|Shapes|Zoom|User] │  │
                                       │  └─────────────────────────────────┘  │
                                       │                                       │
                                       │  ┌─────────┬───────────┬───────────┐  │
                                       │  │ Layers  │  Canvas   │ Properties│  │
                                       │  │ Panel   │           │  Panel    │  │
                                       │  │ .tsx    │  .tsx     │  .tsx     │  │
                                       │  └─────────┴───────────┴───────────┘  │
                                       │                                       │
                                       │  ┌─────────────────────────────────┐  │
                                       │  │    VersionHistory.tsx (Modal)   │  │
                                       │  └─────────────────────────────────┘  │
                                       └───────────────────────────────────────┘
```

#### Component Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         State Management Flow                               │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │         editorStore (Zustand)       │
                    │  ┌───────────────────────────────┐  │
                    │  │ • canvasData: CanvasData      │  │
                    │  │ • selectedIds: string[]       │  │
                    │  │ • activeTool: Tool            │  │
                    │  │ • viewport: Viewport          │  │
                    │  │ • collaborators: Presence[]   │  │
                    │  │ • history: CanvasData[]       │  │
                    │  └───────────────────────────────┘  │
                    └────────────────┬────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
┌─────────────────┐       ┌───────────────────┐       ┌──────────────────┐
│   LayersPanel   │       │      Canvas       │       │ PropertiesPanel  │
│                 │       │                   │       │                  │
│ • Object list   │       │ • PixiRenderer    │       │ • Property form  │
│ • Visibility    │◄─────►│ • Mouse events    │◄─────►│ • Live updates   │
│ • Lock/Unlock   │       │ • Draw tools      │       │ • Color/Size/Pos │
│ • Layer order   │       │ • Selection       │       │                  │
└─────────────────┘       └─────────┬─────────┘       └──────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────┐
                    │       PixiRenderer.ts           │
                    │  (WebGL Rendering Engine)       │
                    │                                 │
                    │  ┌───────────────────────────┐  │
                    │  │ • Application (PIXI.js)   │  │
                    │  │ • ShapeFactory.ts         │  │
                    │  │ • SelectionOverlay.ts     │  │
                    │  │ • CollaboratorCursors     │  │
                    │  └───────────────────────────┘  │
                    └─────────────────────────────────┘
```

#### Real-time Collaboration Flow

```
┌─────────────┐                  ┌──────────────────┐                ┌─────────────┐
│  Client A   │                  │      Server      │                │  Client B   │
│             │                  │                  │                │             │
│ editorStore │                  │  WebSocket Hub   │                │ editorStore │
└──────┬──────┘                  └────────┬─────────┘                └──────┬──────┘
       │                                  │                                 │
       │  1. addObject() / updateObject() │                                 │
       │      ↓                           │                                 │
       │  2. sendOperation()              │                                 │
       │ ─────────────────────────────────►                                 │
       │                                  │                                 │
       │                         3. Persist to DB                           │
       │                         4. Broadcast                               │
       │                                  │─────────────────────────────────►
       │                                  │                                 │
       │                                  │            5. Apply operation   │
       │                                  │               to canvasData     │
       │                                  │                    ↓            │
       │                                  │            6. PixiRenderer      │
       │                                  │               re-renders        │
       │                                  │                                 │
       │  7. Presence update (cursor)     │                                 │
       │ ─────────────────────────────────►                                 │
       │                                  │─────────────────────────────────►
       │                                  │                                 │
       │              (Cursor displayed on canvas)                          │
       ▼                                  ▼                                 ▼
```

#### Renderer Architecture

The PixiJS-based rendering pipeline provides hardware-accelerated graphics:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PixiRenderer.ts (365 lines)                          │
│                      WebGL-based Rendering Engine                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         │                           │                           │
         ▼                           ▼                           ▼
┌─────────────────┐       ┌───────────────────┐       ┌──────────────────┐
│ ShapeFactory.ts │       │ SelectionOverlay  │       │ Collaborator     │
│   (199 lines)   │       │    .ts (143 ln)   │       │ Cursors          │
│                 │       │                   │       │                  │
│ Creates PIXI    │       │ Draws selection   │       │ Renders other    │
│ Graphics for:   │       │ handles, bounds   │       │ users' cursors   │
│ • Rectangle     │       │ for selected      │       │ with colors      │
│ • Ellipse       │       │ objects           │       │ and names        │
│ • Text          │       │                   │       │                  │
│ • Frame         │       │                   │       │                  │
│ • Group         │       │                   │       │                  │
└─────────────────┘       └───────────────────┘       └──────────────────┘
         │                           │                           │
         └───────────────────────────┼───────────────────────────┘
                                     │
                                     ▼
                    ┌─────────────────────────────────┐
                    │     PIXI.Application Stage      │
                    │     (WebGL Canvas Context)      │
                    │                                 │
                    │  ┌────────────────────────────┐ │
                    │  │   objectsContainer         │ │
                    │  │   (z-ordered shapes)       │ │
                    │  ├────────────────────────────┤ │
                    │  │   selectionContainer       │ │
                    │  │   (overlays)               │ │
                    │  ├────────────────────────────┤ │
                    │  │   presenceContainer        │ │
                    │  │   (collaborator cursors)   │ │
                    │  └────────────────────────────┘ │
                    └─────────────────────────────────┘
```

#### Key Frontend Files

| File | Lines | Description |
|------|-------|-------------|
| `stores/editorStore.ts` | 359 | Zustand store for all editor state (canvas, selection, viewport, history) |
| `renderer/PixiRenderer.ts` | 365 | WebGL rendering engine wrapper around PixiJS |
| `renderer/ShapeFactory.ts` | 199 | Creates PixiJS graphics for each shape type |
| `renderer/SelectionOverlay.ts` | 143 | Draws selection bounds and resize handles |
| `hooks/useWebSocket.ts` | 201 | Real-time collaboration via WebSocket |
| `components/Canvas.tsx` | 296 | Main canvas with mouse/keyboard event handling |
| `components/Editor.tsx` | 121 | Workspace layout composing all panels |
| `services/api.ts` | ~80 | REST API client for files and versions |

## Data Model

### Entity-Relationship Diagram

```
                                    ┌─────────────────┐
                                    │      users      │
                                    ├─────────────────┤
                                    │ id (PK)         │
                                    │ email (UNIQUE)  │
                                    │ name            │
                                    │ avatar_url      │
                                    │ password_hash   │
                                    │ role            │
                                    │ created_at      │
                                    │ updated_at      │
                                    └────────┬────────┘
                                             │
           ┌─────────────────────────────────┼─────────────────────────────────┐
           │ owner_id (SET NULL)             │                                 │
           ▼                                 │                                 │
    ┌─────────────────┐                      │                                 │
    │      teams      │                      │                                 │
    ├─────────────────┤                      │                                 │
    │ id (PK)         │◄──────────┐          │                                 │
    │ name            │           │          │                                 │
    │ owner_id (FK)───┼───────────┼──────────┘                                 │
    │ created_at      │           │                                            │
    │ updated_at      │           │                                            │
    └────────┬────────┘           │                                            │
             │                    │                                            │
             │ CASCADE            │ team_id (CASCADE)                          │
             ▼                    │                                            │
    ┌─────────────────┐           │                                            │
    │  team_members   │           │        ┌─────────────────┐                 │
    ├─────────────────┤           │        │    projects     │                 │
    │ id (PK)         │           │        ├─────────────────┤                 │
    │ team_id (FK)────┼───────────┘        │ id (PK)         │◄───────────┐    │
    │ user_id (FK)────┼────────────────┐   │ name            │            │    │
    │ role            │                │   │ team_id (FK)────┼────────────┼────┘
    │ joined_at       │                │   │ owner_id (FK)───┼────────────┼────┐
    │ UNIQUE(team,usr)│                │   │ created_at      │            │    │
    └─────────────────┘                │   │ updated_at      │            │    │
                                       │   └────────┬────────┘            │    │
                                       │            │                     │    │
                                       │            │ CASCADE (project_id)│    │
                                       │            ▼                     │    │
                                       │   ┌─────────────────┐            │    │
                                       │   │      files      │            │    │
                                       │   ├─────────────────┤            │    │
                                       │   │ id (PK)         │◄────────┐  │    │
                                       │   │ name            │         │  │    │
                                       │   │ project_id (FK) │         │  │    │
                                       │   │ owner_id (FK)───┼─────────┼──┘    │
                                       │   │ team_id (FK)────┼─────────┼───────┘
                                       │   │ thumbnail_url   │         │
                                       │   │ canvas_data     │         │ CASCADE
                                       │   │ created_at      │         │
                                       │   │ updated_at      │         │
                                       │   │ deleted_at      │         │
                                       │   └────────┬────────┘         │
                                       │            │                  │
           ┌───────────────────────────┼────────────┼──────────────────┤
           │                           │            │                  │
           ▼                           │            ▼                  ▼
    ┌─────────────────┐                │   ┌─────────────────┐  ┌─────────────────┐
    │ file_permissions│                │   │  file_versions  │  │    comments     │
    ├─────────────────┤                │   ├─────────────────┤  ├─────────────────┤
    │ id (PK)         │                │   │ id (PK)         │  │ id (PK)         │
    │ file_id (FK)────┼──────────┐     │   │ file_id (FK)    │  │ file_id (FK)    │
    │ user_id (FK)────┼──────────┼─────┘   │ version_number  │  │ user_id (FK)    │
    │ permission      │          │         │ name            │  │ object_id       │
    │ granted_at      │          │         │ canvas_data     │  │ position_x      │
    │ UNIQUE(file,usr)│          │         │ created_by (FK) │  │ position_y      │
    └─────────────────┘          │         │ created_at      │  │ content         │
                                 │         │ is_auto_save    │  │ parent_id (FK)──┼──┐
                                 │         │ UNIQUE(file,ver)│  │ resolved        │  │
                                 │         └─────────────────┘  │ created_at      │  │
                                 │                              │ updated_at      │  │
                                 │                              └─────────────────┘  │
                                 │                                      ▲            │
                                 │                                      │ CASCADE    │
                                 │                                      └────────────┘
                                 │
                                 │         ┌─────────────────┐
                                 │         │   operations    │
                                 │         ├─────────────────┤
                                 └─────────┤ id (PK)         │
                                           │ file_id (FK)    │
                                           │ user_id (FK)    │
                                           │ operation_type  │
                                           │ object_id       │
                                           │ property_path   │
                                           │ old_value       │
                                           │ new_value       │
                                           │ timestamp       │
                                           │ client_id       │
                                           │ created_at      │
                                           │ idempotency_key │
                                           └─────────────────┘
```

### Complete Database Schema

The schema is defined in `/backend/src/db/init.sql` and organized into 8 core tables:

#### 1. users
Stores user accounts and authentication information.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique user identifier |
| email | VARCHAR(255) | UNIQUE, NOT NULL | User email address |
| name | VARCHAR(255) | NOT NULL | Display name |
| avatar_url | VARCHAR(500) | | Profile picture URL |
| password_hash | VARCHAR(255) | NOT NULL | Bcrypt password hash |
| role | VARCHAR(50) | DEFAULT 'user' | User role (user/admin) |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Account creation time |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update time |

#### 2. teams
Groups of users collaborating on projects.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique team identifier |
| name | VARCHAR(255) | NOT NULL | Team name |
| owner_id | UUID | REFERENCES users(id) ON DELETE SET NULL | Team owner |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Team creation time |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update time |

#### 3. team_members
Junction table for user-team relationships.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique membership identifier |
| team_id | UUID | REFERENCES teams(id) ON DELETE CASCADE | Parent team |
| user_id | UUID | REFERENCES users(id) ON DELETE CASCADE | Member user |
| role | VARCHAR(50) | DEFAULT 'member' | Role in team (owner/admin/member) |
| joined_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Join date |
| | | UNIQUE(team_id, user_id) | Prevents duplicate memberships |

#### 4. projects
Folders for organizing design files within teams.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique project identifier |
| name | VARCHAR(255) | NOT NULL | Project name |
| team_id | UUID | REFERENCES teams(id) ON DELETE CASCADE | Parent team |
| owner_id | UUID | REFERENCES users(id) ON DELETE SET NULL | Project creator |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update time |

#### 5. files
Design documents containing canvas data (the core entity).

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique file identifier |
| name | VARCHAR(255) | NOT NULL | File name |
| project_id | UUID | REFERENCES projects(id) ON DELETE SET NULL | Parent project |
| owner_id | UUID | REFERENCES users(id) ON DELETE SET NULL | File creator |
| team_id | UUID | REFERENCES teams(id) ON DELETE SET NULL | Owning team |
| thumbnail_url | VARCHAR(500) | | Preview image URL |
| canvas_data | JSONB | DEFAULT '{"objects": [], "pages": []}' | Vector graphics data |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last modification time |
| deleted_at | TIMESTAMP | DEFAULT NULL | Soft delete timestamp |

**Indexes:**
- `idx_files_owner` - Lookup files by owner
- `idx_files_project` - Lookup files by project
- `idx_files_team` - Lookup files by team
- `idx_files_updated` - Sort by last update (DESC)
- `idx_files_deleted` - Partial index for active files (WHERE deleted_at IS NULL)
- `idx_files_deleted_at` - Partial index for cleanup job

#### 6. file_versions
Snapshots for version history and undo capability.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique version identifier |
| file_id | UUID | REFERENCES files(id) ON DELETE CASCADE | Parent file |
| version_number | INTEGER | NOT NULL | Sequential version number |
| name | VARCHAR(255) | | Named version label (optional) |
| canvas_data | JSONB | NOT NULL | Complete canvas snapshot |
| created_by | UUID | REFERENCES users(id) ON DELETE SET NULL | User who saved version |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Version creation time |
| is_auto_save | BOOLEAN | DEFAULT TRUE | Auto vs. manual save |
| | | UNIQUE(file_id, version_number) | Ensures sequential numbering |

**Indexes:**
- `idx_file_versions_file` - Lookup versions by file
- `idx_file_versions_file_number` - Lookup by file + version (DESC)
- `idx_file_versions_created` - Sort by creation time
- `idx_file_versions_autosave` - Filter auto-saves for cleanup

#### 7. comments
Feedback on designs with position anchoring for design review.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique comment identifier |
| file_id | UUID | REFERENCES files(id) ON DELETE CASCADE | Parent file |
| user_id | UUID | REFERENCES users(id) ON DELETE SET NULL | Comment author |
| object_id | VARCHAR(100) | | ID of attached design object |
| position_x | FLOAT | | X coordinate on canvas |
| position_y | FLOAT | | Y coordinate on canvas |
| content | TEXT | NOT NULL | Comment text |
| parent_id | UUID | REFERENCES comments(id) ON DELETE CASCADE | Parent comment (for replies) |
| resolved | BOOLEAN | DEFAULT FALSE | Comment resolution status |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Creation time |
| updated_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Last update time |

**Indexes:**
- `idx_comments_file` - Lookup comments by file

#### 8. file_permissions
Access control for individual files.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique permission identifier |
| file_id | UUID | REFERENCES files(id) ON DELETE CASCADE | Target file |
| user_id | UUID | REFERENCES users(id) ON DELETE CASCADE | Grantee user |
| permission | VARCHAR(50) | DEFAULT 'view' | Permission level (view/edit/admin) |
| granted_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Grant time |
| | | UNIQUE(file_id, user_id) | One permission per user per file |

#### 9. operations
CRDT operation log for real-time sync, undo/redo, and audit trail.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| id | UUID | PRIMARY KEY, DEFAULT uuid_generate_v4() | Unique operation identifier |
| file_id | UUID | REFERENCES files(id) ON DELETE CASCADE | Target file |
| user_id | UUID | REFERENCES users(id) ON DELETE SET NULL | User who made change |
| operation_type | VARCHAR(100) | NOT NULL | Type (create/update/delete/move) |
| object_id | VARCHAR(100) | | ID of affected design object |
| property_path | VARCHAR(255) | | Property that changed (e.g., "fill", "x") |
| old_value | JSONB | | Previous value (for undo) |
| new_value | JSONB | | New value |
| timestamp | BIGINT | NOT NULL | Client-side timestamp (ms) |
| client_id | VARCHAR(100) | | Client identifier for LWW tiebreaker |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP | Server receipt time |
| idempotency_key | VARCHAR(255) | DEFAULT NULL | Deduplication key for retries |

**Indexes:**
- `idx_operations_file` - Lookup operations by file
- `idx_operations_timestamp` - Sort by timestamp
- `idx_operations_file_timestamp` - Lookup by file + timestamp
- `idx_operations_created` - Sort by creation time
- `idx_operations_idempotency` - UNIQUE partial index (WHERE idempotency_key IS NOT NULL)
- `idx_operations_idempotency_lookup` - Partial index for file + idempotency key

### Foreign Key Relationships and Cascade Behaviors

| Relationship | On Delete Behavior | Rationale |
|--------------|-------------------|-----------|
| teams.owner_id -> users.id | SET NULL | Team persists if owner leaves; can be reassigned |
| team_members.team_id -> teams.id | CASCADE | Members removed when team is deleted |
| team_members.user_id -> users.id | CASCADE | Membership removed when user is deleted |
| projects.team_id -> teams.id | CASCADE | Projects removed when team is deleted |
| projects.owner_id -> users.id | SET NULL | Project persists; owner can be reassigned |
| files.project_id -> projects.id | SET NULL | Files become orphaned (can be moved to another project) |
| files.owner_id -> users.id | SET NULL | File persists; owner can be reassigned |
| files.team_id -> teams.id | SET NULL | File persists; can be reassigned to another team |
| file_versions.file_id -> files.id | CASCADE | Versions deleted with file |
| file_versions.created_by -> users.id | SET NULL | Version persists; creator reference cleared |
| comments.file_id -> files.id | CASCADE | Comments deleted with file |
| comments.user_id -> users.id | SET NULL | Comment persists; author reference cleared |
| comments.parent_id -> comments.id | CASCADE | Replies deleted with parent comment |
| file_permissions.file_id -> files.id | CASCADE | Permissions deleted with file |
| file_permissions.user_id -> users.id | CASCADE | Permission deleted when user is deleted |
| operations.file_id -> files.id | CASCADE | Operations deleted with file |
| operations.user_id -> users.id | SET NULL | Operation persists; user reference cleared |

### Why Tables Are Structured This Way

**1. User/Team/Project Hierarchy**
The three-tier hierarchy (Users -> Teams -> Projects -> Files) mirrors Figma's organizational model:
- Users belong to multiple teams (via team_members junction table)
- Teams contain projects as organizational folders
- Projects contain files
- Files can optionally exist outside projects (project_id is nullable)

This allows both personal files (no team) and organized team collaboration.

**2. Denormalized canvas_data JSONB**
Canvas data is stored as a single JSONB blob rather than normalized into object tables because:
- Design objects have highly variable schemas (rectangles vs. text vs. groups)
- JSONB allows atomic snapshots for versioning
- Avoids expensive joins when loading/saving designs
- PostgreSQL JSONB indexing provides querying capability if needed

**3. Separate operations table**
Operations are logged separately from canvas_data to support:
- Real-time CRDT synchronization between clients
- Fine-grained undo/redo without version snapshots
- Audit trail for debugging collaboration conflicts
- Rebuilding canvas state from operations if needed

**4. Dual-index soft delete on files**
Two partial indexes on deleted_at enable:
- Fast queries for active files (WHERE deleted_at IS NULL)
- Efficient cleanup job queries (WHERE deleted_at IS NOT NULL)
- No index overhead for the common case (active file lookups)

**5. Idempotency key with partial unique index**
The idempotency_key column with a partial unique index (WHERE idempotency_key IS NOT NULL) allows:
- Safe operation retries over unreliable WebSocket connections
- Deduplication without blocking operations that do not need idempotency
- Efficient lookups by file + idempotency_key

### Data Flow Between Tables

```
                        WRITE PATH
                        ==========

User creates design     Browser Canvas
         │                    │
         ▼                    ▼
    ┌─────────┐        ┌───────────────┐
    │  users  │        │   Operation   │
    └────┬────┘        │   (CRDT op)   │
         │             └───────┬───────┘
         │                     │
         │         WebSocket   │
         │             ▼       ▼
         │        ┌─────────────────┐
         │        │   operations    │  (log for sync/undo)
         │        └────────┬────────┘
         │                 │
         │                 │ Apply to canvas
         │                 ▼
         │        ┌─────────────────┐
         │        │      files      │  (update canvas_data JSONB)
         │        │  .canvas_data   │
         │        └────────┬────────┘
         │                 │
         │                 │ Periodic snapshot
         │                 ▼
         │        ┌─────────────────┐
         └───────►│  file_versions  │  (full canvas backup)
                  └─────────────────┘


                        READ PATH
                        =========

Browser requests file
         │
         ▼
    ┌─────────────────┐
    │      files      │  (load canvas_data)
    └────────┬────────┘
             │
             ├──────────────────┐
             │                  │
             ▼                  ▼
    ┌─────────────────┐  ┌─────────────────┐
    │    comments     │  │  file_versions  │
    │   (load pins)   │  │  (show history) │
    └─────────────────┘  └─────────────────┘


                   COLLABORATION FLOW
                   ==================

  Client A                 Server                  Client B
     │                        │                        │
     │  1. operation          │                        │
     │ ────────────────────►  │                        │
     │                        │  2. persist to         │
     │                        │     operations table   │
     │                        │                        │
     │                        │  3. update files       │
     │                        │     .canvas_data       │
     │                        │                        │
     │                        │  4. broadcast          │
     │                        │ ────────────────────►  │
     │                        │                        │
     │  5. ack                │                        │
     │ ◄────────────────────  │                        │
     │                        │                        │
```

### Migration History

The schema is maintained through incremental migrations:

| Migration | Description |
|-----------|-------------|
| 001_initial_schema.sql | Core tables: files, file_versions, operations with indexes |
| 002_add_soft_delete.sql | Added deleted_at column to files with partial indexes |
| 003_add_idempotency_key.sql | Added idempotency_key to operations for safe retries |

All migrations are consolidated into `init.sql` for fresh database setup while individual migration files remain for incremental upgrades.

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

## Failure Handling

### Retry Strategy with Idempotency Keys

All mutating operations use idempotency keys to ensure safe retries:

```typescript
// Client generates idempotency key per operation
interface Operation {
  idempotencyKey: string;  // UUIDv4 generated client-side
  fileId: string;
  operationType: 'create' | 'update' | 'delete';
  objectId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// Server deduplication in Redis (5-minute TTL)
async function processOperation(op: Operation): Promise<boolean> {
  const key = `idempotency:${op.idempotencyKey}`;
  const exists = await redis.set(key, '1', 'NX', 'EX', 300);
  if (!exists) {
    return false; // Already processed, skip
  }
  // Process operation...
  return true;
}
```

**Retry policy** (exponential backoff):
- Initial delay: 100ms
- Max delay: 5s
- Max attempts: 3
- Jitter: 0-100ms random addition

### Circuit Breaker Pattern

For database and Redis connections:

```typescript
// Circuit breaker states
enum CircuitState { CLOSED, OPEN, HALF_OPEN }

// Configuration for local development
const circuitConfig = {
  failureThreshold: 5,      // Open after 5 failures
  successThreshold: 2,      // Close after 2 successes in half-open
  timeout: 10000,           // 10s before trying half-open
};

// Health check endpoint reports circuit states
GET /health -> {
  postgres: { state: 'CLOSED', failures: 0 },
  redis: { state: 'CLOSED', failures: 0 },
  websocket: { connections: 3, state: 'healthy' }
}
```

### WebSocket Reconnection

Client-side reconnection with backoff:
1. Connection lost: Wait 1s, attempt reconnect
2. Still disconnected: Wait 2s, 4s, 8s (max 30s)
3. On reconnect: Re-subscribe to file, request full sync
4. Pending operations: Replay from local queue after sync

### Backup and Restore Testing

**Database backup (local development):**

```bash
# Manual backup before schema changes
pg_dump -h localhost -U postgres figma_db > backup_$(date +%Y%m%d_%H%M%S).sql

# Restore from backup
psql -h localhost -U postgres figma_db < backup_20240116_120000.sql
```

**Automated backup script (add to package.json):**

```json
{
  "scripts": {
    "db:backup": "pg_dump -h localhost -U postgres figma_db > ./backups/backup_$(date +%Y%m%d_%H%M%S).sql",
    "db:restore": "psql -h localhost -U postgres figma_db < $1"
  }
}
```

**Testing backup/restore:**
1. Create test file with several objects
2. Run `npm run db:backup`
3. Delete the file via API
4. Run `npm run db:restore` with backup file
5. Verify file and objects restored correctly

### Disaster Recovery (Local Dev)

For local development, "disaster recovery" means recovering from:
- Corrupted database: Restore from most recent backup
- Lost Redis data: Presence rebuilds on reconnect; no persistent data lost
- Crashed server: Restart with `npm run dev`; clients auto-reconnect

**Recovery checklist:**
1. Check PostgreSQL: `docker-compose ps` or `pg_isready`
2. Check Redis: `redis-cli ping`
3. Restart backend: `npm run dev`
4. Clients refresh browser to reconnect

## Data Lifecycle Policies

### Retention and TTL

| Data Type | Retention | Storage | Cleanup Method |
|-----------|-----------|---------|----------------|
| Active files | Indefinite | PostgreSQL | Manual delete |
| File versions | 90 days (auto-save) / Indefinite (named) | PostgreSQL | Scheduled job |
| Operations log | 30 days | PostgreSQL | Scheduled job |
| Presence data | 60 seconds | Redis | TTL auto-expire |
| Idempotency keys | 5 minutes | Redis | TTL auto-expire |

### Auto-save Version Cleanup

```sql
-- Delete auto-save versions older than 90 days, keeping at least 10 per file
DELETE FROM file_versions
WHERE is_auto_save = true
  AND created_at < NOW() - INTERVAL '90 days'
  AND id NOT IN (
    SELECT id FROM file_versions fv2
    WHERE fv2.file_id = file_versions.file_id
    ORDER BY created_at DESC
    LIMIT 10
  );
```

**Scheduled job (add to backend):**

```typescript
// Run daily at 3 AM via node-cron
import cron from 'node-cron';

cron.schedule('0 3 * * *', async () => {
  await cleanupOldAutoSaves();
  await cleanupOldOperations();
  console.log('Daily cleanup completed');
});
```

### Operations Log Archival

For learning purposes, operations older than 30 days are deleted rather than archived:

```sql
-- Weekly cleanup of old operations
DELETE FROM operations
WHERE created_at < NOW() - INTERVAL '30 days';
```

**Production consideration:** In production, archive to cold storage (S3 Glacier) before deletion for audit trails.

### Backfill and Replay Procedures

**Rebuilding canvas from operations (backfill):**

```typescript
async function rebuildCanvasFromOperations(fileId: string, upToTimestamp?: number): Promise<CanvasData> {
  const operations = await db.query(`
    SELECT * FROM operations
    WHERE file_id = $1
      AND ($2::bigint IS NULL OR timestamp <= $2)
    ORDER BY timestamp ASC
  `, [fileId, upToTimestamp]);

  let canvas: CanvasData = { objects: [], pages: [] };
  for (const op of operations.rows) {
    canvas = applyOperation(canvas, op);
  }
  return canvas;
}
```

**Replay procedure for debugging:**

```bash
# Export operations for a file to JSON
psql -h localhost -U postgres -d figma_db -c \
  "SELECT row_to_json(operations) FROM operations WHERE file_id='<UUID>' ORDER BY timestamp" \
  > operations_export.json

# Replay in development environment
npm run replay -- --file=operations_export.json
```

### Soft Delete Implementation

Files use soft delete to allow recovery:

```sql
ALTER TABLE files ADD COLUMN deleted_at TIMESTAMP DEFAULT NULL;

-- Soft delete a file
UPDATE files SET deleted_at = NOW() WHERE id = $1;

-- Query only active files
SELECT * FROM files WHERE deleted_at IS NULL;

-- Hard delete after 30 days (cleanup job)
DELETE FROM files WHERE deleted_at < NOW() - INTERVAL '30 days';
```

## Deployment and Operations

### Local Development Rollout Strategy

**Starting services (development):**

```bash
# Option 1: Docker Compose (recommended)
docker-compose up -d          # Start PostgreSQL + Redis
npm run dev                   # Start backend

# Option 2: Native services
brew services start postgresql@16
brew services start redis
npm run dev
```

**Hot reload workflow:**
- Backend: `nodemon` watches `src/` for changes
- Frontend: Vite HMR for instant updates
- No manual restart needed for code changes

### Schema Migration Procedures

**Migration file naming convention:**

```
backend/src/db/migrations/
├── 001_initial_schema.sql
├── 002_add_deleted_at.sql
├── 003_add_operation_indexes.sql
└── ...
```

**Migration script (backend/src/db/migrate.ts):**

```typescript
const migrations = [
  { version: 1, file: '001_initial_schema.sql' },
  { version: 2, file: '002_add_deleted_at.sql' },
  // Add new migrations here
];

async function migrate() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const applied = await db.query('SELECT version FROM schema_migrations');
  const appliedVersions = new Set(applied.rows.map(r => r.version));

  for (const m of migrations) {
    if (!appliedVersions.has(m.version)) {
      console.log(`Applying migration ${m.file}...`);
      const sql = fs.readFileSync(`./migrations/${m.file}`, 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (version) VALUES ($1)', [m.version]);
    }
  }
}
```

**Running migrations:**

```bash
npm run db:migrate           # Apply pending migrations
npm run db:migrate:status    # Show applied migrations
```

**Pre-migration checklist:**
1. Create database backup: `npm run db:backup`
2. Review migration SQL for destructive operations
3. Test migration on local copy first
4. Apply migration: `npm run db:migrate`
5. Verify application still works

### Rollback Runbook

**Scenario 1: Bad migration (schema change broke the app)**

```bash
# 1. Stop the backend
Ctrl+C

# 2. Restore from backup taken before migration
npm run db:restore -- backups/backup_pre_migration.sql

# 3. Remove the bad migration from migrations list
# Edit backend/src/db/migrate.ts to comment out the migration

# 4. Restart backend
npm run dev

# 5. Fix the migration SQL, then re-apply
```

**Scenario 2: Bad deployment (code change broke the app)**

```bash
# 1. Git revert to previous commit
git log --oneline -5          # Find the good commit
git checkout <good-commit>

# 2. Reinstall dependencies if package.json changed
npm install

# 3. Restart services
npm run dev
```

**Scenario 3: Data corruption (file canvas_data is invalid)**

```bash
# 1. Identify the affected file
psql -c "SELECT id, name FROM files WHERE canvas_data IS NULL OR canvas_data = '{}'"

# 2. Restore from most recent version
psql -c "
  UPDATE files f
  SET canvas_data = (
    SELECT canvas_data FROM file_versions fv
    WHERE fv.file_id = f.id
    ORDER BY created_at DESC
    LIMIT 1
  )
  WHERE f.id = '<file_id>'
"

# 3. If no versions exist, rebuild from operations
npm run rebuild-canvas -- --file=<file_id>
```

### Health Checks and Monitoring

**Health check endpoint (`/health`):**

```json
{
  "status": "healthy",
  "uptime": 3600,
  "postgres": { "connected": true, "latency_ms": 2 },
  "redis": { "connected": true, "latency_ms": 1 },
  "websocket": { "connections": 3, "files_subscribed": 2 }
}
```

**Manual health checks:**

```bash
# Check PostgreSQL
pg_isready -h localhost -p 5432

# Check Redis
redis-cli ping

# Check backend
curl http://localhost:3000/health

# Check WebSocket (via wscat)
npx wscat -c ws://localhost:3000
```

**Logging levels (configurable via LOG_LEVEL env var):**
- `error`: Unhandled exceptions, database failures
- `warn`: Circuit breaker state changes, retry attempts
- `info`: Connection events, file subscriptions
- `debug`: Individual operations, SQL queries

## Future Optimizations

1. **Raw WebGL Shaders**: Custom shaders for advanced effects (blur, shadows, filters)
2. **CRDT Library**: Yjs or Automerge for robust conflict resolution
3. **Viewport Culling**: Only sync objects in view
4. **Delta Compression**: Send only changed properties
5. **Offline Support**: IndexedDB for local persistence

## Implementation Notes

This section explains the rationale behind key architectural decisions implemented in the codebase.

### Why Idempotency Enables Reliable CRDT Operations

Idempotency is critical for collaborative editing because:

1. **Network Unreliability**: WebSocket connections can drop and reconnect. Clients may retry operations that actually succeeded on the server but for which they never received acknowledgment. Without idempotency, these retries would create duplicate objects or apply updates multiple times.

2. **CRDT Convergence**: CRDTs (Conflict-free Replicated Data Types) guarantee eventual consistency only when operations are applied exactly once. If a "create rectangle" operation is applied twice, you get two rectangles instead of one, breaking the fundamental CRDT guarantee.

3. **Safe Client Retries**: With idempotency keys, clients can implement aggressive retry logic (exponential backoff) without fear of corrupting the document state. This is especially important for mobile clients with intermittent connectivity.

**Implementation approach:**
- Client generates a UUID idempotency key per operation
- Server checks Redis for the key before processing (5-minute TTL)
- If key exists, return cached result without re-processing
- If operation fails, key is cleared to allow retry

```typescript
// Example: Client-side operation with idempotency
const operation = {
  idempotencyKey: crypto.randomUUID(),
  operationType: 'create',
  objectId: newObjectId,
  payload: { type: 'rectangle', x: 100, y: 100 }
};
// Safe to retry on network failure - server deduplicates
```

### Why Circuit Breakers Protect Real-Time Collaboration

Circuit breakers prevent cascading failures in the real-time sync system:

1. **Broadcast Amplification**: When one client makes an edit, it broadcasts to N other clients. If the broadcast system is failing, each edit attempt adds load to an already struggling system. Circuit breakers stop this amplification.

2. **Graceful Degradation**: When the sync circuit opens, clients continue to work locally with optimistic updates. When it closes again, they automatically re-sync. Users experience a brief lag rather than complete failure.

3. **Resource Protection**: Without circuit breakers, a failing Redis instance could cause all WebSocket handlers to block waiting for responses, eventually exhausting connection pools and crashing the server.

**Configuration rationale:**
```typescript
const syncConfig = {
  errorThresholdPercentage: 60,  // More tolerant for sync (some failures OK)
  resetTimeout: 5000,            // Quick recovery for real-time UX
  timeout: 3000,                 // Fast fail for responsive editing
  volumeThreshold: 10            // Need meaningful sample before opening
};
```

The sync circuit breaker is more tolerant (60% threshold) because occasional broadcast failures to a single client are acceptable - that client will catch up on reconnect. Database circuit breakers are stricter (50%) because data consistency is critical.

### Why Version History Retention Balances Undo Capability vs Storage

The retention policy makes explicit tradeoffs:

| Data Type | Retention | Rationale |
|-----------|-----------|-----------|
| Auto-save versions | 90 days, min 10/file | Users rarely need undo beyond 3 months |
| Named versions | Indefinite | Explicit save = explicit intent to preserve |
| Operations log | 30 days | Needed for replay/debug, not long-term storage |
| Soft-deleted files | 30 days | Recovery window for accidental deletes |

**Storage cost analysis:**
- Average file: 500KB canvas data
- With 100 versions: 50MB per file
- Cleanup reduces to ~15MB (10 auto-saves + named versions)
- 70% storage reduction while preserving user-critical history

**Minimum version guarantee:**
Even with 90-day cleanup, we always keep at least 10 auto-save versions per file. This ensures recent undo capability regardless of age.

```typescript
// Cleanup query preserves minimum versions
DELETE FROM file_versions
WHERE is_auto_save = true
  AND created_at < NOW() - INTERVAL '90 days'
  AND id NOT IN (
    SELECT id FROM ranked_versions WHERE rn <= 10
  );
```

### Why Metrics Enable Collaboration Optimization

Prometheus metrics provide actionable insights for real-time collaboration:

1. **Active Collaborators Gauge** (`figma_active_collaborators`):
   - Identify hot files with many concurrent editors
   - Trigger auto-scaling decisions
   - Detect potential performance bottlenecks before users notice

2. **Sync Latency Histogram** (`figma_sync_latency_seconds`):
   - Measure p50/p95/p99 latency for presence and operation broadcasts
   - Target: p95 < 100ms for presence, < 200ms for operations
   - Alert if latency degrades, indicating infrastructure issues

3. **Operation Counter** (`figma_operations_total`):
   - Track create/update/delete/move by status (success/error)
   - Calculate error rates to detect client bugs or API issues
   - Identify most common operation types for optimization focus

4. **Circuit Breaker State** (`figma_circuit_breaker_state`):
   - 0 = closed (healthy), 1 = open (failing), 2 = half-open (testing)
   - Alert on state transitions to detect infrastructure problems
   - Track recovery time to tune circuit breaker parameters

**Example Grafana dashboard queries:**
```promql
# Average active collaborators per file
avg(figma_active_collaborators) by (file_id)

# 95th percentile sync latency
histogram_quantile(0.95, rate(figma_sync_latency_seconds_bucket[5m]))

# Operation error rate
sum(rate(figma_operations_total{status="error"}[5m])) /
sum(rate(figma_operations_total[5m]))
```

### Shared Module Architecture

The backend uses a layered architecture with shared modules:

```
src/
├── shared/                  # Cross-cutting concerns
│   ├── logger.ts           # Pino structured logging
│   ├── metrics.ts          # Prometheus metrics
│   ├── circuitBreaker.ts   # Opossum circuit breakers
│   ├── retry.ts            # Exponential backoff
│   ├── idempotency.ts      # Redis-based deduplication
│   └── retention.ts        # Version cleanup scheduling
├── db/
│   ├── postgres.ts         # Connection pool + query helpers
│   ├── redis.ts            # Redis clients (main + pub/sub)
│   ├── migrate.ts          # Migration runner
│   └── migrations/         # SQL migration files
├── services/               # Business logic
├── routes/                 # REST API handlers
├── websocket/              # Real-time sync handlers
└── types/                  # TypeScript interfaces
```

This separation enables:
- Consistent logging and metrics across all components
- Reusable retry and circuit breaker logic
- Testable business logic isolated from infrastructure concerns

