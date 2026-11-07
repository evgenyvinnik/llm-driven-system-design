# Document Q&A - Architecture

## System Overview

Users upload documents to an assistant and ask questions about them. The system extracts text, splits it into chunks, embeds and indexes them, answers with citations that open the exact cited span, and supports new versions, sharing changes and deletion. Retrieval-augmented generation is the easy part to sketch. Making it correct is harder, and five problems decide whether the design holds:

1. **The index is a copy, and copies go stale.** A vector index holds each chunk with a snapshot of its tenant and access scope, so it can filter during the search. When a document is unshared, someone leaves a group, or the document is deleted, that snapshot is wrong until a background job rewrites it, and caches hold answers built from the old state. **Key question: a document becomes inaccessible while its content remains in an index or cache. How does the design avoid returning it?** Answer: the index and the caches are never the authority on access. Every chunk the index returns is re-checked against the source of truth (tombstone, current version, the asker's live access) before it can enter a prompt or a citation. Every cached answer records which documents were in its prompt and is validated the same way on every read. Invalidation and purge only reclaim space; correctness never waits for them.
2. **The pipeline fails between steps.** Extract → chunk → embed → index runs on workers that crash, get killed during deploys, and call rate-limited embedding APIs. Every stage must be safe to redo: a worker killed after writing half a document's chunks must neither lose the other half nor duplicate the first.
3. **Versions must not mix.** A new version is processed while questions keep arriving. Until it is fully indexed, answers come from the old version. After the switch, from the new one. No answer may quote paragraph 3 of v1 next to paragraph 4 of v2.
4. **Deletion has to be immediate and then complete.** The document must vanish at once from the library, retrieval and citations. Its blobs (every version), chunks, embeddings, index rows and cached answers must then actually be removed, with proof of when that finished, even if the object store is down at the time.
5. **Uploads are retried and duplicated.** A client that loses the response retries; people upload the same file twice. Neither should create a second document or a second embedding bill.

**Learning goals:** access enforced twice (pre-filter inside the ANN query, re-check against the source of truth); idempotent pipeline stages with leased jobs; deterministic chunk identity; atomic version switch with asynchronous retirement; tombstone-first deletion with tracked purge; cache validation on read; durable streamed answer runs.

**Signal.** Practice extension ([ROADMAP entry 8](../ROADMAP.md#8-document-qa)). The named trap is treating the index as the authority on access, or treating retrieval-augmented generation as a black box.

## Requirements

### Functional Requirements

1. **Upload** `.txt`, `.md` and `.html` (markup stripped) up to 5 MB locally. An `Idempotency-Key` makes a retried upload return the first response. Identical bytes within a tenant return the existing document when the uploader can read it. A corrupt or unsupported file fails with a reason. PDF is out of scope for this build.
2. **Process** each version through extract → chunk → embed → index. Show per-stage status, progress and attempts. A stage that fails N times poisons the job and marks the document `failed` with the reason and a retry action.
3. **Chunk** by approximate token length with sentence overlap, keeping character offsets and the enclosing heading, so a citation can highlight the exact span.
4. **Ask** a question and get an answer streamed over SSE with numbered citations. "Not found in your documents" when nothing relevant is readable. Each question is a durable run (`queued → running → completed | cancelled | failed`) that the client can reconnect to and stop. Usage (tokens; queue, retrieval, time-to-first-token and generation latency) is recorded on every run.
5. **Share** a document as private, with a group, or org-wide. Revoking (unshare, removing a user from a group) takes effect on the next question.
6. **Version** a document. The new version is processed fully, then switched atomically. The old version's chunks are retired afterwards.
7. **Delete** a document: it disappears at once, then a purge removes blobs, chunks, embeddings, index rows and cached answers, tracking each artifact and the completion time.
8. **Operate**: queue depth, jobs by stage and status, poisoned jobs with retry, purge backlog, index-metadata lag, and fault switches for workers and the mock services.

### Non-Functional Requirements

| Property | Target | Why |
|----------|--------|-----|
| Access correctness | Zero chunks of a document a user cannot read *right now* in any prompt, answer, citation or cached answer | This is a data-leak class bug: one wrong chunk can expose salary bands or a customer contract |
| Revocation latency | Effective on the next question (< 1 s after commit) | "I unshared it" must mean unshared, not "in a few minutes" |
| Delete visibility | Invisible everywhere at tombstone commit; physically purged within 24 h (seconds when healthy) | Users and regulators (GDPR erasure) expect both |
| Answer latency | p50 time to first token < 1.5 s, p99 < 4 s; retrieval p99 < 150 ms | Chat feels broken past a couple of seconds of silence |
| Ingestion latency | p50 upload → ready < 30 s for a 20-page document; backlog drains with no loss after outages | Users ask about a file right after uploading it |
| Durability | No accepted upload lost; every stage resumable | Uploads are user data; re-embedding costs money |
| Availability | 99.9% for Q&A, 99.95% for upload acceptance | Upload acceptance is a write path users retry on |
| Tenant isolation | No cross-tenant reads, timing or existence leaks (including through dedupe) | Multi-tenant SaaS baseline |

## Capacity Estimation

### Production Scale (assumptions)

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Tenants / users | 10,000 orgs, 2M users | Mid-size B2B assistant |
| Documents | 50M live, 2M uploads/day (≈ 23/s average, 150/s peak) | Many small docs, some big manuals |
| Extracted text | ~40 KB per document → 2 TB | Typical office documents |
| Chunks | ~25 per document (512 tokens, 64 overlap) → 1.25B | 40 KB ≈ 10k tokens |
| Embeddings | 1024 dims × 4 B = 4 KB per chunk → 5 TB, ~8 TB with HNSW graph overhead | Must be sharded |
| Embedding throughput | 50M chunks/day ≈ 580/s average, 4,000/s peak (re-index days: 10×) | The provider's rate limit is the ceiling, not our CPUs |
| Questions | 10M/day ≈ 115/s average, 600/s peak | 5 questions per user per day |
| Per question | 1 query embedding, ANN k = 50 with filters, 1 batched re-check of ≤ 50 chunks, 1 LLM stream of ~3-8 s | — |
| Concurrent answer streams | ~600/s × 5 s ≈ 3,000 open SSE connections at peak | Sized for the gateway and model slots |
| Re-check reads | 600 batched primary-key lookups/s at peak | Tiny compared with the ANN work; this is why "always re-check" is affordable |

The numbers say: storage and ANN memory are the big costs (sharded vector index), the embedding provider's rate limit governs ingestion, and the LLM dominates answer latency. The re-check that makes access correct is a cheap batched lookup by primary key, which is the reason the design can afford to run it on every question.

### Local Development Scale

Two orgs, four users, two API instances, two pipeline workers (4 tickets each), one mock embedder, one mock model. The sample corpus is 14 small documents. Chunks target 120 tokens with 24 of overlap (production: 512 / 64) so even small files produce several chunks. Retries back off from 1 s to a 15 s cap; the old version is retired 5 s after a switch; index metadata syncs 3 s after a sharing change.

## High-Level Architecture

```
                    ┌──────────────────────── Clients (web app: library, document page, chat, ops) ────────────────────────┐
                    └────────────────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                                                     │ HTTPS (REST + SSE)
                                                       ┌─────────────▼─────────────┐
                                                       │ API gateway / LB (auth,    │
                                                       │ rate limits, SSE affinity  │
                                                       │ not required)              │
                                                       └──┬──────────┬──────────┬──┘
                       upload (presigned PUT at scale)    │          │          │ questions, runs, SSE
              ┌───────────────────────────────────────────┘          │          └─────────────────────────────┐
              ▼                                                      ▼                                        ▼
   ┌─────────────────────┐   job rows (outbox)   ┌────────────────────────────┐                ┌──────────────────────────┐
   │ Document service    │──────────────────────▶│ Metadata DB (PostgreSQL)   │◀───re-check────│ Answer service           │
   │ dedupe, versions,   │                       │ SOURCE OF TRUTH: documents,│  (same         │ cache → embed query →    │
   │ sharing, tombstones │                       │ versions, ACL, groups,     │   snapshot)    │ ANN (pre-filtered) →     │
   └──────────┬──────────┘                       │ chunks, jobs, runs, purge  │                │ re-check → prompt →      │
              │ blobs (one key per version)      └──────────┬─────────────────┘                │ LLM stream → citations   │
              ▼                                             │ tickets {jobId}                  └──┬──────┬──────────┬────┘
   ┌─────────────────────┐                       ┌──────────▼─────────────────┐                   │      │          │
   │ Object store (S3)   │◀──────read/delete─────│ Queue (RabbitMQ / Kafka)   │                   │      │          │
   └─────────────────────┘                       └──────────┬─────────────────┘        ┌──────────▼┐ ┌───▼──────┐ ┌─▼───────────┐
                                                            ▼                          │ Valkey:   │ │ Embedding│ │ LLM gateway │
                         ┌────────────────────────────────────────────────────┐        │ answer    │ │ service  │ │ (provider / │
                         │ Pipeline workers: extract │ chunk │ embed │ index  │──────▶ │ cache, run│ │ (batch,  │ │ self-hosted)│
                         │ + retire, sync_acl, purge; sweeper reclaims leases │ embed  │ streams,  │ │ 429s)    │ └─────────────┘
                         └─────────────┬──────────────────────────────────────┘        │ cancel    │ └──────────┘
                                       │ index entries (tenant, version, scope)        └───────────┘
                                       ▼
                         ┌────────────────────────────────────┐
                         │ Vector index (pgvector HNSW shards │
                         │ or a dedicated engine): a COPY of  │
                         │ access metadata, pre-filter only   │
                         └────────────────────────────────────┘
```

Two rules shape every arrow:

- **PostgreSQL decides; everything else remembers.** The queue holds pointers to job rows, the index holds a lazily synced copy of access metadata, Valkey holds answers that must pass validation before they are served. Losing any of them delays work or costs a recomputation; it never changes who can read what.
- **Every stage is keyed and redoable.** Jobs are unique per (version, stage); chunk rows per (version, ordinal); embeddings and index entries per chunk id. A redo rewrites the same rows.

## Core Components

### 1. Upload, idempotency and dedupe

An upload is one PostgreSQL transaction (`api/services/uploads.ts`):

1. **Idempotency.** An advisory lock on (user, `Idempotency-Key`), then a lookup in `upload_requests`. A stored response is replayed with `Idempotent-Replayed: true`. The same key with different bytes or a different target returns `422 IDEMPOTENCY_KEY_REUSED`. Concurrent retries serialize on the lock, so two simultaneous requests with one key produce one document (verified in the e2e by firing both at the two API instances at once).
2. **Dedupe** (new documents). An advisory lock on (org, SHA-256 of the bytes), then: is there a live document in this org whose current (or only) version has this hash **and which the uploader can read**? If so, return it as `200 {duplicate: true}` and create nothing.
   - **The semantics, decided:** dedupe is per tenant and *visibility-scoped*. If the same bytes exist in a document the uploader cannot read, the upload proceeds as a new document. Returning the hidden one, or even a "duplicate exists" error, would leak that a private document with this exact content exists. Across tenants there is no dedupe at all.
   - A new version with bytes identical to the latest version returns `200 {unchanged: true}`.
3. **Store and record.** PUT the blob under a per-version key `<org>/<doc>/v<n>-<hash prefix>.<ext>`, insert the document (or bump `latest_version_no`), the version row, the `extract` job and the idempotency record, then commit and publish the job's ticket. If MinIO is down the transaction rolls back with `503`; a retry with the same key is safe.

**Multipart through the API, not a presigned PUT, locally.** The API has to hash and type-check the bytes before anything is recorded, and at ≤ 5 MB a single request is simpler than "presign, PUT, then commit". At production sizes (100 MB PDFs) the API should leave the byte path: the client computes SHA-256, asks for a presigned PUT into a quarantine prefix, uploads directly, then calls `commit` with the hash; dedupe runs at commit and the extract stage re-verifies the hash. The trade-off is one more round trip and a pending-upload state that needs garbage collection. See Key Design Decisions.

Supported types are decided by extension (`.txt`, `.md`, `.markdown`, `.html`, `.htm`). An unsupported type is rejected at upload with `415` and a reason ("PDF extraction is not enabled in this build"). Content that is corrupt (NUL bytes, invalid UTF-8, empty after stripping markup) is accepted, then fails in the extract stage permanently with the reason, so it shows up in the library as a failed document with an explanation.

### 2. Processing jobs, leases and the sweeper

A `processing_jobs` row is the unit of work and the outbox at once (`pipeline/jobs.ts`):

| Column | Role |
|--------|------|
| `job_key` (unique) | `<version>:<stage>` for pipeline stages, `<document>:<stage>` for `sync_acl` / `purge`. Enqueue is `INSERT … ON CONFLICT DO NOTHING`, so a stage that completes twice can't create a second next job |
| `status` | `pending → running → succeeded`, or `poisoned` / `cancelled` |
| `attempts`, `max_attempts` | Incremented on every claim, so a document that crashes the worker every time is poisoned instead of crash-looping (3 locally; purge never gives up) |
| `lease_owner`, `lease_token`, `lease_expires_at` | Who holds it, a fencing token, and when it is presumed dead. Heartbeated every lease/3 |
| `next_run_at`, `dispatched_at` | Retry schedule on the database clock; when its ticket was last published |
| `generation` | Bumped when a `sync_acl` job is re-armed while running; a completion for an older generation leaves the job pending so the newest change is always applied |
| `progress` | `{done, total}` for the UI's per-stage progress bars |

Each attempt has a `job_attempts` row (worker, outcome `succeeded | retry | failed | poisoned | lost | superseded`, error, detail such as `chunksWrittenBeforeExit` or `rateLimitedRetries`), which is the processing timeline on the document page.

**Tickets are pointers.** RabbitMQ carries `{jobId}` on a quorum queue. The worker claims with a conditional UPDATE: a pending job that is due, or a running job whose lease expired, **or whose ticket was redelivered** (RabbitMQ redelivers only after the holder's channel closed, i.e. the worker died). The previous holder's attempt is marked `lost`. Completion, failure and deferral are fenced on the lease token, so a worker that was presumed dead and comes back can't overwrite the new holder's result.

**The sweeper** runs inside every worker with `FOR UPDATE SKIP LOCKED` (`worker/sweeper.ts`): it returns expired leases to pending (or poisons them), publishes due pending jobs that were never dispatched or whose ticket went missing, and fails answer runs whose executor stopped heartbeating. Retries never wait in RabbitMQ.

**Failure classes.** A `PermanentError` (corrupt bytes, unsupported type) poisons immediately with outcome `failed`. Anything else is retried with equal-jitter backoff (1 s, 2 s, 4 s… capped at 15 s locally) until `max_attempts`, then poisoned. Poisoning a pipeline stage marks the version `failed` with "embed failed after 3 attempts: Embedder returned 500…", and the document too if no version is being served. The owner's Retry (or the operator's) resets the poisoned job's attempts and republishes it.

A **supervisor** (`worker/supervisor.ts`) runs the two workers as child processes and restarts one that exits, standing in for an orchestrator.

### 3. The stages, and why each is safe to redo

| Stage | Reads | Writes (idempotent key) | Redo behaviour |
|-------|-------|-------------------------|----------------|
| extract | blob | `version_texts` (version) | Same bytes → same text, upserted |
| chunk | extracted text + headings | `chunks` (version, ordinal), id = `chk_<version>_<ordinal>` | Upserts in batches of 4, then deletes ordinals past the end. A redo after a crash rewrites the same rows with the same ids |
| embed | chunks without an embedding | `chunk_embeddings` (chunk id) | Only missing chunks are embedded, so a crash after 3 of 5 batches costs 2 batches on the redo, not 5 |
| index | embeddings + the document's **current** access metadata | `index_entries` (chunk id), then the version switch | Upsert; the switch is decided under a row lock (below) |
| retire | — | deletes a superseded version's index rows, embeddings and chunks | Deleting nothing is fine; never retires the current version |
| sync_acl | document scope/group/epoch | `index_entries` metadata | Writes only rows whose epoch is behind |
| purge | purge_tasks | removes each artifact, marks it done | Skips artifacts already done; deleting what's gone is a no-op |

The chunker is a pure function of the text and the settings, which is what makes "redo" mean "rewrite the same rows". The **kill-mid-chunk** fault switch proves it: armed once, a worker calls `process.exit(1)` right after writing at least half of a version's chunks (e2e: 12 of 17) without acking its ticket. RabbitMQ redelivers the ticket to the other worker, which takes over the lease (attempt 1 recorded `lost` with `chunksWrittenBeforeExit: 12`), writes all 17, and the supervisor restarts the dead worker. Afterwards `count(*) = count(DISTINCT ordinal) = 17`, ordinals 0..16, one embedding each.

Embedding is split from indexing on purpose. The embedding store (keyed by chunk id) is the expensive artifact; the index is cheap to rebuild from it with new metadata or a new index type. In production these are often different systems (a provider batch job and a vector engine).

### 4. Chunking with offsets

`pipeline/chunk.ts` splits the extracted text into sentences (a sentence ends at `.`, `!` or `?` followed by whitespace, or at a newline, so "3.5 days" stays whole), splits any sentence longer than a chunk at whitespace, then accumulates sentences up to ~120 tokens (≈ 4 characters per token). The next chunk restarts on whole sentences covering ~24 tokens of the previous chunk's tail, and at least its last sentence if that is shorter than half a chunk, so a claim that straddles a boundary is whole in at least one chunk. A heading starts a new chunk with no overlap, and every chunk records the heading it falls under. Invariant, unit-tested and checked live: `text.slice(charStart, charEnd) === chunk.text`.

Offsets index into the version's **extracted text**: identical to the uploaded file for `.txt` and `.md` (apart from normalised line endings); for `.html` they index the stripped text the document page displays.

### 5. Embeddings (mock embedding service)

A separate process (`embedder/`) with a batch endpoint (`POST /v1/embeddings`, ≤ 256 inputs). Vectors are deterministic: each term (a concept id from a small synonym table, or a crude stem), each adjacent term pair and each stem's character trigrams are hashed into 256 signed dimensions, then L2-normalised. Related text really is closer ("reimbursed for receipts" lands near "expense claims with an itemized receipt"), so retrieval behaves like the real thing. Knobs: latency per batch, random failure rate, and armed counts for 429 (with `Retry-After`) and 500.

The embed stage retries 429 and 503 **inside** the attempt, honouring `Retry-After` (capped) or backing off exponentially with jitter, and heartbeats its lease while it waits; those mean "slow down", not "broken". A 500 or a network error fails the attempt and the job-level retry takes over. Verified: three armed 429s were absorbed in one attempt, recorded as `rateLimitedRetries: 3`, with the stage waiting the full 3 s.

### 6. Retrieval with access enforced twice

`api/services/retrieval.ts`, in one `REPEATABLE READ READ ONLY` snapshot:

1. **Embed the question** (same embedder).
2. **Pre-filter inside the search.** Both arms put tenant and scope in the WHERE clause of the index query, using the index rows' copy of scope and group and the session's group claims:

   ```sql
   SELECT e.chunk_id, e.document_id, e.version_id, e.scope, e.group_id, e.acl_epoch,
          1 - (e.embedding <=> $4::vector) AS similarity
     FROM index_entries e
    WHERE e.org_id = $1
      AND (e.scope = 'org' OR e.owner_id = $2 OR (e.scope = 'group' AND e.group_id = ANY($3)))
    ORDER BY e.embedding <=> $4::vector
    LIMIT 24;   -- with SET LOCAL hnsw.iterative_scan = relaxed_order
   ```

   The full-text arm runs the same filter with `to_tsquery('english', 'word1 | word2 | …')`. The two lists are fused with reciprocal rank fusion (k = 60). Vector-only hits need cosine similarity ≥ 0.2, keyword hits ≥ 0.1.
3. **Re-check every candidate against the source of truth** (`api/services/recheck.ts`): one query loads the candidates' chunk rows joined to their documents and versions, plus the asker's live account and group memberships. A candidate survives only if its chunk still exists, its document is live and in the asker's org, its version **is the document's current version**, the asker can read the document now, and the asker's account is active. Each drop records a reason (`deleted`, `not_owner`, `not_in_group`, `other_tenant`, `user_inactive`, `chunk_missing`, `not_current_version`) and whether the index row was stale.
4. The top 5 survivors become the numbered sources.

**Why filter inside the ANN query, not after top-k.** Post-filtering a global top-k fails twice. With 10,000 tenants, the 24 nearest chunks to "what is our retention period?" are almost all other tenants' retention policies; after filtering, the answer is starved or empty although relevant readable chunks exist at rank 400. Raising k to compensate makes every query pay for every tenant's data, and the latency then depends on other tenants' content. HNSW with a selective filter has the same starvation inside the graph walk, which is why pgvector 0.8's iterative scan (`hnsw.iterative_scan`) keeps walking until enough rows pass. At production scale, per-tenant partitions (or namespaces in a vector engine) make the filter physical.

**Why re-check when the pre-filter already filtered.** The pre-filter uses copies that lag: index metadata is synced by a job seconds after a sharing change, and the session's group claims are refreshed every 5 minutes. A stale copy can only err in two ways. Too narrow (a new share not yet synced) costs recall for a few seconds. Too wide (a revoke not yet synced, a removal not yet in the claims) would leak, and the re-check closes exactly that gap. The re-check is cheap: one batched primary-key query for ≤ 24 chunks.

**Why one snapshot.** The version switch is a single-row update. Running the ANN query and the re-check in the same `REPEATABLE READ` snapshot means each document's `current_version_id` is read once per question, so every surviving chunk of that document comes from the same version.

### 7. Access model, and how a revoke takes effect

- An org owns documents. Each document has an owner and a scope: `private` (owner only), `group` (one group, membership read live), or `org`.
- A sharing change commits the new scope and bumps `documents.acl_epoch` in one transaction, then re-arms the document's `sync_acl` job with a 3 s delay. Until it runs, the index rows still carry the old scope.
- Removing a user from a group deletes one `group_members` row. Nothing in the index changes (rows carry the group id, not member lists) and the user's session claims are left alone.

Both revokes take effect on the next question because the re-check reads the truth, not the copies. The e2e proves it with the sync paused: after alice unshares a document, its index rows still say `scope = group`, carol's next question retrieves them, and the re-check drops them (`not_owner`, `staleIndex: true`). After alice removes carol from Engineering, carol's session claims still list Engineering, and her next question drops the group document (`not_in_group`). Unpausing the sync then rewrites the index rows.

The same rule applies to history: listing past answers re-validates each run's sources, and an answer whose prompt included a document the reader can no longer read comes back redacted.

### 8. New versions: process fully, switch atomically, retire later

1. `POST /documents/:id/versions` creates version n+1 with its own blob key and an `extract` job. The document keeps serving its current version.
2. The pipeline runs. The index stage upserts the new version's index entries, so for a while **both versions sit in the index**.
3. Still in the index stage, inside the transaction that completes the job, the document row is locked and `decideActivation` (`pipeline/stage-core.ts`) runs: activate if the document is live and no newer version is current; mark `stale` (superseded, never served) if a newer version won the race; cancel if the document was deleted.
4. Activation is one UPDATE: `current_version_id`, `current_version_no`, `content_hash`. The old version becomes `superseded`, and a `retire` job is enqueued 5 s later so answers already reading the old chunks finish.
5. `retire` deletes the old version's index entries, embeddings and chunks. Its blob and extracted text stay for version history until the document is deleted.

During the overlap, the re-check drops the new version's chunks as `not_current_version`; after the switch it drops the old version's. The e2e holds the switch for 8 s (`activation_delay_ms`) and asks repeatedly across it. Every answer used exactly one version, and the sequence flipped once (seven answers from v1, then three from v2).

### 9. Deletion: tombstone first, then a tracked purge

`DELETE /documents/:id` is one transaction (`api/services/lifecycle.ts`):

1. `deleted_at = now()` and `acl_epoch + 1` on the document row. **This is the delete.** The library, document pages, retrieval re-check, cache validation and history redaction all filter on it, so the document is gone from every read path at commit.
2. Pending pipeline jobs for the document are cancelled. A running stage notices the tombstone at its next check and cancels itself.
3. One `purge_tasks` row per artifact (`cache`, `index`, `embeddings`, `chunks`, `blobs`) and a `purge` job.

The purge job (`pipeline/stages.ts`):

- waits (defers without spending an attempt) while any pipeline stage for the document still holds a live lease, so nothing is written back after its artifact was removed;
- removes each pending artifact in order and marks it done with a count:
  - `cache`: every cached answer listed in the document's reverse index (a Valkey set; never a `DEL` by key pattern), and it scrubs persisted answer runs whose prompt included the document;
  - `index` and `embeddings` rows;
  - `chunks` and extracted texts;
  - `blobs`: every version's object;
- verifies nothing came back (a stage racing the tombstone); if something did, the artifact is re-marked pending and the job retries;
- sets `purge_completed_at`.

A failure (MinIO down) records the error on that artifact and retries the job with capped backoff, indefinitely; done artifacts are never redone. The library shows "purged 4/5 · blobs: connection refused" and then the completion time. The e2e stops the MinIO container mid-purge: four artifacts finish, the blobs artifact fails and retries with backoff, and when MinIO returns the blobs are deleted and the purge completes.

A `purge_paused` switch holds purges, like a legal hold: the document stays invisible while removal waits. The e2e uses it to prove that the cached answer is rejected by validation, not saved by the purge winning a race.

### 10. The answer cache, safe by validation on read

`api/services/answer-cache.ts`. Key: `dq:ans:<org>:<user>:<sha256(normalized question)>`. The user is in the key because retrieval depends on what the user can read. Production could key by an access fingerprint (the set of groups) to share entries between users with identical access; validation keeps either choice safe.

Each entry stores the answer, sources, citations and a **context list**: every document whose chunks were in the prompt (not just the cited ones, because a model can repeat uncited context), with the version and `acl_epoch` it was built from. On every read, one query checks each context document **for this reader, now**:

| Check | Rejects when |
|-------|--------------|
| Tombstone | the document was deleted, even if purge hasn't removed the entry yet |
| Live access | the reader can no longer read it (unshared, removed from the group, account disabled) |
| Version | a newer version is current |
| Access epoch | sharing on the document changed since the entry was built (conservative) |

A rejected entry is deleted and the question is answered fresh; the run records `cache: {status: "rejected", reason}`. Entries also expire after 10 minutes, but correctness never depends on the TTL or on invalidation arriving. Answers with no sources are not cached (they would go stale silently when a document is uploaded).

### 11. Answer runs and streaming

`POST /answers` inserts an `answer_runs` row (`queued`) and returns `202` with its server-assigned id. The API instance that accepted it executes it (`api/services/answer-runner.ts`):

1. `running` (queue time recorded), heartbeat every second; each heartbeat also flushes the partial output and checks for a cancel request.
2. Answer cache lookup with validation (hit: the cached answer is streamed and the run completes with zero model tokens).
3. Retrieval and re-check; the sources and the retrieval summary (candidates, kept, drops by reason) are stored on the run.
4. The prompt: a system instruction plus numbered `<source id="n" title=… version=…>` blocks and the question.
5. The model stream; the first delta stamps time to first token. When it ends, `[n]` markers become citations (`api/services/citations.ts`): the claim before each marker is located verbatim in source n's chunk, so the citation points at that exact span (fallback: the whole chunk).
6. `completed` with usage, then the answer is cached.

Every step appends to a per-run **Valkey stream**. `GET /answers/:id/stream` replays it from `Last-Event-ID` on **any** API instance, so a client can reconnect, even to the other instance, without gaps or repeats (verified). **Stop** sets `cancel_requested_at` and publishes on a cancel channel that every instance hears; the executor aborts the model request and the run ends `cancelled` with its partial output. A mid-stream model failure (the socket closes before `message_stop`) ends the run `failed` with the partial output kept and usage recorded. If the executing instance dies, the sweeper fails the run once its heartbeat is 15 s stale, and the partial text flushed so far survives. Runs are not retried automatically: a retry would bill again and could produce a different answer, so the user re-asks.

### 12. Mock model service

A separate process (`model/`) speaking a subset of the Anthropic Messages API (`POST /v1/messages`, `stream: true`). Its "reasoning" is extractive and deterministic: it parses the numbered sources and the question, scores each source sentence by how many question terms it contains, skips headings, and answers with the best sentences verbatim, each followed by `[n]`. When nothing clears the bar, or no sources were sent, it says "That information was not found in your documents." Knobs: time to first token, tokens per second, concurrent slots, random failure rate, and armed `overloaded` (529), `server_error` (500) and `midstream_disconnect` (the socket is destroyed after N tokens). A real provider is used instead when `ANTHROPIC_API_KEY` is set: the official Anthropic SDK streams from `claude-opus-5-5` (override with `ANTHROPIC_MODEL`) at low effort with server-side refusal fallbacks, and a final `refusal` fails the run with its category. It is off by default and never needed for setup, tests or screenshots, and it has not been exercised against the live API in this build.

### Worked example: one successful trace

Carol asks a question while a revoke and a stale index are in play (from the e2e run):

1. Alice shares "Deploy guide" with Engineering. The transaction sets `scope = group`, bumps `acl_epoch` to 3, and re-arms `sync_acl`, which rewrites the document's index rows 3 s later.
2. Ops pauses the metadata sync. Alice unshares the document: `scope = private`, `acl_epoch = 4`, and the sync is re-armed but deferred. The index rows still say `scope = group, acl_epoch = 3`.
3. Carol asks "At what time does the deploy freeze begin on Fridays?" on API instance 3010. A run is inserted `queued`; the response is `202 {run: {id: run_…}}`. Her browser opens `GET /answers/run_…/stream`.
4. The executor marks the run `running` and looks up `dq:ans:org_acme:usr_carol:<hash>`: a miss.
5. It embeds the question and opens a `REPEATABLE READ` snapshot. The ANN query, filtered by `org_acme` and carol's session claims (`grp_acme_eng`), returns the deploy guide's chunks: the stale index rows still say Engineering.
6. The re-check loads those chunks with their documents: the deploy guide is `private`, owned by alice. Carol is not the owner, so all of its chunks are dropped with `not_owner, staleIndex: true`. The remaining candidates come from documents she can read.
7. The model receives only those sources and streams its answer; the run completes with usage, and the retrieval summary says "dropped 2 by access re-check: not_owner".
8. Ops unpauses the sync; the index rows become `scope = private, acl_epoch = 4`, and from then on the pre-filter itself excludes them.

Result: the revoke took effect on the very next question, and the stale index never reached a prompt.

### Worked example: one failed trace

An embedding outage poisons a document, then a retry recovers it (e2e):

1. Ops arms three 500s on the embedder. Alice uploads a file; the upload commits the document, version, blob and `extract` job, and publishes its ticket.
2. Worker-1 claims `extract` (attempt 1), reads the blob, writes the text, and in one transaction marks the job succeeded and enqueues `chunk`; then `chunk` runs and enqueues `embed`.
3. Worker-2 claims `embed` (attempt 1). The embedder answers 500. `failJob` records attempt 1 `retry` and sets `next_run_at = now() + ~0.7 s` on the database clock; the ticket is acked.
4. The sweeper publishes the job when it is due; attempt 2 fails the same way (`retry`, ~1.5 s).
5. Attempt 3 fails. `attempts = max_attempts`, so the job becomes `poisoned`, and in the same transaction the version and the document become `failed` with "embed failed after 3 attempts: Embedder returned 500: …". The library shows the reason and a Retry button.
6. Alice clicks Retry: the poisoned job's attempts reset, the version goes back to `processing`, and the ticket is republished. The embedder is healthy again; `embed` and then `index` succeed, and the document becomes `ready`. The chunks written before the outage were not rewritten.

### Design Review Checklist

| Question | Answer |
|----------|--------|
| What is the source of truth, and when is a write successful? | PostgreSQL: documents, versions, scope, groups, tombstones, chunks, the index rows, jobs, runs. An upload succeeds when the transaction holding the document, version, blob reference, extract job and idempotency record commits (after the blob PUT). A stage succeeds when its final writes, its job completion and the next job commit together. A delete succeeds at the tombstone commit; the purge is cleanup with its own tracked completion. A sharing change succeeds at its commit, before the index catches up |
| What happens when a client retries after losing the response? | Upload: same `Idempotency-Key` → the stored response, replayed (`Idempotent-Replayed: true`); different bytes → 422; concurrent duplicates serialised by an advisory lock. Same bytes with a new key → the existing document (duplicate) if the uploader can read it. Question: a lost `202` means a second run (questions are cheap and read-only); a lost stream is resumed with `Last-Event-ID` from any instance. Delete and sharing are idempotent by state |
| What happens when a worker or server fails between two important steps? | API between commit and publish: the job row has `dispatched_at = NULL`; the sweeper publishes it. Worker mid-stage: the ticket is unacked, RabbitMQ redelivers it, another worker takes over the lease, and the stage redoes from its keyed writes (proven by the kill-mid-chunk switch). Worker after commit, before ack: the redelivered ticket finds nothing to claim. Worker frozen: lease expiry + sweeper. API instance mid-answer: the sweeper fails the run after 15 s with the flushed partial output. Purge during a MinIO outage: retried indefinitely, done artifacts skipped |
| Which ordering or consistency guarantee is actually required? | Per question: one consistent snapshot, so all chunks of a document come from one version and the access check sees committed state. Per document: monotonic versions (a version activates only if newer than the current one, decided under a row lock). Revocation: read-your-writes for access (the re-check reads the primary). Not required: ordering between documents, or the index being in sync with the truth; the index may lag by seconds |
| How is access enforced when caches, indexes or asynchronous jobs are involved? | Twice: the index query pre-filters by tenant and the index's copy of scope (performance and recall), then every candidate is re-checked against PostgreSQL for tombstone, current version and live access (correctness). Cached answers record every context document's version and epoch and are validated for the reader on every read. History is redacted on read. Workers act as the system and never serve user data. Operators see ids and counts, never titles or text. Dedupe never reveals documents the uploader can't read |
| What breaks first at much larger scale, and what evidence supports that prediction? | The vector index's memory and the embedding provider's rate limit. Measured locally: 6.6 PostgreSQL row writes per chunk (86 per 13-chunk document: a chunk, an embedding and an index row each, plus ~47 fixed for jobs, attempts, progress and state), 3 chunk-sized rows per chunk, and retrieval p50 51 ms / p95 66 ms over 24 questions on 41 chunks. At 1.25B chunks that is ~8 TB of vectors plus graph, which no single PostgreSQL holds in memory, so the index must be sharded by tenant first. The re-check stays one batched primary-key lookup per question at any scale. See Scalability Considerations |

## Database Schema

The full DDL is in [`backend/src/db/init.sql`](./backend/src/db/init.sql). The core tables:

```sql
CREATE TABLE documents (
  id                  TEXT PRIMARY KEY,                 -- doc_<ulid>
  org_id              TEXT NOT NULL REFERENCES orgs(id),
  owner_id            TEXT NOT NULL REFERENCES users(id),
  title               TEXT NOT NULL,
  scope               TEXT NOT NULL DEFAULT 'private' CHECK (scope IN ('private', 'group', 'org')),
  group_id            TEXT REFERENCES groups(id),
  status              TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'ready', 'failed')),
  current_version_id  TEXT REFERENCES document_versions(id),   -- switched in one UPDATE
  current_version_no  INT,
  latest_version_no   INT NOT NULL DEFAULT 0,
  content_hash        TEXT,
  acl_epoch           BIGINT NOT NULL DEFAULT 1,       -- bumped on sharing change and delete
  failure_reason      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,                     -- the tombstone
  deleted_by          TEXT REFERENCES users(id),
  purge_completed_at  TIMESTAMPTZ,
  CHECK ((scope = 'group') = (group_id IS NOT NULL))
);
CREATE INDEX documents_org_live ON documents (org_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), org_id TEXT NOT NULL,
  version_no INT NOT NULL, content_hash TEXT NOT NULL,
  blob_key TEXT NOT NULL,                              -- one object per version
  filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'processing', 'ready', 'failed', 'superseded', 'retired', 'cancelled')),
  failure_reason TEXT, char_count INT, chunk_count INT, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), ready_at TIMESTAMPTZ, activated_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ, retired_at TIMESTAMPTZ,
  UNIQUE (document_id, version_no)
);
CREATE INDEX document_versions_hash ON document_versions (org_id, content_hash);   -- dedupe

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,                                 -- chk_<version>_<ordinal>: derived, not random
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  document_id TEXT NOT NULL REFERENCES documents(id), org_id TEXT NOT NULL,
  ordinal INT NOT NULL, text TEXT NOT NULL,
  char_start INT NOT NULL, char_end INT NOT NULL, heading TEXT, token_count INT NOT NULL,
  tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || text)) STORED,
  UNIQUE (version_id, ordinal), CHECK (char_end > char_start)
);
CREATE INDEX chunks_tsv ON chunks USING gin (tsv);

CREATE TABLE chunk_embeddings (                        -- the expensive artifact, keyed by chunk
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id), version_id TEXT NOT NULL,
  model TEXT NOT NULL, embedding VECTOR(256) NOT NULL
);

CREATE TABLE index_entries (                           -- the retrieval index: a copy, pre-filter only
  chunk_id TEXT PRIMARY KEY REFERENCES chunks(id),
  org_id TEXT NOT NULL, document_id TEXT NOT NULL, version_id TEXT NOT NULL,
  owner_id TEXT NOT NULL, scope TEXT NOT NULL, group_id TEXT, acl_epoch BIGINT NOT NULL,
  embedding VECTOR(256) NOT NULL, indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(), synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX index_entries_hnsw ON index_entries USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX index_entries_org ON index_entries (org_id, scope);

CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY, job_key TEXT NOT NULL UNIQUE,   -- <version>:<stage> or <document>:<stage>
  document_id TEXT NOT NULL REFERENCES documents(id), version_id TEXT REFERENCES document_versions(id), org_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('extract', 'chunk', 'embed', 'index', 'retire', 'sync_acl', 'purge')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'poisoned', 'cancelled')),
  attempts INT NOT NULL DEFAULT 0, max_attempts INT NOT NULL, generation INT NOT NULL DEFAULT 1,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(), dispatched_at TIMESTAMPTZ,
  lease_owner TEXT, lease_token TEXT, lease_expires_at TIMESTAMPTZ,
  progress JSONB NOT NULL DEFAULT '{}', last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX processing_jobs_due   ON processing_jobs (next_run_at)      WHERE status = 'pending';
CREATE INDEX processing_jobs_lease ON processing_jobs (lease_expires_at) WHERE status = 'running';

CREATE TABLE purge_tasks (
  document_id TEXT NOT NULL REFERENCES documents(id),
  artifact TEXT NOT NULL CHECK (artifact IN ('index', 'embeddings', 'chunks', 'blobs', 'cache')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  attempts INT NOT NULL DEFAULT 0, removed INT NOT NULL DEFAULT 0, last_error TEXT, completed_at TIMESTAMPTZ,
  PRIMARY KEY (document_id, artifact)
);

CREATE TABLE answer_runs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  output_text TEXT NOT NULL DEFAULT '', error TEXT,
  sources JSONB NOT NULL DEFAULT '[]', citations JSONB NOT NULL DEFAULT '[]',
  retrieval JSONB NOT NULL DEFAULT '{}',               -- candidates, kept, drops by reason
  cache JSONB NOT NULL DEFAULT '{}',                   -- hit | miss | rejected (+ reason)
  executor TEXT, heartbeat_at TIMESTAMPTZ, cancel_requested_at TIMESTAMPTZ,
  input_tokens INT, output_tokens INT, queue_ms INT, retrieval_ms INT, ttft_ms INT, generation_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, first_token_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
);
```

Also: `orgs`, `users` (role `member | org_admin | operator`), `groups`, `group_members`, `version_texts` (extracted text and headings per version), `job_attempts`, `upload_requests` (idempotency), `document_events` (audit trail on the document page) and `chaos_switches`.

## API Design

All routes are under `/api/v1`, session-authenticated (httpOnly cookie), JSON unless noted.

```
POST   /auth/login | /auth/logout,  GET /auth/me

GET    /documents                      library: readable live documents with per-stage state
GET    /documents/deleted              your deleted documents with purge progress
POST   /documents                      multipart file (+ title); Idempotency-Key → 201 | 200 duplicate | 415 | 422 | 503
POST   /documents/:id/versions         new version (owner) → 201 | 200 unchanged
GET    /documents/:id                  detail: document, versions, jobs with attempt logs, events
GET    /documents/:id/text?version=    extracted text (citation highlight view)
GET    /documents/:id/chunks?version=  chunks with offsets, embedded/indexed flags
PATCH  /documents/:id/sharing          {scope, groupId} (owner)
DELETE /documents/:id                  tombstone + purge (owner) → 202
POST   /documents/:id/retry            retry a poisoned stage (owner)

GET    /groups                         groups, members, org users
POST   /groups/:id/members             {userId} (org admin)
DELETE /groups/:id/members/:userId     (org admin)

POST   /answers                        {question} → 202 {run}
GET    /answers | /answers/:id         history (re-validated, redacted where access was lost)
GET    /answers/:id/stream             SSE: status, cache, retrieval, delta, completed | failed | cancelled; Last-Event-ID resumes
POST   /answers/:id/cancel             → 202 (works from any instance)

GET    /ops/overview                   operator: queue depth, jobs matrix, poisoned jobs, purge backlog, stale index rows, runs, switches
POST   /ops/jobs/:id/retry
PUT    /ops/chaos                      {name, value}: kill_mid_chunk, blob_outage, acl_sync_paused, purge_paused, activation_delay_ms
PUT    /ops/embedder | /ops/model      proxy to the mock services' fault knobs
```

Example:

```bash
curl -b jar -H 'Idempotency-Key: 4f1c…' -F file=@expense-policy.md localhost:3000/api/v1/documents
# → 201 {"duplicate":false,"document":{"id":"doc_…","status":"uploaded","stages":[…]},"versionId":"ver_…","versionNo":1}
# same request again → 201, Idempotent-Replayed: true, same document
curl -b jar -H 'Content-Type: application/json' -d '{"question":"How long do I have to submit expense receipts?"}' localhost:3000/api/v1/answers
# → 202 {"run":{"id":"run_…","status":"queued",…}}; then GET /answers/run_…/stream
```

## Key Design Decisions

### 1. The index is a pre-filter; PostgreSQL is the authority on access

The alternative is to make the index authoritative: update every index row synchronously inside the sharing transaction, and purge caches before acknowledging a revoke. That couples a user-facing write to the slowest system in the path (a sharded vector index, possibly another vendor), turns "unshare" into a distributed transaction, and still leaves gaps: an index replica that applied the change late, a cache entry written by a run that started before the revoke, a session claim from an hour ago. We let every copy lag and make one cheap, authoritative check at the last point before content is used. The cost is a second query per question and the discipline that every content-serving path (retrieval, cache, history, document pages) goes through it.

### 2. Re-check on every question, rather than invalidate on every change

Invalidation-based designs need to find every derived copy when access changes: index rows, cached answers keyed by question, conversation context, prompt caches. Missing one leaks. Validation on read needs only that each copy record *which documents it depends on*, which is true by construction for retrieval candidates (they carry the chunk id) and for cache entries (they store their context list). The re-check reads the truth in the same snapshot, so revocation is immediate without any fan-out. What we give up: a few milliseconds per question, and grants become visible only when the lazy sync widens the index (seconds), which is the safe direction to be stale in.

### 3. Deterministic chunk identity and keyed upserts make every stage redoable

Exactly-once processing across a queue, a worker and a database is not available; at-least-once delivery plus idempotent writes is. Chunk ids derive from (version, ordinal), the chunker is a pure function, and every write is an upsert on a natural key. A redone stage converges on the same rows. The alternative, random chunk ids with "delete everything for this version, then insert", is also idempotent but turns every retry into a full rewrite and invalidates embeddings keyed by the old ids, re-billing the embedding provider for work already done.

### 4. Process the new version fully, then switch one pointer

Updating chunks in place (delete v1's rows, insert v2's) leaves a window where a question sees half a document, or none. Indexing v2 alongside v1 and switching `current_version_id` in one row update gives every question one consistent version, because the re-check reads that pointer in the same snapshot as the candidates. The cost is double index space for a document during the overlap and a retire job afterwards; the 5 s retire delay keeps the old chunks around for answers already reading them.

### 5. Tombstone first, purge later, track each artifact

Synchronous deletion across five stores would make DELETE fail whenever any of them is down, and a partial failure would leave some copies behind with no record. The tombstone is one row update that every read path already filters on, so the user-visible delete is instant and atomic. The physical purge is asynchronous, idempotent, tracked per artifact ("purged 4/5") and retried until it completes, which gives the operator, and an auditor, a completion time per document. The cost is a window where content still physically exists; nothing can read it because the tombstone is checked on every read, including cache reads.

### 6. Multipart upload through the API (locally), presigned PUT at scale

Through the API: one request, hash and type check before anything is recorded, dedupe at once, and no pending-upload garbage to collect. It costs API bandwidth and memory proportional to file size, which is fine at 5 MB and wrong at 500 MB. Presigned PUT removes the API from the byte path, but dedupe then depends on a client-declared hash that must be verified after the fact, and abandoned uploads need a sweeper. The upload service keeps the same idempotency and dedupe transaction either way; only where the bytes travel changes.

### 7. Answer runs execute on the accepting API instance, streams live in Valkey

A separate answer-worker fleet behind a queue would add a hop to every question for little gain at this scale. Executing on the accepting instance and writing every event to a per-run Valkey stream decouples who runs the answer from who streams it: any instance can serve a reconnect from `Last-Event-ID`. The run row is the durable record; the heartbeat plus the sweeper cover a dead instance. At much larger scale, a dedicated LLM gateway with slot accounting takes over execution; the stream contract stays.

## Consistency and Idempotency

- **Upload:** idempotency key + request hash under an advisory lock; content-hash dedupe under a second advisory lock; one transaction for rows, job and idempotency record.
- **Pipeline:** at-least-once tickets; claims conditional on status and lease; completion fenced by the lease token; next job enqueued in the completing transaction with `ON CONFLICT DO NOTHING`; writes upserted on natural keys; attempts counted per claim; poison after N.
- **Version switch:** decided under `SELECT … FOR UPDATE` on the document row, monotonic by version number.
- **Retrieval:** one `REPEATABLE READ READ ONLY` snapshot for the ANN query and the re-check.
- **Sharing:** the scope change and the epoch bump commit together; `sync_acl` is re-armed (generation bump), so the latest change always wins.
- **Delete:** tombstone, job cancellations, purge tasks and the purge job in one transaction; purge is idempotent per artifact.
- **Runs:** server-assigned id; state transitions are conditional updates; the event stream is append-only and replayable; cancel is idempotent.
- **Clocks:** every lease, retry time and heartbeat comparison uses PostgreSQL's `now()`. After a laptop sleep the Docker VM clock lags the host by seconds, and mixing clocks shifted retries in an earlier project.

## Security / Auth

- **Sessions:** opaque id in an httpOnly, SameSite=Lax cookie; session data in Valkey. The session carries the user's group ids as *claims* used only for the index pre-filter.
- **Roles:** `member` (reads what is shared with them, owns their uploads), `org_admin` (also manages groups), `operator` (ops page only; sees ids and counts, never titles, text or questions).
- **Tenant isolation:** every query is scoped by the session's org; the index query filters by org inside the search; a document in another org is a 404, never a 403, so existence isn't confirmed. Dedupe never returns or reveals documents the uploader can't read.
- **Owner-only mutations:** sharing, new versions, delete, retry.
- **Upload limits:** 5 MB, extension allowlist, strict UTF-8 decoding, scripts and styles stripped from HTML. Text is rendered as text in the UI, never as HTML.
- **Prompt-injection posture:** retrieved text is wrapped in numbered source blocks and the system prompt restricts the model to them; the model has no tools, so an injected instruction can at worst distort one answer, and the re-check means it can only ever come from a document the asker can read.
- **Production additions:** SSO/OIDC, malware scanning in quarantine before extract, KMS-encrypted blobs with per-tenant keys (crypto-shredding as a purge backstop), audit log export.

## Observability

Each process exposes Prometheus metrics (`/metrics`; workers on their own port) and Pino JSON logs tagged with the process name.

| Metric | Labels | Why |
|--------|--------|-----|
| `docqa_uploads_total` | outcome (created, new_version, duplicate, unchanged, idempotent_replay, rejected) | Dedupe and retry rates |
| `docqa_job_attempts_total` | stage, outcome | Retry and poison rates per stage; a spike in `lost` means workers are dying |
| `docqa_job_duration_seconds` | stage | Which stage is the ingestion bottleneck |
| `docqa_embedder_calls_total` | result (ok, rate_limited, retryable_error, error) | Provider health and throttling |
| `docqa_recheck_dropped_total` | reason | **The key safety signal.** A sustained rise in `staleIndex` drops means the metadata sync is behind; any drop at all means the pre-filter alone would have leaked |
| `docqa_answer_cache_total` | result (hit, miss, rejected) | Cache value, and how often access changes invalidate answers |
| `docqa_answer_runs_total` | status | Failure and cancel rates |
| `docqa_answer_ttft_seconds` | — | The user-perceived latency SLO |

The ops page shows queue depth (RabbitMQ management API), jobs by stage × status, running jobs per worker, poisoned jobs with retry, the purge backlog with per-artifact progress, **stale index rows** (index entries whose epoch is behind their document's), recent runs with usage, and every fault switch. Each document page shows its processing timeline with every attempt, worker, outcome and error.

## Failure Handling

| Failure | Behaviour |
|---------|-----------|
| Worker dies mid-stage | Ticket redelivered; lease taken over; stage redone from keyed writes; previous attempt recorded `lost`; supervisor restarts the process |
| Worker freezes (laptop sleep, GC) | Heartbeat stops; lease expires; sweeper reclaims; if it wakes up, its writes are fenced by the lease token |
| Ticket lost (crash between commit and publish, broker restart) | `dispatched_at` empty or old → the sweeper republishes |
| RabbitMQ down | Uploads still commit (jobs wait with `dispatched_at = NULL`); supervised connections reconnect after it returns; the sweeper drains |
| Embedder 429 / 503 | Retried inside the attempt with Retry-After or jittered backoff; the lease is heartbeated meanwhile |
| Embedder 500 / down | Attempt fails; job retried with backoff; poisoned after 3; owner or operator retries |
| Corrupt or unsupported file | Permanent failure with a reason, no retries (or 415 at upload) |
| MinIO down | Upload → 503 (retry with the same key). Extract → retried. Purge → that artifact retried indefinitely, others finish. Blob calls time out after 15 s so a half-dead endpoint can't hold a lease forever |
| Valkey down | Sessions live there, so requests are unauthenticated until it returns; the answer cache and run streams are unavailable. No document, job or run state is lost |
| Model overloaded (529) / error before streaming | Run fails with the reason; the user re-asks |
| Model drops mid-stream | Run fails with the partial output kept and usage recorded |
| API instance dies mid-answer | Sweeper fails the run after 15 s with the partial output flushed by the last heartbeat; a client stream sees the `failed` event |
| Index metadata sync behind or paused | No safety impact: the re-check drops stale rows; grants appear late |
| A stage writes after the tombstone | Purge waits for live leases, then verifies nothing came back; re-purges if it did |

## Scalability Considerations

What breaks first, in order:

1. **Vector index memory.** 1.25B chunks × (4 KB vector + graph) ≈ 8 TB. Shard the index by tenant (hash of org id; big tenants get their own shards), which also makes the tenant filter physical. Use quantization (int8 or product quantization) to cut memory 4-8× with a re-rank on full vectors. pgvector shards work to tens of millions of vectors per node; beyond that a dedicated engine (Vespa, OpenSearch k-NN, a managed vector database with namespaces) is the usual step. The re-check doesn't change.
2. **Embedding throughput.** The provider's rate limit caps ingestion. Batch aggressively, cache embeddings by chunk-text hash across versions (most of a new version is unchanged text), run separate queues and quotas per tenant so one tenant's bulk import can't starve everyone's single uploads, and prefer a self-hosted embedding model for bulk re-indexing.
3. **PostgreSQL writes.** Measured 6.6 row writes per chunk including job bookkeeping. At 4,000 chunks/s peak that is ~26k writes/s on the metadata database: shard by org, move chunk text and embeddings out of the OLTP database (object store + the vector engine), and batch progress updates.
4. **The re-check.** One batched primary-key query per question (~600/s at peak) against the ACL tables. It must read the primary (or a replica proven caught up past the latest access change, e.g. by waiting for its replay LSN), because a lagging replica would reintroduce the revoke window. ACL rows are tiny and hot, so this stays cheap.
5. **Answer streaming.** ~3,000 concurrent SSE streams at peak: horizontally scaled stateless API instances; Valkey streams sharded by run id; the LLM gateway enforces per-tenant concurrency and token budgets.
6. **Purge backlog.** Purge is cheap per document but bursts (an org deletes 100k documents). Rate-limit per tenant, delete by prefix in the object store, and track SLOs on `purge_completed_at - deleted_at`.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Authority on access | PostgreSQL, re-checked per candidate | The index's metadata | Copies lag; a stale copy must never decide |
| Where the index filters | Inside the ANN query (iterative scan) | Post-filter a global top-k | Post-filtering starves answers and leaks cost across tenants |
| Revocation | Validate on read (re-check, cache validation) | Invalidate every copy synchronously | No fan-out to find every copy; immediate by construction |
| Index metadata | Lazily synced by a job | Updated inside the sharing transaction | Decouples user writes from the slowest store; staleness is safe |
| Stage idempotency | Derived chunk ids + upserts on natural keys | Delete-and-reinsert per stage | Redo converges on the same rows; embeddings keep their keys |
| Embed vs index | Separate stores | Embed straight into the index | Rebuild the index without re-billing embeddings |
| Version update | Index v2 alongside, switch one pointer, retire later | Update chunks in place | No half-documents, no mixed versions |
| Deletion | Tombstone first, tracked async purge | Synchronous multi-store delete | Instant and atomic for users; complete and auditable later |
| Dedupe scope | Per tenant, only documents the uploader can read | Per tenant regardless of access | Never reveals a hidden document's existence |
| Upload path | Multipart through the API (locally) | Presigned PUT | Hash and validate before recording; presign at large sizes |
| Answer cache key | Org + user + question, validated on read | Org + question | Retrieval depends on the reader; validation makes either safe |
| Run execution | Accepting instance, events in Valkey streams | Separate answer workers | One fewer hop; any instance can resume a stream |
| Retries | In PostgreSQL (`next_run_at`), swept | Broker TTL / delayed queues | Visible, cancellable, on one clock |

## Implementation Notes

### Local architecture

| Process | Default port | Entry | Production counterpart |
|---------|--------------|-------|------------------------|
| API (×2; `dev:server1` adds 3001) | 3000 | `backend/src/api/index.ts` | Document and answer services behind a gateway |
| Pipeline workers (×2, supervised) | 3102, 3103 (metrics) | `backend/src/worker/supervisor.ts` → `worker/index.ts` | Autoscaled per-stage worker pools |
| Mock embedder | 3100 | `backend/src/embedder/index.ts` | Embedding provider or GPU service |
| Mock model | 3101 | `backend/src/model/index.ts` | LLM gateway + provider |
| Frontend | 5173 | `frontend/` | Web app |
| PostgreSQL 16 + pgvector 0.8, RabbitMQ 3.13 (quorum queue), Valkey 7, MinIO | 5432, 5672/15672, 6379, 9000/9001 | `docker-compose.yml` | Sharded PostgreSQL + vector engine, RabbitMQ/Kafka, Valkey cluster, S3 |

### Production-grade patterns actually implemented

- **Access enforced twice** (`api/services/retrieval.ts`, `api/services/recheck.ts`, `shared/access.ts`): pre-filter inside the HNSW and full-text queries, then a same-snapshot re-check with drop reasons. Verified live with the metadata sync paused and with stale session claims.
- **Validated answer cache** with a per-document reverse index (`api/services/answer-cache.ts`), and history redaction on read (`api/routes/answers.ts`).
- **Leased, fenced, keyed pipeline jobs** with takeover on redelivery, poison after N, lost-attempt records and a SKIP LOCKED sweeper (`pipeline/jobs.ts`, `worker/run-ticket.ts`, `worker/sweeper.ts`). Verified by killing a worker mid-chunk with a real `process.exit`.
- **Atomic version switch** under a row lock with delayed retirement (`pipeline/stages.ts`, `pipeline/stage-core.ts`).
- **Tombstone-first deletion with a tracked, idempotent purge** that waits for in-flight stages and verifies afterwards (`api/services/lifecycle.ts`, `pipeline/stages.ts`). Verified through a real MinIO outage.
- **Idempotent, visibility-scoped dedupe** on upload (`api/services/uploads.ts`).
- **Durable streamed runs** with Valkey streams, `Last-Event-ID` resume across instances, cross-instance cancel and heartbeat-based failure (`api/services/answer-runner.ts`, `api/services/run-events.ts`).
- **Supervised RabbitMQ connections** and confirm-channel publishing (`shared/queue.ts`), Prometheus metrics, Pino logs, `/health` and `/ready` on every process, zod validation, camelCase DTOs, timeouts on blob calls.

```typescript
// worker/run-ticket.ts: the stage's final writes, its completion and the next job commit together
const toPublish = await withTransaction(async (client) => {
  const ids = ((await outcome.finalize?.(client)) ?? []).slice()            // e.g. the version switch
  if (!(await completeJob(client, job, outcome.detail))) throw new SupersededError('lease lost before commit')
  for (const spec of outcome.next ?? []) { const id = await enqueueJob(client, spec); if (id) ids.push(id) }
  return ids
})
if (await publisher.publish(toPublish)) await markDispatched(toPublish)       // else the sweeper publishes
```

### Simplified or substituted

- One PostgreSQL holds the metadata, chunks, embeddings and the HNSW index (production: sharded metadata, a separate vector engine, chunk text in object storage).
- A hashed bag-of-terms embedding (256 dimensions) and an extractive mock model instead of real models; both are deterministic, so tests and screenshots are reproducible. A real Anthropic provider can be enabled with `ANTHROPIC_API_KEY`.
- MinIO for S3; multipart upload through the API instead of presigned PUTs.
- Session auth with group claims instead of OIDC tokens.
- Two worker processes under a tiny supervisor instead of an orchestrator; one queue for all stages instead of per-stage pools.
- Compressed timings (1-15 s backoff, 5 s retire delay, 3 s metadata sync); every knob is an environment variable.
- `.txt`, `.md` and `.html` only; PDF and OCR are not built.

### Omitted

Multi-region, per-tenant index shards and quantization, malware scanning, per-tenant encryption keys and crypto-shredding, OCR/PDF/Office extraction, conversation memory (multi-turn chat), reranking models, embedding caches across versions, per-tenant ingestion quotas, prompt caching, evaluation of answer quality, billing.
