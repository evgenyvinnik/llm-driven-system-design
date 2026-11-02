# Gmail: system architecture

## System Overview

This project explores email conversations whose content and mailbox state have different ownership. A message has a specific sender and recipient set; reading, starring, filing, and deleting it belong to each user's mailbox. A thread groups related messages, but membership in one message must not grant access to every message in that thread.

The **production proposal** below describes an internal email service at a stated hypothetical scale. The **local implementation** is a React client, one Express API, a polling indexer, PostgreSQL, Valkey, and Elasticsearch. It enforces per-message visibility (a user sees only messages they sent or received), sanitizes stored HTML, and has real transactions, sessions, draft version checks, and rate limits. It still lacks the durable receipts and per-mailbox projections of the production design, as described in the final Implementation Notes. It does not implement Google Gmail's infrastructure or external email transport. Setup is in [README.md](./README.md).

## Requirements

### Production scope

Support internal send/reply with To, CC, and BCC; per-user conversation lists and mailbox state; custom labels; conflict-safe drafts; contact completion; and privacy-filtered full-text search. A new recipient sees only messages addressed to them, plus any content explicitly included in a new message. BCC envelope identities are visible to the sender and relevant recipient, never other recipients.

Exclude SMTP/IMAP/POP3 interoperability, mailing-list expansion, attachments, scheduling, and spam classification from the first design. Keep explicit Spam and Trash folders. Distinguish accepting a send from completing delivery to every mailbox. Acknowledging a send must not imply that every downstream search projection is ready.

| Requirement | Proposed target or invariant |
|-------------|------------------------------|
| Availability | 99.99% for accepted sends and mailbox reads; search may degrade separately |
| Latency | API p99 below 200 ms for a bounded inbox page; below 500 ms for bounded search |
| Send correctness | One accepted message per sender/operation key and identical request content within the retention window |
| Delivery | Durable retries and unique recipient delivery records; expose delayed or failed delivery |
| Draft safety | Conditional revisions; preserve the losing editor's local text on conflict |
| Privacy | Check message entitlement before returning content, summaries, search snippets, or attachments if later added |
| Freshness | Read-your-writes for the acting mailbox; target search indexing within 10 seconds under normal load |
| Limits | Bounded body bytes, recipient count, page size, search work, and draft retention |

These are design targets, not measurements. Privacy and durable acceptance remain requirements during dependency failures; degraded search must identify itself rather than returning a false claim of no matching mail.

## Capacity Estimation

Assume 10 million daily active users, 20 sends per user per day, three recipients per send, 100 mailbox-page reads per user per day, five searches per user per day, and 10 KB average text bodies. These inputs are hypothetical, not published Gmail statistics.

| Workload | Daily estimate | Average rate | Tenfold peak assumption |
|----------|----------------|--------------|--------------------------|
| Accepted messages | 200 million | About 2,315/s | About 23,150/s |
| Recipient deliveries | 600 million | About 6,945/s | About 69,450/s |
| Mailbox page reads | 1 billion | About 11,575/s | About 115,750/s |
| Searches | 50 million | About 580/s | About 5,800/s |

Text alone adds about 2 TB/day before replication, metadata, indexes, and backups. Sender plus recipient projections create roughly 800 million mailbox-message records/day. Actual recipient distributions and body sizes matter more than a single average; cap fan-out and isolate abusive senders. Retention is a product requirement to price explicitly, not an assumption of unlimited free storage.

### Local Development Scale

The supplied fixture contains three users, five threads, nine messages, and one draft. One API and one indexer are enough for exploration. Compose allocates a 256 MB Elasticsearch heap. No throughput or memory benchmark establishes production capacity from this setup.

## High-Level Architecture

Production proposal; the durable event path is an extension to the local code:

```
PROPOSED INTERNAL MAIL — acceptance and each mailbox delivery commit separately

┌──────────────────────────┐            ┌──────────────────────────┐            ┌──────────────────────────┐
│ Internal mail clients    │HTTP/result │ Authenticated mail API   │accept/read │ Sender authority + SQL   │
│ Read / organize / send   │◀──────────▶│ Account / owner routing  │◀──────────▶│ Draft / body / audience  │
│ Saved operation IDs      │            │ Read / save / send       │            │ Send receipt + outbox    │
└──────────────────────────┘            └──────────────────────────┘            └──────────────────────────┘
              ▲                                       ▲                                       ▲
              │                                       │                                       │
              │ query / results                       │ read / mailbox state                  │ work / delivery status
              │                                       │                                       │
              ▼                                       ▼                                       ▼
┌──────────────────────────┐            ┌──────────────────────────┐            ┌──────────────────────────┐
│ Authorized search API    │access/read │ Mailbox authority + SQL  │commit / ACK│ Recipient delivery       │
│ Current entitlement      │◀──────────▶│ Effect + receipt commit  │◀──────────▶│ User/message identity    │
│ Safe viewer snippets     │            │ Viewer state + outbox    │            │ Delivery outcome / retry │
└──────────────────────────┘            └──────────────────────────┘            └──────────────────────────┘
              ▲                                       ▲
              │                                       │
              │ query / candidates                    │ changes / progress
              │                                       │
              ▼                                       ▼
┌──────────────────────────┐            ┌──────────────────────────┐
│ Per-mailbox index        │apply / ACK │ Indexing workers         │
│ Viewer-scoped fields     │◀──────────▶│ Replay mailbox changes   │
│ Versioned / rebuildable  │            │ Upserts + tombstones     │
└──────────────────────────┘            └──────────────────────────┘

An index outage delays discovery; it neither undoes acceptance nor authorizes hidden mail.
```

Redis holds revocable sessions, shared request limits, and bounded per-mailbox caches. Database ownership and an authenticated user context govern every API operation. The search API retrieves candidate IDs from its projection and verifies current entitlement before producing a response. Static CDN caching does not make private messages public.

Read the return arrows as separate outcomes: the sender commits a frozen send, each recipient commits a mailbox effect and receipt, and index workers confirm versioned projection effects before advancing progress. Delivery retries resolve the original user/message identity; they do not add unread state twice. A bounded account-scoped browser journal can retain local draft revisions and operation IDs under an explicit privacy/retention policy. On return, the client reauthenticates and resolves save/send receipts before retrying; restored local text is not proof of a server save or accepted send.

## Core Components / Request Flows

### Accept and deliver a message

The proposed acceptance transaction runs at a message authority associated with the sender. It validates all recipient addresses, checks reply access and parent context, stores immutable content and audience, claims a sender-scoped operation key with a request digest, and records durable delivery work. Unknown internal recipients reject the request before acceptance. A duplicate key with different recipients or text is a conflict, not a replay.

After commit, return the accepted message ID and delivery status. Workers create recipient mailbox entries with a uniqueness key of message ID and recipient ID; repeated work does not generate another unread increment. Contact updates and search indexing follow durable events. Sender and recipient mailbox shards need not participate in one cross-region transaction. A committed acceptance is preserved through a queue outage because its outbox remains in the database.

A crash after delivery but before acknowledgment leads to replay, so the mailbox write and its processed-event receipt commit together. Lease expiry allows another worker to recover abandoned work. Per-message delivery status reports outstanding recipients. Retry budgets distinguish transient infrastructure failures from permanently invalid or disabled recipients; accepted internal addresses have already been resolved to stable account IDs.

**Local:** [messageService.ts](./backend/src/services/messageService.ts) performs message, state, label, and contact SQL in a single database transaction. Recipients are normalized and deduplicated, and any address without an account rejects the whole send with 400. Replies require the sender to see the thread and the replied-to message. Body HTML is sanitized, and all caches are invalidated after commit. There is no send receipt, outbox, or delivery worker.

### Read a mailbox and conversation

The proposal stores a per-user conversation summary derived only from that user's visible messages: latest visible snippet/date, visible message count, and visible participants. Listing is ordered by mailbox activity plus a unique tie-breaker. Keyset pagination bounds deep reads but a live conversation can move across the cursor as replies arrive; deduplicate by thread ID and offer a refresh for newly arrived mail. A fixed search snapshot is a separate contract, not a property of any cursor.

Fetch message pages using the user's entitlement records, not a global thread lookup alone. Represent read state by the highest visible mailbox sequence actually presented. A later delivery has a higher sequence and remains unread when an older read request arrives late. Archive removes Inbox membership; Spam/Trash follow one canonical location policy. User actions and counts are committed together or associated with a mailbox revision for reconciliation.

**Local:** visibility is per message: a user sees a message only if they sent it or are one of its recipients. Thread detail returns only those messages. The list computes each thread's count, latest time, snippet and participants over the same set with a `LATERAL` subquery, so a reply that excludes someone never reaches their view. BCC lists are shown to the message's sender, and to a BCC recipient only as themself. This used to be thread-wide: anyone with a state row saw every message, including replies they were left off. Computing the summary per query rather than storing it per mailbox is the local simplification.

### Save drafts and send a frozen revision

A proposed editor separates the current local revision from the acknowledged server revision. Only one save is in flight per draft; newer typing stays dirty after an older save completes. The server conditionally replaces the expected version, with a durable save receipt so a lost successful response can be resolved. A conflict returns current server content while the browser retains its local copy for comparison or saving separately.

Sending freezes recipients and body at a chosen revision. A transaction at the draft/message authority checks that revision, records acceptance and the send receipt, and marks the draft sent. Late saves cannot resurrect a sent draft. The user can resolve an uncertain send through its operation key instead of generating another message. This proposal requires additional schema/state; the local draft table has only a version column and is disconnected from compose and send.

### Search without disclosing hidden recipients

Start with per-mailbox search documents keyed by user ID and message ID. Their contents include only fields visible to that user. Public To/CC fields can be shared; BCC fields require audience-specific projection. A single message document with all recipients in searchable name/address fields would reveal BCC participation through `to:hidden-address` matches even if those fields were omitted from the response.

The search service validates operators, bounds query cost, and returns message hits grouped deliberately in the UI. Current entitlement is checked before snippets or counts are disclosed. If using a point-in-time index view, it stabilizes search ordering, not authorization; revoked/deleted entries must still be removed during hydration. Bound candidate overfetch, report partial pages honestly, and avoid totals that count unauthorized results.

An outbox consumer publishes versioned upserts and tombstones. Old retries cannot restore deleted mail. A rebuild uses a new index generation, a consistent snapshot plus subsequent changes, verification, and an atomic read-alias switch. Retain enough change history to catch up; do not reset a global time checkpoint and assume completeness.

**Local:** each message is indexed once with a `visible_to` array of sender and all recipients. Searchable recipient fields exclude BCC for everyone, including the sender. Hits are re-checked against SQL (visibility plus the user's current Trash/Spam state), snippets are HTML-escaped with only highlight tags added, and `npm run search:reindex` rebuilds the index. There is no per-user index projection.

## Database Schema

### Actual local SQL

This is the exact [backend/src/db/init.sql](./backend/src/db/init.sql): ten tables and seven explicit secondary indexes, in addition to indexes backing primary/unique constraints. It has no idempotency/outbox table, processed-event receipts, mailbox sequence, or sent-draft state. The attachments table models metadata only. Foreign keys do not ensure that a reply parent belongs to its thread or that a label belongs to `thread_labels.user_id`.

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject VARCHAR(500) NOT NULL,
  snippet TEXT,
  message_count INT DEFAULT 0,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  in_reply_to UUID REFERENCES messages(id),
  body_text TEXT NOT NULL,
  body_html TEXT,
  has_attachments BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS message_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  recipient_type VARCHAR(3) NOT NULL CHECK (recipient_type IN ('to', 'cc', 'bcc')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) DEFAULT '#666666',
  is_system BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS thread_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(thread_id, label_id, user_id)
);

CREATE TABLE IF NOT EXISTS thread_user_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_read BOOLEAN DEFAULT false,
  is_starred BOOLEAN DEFAULT false,
  is_archived BOOLEAN DEFAULT false,
  is_trashed BOOLEAN DEFAULT false,
  is_spam BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(thread_id, user_id)
);

CREATE TABLE IF NOT EXISTS drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id UUID REFERENCES threads(id),
  in_reply_to UUID REFERENCES messages(id),
  subject VARCHAR(500),
  body_text TEXT,
  body_html TEXT,
  to_recipients JSONB DEFAULT '[]',
  cc_recipients JSONB DEFAULT '[]',
  bcc_recipients JSONB DEFAULT '[]',
  version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_email VARCHAR(255) NOT NULL,
  contact_name VARCHAR(100),
  frequency INT DEFAULT 0,
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, contact_email)
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100),
  size_bytes BIGINT,
  storage_key TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_recipients_user ON message_recipients(user_id, message_id);
CREATE INDEX IF NOT EXISTS idx_thread_labels_user ON thread_labels(user_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_thread_user_state_user ON thread_user_state(user_id, is_trashed, is_archived);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, frequency DESC);
CREATE INDEX IF NOT EXISTS idx_threads_last_message ON threads(last_message_at DESC);
```

### Proposed production extensions

| Record | Key and invariant | Purpose |
|--------|-------------------|---------|
| Send receipt | Unique sender ID + operation key; request digest and accepted message ID | Resolve duplicate and uncertain sends |
| Message audience | Unique message ID + recipient ID; envelope role and entitlement state | Separate content access from thread membership |
| Mailbox message | Unique user ID + message ID; mailbox sequence and delivery receipt | Replay-safe delivery and per-user visibility |
| Mailbox conversation | User ID + thread ID; visible summary, state version, read-through sequence | Efficient inbox reads and safe read marking |
| Outbox / processed event | Durable event ID, entity version, retry/lease state | Recovery across independent stores |
| Draft lifecycle | Owner, content version, active/sent/deleted state, send ID | Serialize final acceptance with editing |

These are proposed records, not tables created by the setup script. A small single-database version can transact across them before partitioning; after partitioning, acceptance and recipient delivery are explicitly separate commits.

## API Design

### Implemented API

All paths below have `/api/v1` as their prefix. Except register/login/logout, handlers require a session user ID. Generic pagination uses a parsed page number with no positive-range validation; list and search sizes are fixed by their routes.

| Method | Path | Actual behavior |
|--------|------|-----------------|
| POST | `/auth/register`, `/auth/login` | Register with eight labels; login by username |
| POST / GET | `/auth/logout` / `/auth/me` | Destroy session / load current user from SQL |
| GET | `/threads?label=INBOX&page=1` | 25 conversations; summary over the caller's visible messages; archived threads excluded from INBOX |
| GET | `/threads/unread-counts` | Per-label unread counts with the same folder predicates as the lists, plus Starred and Spam |
| GET | `/threads/:threadId` | The caller's visible messages (404 if none); marks thread read |
| PATCH | `/threads/:threadId/state` | Update supplied boolean flags; 404 if the caller has no state for the thread |
| POST | `/messages/send`, `/messages/reply` | Internal SQL send; 400 with `unknownRecipients`, 404 for a thread or parent the sender cannot see; 201 returns threadId and messageId |
| GET / POST | `/labels` | List labels / create custom label |
| PUT / DELETE | `/labels/:labelId` | Owner-scoped custom-label mutation; system labels protected |
| POST | `/labels/:labelId/assign`, `/labels/:labelId/remove` | Assign/remove; the label must be the caller's and the thread visible (else 404) |
| GET / POST | `/drafts` | Unpaged draft list / create another version-1 draft |
| GET / PUT / DELETE | `/drafts/:draftId` | Owner-scoped read/update/delete; PUT requires version |
| GET | `/search?q=...&page=1` | 20 message hits re-checked against SQL; `degraded: true` when served by the SQL fallback |
| GET | `/contacts?q=...` | Up to ten matching contacts, ordered by frequency |

Draft conflicts return 409 with `error` and current `draft`; missing drafts return 404. The browser's shared fetch helper converts failures to a plain Error and drops status/current-draft data. New production contracts would add operation receipts, expected versions, and cursor/sequence metadata. They are not accepted by the current endpoints merely because they appear in this design.

## Key Design Decisions

### Per-user projections instead of one mutable global mailbox

A shared body avoids copying large content, but a shared read bit cannot represent Alice reading while Bob remains unread. Mailbox rows also supply a natural user partition and query index. The cost is delivery fan-out, projection repair, and extra records. For a bounded small installation, normalized joins can be sufficient; at scale, denormalize the visible summary beside mailbox state rather than joining unrelated shards for every inbox page.

JSONB is a valid alternative for bounded aggregate data and supports indexes. The reason to avoid an ever-growing user-state object on one thread is its shared update hotspot and poor fit for user-oriented sorting and partitioning, not an inability to index JSONB. PostgreSQL documents both [JSONB indexes and whole-row update locking](https://www.postgresql.org/docs/16/datatype-json.html).

### Dedicated search after measuring database search

PostgreSQL full-text search can be combined with permission predicates and indexes. It does not inherently fail BCC privacy. Elasticsearch becomes attractive when relevance tuning, independently scaled indexing, and a large historical corpus justify a second system. That choice introduces lag, replay, privacy-projection maintenance, and backup/rebuild work. Neither engine supplies authorization automatically.

The local searchable recipient fields exclude BCC, while the proposed per-mailbox projection supports sender-specific envelope search. Replication costs more index space but keeps query routing aligned with mailbox ownership. A shared document cannot be routed once by each of several independent user IDs without either duplication or broader searches.

### Conditional saves with explicit recovery

A draft version check prevents an older editor from overwriting a newer saved revision. It does not merge text or preserve the losing browser's unsaved work by itself. Prefer conflict-aware saves over unconditional last-write-wins for valuable authored content. Short database locks during the update are normal; pessimistic locking does not inherently mean holding a connection for hours. An editing lease is another option, but must handle abandoned tabs and fencing. Optimistic saves accept occasional conflicts and require a clear recovery UI.

## Consistency and Idempotency

Production acceptance commits content, audience, request receipt, and outbox together. Duplicate requests serialize on the unique receipt key; insert-or-ignore after repeating the operation is insufficient. A request digest covers recipient roles, text, reply context, and the frozen draft revision. Retain receipts for a declared retry window and keep accepted message IDs queryable; an expired key cannot promise unlimited deduplication.

Recipient delivery is at least once in transport with one committed mailbox effect per unique delivery ID. Search is eventually consistent and independently repairable. UI read-your-writes uses a mailbox revision or primary read until replicas catch up. Cache invalidation follows commit; generation checks prevent an older in-flight read from repopulating a newer cache generation.

**Local deviations:** no send or draft-create receipt exists, so retrying an uncertain send can send again. Recipient SQL and contacts are transactional, and cache invalidation runs after commit and fails open (a per-user generation counter, bumped with `INCR`), so a Redis failure can no longer turn persisted mail into an error. A new delivery un-archives the thread for its recipients but leaves Trash and Spam alone.

## Security / Auth

Production checks message entitlement, draft ownership, label ownership, recipient limits, and reply-parent context on every route. Reject unauthorized thread IDs before any mutation. Do not log message bodies, BCC lists, or raw search queries. HTML email requires a defined sanitization policy, isolated rendering, safe links, and controlled remote images; plain text is a simpler initial contract.

Local sessions use `connect.sid`, Redis prefix `sess:`, HTTP-only/SameSite=Lax cookies, and a seven-day cookie maxAge. Secure cookies require production HTTPS. Login/register assign the existing session without explicit ID regeneration. `requireAuth` checks only the session's userId; `/me` separately loads SQL. Account creation and its eight label inserts are not one transaction. Input checks cover some required fields, username length 3–30, and password length at least six, with bcrypt cost 12; they do not constitute comprehensive validation or email normalization.

CORS allows the two localhost frontend origins. It is not an authorization layer or a complete CSRF defense; URL-encoded bodies are also accepted. `trust proxy=1` assumes a trusted single proxy hop. The current API permits sending into a known unrelated thread and thereby adds the sender's thread-state row, which can expose that thread's history. Label assignment does not validate label ownership or thread membership. Raw `bodyHtml` and search snippets reach `dangerouslySetInnerHTML` without sanitization. These gaps require correction before using private data.

## Observability

The production dashboard should distinguish accepted sends, recipient delivery latency/backlog, duplicate replays, draft conflicts, search lag, projection repairs, and permission failures. Measure p99 by operation with bounded labels. A healthy process does not prove that a newly accepted message is searchable or delivered.

Local [metrics.ts](./backend/src/services/metrics.ts) registers HTTP duration/count, send count, search count/duration, draft conflicts, authentication outcomes, and rate-limit hits. HTTP route labels use router-local paths or raw unmatched paths, which can merge unrelated endpoints or create unbounded cardinality. The indexer increments its own process-local indexed-message counter, but exposes no scrape server. The API's separate registry cannot show that worker count. Received-mail, DB duration/pool, and breaker metrics are declared without active producers.

[Pino logging](./backend/src/services/logger.ts) records request completion and `x-trace-id` propagation. Service logs use the global logger, so trace context is not consistently attached. `logQuery`, `logCache`, and the request-child helper are unused; database/Redis errors also use console output. Requests log `originalUrl`, and search debug logs include query text. There is no configured redaction, distributed tracing collector, Prometheus server, or Grafana deployment.

## Failure Handling

| Failure | Proposed response | Actual local behavior |
|---------|-------------------|-----------------------|
| Redis unavailable | Fail closed for authentication; isolate optional caches | Sessions/limits depend on Redis; the mailbox cache fails open (misses, no-op writes) |
| SQL unavailable | Reject new work; retain client drafts and uncertain-operation IDs | Pool errors reach routes; an idle-client error exits the process |
| Search unavailable | Explicit degraded response, bounded deadline, durable indexing backlog | 5 s client timeout, then a visibility-checked SQL fallback with `degraded: true`; unindexed messages wait in SQL |
| Worker stops | Resume leased outbox records with deduplication | Per-message `indexed_at` markers; a restarted worker resumes exactly where it stopped (no lease for multiple workers) |
| Response lost after send | Resolve receipt using the same operation key | No receipt; retry can duplicate an already committed send |

[rateLimiter.ts](./backend/src/services/rateLimiter.ts) applies Redis counters to general `/api/` traffic (1,000/minute), login failures (five/minute, successful requests decremented), sends/replies (50/hour), and search (60/minute). Keys use session user ID or the library's IP/subnet helper. This is a counter with expiration, not a sliding-window log. It limits requests, not recipients or bytes; general limits include health endpoints.

The API installs sessions and rate limiting before its health handlers. `/api/health` and `/api/health/live` have simple bodies but are not dependency-isolated liveness endpoints. `/api/health/detailed` checks SQL then Redis and returns 503 on failure, without an overall deadline or Elasticsearch/worker check. SQL has a 20-connection pool, a two-second connection timeout, and no statement timeout. Redis retries linearly at 100 ms times the attempt count, capped at three seconds, with three retries per request. Re-login cannot repair a Redis outage.

Shutdown closes pools and exits without closing/draining the HTTP listener. The worker has an unconditional polling loop without a signal-drain protocol. Proposed shutdown stops new work, finishes or releases leases, drains in-flight requests to a deadline, and then closes dependency clients.

## Scalability Considerations

The first local constraints include one synchronous transaction per send, sequential per-recipient SQL and Redis work, unindexed global message-time polling, and whole-thread retrieval. The indexer handles at most 100 messages before sleeping five seconds, so even ignoring work time and cursor defects its nominal rate is below 20 messages/second.

Shard mailbox state, drafts, contacts, and search projections by user ID. Route shared immutable message content through its own authority; do not claim that this makes multi-recipient writes one local transaction. Increase delivery consumers by mailbox partition, preserve per-entity versions, bound fan-out, and reconcile lagging recipients. Partition historical content after measuring retention and access patterns. Cache hot first pages rather than assuming a universal 97% hit rate.

A conversation that receives continuous mail is a hot aggregate. Batch summary updates, separate immutable messages from mutable mailbox summaries, and bound per-conversation fetches. Large bulk mail belongs on an explicitly limited path. Multi-region durability needs a chosen replication and failover contract; 99.99% availability is not supplied by running three API ports against one database.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Content/state model | Immutable messages + per-user projections | One global thread view | Independent state and recipient-specific history |
| Delivery boundary | Durable acceptance then replay-safe mailbox fan-out | Global multi-recipient transaction | Keeps shard failures out of acceptance latency |
| Draft updates | Conditional versions + recovery | Unconditional last-write-wins | Preserve authored work and expose conflicts |
| Search at scale | Per-mailbox search projections | Shared recipient-search document | Align privacy and routing with the viewer |
| Index propagation | Durable events with versioned writes | Timestamp-only polling | Recover retries, deletions, and late commits |
| Client navigation | Bounded pages with explicit refresh | Unlimited retained feed | Predictable memory and understandable ordering |

## Implementation Notes

### What actually runs

[app.ts](./backend/src/app.ts) mounts seven route groups in one Express process. [index.ts](./backend/src/index.ts) starts the listener without a dependency-readiness gate. `npm run dev` starts it together with the [worker](./backend/src/workers/search-indexer.ts) (via `concurrently`); the worker waits for Elasticsearch and initializes the index. An existing index's mapping is not migrated; `npm run search:reindex` recreates it.

[config/index.ts](./backend/src/config/index.ts) loads dotenv, but the [database pool](./backend/src/services/db.ts) ignores `DATABASE_URL` and uses `POSTGRES_*`. The [Redis client](./backend/src/services/redis.ts) ignores `REDIS_URL` and uses `REDIS_HOST`/`REDIS_PORT`. The separate [migration runner](./backend/src/db/migrate.ts) uses exported `DATABASE_URL` without dotenv. `dev:server2`/`dev:server3` bind 3002/3003 (they used to call `dev` and inherit its forced 3001).

### Visibility, sending, and mailbox semantics (implemented)

**Visibility is per message** ([threadService.ts](./backend/src/services/threadService.ts), `visibleMessageSql`): sender or recipient of that message, nothing broader. It drives thread detail, the list's per-user summary (count, latest time, snippet and participants, computed with a `LATERAL` subquery over visible messages), unread counts, search re-checks, label assignment and replies. The seed includes two threads that exercise the rule:
- Bob replies to Alice only in a thread Charlie was on.
- Charlie BCCs Alice.

The trade-off is that the summary is recomputed per list query and not stored per mailbox. That is cheap at local scale, and is the point at which the production design's per-user projection takes over.

**Sending** ([messageService.ts](./backend/src/services/messageService.ts)):
- Recipients are normalized (trimmed, lowercased) and deduplicated, keeping each person's most visible role (to > cc > bcc). A unique `(message_id, user_id)` index backs this; duplicate addresses used to create duplicate rows and double contact counts.
- Unknown addresses fail the whole send with 400 and the list, instead of being dropped silently.
- A reply must target a thread the sender can see and a parent message they can see. Before, posting into any thread ID created a state row for the sender, which then exposed the whole conversation.
- `bodyHtml` is sanitized with an allow-list ([htmlSanitizer.ts](./backend/src/services/htmlSanitizer.ts)); the reader also runs DOMPurify for rows written earlier.
- New mail un-archives the thread for its recipients, as Gmail does.

The draft update's essential condition is unchanged:

```sql
WHERE id = $1 AND user_id = $2 AND version = $11
```

Draft creation is still not idempotent, deletion is unconditional on version, and reply references are not checked against the caller's visible thread.

**Mailbox semantics.**
- **Folders.** INBOX excludes archived threads (Archive used to do nothing visible), Spam excludes Trash, and unread counts use the same predicates; an archived thread no longer counts toward INBOX.
- **Caching.** Thread lists and unread counts are cached for 30 seconds under keys that embed a per-user generation, and every write bumps it with `INCR` after commit: state changes, sends (for all participants), label changes, label renames and deletes. The old code called `DEL` on a key containing `*`, which Redis does not expand, so nothing was invalidated. Cache helpers fail open.
- **Validation.** Malformed IDs are 404s rather than Postgres cast errors, and a state change on a thread the caller has no part in is a 404.

Sessions and Redis-backed rate limits are wired. The [circuit-breaker factory](./backend/src/services/circuitBreaker.ts) still has no production call site; the search path's resilience is a short client timeout plus the SQL fallback.

### Indexing and search contract

The [worker](./backend/src/workers/search-indexer.ts) indexes messages whose `indexed_at` is NULL, ordered by `(created_at, id)`, and sets the marker per message once its document is written. That replaced a timestamp checkpoint in Redis with three failure modes:
- **Ties.** It re-selected the same batch forever when more than 100 messages shared a timestamp (the stored Date lost its microseconds), or skipped rows at an exact boundary.
- **Late commits.** A transaction committing after a newer message had been indexed fell behind the checkpoint (`created_at` is transaction start time).
- **Batch coupling.** It retried whole batches after one failure.

A failure now increments `index_attempts` and records `index_error`, and the message is retried up to 10 times. The worker waits for Elasticsearch at boot, `npm run dev` starts it alongside the API, and `npm run search:reindex` recreates the index and clears the markers. There is no lease, so two workers would duplicate work (harmlessly, since document IDs are message IDs).

[searchService.ts](./backend/src/services/searchService.ts):
- **Visibility.** Elasticsearch filters by `visible_to`, then hits are re-checked against SQL for visibility and current Trash/Spam state, which the index cannot know. The reported total subtracts what a page drops, so it is an estimate when trashed mail matches.
- **Escaping.** Highlights use the `html` encoder, and plain-text fallbacks are escaped, so a snippet's only markup is `<em>`.
- **Fallback.** On an Elasticsearch error (5 s timeout, one retry), search runs an escaped `ILIKE` query over the user's visible, non-trashed messages, supporting `from:`, `to:`, `has:attachment`, `before:` and `after:`, and returns `degraded: true`.

Operator parsing is unchanged: the first occurrence of each simple operator, with no quoting grammar or date validation.

### Browser implementation

The [mail store](./frontend/src/stores/mailStore.ts) holds one list, one detail object, labels, counts, page, and compose visibility. Components generally subscribe to the entire store rather than selecting individual fields. Auth persists user/profile flags in localStorage; the server session remains in an HTTP-only cookie. Mail data is not cleared on logout or account changes, and requests have no account/query generation guard. The root removes the authenticated shell on logout but continues rendering the current route's Outlet, so retained mail may remain visible. Auth checking runs on initial mount, not on focus or every navigation.

[ThreadList](./frontend/src/components/ThreadList.tsx) virtualizes one 25-row page with 40 px estimates and five rows of overscan; it does not measure rows or assign thread IDs as virtualizer keys. The layout lacks a rigorously bounded viewport and there is no evidence of a particular frame rate. Rows are clickable divs without keyboard row navigation. The list and detail are alternative routes, not simultaneously mounted columns. Thread detail fetches every body even when [MessageCard](./frontend/src/components/MessageCard.tsx) initially collapses older messages.

Logout now resets the mail store, so a previous account's mail does not stay on screen. Star actions update only a matching item in the list, so detail remains stale and a direct visit with no list match sends no request. Archive/trash remove list items without updating totals/detail; failure refetches may restore cached state. Concurrent star responses can overwrite newer intent. Fetch failures are mostly silent and can leave stale content or a permanent detail loading message. Opening a thread marks SQL state read but does not reconcile list/counts. Reply is reply-all: the last sender plus To and CC, excluding yourself (CC used to be dropped and your own address kept), never copying BCC. Reply errors are shown inline.

[ComposeModal](./frontend/src/components/ComposeModal.tsx) retains text while minimized and while the authenticated shell stays mounted, but closes/discards without saving. Inputs remain editable during send; success closes the window even if newer text was entered. The [draft API wrapper](./frontend/src/services/api.ts) has no UI callers, and [LabelManager](./frontend/src/components/LabelManager.tsx) is unmounted. There is no undo toast, route-lazy compose, offline queue, attachment control, or admin view.

[ContactAutocomplete](./frontend/src/components/ContactAutocomplete.tsx) debounces 200 ms and filters already-selected addresses, but has no stale-response guard or active suggestion keyboard model. Enter/comma/Tab accept text containing `@`; Tab is prevented even when the field is empty. A typed address not committed to a chip is omitted from send. [SearchBar](./frontend/src/components/SearchBar.tsx) submits explicitly, keeps only the first page, and lacks URL query state and request ordering. It renders the server-escaped subject and snippet highlights and notes degraded mode. Message HTML is sanitized on send and again with DOMPurify when rendered, and BCC appears only as the server allows. There is no remote-image protection (tracking pixels load), modal focus trap, focus restoration, or comprehensive control labeling.

### Simplified, omitted, and verified

The local system uses one PostgreSQL database, one Valkey instance with AOF, one Elasticsearch node, and Vite in place of a CDN. It omits durable acceptance receipts, outbox delivery, repairable search projections, cross-region replication, attachments, protocol gateways, spam classification, push notifications, and a connected draft editor.

The SQL seed has three users, seven threads and twelve messages, including the reply-excludes-a-participant and BCC fixtures, and one API-only draft. The unique recipient index stops repeated seeding from duplicating recipient rows.

Tests:
- **Unit tests** (24) cover recipient deduplication, email HTML sanitization, the visibility clause, and fail-open generation caching.
- **Live run.** A scripted run against the full stack checks 34 behaviours:
  - per-message visibility in thread detail, list rows and search;
  - BCC display rules;
  - refused intrusion into others' threads and replies to invisible messages;
  - unknown-recipient refusal, recipient deduplication and HTML sanitization;
  - escaped search snippets;
  - archive and un-archive, immediate cache invalidation and unread counts;
  - trash hiding from search, label ownership, and indexing markers.
- **Outage run.** A second run stops Elasticsearch and confirms the visibility-checked, escaped SQL fallback within about 2 s, that a send during the outage records its failed index attempt, and that the message is indexed after recovery.
- **Screenshots** were regenerated, including the same thread as seen by its full and partial participants and the BCC recipient's view.
