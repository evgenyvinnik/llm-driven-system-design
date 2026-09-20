# Google Sheets architecture

## System Overview

This learning project explores a collaborative spreadsheet: a large editable grid, shared cell values, presence, and formulas. The production proposal below explains how durable edit ordering, revisioned calculation, and responsive rendering can fit together. It is a design exercise, not a claim about Google's internal architecture.

The local implementation is substantially smaller: React and Zustand, an Express/WebSocket process, PostgreSQL, and Valkey. [Implementation Notes](#implementation-notes) traces actual behavior and defects. The local SQL is reproduced in [Database Schema](#database-schema); proposed production additions are listed separately. Setup belongs in the [README](./README.md).

## Requirements

### Proposed production scope

Support workbooks with multiple sheets, cell values and formatting, bounded rectangular paste, arithmetic and allowlisted formulas with same-workbook references, collaborative presence, and conditional undo. Distinguish document edits from ephemeral cursor movement. A committed edit must survive process failure and must have one stable identity across retries.

Start with fixed row/column coordinates and bounded workbook dimensions. Structural insertion/deletion, macros, arbitrary scripts, external workbook references, full Excel compatibility, and unrestricted offline merging are out of scope. Adding structural edits later requires stable row/column identities or a tested coordinate transformation protocol; a cell register alone is insufficient.

| Requirement | Proposed target / policy |
|-------------|--------------------------|
| Interaction | Visible typing and selection feedback within a 16 ms frame budget on the reference device |
| Initial load | Useful first viewport within 2 seconds at p95 for the agreed workbook/network fixture |
| Edit durability | Commit acknowledgement within 200 ms at p95 in the home region |
| Collaboration | Canonical peer update within 300 ms at p95 under normal load |
| Recalculation | Ordinary dependency changes within 500 ms at p95; expose lag for expensive cases |
| Availability | 99.9% monthly editing availability; reject writes when authority is unavailable |
| Correctness | Monotonic workbook revisions, durable duplicate detection, revision-labeled results |
| Limits | Initially 200,000 populated cells, 100 editors, and 1,000 cells per paste per workbook |

These are proposed acceptance targets, not measurements of this repository. A workbook's aggregate formula cost also needs explicit limits; a cell count alone does not bound dependency fanout.

## Capacity Estimation

Assume one million daily editors and 100 committed cell edits per editor per day: 100 million edits/day, approximately 1,157 edits/second average. A planning peak of ten times average is about 11,600 edits/second. Keystrokes within a single-cell draft are local; Enter, blur, or paste creates an operation. Do not size durable storage as if every keypress were a saved edit.

At an illustrative 500 bytes per operation record, the log alone grows by about 50 GB/day before indexes, replication, snapshots, or retention. With ten average recipients per edit, peak fanout approaches 116,000 deliveries/second. Presence has a separate message budget and can be sampled or dropped. A single popular workbook can saturate its ordering queue while fleet utilization remains low.

### Local Development Scale

The browser exposes 1,000 × 26 positions. It retrieves all stored cells from the first sheet on connection and virtualizes rendering only. The optional seed inserts 44 cells across three workbooks and five sheets. No benchmark establishes the local server's maximum workbook size or collaboration capacity.

## High-Level Architecture

**Proposed production system.** Boxes are logical responsibilities; the initial deployment can combine the gateway, owner, and range reader while preserving their contracts.

```
┌────────────────────────┐ HTTPS  ┌────────────────────────┐        ┌────────────────────────┐
│ Clients                │        │ API + socket gateway   │        │ Workbook owner         │
│ Edits / range reads    │◀──────▶│ Auth, ACL, limits      │◀──────▶│ Fenced ordering        │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                                                                                           ▲
                                                                                           │
                                                    edit + revision + receipt              │
                                                                                           │
                                                                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ PostgreSQL partition (workbook ID): authoritative state                                    │
│ ACL, owner epoch, raw cells, ordered commits, receipts, outbox                             │
│ Immutable snapshot chunks + versioned formula-result batches                               │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                       ▲                                  ▲                                ▲
                       │                                  │                                │
 snapshot + replay     │           committed outbox       │          inputs / results      │
                       │                                  │                                │
                       ▼                                  ▼                                ▼
┌────────────────────────┐        ┌────────────────────────┐job/ACK ┌────────────────────────┐
│ Range reader           │        │ Outbox relay           │        │ Formula workers        │
│ Revision-pinned reads  │        │ Retry by event ID      │◀──────▶│ Pinned input / result  │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
                       ▲                                  ▲
                       │                                  │
 scoped ranges         │           edit + calc events     │
                       │                                  │
                       ▼                                  ▼  cursors
┌────────────────────────┐        ┌────────────────────────┐        ┌────────────────────────┐
│ Authorized range API   │        │ Authorized fanout      │        │ Presence / pub-sub     │
│ Snapshot / revision    │        │ Ordered replay feed    │◀──────▶│ Ephemeral Valkey       │
└────────────────────────┘        └────────────────────────┘        └────────────────────────┘
            ▲                                  ▲
            │                                  │
            ▼                                  ▼
┌──────────────────────────────────────────────────────────┐
│ Clients apply canonical state + pending overlay          │
│ Detect gaps; resume or request a new snapshot            │
└──────────────────────────────────────────────────────────┘
```

The gateway authenticates each request and checks workbook/sheet access. It routes commands to a workbook owner. The owner serializes accepted operations and commits the raw cell changes, next workbook revision, receipt, and outbox together in the workbook's PostgreSQL partition.

Range readers reconstruct a requested revision from immutable snapshot chunks and retained edits. The outbox relay schedules recalculation and publishes canonical events; formula workers read pinned inputs and publish complete result batches back through the same durable store. Gateways resume from the ordered history before live delivery. Valkey can accelerate fanout and carry presence, but losing it cannot erase accepted edits.

The return paths carry range/resume requests and confirmed worker outcomes. Relay progress follows the relevant durable handoff or completed effect, never mere delivery to a process's memory. A formula job publishes a complete batch with its input revision and engine version; a later raw edit does not make a late older result current. Browser recovery retains a bounded account/workbook-scoped journal under a storage policy, reauthorizes, and resolves original operation IDs before removing pending overlays or installing a replacement snapshot.

Partition by **workbook**, not sheet, because same-workbook formulas may cross sheets. A home-region owner simplifies ordering. Cross-region failover must fence the previous owner and preserve acknowledged database commits; an asynchronous replica alone does not establish zero data loss.

## Core Components / Request Flows

### Open and synchronize

1. Authenticate the user and resolve workbook membership, limits, current raw revision, and current complete calculation revision.
2. Issue a bounded snapshot token identifying checkpoint S and replay horizon R. Keep the snapshot and edits needed for this token until expiry.
3. Return metadata and the first visible range reconstructed at R. Range responses include their workbook, sheet, coordinates, and token.
4. Buffer events after R while range data is loaded. Apply later revisions to the loaded range and retain invalidation information for ranges not in memory.
5. A sequence gap triggers replay. An expired token or history gap requires a new snapshot; it must not silently turn unknown cells into blanks.

Snapshots are immutable checkpoints, not a collection of independent queries against changing current rows. Old checkpoints and log segments may be compacted only after active tokens and supported reconnect windows no longer need them. At first, store snapshot chunks in PostgreSQL; object storage is an optional later substitution for cold checkpoints.

### Commit an edit

1. Validate identity, access, coordinates, value length, paste size, and formula syntax. Reject unsupported functions before committing.
2. Route to the workbook owner. In a database transaction, lock/check the workbook's current owner epoch and revision.
3. Look up an actor-scoped operation ID and payload digest. Return an existing receipt for an identical retry; reject reuse with different content.
4. Apply raw changes and increment the workbook revision. Persist the operation, receipt, and outbox atomically. A paste is bounded and all-or-nothing.
5. Acknowledge after durable commit. Relay the committed event with revision and operation ID, including to the originating client.
6. The browser merges canonical state underneath its remaining pending edits. A receipt clears only the matching operation.

Normal same-cell replacements follow server commit order. The UI can indicate that another user replaced a recently edited value. Undo uses the expected current cell version and refuses to overwrite an intervening collaborator's edit without an explicit new action.

### Calculate formulas

Parse a defined spreadsheet grammar into an expression tree; never execute input as JavaScript. Maintain dependencies, including cross-sheet edges, and detect cycles. A worker evaluates a pinned workbook revision in dependency order with bounded memory, range traversal, and execution time.

Store a complete calculation batch tagged with input revision and engine version, then atomically publish its pointer and event. A slow batch must not move the published calculation revision backward. Calculations may lag raw edits; clients show the lag explicitly rather than mixing result versions and calling them current. Coalesce obsolete queued jobs, but retain a runnable bounded job so continuous edits do not starve all published results.

A range aggregate should use a range dependency representation or an appropriate aggregate index instead of expanding every reference into millions of graph edges. The initial limits can reject workloads whose dependency or compute budget is too large. Browser previews, if introduced, remain provisional and cannot infer an unloaded dependency is zero.

## Database Schema

### Local schema, reproduced from source

The following is the exact [init.sql](./backend/src/db/init.sql), including its existing comments. Several comments describe intended behavior rather than runtime: users are not checked on WebSocket connections; empty edits remain rows; there is no viewport query API or migration directory; nullable user references do **not** have `ON DELETE SET NULL`. PostgreSQL's actual foreign-key actions take precedence over those comments.

```sql
-- init.sql
-- Google Sheets collaborative spreadsheet - Complete database schema
-- Consolidated from all migrations for initial database setup
--
-- This file creates the complete schema in dependency order.
-- Use this for fresh database initialization.
-- For incremental updates, use the numbered migration files in ./migrations/

-- ============================================================================
-- USERS TABLE
-- ============================================================================
-- Stores user information with session-based authentication.
-- Simple auth model: users are identified by session_id, no password required.
--
-- Design decisions:
--   - UUID primary key for global uniqueness across distributed systems
--   - session_id is unique to identify returning users
--   - color field enables visual differentiation in collaboration UI
--   - last_seen supports cleanup of inactive users

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL DEFAULT 'Anonymous',
    color VARCHAR(7) NOT NULL DEFAULT '#4ECDC4',  -- Hex color for cursor/presence
    created_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW()
);

-- Index for fast session lookups (used on every WebSocket connection)
CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_id);


-- ============================================================================
-- SPREADSHEETS TABLE
-- ============================================================================
-- Top-level document container. Each spreadsheet contains multiple sheets.
--
-- Design decisions:
--   - Soft reference to users (owner_id) allows orphaned spreadsheets if user deleted
--   - updated_at tracks last modification for sorting and caching invalidation

CREATE TABLE IF NOT EXISTS spreadsheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL DEFAULT 'Untitled Spreadsheet',
    owner_id UUID REFERENCES users(id),  -- NULL if owner deleted
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);


-- ============================================================================
-- SHEETS TABLE
-- ============================================================================
-- Individual sheets within a spreadsheet (tabs at bottom of UI).
--
-- Design decisions:
--   - CASCADE delete ensures sheets are removed when parent spreadsheet deleted
--   - sheet_index allows reordering tabs
--   - frozen_rows/cols support Excel-like freeze panes feature

CREATE TABLE IF NOT EXISTS sheets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    spreadsheet_id UUID REFERENCES spreadsheets(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL DEFAULT 'Sheet1',
    sheet_index INTEGER NOT NULL DEFAULT 0,  -- Order of tabs
    frozen_rows INTEGER DEFAULT 0,           -- Number of frozen header rows
    frozen_cols INTEGER DEFAULT 0,           -- Number of frozen header columns
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for fast sheet lookup when loading a spreadsheet
CREATE INDEX IF NOT EXISTS idx_sheets_spreadsheet ON sheets(spreadsheet_id);


-- ============================================================================
-- CELLS TABLE
-- ============================================================================
-- Cell data storage using sparse representation.
-- Only non-empty cells are stored (empty cells do not exist in the table).
--
-- Design decisions:
--   - Sparse storage is efficient: a 1M cell sheet might only have 1000 rows
--   - raw_value stores user input (formulas start with '=')
--   - computed_value stores calculated result (for formulas) or NULL
--   - format stored as JSONB for flexible styling without schema changes
--   - UNIQUE constraint on (sheet_id, row_index, col_index) enables UPSERT
--   - updated_by tracks who made the last edit for audit/collaboration

CREATE TABLE IF NOT EXISTS cells (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,              -- 0-based row number
    col_index INTEGER NOT NULL,              -- 0-based column number
    raw_value TEXT,                          -- User input (e.g., "=SUM(A1:A10)")
    computed_value TEXT,                     -- Calculated result (e.g., "150")
    format JSONB DEFAULT '{}',               -- {bold, italic, color, bgColor, align, fontSize}
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by UUID REFERENCES users(id),    -- NULL if user deleted
    UNIQUE(sheet_id, row_index, col_index)   -- One cell per position
);

-- Primary lookup pattern: get cells for a sheet
CREATE INDEX IF NOT EXISTS idx_cells_sheet ON cells(sheet_id);

-- Secondary index for range queries (viewport loading)
CREATE INDEX IF NOT EXISTS idx_cells_position ON cells(sheet_id, row_index, col_index);


-- ============================================================================
-- COLUMN_WIDTHS TABLE
-- ============================================================================
-- Custom column widths (only stores non-default values).
-- Default width is 100px; only columns with different widths are stored.
--
-- Design decisions:
--   - Sparse storage pattern matches cells table
--   - Composite primary key (sheet_id, col_index) is natural unique identifier
--   - CASCADE delete cleans up when sheet is deleted

CREATE TABLE IF NOT EXISTS column_widths (
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    col_index INTEGER NOT NULL,
    width INTEGER NOT NULL DEFAULT 100,  -- Width in pixels
    PRIMARY KEY (sheet_id, col_index)
);


-- ============================================================================
-- ROW_HEIGHTS TABLE
-- ============================================================================
-- Custom row heights (only stores non-default values).
-- Default height is 32px; only rows with different heights are stored.
--
-- Design decisions:
--   - Mirror structure of column_widths for consistency
--   - Sparse storage for efficiency

CREATE TABLE IF NOT EXISTS row_heights (
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    row_index INTEGER NOT NULL,
    height INTEGER NOT NULL DEFAULT 32,  -- Height in pixels
    PRIMARY KEY (sheet_id, row_index)
);


-- ============================================================================
-- COLLABORATORS TABLE
-- ============================================================================
-- Tracks active users in a spreadsheet for real-time collaboration.
-- This is ephemeral data; rows are cleaned up when users disconnect.
--
-- Design decisions:
--   - Composite primary key (spreadsheet_id, user_id) ensures one entry per user per document
--   - Cursor position supports showing other users' cursors
--   - Selection range supports showing other users' selected areas
--   - last_seen enables cleanup of stale connections (via background job)
--   - CASCADE delete ensures cleanup when spreadsheet or user is deleted

CREATE TABLE IF NOT EXISTS collaborators (
    spreadsheet_id UUID REFERENCES spreadsheets(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    cursor_row INTEGER,              -- Current cursor row (NULL if not active)
    cursor_col INTEGER,              -- Current cursor column
    selection_start_row INTEGER,     -- Selection range start
    selection_start_col INTEGER,
    selection_end_row INTEGER,       -- Selection range end
    selection_end_col INTEGER,
    joined_at TIMESTAMP DEFAULT NOW(),
    last_seen TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (spreadsheet_id, user_id)
);

-- Index for getting all collaborators in a spreadsheet (presence list)
CREATE INDEX IF NOT EXISTS idx_collaborators_spreadsheet ON collaborators(spreadsheet_id);


-- ============================================================================
-- EDIT_HISTORY TABLE
-- ============================================================================
-- Operation log for undo/redo functionality and audit trail.
-- Each entry represents one atomic operation that can be undone.
--
-- Design decisions:
--   - operation_type categorizes edits (SET_CELL, DELETE_CELL, RESIZE, PASTE, etc.)
--   - operation_data stores forward operation details as JSONB
--   - inverse_data stores reverse operation for undo
--   - Keeping both forward and inverse enables redo after undo
--   - Index on (sheet_id, created_at DESC) optimizes undo stack retrieval
--   - Soft reference to users allows history to persist if user deleted

CREATE TABLE IF NOT EXISTS edit_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sheet_id UUID REFERENCES sheets(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),       -- NULL if user deleted
    operation_type VARCHAR(50) NOT NULL,     -- SET_CELL, DELETE_CELL, RESIZE, etc.
    operation_data JSONB NOT NULL,           -- Forward operation details
    inverse_data JSONB NOT NULL,             -- Reverse operation for undo
    created_at TIMESTAMP DEFAULT NOW()
);

-- Index for retrieving undo stack (most recent first)
CREATE INDEX IF NOT EXISTS idx_edit_history_sheet ON edit_history(sheet_id, created_at DESC);


-- ============================================================================
-- ENTITY RELATIONSHIPS SUMMARY
-- ============================================================================
--
-- users (1) ----< (many) spreadsheets      [owner relationship]
-- users (1) ----< (many) cells             [last editor]
-- users (1) ----< (many) collaborators     [active session]
-- users (1) ----< (many) edit_history      [operation author]
--
-- spreadsheets (1) ----< (many) sheets     [parent container, CASCADE]
-- spreadsheets (1) ----< (many) collaborators [active document, CASCADE]
--
-- sheets (1) ----< (many) cells            [cell container, CASCADE]
-- sheets (1) ----< (many) column_widths    [dimension customization, CASCADE]
-- sheets (1) ----< (many) row_heights      [dimension customization, CASCADE]
-- sheets (1) ----< (many) edit_history     [operation log, CASCADE]
--
-- ============================================================================
-- CASCADE DELETE BEHAVIOR
-- ============================================================================
--
-- When a spreadsheet is deleted:
--   - All sheets are deleted (CASCADE)
--   - All collaborator entries are deleted (CASCADE)
--
-- When a sheet is deleted:
--   - All cells are deleted (CASCADE)
--   - All column_widths are deleted (CASCADE)
--   - All row_heights are deleted (CASCADE)
--   - All edit_history entries are deleted (CASCADE)
--
-- When a user is deleted:
--   - Spreadsheets remain (owner_id becomes NULL via REFERENCES)
--   - Cells remain (updated_by becomes NULL via REFERENCES)
--   - Collaborator entries are deleted (CASCADE)
--   - Edit history remains (user_id becomes NULL via REFERENCES)
--
-- ============================================================================
```

There are eight tables and six explicit secondary indexes, in addition to primary/unique indexes. The `cells` uniqueness constraint supports one row per sheet/position, but there are no bounds checks, cell versions, or operation IDs. `sheet_index` is not unique within a workbook. WebSocket handlers do not maintain SQL `users`, `collaborators`, or `edit_history`, and cell writes do not update `updated_by` or the workbook's `updated_at`.

### Proposed production additions

| Record | Key / important fields | Purpose |
|--------|------------------------|---------|
| Workbook authority | Workbook ID, home region, owner epoch, raw revision, published calculation revision | Fence stale owners and allocate order |
| Membership | Workbook ID + actor, role, permission version | Enforce reads, edits, replay, export, and revocation |
| Versioned cell | Workbook/sheet/row/column, raw input, format, last edit revision | Current raw state and conditional undo |
| Operation and receipt | Workbook + actor + operation ID, digest, revision, canonical outcome | Durable deduplication and bounded replay |
| Outbox | Workbook + revision/event ID, payload, delivery state | Retry publication after commit |
| Snapshot chunk | Workbook + checkpoint + range, immutable values, token retention | Reconstruct coherent range reads |
| Calculation batch | Workbook + input revision + engine version, complete result chunks | Publish coherent derived values |

These additions are not in `init.sql`. History retention and receipt retention are separate decisions: a compacted replay log must not accidentally erase the supported retry guarantee. Expired operation IDs require an explicit recovery policy, not blind reapplication as new edits.

## API Design

### Implemented REST routes

All routes below are currently unauthenticated, under `/api`. They do not form a revisioned collaboration protocol.

| Method | Path | Actual behavior |
|--------|------|-----------------|
| GET | `/spreadsheets` | Up to 100 workbooks, sorted by workbook `updated_at` |
| POST | `/spreadsheets` | Create workbook, then first sheet in separate statements |
| GET | `/spreadsheets/:id` | Cached metadata or database lookup with sheet list |
| PATCH | `/spreadsheets/:id` | Rename; no affected-row check or live notification |
| DELETE | `/spreadsheets/:id` | Cascading SQL delete; invalidate metadata only |
| POST | `/spreadsheets/:id/sheets` | Choose max sheet index + 1 and insert; no concurrency protection |
| GET | `/sheets/:sheetId/cells` | Entire cached or stored sheet; no viewport bounds |
| PATCH | `/sheets/:sheetId/cells` | Transactional array of upserts; computed value equals raw input |
| GET | `/spreadsheets/:id/export` | CSV from optional `sheetId` or first sheet; format selector has no effect |

The optional export sheet ID is not checked against the path workbook. CSV is constructed as an in-memory rectangle through the largest stored coordinates, without coordinate or output-size limits. It does not neutralize formula-leading content. REST cell changes skip formula evaluation, history, and WebSocket publication.

### Implemented WebSocket messages

| Direction | Message | Current contract |
|-----------|---------|------------------|
| Server → client | `STATE_SYNC` | Metadata, all first-sheet cells, dimensions, local-room identities |
| Client → server | `CELL_EDIT` | Sheet, row, column, value, optional request ID |
| Server → client | `CELL_UPDATED` | Canonical raw/computed values; no revision or request ID |
| Server → client | `CELL_EDIT_ACK` / `ERROR` | Completion/error response; browser ignores both |
| Client → server | `CURSOR_MOVE` / `SELECTION_CHANGE` | Coordinates/range; no sheet context |
| Server → client | `CURSOR_MOVED` / `SELECTION_CHANGED` | Room-wide cursor/selection broadcasts |
| Both | `RESIZE_COLUMN` / `RESIZE_ROW` | Persist dimensions and broadcast locally |
| Both | `RENAME_SHEET` / `SHEET_RENAMED` | Persist/broadcast; browser ignores rename event |

The proposed protocol adds authenticated workbook/sheet scope, operation IDs and digests, raw/cell/calculation revisions, snapshot tokens, replay cursors, expiry, and explicit rejection reasons. Every write entry point must share the same command path; a REST bulk update cannot bypass ordering.

## Key Design Decisions

### Workbook ordering versus independent cell merges

A workbook owner gives raw changes and cross-sheet dependencies a coherent order. Independent last-writer-wins registers are attractive for simple values, but they do not alone specify calculation snapshots, atomic paste, or structural changes. We accept a throughput ceiling per workbook and home-region write latency. When a workbook becomes hot, first bound edits and move it to a dedicated partition; splitting it requires revisiting cross-sheet semantics.

A lease is a routing aid, not sufficient fencing. The current epoch must be checked within the same database transaction that changes cells. Locking the authority row prevents ownership transfer from racing a valid commit; all writers must obey this protocol. PostgreSQL describes the relevant lock lifetime in its [explicit locking documentation](https://www.postgresql.org/docs/16/explicit-locking.html).

### Asynchronous calculation versus blocking edits

Keeping expensive calculation outside the commit transaction prevents a large dependency chain from freezing ordinary text edits. The price is two freshness dimensions: raw revision and complete calculation revision. We expose calculating/stale results, cap work, and publish complete batches. Synchronous evaluation is simpler for tiny workbooks, but coupling unbounded formula work to locks turns one costly edit into a room-wide queue.

### DOM virtualization versus a canvas grid

A bounded DOM viewport makes native input, selection semantics, and assistive-technology support more approachable. Canvas can reduce cell-node overhead for very dense views, but requires a separate accessible representation, hit testing, and text editing. Start with DOM virtualization and measure visible-cell rendering before paying those costs. Virtualization limits rendered nodes; it does not automatically limit data, dependency, or pending-operation memory.

## Consistency and Idempotency

Production durability is defined by the database transaction, not WebSocket delivery or Redis publication. Retries return the stored receipt for the same actor, operation ID, and payload. A delayed duplicate must not overwrite a newer edit. Outbox events can be delivered more than once; clients deduplicate by identity/revision and request missing history.

The local implementation has an optional Redis get-then-set receipt cache after the write. It has no atomic claim or transaction with PostgreSQL, no actor or payload binding, and fails open. The browser sends no request IDs. Current UPSERT behavior does not guarantee retry safety when another edit intervenes.

## Security / Auth

The production boundary authenticates sessions, verifies WebSocket origin, checks workbook and sheet membership on all operations, and handles revocation on established sockets and replay reads. Validate bounds, payload size, formula grammar, and export size. Rate-limit expensive edits separately from lightweight presence.

The local `spreadsheetId`, display name, and generated session ID are not authorization. Arbitrary sheet IDs can be submitted in a joined room. The formula fallback uses the JavaScript `Function` constructor in the server process, without a sandbox or evaluation deadline. This is an actual execution boundary defect, not merely incomplete spreadsheet compatibility. Keep the demo limited to trusted local inputs until that code is replaced.

## Observability

Production measures input-to-paint, commit latency, pending age, replay gaps, owner queue depth, outbox age, calculation lag, rejected formula budgets, and permission denials. Use bounded labels; workbook and operation identities belong in sampled logs/traces rather than metric label dimensions.

Locally, [metrics.ts](./backend/src/shared/metrics.ts) defines counters, gauges, and histograms; [index.ts](./backend/src/index.ts) exposes `/metrics`, `/health`, and `/ready`. The health check probes PostgreSQL and Redis; readiness probes both but does not update the same dependency gauges. There is no separate process-only liveness route or overall probe deadline. The pool's “active” gauge receives `pool.totalCount`, including idle connections. Cell latency ends before publication, receipt caching, and ACK. Duplicate socket cleanup can decrement the connection gauge more than once.

## Failure Handling

| Failure | Proposed response | Local behavior |
|---------|-------------------|----------------|
| Lost ACK after commit | Retry identical operation ID; return durable receipt | No browser retry; optional Redis receipt is outside SQL transaction |
| Missed live update | Replay from last revision or obtain new snapshot | No revisions, gap detection, or reconnect |
| Owner crash | Reassign with higher fenced epoch | No owner abstraction; concurrent async handlers overlap |
| Calculation overload | Bound work, coalesce jobs, show calculation lag | Synchronous evaluation on API event loop |
| Redis outage | Drop presence; recover edits from durable log | Errors often caught, but awaited Redis retries can delay work |
| Permission revoked | Reject commands and remove live access | No authentication or access checks |
| Snapshot expires | Explicit resync, preserve pending user intent | Initial state can overwrite concurrent live events |

The local SIGTERM path requests HTTP/socket closure, then closes the SQL pool and ordinary Redis client and exits. It does not await all accepted writes or socket draining, close the subscriber client, impose a drain deadline, or handle SIGINT equivalently. It is not a proven graceful-drain guarantee.

## Scalability Considerations

Scale independent workbooks across database partitions and owners; scale socket gateways by connections and delivery bytes. A gateway can lose ephemeral state and resume clients from durable history. Protect the owner from presence traffic and bulk operations that exceed its budget.

Formula fanout, a hot workbook, and reconnect bursts can dominate long before aggregate storage is exhausted. Cache immutable range chunks by workbook, snapshot, and coordinates behind authorization. Bound per-client memory and evict only reconstructible canonical ranges; pending edits and dependency state need separate policies. Compact snapshots/logs with explicit token and replay retention guarantees.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Edit authority | Workbook order + atomic SQL receipt | Independent mutable registers | Coherent paste, replay, and same-workbook formula inputs |
| Ownership | Database-fenced epoch | Redis lease alone | A stale owner cannot commit after handoff |
| Calculation | Bounded asynchronous revision batches | Unbounded evaluation inside edit transaction | Keep writes responsive with visible result lag |
| Rendering | Virtualized DOM + stable editor | Canvas from the start | Native editing and accessible structure within a viewport budget |
| Recovery | Immutable checkpoint + retained operations | Full state mixed with unversioned live events | A defined boundary between snapshot and updates |

## Implementation Notes

### Actual local topology

```
┌────────────────────────┐ WS     ┌────────────────────────┐      ┌────────────────────────┐
│ React + Zustand        │        │ Express + ws           │      │ PostgreSQL             │
│ 1,000 rows × 26 cols   │◀──────▶│ One process / rooms    │◀────▶│ Cells / metadata       │
└────────────────────────┘        └────────────────────────┘      └────────────────────────┘
                       │                       ▲                               ▲
                       │                       │                               │
                       │                       │                               │
optimistic Map         │          cache / publish                              │
                       │                       │                               │
                       │                       ▼                               │
                       │          ┌────────────────────────┐                   │
                       │          │ Valkey                 │                   │
                       │          │ Caches / receipts      │                   │
                       │          └────────────────────────┘                   │
                       │                                                       │
                       │                                                       │
                       │          No subscriber wiring:                        │
                       │          other API processes             SQL          │
                       │          do not receive edits.                        │
                       ▼                                                       ▼
┌────────────────────────┐                                        ┌────────────────────────┐
│ Grid + inline input    │                                        │ REST API routes        │
│ No durable retry       │                                        │ No auth / no WS push   │
└────────────────────────┘                                        └────────────────────────┘



Browser uses WebSocket; REST is available for manual calls.

Formula evaluation runs inside the API process before each WS cell write.
```

The REST route box is part of the same Express process, shown separately to emphasize its different write behavior. The browser uses WebSocket; manual REST calls are another entry point. PostgreSQL stores cells and metadata. Valkey caches data and receives publication, but nothing subscribes that publication into other processes' rooms.

### Patterns actually wired

| Pattern | Source | Why it matters and its current boundary |
|---------|--------|-----------------------------------------|
| Two-axis virtualization | [SpreadsheetGrid.tsx](./frontend/src/components/SpreadsheetGrid.tsx) | Bounds DOM work to visible rows × columns plus overscan; does not bound full-sheet loading |
| SQL cell uniqueness | [cell-operations.ts](./backend/src/websocket/cell-operations.ts) | One cell per position; no revisioned ordering or duplicate-effect guarantee |
| Metadata/cell caching | [cache.ts](./backend/src/shared/cache.ts) | Avoids repeated reads; mutable, unversioned hash fills can race edits |
| Publication breaker | [circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts) | Limits repeated publish failures; does not wrap every Redis or database operation |
| Optional receipt cache | [idempotency.ts](./backend/src/shared/idempotency.ts) | Replays some completed requests for 24 hours; browser does not opt in |
| Structured logs | [logger.ts](./backend/src/shared/logger.ts) | Pino and request logging aid diagnosis; logs do not prove durable delivery |
| Ping/pong | [websocket/index.ts](./backend/src/websocket/index.ts) | Detects stale connections every 30 seconds; teardown is not idempotent |

The implemented persistence pattern is a cell UPSERT followed by separate side effects:

```text
formula evaluation → SQL upsert → cache update → local broadcast
→ optional Redis publication → optional receipt cache → ACK
```

This is a flow illustration, not an atomic transaction. Two handlers can commit A then B but broadcast B then A when A pauses on its cache update. A single process therefore does not itself establish a consistent edit order.

### State and transport limitations

[spreadsheet.ts](./frontend/src/stores/spreadsheet.ts) holds a single cell Map keyed only by row/column. It clones the whole Map on updates, replaces cell objects without retaining format, ignores the incoming sheet ID, and does not process ACK/error/rename messages. Pending edits have no durable journal. The hardcoded localhost socket has no reconnect or generation guard; an old socket can update the current store after a connection change.

[App.tsx](./frontend/src/App.tsx) treats socket-open as ready before state synchronization. [state-sync.ts](./backend/src/websocket/state-sync.ts) joins the room before reading initial state, performs independent SQL reads, and registers message/close/error handlers after synchronization. It has no snapshot/live-event barrier. Concurrent first opens can race the separate workbook and first-sheet inserts, and early disconnects or messages can be mishandled.

[Cell.tsx](./frontend/src/components/Cell.tsx) owns an inline editor that can unmount with its virtual cell. Its memo comparator ignores style changes. There is no IME-specific handling or accessible grid/focus model. [Toolbar.tsx](./frontend/src/components/Toolbar.tsx) displays a read-only title and formula bar; its stable `getCell` subscription does not itself subscribe to active-cell value changes. Keyboard movement has no upper grid bound or automatic scroll-to-cell.

[collaboration.ts](./backend/src/websocket/collaboration.ts) broadcasts cursor/selection coordinates without sheet context. The UI's drag-extension action does not call the action that sends selection messages. [sheet-operations.ts](./backend/src/websocket/sheet-operations.ts) exposes resize/rename handlers, but there are no browser resize controls or sheet tabs. SQL dimensions and frozen-row fields do not establish working freeze-pane support.

### Cache, calculation, and storage limitations

Metadata TTL is 30 minutes, cell hashes 15 minutes, and cached collaborator hashes 5 minutes. Presence reads use local rooms, not the collaborator cache; cursor moves do not refresh that cache. [redis.ts](./backend/src/shared/redis.ts) creates a subscriber and helper, but there is no subscriber call in the live path.

Cell hash fills use a nontransactional pipeline of delete, set, and expire. A stale full-sheet read can overwrite a newer edit. A separate exists check followed by a cell HSET can recreate an expired key as a partial hash without TTL. Any nonempty hash is treated as a complete sheet. Deleting a workbook only invalidates metadata, so cached cell data can outlive its SQL rows.

[formula-handler.ts](./backend/src/websocket/formula-handler.ts) parses comma-separated literal arguments with `parseFloat`; references are not resolved. `=SUM(A1:A10)` yields `0`, `=SUM(1+2,3)` yields `4`, and arithmetic division by zero yields `Infinity`. Other expressions fall through to unrestricted JavaScript. There is no dependency graph, downstream recalculation, dedicated worker, or formula-result version. [seed.ts](./backend/src/db/seed.ts) inserts precomputed reference results, which remain stored until overwritten.

[routes.ts](./backend/src/api/routes.ts) has a different cell-write path: a bounded-by-client-only array transaction that stores input directly as the computed value. Creation, sheet-index allocation, and title/deletion behavior have the limitations described in the API table. The schema includes history and collaborator tables without runtime history or SQL presence writes.

### Simplifications and omissions

Implemented substitutions are one PostgreSQL instance for durable rows, Valkey for Redis-compatible caching, local room Sets for presence/fanout, and CSS/DOM cells for the grid. Missing production mechanisms include real authorization, a safe spreadsheet parser, dependency evaluation, revisioned snapshots, replay, fencing, atomic receipts/outbox, conditional undo, real offline recovery, multi-region durability, CDN delivery, worker isolation, and distributed tracing.

See the [README](./README.md) for the migration/runtime credential mismatch and setup commands. This documentation review checked all five documents against source and ran 12 isolated checks with mocked network/database dependencies. They reproduced formula/reference limitations, general JavaScript fallback, concurrent duplicate execution, cache TTL gaps, SQL/broadcast reordering, missing sheet authorization, early readiness, omitted request IDs and lost formatting, ignored ACK/errors, ignored incoming sheet identity, old-socket cleanup races, and repeated connection-gauge decrement. These checks do not constitute an application build, browser collaboration run, database migration, or production load test.
