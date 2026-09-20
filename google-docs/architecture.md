# Google Docs: architecture and implementation

## System Overview

This project studies shared rich-text documents: responsive local editing, ordered
collaboration, recoverable saves, comments, history, and document-level permissions.
The **proposed production design** below defines a complete service. The final
[Implementation Notes](#implementation-notes) describe the current local demo, whose
editor does not yet send or apply document operations. These are different layers;
the proposal is not a claim about Google's infrastructure or this repository's runtime.

The central learning question is where an edit becomes authoritative. A character
appearing locally, a WebSocket sending successfully, a durable operation commit,
and another user's screen updating are separate events.

## Requirements

### Functional requirements — proposed

Support authenticated document creation, basic rich text (paragraphs, headings,
lists, and marks), concurrent editing, temporary presence, comments with anchored
ranges, named history, and restore. Owners grant view, comment, or edit capability.

Start with bounded documents and small editing groups. Include recovery from short
network interruptions; unlimited offline merging, spreadsheets, arbitrary embeds,
printing/export, and tracked-change suggestions are extensions. A CRDT-based product
could be a better fit if long independent offline sessions become a core requirement.

### Non-functional requirements — proposed

| Concern | Initial target or contract |
|---------|----------------------------|
| Local interaction | p95 input-to-paint below 50 ms on a specified modest device |
| Collaboration | p95 committed edit-to-peer visibility below 200 ms within the home region |
| Opening | p95 usable editor below 1 second for a bounded 100 KB document on a defined network |
| Availability | 99.99% target for document access; edits pause when durable commit is unavailable |
| Durability | Acknowledged edits survive an owner-process crash; replica-loss guarantees depend on the configured synchronous durability boundary |
| Consistency | One ordered committed revision stream per document; temporary local state can lead it |
| Access | Current document capability governs reads, commands, replay, snapshots, and presence |

These are planning targets, not measurements. Presence may be dropped or coalesced;
accepted content may not. A disconnected client must retain its work without calling
that work saved to the service.

## Capacity Estimation

Assume 5 million daily active users, each editing for 20 minutes. That is 6 billion
editor-seconds/day, about 69,445 concurrent editors on average. A fivefold peak is
roughly 350,000 connected editors. These figures are illustrative, not usage data from Google.

At 0.5 submitted batches per active editor per second, the average is about 34,722
batches/second and the peak about 175,000. A batch contains ordered editor steps;
operation rate and WebSocket frame rate are therefore not interchangeable.

If each batch averages 500 bytes, three billion daily batches add about 1.5 TB/day
before replication, indexes, receipts, and snapshot storage. At five other viewers
per editing room, content delivery has roughly five times the accepted-batch fan-out,
plus acknowledgments, presence, and reconnect replay.

The hottest document's step-processing time and queue are separate constraints from
total fleet capacity. Benchmark realistic large pastes and formatting changes, not
only single-character inserts. Local setup sizes should come from measurements;
no local concurrency or memory benchmark is claimed here.

## High-Level Architecture

The following is the production proposal. Boxes identify ownership, and arrows show
request, commit, replay, or temporary presence traffic.

```
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Browser clients        │       │ Authenticated gateways │       │ Presence routing       │
│ Batches / reads/cursor │◀─────▶│ Session + doc routing  │◀─────▶│ Connection + revision  │
└────────────────────────┘       │ Ordered replay channel │       │ Coalesce / expire      │
             ▲                   └────────────────────────┘       └────────────────────────┘
             │                                ▲
             │ review / result                │ commands / outcomes
             │                                │
             ▼                                ▼
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ Authorized review API  │       │ Fenced document owner  │       │ Document partition/SQL │
│ Lists/comments/history │◀─────▶│ Validate / admit steps │◀─────▶│ Head / grants / epoch  │
│ Current access checks  │       │ Restore/grant commands │       │ Steps/receipts/outbox  │
└────────────────────────┘       └────────────────────────┘       │                        │
             ▲                                ▲                   │                        │
             │ read / version                 │ replay / publish  │                        │
             │                                │                   │                        │
             ▼                                ▼                   │                        │
┌────────────────────────┐       ┌────────────────────────┐       │ Contiguous step reads  │
│ Verified snapshots     │       │ Replay/snapshot work   │       │ Claim committed work   │
│ Pinned revision/schema │◀─────▶│ Read committed history │◀─────▶│ Commit + work progress │
│ Immutable content hash │       │ Build/verify snapshot  │       │                        │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘

The owner streams accepted history to gateways. Missing live delivery is repaired by replay.
Saved ACK follows the SQL commit; snapshots and expiring presence have different lifetimes.
```

A browser reaches a gateway, which routes a document's commands to its current owner.
The owner serializes admission and commits through the document's database partition.
The database enforces ownership fencing and stores accepted steps and receipts.
Committed events feed live delivery and snapshot work; missed live delivery is repaired
from retained history. Presence follows an independent, disposable path.

A bounded account/document/schema-scoped browser journal can retain pending steps and immutable submitted attempts for reload recovery under a defined storage policy. Recovery first reauthorizes and resolves the original attempt. Only a definitive no-effect result permits rebasing that work into a new attempt; a timeout does not. Snapshot workers publish a verified complete prefix before recording progress, and retained history supplies the suffix. The arrows distinguish these durable outcomes from disposable presence.

Static application assets can use a CDN. Private document content and snapshots stay
behind current authorization. A CDN, Redis pub/sub, or a load-balancer hash is not the
source of truth for accepted document revisions.

## Core Components / Request Flows

### Editor and collaboration model

Use a schema-aware editor such as ProseMirror rather than treating rich text as a
flat string. Paragraph boundaries, marks, list changes, selections, and undo depend
on its document model. Client and server agree on a schema and step format.

For the proposal, choose centralized step rebasing: the authority accepts a batch
only at its current base version, while a stale client receives the intervening steps
and rebases its unconfirmed work. This follows the model described in the
[ProseMirror collaboration guide](https://raw.githubusercontent.com/ProseMirror/website/master/markdown/guide/collab.md).
It replaces the demo's custom server-side position transforms; it is not a claim that
TipTap's Yjs collaboration extension implements the same protocol.

The browser keeps the editor's displayed state, confirmed version, unconfirmed steps,
and immutable in-flight request identity distinct. React owns the surrounding shell,
side panels, and small status projections. It does not replace the full editor JSON
on every network response or presence update.

### Open and catch up

1. Authorize the account/document pair and obtain the active owner and protocol schema.
2. Load a verified snapshot at revision S and a contiguous committed suffix through H.
3. Reconstruct exactly H; subscribe/replay from H so changes during load are not lost.
4. Apply later committed batches in order, identifying the client's own accepted steps.
5. Send version-relative presence only after the editor has a valid shared context.

The snapshot's revision describes its actual content. An unrelated current head must
not be attached to an older JSON body. Reconnect uses the same durable replay path;
live notifications are only a latency optimization.

### Admit, acknowledge, and publish an edit

Each wire attempt has account/document/client scope, a unique batch ID, base version,
schema version, and a digest of its immutable steps. Keep at most one unresolved
submitted batch per client/document while buffering newer local transactions.

The owner validates limits and schema, then serializes the request against the current
head. A database transaction checks its fencing epoch, current access, and batch
receipt. An already committed identical attempt returns its original version range.
A changed payload under that ID is a conflict.

If the base is stale, record a terminal no-effect outcome for this attempt and return
a bounded suffix or a resync requirement. After that outcome is known, the client can
rebase and create a new attempt. It must not change the payload of an uncertain attempt.

For a current-base batch, apply every step to a candidate document; if any step is
invalid, reject the entire batch. Atomically append the steps, advance the head by the
number of steps, and store the acceptance receipt and outbox event. Only after commit
does the owner publish this state or acknowledge durability.

The owner's memory is a working copy of committed state. If a database outcome is
unknown, resolve the receipt before admitting another conflicting write. During failover,
a newly acquired epoch prevents an old owner from committing later.

### Comments, history, and restore

Comment text and discussion state have their own identities, while anchors identify
an exact document revision and range with defined boundary affinity. Map anchors
through accepted steps. If their text disappears, preserve the discussion as detached
rather than attaching it to an unrelated sentence.

Route comment anchoring, permission changes, and restore through the same document
admission boundary where they depend on content or access. Simple list/read services
can scale independently without becoming a second content writer.

A history worker reconstructs a committed target revision, verifies its content hash,
and publishes a snapshot manifest only after storage is durable. Compaction preserves
all history needed by published manifests, active recovery windows, and retained
operation receipts. Named historical revisions have an explicit retention policy.

Restore is a new identified command, not a decrement of the head. It pins the selected
snapshot and expected current head, preserves the current revision, and appends an
explicit replacement/reset event. Clients with pending work keep a recovery copy when
that structural replacement cannot be safely rebased. Preview uses a separate editor.

## Database Schema

### Production ownership model — proposed additions

Begin with PostgreSQL and colocate all correctness-critical rows for a document.
The actual eight-table teaching schema is reproduced in Implementation Notes; it
lacks the durable admission model described here.

| Record | Key and important fields | Required invariant |
|--------|--------------------------|--------------------|
| Document head | Document ID, owner epoch, step version, schema version, access revision, deleted state | One conditional advancement of the authoritative head |
| Accepted steps | Document ID + step version; batch ID, actor, step payload | Unique, contiguous committed history; no partial batch |
| Attempt receipt | Document + actor + client + batch ID; digest, outcome, accepted range | Duplicate admission cannot repeat effects; rejected attempts stay rejected |
| Access grant | Document + principal; capability, access revision | Revocation participates in current admission checks |
| Outbox event | Durable event ID, document, committed range, publication state | Recoverable delivery after commit |
| Snapshot manifest | Document + revision; schema, content hash, immutable object reference | Advertised revision matches verified content |
| Comment / anchor | Document + comment; parent, author, body, resolved version, mapped range or detached state | Reply belongs to same document; anchor position has a version |

Version fields cross JSON boundaries as validated decimal strings or checked safe
integers. Do not let an unchecked database BIGINT silently become string concatenation.
Index document lists by authorized user and activity with stable pagination; index
steps by document/version and pending outbox work by claimable state. Enforce account
and document bounds in queries, not only in frontend routing.

## API Design

### Proposed contracts

Use REST for document discovery and review panels, WebSocket for editing and presence.
Both transports call the same authoritative command service when a command changes
content, permissions, or content-dependent anchors.

| Method/channel | Proposed operation | Contract |
|----------------|--------------------|----------|
| GET | `/api/documents` | Authorized bounded list with stable cursor |
| GET | `/api/documents/:id/bootstrap` | Schema, snapshot revision, committed suffix, current capability |
| WS | Submit batch | Immutable batch ID/digest/base and bounded editor steps |
| WS or GET | Changes after revision | Contiguous committed range, own batch identities, resync if history expired |
| GET | `/api/documents/:id/attempts/:batchId` | Resolve an uncertain attempt under current authorization |
| POST/PATCH | Comments and desired resolution state | Current capability, expected version, identified command |
| GET | Versions / pinned version content | Authorized history; explicit reconstruction failure |
| POST | Restore pinned revision | Expected head + operation ID; new committed reset event |
| POST/DELETE | Grants | Owner authorization and access revision update |
| WS | Presence update | Connection identity, referenced revision, cursor/selection, short expiry |

A sample contract might accept batch `b7` at base 20 containing two steps and return
accepted range 21–22. A repeat of that immutable attempt returns the same result.
Receiving version 24 while confirmed at 22 triggers recovery of step 23; it does not
justify advancing the confirmed version past a gap.

## Key Design Decisions

### Centralized rebasing and document ownership

A single ordering authority fits an online document with bounded editing groups and
makes the accepted history inspectable. Client-side step mapping handles concurrent
changes using the editor's model. A hand-written insert/delete table cannot cover
rich-text structure, composition, undo, and every overlapping range case.

A CRDT is a legitimate alternative for independent offline work. It still needs
server authorization, durable storage, abuse controls, and product conflict semantics.
Its storage and garbage-collection costs depend on the implementation and workload;
there is no justified universal “3–5× memory” claim. The centralized choice gives up
unrestricted offline acceptance and requires explicit failover fencing.

### Durable admission with asynchronous snapshots

Persist small accepted batches before a saved acknowledgment; build full snapshots
later. Short group commits can amortize storage work while each contained edit still
waits for the commit. Debouncing the snapshot is different from discarding intermediate
operations. The cost is database latency in acknowledgment, while local input remains
responsive through unconfirmed state.

### Ephemeral delivery with durable recovery

Live fan-out and presence benefit from a fast routing layer. Content delivery must
have a recoverable source. [Redis pub/sub](https://redis.io/docs/latest/develop/pubsub/)
does not retain a disconnected subscriber's messages. Use sequence checking, replay,
and periodic head reconciliation; do not rely on a later message to reveal every gap.

If a durable broker is added, distinguish worker distribution from broadcasting to
all interested gateways. One shared consumer group does not deliver each event to
every gateway with subscribers. Partition queues, routing, and per-gateway cursors
need an explicit design.

## Consistency and Idempotency

The atomic unit is one document's accepted batch, receipt, and outbox record. Database
constraints and fencing enforce it across duplicate requests and owner replacement.
A session cache or an expiring lock alone is insufficient.

Receipt retention and reconnect support are declared product limits. Once an old
attempt cannot be resolved, preserve local work and offer recovery; do not assume
it failed and resend transformed content under a fresh identity. Snapshot compaction
must not silently remove the only evidence of whether an uncertain write committed.

## Security / Auth

Authorize read, comment, edit, share, and delete separately. Check the active session
and current document capability at admission, including long-lived sockets. A grant
revocation must invalidate ongoing subscriptions and stop subsequent reads/commands;
an already delivered copy cannot be recalled.

Validate WebSocket origin, message bytes, batch size, schema version, nesting, positions,
and permitted marks/URLs. TypeScript types do not validate network data. Keep private
content and tokens out of logs and shared caches. Scope local recovery storage to the
account/document, explain its retention, and clear it according to sign-out policy.

## Observability

Measure local input-to-paint, owner admission queue, durable commit latency, oldest
unresolved attempt, peer visibility, replay gaps, snapshot lag, and disconnect reasons.
These distinguish a fast in-memory ACK from a recoverable saved edit. Track aggregate
room-size and document-size distributions without unbounded document-ID metric labels.

Use structured request/batch IDs for debugging and preserve a body-free audit trail
for restore and grant changes. Dependency health, protocol readiness, and end-to-end
collaboration checks answer different questions.

## Failure Handling

| Failure | Proposed response |
|---------|-------------------|
| Database cannot commit | Keep local changes pending; stop saved ACKs and authoritative publication |
| Owner crashes after commit | Resolve receipt and recover committed state under a new fenced epoch |
| Live bus loses messages | Detect sequence/head mismatch; replay retained committed steps |
| Slow browser | Bound its queue, coalesce presence, disconnect with resumable cursor if needed |
| Schema mismatch or expired rebase history | Preserve work; require compatible reload or explicit recovery copy |
| Snapshot worker fails | Retain the log; retry from the same revision; never publish incomplete content |
| Restore races with editing | Reject stale expected head; user reviews current state before a new attempt |

## Scalability Considerations

Scale many documents by partitioning their owners and data. Scale connections and
readers separately from the single-document write authority. A hot document may need
editor admission limits, batched steps, bounded presence, and more delivery capacity;
more stateless gateways do not increase its serialized mutation throughput.

Section partitioning is a product/model change: moving a paragraph across sections,
whole-document undo, and range comments cross the new boundaries. Introduce it only
when measurements justify that complexity. Prefer one home region for document writes
initially; explain failover and replica durability before promising multi-region saves.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Collaboration | Centralized schema-aware step rebasing | CRDT | Fits bounded online editing and explicit ordered history |
| Durability | Commit batch before saved ACK | Memory ACK plus debounce | Preserves acknowledged work after owner failure |
| Recovery | Verified snapshots + contiguous steps | Snapshot-only overwrite | Retains accepted changes and identifies gaps |
| Presence | Expiring connection state | Durable per-cursor history | Current intent matters more than every mouse movement |
| Restore | New guarded history event | Direct snapshot overwrite | One mutation authority and recoverable user intent |
| Rendering | Editor owns content; React owns shell | Global JSON replacement | Preserves composition, selection, and undo context |

## Implementation Notes

### What actually runs

```
┌────────────────────────┐       ┌────────────────────────┐       ┌────────────────────────┐
│ React / TipTap browser │       │ Express + ws :3001     │       │ Valkey :6379           │
│ Stored body/local edit │◀─────▶│ REST title/review      │◀─────▶│ Sessions / receipts    │
│ No content sync        │       │ WS presence + OT stub  │       │ Global pub/sub         │
└────────────────────────┘       └────────────────────────┘       └────────────────────────┘
                                              ▲
                                              │
   REST reads/writes                          ├────────────────────────────────┐
                                              │                                ▲
                                              │                                │
                                              ▼                                ▼
                                 ┌────────────────────────┐       ┌────────────────────────┐
                                 │ PostgreSQL :5432       │       │ Per-process maps       │
                                 │ Content / review rows  │◀──────│ Version / log / users  │
                                 │ Operations / versions  │       │ No edited content      │
                                 └────────────────────────┘       └────────────────────────┘


WS operations are ACKed in memory; only the last debounced operation is written to SQL.

That writer advances version but does not apply content. Redis peers only forward messages.


Vite :5173 proxies /api and /ws to :3001. No owner election, replay or multi-writer safety.
```

[Compose](./docker-compose.yml) runs PostgreSQL 16 and Valkey 7. It mounts only the
schema, not the [seed](./backend/db-seed/seed.sql). [Backend scripts](./backend/package.json)
start one Express/`ws` process on 3001; alternate dev scripts use 3002 and 3003, with
no owner routing or fencing. [Vite](./frontend/vite.config.ts) proxies both transports
to 3001. The [README](./README.md) gives Docker/native setup and actual defaults.

The [frontend](./frontend/package.json) uses React 18, React Router v6, Zustand,
Tailwind, and TipTap 2. Installed collaboration extensions are not configured in
[Editor.tsx](./frontend/src/components/Editor.tsx); its `onUpdate` sends nothing.
It emits selection messages and displays presence names, but no remote caret layer.
[DocumentPage](./frontend/src/routes/DocumentPage.tsx) processes presence and errors,
ignores incoming operations, and ignores SYNC content/version. REST PATCH updates
only title, so local body edits have no alternative save path.

### Database Schema — exact local definition

The following is [backend/src/db/init.sql](./backend/src/db/init.sql), including its
actual defaults, constraints, and indexes. It is a fresh-database initialization file,
not the proposed production schema or a repeatable migration.

```sql
-- Google Docs Database Schema
-- UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_color VARCHAR(7) DEFAULT '#3B82F6',
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sessions table for Redis-backed auth
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Documents table
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL DEFAULT 'Untitled Document',
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_version BIGINT DEFAULT 0,
    content JSONB DEFAULT '{"type":"doc","content":[{"type":"paragraph","content":[]}]}',
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Document permissions
CREATE TABLE document_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255),
    permission_level VARCHAR(20) NOT NULL CHECK (permission_level IN ('view', 'comment', 'edit')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(document_id, user_id),
    UNIQUE(document_id, email)
);

-- Document versions (snapshots)
CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number BIGINT NOT NULL,
    content JSONB NOT NULL,
    created_by UUID REFERENCES users(id),
    is_named BOOLEAN DEFAULT FALSE,
    name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(document_id, version_number)
);

-- Operations log for OT
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number BIGINT NOT NULL,
    operation JSONB NOT NULL,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(document_id, version_number)
);

-- Comments
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    anchor_start INTEGER,
    anchor_end INTEGER,
    anchor_version BIGINT,
    content TEXT NOT NULL,
    author_id UUID NOT NULL REFERENCES users(id),
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Suggestions (tracked changes)
CREATE TABLE suggestions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    suggestion_type VARCHAR(20) NOT NULL CHECK (suggestion_type IN ('insert', 'delete', 'replace')),
    anchor_start INTEGER NOT NULL,
    anchor_end INTEGER NOT NULL,
    anchor_version BIGINT NOT NULL,
    original_text TEXT,
    suggested_text TEXT,
    author_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_documents_owner ON documents(owner_id);
CREATE INDEX idx_documents_updated ON documents(updated_at DESC);
CREATE INDEX idx_document_permissions_user ON document_permissions(user_id);
CREATE INDEX idx_document_versions_doc ON document_versions(document_id, version_number DESC);
CREATE INDEX idx_operations_doc ON operations(document_id, version_number);
CREATE INDEX idx_comments_doc ON comments(document_id);
CREATE INDEX idx_suggestions_doc ON suggestions(document_id);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Seed data is in db-seed/seed.sql
```

This schema has no owner epoch, durable operation ID/digest, accepted-batch receipt,
or outbox. JSONB columns are not validated against an editor schema in PostgreSQL.
Permission rows do not require exactly one of user/email, comment parents are not
constrained to the same document, and nullable/default fields differ from the older
architecture's stronger schema claims.

### Source-traced behavior and gaps

| Path | Observed implementation and consequence |
|------|-----------------------------------------|
| [Document routes](./backend/src/routes/documents.ts) | Authorized list/open, create plus initial snapshot, title-only PATCH, soft-delete, owner share/remove grant. List is unpaginated and ordered primarily by UUID. Create uses separate SQL writes. |
| [Collaboration state](./backend/src/services/collaboration/state.ts) and [types](./backend/src/services/collaboration/types.ts) | Each process holds version, operation arrays, and user-keyed presence; it holds no edited content. |
| [Subscribe](./backend/src/services/collaboration/sync.ts) | Reads SQL content and combines it with the in-memory version. Initializes an empty log even for a nonzero database version; no snapshot-plus-suffix reconstruction. |
| [Operation handling](./backend/src/services/collaboration/ot.ts) | Accepts any subscribed client's operation without checking edit capability, current grant, deletion, valid base, or schema. Uses `operationLog.slice(clientVersion)` although the array has no absolute version origin. |
| [OT helpers](./backend/src/services/ot.ts) | Flat insert/delete examples, format pass-through, no general rich-text step model. Equal-position inserts always shift the first operand; symmetric application can diverge without a coordinated protocol. Apply/anchor helpers are not called by collaboration persistence. |
| [Persistence](./backend/src/services/collaboration/persist.ts) | A one-second inactivity timer retains only its last operation, not a batch. Continuous edits can postpone writes indefinitely. Separate statements append that operation and update the version; they never update document content. |
| [Snapshot persistence](./backend/src/services/collaboration/persist.ts) | Only a persisted version divisible by 100 copies the existing SQL content. Skipped versions and stale content prevent the claimed bounded replay guarantee. |
| [Cross-server handlers](./backend/src/services/collaboration/index.ts) | Global `doc:operations`/`doc:presence` subscriptions forward messages but do not update peer process version/log/presence state. There is no durable replay. |
| [Presence](./backend/src/services/collaboration/presence.ts) | User-keyed local map conflates multiple tabs. One tab leaving can remove the user's presence and even the document state while another tab remains. Leave messages are not published to Redis. |
| [Version routes](./backend/src/routes/versions.ts) | Read only exact stored snapshots, list up to 100, name the current SQL snapshot, restore via separate writes. No operation replay, owner coordination, or broadcast accompanies restore. |
| [Comments](./backend/src/routes/comments.ts) and [suggestions](./backend/src/routes/suggestions.ts) | REST discussion/status records; comments are not mapped through edits and accepting a suggestion does not modify content. Auxiliary access queries omit `is_deleted`; author mutation checks do not recheck current membership. |

`documents.current_version` is BIGINT. The [default pg parser](https://github.com/brianc/node-pg-types)
returns it as a string; no local parser override exists. The restore handler's
`current_version + 1` therefore turns `5` into `51`. Creating a snapshot does not
capture unsent browser text, despite the history panel's reassuring restore prompt.

The [document store](./frontend/src/stores/documentStore.ts) updates after successful
requests, not before them. It shares one current document, comments array, history
array, and loading/error state without account/document request generations. Late
responses can replace a newer route's data. Comment/version actions swallow failures;
[CommentsPanel](./frontend/src/components/CommentsPanel.tsx) then clears authored input.

[WebSocketService](./frontend/src/services/websocket.ts) reconnects with linear delays
of 1–5 seconds and resubscribes. It does not replay its pending operation array or
attach operation IDs, and deliberate close can still schedule reconnect. The page's
connection flag is not updated on later transport close. Idle sockets are closed after
60 seconds of inactivity by a 30-second server scan, with no client heartbeat.

### Production patterns actually wired

[HTTP authentication](./backend/src/middleware/auth.ts) checks the cookie or bearer
session token in Valkey, falling back to PostgreSQL only on a cache miss. A Redis
error fails authentication; it is not an outage fallback. [Login/register](./backend/src/routes/auth.ts)
create UUID tokens and seven-day database/cache sessions; a SQL fallback fills a
one-hour cache entry without clamping it to remaining session lifetime.

The browser also persists the token in localStorage and puts it in the WebSocket URL.
WebSocket admission checks only Redis. Neither session revocation nor document grant
changes evict existing sockets, and the server does not validate WebSocket origin.
These details differ from the old “instant revocation” and cookie-only claims.

[RBAC middleware](./backend/src/shared/rbac.ts) is wired to document title/share/delete
routes, with owner-only sharing/deletion. Other routes perform their own SQL checks;
WebSocket edits do not use that middleware. No admin-management or transfer-ownership
route is mounted. Email-only grants are not converted on registration.

[HTTP idempotency middleware](./backend/src/middleware/idempotency.ts) is optional on
create/title/share. It uses a 30-second Redis lock and one-hour result cache; keys
omit method/path and payload digest, storage follows the response, and failures fail
open. The browser sends no idempotency header. [WebSocket receipt caching](./backend/src/shared/idempotency.ts)
is also optional and uses a lookup followed by processing without a claim lock.
Concurrent duplicates can both advance state; neither path is atomic with SQL.

The following actual wrapper illustrates dependency isolation, not durable retry:

```typescript
export const persistCircuitBreaker = createCircuitBreaker(
  'db-persist',
  persistOperationToDb,
  OT_SYNC_OPTIONS
);
```

[Both persistence and operation publishing](./backend/src/services/collaboration/persist.ts)
use `OT_SYNC_OPTIONS`: a two-second timeout, 50% failure threshold, minimum volume 3,
and five-second reset in [circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts).
Presence publishing bypasses the breakers. Persistence retries an open-circuit error
through another in-memory timer after 15 seconds; other failures are logged. There
is no durable queue, cached-document fallback, or read-only mode. A timeout does not
cancel the underlying SQL operation or undo its possible effects.

[Metrics](./backend/src/shared/metrics.ts) and [entry-point middleware](./backend/src/index.ts)
record HTTP duration/count, active document/connection gauges, operation counts,
cache outcomes, and breaker state/events. `google_docs_sync_latency_ms` measures
handler time through ACK/cache storage, before publishing/persistence; it is not
peer-render or durable-save latency. The database-query histogram is declared but
unused. No Prometheus/Grafana services or alert rules are deployed in Compose.

[Pino](./backend/src/shared/logger.ts) supplies structured logs and child context,
with pretty output in development. There is no propagated distributed tracing
implementation. `/health` executes PostgreSQL `SELECT 1` and Redis `PING` sequentially,
returns 200/503 plus local collaboration counts, and has no explicit overall deadline.
No rate-limiting middleware is mounted.

### Simplified, substituted, and omitted

Valkey stands in for Redis; one PostgreSQL instance and in-process maps replace
partitioned ownership. Vite replaces static hosting, and local account sessions replace
federated identity. The demo has no durable editor integration, verified snapshot
reconstruction, safe offline queue, supported multi-writer deployment, protocol schema
validation, anchored review UI, export, full-text search, or working suggestion application.

The proposed design supplies those missing boundaries conceptually; this documentation
review does not implement them. Eight isolated source checks reproduced the editor,
transform, receipt, debounce, and BIGINT behaviors and verified the seed password hash.
The app, databases, and browser were not started, and no convergence or load benchmark
is claimed. [The interview answers](./system-design-answer-fullstack.md) use a smaller
whiteboard narrative rather than this implementation inventory.
