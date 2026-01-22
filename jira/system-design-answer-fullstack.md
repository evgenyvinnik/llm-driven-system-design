# Design Jira - System Design Answer (Fullstack Focus)

*45-minute system design interview format - Fullstack Engineer Position*

## Introduction (2 minutes)

"Thanks for the opportunity. Today I'll design Jira, an issue tracking and project management system. As a fullstack engineer, I'll focus on the integration points between frontend and backend:

1. **End-to-end workflow transitions** from drag-drop to database update
2. **Optimistic updates with conflict resolution** using version-based locking
3. **Real-time board synchronization** when teammates modify issues
4. **JQL search** from autocomplete input to Elasticsearch query
5. **Shared type contracts** ensuring consistency across the stack

I'll demonstrate how frontend and backend work together to deliver a responsive, consistent experience."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For the integrated system:

1. **Board Operations**: Drag issues across columns with instant feedback
2. **Issue Editing**: Inline field changes with server persistence
3. **Workflow Transitions**: Execute transitions with validation
4. **Search**: JQL queries with autocomplete and results
5. **Real-time Updates**: See teammate changes without refresh"

### Non-Functional Requirements

"For user experience and reliability:

- **Latency**: < 100ms perceived response for all interactions
- **Consistency**: No lost updates from concurrent edits
- **Offline Resilience**: Queue operations when disconnected
- **Type Safety**: Shared contracts prevent runtime errors"

---

## Architecture Overview (8 minutes)

### End-to-End Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         FRONTEND                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Board       │  │ Issue       │  │ Search      │              │
│  │ Component   │  │ Detail      │  │ Component   │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         ▼                ▼                ▼                      │
│  ┌─────────────────────────────────────────────────┐            │
│  │              Zustand Stores                      │            │
│  │   boardStore │ issueStore │ searchStore          │            │
│  └─────────────────────────────────────────────────┘            │
│         │                │                │                      │
│         ▼                ▼                ▼                      │
│  ┌─────────────────────────────────────────────────┐            │
│  │              API Service (fetch + WebSocket)     │            │
│  └─────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         BACKEND                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Issue       │  │ Workflow    │  │ Search      │              │
│  │ Service     │  │ Engine      │  │ Service     │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         ▼                ▼                ▼                      │
│  ┌─────────────────────────────────────────────────┐            │
│  │   PostgreSQL   │   Redis   │   Elasticsearch    │            │
│  └─────────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

### Shared Type Contracts

The system uses shared TypeScript interfaces between frontend and backend for type safety. Key entities include:

**Issue**: Core entity with id, key, summary, description, issueType, status, priority, assignee, reporter, storyPoints, customFields, version (for optimistic locking), and timestamps.

**Status**: Represents workflow states with id, name, and category (todo, in_progress, done).

**Transition**: Defines workflow movements with from/to status and validation rules.

**UpdateIssueRequest**: Partial updates requiring version number for conflict detection.

**ApiError**: Standardized error responses with codes (CONFLICT, VALIDATION_ERROR, FORBIDDEN, NOT_FOUND).

---

## Deep Dive: Workflow Transition Flow (12 minutes)

### Drag-and-Drop Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    DRAG EVENT INITIATED                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. OPTIMISTIC UPDATE                                            │
│     ├── Store original columns state                             │
│     ├── Move issue to target column in UI                        │
│     └── User sees immediate feedback                             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. FETCH AVAILABLE TRANSITIONS                                  │
│     └── GET /api/v1/issues/{key}/transitions                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. EXECUTE TRANSITION                                           │
│     └── POST /api/v1/issues/{id}/transitions                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│      SUCCESS         │        │       FAILURE        │
│  Update confirmed    │        │  Rollback UI state   │
│  Broadcast via WS    │        │  Show error toast    │
└──────────────────────┘        └──────────────────────┘
```

### Backend Workflow Engine

The workflow engine is database-driven with three validation phases:

**Conditions** (Authorization):
- `always` - Always allow transition
- `user_in_role` - User must have specific project role
- `issue_assignee` - Only assignee can transition

**Validators** (Data Validation):
- `field_required` - Field must have value
- `field_value` - Field must match specific value

**Post-Functions** (Side Effects):
- `assign_to_current_user` - Auto-assign on transition
- `clear_field` - Reset field value
- `update_field` - Set field to specific value
- `send_notification` - Trigger notifications

### Transaction Flow

```
┌─────────────┐     ┌─────────────────────────────────────────────┐
│   Client    │     │                  Backend                     │
└──────┬──────┘     └──────────────────────┬──────────────────────┘
       │                                    │
       │  POST /transitions                 │
       │───────────────────────────────────▶│
       │                                    │
       │                    ┌───────────────┴───────────────┐
       │                    │ 1. Load issue from database   │
       │                    │ 2. Find workflow for project  │
       │                    │ 3. Locate transition by ID    │
       │                    │ 4. Check source status match  │
       │                    └───────────────┬───────────────┘
       │                                    │
       │                    ┌───────────────┴───────────────┐
       │                    │ 5. Run conditions (auth)      │
       │                    │ 6. Run validators (data)      │
       │                    └───────────────┬───────────────┘
       │                                    │
       │                    ┌───────────────┴───────────────┐
       │                    │ 7. BEGIN TRANSACTION          │
       │                    │ 8. UPDATE with version check  │
       │                    │ 9. INSERT history record      │
       │                    │ 10. COMMIT                    │
       │                    └───────────────┬───────────────┘
       │                                    │
       │                    ┌───────────────┴───────────────┐
       │                    │ 11. Run post-functions        │
       │                    │ 12. Publish WebSocket event   │
       │                    └───────────────┬───────────────┘
       │                                    │
       │  200 OK (updated issue)            │
       │◀───────────────────────────────────│
       │                                    │
```

---

## Deep Dive: Conflict Resolution (8 minutes)

### Version-Based Optimistic Locking

```
Timeline of concurrent edits:

User A reads issue (version 1)
                                    User B reads issue (version 1)
User A updates summary (version 1 ──▶ 2)
                                    User B updates priority (version 1 ──▶ ?)
                                    ↓
                                    CONFLICT! Version mismatch
                                    ↓
                                    UI shows merge dialog
```

### Conflict Detection Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      UPDATE REQUEST                              │
│                  (includes version: N)                           │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  UPDATE issues SET ... WHERE id = ? AND version = N             │
└──────────────────────────┬──────────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│  rows_affected = 1   │        │  rows_affected = 0   │
│  SUCCESS             │        │  VERSION MISMATCH    │
│  Increment version   │        │  Return 409 Conflict │
└──────────────────────┘        └──────────────────────┘
```

### Frontend Conflict Resolution

When a conflict is detected, the frontend:

1. **Rollback UI** to previous state
2. **Fetch server version** to get current data
3. **Display conflict dialog** with options:
   - "Discard My Changes" - Accept server version
   - "Keep My Changes" - Retry with new version number
   - "Merge" - Open merge UI (for complex cases)

"I chose version-based optimistic locking over pessimistic locking because it allows multiple users to view and start editing simultaneously. Conflicts are rare in practice, and when they occur, the user has full context to make the right decision."

---

## Deep Dive: Real-Time Updates (8 minutes)

### WebSocket Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Browser A  │     │  Browser B  │     │  Browser C  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │      WebSocket Connections            │
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│                   WebSocket Hub                      │
│           (subscriptions by project/board)           │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│                    Redis Pub/Sub                     │
│               (cross-server messaging)               │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│                   Issue Service                      │
│              (publishes events on changes)           │
└─────────────────────────────────────────────────────┘
```

### Subscription Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLIENT SUBSCRIPTIONS                          │
├─────────────────────────────────────────────────────────────────┤
│  Channel Pattern          │  Example                             │
├───────────────────────────┼─────────────────────────────────────┤
│  board:{projectId}        │  board:123                          │
│  issue:{issueKey}         │  issue:PROJ-456                     │
└─────────────────────────────────────────────────────────────────┘
```

### Event Flow

```
┌─────────────┐                    ┌─────────────┐
│ User A      │                    │ User B      │
│ (Actor)     │                    │ (Observer)  │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  1. Drag issue                   │
       │───────────────▶                  │
       │                                  │
       │  2. Optimistic update            │
       │  (UI updates immediately)        │
       │                                  │
       │  3. Server confirms              │
       │◀─ ─ ─ ─ ─ ─ ─ ─                  │
       │                                  │
       │  4. Event published              │
       │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶│
       │                                  │
       │                    5. UI updates │
       │                    automatically │
       │                                  │
```

### Smart Event Filtering

"The WebSocket hub does not broadcast to the actor who initiated the change. Since they already have the optimistic update, sending them the confirmation would cause unnecessary re-renders or potential state conflicts."

---

## Deep Dive: JQL Search Integration (5 minutes)

### Search Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         SEARCH FLOW                              │
└─────────────────────────────────────────────────────────────────┘

┌─────────────┐     ┌─────────────┐     ┌─────────────────────────┐
│   Search    │     │   JQL       │     │    Elasticsearch        │
│   Input     │────▶│   Parser    │────▶│    Query                │
└─────────────┘     └─────────────┘     └─────────────────────────┘
       │                   │                        │
       │                   │                        │
       ▼                   ▼                        ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────────────────┐
│ Debounce    │     │ AST         │     │ Permission              │
│ 300ms       │     │ Generation  │     │ Filtering               │
└─────────────┘     └─────────────┘     └─────────────────────────┘
```

### JQL Parsing Pipeline

```
Input: "project = DEMO AND status = 'In Progress'"
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  TOKENIZER                                                       │
│  ├── project (FIELD)                                             │
│  ├── = (OPERATOR)                                                │
│  ├── DEMO (VALUE)                                                │
│  ├── AND (BOOLEAN)                                               │
│  ├── status (FIELD)                                              │
│  ├── = (OPERATOR)                                                │
│  └── 'In Progress' (VALUE)                                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  AST BUILDER                                                     │
│  {                                                               │
│    type: "AND",                                                  │
│    left: { field: "project", op: "=", value: "DEMO" },          │
│    right: { field: "status", op: "=", value: "In Progress" }    │
│  }                                                               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  ELASTICSEARCH QUERY                                             │
│  {                                                               │
│    bool: {                                                       │
│      must: [                                                     │
│        { term: { project_key: "DEMO" } },                        │
│        { term: { status: "In Progress" } }                       │
│      ]                                                           │
│    }                                                             │
│  }                                                               │
└─────────────────────────────────────────────────────────────────┘
```

### Supported JQL Features

| Feature | Examples |
|---------|----------|
| Boolean operators | AND, OR |
| Grouping | Parentheses for precedence |
| Comparison | =, !=, ~, >, <, >=, <=, IN, NOT IN, IS, IS NOT |
| Functions | currentUser(), now(), startOfDay(), endOfDay() |

---

## Trade-offs and Alternatives

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Conflict resolution | Version-based OCC | Last-write-wins | Prevents silent data loss |
| Real-time | WebSocket + Redis | Polling | Lower latency, better UX |
| Search | Elasticsearch | PostgreSQL FTS | Complex JQL, aggregations |
| State sync | Event-driven | Full refresh | Efficient updates |
| Type sharing | Manual contracts | OpenAPI codegen | Simpler, less tooling |

---

## Summary

"I've designed Jira with end-to-end integration:

1. **Workflow Transitions**: Drag-drop triggers optimistic update, backend validates conditions/permissions, executes atomically with version check, broadcasts via WebSocket
2. **Conflict Resolution**: Version-based locking with merge UI when conflicts detected
3. **Real-Time Updates**: WebSocket hub with Redis pub/sub for cross-server delivery, smart subscription management
4. **JQL Search**: Frontend autocomplete, backend parser translates to Elasticsearch queries
5. **Shared Contracts**: TypeScript interfaces used by both frontend and backend ensure type safety

The design prioritizes immediate feedback through optimistic updates while maintaining data integrity through version-based conflict detection and proper error handling."
