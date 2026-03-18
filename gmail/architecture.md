# Gmail (Email Client) - System Architecture

## System Overview

Gmail is a web-based email client supporting thread-based conversations, per-user state management, full-text search with privacy controls, label-based organization, and draft auto-save with conflict detection. This design explores the unique challenges of email systems: each message has multiple recipients who maintain independent state (read, labels, archive), search must enforce privacy (BCC recipients hidden), and drafts need conflict-safe concurrent editing support.

**Learning Goals:**
- Thread model with independent per-user state
- Privacy-aware full-text search using Elasticsearch
- Optimistic locking for draft conflict detection
- Label system design (system + custom, per-user assignment)
- Contact frequency tracking for autocomplete

---

## Requirements

### Functional Requirements

1. **Account Management**: User registration, login, logout with session-based auth
2. **Email Composition**: Send emails with To, CC, BCC recipients
3. **Thread Conversations**: Messages grouped into threads with reply chains
4. **Per-User State**: Each user independently manages read, starred, archived, trashed, spam status
5. **Label System**: System labels (INBOX, SENT, TRASH, SPAM, STARRED, DRAFTS, ALL_MAIL, IMPORTANT) auto-created; custom labels with colors
6. **Full-Text Search**: Search email content with advanced operators (from:, to:, has:attachment, date ranges)
7. **Drafts**: Auto-save drafts with optimistic locking for conflict detection
8. **Contact Autocomplete**: Suggest contacts based on communication frequency

### Non-Functional Requirements (Production Scale)

| Requirement | Target |
|-------------|--------|
| Availability | 99.99% uptime |
| Latency | p99 < 200ms for inbox load, p99 < 500ms for search |
| Throughput | 100K emails/second globally |
| Storage | Petabytes of email data, indefinite retention |
| Consistency | Strong for send/receive, eventual for search index |
| Privacy | Users can only search/view emails they are participants in |

---

## Capacity Estimation

### Production Scale

| Metric | Value |
|--------|-------|
| Monthly Active Users | 1.8 billion |
| Emails sent/received per day | 300 billion |
| Average email size | 75 KB (text) + 500 KB (attachments) |
| Search queries per day | 10 billion |
| Storage growth per day | ~22 PB |

### Local Development Scale

| Metric | Value |
|--------|-------|
| Users | 3-10 |
| Emails | Hundreds |
| Threads | Dozens |
| Single PostgreSQL instance | Handles all data |

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                            CDN / Edge Network                                │
│                    (Static assets, TLS termination)                           │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │ HTTPS
                                    ▼
                          ┌─────────────────────┐
                          │    API Gateway       │
                          │  (Rate limit, auth)  │
                          └──────────┬──────────┘
                                     │
                   ┌─────────────────┼─────────────────┐
                   ▼                 ▼                 ▼
           ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
           │  API Server  │  │  API Server  │  │  API Server  │
           │  (Node.js)   │  │  (Node.js)   │  │  (Node.js)   │
           └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
                  │                 │                 │
                  └─────────────────┼─────────────────┘
                                    │
          ┌──────────┬──────────────┼──────────────┬───────────┐
          ▼          ▼              ▼              ▼           ▼
   ┌───────────┐ ┌────────┐ ┌───────────┐ ┌────────────┐ ┌─────────┐
   │PostgreSQL │ │ Redis/ │ │Elastic-   │ │  Search    │ │  Blob   │
   │ (Primary  │ │ Valkey │ │search     │ │  Indexer   │ │ Storage │
   │ + Replicas│ │(Cache +│ │ Cluster   │ │  Worker    │ │  (S3)   │
   │  + Shards)│ │Session)│ │           │ │            │ │         │
   └───────────┘ └────────┘ └───────────┘ └────────────┘ └─────────┘
```

---

## Core Components

### 1. API Server (Express + Node.js)

Handles all client requests through RESTful endpoints:

- **Auth Routes** (`/api/v1/auth/*`): Register, login, logout, session management
- **Thread Routes** (`/api/v1/threads/*`): List by label, get thread detail, update state
- **Message Routes** (`/api/v1/messages/*`): Send new email, reply to thread
- **Label Routes** (`/api/v1/labels/*`): CRUD labels, assign/remove from threads
- **Draft Routes** (`/api/v1/drafts/*`): CRUD drafts with version-based conflict detection
- **Search Routes** (`/api/v1/search`): Full-text search with advanced operators
- **Contact Routes** (`/api/v1/contacts`): Autocomplete by communication frequency

### 2. Thread Service

Manages thread listing, detail retrieval, and per-user state:

```
listThreads(userId, labelName, page)
├── Query threads by label join (thread_labels + labels)
├── Filter by thread_user_state (not trashed, not spam)
├── Join participants (senders + recipients)
├── Join labels for each thread
└── Return with pagination

getThread(userId, threadId)
├── Get thread with user state
├── Get all messages ordered by created_at
├── Get recipients for each message
├── Get labels for this user
└── Auto-mark as read
```

### 3. Message Service

Handles email send flow within a database transaction:

```
sendMessage(senderId, {to, cc, bcc, subject, bodyText, threadId})
├── BEGIN TRANSACTION
├── Check idempotency key (return existing if duplicate)
├── Look up recipient user IDs by email
├── Create or update thread
│   ├── New thread: INSERT with subject and snippet
│   └── Existing: UPDATE snippet, message_count, last_message_at
├── INSERT message
├── INSERT message_recipients (to, cc, bcc)
├── Add SENT label for sender
├── Add INBOX label + unread state for each recipient
├── Update contacts (frequency, last_contacted_at)
├── COMMIT
└── Invalidate caches
```

### 4. Search Service

Parses Gmail-style search operators and queries Elasticsearch:

```
search("from:alice has:attachment project")
├── Parse operators:
│   ├── from: "alice" → filter by sender_name or sender_email
│   ├── has:attachment → filter has_attachments: true
│   └── remaining text: "project" → multi_match on subject + body
├── Always filter: visible_to contains userId
├── Sort by relevance score, then recency
└── Return with highlights
```

### 5. Search Indexer Worker

Background process that polls for new messages and indexes them:

```
Poll Loop (every 5 seconds):
├── Read last_indexed timestamp from Redis
├── Query messages with created_at > last_indexed (LIMIT 100)
├── For each message:
│   ├── Get recipients
│   ├── Build visible_to = [sender_id, ...recipient_ids]
│   └── Index in Elasticsearch
├── Update last_indexed timestamp
└── Sleep 5 seconds
```

### 6. Draft Service

CRUD operations with optimistic locking:

```
updateDraft(userId, draftId, data, expectedVersion)
├── UPDATE drafts SET ... WHERE id = $1 AND version = $expected
├── If 0 rows affected:
│   ├── Check if draft exists
│   ├── If exists: return 409 Conflict with current version
│   └── If not: return 404
└── If updated: return new draft with version + 1
```

---

## Database Schema

### Entity Relationship

```
┌──────────┐     ┌──────────┐     ┌──────────────────┐
│  users   │────▶│ messages │────▶│message_recipients│
│          │     │          │     │                  │
│ id       │     │ id       │     │ message_id       │
│ username │     │ thread_id│     │ user_id          │
│ email    │     │ sender_id│     │ recipient_type   │
│ password │     │ body_text│     │ (to/cc/bcc)      │
└──────────┘     └──────────┘     └──────────────────┘
     │                │
     │           ┌────┴────┐
     │           │ threads │
     │           │         │
     │           │ id      │
     │           │ subject │
     │           │ snippet │
     │           └─────────┘
     │                │
     ▼                ▼
┌──────────┐   ┌──────────────────┐
│  labels  │   │thread_user_state │
│          │   │                  │
│ id       │   │ thread_id        │
│ user_id  │   │ user_id          │
│ name     │   │ is_read          │
│ color    │   │ is_starred       │
│ is_system│   │ is_archived      │
└──────────┘   │ is_trashed       │
     │         └──────────────────┘
     ▼
┌──────────────┐
│thread_labels │
│              │
│ thread_id    │
│ label_id     │
│ user_id      │
└──────────────┘
```

### Full SQL Schema

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject VARCHAR(500) NOT NULL,
  snippet TEXT,
  message_count INT DEFAULT 0,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id),
  in_reply_to UUID REFERENCES messages(id),
  body_text TEXT NOT NULL,
  body_html TEXT,
  has_attachments BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE message_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  recipient_type VARCHAR(3) NOT NULL CHECK (recipient_type IN ('to', 'cc', 'bcc')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) DEFAULT '#666666',
  is_system BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE TABLE thread_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(thread_id, label_id, user_id)
);

CREATE TABLE thread_user_state (
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

CREATE TABLE drafts (
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

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_email VARCHAR(255) NOT NULL,
  contact_name VARCHAR(100),
  frequency INT DEFAULT 0,
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, contact_email)
);

CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(100),
  size_bytes BIGINT,
  storage_key TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Key Indexes

```sql
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE INDEX idx_message_recipients_user ON message_recipients(user_id, message_id);
CREATE INDEX idx_thread_labels_user ON thread_labels(user_id, thread_id);
CREATE INDEX idx_thread_user_state_user ON thread_user_state(user_id, is_trashed, is_archived);
CREATE INDEX idx_drafts_user ON drafts(user_id, updated_at DESC);
CREATE INDEX idx_contacts_user ON contacts(user_id, frequency DESC);
CREATE INDEX idx_threads_last_message ON threads(last_message_at DESC);
```

---

## API Design

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/auth/register | Register new user |
| POST | /api/v1/auth/login | Login |
| POST | /api/v1/auth/logout | Logout |
| GET | /api/v1/auth/me | Get current user |

### Threads

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/v1/threads?label=INBOX&page=1 | List threads by label |
| GET | /api/v1/threads/unread-counts | Get unread counts per label |
| GET | /api/v1/threads/:threadId | Get thread with messages |
| PATCH | /api/v1/threads/:threadId/state | Update read/starred/archive/trash |

### Messages

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/v1/messages/send | Send new email |
| POST | /api/v1/messages/reply | Reply to thread |

### Labels

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/v1/labels | List user labels |
| POST | /api/v1/labels | Create custom label |
| PUT | /api/v1/labels/:labelId | Update custom label |
| DELETE | /api/v1/labels/:labelId | Delete custom label |
| POST | /api/v1/labels/:labelId/assign | Assign label to thread |
| POST | /api/v1/labels/:labelId/remove | Remove label from thread |

### Drafts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/v1/drafts | List drafts |
| GET | /api/v1/drafts/:draftId | Get draft |
| POST | /api/v1/drafts | Create draft |
| PUT | /api/v1/drafts/:draftId | Update draft (with version) |
| DELETE | /api/v1/drafts/:draftId | Delete draft |

### Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/v1/search?q=query | Search emails |

### Contacts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/v1/contacts?q=term | Autocomplete contacts |

---

## Key Design Decisions

### 1. Per-User Thread State Table

**Decision**: Separate `thread_user_state` table rather than embedding state in the thread or message table.

**Why it works**: A single email thread can have 5 participants. Alice reads it, Bob has not. Charlie archived it. Each user needs independent flags. A separate table with a UNIQUE(thread_id, user_id) constraint makes this natural -- each row is one user's view of one thread.

**Why the alternative fails**: Embedding read/starred flags in the thread table would force a single state for all users. Using a JSONB column like `user_states: {alice: {read: true}}` would make queries painfully slow at scale -- you cannot efficiently index inside JSONB for "find all unread threads for user X". At 1.8 billion users, scanning JSONB per-row to filter unread threads for a single user would produce full table scans every time the inbox loads.

**Trade-off**: More JOINs on every thread list query (thread + thread_user_state + thread_labels + labels). We accept this because the JOIN is on indexed columns and the query pattern is predictable. The composite index on `(user_id, is_trashed, is_archived)` ensures the filter is fast.

### 2. Elasticsearch with visible_to for Search Privacy

**Decision**: Index each message in Elasticsearch with a `visible_to` keyword array containing all participant user IDs. Every search query includes a `term` filter on `visible_to`.

**Why it works**: BCC recipients see the message in their search results because their user ID is in `visible_to`. But other recipients do not see the BCC recipient because `visible_to` is per-document, not per-query. The indexer includes `[sender, to_recipients, cc_recipients, bcc_recipients]` in `visible_to`, so each participant can find the message.

**Why PostgreSQL full-text search fails**: PostgreSQL `tsvector` search does not natively support "only return results where this user is a participant." You would need to JOIN with message_recipients on every search, which destroys performance at scale. With 300 billion emails per day, a JOIN-based search across a normalized schema would require cross-shard queries that cannot meet the 500ms p99 latency target. Elasticsearch's inverted index with term filtering handles this efficiently because `visible_to` is pre-computed at index time.

**Trade-off**: Requires maintaining a separate search index via a background worker. Search results may lag 5-10 seconds behind newly sent messages. For email, this latency is acceptable -- users do not search for messages they sent seconds ago.

### 3. Optimistic Locking for Drafts

**Decision**: Version column on drafts with conditional UPDATE.

**Why it works**: When Tab A loads draft version 3 and Tab B loads draft version 3, both see the same content. Tab A saves first, incrementing to version 4. Tab B tries to save with `WHERE version = 3`, which matches 0 rows. The API returns 409 Conflict with the current draft state, and the client can show "This draft was modified in another window."

**Why pessimistic locking (SELECT FOR UPDATE) fails**: Drafts auto-save every few seconds. Holding a row lock for the duration of editing would block other tabs indefinitely. With hundreds of millions of users, lock contention on the drafts table would be catastrophic. The database connection pool would exhaust as connections wait on locked rows, eventually cascading into API server unresponsiveness.

**Trade-off**: The client must handle 409 responses gracefully. We implement a simple "last write wins" with user notification rather than complex merge logic. This is acceptable because draft editing is typically a single-user activity -- multi-tab conflicts are the exception, not the rule.

---

## Consistency and Idempotency

Email systems face several consistency challenges because a single send operation touches multiple tables, multiple users' states, and an external search index. Without careful design, failures at any point in this pipeline can result in duplicate emails, missing inbox entries, or orphaned search results.

### Idempotency Keys for Email Sending

Every email send request includes a client-generated idempotency key (a UUID generated when the compose modal opens). The server stores this key in a dedicated idempotency table alongside the resulting message ID. Before processing a send request, the server checks whether the idempotency key already exists. If it does, the server returns the previously created message without re-executing the send flow. This prevents the most damaging user-facing bug in an email system: duplicate sends caused by network retries, double-clicks, or browser refresh during submission.

The idempotency key has a TTL of 24 hours. After that window, the key is purged. This is sufficient because email composition is ephemeral -- users do not retry sends days later. The key is scoped to the sending user, so two different users composing simultaneously never collide.

### Retry Semantics for Failed Deliveries

When the send transaction commits successfully in PostgreSQL, the email is considered delivered within the system. However, several downstream operations can fail independently: cache invalidation for recipients, search index updates, and contact frequency tracking.

For cache invalidation, we use a fire-and-forget pattern. If Redis is temporarily unavailable, the recipient's cached thread list simply expires naturally after its 30-second TTL. No retry is necessary because stale cache entries are self-correcting.

For search indexing, the background indexer worker handles retries implicitly. It polls for messages newer than its last-indexed timestamp. If the indexer crashes or Elasticsearch is temporarily down, the next poll cycle picks up all missed messages. No message is ever skipped because the indexer advances its checkpoint only after successful indexing. If a message fails to index, the checkpoint does not advance and the message is retried on the next cycle.

For contact frequency updates, these are best-effort. A missed frequency increment does not affect correctness -- it only slightly degrades autocomplete ranking. We accept this trade-off rather than adding retry complexity.

### Exactly-Once Processing for Inbox Updates

The send transaction uses a database transaction to ensure that either all recipients receive the message in their inbox or none do. The critical invariant is: if a message row exists, every intended recipient has a corresponding thread_user_state row and INBOX label assignment. Partial failures (message created but some recipients missing) are prevented by the transaction boundary.

For the search indexer, exactly-once semantics are approximated through idempotent upserts. The indexer uses the message ID as the Elasticsearch document ID. If the same message is indexed twice (due to a checkpoint replay after a crash), the second index operation simply overwrites the identical document. This makes the indexer safe to restart at any time without producing duplicate search results.

Draft auto-save achieves consistency through the optimistic locking mechanism described in the Key Design Decisions section. The version column ensures that concurrent saves from multiple tabs never silently overwrite each other. Combined with the idempotency key on draft creation, we prevent duplicate drafts from being created by rapid auto-save retries.

---

## Security and Auth

- **Session-based authentication** with Redis-backed store (express-session + connect-redis)
- **bcrypt password hashing** with salt rounds = 12
- **Rate limiting** on login (5/min), send (50/hr), search (60/min), general (1000/min)
- **CORS** restricted to frontend origin
- **HTTP-only cookies** with SameSite=lax
- **Input validation** on all endpoints (username length, password strength, required fields)
- **SQL injection prevention** via parameterized queries

---

## Observability

### Prometheus Metrics

- `gmail_http_request_duration_seconds` - Request latency histogram
- `gmail_emails_sent_total` - Counter of sent emails
- `gmail_search_queries_total` - Counter of search queries
- `gmail_search_duration_seconds` - Search latency histogram
- `gmail_draft_conflicts_total` - Counter of draft version conflicts
- `gmail_indexed_messages_total` - Counter of messages indexed in ES
- `gmail_circuit_breaker_state` - Circuit breaker state gauge
- `gmail_rate_limit_hits_total` - Rate limit violations

### Structured Logging

Pino JSON logger with request tracing:
- Request ID propagation via `x-trace-id` header
- User context (userId, username) in log entries
- Query timing for slow query detection (>1s triggers warning)
- Cache hit/miss tracking

### Health Checks

- `/api/health` - Simple liveness
- `/api/health/detailed` - PostgreSQL + Redis connectivity with latency
- `/api/health/live` - Process alive check

---

## Failure Handling

### Circuit Breakers (Opossum)

Applied to external service calls (Elasticsearch):
- **Threshold**: 50% failure rate triggers open
- **Reset**: 30-second timeout before half-open test
- **Fallback**: Return empty results for search when ES is down

### Retry Strategy

- Database connections: Automatic reconnect via pg pool
- Redis: Exponential backoff (100ms base, 3s max)
- Search indexer: Continues polling on error, logs and retries

### Graceful Degradation

- If Elasticsearch is down: Search returns empty results, send/receive still works
- If Redis is down: Sessions fail (users need to re-login), cache misses fall through to DB
- If search indexer is behind: Recently sent emails may not appear in search for a few seconds

---

## Scalability Considerations

### Database Scaling Path

1. **Read replicas** for thread list queries (read-heavy workload)
2. **Partitioning** thread_user_state by user_id hash for horizontal sharding
3. **Archive tables** for old messages (move threads older than 2 years)

### Search Scaling

1. **Index sharding** in Elasticsearch by user_id range
2. **Separate hot/warm indices** (recent 30 days vs. older)
3. **Query routing** to specific shards based on user_id

### Caching Strategy

- Thread lists: 30-second TTL, invalidated on send/state change
- Unread counts: 30-second TTL, invalidated on message receive
- Labels: Cached until mutation (long TTL)

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Thread state | Per-user table | JSONB in thread | Queryable indexes, clean schema |
| Search engine | Elasticsearch | PostgreSQL FTS | Privacy filtering, advanced operators |
| Draft conflict | Optimistic locking | Pessimistic locks | No lock contention on auto-save |
| Search indexing | Background worker | Inline on send | No send latency increase |
| Session storage | Redis + cookie | JWT | Immediate revocation, simpler |
| Label assignment | Per-user | Per-thread | Users need independent label views |
| Contact ranking | Frequency counter | ML model | Simple, effective for autocomplete |

---

## Implementation Notes

This section maps the production architecture above to the actual local implementation running on Docker + Node.js + React.

### Local Architecture

```
┌─────────────────────────────────┐
│     Browser (localhost:5173)    │
│  React + TanStack Router +     │
│  Zustand + Tailwind CSS        │
└───────────────┬─────────────────┘
                │ HTTP
                ▼
┌─────────────────────────────────┐
│  Express API (localhost:3001)   │
│  Routes: auth, threads,        │
│  messages, labels, drafts,     │
│  search, contacts              │
│  + /metrics + /api/health      │
└──────┬──────┬──────┬────────────┘
       │      │      │
       ▼      ▼      ▼
┌────────┐ ┌──────┐ ┌────────────────┐
│Postgres│ │Valkey│ │ Elasticsearch  │
│ :5432  │ │:6379 │ │    :9200       │
└────────┘ └──────┘ └───────┬────────┘
                            │
                    ┌───────┴────────┐
                    │ Search Indexer │
                    │   (Worker)     │
                    └────────────────┘
```

### Frontend Architecture

The frontend is a React 19 + TypeScript application built with Vite, using TanStack Router for file-based routing, Zustand for state management, and Tailwind CSS for styling. It replicates Gmail's three-panel layout: a sidebar with labels, a thread list, and a thread detail view.

**Component Hierarchy:**

```
__root.tsx (RootLayout -- auth gate + Gmail shell)
├── Header (search bar, user menu)
├── Sidebar (compose button, label navigation with unread counts)
├── ComposeModal (floating compose window, minimizable)
├── index.tsx (redirects to INBOX)
├── label.$labelName.tsx (ThreadList for selected label)
│   └── ThreadList (virtualized via @tanstack/react-virtual)
│       └── ThreadListItem (subject, sender, snippet, star, timestamp)
├── thread.$threadId.tsx (ThreadView)
│   └── MessageCard (per-message: sender, timestamp, body, reply)
├── login.tsx
└── register.tsx
```

**Zustand Stores:**

Two stores manage the application state:

1. **`useAuthStore`** (persisted to `localStorage` via Zustand `persist` middleware): Holds the current user, authentication status, and loading flag. Provides `login`, `register`, `logout`, and `checkAuth` actions. The `persist` middleware serializes `user` and `isAuthenticated` to `localStorage`, so refreshing the page does not force a re-login. The `checkAuth` action validates the session against the server on mount.

2. **`useMailStore`**: The core mail state. Holds the thread list, current thread detail, labels, unread counts per label, current label filter, current page, compose modal visibility, and loading state. Key patterns:
   - **Optimistic updates**: When the user stars a thread, the store immediately updates the local state (`threads.map(...)`) before sending the API request. If the request fails, the store reverts to the previous state. The same pattern applies to archive and trash operations, where the thread is immediately removed from the list and restored on failure.
   - **Centralized data fetching**: All API calls flow through store actions (`fetchThreads`, `fetchThread`, `fetchLabels`, `fetchUnreadCounts`), keeping data-fetching logic out of components.
   - **Label-driven navigation**: `setCurrentLabel` resets the page to 1 and clears the current thread, then `fetchThreads` loads threads filtered by that label.

**Data Fetching Pattern:**

All API calls are centralized in `services/api.ts`, which exports separate API objects (`authApi`, `threadApi`, `messageApi`, `labelApi`, `draftApi`, `searchApi`, `contactApi`). Each API object wraps a shared `fetchApi` helper that sets `Content-Type: application/json`, includes credentials (`credentials: 'include'` for cookie-based sessions), and handles error responses by parsing the JSON error body. There is no React Query or SWR; data fetching is imperative through Zustand store actions.

**Email Threading UI:**

The `ThreadList` component uses `@tanstack/react-virtual` to virtualize the thread list. Each row is estimated at 40px, with 5 rows of overscan. The virtualizer positions items absolutely within a container whose height equals `virtualizer.getTotalSize()`. Pagination is server-side: the toolbar shows "1-25 of 142" and provides next/previous buttons that call `fetchThreads` with the next page number.

The `ThreadView` component loads a full thread (all messages ordered by `created_at`) and renders each message as a `MessageCard`. Opening a thread automatically marks it as read via `threadApi.updateState`.

**Compose Modal:**

The `ComposeModal` is a floating window (positioned `fixed bottom-0 right-20`) that can be minimized to a title bar. It manages its own local state for recipients (To, CC, BCC), subject, and body. The `ContactAutocomplete` component provides type-ahead contact suggestions by querying `/api/v1/contacts?q=term`. CC and BCC fields are hidden by default and shown via toggle buttons, matching Gmail's behavior.

**Search:**

The `SearchBar` component in the `Header` accepts Gmail-style search operators (`from:`, `to:`, `has:attachment`). Search results are displayed as a thread list. The search API returns results with relevance-ordered threads.

**Routing:**

TanStack Router with file-based routing. Key routes: `/` (redirects to INBOX), `/label/$labelName` (thread list filtered by label), `/thread/$threadId` (thread detail), `/login`, and `/register`. The root layout includes an auth gate: unauthenticated users see only the `Outlet` (login/register pages), while authenticated users see the full Gmail shell (Header + Sidebar + main content + ComposeModal).

### Production-Grade Patterns Implemented

| Pattern | Library | File Path | Purpose |
|---------|---------|-----------|---------|
| Circuit breakers | opossum | `backend/src/services/circuitBreaker.ts` | Protects against Elasticsearch failures; opens after 50% failure rate, returns empty search results as fallback |
| Rate limiting | express-rate-limit + rate-limit-redis | `backend/src/services/rateLimiter.ts` | Distributed rate limiting across API instances using Redis as shared state |
| Prometheus metrics | prom-client | `backend/src/services/metrics.ts` | HTTP duration, email send counts, search latency, draft conflicts, cache hit ratios exposed at `/metrics` |
| Structured logging | pino + pino-http | `backend/src/services/logger.ts` | JSON logs with request ID tracing, user context, query timing |
| Health checks | custom | `backend/src/routes/` | Liveness, readiness, detailed dependency checks |
| Optimistic locking | PostgreSQL version column | `backend/src/services/draftService.ts` | Draft conflict detection via conditional UPDATE with 409 response |
| Background indexing | polling worker | `backend/src/workers/search-indexer.ts` | Polls PostgreSQL for new messages, indexes into Elasticsearch with `visible_to` privacy filter |

### Production Pattern Deep Dives

This section explains each production-grade pattern implemented in the backend as if the reader has never encountered it before.

**Circuit Breaker (`backend/src/services/circuitBreaker.ts`):**

A circuit breaker is a stability pattern that prevents an application from repeatedly calling a failing external service. Imagine Elasticsearch goes down. Without a circuit breaker, every search request waits for a TCP connection timeout (often 30 seconds), consuming a server thread the entire time. With hundreds of concurrent requests, the API server quickly exhausts its thread pool and becomes unresponsive -- even though the rest of the application (sending emails, listing threads) works fine. This is called a "cascading failure."

The circuit breaker tracks the success/failure ratio of recent calls. When the failure rate exceeds a threshold (50% in this project), the breaker "opens" and immediately rejects all subsequent calls without attempting them. After a cooldown period (30 seconds), the breaker enters a "half-open" state where it allows a single test request through. If that request succeeds, the breaker closes and resumes normal operation. If it fails, the breaker reopens for another cooldown cycle.

In this project, the circuit breaker wraps Elasticsearch calls. When it opens, search returns empty results with a `fallback: true` flag so the frontend can display "Search temporarily unavailable." All other email operations (send, receive, label management, drafts) continue working. The breaker state is exposed as a Prometheus gauge (`gmail_circuit_breaker_state`), enabling operations teams to see when and how often Elasticsearch outages occur.

**Redis Cache-Aside (integrated in thread and label services):**

Cache-aside is a caching pattern where the application checks the cache before querying the database. On a cache miss, the application queries the database, stores the result in the cache with a time-to-live (TTL), and returns the data. On a cache hit, the data is returned directly from the cache without touching the database.

In this project, thread lists are cached in Redis with a 30-second TTL. When a user opens their inbox, the API checks Redis first. If the inbox data is cached and fresh, it is returned in under a millisecond. If not, the API executes the thread list query (which involves JOINs across `threads`, `thread_user_state`, `thread_labels`, and `labels`), caches the result, and returns it. Cache entries are invalidated explicitly when the user performs a state change (star, archive, trash) or when a new message arrives.

The 30-second TTL is a trade-off: too short and the cache provides little benefit; too long and users see stale data (e.g., a thread still appearing as unread after being read in another tab). For email, a 30-second staleness window is acceptable because users refresh manually when they expect new mail.

**Structured Logging (`backend/src/services/logger.ts`):**

Structured logging emits log entries as machine-parsable JSON rather than free-form text. Instead of `"User alice sent email to bob, 23ms"`, the logger emits `{"level":"info","event":"email_sent","userId":"abc","recipients":["bob"],"durationMs":23,"traceId":"xyz"}`.

This project uses the Pino library, which is chosen for its speed (Pino serializes JSON faster than most alternatives by avoiding expensive string formatting). Every HTTP request is assigned a trace ID via the `x-trace-id` header. This trace ID is attached to every log entry generated during that request, making it possible to reconstruct the full lifecycle of a request by filtering logs on the trace ID. Pino-http middleware automatically logs request start and completion with method, URL, status code, and duration.

Key events logged: email send (sender, recipient count, thread creation vs. reply), search query (query text, result count, latency, Elasticsearch vs. cache), draft conflict (draft ID, expected version vs. actual version), and rate limit hits (endpoint, client IP). In production, these logs would feed into a centralized system (e.g., Datadog, Elasticsearch/Kibana) for real-time dashboards and alerting.

**Prometheus Metrics (`backend/src/services/metrics.ts`):**

Prometheus is a monitoring system where the application exposes metrics at an HTTP endpoint (`/metrics`), and a Prometheus server periodically scrapes this endpoint to collect time-series data for dashboards and alerting.

Metrics come in four types: **Counters** only go up (e.g., `gmail_emails_sent_total`), **Gauges** go up and down (e.g., `gmail_circuit_breaker_state`), **Histograms** track distributions by bucketing values (e.g., `gmail_http_request_duration_seconds` with buckets at 10ms, 50ms, 100ms, 500ms, 1s, 5s), and **Summaries** compute percentiles client-side. Histograms are preferred over summaries because they can be aggregated across multiple server instances.

This project tracks HTTP request duration and count (labeled by method, route, status code), email send count, search query count and duration, draft version conflicts, messages indexed into Elasticsearch, circuit breaker state, and rate limit violations. These metrics enable SLI-based alerting: for example, "if p95 inbox load latency exceeds 200ms for 5 minutes, page the on-call engineer."

**Rate Limiting (`backend/src/services/rateLimiter.ts`):**

Rate limiting caps the number of requests a client can make within a time window. Without it, a single client could overwhelm the server with requests, degrading service for all users.

This project uses `express-rate-limit` with `rate-limit-redis` as the backing store. Redis is used instead of in-memory storage so that rate limits are shared across multiple API server instances. If the API is scaled to 3 instances behind a load balancer, a user cannot bypass the limit by having requests routed to different instances.

Each endpoint has a different limit based on its cost: login is limited to 5 attempts per minute (brute-force protection), email sending is limited to 50 per hour (prevents spam), search is limited to 60 per minute (prevents scraping), and general API calls are limited to 1000 per minute. When a client exceeds the limit, the server returns HTTP 429 with a `Retry-After` header indicating how many seconds the client should wait.

**Health Checks (`backend/src/routes/`):**

Health checks are HTTP endpoints that report whether the application is functioning correctly. They serve different audiences and purposes:

- **`/api/health`** (simple liveness): Returns HTTP 200 if the process is alive. Used by the orchestrator (Kubernetes) to detect hung processes. If this fails, the container is killed and restarted.
- **`/api/health/detailed`** (dependency check): Connects to PostgreSQL and Redis, measures round-trip latency, and reports the status of each dependency. Used by load balancers to decide whether to route traffic to this instance. If PostgreSQL is unreachable, this returns unhealthy, and the load balancer stops sending requests.
- **`/api/health/live`** (process check): Confirms the process is running. Distinct from the liveness probe in that it checks only the Node.js event loop, not external dependencies.

The distinction between liveness and readiness is important: during a database migration, the process is alive (liveness = healthy) but not ready to serve traffic (readiness = unhealthy). The load balancer should stop routing to it but should not restart it.

### What Was Simplified

| Production Design | Local Substitute | Impact |
|-------------------|------------------|--------|
| Sharded PostgreSQL cluster | Single PostgreSQL 16 instance | All data on one node; no partition-level queries |
| Clustered Elasticsearch | Single ES 8.11 node | No index sharding or hot/warm tiers |
| S3 blob storage for attachments | Schema-only (MinIO omitted) | Attachment metadata stored, files not uploaded |
| OAuth/JWT federation | Session-based auth with bcrypt | Single auth mechanism, no SSO |
| CDN for static assets | Vite dev server | No edge caching |
| Multiple API instances behind LB | Single Express server (can run 3 via npm scripts) | No load balancing by default |

### What Was Omitted

- CDN and edge caching
- Multi-region deployment
- Kubernetes orchestration
- Email spam filtering (ML-based)
- POP3/IMAP protocol support
- Push notifications / WebSocket for real-time new mail
- Calendar and contacts integration
- Attachment storage (MinIO/S3)
- Database sharding and read replicas
