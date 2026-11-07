# Document Q&A — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Requirements → Architecture → Data model → Upload → Pipeline → Retrieval → Deep dives → Traces → Scale*

> "The prompt: users upload documents, we extract, chunk, embed and index them, answer questions with citations, and support deletion. Retrieval-augmented generation is easy to draw as three boxes, so before I draw them I want to name where it goes wrong. The vector index has to carry a copy of each chunk's tenant and sharing scope so it can filter during the search, and copies go stale. Someone unshares a document, leaves a group, or deletes a file, and for a while the index and the answer cache still say 'readable'. If the index is treated as the authority on access, that window is a data leak. So my rule is: PostgreSQL decides who can read what; the index and the caches only remember. Every chunk the index returns is re-checked against the source of truth before it reaches a prompt, and every cached answer is validated the same way when it's read. The rest of the design is about making a four-stage pipeline safe to redo, switching versions without ever mixing them, and deleting things immediately and then completely."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Requirements | ~5 min | Access correctness is the top requirement; revocation is immediate |
| Architecture | ~5 min | PostgreSQL decides; queue tickets, index metadata and caches are copies |
| Data model and API | ~4 min | Documents and versions, chunks keyed by (version, ordinal), jobs keyed by (version, stage) |
| Upload and pipeline | ~8 min | Idempotent, visibility-scoped dedupe; leased jobs; every stage redoable |
| Deep dives | ~13 min | Access enforced twice; a worker killed halfway; versions and deletion |
| Traces and checklist | ~6 min | One success, one failure, six review questions |
| Scale and wrap-up | ~4 min | Vector memory and the embedding rate limit break first, with numbers |

---

## 🎯 Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who can see a document? | Decides the access model the index must carry | Org-scoped: private to the owner, shared with a group, or org-wide |
| How fast must an unshare or a group removal take effect? | Decides whether lazy index updates are acceptable | On the next question. "I unshared it" must not mean "in a few minutes" |
| Do deletes need proof of removal? | Purge tracking, compliance | Yes: invisible at once, physically purged with a completion time per document |
| Do documents change? | Version handling | Users upload new versions; answers must never mix versions |
| Which formats? | Extract stage scope | Text, Markdown and HTML now; PDF and OCR later behind the same stage |
| Is the embedding model rate-limited? | Ingestion throughput and retries | Yes, it returns 429s; ingestion must slow down, not fail |

### Functional requirements

1. Upload with an `Idempotency-Key`; the same bytes within a tenant return the existing document (if the uploader can read it). Corrupt or unsupported files fail with a reason.
2. Process each version through extract → chunk → embed → index, with per-stage status and attempts; poison after N attempts with a reason and a retry action.
3. Chunk with overlap, keeping character offsets and headings, so citations highlight exact spans.
4. Answer questions over SSE with numbered citations, or "not found in your documents". Each question is a durable run (queued → running → completed | cancelled | failed) with recorded usage.
5. Share as private, group or org-wide; revoke takes effect on the next question.
6. Upload new versions: process fully, switch atomically, retire the old chunks later.
7. Delete: tombstone first, then purge blobs, chunks, embeddings, index rows and cached answers, tracking completion.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Access correctness | Zero chunks a user can't read *now* in any prompt, citation or cached answer | A final check against the source of truth on every content path |
| Revocation | Effective < 1 s after commit | Can't wait for index sync or cache invalidation |
| Delete | Invisible at commit; purged within 24 h (seconds when healthy) | Tombstone + tracked async purge |
| Answer latency | First token p50 < 1.5 s, p99 < 4 s; retrieval p99 < 150 ms | The re-check must be one cheap batched query |
| Ingestion | Upload → ready p50 < 30 s; no loss through outages | Durable jobs, resumable stages |
| Isolation | No cross-tenant reads, and no existence leaks via dedupe | Tenant filter inside the search; visibility-scoped dedupe |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Documents | 50M live, 2M uploads/day (≈ 23/s, 150/s peak) | 10k orgs, 2M users |
| Chunks | ~25 per document → 1.25B | 40 KB of text, 512-token chunks with 64 overlap |
| Vectors | 1024 dims × 4 B → 5 TB, ~8 TB with the HNSW graph | Must be sharded |
| Embedding demand | ~580 chunks/s average, 4,000/s peak | The provider's rate limit is the ceiling |
| Questions | 10M/day ≈ 115/s, 600/s peak; ~3,000 concurrent streams | 5 per user per day, 3-8 s streams |
| Re-check | 600 batched primary-key lookups/s at peak | Cheap, which is why we can always run it |

> "The expensive things here are vector memory, the embedding provider's quota and the LLM. The thing that makes access correct, the re-check, is a primary-key lookup of 24 rows. That's the asymmetry I'm going to lean on."

---

## 🏗️ High-Level Architecture (~5 min)

```
 Client ──REST/SSE──▶ API gateway ──┬──▶ Document service ──┬──▶ Object store (one key per version)
                                    │    upload · dedupe ·  │
                                    │    sharing · delete   └──▶ PostgreSQL  ◀── SOURCE OF TRUTH
                                    │                            documents · versions · scope · groups
                                    │                            tombstones · chunks · jobs · runs
                                    │                                 │  job rows = outbox
                                    │                                 ▼
                                    │                        Queue (tickets {jobId})
                                    │                                 │
                                    │              ┌──────────────────▼───────────────────┐
                                    │              │ Pipeline workers + sweeper            │
                                    │              │ extract → chunk → embed → index        │──▶ Embedding service
                                    │              │ retire · sync_acl · purge              │    (batches, 429s)
                                    │              └──────────────────┬───────────────────┘
                                    │                                 ▼
                                    │                  Vector index: chunk + COPY of tenant,
                                    │                  version, scope (pre-filter only)
                                    │                                 ▲
                                    └──▶ Answer service ─── ANN ──────┘
                                         cache check → embed query → pre-filtered ANN
                                         → RE-CHECK in PostgreSQL (same snapshot)
                                         → prompt → LLM stream → citations
                                              │                │
                                              ▼                ▼
                                   Valkey: answer cache,   LLM gateway
                                   run event streams,
                                   cancel channel
```

Two rules shape every arrow:

- **PostgreSQL decides; everything else remembers.** Queue messages are pointers to job rows. Index rows carry a lazily synced copy of access metadata. Valkey entries must pass validation before they're served. Losing any of those delays work or costs a recomputation; it never changes who can read what.
- **Every stage is keyed and redoable.** Jobs are unique per (version, stage), chunks per (version, ordinal), embeddings and index entries per chunk id. Running a stage twice rewrites the same rows.

> "Locally this is one PostgreSQL with pgvector holding both the metadata and the HNSW index, RabbitMQ, Valkey, MinIO, two API instances, two supervised workers, a deterministic mock embedder and a mock model that streams extractive answers with citations."

---

## 💾 Data Model (~2 min)

| Table | Key columns | Indexes | Notes |
|-------|-------------|---------|-------|
| documents | id, org_id, owner_id, title, scope (private / group / org), group_id, current_version_id, latest_version_no, status, acl_epoch, deleted_at, purge_completed_at | (org_id, updated_at) where live; purge backlog | The tombstone and the current-version pointer live here. acl_epoch bumps on every sharing change and delete |
| document_versions | id, document_id, version_no, content_hash, blob_key, status, failure_reason, chunk_count | unique (document_id, version_no); (org_id, content_hash) | Status: uploaded → processing → ready → superseded → retired, or failed |
| version_texts | version_id, text, headings | primary key | Output of extract; citation offsets index into this text |
| chunks | id = chk_<version>_<ordinal>, version_id, ordinal, text, char_start, char_end, heading | unique (version_id, ordinal); full-text index | Derived ids make a redo rewrite the same rows |
| chunk_embeddings | chunk_id, model, vector | version_id | The expensive artifact, kept apart from the index |
| index_entries | chunk_id, org_id, document_id, version_id, owner_id, scope, group_id, acl_epoch, vector | HNSW (cosine); (org_id, scope) | The retrieval index. Access columns are a copy, pre-filter only |
| processing_jobs | job_key (unique), stage, status, attempts, max_attempts, lease_owner, lease_token, lease_expires_at, next_run_at, dispatched_at, generation, progress | due (pending); lease (running) | The unit of work and the outbox at once |
| job_attempts | job_id, attempt_no, worker_id, outcome, error, detail | (job_id, attempt_no) | Outcome: succeeded / retry / failed / poisoned / lost / superseded |
| purge_tasks | document_id, artifact (cache / index / embeddings / chunks / blobs), status, attempts, removed, last_error | primary key (document_id, artifact) | "Purged 4/5" |
| upload_requests | user_id, idempotency_key, request_hash, response | primary key | Replayed on retry |
| answer_runs | id, user_id, question, status, output_text, sources, citations, retrieval, cache, token and latency columns, heartbeat_at | (user_id, created_at) | The durable record of a question |

---

## 🔌 API Design (~2 min)

```
POST   /api/v1/documents                 multipart + Idempotency-Key → 201 | 200 duplicate | 415 | 503
POST   /api/v1/documents/:id/versions    new version (owner) → 201 | 200 unchanged
GET    /api/v1/documents                 library (only what you can read now)
GET    /api/v1/documents/:id             detail: versions, jobs with attempt logs
GET    /api/v1/documents/:id/text        extracted text, for citation highlights
PATCH  /api/v1/documents/:id/sharing     scope + group (owner)
DELETE /api/v1/documents/:id             tombstone + purge → 202
POST   /api/v1/documents/:id/retry       retry a poisoned stage
DELETE /api/v1/groups/:id/members/:user  remove from group (org admin)
POST   /api/v1/answers                   question → 202 with run id
GET    /api/v1/answers/:id/stream        SSE, resumable with Last-Event-ID from any instance
POST   /api/v1/answers/:id/cancel        Stop
GET    /api/v1/ops/overview              queue depth, jobs by stage, poisoned, purge backlog, stale index rows
```

---

## 📥 Upload: idempotency and dedupe (~3 min)

One transaction per upload:

1. **Idempotency.** An advisory lock on (user, key), then look up the stored response. Found: replay it with an "Idempotent-Replayed" header. Same key with different bytes: 422. Two concurrent retries serialize on the lock, so they produce one document. We tested exactly that, firing both at the two API instances at once.
2. **Dedupe.** An advisory lock on (org, content hash), then look for a live document in this org whose current version has the same hash **and which the uploader can read**. If there is one, return it as a duplicate and create nothing.
3. **Store.** PUT the blob under a per-version key, insert the document and version rows, the extract job and the idempotency record, commit, then publish the job's ticket. If the object store is down, everything rolls back with 503 and a retry with the same key is safe.

> "The dedupe semantics are the interesting decision. If carol uploads a file that's byte-identical to alice's *private* document, the naive design returns alice's document, or says 'duplicate exists'. Either one tells carol that a hidden document with exactly this content exists, which for a leaked memo is the whole secret. So dedupe is scoped to what the uploader can read: carol gets her own document. Across tenants there's no dedupe at all."

Bytes go through the API as multipart because the API must hash and type-check them before anything is recorded. At 5 MB that's simpler than a presigned PUT. For 500 MB PDFs I'd switch to a presigned PUT into a quarantine prefix: the client declares the hash, and the extract stage verifies it. That costs one more round trip and a sweeper for abandoned uploads.

---

## ⚙️ Pipeline: leased jobs and redoable stages (~5 min)

A job row is the unit of work. RabbitMQ carries only `{jobId}`. A worker claims a job with a conditional update. It can take a pending job that's due, or a running one whose lease expired. It can also take a running job whose ticket was *redelivered*, because the broker only redelivers after the previous holder's channel died. Every claim counts as an attempt, so a document that kills the worker every time gets poisoned instead of crash-looping the fleet. Completion is fenced by the lease token, and the next stage's job is inserted in the same transaction with "on conflict do nothing", so a stage that commits twice can't create two next jobs.

| Stage | Writes, keyed by | Why a redo is safe |
|-------|------------------|--------------------|
| extract | extracted text, by version | Same bytes give the same text |
| chunk | chunks, by (version, ordinal), in batches of 4 | The chunker is a pure function and ids are derived, so a redo rewrites the same rows |
| embed | embeddings, by chunk id | Only chunks without an embedding are sent, so a redo resumes |
| index | index entries, by chunk id, with the document's *current* access metadata, then the version switch | Upsert; the switch is decided under a row lock |
| retire | deletes a superseded version's chunks, embeddings and index rows | Deleting nothing is fine |
| sync_acl | copies scope, group and epoch onto index rows that are behind | Rewrites only stale rows |
| purge | removes one artifact at a time, marking each done | Done artifacts are skipped |

**Retries live in PostgreSQL**, not the broker. A failed attempt writes `next_run_at` as database now plus an equal-jitter backoff (1 s, 2 s, 4 s, capped at 15 s locally). A sweeper inside each worker uses skip-locked claims to do three things: publish jobs that are due, republish jobs whose ticket went missing, and reclaim expired leases. A corrupt file (NUL bytes, invalid UTF-8) is a *permanent* error: it's poisoned on the first attempt with its reason, without burning retries. Three failures of anything else poison the job. The version, and the document if nothing is being served yet, then becomes failed with a reason like "embed failed after 3 attempts: embedder returned 500", plus a Retry button that resets the job.

**The embedder's 429s are retried inside the attempt.** The embed stage honours Retry-After (or backs off exponentially) and heartbeats its lease while it waits. A 429 means "slow down", not "broken", so it shouldn't spend one of three attempts. In the end-to-end run, three armed 429s were absorbed in one attempt, recorded as three rate-limited retries, and the stage waited the full three seconds.

**Chunking with offsets.** Sentences accumulate to about 120 tokens locally (512 in production). The next chunk restarts on whole sentences overlapping the previous tail. A heading starts a fresh chunk, and each chunk records its heading. The invariant, tested and checked live, is that slicing the extracted text at a chunk's start and end gives back exactly the chunk. That's what lets a citation point at the exact cited sentence. The mock model answers extractively, so the API finds the cited sentence verbatim inside the chunk and stores its absolute offsets.

---

## 🔎 The answer path (~2 min)

1. `POST /answers` inserts a run as queued and returns 202 with its id. The accepting API instance executes it and appends every event to a per-run Valkey stream.
2. **Cache.** Look up org + user + hash of the normalized question, then validate the entry before serving it (Deep Dive 1).
3. **Embed the question**, then open one repeatable-read snapshot for the next two steps.
4. **Pre-filtered search.** Run the HNSW query and a full-text query, both filtered by tenant and the index's copy of scope inside the search. Fuse them with reciprocal rank fusion and over-fetch 24 candidates for 5 context slots.
5. **Re-check every candidate** against the source of truth in the same snapshot. Record each drop's reason on the run.
6. **Prompt, stream, cite.** Build a prompt from the numbered sources, stream the model's answer, map each `[n]` to an exact span, record usage and cache the answer.

**Stop** sets a cancel flag and publishes on a channel every instance hears. **A mid-stream model failure** (the socket closes before the stream's end event) fails the run and keeps the partial text, which the heartbeat has been flushing every second. Usage is recorded either way. **If the executing instance dies**, the sweeper fails the run once its heartbeat is 15 s stale. Any instance can serve a reconnect from `Last-Event-ID`, so the client resumes without gaps.

---

## 🔧 Deep Dive 1: Access enforced twice, and why the index is never the authority (~5 min)

**Decision.** Filter by tenant and scope *inside* the vector search, using the index's copy of the access metadata. Then re-check every candidate against PostgreSQL in the same snapshot, before it can enter a prompt or a citation. A candidate survives only if:

- its chunk still exists;
- its document isn't tombstoned and is in the asker's org;
- its version is the document's *current* version;
- the asker can read it right now: owner, org-wide, or a live member of the shared group;
- the asker's account is active.

The index metadata is updated lazily by a job a few seconds after a sharing change. The user's group ids ride in the session as claims refreshed every five minutes. The re-check reads neither.

**Why it works here.** A stale copy can be wrong in only two directions.

- **Too narrow.** A new share isn't synced yet, so the document is missed for a few seconds. That costs recall and is safe.
- **Too wide.** A revoke isn't synced yet, or a group removal isn't in the session claims yet. That would leak, and it's exactly what the re-check closes.

We proved both live. With the metadata sync paused, alice unshared a document. Its index rows still said "group". Carol's next question retrieved them, and the re-check dropped them as "private to its owner", flagged as a stale index row. Then alice removed carol from Engineering. Carol's session still listed Engineering, her next question still pulled the group document from the index, and the re-check dropped it as "not a member". In both cases it was the very next question. The re-check costs one primary-key query for at most 24 chunks: about 51 ms for the whole retrieval locally, including the ANN.

**Why the alternatives break.**

- *Post-filter a global top-k.* With 10,000 tenants, the 24 nearest chunks to "what's our retention period?" are mostly other tenants' retention policies. After filtering, the answer is starved, or reads "not found", while the right chunk sits at rank 400. Raising k makes every query pay for every tenant's data. HNSW has the same problem inside its graph walk when the filter is selective, which is why I use pgvector's iterative scan, and per-tenant shards at scale.
- *Make the index authoritative:* update every index row and purge every cache inside the unshare transaction. That turns a one-row write into a distributed transaction across a sharded vector store and Valkey, so it fails or slows whenever they do. It still misses copies you didn't think of: a session claim, an index replica, a run that started a second before the revoke and writes its cache entry a second after.
- *Re-check against a cache of permissions.* That's just another stale copy.

**What we give up.** A second query on every question, and the discipline that *every* content path goes through the same rule: retrieval, the answer cache, history and document pages. Grants show up only once the sync widens the index, a few seconds later. And the re-check must read the primary, or a replica proven caught up past the revoke, or replica lag reopens the window.

| Approach | Revocation latency | Leak risk | Cost |
|----------|--------------------|-----------|------|
| ✅ Pre-filter in the ANN + re-check the truth | Next question | None from stale copies | One batched PK query |
| ❌ Index as authority, lazily synced | Seconds to minutes | Real, during every sync lag | Cheapest |
| ❌ Synchronous index + cache invalidation | Immediate if every copy is found | Any copy you forgot | Distributed write on every share |
| ❌ Post-filter a global top-k | Next question | None | Starved answers, cross-tenant cost |

---

## 🔧 Deep Dive 2: A worker is killed after writing half a document's chunks (~4 min)

**Decision.** At-least-once tickets plus idempotent stages. Jobs are keyed by (version, stage) and leased. Chunk ids are derived from (version, ordinal), and every write is an upsert on a natural key. Takeover happens on redelivery or on lease expiry, and every claim is counted as an attempt.

**Why it works here.** We built a fault switch that does exactly this: armed once, a worker calls a hard process exit right after writing at least half of a version's chunks. In the end-to-end run it died after writing 12 of 17, without acking its ticket.

1. The broker saw the channel close and redelivered the ticket to the other worker, marked as redelivered.
2. That worker's claim took over the running job. It recorded attempt 1 as "lost, 12 of 17 written before exit" and started attempt 2.
3. The chunker produced the same 17 chunks with the same ids. The first 12 were upserts that changed nothing, and the last 5 were inserts.
4. The supervisor restarted the dead worker a second later.

Afterwards there were 17 rows, 17 distinct ordinals from 0 to 16, and one embedding each. Embed is just as safe: it only sends chunks with no embedding, so a crash after three of five batches costs two batches on the redo, not five, and never double-bills.

**Why the alternatives break.**

- *Exactly-once processing.* The queue can't give it to us across a worker and a database. The worker can commit and die before acking; that's the case being solved.
- *Random chunk ids with delete-then-insert per attempt.* That is idempotent too, but every retry rewrites the whole version. It also orphans embeddings keyed by the old ids, so the provider gets billed again for work already done.
- *Wait for lease expiry only.* Recovery takes a full lease (15 s here, a minute in production). Taking over on redelivery recovers in about a second, and the lease token still fences the old worker if it was merely partitioned and comes back.

**What we give up.** Determinism is a contract: changing chunk settings means a new version of the chunker, or the trim step removes ordinals past the new end. A worker that dies on the same document three times poisons it, so a bug can fail documents. That's intentional, because the alternative is a crash loop that takes the fleet down. And the job bookkeeping isn't free: we measured 6.6 PostgreSQL row writes per chunk. That's 86 for a 13-chunk document, about 47 of them fixed per document for jobs, attempts, progress and state.

---

## 🔧 Deep Dive 3: Versions that never mix, and deletes that are immediate and then complete (~4 min)

**Decision (versions).** Process the new version fully alongside the old one. Then switch the document's current-version pointer in one row update, decided under a row lock in the same transaction that completes the index job. Retire the old version's chunks five seconds later.

**Why it works here.** Retrieval reads that pointer in the same repeatable-read snapshot as the candidates, so for any one question each document has one current version. Every chunk of any other version is dropped as "not current". During the overlap both versions sit in the index: the new one's chunks are dropped until the switch, and the old one's after it. The activation rule is monotonic: a version activates only if the document is live and nothing newer is current, so a slow v2 can't overwrite a fast v3. In the end-to-end run we held the switch for eight seconds and asked continuously across it. Seven answers came from v1 and three from v2, and no answer drew from both.

**Why the alternative breaks.** Updating chunks in place means deleting v1's rows and then inserting v2's. That leaves a window where a question sees half a document or none, and an answer can quote paragraph 3 of v1 next to paragraph 4 of v2.

**Decision (deletion).** Write a tombstone first. One transaction sets deleted-at, bumps the access epoch, cancels the document's pending pipeline jobs, creates one purge task per artifact and enqueues the purge job. Every read path already filters on the tombstone, so the document is gone at commit. The purge then removes, in order:

1. cached answers, through a per-document reverse index (never a delete by key pattern), and scrubs persisted answers whose prompt used the document;
2. index rows;
3. embeddings;
4. chunks and extracted text;
5. every version's blob.

It waits while any stage still holds a live lease on the document, verifies afterwards that nothing came back, and records a completion time. A failure records its error on that artifact and retries with capped backoff, forever. When we stopped the MinIO container mid-purge, four artifacts completed, the blobs failed and retried, and the purge finished once MinIO returned. The library showed "purged 4/5" in the meantime.

**Why the alternative breaks.** A synchronous delete across five stores fails whenever any of them is down. A partial failure leaves copies behind with no record of which.

**What we give up.** Double index space for a document during a version overlap. A window where deleted content still physically exists: nothing can read it, because the tombstone is checked on every read, but it's there until the purge lands. And an operator SLO to watch: purge completion time minus deletion time.

| Concern | ✅ Chosen | ❌ Alternative | Failure of the alternative |
|---------|----------|---------------|---------------------------|
| New version | Index alongside, switch one pointer, retire later | Update chunks in place | Half-documents, mixed versions |
| Who wins a race | Monotonic by version number under a row lock | Last writer wins | A slow v2 overwrites v3 |
| Delete | Tombstone, then tracked idempotent purge | Synchronous multi-store delete | Fails on any outage; partial copies with no record |

---

## 🗝️ The Key Question: content outlives access. How is it never returned? (~2 min)

| Where content still sits after a revoke or delete | Why it's never returned |
|---------------------------------------------------|-------------------------|
| Index rows with the old scope (the sync is lagging or paused) | The re-check reads current scope and live membership; drops are counted per reason |
| Index rows of a deleted document (before purge) | The re-check sees the tombstone |
| Index rows of the old version | The re-check requires the current version, read in the same snapshot |
| The user's session group claims | Used only to pre-filter; never to decide |
| A cached answer that used the document | Validated on read: tombstone, live access, version and epoch for every document in its prompt, not only the cited ones. Rejected entries are deleted |
| Past answers in chat history | Re-validated when listed and redacted; the purge scrubs them for good |
| Blobs, chunks and embeddings awaiting purge | Only workers read them, and every user-facing path checks the tombstone first |

> "Notice that none of these rows says 'and then we invalidate it'. Invalidation and purge reclaim space. Correctness never waits for them. We proved that by holding purges with a switch, deleting a document whose answer was cached, and asking again. The entry was still in Valkey, and it was rejected on read as 'a source document was deleted'."

---

## 🧪 Execution Traces (~4 min)

### ✅ Success: a revoke the index hasn't caught up with

1. Alice shares "Deploy guide" with Engineering. One transaction sets the scope to group, bumps the epoch, and re-arms the document's metadata-sync job for three seconds later, when it rewrites the index rows.
2. The metadata sync is paused from the ops page. Alice unshares the document. The scope becomes private and the epoch bumps again. The sync job is re-armed but defers, so the index rows still say "group, Engineering".
3. Carol asks "At what time does the deploy freeze begin on Fridays?" on API instance A. A run is inserted as queued and she gets 202 with its id. Her browser opens the stream; it could just as well open it on instance B.
4. Instance A marks the run running and checks the cache: a miss. It embeds the question and opens a repeatable-read snapshot.
5. The pre-filtered HNSW and full-text queries use carol's org and her claimed groups, which include Engineering. They return the deploy guide's chunks among the candidates.
6. The re-check loads those chunks with their documents and carol's live account. The deploy guide is private to alice, so every chunk is dropped as "not owner", flagged as a stale index row. The remaining candidates come from documents carol can read.
7. The model streams its answer from those sources only. The run completes with its usage and a retrieval summary that says two chunks were dropped by the access re-check.
8. The sync is unpaused and rewrites the index rows to private. From then on the pre-filter excludes them itself.

The revoke took effect on the very next question, and the stale index never reached a prompt.

### ❌ Failure: an embedding outage poisons a document, and Retry recovers it

1. Three embedder 500s are armed. Alice uploads a file. The transaction commits the document, the version, the blob reference and the extract job, then publishes the ticket.
2. A worker claims extract and writes the text. In one transaction it marks extract succeeded and enqueues chunk. Chunk runs the same way and enqueues embed.
3. Worker 2 claims embed, attempt 1. The embedder answers 500, which is not a 429, so the attempt fails. The job goes back to pending with its next run at database now plus about 0.7 s, recorded as "retry". The ticket is acked.
4. The sweeper publishes the job when it's due. Attempt 2 fails the same way, now about 1.5 s out.
5. Attempt 3 fails. Attempts have reached the maximum, so the job is poisoned. In the same transaction the version and the document become failed with "embed failed after 3 attempts: embedder returned 500". The library shows the reason and a Retry button.
6. Alice clicks Retry. The poisoned job's attempts reset, the version goes back to processing, and the ticket is republished. The embedder is healthy now, so embed and then index succeed and the document is ready. The chunks written before the outage were not rewritten.

---

## ✅ Design Review Checklist

| Question | Answer |
|----------|--------|
| What is the source of truth, and when is a write successful? | PostgreSQL. An upload succeeds when its document, version, extract job and idempotency record commit, after the blob PUT. A stage succeeds when its final writes, its completion and the next job commit together. A delete succeeds at the tombstone commit; the purge has its own tracked completion. A sharing change succeeds at its commit, before the index catches up |
| What happens when a client retries after losing the response? | Upload: the same key replays the stored response; a different body gets 422; concurrent retries serialize on an advisory lock. The same bytes under a new key return the existing document if you can read it. A lost question response makes a second, harmless run; a lost stream resumes from Last-Event-ID on any instance |
| What happens when a worker or server fails between two important steps? | API between commit and publish: the job has no dispatch time, so the sweeper publishes it. Worker mid-stage: the ticket is redelivered, the lease taken over, and the stage redone from keyed writes (proven by a real kill). Worker after commit, before ack: the redelivered ticket finds nothing to claim. A frozen worker is caught by lease expiry, and its late writes are fenced. API mid-answer: the run fails after 15 s with its flushed partial output. MinIO during purge: that artifact retries, the others finish |
| Which ordering or consistency guarantee is actually required? | One consistent snapshot per question (one version per document, committed access). Monotonic version activation per document. Read-your-writes for access changes, so the re-check reads the primary. Not required: ordering across documents, or the index matching the truth in real time |
| How is access enforced when caches, indexes or asynchronous jobs are involved? | Twice: a tenant and scope pre-filter inside the index query, then a re-check of every candidate against PostgreSQL. Cached answers are validated per reader on read; history is redacted on read. Workers act as the system and never serve users. Operators see ids and counts. Dedupe never reveals documents you can't read |
| What breaks first at much larger scale, and what evidence supports that prediction? | Vector memory (~8 TB at 1.25B chunks) and the embedding quota (4,000 chunks/s at peak). Measured locally: 6.6 PostgreSQL row writes per chunk, 3 chunk-sized rows per chunk, and retrieval p50 51 ms / p95 66 ms. The re-check stays one batched primary-key query at any scale |

---

## ❓ Follow-ups

**We change the embedding model. Now what?** Embeddings are a separate artifact keyed by chunk id and model. Backfill new embeddings in a background pass with its own quota, build a second index, and flip retrieval to it per tenant. Chunks don't change, so citations and offsets stay valid. The re-check doesn't care which index produced the candidate.

**A tenant bulk-imports 100,000 documents. Does everyone else wait?** Not if ingestion is fair: per-tenant queues or a fair-share dispatcher, a per-tenant share of the embedding quota, and single uploads prioritised over bulk ones. Locally there's one queue. In production, that's the first thing I'd split.

**Could an uploaded document inject instructions into the model?** Yes; retrieved text is untrusted. It's wrapped in numbered source blocks, the model has no tools, and the system prompt restricts it to the sources. The re-check also means injected text can only come from a document the asker could already read, so the worst case is a distorted answer, not data exfiltration.

**Can we cache across users?** Yes. Key by an access fingerprint, the set of groups plus ownership, instead of the user, and keep validation on read. An answer built from documents another reader can't see then fails validation for that reader instead of leaking.

**What if the re-check reads a lagging replica?** Then a revoke isn't visible for the replica's lag, which reopens the window. Read the primary for the access tables (tiny, hot rows), or wait until the replica has replayed past the revoke.

---

## 📈 Scalability (~3 min)

| What breaks | When | Evidence | Fix |
|-------------|------|----------|-----|
| Vector index memory | ~1.25B chunks | 4 KB per vector plus the graph ≈ 8 TB | Shard by tenant, which makes the filter physical; quantize to int8 or PQ and re-rank; move to a dedicated engine with namespaces past tens of millions of vectors per node |
| Embedding throughput | Peaks and re-index days | The provider's 429s; locally, the embed stage dominates time-to-ready | Batch; per-tenant quotas; cache embeddings by chunk-text hash across versions; self-host for bulk |
| Metadata DB writes | ~4,000 chunks/s | 6.6 row writes per chunk, measured with pg_stat_database deltas | Shard by org; move chunk text and vectors out of the OLTP database; batch progress writes |
| Answer concurrency | ~3,000 streams | 600 questions/s × 5 s | Stateless API instances; Valkey streams sharded by run id; an LLM gateway with per-tenant slots |
| Purge bursts | An org deletes everything | Five artifacts per document | Per-tenant rate limits, prefix deletes in the object store, an SLO on time to purge |
| Re-check | Never first | One primary-key query per question, ≤ 24 rows | Primary-routed access reads; it stays cheap |

> "The number I'd put on a dashboard first is re-check drops by reason. Any drop at all means the pre-filter alone would have leaked, and a rising count of stale-index drops means the metadata sync is falling behind."

---

## ⚖️ Trade-offs Summary

| Decision | ✅ Chosen | ❌ Alternative | Why |
|----------|----------|---------------|-----|
| Authority on access | PostgreSQL, re-checked per candidate | The index's metadata | Copies lag; a stale copy must never decide |
| Index filtering | Inside the ANN query (iterative scan) | Post-filter a global top-k | Post-filtering starves answers |
| Revocation | Validate on read | Invalidate every copy synchronously | No need to find every copy; immediate by construction |
| Index metadata | Lazily synced by a job | Updated in the sharing transaction | User writes don't depend on the slowest store |
| Stage idempotency | Derived chunk ids + upserts | Delete-and-reinsert | Redo converges; embeddings keep their keys |
| Embeddings vs index | Separate stores | One table | Rebuild the index without re-billing |
| Retries | PostgreSQL next_run_at + sweeper | Broker delays | Visible, cancellable, one clock |
| 429 from the embedder | Retried inside the attempt | Fail the attempt | Throttling shouldn't poison documents |
| New versions | Alongside, one-pointer switch, retire later | In-place update | Never mixed, never half-indexed |
| Delete | Tombstone first, tracked purge | Synchronous delete | Instant for users, complete and auditable later |
| Dedupe | Per tenant, only readable documents | Per tenant regardless of access | No existence leaks |
| Answer cache | Context list + validation on read | TTL or invalidation only | A cached answer can't outlive access |
| Runs | Durable rows + Valkey event streams | In-memory request | Reconnect anywhere, Stop, partial output survives |

> "To wrap up: PostgreSQL is the only thing that decides access, and every path that serves content checks it at the last moment. That covers the retrieval re-check, the cache validation and the history redaction. The index and the caches are allowed to be stale because they're never trusted. The pipeline is a chain of keyed, leased, redoable stages, so a killed worker, a lost ticket, a throttled embedder or a failed object store delay a document but never corrupt it. Versions switch on one pointer read in one snapshot, and deletes are a tombstone first and a tracked purge after. The local build runs all of it: two API instances, two supervised workers, a deterministic embedder, an extractive mock model, pgvector, RabbitMQ, Valkey and MinIO. A 95-check end-to-end script exercises every one of those failure paths against the real stack."
