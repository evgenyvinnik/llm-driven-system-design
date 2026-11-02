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
| **Search-indexer worker** | Polls Postgres every 2 s for messages with `indexed_at IS NULL`, builds the `visible_to` set, indexes to ES, marks each message | Keeps send latency low; search lag of a few seconds is acceptable for email. `npm run dev` starts it alongside the API |

**Frontend:** React 19 + TanStack Router + Zustand v5 + `@tanstack/react-virtual` (the thread list is virtualized). Auth is a real Redis-backed session cookie.

## Key Design Decisions

### 1. Per-user thread state in a separate table, not flags on the thread
`thread_user_state` holds `(thread_id, user_id)` rows with `is_read/is_starred/is_archived/is_trashed/is_spam`, and `thread_labels` is keyed `(thread_id, label_id, user_id)`. A thread has no global "read" bit because read/label/archive status is inherently per-recipient. Trade-off given up: reading a thread list now requires joining state per user (more joins, more rows) instead of selecting a single flag — but the flag approach is simply *wrong* for shared conversations, so there's no correctness alternative.

### 2. Visibility is per message, everywhere
A user sees a message only if they sent it or are one of its recipients. One SQL fragment, `visibleMessageSql` in `threadService.ts`, applies that rule to thread detail, the list's per-user summary, unread counts, search re-checks, label assignment and replies. A thread groups messages but grants nothing: a reply can go to fewer people than the message it answers, and a BCC recipient is not on the replies.

Until 2026-11 the rule held only in the search index. Thread detail returned every message to anyone with a state row, list rows showed the thread-wide snippet (the newest message's opening line, whoever it was sent to), and posting a reply into any thread ID created that state row. Any thread ID was therefore a read capability.

Search still filters in ES on a `visible_to` array, so privacy cannot be forgotten by a caller writing an ES query. Hits are then re-checked in SQL, because the index cannot know per-user state such as Trash. The list computes each user's summary over their visible messages with a `LATERAL` subquery. That is correct by construction and needs no backfill, at the cost of work per list query. At scale, the summary belongs in a per-user mailbox row maintained on delivery, which is the production design's projection.

### 3. Optimistic locking on drafts (version column), not last-write-wins
Draft updates run `UPDATE ... WHERE version = $expected`; a zero-row result means someone else saved first and the API returns **409 Conflict**. Gmail-open-in-three-tabs is the normal case, and silent overwrite would lose a half-written email. Trade-off: the client must handle 409 (reload + merge) rather than fire-and-forget — a small UX burden to eliminate lost updates. Pessimistic locks were rejected because a user leaving a draft tab open would hold a lock indefinitely.

### 4. Background worker indexing with a per-message marker, not a checkpoint
Search indexing is done by a separate worker, not synchronously in the send path, so send stays fast and doesn't fail when Elasticsearch is slow or down. The worker selects messages with `indexed_at IS NULL` and sets the marker per message once its document is written. That marker *is* the acknowledgment, stored beside the message.

The previous design kept a "last indexed `created_at`" checkpoint in Redis. Timestamps make a bad cursor:
- **Ties.** More than a batch of messages sharing a timestamp looped forever (the checkpoint lost its microseconds), or rows at the boundary were skipped.
- **Late commits.** A transaction that committed late with an earlier `created_at` was never indexed.
- **Stale index after reset.** Resetting Elasticsearch left the checkpoint in place and old mail unsearchable.

A marker column has none of these, makes the backlog a query (`WHERE indexed_at IS NULL`), and turns "reindex everything" into an `UPDATE`.

The cost is a write per message and no coordination between workers (no lease), so two workers would duplicate effort. At higher volume, the next step is a change feed or outbox with leasing.

### 5. System labels are rows, seeded at registration
INBOX/SENT/TRASH/SPAM/etc. are ordinary `labels` rows with `is_system = true`, created when a user registers; custom labels are the same table with `is_system = false`. One code path handles both. Trade-off: system labels can't have special columns/behavior without branching on `is_system`, but the uniformity keeps label assignment (`thread_labels`) identical for system and custom.

### 6. Cache invalidation by per-user generation, after commit, failing open
Thread lists and unread counts are cached for 30 s under keys that embed `mailbox-gen:<userId>`, and any write bumps it with one `INCR` after commit. The previous code called `DEL threads:<id>:*`. Redis `DEL` takes literal keys, so the pattern deleted nothing, and archive, star or read changes stayed invisible for up to 30 s. The deletes also ran inside the send transaction, so a concurrent read could refill the cache from uncommitted state.

A generation key makes invalidation O(1) with no key scan, and superseded entries simply expire. Every cache helper fails open: Redis down means a cache miss, not a 500 after the mail has committed. The trade-off is a little memory held by dead entries until their TTL ends.

## Current State

**Implemented and working end-to-end:**
- **Accounts:** register/login with Redis-backed sessions (bcryptjs).
- **Privacy:** per-message visibility across thread view, lists, counts and search.
- **Sending:** send/reply with deduplicated recipients, refusal of unknown recipients, refusal of replies into threads the sender is not part of, sanitized HTML, thread creation, and auto-labeling (SENT for sender, INBOX for recipients, un-archiving on new mail).
- **Mailbox state:** per-user read/star/archive/trash/spam, with archive removing a thread from INBOX; system + custom labels with per-label unread counts; immediate cache invalidation.
- **Search:** Elasticsearch with `visible_to` privacy, a SQL re-check for current mailbox state, escaped snippets, Gmail operators, and a visibility-checked SQL fallback flagged `degraded`.
- **Indexing:** the search-indexer worker with per-message markers and `npm run search:reindex`.
- **Other features:** draft CRUD with version-based conflict detection (409); contact auto-creation with frequency-ranked autocomplete; compose with CC/BCC; virtualized thread list; rate limiting, Prometheus metrics, Pino logging. (A circuit-breaker helper exists in `services/circuitBreaker.ts` but nothing calls it.)

Seeded logins: `alice`, `bob`, `charlie` (all `password123`). *Q4 offsite planning* has a reply from Bob to Alice only, which Charlie must not see. In *Interview loop feedback*, Charlie BCCs Alice.

**Intentionally omitted:** attachment file storage (attachment metadata is modeled; MinIO/S3 upload is not wired); OAuth/SSO federation (single session-based mechanism); real SMTP/IMAP delivery to external servers (mail lives entirely inside this system); push/IDLE real-time delivery (list refresh is request-driven).

## Iteration & Repair Log

- **Boilerplate structure replaced (2026-07).** The prior CLAUDE.md tracked progress as "Phase 1–6 (Complete)" checklists. Replaced with an Architecture-at-a-Glance table matching `docker-compose.yml` (Postgres + Valkey + Elasticsearch + worker) and grounded decisions; the good design content (thread state, `visible_to`, optimistic locking, label model, worker indexing) is preserved but reframed as decisions with trade-offs.
- **ESM named-import fixes (repo-wide class, applies here).** This backend uses the modern named imports required by the upgraded deps: `import { RedisStore } from 'connect-redis'` (v8) in `app.ts`, and `pino-http` (v11) as a named import — the shapes that broke default-import code elsewhere in the repo.
- **Schema-apply path is real here.** Unlike some sibling projects, gmail has `db:migrate` (`src/db/migrate.ts` reads and executes `src/db/init.sql`). Setup is `npm run db:migrate` then seed via `psql ... -f db-seed/seed.sql`; the README documents both Docker and native paths.
- **Password normalization.** Demo accounts `alice`/`bob`/`charlie` all use `password123` (bcryptjs), matching the repo-wide login password.

- **2026-11-01: privacy, mailbox correctness, and safe rendering.**

  The project's own stated rule ("membership in one message must not grant access to every message in that thread") held only inside the search index:
  - **Thread view and list.** Thread detail returned every message to anyone with a state row, and list rows showed the thread-wide snippet, count and participants.
  - **Replies.** Any thread ID was accepted, and replying created the sender's state row, after which the whole conversation was readable.
  - **Rendering.** Message HTML from other users was stored and injected raw, and search snippets carried raw markup.
  - **Cache.** `DEL` on a `*` pattern never invalidated anything.
  - **Archive.** It did nothing visible, because INBOX ignored `is_archived`.
  - **Search.** It ignored Trash and Spam, and returned "no results" when Elasticsearch failed.
  - **Indexer.** The timestamp checkpoint could loop, skip, or miss late commits.
  - **Recipients.** Duplicates created duplicate rows, and unknown recipients were dropped silently.

  Fixed as decisions 2, 4 and 6, plus recipient normalization, unknown-recipient refusal, sanitization (sanitize-html on send, DOMPurify on render), the INBOX predicate, un-archive on delivery, reply-all with CC, a store reset on logout, and UUID validation.

  **Verification:**
  - 24 unit tests.
  - 34 live checks across three identities, including the new seed threads for reply-excludes-someone and BCC.
  - An outage run: search falls back to visibility-checked SQL within about 2 s, a send during the outage records its failed index attempt, and the message is indexed after recovery.
  - Ten regenerated screenshots, including the same thread as seen by Alice and by Charlie, and the BCC recipient's view.

  **Two findings came from running it:**
  - **Check-script mistakes.** Unread-count checks failed twice because the script itself had opened the thread (opening marks read).
  - **Search latency during outages.** With the client's default 30 s timeout and three retries, each failing search took about 10 s before the fallback ran. The client now uses a 5 s timeout and one retry.
- **Frontend build (2026-11-01):** `npm run build` failed on a missing `vite-env.d.ts` and a React 19 `useRef()` signature in `ContactAutocomplete`. Both are fixed.

## Open Questions

1. The indexer polls for unmarked messages every 2 s. At what volume does that query (backed by a partial index) need replacing with a logical-replication change feed or a leased outbox, and is per-message `UPDATE ... SET indexed_at` write amplification the first thing to break?
2. `visible_to` is denormalized into the index, but search results are now re-checked in SQL, so stale visibility cannot leak a hit. Should the re-check also become the source of the total count, at the cost of a second query per search, instead of the current page-local estimate?
3. Per-user state rows are created lazily. For a thread with thousands of recipients (mailing-list style), does the `thread_user_state` fan-out need a different shape (e.g., default-state + overrides)?
4. Attachments are metadata-only. What's the smallest correct design (presigned upload to object storage + virus scan + size limits) before "has:attachment" search reflects real files?
5. The per-user thread summary is computed with a `LATERAL` subquery on every list query (decision 2). What is the smallest per-mailbox projection that removes it: a row per (user, thread) carrying last visible time, snippet and count, maintained in the send transaction? And how is it repaired if a delivery partially fails?

## Resources

- [Gmail API design](https://developers.google.com/gmail/api) — thread/label/message model
- [Elasticsearch: filtering for security](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-terms-query.html) — the `visible_to` pattern
- [Optimistic concurrency (MVCC)](https://www.postgresql.org/docs/current/mvcc-intro.html) — the version-column basis for draft conflict detection
