# Gmail (Email Client) — Development with Claude

## Project Context

An email client modeled on Gmail: conversation threads, per-user state (read/starred/archived), system + custom labels, privacy-aware full-text search, and draft conflict detection. The defining problem is that **a thread is shared but every participant sees their own view of it** — one recipient marks it read and labels it "Work" while another leaves it unread in Spam — so almost nothing about a thread is a single global flag.

**Learning goals:** modeling per-user state over shared conversations, enforcing recipient-level privacy in a search index (including hidden BCC), optimistic locking to prevent multi-tab lost updates, and offloading indexing to a background worker.

## Architecture at a Glance (what actually runs)

Three datastores plus one background worker.

| Store / Process | Role | Why this one |
|-----------------|------|--------------|
| **PostgreSQL** (`pg`) | Users, threads, messages, recipients, `thread_user_state`, labels, `thread_labels`, drafts, contacts | Relational source of truth; per-user state and label joins are natural SQL, drafts need transactional version checks |
| **Redis / Valkey** (`ioredis`) | Sessions (via `connect-redis`), caching, rate-limit counters (`rate-limit-redis`) | Server-side session store enabling instant revocation; shared rate-limit state across API instances |
| **Elasticsearch** (`@elastic/elasticsearch` 8) | Message search index with a `visible_to` array + Gmail-style operators | Privacy-filtered full-text with `from:`/`to:`/`has:attachment`/`before:`/`after:` — beyond Postgres FTS |
| **Search-indexer worker** | Polls Postgres every 5s for new messages, builds the `visible_to` set, indexes to ES | Keeps send latency low; search lag of a few seconds is acceptable for email |

**Frontend:** React 19 + TanStack Router + Zustand v5 + `@tanstack/react-virtual` (the thread list is virtualized). Auth is a real Redis-backed session cookie.

## Key Design Decisions

### 1. Per-user thread state in a separate table, not flags on the thread
`thread_user_state` holds `(thread_id, user_id)` rows with `is_read/is_starred/is_archived/is_trashed/is_spam`, and `thread_labels` is keyed `(thread_id, label_id, user_id)`. A thread has no global "read" bit because read/label/archive status is inherently per-recipient. Trade-off given up: reading a thread list now requires joining state per user (more joins, more rows) instead of selecting a single flag — but the flag approach is simply *wrong* for shared conversations, so there's no correctness alternative.

### 2. Privacy enforced in the index via `visible_to`, not just at query time
Every indexed message carries a `visible_to` array of the sender plus all recipient user IDs; the worker computes it, and every search query filters on it. This makes a BCC recipient invisible to other recipients even though they're on the same message. Trade-off: `visible_to` must be recomputed if participants change, and the index is only as private as that field — but pushing the filter into ES means privacy can't be forgotten by a caller writing a query.

### 3. Optimistic locking on drafts (version column), not last-write-wins
Draft updates run `UPDATE ... WHERE version = $expected`; a zero-row result means someone else saved first and the API returns **409 Conflict**. Gmail-open-in-three-tabs is the normal case, and silent overwrite would lose a half-written email. Trade-off: the client must handle 409 (reload + merge) rather than fire-and-forget — a small UX burden to eliminate lost updates. Pessimistic locks were rejected because a user leaving a draft tab open would hold a lock indefinitely.

### 4. Background worker indexing, not inline-on-send
Search indexing is done by a separate worker polling Postgres every 5s, not synchronously in the send path. Send stays fast and doesn't fail if Elasticsearch is slow or down; the message is durably in Postgres regardless. Trade-off: search results lag reality by up to a poll interval — fine for email, where "sent 3 seconds ago" not being searchable yet is unnoticeable. A production system would replace polling with a change feed / queue for lower lag.

### 5. System labels are rows, seeded at registration
INBOX/SENT/TRASH/SPAM/etc. are ordinary `labels` rows with `is_system = true`, created when a user registers; custom labels are the same table with `is_system = false`. One code path handles both. Trade-off: system labels can't have special columns/behavior without branching on `is_system`, but the uniformity keeps label assignment (`thread_labels`) identical for system and custom.

## Current State

**Implemented and working end-to-end:** register/login with Redis-backed sessions (bcryptjs); send/reply with thread creation and auto-labeling (SENT for sender, INBOX for recipients); per-user read/star/archive/trash/spam with optimistic UI updates; system + custom labels with per-label unread counts; Elasticsearch search with `visible_to` privacy and Gmail operators; the search-indexer worker; draft CRUD with version-based conflict detection (409); contact auto-creation with frequency-ranked autocomplete; compose with CC/BCC; virtualized thread list; rate limiting, circuit breaker, Prometheus metrics, Pino logging.

**Intentionally omitted:** attachment file storage (attachment metadata is modeled; MinIO/S3 upload is not wired); OAuth/SSO federation (single session-based mechanism); real SMTP/IMAP delivery to external servers (mail lives entirely inside this system); push/IDLE real-time delivery (list refresh is request-driven).

## Iteration & Repair Log

- **Boilerplate structure replaced (2026-07).** The prior CLAUDE.md tracked progress as "Phase 1–6 (Complete)" checklists. Replaced with an Architecture-at-a-Glance table matching `docker-compose.yml` (Postgres + Valkey + Elasticsearch + worker) and grounded decisions; the good design content (thread state, `visible_to`, optimistic locking, label model, worker indexing) is preserved but reframed as decisions with trade-offs.
- **ESM named-import fixes (repo-wide class, applies here).** This backend uses the modern named imports required by the upgraded deps: `import { RedisStore } from 'connect-redis'` (v8) in `app.ts`, and `pino-http` (v11) as a named import — the shapes that broke default-import code elsewhere in the repo.
- **Schema-apply path is real here.** Unlike some sibling projects, gmail has `db:migrate` (`src/db/migrate.ts` reads and executes `src/db/init.sql`). Setup is `npm run db:migrate` then seed via `psql ... -f db-seed/seed.sql`; the README documents both Docker and native paths.
- **Password normalization.** Demo accounts `alice`/`bob`/`charlie` all use `password123` (bcryptjs), matching the repo-wide login password.

## Open Questions

1. The indexer polls every 5s. At what message volume does polling become wasteful/laggy enough to justify a Postgres logical-replication change feed or an outbox+queue into ES?
2. `visible_to` is denormalized into the index. When participants or visibility change (e.g., a thread is shared), what's the reindex trigger, and how do we avoid a window where stale visibility leaks a message?
3. Per-user state rows are created lazily. For a thread with thousands of recipients (mailing-list style), does the `thread_user_state` fan-out need a different shape (e.g., default-state + overrides)?
4. Attachments are metadata-only. What's the smallest correct design (presigned upload to object storage + virus scan + size limits) before "has:attachment" search reflects real files?

## Resources

- [Gmail API design](https://developers.google.com/gmail/api) — thread/label/message model
- [Elasticsearch: filtering for security](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-terms-query.html) — the `visible_to` pattern
- [Optimistic concurrency (MVCC)](https://www.postgresql.org/docs/current/mvcc-intro.html) — the version-column basis for draft conflict detection
