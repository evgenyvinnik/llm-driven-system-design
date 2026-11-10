# Document Q&A — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Requirements → Architecture → Data and API → Upload and pipeline → Versions, deletion, cache → Client → Deep dives → The key question → Traces → Scale*

> "Users upload documents and ask questions about them. The answer streams back with numbered citations, and each citation opens the exact passage it came from. The retrieval-augmented part is easy to sketch: extract, chunk, embed, index, search, prompt. What makes it hard is that almost everything on that path is a copy. The vector index holds a copy of each chunk's access scope. Valkey holds answers built from earlier sharing state. A session holds an old list of the user's groups, and the browser holds whatever it fetched last. Documents get unshared, re-versioned and deleted while all of those copies still exist. So my organizing rule is that PostgreSQL decides who can read what, every copy is allowed to lag, and nothing a copy returns is used until it has been checked against PostgreSQL. The other half of the problem is a pipeline that crashes between steps and calls a rate-limited embedder, so every stage has to be safe to redo."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements and scale | ~5 min | Access correctness is the top requirement; ANN memory and the embedder's rate limit are the cost centres |
| Architecture, data, API | ~6 min | PostgreSQL decides, everything else remembers; jobs are rows, tickets are pointers |
| Upload, pipeline, versions, delete, cache, client | ~10 min | Idempotent upload, redoable stages, a one-pointer switch, tombstone first, validation on read |
| Deep dives | ~14 min | Access enforced twice; the redoable pipeline; one answer from row to pixel |
| Key question, traces, checklist, scale, wrap-up | ~10 min | Why content that outlives access is never returned; one success, one failure; what breaks first |

---

## 🎯 Requirements (~5 min)

**Clarifying questions (and the answers I'll assume)**

| Question | Assumption |
|----------|------------|
| Formats and sizes? | `.txt`, `.md` and `.html` (markup stripped) up to 5 MB locally; PDF and OCR are out of scope for this build |
| Sharing model? | Each document is private, shared with one group, or org-wide. Org admins manage groups |
| How fast must a revoke apply? | On the very next question, not "within a few minutes" |
| Multi-tenant? | Yes. No cross-tenant reads and no existence leaks, including through duplicate detection |
| Conversation memory? | Single questions. Each is a durable run the client can reconnect to and stop |
| Models? | A hosted embedding provider and an LLM behind a gateway; deterministic mock services locally |

**Functional**

1. Upload with an `Idempotency-Key`. A retried upload returns the first response, and identical bytes in the same tenant return the existing document if the uploader can read it.
2. Process each version through extract → chunk → embed → index, with per-stage status, progress and attempts. A stage that keeps failing marks the document `failed` with a reason and a Retry action.
3. Chunk with character offsets and the enclosing heading, so a citation highlights the exact span.
4. Ask a question and get a streamed answer with numbered citations, or "not found in your documents". Each question is a run (`queued → running → completed | cancelled | failed`) that records usage.
5. Share as private, group or org. A revoke takes effect on the next question.
6. Upload a new version. It is processed fully, switched atomically, and the old version's chunks are retired afterwards.
7. Delete. The document disappears at once, then a purge removes blobs, chunks, embeddings, index rows and cached answers, and records when it finished.
8. Operate: queue depth, jobs by stage, poisoned jobs with retry, purge backlog, stale index rows, fault switches.

**Non-functional**

| Property | Target |
|----------|--------|
| Access correctness | Zero chunks of a document the user can't read *right now* in any prompt, answer, citation or cached answer |
| Revocation latency | Effective on the next question (< 1 s after commit) |
| Delete | Invisible everywhere at commit; physically purged within 24 h (seconds when healthy) |
| Answer latency | Time to first token p50 < 1.5 s, p99 < 4 s; retrieval p99 < 150 ms |
| Ingestion | Upload to ready p50 < 30 s for a 20-page document; backlogs drain without loss |
| Availability | 99.9% for Q&A, 99.95% for upload acceptance |
| Tenant isolation | No cross-tenant reads, timing or existence leaks |

**Scale (assumptions)**

| Quantity | Estimate | Consequence |
|----------|----------|-------------|
| Tenants and users | 10,000 orgs, 2M users | Every query is tenant-scoped |
| Documents | 50M live; 2M uploads/day ≈ 23/s, 150/s peak | A steady background pipeline |
| Chunks | ~25 per document (512 tokens, 64 overlap) → 1.25B | The index is huge |
| Vectors | 1024 dims × 4 B → 5 TB, ~8 TB with the HNSW graph | The index must be sharded |
| Embedding | ≈ 580 chunks/s, 4,000/s peak, 10× on re-index days | The provider's rate limit governs ingestion |
| Questions | 10M/day ≈ 115/s, 600/s peak | Each: one query embedding, one filtered ANN search, one batched re-check, one 3-8 s LLM stream |
| Open answer streams | ≈ 3,000 SSE connections at peak | Sized for the gateway and model slots |

> "The numbers say storage and ANN memory are the big costs, the embedding provider's rate limit caps ingestion, and the LLM dominates answer latency. The access re-check I'm about to insist on is 600 batched primary-key lookups a second at peak, which is tiny next to the ANN work. That's why I can afford to run it on every single question."

---

## 🏗️ End-to-End Architecture (~3 min)

```
 ┌───────────────────────────── Browser (React SPA) ─────────────────────────────┐
 │ Library · Document page (cited span highlighted) · Ask (chat) · Ops           │
 └────────┬──────────────────────────────────────────────┬───────────────────────┘
          │ REST, polled every 2-5 s                     │ POST /answers → 202; SSE + Last-Event-ID
          ▼                                              ▼
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │ API instances (stateless): upload + dedupe · sharing · tombstones ·           │
 │ answer runs (executed by the accepting instance) · history redacted on read   │
 └───┬───────────────┬─────────────────────────┬──────────────────────┬──────────┘
     │ blob PUT      │ one txn per write,      │ cache, run streams,  │ embed question,
     ▼               ▼ re-check reads here     ▼ cancel channel       ▼ stream answer
 ┌──────────┐ ┌───────────────────────┐ ┌──────────────────┐ ┌──────────────────┐
 │ Object   │ │ PostgreSQL            │ │ Valkey           │ │ Embedder · LLM   │
 │ store:   │ │ SOURCE OF TRUTH:      │ │ answer cache     │ │ gateway (mock    │
 │ one key  │ │ documents, versions,  │ │ (validated on    │ │ services locally)│
 │ per      │ │ ACL, chunks, jobs,    │ │ read) · per-run  │ │                  │
 │ version  │ │ runs, purge tasks     │ │ event streams    │ │                  │
 └────▲─────┘ └───┬─────────────▲─────┘ └──────────────────┘ └────────▲─────────┘
      │           │ tickets     │ claim with a lease ·                │
      │           ▼ {jobId}     │ keyed upserts · stage               │
      │   ┌────────────────┐    │ writes + completion +               │
      │   │ RabbitMQ       │    │ next job in one txn                 │
      │   │ quorum queue   │    │                                     │
      │   └───────┬────────┘    │                                     │
      │           ▼             │                                     │ batched,
      │   ┌─────────────────────┴───────────────────────┐             │ 429s retried
      └───│ Pipeline workers: extract → chunk → embed → │─────────────┘
          │ index · retire · sync_acl · purge · sweeper │
          └──────────────────────┬──────────────────────┘
                                 ▼ entries carry tenant, version, scope copy
                ┌───────────────────────────────────────────────────┐
                │ Vector index (pgvector HNSW; a sharded engine     │
                │ at scale): a COPY of access metadata, used        │
                │ only to pre-filter                                │
                └───────────────────────────────────────────────────┘
```

> "Two rules shape every arrow. First, PostgreSQL decides and everything else remembers. The queue holds pointers to job rows, the index holds a lazily synced copy of access metadata, and Valkey holds answers that must pass validation before they're served. Losing any of them delays work or costs a recomputation; it never changes who can read what. Second, every stage is keyed and redoable: jobs are unique per version and stage, chunks per version and ordinal, embeddings and index entries per chunk id. A redo rewrites the same rows."

---

## 💾 Data Model (~2 min)

| Table | Key columns | Indexes | Notes |
|-------|-------------|---------|-------|
| documents | id, org_id, owner_id, title, scope, group_id, status, current_version_id, current/latest version numbers, content_hash, acl_epoch, deleted_at, purge_completed_at | (org_id, updated_at) where live | `current_version_id` is the one pointer the switch moves; `acl_epoch` bumps on every sharing change and on delete; `deleted_at` is the tombstone |
| document_versions | document_id, version_no, content_hash, blob_key, status, chunk_count | unique (document_id, version_no); (org_id, content_hash) for dedupe | uploaded → processing → ready, or failed, superseded, retired, cancelled |
| version_texts | version_id, text, headings | primary key | The extracted text every chunk offset points into |
| chunks | id = `chk_<version>_<ordinal>`, version_id, ordinal, text, char_start, char_end, heading | unique (version_id, ordinal); GIN on the full-text vector | The id is derived, never random, so a redo upserts the same rows |
| chunk_embeddings | chunk_id, model, embedding | primary key | The expensive artifact, kept apart from the index |
| index_entries | chunk_id, org_id, document_id, version_id, owner_id, scope, group_id, acl_epoch, embedding | HNSW on embedding; (org_id, scope); document_id; version_id | The retrieval index: a **copy** of access metadata |
| processing_jobs | job_key = `<version>:<stage>`, status, attempts, max_attempts, lease owner/token/expiry, next_run_at, dispatched_at, generation, progress | unique job_key; partial on next_run_at (pending), on lease expiry (running) | Unit of work and outbox in one row |
| job_attempts | job_id, worker, outcome (succeeded, retry, failed, poisoned, lost, superseded), error, detail | (job_id, attempt_no) | The processing timeline on the document page |
| purge_tasks | (document_id, artifact), status, removed, attempts, last_error | primary key | One row per artifact: cache, index, embeddings, chunks, blobs |
| upload_requests | (user_id, idempotency_key), request_hash, status, response | primary key | Replays the first response |
| answer_runs | id, user_id, question, status, output_text, sources, citations, retrieval, cache, heartbeat_at, cancel_requested_at, tokens and latency split | (user_id, created_at); partial on heartbeat_at while queued or running | The durable record of every question |

Groups and memberships are plain rows (`groups`, `group_members`). Valkey holds the answer cache, a per-document set of cache keys for the purge, the per-run event streams, a cancel channel and sessions.

---

## 🔌 API (~1 min)

```
POST   /api/v1/documents                 multipart + Idempotency-Key → 201 | 200 duplicate | 415 | 422 | 503
POST   /api/v1/documents/:id/versions    new version (owner) → 201 | 200 unchanged
GET    /api/v1/documents                 library: readable live documents with per-stage state
GET    /api/v1/documents/deleted         my deleted documents with purge progress
GET    /api/v1/documents/:id             detail: versions, jobs with attempt logs, events
GET    /api/v1/documents/:id/text        extracted text of a version (citation highlight view)
GET    /api/v1/documents/:id/chunks      chunks with offsets, embedded/indexed flags
PATCH  /api/v1/documents/:id/sharing     scope + group (owner)
DELETE /api/v1/documents/:id             tombstone + purge (owner) → 202
POST   /api/v1/documents/:id/retry       retry a poisoned stage (owner)
POST   /api/v1/groups/:id/members        add a member (org admin); DELETE removes one
POST   /api/v1/answers                   question → 202 with the run's server-assigned id
GET    /api/v1/answers · /answers/:id    history, re-validated and redacted on read
GET    /api/v1/answers/:id/stream        SSE: status, cache, retrieval, delta, terminal event; Last-Event-ID resumes
POST   /api/v1/answers/:id/cancel        Stop, from any instance → 202
GET    /api/v1/ops/overview              operator: queue, jobs matrix, poisoned, purge backlog, stale index rows
```

Another tenant's document is a 404, never a 403, so its existence isn't confirmed.

---

## 📥 Upload: Idempotency and Visibility-Scoped Dedupe (~2 min)

An upload is one PostgreSQL transaction:

1. **Idempotency.** An advisory lock on (user, key), then a lookup in `upload_requests`. A stored response is replayed with `Idempotent-Replayed: true`. The same key with different bytes returns `422 IDEMPOTENCY_KEY_REUSED`. Concurrent retries serialize on the lock: the e2e fires one key at both API instances at once and gets one document.
2. **Dedupe.** An advisory lock on (org, SHA-256 of the bytes), then: is there a live document in this org whose current (or only) version has this hash **and which the uploader can read**? If so, return it as `200 duplicate` and create nothing. A new version identical to the latest returns `200 unchanged`.
3. **Store and record.** PUT the blob under a per-version key, insert the document, version, `extract` job and idempotency record, commit, then publish the job's ticket. If MinIO is down the transaction rolls back with `503`, and a retry with the same key is safe.

| Dedupe scope | Pros | Cons |
|--------------|------|------|
| ✅ Per tenant, only documents the uploader can read | Never reveals that a hidden document exists | The same bytes may be embedded twice in one org |
| ❌ Per tenant, regardless of access | Maximum savings | "Duplicate exists" tells an intern that a private salary file with these exact bytes is there |
| ❌ Global, across tenants | Even more savings | A cross-tenant existence oracle |

> "Unsupported types are a `415` at upload. Corrupt content, like invalid UTF-8 or HTML that's empty after stripping, is accepted and then fails in the extract stage with the reason, so it shows up in the library as a failed document with an explanation instead of a mysterious error. On the client, each file gets its Idempotency-Key when it's picked, and Retry upload resends with the same key."

---

## ⚙️ The Pipeline at a Glance (~2 min)

| Stage | Writes (idempotent key) | Redo behavior |
|-------|-------------------------|---------------|
| extract | version text (version) | Same bytes give the same text, upserted |
| chunk | chunks (version, ordinal) | Upserts in batches of 4, then deletes ordinals past the end |
| embed | embeddings (chunk id) | Embeds only chunks still missing one: a crash after 3 of 5 batches costs 2 on the redo |
| index | index entries (chunk id), then the version switch | Upsert; the switch is decided under a row lock |
| retire | deletes a superseded version's index rows, embeddings, chunks | Deleting nothing is fine; never touches the current version |
| sync_acl | index metadata where its epoch is behind | Writes only stale rows |
| purge | each pending artifact | Skips artifacts already done |

Jobs are leased rows and tickets are pointers; deep dive 2 covers why that survives crashes. Embedding is split from indexing on purpose: the embedding store is the expensive artifact, and the index can be rebuilt from it with new metadata or a new index type without paying the provider again.

**Chunk offsets feed the citation highlight.** The chunker splits the extracted text into sentences ("3.5 days" stays whole), accumulates them to about 120 tokens locally (512 in production), and restarts the next chunk on whole sentences covering about 24 tokens of the previous tail (64 in production), so a claim that straddles a boundary is whole in at least one chunk. A heading starts a new chunk, and every chunk records its heading. The invariant, unit-tested and checked live, is that slicing the version's extracted text from `char_start` to `char_end` gives exactly the chunk text. When the model's stream ends, each `[n]` marker becomes a citation: the claim before the marker is located verbatim inside source n's chunk, so the citation points at that exact span, falling back to the whole chunk. The link carries the document, the version and both offsets, and the document page highlights that range and scrolls to it.

---

## 🔀 New Versions: Never Mixed (~1 min)

1. A new version gets its own blob key and an `extract` job. The document keeps serving its current version.
2. The index stage upserts the new version's entries, so **both versions sit in the index** for a while.
3. In the transaction that completes the index job, the document row is locked and the switch is decided: activate if the document is live and nothing newer is current; mark the version stale if a newer one won the race; cancel if the document was deleted.
4. Activation is one row update to `current_version_id`. The old version becomes `superseded`, and a `retire` job runs 5 s later so answers already reading the old chunks can finish.

> "During the overlap the re-check drops the new version's chunks as `not_current_version`, and after the switch it drops the old version's. Because the ANN query and the re-check run in one `REPEATABLE READ` snapshot, each document's pointer is read once per question, so every chunk of a document in a prompt comes from the same version. The e2e holds the switch open for 8 s and keeps asking: seven answers came from v1, then three from v2, and no answer mixed them. Updating chunks in place would have created a window where a question sees half a document, or none of it."

---

## 🗑️ Delete: Tombstone First, Then a Tracked Purge (~2 min)

`DELETE` is one transaction: set `deleted_at` and bump `acl_epoch`, cancel the document's pending pipeline jobs, insert one `purge_tasks` row per artifact (cache, index, embeddings, chunks, blobs) and enqueue a purge job. **The tombstone is the delete.** The library, document pages, the retrieval re-check, cache validation and history redaction all filter on it, so the document is gone from every read path at commit.

The purge job then:

- defers, without spending an attempt, while any pipeline stage for the document still holds a live lease, so nothing gets written back after its artifact is removed. A running stage notices the tombstone at its next check and cancels itself;
- removes each pending artifact in order and marks it done with a count. Cached answers are found through the document's reverse-index set in Valkey, never a pattern delete, and persisted answer runs whose prompt included the document are scrubbed;
- verifies nothing came back. If a racing stage wrote something, that artifact is marked pending again and the job retries;
- sets `purge_completed_at`.

A failure records the error on that one artifact and retries with capped backoff, indefinitely; finished artifacts are never redone. The library shows "purged 4/5 · blobs: connection refused" with one chip per artifact, then the completion time. The e2e stops the MinIO container mid-purge: four artifacts finish, blobs fail and retry, and when MinIO returns the blobs are deleted and the purge completes. Deleting synchronously across five stores would make `DELETE` fail whenever any one of them was down and leave partial copies with no record.

---

## 🗃️ The Answer Cache: Validated on Read (~1 min)

The key is org + user + a hash of the normalized question; the user is in the key because retrieval depends on what the user can read. Each entry stores the answer, sources, citations and a **context list**: every document whose chunks were in the prompt, not just the cited ones, because a model can repeat uncited context. Each context document is stored with the version and `acl_epoch` the answer was built from. On every read, one query checks each context document for this reader, now:

| Check | Rejects when |
|-------|--------------|
| Tombstone | The document was deleted, even if the purge hasn't removed the entry yet |
| Live access | The reader can no longer read it: unshared, removed from the group, account disabled |
| Version | A newer version is current |
| Access epoch | Sharing on the document changed since the entry was built (conservative) |

A rejected entry is deleted, the question is answered fresh, and the run records `cache: rejected` with the reason, which the chat shows as an amber badge. Entries expire after 10 minutes, but correctness never depends on the TTL or on invalidation arriving. Answers with no sources aren't cached, because they would go stale silently when a relevant document is uploaded.

---

## 🖥️ The Client (~2 min)

| Page | Shows | Actions |
|------|-------|---------|
| Library | Readable documents with scope, status and per-stage pills (extract → chunk → embed → index) with progress and "attempt 2/3"; a failed document's reason; a Recently deleted panel with "purged 4/5" | Drag-and-drop upload, Retry upload, Retry a failed document |
| Document page | Extracted text of the viewed version with the cited span highlighted; the chunk table with offsets; versions; the processing timeline with every attempt, worker and outcome | Owner: share, new version, delete |
| Ask | Questions and answers as a chat; status, cache badge, retrieval trace (candidates, kept, and "2 dropped by access re-check: private to its owner ×2 (index said readable: 2)"), citations, sources, usage | Ask, Stop |
| Ops (operator) | Queue depth, jobs by stage and status, poisoned jobs, purge backlog, stale index rows, fault switches | Retry a job, arm faults |

**Structure.** TanStack Router file routes; Zustand holds the session and the ask store; every other page uses a small polling hook that refetches every 2-5 s while the tab is visible, through the same access-scoped endpoints as the first load.

**Streaming only while generating.** The ask store opens a stream only for runs that are `queued` or `running`, including ones found when the page loads, so a refresh mid-answer picks the stream back up. Finished runs are plain REST data. When a stream starts it clears the run's text, because the replay begins at the first event and rebuilds it. When a terminal event arrives, the store re-reads history to pick up final usage and citations.

**The client never trusts its own cache after access changes.** There is no long-lived client cache to invalidate. Every poll is a fresh read under the live access rule, so an unshared document drops out of the library on the next poll. If the document page gets a 404 while open, it stops showing the copy it holds and says the document may have been deleted or is no longer shared. After every run the chat re-reads history, and an answer whose prompt included a document the reader has lost renders as a lock line instead of the text the store still holds. Sign-out drops history and closes every stream.

---

## 🔧 Deep Dives (~14 min)

### Deep dive 1: Access enforced twice (pre-filter inside the search, re-check in the same snapshot)

**Decision.** Both search arms, HNSW vectors and PostgreSQL full-text, put tenant and scope in the index query's WHERE clause, using the index rows' copy of scope and group plus the session's group claims. pgvector's iterative scan keeps the graph walk going until enough rows pass the filter. The two lists are fused by reciprocal rank, and 24 candidates are over-fetched for 5 context slots. Then, in the same `REPEATABLE READ` snapshot, one batched query loads each candidate's chunk, document and version, plus the asker's live account and group memberships. A candidate survives only if its chunk still exists, its document is live and in the asker's org, its version is the current one, the asker can read it now, and the asker's account is active. Every drop records a reason and whether the index row was stale.

**Why it works here.** Two copies lag, by design. A sharing change commits the new scope, bumps `acl_epoch` and re-arms a `sync_acl` job that rewrites the index rows about 3 s later. Session group claims refresh every 5 minutes. Removing someone from a group deletes one `group_members` row and changes nothing in the index, because index rows carry a group id, not member lists. A stale copy can only err two ways. Too narrow, a new share not yet synced, costs recall for a few seconds. Too wide, a revoke not yet synced or a removal not yet in the claims, would leak, and the re-check closes exactly that gap because it reads the truth. The e2e proves it with the sync paused: after Alice unshares, the index still says `scope = group`, Carol's next question retrieves those rows, and the re-check drops them as `not_owner` with `staleIndex: true`. After Alice removes Carol from Engineering, Carol's claims still list it, and her next question drops the group document as `not_in_group`.

**How the alternatives break.**

- **Post-filtering a global top-k.** With 10,000 tenants, the 24 nearest chunks to "what is our retention period?" are almost all other tenants' retention policies. After filtering, the answer is starved or empty, even though relevant readable chunks exist at rank 400. Raising k makes every query pay for every tenant's data, and latency then depends on other tenants' content. A selective filter starves the HNSW walk the same way, which is why the iterative scan exists; at scale, per-tenant partitions make the filter physical.
- **Making the index the authority.** Updating every index row inside the sharing transaction couples a user-facing write to the slowest store, maybe another vendor, and turns "unshare" into a distributed transaction. It still leaves gaps: an index replica that applied the change late, a cache entry written by a run that started before the revoke, an hour-old session claim.
- **Pre-filter only.** Every lag in the copy becomes a leak.

**What I give up.** A second query per question, a few milliseconds for at most 24 primary keys. Grants show up only once the lazy sync widens the index, seconds later, which is the safe direction to be stale in. Every content-serving path (retrieval, cache, history, document pages) must go through the same check. At scale, the re-check must read the primary, or a replica proven to be past the latest access change, or a lagging replica reopens the revoke window.

| Approach | Revoke takes effect | Recall | Leak if a copy lags |
|----------|---------------------|--------|---------------------|
| ✅ Pre-filter in the query + same-snapshot re-check | Next question | Full; over-fetch absorbs drops | No |
| ❌ Post-filter a global top-k | Next question | Starved or empty | No, but slow and unfair |
| ❌ Index as the authority, synced in the write | When every copy is updated | Full | Yes, through any missed copy |

### Deep dive 2: The redoable pipeline (leases, derived ids, keyed upserts)

**Decision.** A `processing_jobs` row per (version, stage) is both the unit of work and the outbox. RabbitMQ carries only `{jobId}` on a quorum queue. A worker claims with a conditional update: a pending job that is due, or a running job whose lease expired or whose ticket was redelivered, which RabbitMQ only does after the holder's channel closed. The previous holder's attempt is marked `lost`. The worker heartbeats its lease every third of its length. It commits the stage's final writes, its completion fenced on the lease token, and the next stage's job (insert-if-absent on `job_key`) in one transaction, then publishes. Every write is an upsert on a natural key.

**Why it works here.** Exactly-once across a queue, a worker and a database isn't available; at-least-once delivery plus idempotent writes is. Every failure turns into "redo it" or "a stale ticket":

| Failure | What's left | How it resolves |
|---------|-------------|-----------------|
| API dies between commit and publish | Job row never dispatched | The sweeper publishes it |
| Worker killed mid-chunk | Unacked ticket, half the chunks | Redelivered; takeover; the same rows are rewritten |
| Worker dies after commit, before ack | A redelivered ticket | Finds nothing to claim |
| Worker freezes | An expiring lease | The sweeper reclaims it; a late write is fenced by the token |
| Embedder 429 or 503 | "Slow down" | Retried inside the attempt, honoring Retry-After, lease heartbeated |
| Embedder 500 or down | A failed attempt | Backoff 1 s, 2 s, 4 s… capped at 15 s locally; poisoned after 3 |
| Corrupt file | A permanent error | Poisoned at once, with the reason |
| A file that crashes the worker every time | A crash loop | Attempts count per claim, so it's poisoned |

The kill-mid-chunk fault switch proves the core claim with a real `process.exit(1)` after 12 of 17 chunks, without acking. RabbitMQ redelivers to the other worker, which takes over the lease, records attempt 1 as `lost` with `chunksWrittenBeforeExit: 12`, and writes all 17. Afterwards the count equals the distinct-ordinal count, 17, with one embedding each. Three armed 429s were absorbed inside one embed attempt, recorded as `rateLimitedRetries: 3`. Poisoning marks the version, and the document if nothing is being served yet, `failed` with "embed failed after 3 attempts: Embedder returned 500…"; Retry resets attempts and republishes.

**How the alternatives break.** Random chunk ids with "delete this version's chunks, then insert" is also idempotent, but every retry becomes a full rewrite and orphans embeddings keyed by the old ids, so the provider bills again for work already done. Retries parked in broker delay queues can't be cancelled when the document is deleted, can't be shown on the timeline, and run on another clock. Treating a 429 as a failed attempt would poison a healthy document during a provider's busy minute.

**What I give up.** Bookkeeping writes. I measured 6.6 PostgreSQL row writes per chunk: 86 for a 13-chunk document, about 47 of them fixed job, attempt, progress and state writes. Also a sweeper in every worker, and the rule that every new stage must be written to be redoable.

### Deep dive 3: One answer from row to pixel (durable runs, Valkey streams, resume)

**Decision.** `POST /answers` inserts a `queued` run and returns 202 with its server-assigned id. The instance that accepted it executes it: cache lookup, retrieval and re-check, prompt, model stream, citations. Every step appends an event to a per-run Valkey stream. `GET /answers/:id/stream` replays that stream from `Last-Event-ID` on any instance. The browser reads it with `fetch` and a `ReadableStream`, reconnecting with the last id it saw.

**Why it works here.** It separates who runs an answer from who streams it, so a reconnect, even to the other instance, resumes without gaps or repeats (verified). The run row is the durable record. A heartbeat every second flushes the partial output and checks for a cancel request. **Stop** sets `cancel_requested_at` and publishes on a cancel channel every instance hears; the executor aborts the model request and the run ends `cancelled` with its partial text. A **mid-stream model failure**, where the socket closes before the end of the message, ends the run `failed` with the partial text kept and usage recorded. If the **executing instance dies**, the sweeper fails the run once its heartbeat is 15 s stale, and the partial text flushed so far survives. **Usage** is on every run: input and output tokens, plus queue, retrieval, time-to-first-token and generation latency. On screen, "partial output kept" appears beside the failed or stopped status, and the usage line appears once the run ends.

**How the alternatives break.** Streaming straight from the executor's memory loses the answer on a refresh or a reconnect that lands elsewhere, unless sticky routing is added, and that breaks on every deploy. `EventSource` can't send custom headers, while fetch carries cookies and `Last-Event-ID` explicitly. A WebSocket buys nothing, because the only thing the client sends mid-run is Stop, which is a POST any instance can take. A separate answer-worker fleet behind a queue adds a hop to every question for little gain at this scale; at much larger scale a dedicated LLM gateway with slot accounting takes over execution and the stream contract stays. Automatic retries would bill twice and could produce a different answer, so the user re-asks.

**What I give up.** Valkey sits on the streaming path, and it holds sessions too: if it's down, nobody is signed in and the cache and streams are unavailable, though no document, job or run state is lost. Each open stream holds one blocking Valkey reader. Questions carry no idempotency key, so a lost 202 means a second run; questions are cheap and read-only, and I accept that.

| Approach | Refresh or reconnect mid-answer | Instance dies | Stop |
|----------|---------------------------------|---------------|------|
| ✅ Run row + Valkey stream + Last-Event-ID | Replays from any instance | `failed` with partial text after 15 s | Cancel channel reaches the executor |
| ❌ SSE from the executor's memory | Answer lost without sticky routing | Lost, run stuck | Must reach the right process |
| ❌ Queue + answer workers now | Same as chosen | Same | Same, plus a hop per question |

---

## 🔐 The Key Question: Content That Outlives Access (~2 min)

> **"A document becomes inaccessible while its content remains in an index or cache. How does the design avoid returning it?"**

> "The index and the caches are never the authority on access. Every chunk the index returns is re-checked against PostgreSQL (tombstone, current version, the asker's live access) before it can enter a prompt or a citation. Every cached answer records which documents were in its prompt and is validated the same way on every read. Invalidation and purge only reclaim space; correctness never waits for them."

| Where the content still lives | Why it is never returned |
|-------------------------------|--------------------------|
| Index rows with stale scope (sync behind or paused) | The re-check drops them: `not_owner`, `not_in_group`, flagged `staleIndex` |
| Index rows of a deleted document, not yet purged | The re-check sees the tombstone: `deleted` |
| Old version's chunks during the 5 s retire delay | `not_current_version` |
| Session group claims up to 5 minutes old | Used only for the pre-filter; the re-check reads `group_members` live |
| A cached answer in Valkey | Its context list fails validation (tombstone, live access, version, epoch); it's deleted and answered fresh |
| Past answers in history | Re-validated on read and redacted; the purge later scrubs the stored text |
| The browser's chat history and open document page | History is re-read after each run and comes back redacted; the document page drops its copy on a 404 |
| Blobs and extracted text | Served only through endpoints that apply the live access rule; then purged |

The e2e uses the `purge_paused` switch, which works like a legal hold, to prove the cached answer is rejected by validation, not saved by the purge winning a race. Prompt injection can't widen this either: the model has no tools, and the re-check means injected text can only come from a document the asker can already read.

---

## 📜 Execution Traces (~4 min)

### ✅ Successful trace: a revoke while the index is stale (from the e2e run)

1. **Share.** Alice shares "Deploy guide" with Engineering. The transaction sets `scope = group` and `acl_epoch = 3`, and re-arms `sync_acl`, which rewrites the index rows 3 s later.
2. **Revoke with the sync paused.** Ops pauses the metadata sync. Alice unshares: `scope = private`, `acl_epoch = 4`, and the sync is re-armed but deferred. The index rows still say `scope = group, acl_epoch = 3`.
3. **Ask.** Carol types "At what time does the deploy freeze begin on Fridays?" The browser POSTs to API instance 3010, which inserts a `queued` run and returns 202 with its id. The ask store appends the run and opens its stream.
4. **Cache.** The executor marks the run `running` and starts heartbeating. The cache lookup for Carol's key misses, and a `cache` event is appended.
5. **Search.** It embeds the question and opens a `REPEATABLE READ` snapshot. The ANN and full-text queries, filtered by Carol's org and her claims (Engineering), return the deploy guide's chunks, because the stale rows still say Engineering.
6. **Re-check.** In the same snapshot it loads those chunks with their documents. The deploy guide is `private` and owned by Alice, and Carol isn't the owner, so every one of its chunks is dropped as `not_owner, staleIndex: true`. The remaining candidates come from documents Carol can read.
7. **Trace on screen.** The `retrieval` event reaches the browser, and the card shows the sources plus "2 dropped by access re-check: private to its owner ×2 (index said readable: 2)".
8. **Answer.** The model receives only readable sources. Deltas stream into the card; on completion the citations become links with version and offsets, the run records usage, and the answer is cached with its context list.
9. **Catch-up.** Ops unpauses the sync. The index rows become `scope = private, acl_epoch = 4`, and from then on the pre-filter itself excludes them.

The revoke took effect on the very next question, and the stale index never reached a prompt.

### ❌ Failed trace: an embedding outage poisons a document, then Retry recovers it

1. **Upload.** Ops arms three 500s on the embedder. Alice drops a file. The upload commits the document, version, blob and `extract` job, publishes the ticket and returns 201; the library shows the stage pills.
2. **Extract and chunk.** Worker-1 claims `extract` (attempt 1), reads the blob and writes the text. In one transaction it marks the job succeeded and enqueues `chunk`, which then runs and enqueues `embed`.
3. **Embed, attempt 1.** Worker-2 claims `embed`. The embedder answers 500. The worker records attempt 1 as `retry` and sets `next_run_at = now() + ~0.7 s` on the database clock, then acks the ticket. The embed pill shows the error and "attempt 1/3".
4. **Attempt 2.** The sweeper publishes the job when it's due. It fails the same way and is rescheduled about 1.5 s out.
5. **Poisoned.** Attempt 3 fails. Attempts have reached the maximum, so the job becomes `poisoned`, and in the same transaction the version and the document become `failed` with "embed failed after 3 attempts: Embedder returned 500: …". The library shows the reason and a Retry button.
6. **Retry.** Alice clicks Retry. The poisoned job's attempts reset, the version goes back to `processing`, and the ticket is republished. The embedder is healthy now; `embed` and then `index` succeed, and the document becomes `ready`. The chunks written before the outage were not rewritten.

---

## ✅ Design Review Checklist (~1 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | PostgreSQL: documents, versions, scope, groups, tombstones, chunks, index rows, jobs, runs. An upload succeeds when the transaction holding the document, version, blob reference, extract job and idempotency record commits, after the blob PUT. A stage succeeds when its writes, its completion and the next job commit together. A delete succeeds at the tombstone commit; the purge has its own tracked completion. A sharing change succeeds at commit, before the index catches up. The UI treats nothing as done before a 2xx |
| Client retries after losing the response? | Upload: same key → stored response replayed; different bytes → 422; concurrent duplicates serialized by the advisory lock; same bytes with a new key → the existing document if readable. Question: a lost 202 means a second run; a lost stream resumes with `Last-Event-ID` from any instance. Delete and sharing are idempotent by state |
| Failure between two important steps? | API between commit and publish: the sweeper publishes the undispatched job. Worker mid-stage: redelivery, lease takeover, redo from keyed writes (kill-mid-chunk). Worker after commit, before ack: nothing to claim. Frozen worker: lease expiry and fencing. API mid-answer: the sweeper fails the run after 15 s with the flushed partial text. Purge during a MinIO outage: retried indefinitely, finished artifacts skipped |
| Which ordering is required? | Per question, one snapshot, so a document's chunks come from one version and the access check sees committed state. Per document, monotonic versions decided under a row lock. Read-your-writes for access, because the re-check reads the primary. Not required: ordering across documents, or the index being in sync |
| Access with caches, indexes, async jobs? | Twice: the index pre-filters by tenant and its copy of scope, then every candidate is re-checked against PostgreSQL. Cached answers are validated per read; history is redacted on read; the client re-reads rather than trusting what it holds. Workers act as the system and never serve user data. Operators see ids and counts, never titles or text. Dedupe never reveals unreadable documents |
| What breaks first, and the evidence? | Vector index memory, then the embedder's rate limit, then PostgreSQL writes; next section |

---

## 📈 Scale: What Breaks First (~2 min)

| Rank | Component | Evidence | Next step |
|------|-----------|----------|-----------|
| 1 | Vector index memory | 1.25B chunks × (4 KB vector + graph) ≈ 8 TB; measured 3 chunk-sized rows per chunk (chunk, embedding, index entry) | Shard by tenant, which also makes the tenant filter physical; int8 or product quantization (4-8× less memory) with a full-vector re-rank; a dedicated vector engine with namespaces |
| 2 | Embedding throughput | 4,000 chunks/s at peak, 10× on re-index days, against a provider rate limit | Bigger batches; cache embeddings by chunk-text hash across versions; per-tenant queues and quotas; a self-hosted model for bulk re-indexing |
| 3 | PostgreSQL writes | Measured 6.6 row writes per chunk → ~26k writes/s at 4,000 chunks/s | Shard metadata by org; move chunk text and vectors out of the OLTP database; batch progress updates |
| 4 | The re-check | ~600 batched primary-key lookups/s at peak, against tiny, hot ACL rows | Stays cheap; must read the primary or a replica proven caught up |
| 5 | Answer streams | ~3,000 concurrent SSE streams | Stateless instances; Valkey streams sharded by run id; a multiplexed reader; per-tenant slots in the LLM gateway |
| 6 | Purge bursts | An org deletes 100k documents at once | Per-tenant rate limits, delete by object-store prefix, an SLO on purge completion time minus delete time |

> "Locally, retrieval measured p50 51 ms and p95 66 ms over 24 questions on 41 chunks, re-check included. That tells me the re-check is noise next to the search. It doesn't tell me how the ANN behaves at 1.25B vectors, which is why the memory arithmetic, not the local latency, puts the index first. The write count is the measured number I'd extrapolate: 6.6 per chunk is what each new chunk will cost until chunk text and vectors move out of PostgreSQL."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|-----------|----------------|-----|
| Authority on access | PostgreSQL, re-checked per candidate | The index's metadata | Copies lag; a stale copy must never decide |
| Where the index filters | Inside the ANN query, iterative scan | Post-filter a global top-k | Post-filtering starves answers and leaks cost across tenants |
| Revocation | Validate on read (re-check, cache validation, redaction) | Invalidate every copy synchronously | No fan-out to find every copy; immediate by construction |
| Index metadata | Lazily synced by a job | Updated inside the sharing transaction | Decouples user writes from the slowest store; the staleness is safe |
| Stage idempotency | Derived chunk ids + keyed upserts | Delete and reinsert per stage | Redo converges on the same rows; embeddings keep their keys |
| Jobs | Leased rows, pointer tickets, sweeper | State in the broker | Visible, cancellable, fenced, on one clock |
| Embedder throttling | 429s retried inside the attempt | Counted as failed attempts | A busy provider doesn't poison healthy documents |
| Version update | Index alongside, switch one pointer, retire later | Update chunks in place | No half-documents, no mixed versions |
| Deletion | Tombstone first, tracked async purge | Synchronous multi-store delete | Instant for users; complete and auditable later |
| Dedupe | Per tenant, readable documents only | Per tenant regardless of access | Never reveals a hidden document |
| Answer cache | Context documents with version and epoch, validated per read | Trust TTL and invalidation | Safe even before the purge runs |
| Answer runs | Accepting instance + Valkey streams | Executor-memory SSE, or answer workers | Any instance resumes a stream; one fewer hop |
| Client data | Polling, re-read after runs, no client cache | A cached client store | Nothing on screen outlives an access change for long |

---

## 📝 Wrap-up (~1 min)

> "To sum up: the design treats every copy of a document as something that may be wrong. PostgreSQL decides access, and the last step before content is used, the re-check in retrieval and the validation of cached answers and history, reads that truth in the same snapshot. That's why a revoke takes effect on the next question even with the index behind, and why a delete is complete for users at the tombstone. The pipeline is leased rows plus keyed upserts, so a worker killed mid-chunk costs a redo, not a duplicate. Versions switch by moving one pointer, and answers are durable runs that any instance can stream. What I'd do first at real scale is shard the vector index by tenant and move vectors out of the OLTP database, because memory and writes per chunk are what the numbers say breaks first."

### How the local implementation compares

| Production | Local |
|------------|-------|
| Sharded metadata, a dedicated vector engine, chunk text in object storage | One PostgreSQL 16 with pgvector 0.8 holding metadata, chunks, embeddings and the HNSW index |
| Embedding provider and LLM gateway | Deterministic mock embedder (hashed terms, 256 dimensions) and an extractive mock model; a real provider is optional via an API key |
| S3 with presigned PUTs for large files | MinIO, multipart through the API (≤ 5 MB) |
| OIDC with group claims | Session cookie in Valkey with group claims refreshed every 5 minutes |
| Autoscaled per-stage worker pools | Two supervised workers on one quorum queue; a kill-mid-chunk switch and other fault switches |
| Hours-scale timings | 1-15 s backoff, 5 s retire delay, 3 s metadata sync |

Two API instances, two workers, the mock services and the React app run on one machine. The e2e drives the hard paths through the real stack: concurrent duplicate uploads, a worker killed mid-chunk, absorbed 429s, a poisoned embed and its retry, a held version switch, revokes with the sync paused, a cached answer rejected after delete, a MinIO outage mid-purge, and a stream resumed on the other instance.
