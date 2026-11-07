# LLM Inference API — System Design Answer (Backend Focus)

*Backend engineer interview · 45 minutes · Contract → Requirements → Architecture → Admission → Queues and batching → Routing → Lifecycle → Deep dives → Traces → Scale*

> "Before I draw a GPU, let me pin down the product contract, because the hard problems of this system are all about the request. Who owns it when the client goes away? What is it charged? When does it wait, and for how long? Where does it run? And what does the caller see when two things happen at once, like a cancel landing as the last token comes out? I'll build it in three layers. The edge decides whether work is admitted, by cost, not by request count. The dispatcher decides when admitted work runs and on which replica. The replicas only generate. Three rules carry the whole answer. First, the edge assigns the request id, and the id owns the work. Second, every state change is one atomic transition, so a race has exactly one winner. Third, a request can move between replicas until its first token, and never after."

| Phase | Time | What the interviewer should leave with |
|-------|------|----------------------------------------|
| Contract and requirements | ~6 min | Three modes, ownership, two different "no"s |
| Architecture | ~5 min | Gateway → queues → dispatcher → replicas; events flow back |
| Admission and fairness | ~6 min | Reservation = input + max_tokens; refund; DRR by cost |
| Batching and routing | ~8 min | Max wait bounds latency; continuous batching; bounded-load hashing |
| Deep dives | ~12 min | Cost admission, cancellation race, routing under change |
| Traces, checklist, follow-ups | ~6 min | One success, one crash, six review questions |
| Scale and wrap-up | ~2 min | What breaks first |

---

## 🎯 Contract and Requirements (~6 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who calls this? | Auth model, limits | Developers with API keys; keys belong to orgs with a tier |
| Which response modes? | Ownership of the work | Sync (one JSON), stream (SSE) and async (submit, fetch later) |
| What does a request cost us? | The unit of admission | Dominated by output tokens, unknown until generation ends |
| What is scarce? | What to protect | Replica batch slots. Everything else is cheap by comparison |
| Do we need strict ordering? | Queue design | FIFO per tenant, nothing global |
| Is there bulk traffic? | Priority classes | Yes: async jobs that tolerate minutes, next to interactive traffic that tolerates milliseconds |
| The batching variant? | Batch semantics | One accelerator takes up to 100 inputs at a time (an exercise assumption) |

### The contract

| Mode | Who owns the request | If the client disconnects | How the result arrives |
|------|----------------------|---------------------------|------------------------|
| Sync | The connection | Cancelled: nobody can read it | One JSON message |
| Stream | The connection | Cancelled | SSE events, Messages-API shape |
| Async | The request id | Nothing; it keeps running | Poll by id, or attach to its event stream |

> "Ownership is the first decision, and I make it explicit per mode. In sync and stream, the open connection is the only place the answer can go. So if the connection dies, generating more tokens is pure waste, and I cancel. In async, the client gave up the connection on purpose. The id it received owns the work, and any API server can hand back the result later. That's also the answer to 'the API server timed out while the model was still working': for async, nothing is lost, because the work and its result don't live in the API server. For sync, the deadline cancels the request and returns a 504 with the id, and long work belongs in async."

### Functional requirements

1. API-key auth; org tier sets tokens/min, requests/min and a share of each queue.
2. Submit in three modes; the edge assigns the id; cancel explicitly or on disconnect.
3. Usage per request: input (and cached input), output, reserved and refunded tokens, and the latency split.
4. Two lanes, interactive and bulk, each with a bounded queue.
5. Batch onto replicas; route with prefix affinity; drain for rollouts.
6. An operator view of queues, batch fill, replica health and usage per tenant.

### Non-functional requirements

| Property | Target | What it forces |
|----------|--------|----------------|
| Admission decision | p99 < 5 ms | One Valkey script; no DB write on rejection |
| Interactive queue time | p50 < 50 ms | A separate lane and slots bulk cannot take |
| TTFT on a cache hit | p50 < 300 ms | Routing affinity on the prompt prefix |
| Billing | Exactly once, refunds never doubled | A usage row written once; the refund keyed to that write |
| Cancellation | One terminal state, caller sees which | Guarded transitions |
| Overload | Bounded memory and bounded wait | Bounded queues, deadlines, 529 at the edge |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Requests | 20k/s average, 60k/s peak | Large public API |
| Tokens | ~2,000 in, ~300 out per request | Long system prompts, short answers |
| Output throughput | ~6M tokens/s | 20k × 300 |
| Replicas | ~2,000 + 25% headroom | ~3,000 output tokens/s each at full batch |
| Concurrent sequences | ~200k | 20k/s × ~10 s per generation |
| Request rows | ~1.7B/day | One row per request, partitioned by day |

> "The numbers say the control plane is cheap and the GPUs are everything. Twenty thousand admission decisions a second is one Valkey shard's light day. Two thousand replicas is the bill. So every choice should keep replicas full, and turn work away at the edge rather than letting it pile up in front of a replica."

---

## 🏗️ High-Level Architecture (~5 min)

```
 clients ──▶ ┌────────────────────────────────────────────────────────────┐
             │ API gateways (stateless)                                   │
             │ key → org/tier · cost estimate · admission (atomic script) │
             │ insert request record (id minted here) · modes · cancel    │
             └──────┬───────────────────────┬──────────────────────┬──────┘
                    │ charge + enqueue       │ insert/transition    │ read event log
                    ▼                        ▼                      │
      ┌──────────────────────────┐  ┌───────────────────────┐       │
      │ Valkey (hot, rebuildable)│  │ PostgreSQL (truth)    │       │
      │ token buckets per org    │  │ orgs · keys · tiers   │       │
      │ interactive | bulk lanes │  │ requests (state)      │       │
      │ per-tenant FIFOs         │  │ usage · batches       │       │
      │ in-flight set            │  └───────────▲───────────┘       │
      │ per-request event logs ◀─┼──────────────┼───────────────────┘
      └────────────▲─────────────┘              │
                   │ claim/requeue/publish      │ guarded transitions
      ┌────────────┴────────────────────────────┴───────────────────┐
      │ Dispatcher (leader per cell, standby on lease)              │
      │ batch policy · fair picking · router · stream relay · sweeps│
      └────────┬──────────────────┬──────────────────┬──────────────┘
               ▼                  ▼                  ▼
        ┌────────────┐     ┌────────────┐     ┌────────────┐
        │ replica b1 │     │ replica b2 │     │ replica b3 │
        │ N slots    │     │ KV cache   │     │ version    │
        └────────────┘     └────────────┘     └────────────┘
```

> "Requests flow down: gateway, queue, dispatcher, replica. Results flow back up as events. The replica streams tokens to the dispatcher, the dispatcher appends them to a per-request event log in Valkey, and whichever gateway holds the client's connection reads that log. Putting the log outside the gateway is what lets any API server serve any request id, and lets a client resume a stream after a reconnect."

**Why a separate dispatcher rather than gateways calling replicas directly?** Batching and fairness need one place that sees all waiting work. If each of fifty gateways forwarded its own requests, nobody could form a batch, and nobody could say "this tenant has had its turn". The cost is a single scheduler per cell. I make it a leader with a lease and a standby, and I size cells so one scheduler is enough (a few hundred replicas each).

---

## 💾 Data Model (~3 min)

| Table | Key columns | Indexes | Notes |
|-------|-------------|---------|-------|
| tiers | name, tokens_per_minute, requests_per_minute, max_queued_interactive, max_queued_batch, weight | PK name | Free / build / scale |
| orgs | id, slug, name, tier | slug unique | A tenant |
| api_keys | id, org_id, key_hash, key_prefix, revoked_at | key_hash unique | Only the hash is stored |
| requests | id (edge-assigned), org_id, key_id, mode, priority_class, status, max_tokens, est_input_tokens, est_cost_tokens, prefix_key, idempotency_key, backend_id, model_version, attempts, deadline_at, created/dispatched/first_token/finished_at | (org_id, created_at); partial on open statuses; partial unique (org_id, idempotency_key) for live or completed rows | The state machine lives here |
| usage | request_id (PK), org, input, cached_input, output, reserved, refunded, queue_ms, ttft_ms, exec_ms, total_ms, tokens_per_sec | (org_id, created_at) | Written once per request |
| batches | id, class, size, max_size, trigger, oldest_wait_ms, backends | created_at | Batch fill, and why each batch left |

**Valkey, per cell.** Per-org token and request buckets; per-class, per-tenant FIFO lists, with a sorted set by enqueue time (depth and oldest) and one by deadline; an in-flight set of claimed ids; a small job payload per request; a per-request event log (stream, one-hour TTL).

> "The partial unique index on the idempotency key excludes cancelled and failed rows. So a retry after a failure starts fresh, while a retry after success replays the stored result. Rejections (429s and 529s) never touch PostgreSQL. They're counted per minute in Valkey. A tenant hammering past its limit should cost us a hash increment, not a database write."

---

## 🔌 API Design (~2 min)

```
POST /v1/messages                → sync, or stream when "stream": true
POST /v1/messages/async          → 202 + id + links
GET  /v1/requests/:id            → status, result, usage, latency split
GET  /v1/requests/:id/events     → SSE attach, resumable (Last-Event-ID); leaving never cancels
POST /v1/requests/:id/cancel     → the final record + whether the cancel won
GET  /v1/usage                   → org usage and tier limits
```

| Status | Error type | Meaning for the client |
|--------|-----------|------------------------|
| 429 + exact Retry-After | rate_limit_error | You are over your own limit; your bucket refills in N s |
| 529 + jittered hint | overloaded_error | We are over capacity; back off, it isn't you |
| 400 | invalid_request_error | E.g. the reservation exceeds your tier's burst; no retry helps |
| 500 | api_error | E.g. the replica failed after output started; retry |
| 504 | timeout_error | Sync deadline passed, or the request expired while queued |

> "The 429/529 split is part of the contract, not a detail. A client that gets 429 should sleep exactly Retry-After. A client that gets 529 should back off exponentially with jitter, and maybe fail over to another region or model. Collapse them into one code and well-behaved clients are wrong in one of the two cases."

---

## 🚪 Admission and Fairness (~6 min)

**Admission, in order, as one atomic script in Valkey:**

1. Reservation = estimated input tokens + max_tokens. If it exceeds the tier's burst → 400.
2. Token bucket short → 429, with Retry-After = (cost − level) ÷ refill rate.
3. Request bucket empty → 429.
4. The tenant already holds its share of this lane's queue → 429.
5. The lane's queue is at its bound → 529.
6. Otherwise: charge both buckets and enqueue the id, in the same step.

> "I run that script twice. First as a read-only pre-check, so a rejected request never costs a database write. Then I insert the durable record, and then I run it for real. If the real run disagrees, because the tenant's own concurrent requests raced it, I mark the record failed with the admission reason. Rejections stay off the source of truth, and nothing sits in the queue without a durable record behind it."

**On completion, refund the unused reservation:** refund = reserved − (input + output tokens), never negative, never above the bucket capacity. A tenant is therefore limited by real use, while its outstanding work is capped at admission time, the moment that matters.

**Keeping one customer from consuming everything** takes three layers, because each one leaves a gap:

| Layer | What it stops | Gap it leaves |
|-------|---------------|---------------|
| Token and request buckets | Spending above the tier | A big tenant within its limits can still flood |
| Per-tenant share of each lane's queue (429 when full) | One tenant filling the queue and turning everyone else's traffic into 529s | Inside the queue, FIFO would still serve the backlog first |
| Deficit round robin by cost in the dispatcher, weighted by tier | A quiet tenant waiting behind a noisy backlog | None at this level; the noisy tenant still gets all the idle capacity |

> "DRR is the piece people skip. Each tenant with queued work earns a quantum of token credit per round, times its tier weight. It can dispatch while its credit covers its next request's estimated cost. So a tenant with five hundred queued requests and a tenant with two simply alternate. The noisy one gets everything nobody else wants, and gives it back the instant someone else shows up. In my local run, a noisy tenant had sixty bulk requests queued with a median queue time of about two seconds. A quiet tenant arriving after them waited at most about half a second, and overtook forty-three of the noisy requests."

**Two lanes.** Interactive (sync and stream) and bulk (async) have separate bounded queues. Bulk is guaranteed a minimum share of slots (25%), so it is never starved, and capped at a maximum share (50%), so interactive bursts always find free slots instead of queueing behind long bulk generations.

---

## 📦 Batching (~4 min)

**When a batch leaves**, evaluated per lane every few milliseconds:

- **Full**: batch-size requests are queued and that many slots are free.
- **Max wait**: the oldest queued request has waited the lane's max wait (25 ms interactive, 1.5 s bulk).
- **Deadline**: some request's deadline is close.
- **No free slots**: nothing leaves. The bounded queue absorbs the backlog, and admission sheds the rest with 529.

> "The low-traffic follow-up has a crisp answer: a request waits at most max wait plus one tick, never 'until the batch fills'. With the exercise's accelerator of 100 inputs and a 50 ms wait, at 2,000 requests a second the batch fills just as the wait expires. At 200 a second every batch leaves at about 10% full. At 20 a second, every request pays the full 50 ms for nothing. So max wait is the latency-for-efficiency knob. I make it a runtime setting, and in production it should adapt: shorter when the queue is empty, longer when a batch is about to fill."

**Static vs continuous batching on the replica:**

| Approach | Behaviour | Verdict |
|----------|-----------|---------|
| ✅ Continuous (iteration-level) | Every decode step emits one token per sequence; finished sequences leave at once; waiting ones join at the next step | Slots stay busy; a short answer's latency depends on its own length |
| ❌ Static | The batch runs until its longest member finishes | A 20-token answer holds its slot while a 2,000-token neighbour finishes |

> "If the replica batches continuously, why does the dispatcher batch at all? Because admitting new sequences isn't free. Scheduling, KV-cache allocation and launching prefill stall decode for everyone already running on that replica. Ten single admissions stall running streams ten times; one group of ten stalls them once. So the dispatcher's batch is an admission group. Under saturation, slots free up one at a time, so most groups leave on max wait with one or two requests. That's correct, because holding three idle slots to form a group of four would cost more than the stall it saves. Batch fill is a diagnostic. The efficiency metric is slot occupancy."

---

## 🧭 Routing (~4 min)

**First, why affinity at all.** Apps resend the same long system prompt with every call. The replica that processed that prefix recently holds its KV cache and skips most of the prefill: about 140 ms to first token instead of about 600 ms for a 1,500-token prompt in my mock. That is a performance preference, never a correctness requirement. Any replica can serve any request, so affinity must yield to load, drains and failures.

**Algorithm: consistent hashing with bounded load, on a prefix key** (a hash of the model and system prompt):

1. Each replica owns about 160 virtual nodes on a ring. A key's preference order is the replicas met walking clockwise from its hash.
2. Take the first replica that is routable (healthy, not draining, not cooling down) and has a free slot, and whose load stays within (1 + ε) × the average, with ε = 0.25. Below half occupancy, affinity always wins.
3. A hot prefix spills to the next replica on the ring, which then also caches it.

**Pinning.** A request can be re-routed while it is queued, including after it was sent to a replica, as long as that replica hasn't produced a token yet. The first token pins it.

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: Admission by cost, not by request count

**Decision.** Charge every request a reservation of estimated input tokens plus max_tokens against the org's token bucket at admission, and refund the unused part when it finishes.

**Why it works here.** Execution cost is dominated by output tokens, and output length is unknown until generation ends. Two requests with nearly identical payloads, a short prompt with max_tokens 50 and the same prompt with max_tokens 4,096, differ in worst-case replica time by 80×. The reservation charges each its worst case *before* it consumes a slot, which is the only moment admission can protect capacity. The refund makes the final charge equal to actual use, so honest clients aren't punished for an unused budget. It also bounds a tenant's *outstanding* work: a tenant can never have more reserved tokens in flight than its bucket holds.

**Why the alternatives fail.** Counting requests treats a 10-token completion and a 4,000-token essay as equal. A tenant sending essays at the allowed request rate consumes hundreds of times its fair share, and our only defence is the replica queue backing up for everyone. Charging after the fact (post-hoc billing against the bucket) can't prevent anything: by the time we know the cost, the replica time is spent, and a burst of large requests is admitted all at once because the bucket still looked full. Predicting output length per tenant and charging the prediction admits more traffic on average, but it fails precisely during a burst of unusually long requests, which is when the system is busiest.

**What I give up.** A client that always sends max_tokens 4,096 and uses 50 gets fewer concurrent requests admitted than its real usage suggests, until the refunds land. I accept that, because it nudges clients toward honest max_tokens, which is also what the batcher wants. There are two smaller costs. Input estimation needs the tokenizer at the edge, an extra CPU cost per request. And refunds must be exactly-once, so I key them to the usage row insert: insert-if-absent, refund only if inserted. A crash between those two steps loses a refund, overcharging one request until the bucket refills.

### Deep dive 2: Cancellation racing completion

**Decision.** The request record has one state machine: queued → running → completed | cancelled | failed. Every change is one guarded UPDATE whose WHERE clause lists the legal source states. Cancel requires queued or running. Completion requires running. The winner writes the single terminal event to the request's event log, and the cancel endpoint returns the final record with a flag saying whether the cancel won.

**Why it works here.** A cancel and a completion are two writers racing on one fact. Both UPDATEs lock the same row. Whichever commits first wins; the other re-evaluates its WHERE clause, matches zero rows, and knows it lost. No coordinator, no lock service, no timeouts. Every observer then sees the same answer, because only the winner writes to the event log: the sync waiter, the stream, someone attached by id. A caller whose cancel lost receives the completed result rather than an error. In my local test, I fired cancels at staggered times around completion, 24 times. Both outcomes occurred, and every request had exactly one terminal state, one terminal event and one usage row.

**Why the alternatives fail.** A "cancelled" flag that the dispatcher checks between tokens loses the race at the end: the last token and the completion can be written after the flag was set but before it was read. The client then sees both a cancel confirmation and a completed message. Cancelling only at the replica, with no state transition, leaves the outcome undefined if the replica finishes first. A distributed lock around "finish" adds a lease that can expire in the middle of the write, and adds a dependency on the lock service. Making the cancel endpoint always succeed ("we'll stop it") lies to the caller when completion already won, and then billing contradicts the API response.

**What I give up.** Every terminal state costs a PostgreSQL write on the hot path. At 20k requests a second that's 20k extra row updates per second, plus the first-token transition. I handle it with partitioning by day and short transactions, but it's real load that a fire-and-forget design wouldn't have. The other cost is subtle: the first token can only be published *after* the queued → running transition commits, which adds a few milliseconds to time to first token. I accept it, because otherwise a cancel that won could still show the client a token.

### Deep dive 3: Routing under change — staleness, growth and rollouts

**Decision.** Consistent hashing with bounded load on the prompt prefix key. The router's view of replicas is polled and therefore stale, so the replica stays the authority on its own admission. Drains are used for rollouts. Re-routing is allowed only before the first token.

**Why it works here.** Affinity's value is cache reuse, so the routing function must be stable, while capacity changes underneath it:

- **Adding a replica** moves only the keys it now owns: about a quarter of them when going from three to four, all to the new replica. Each moved key costs one cold prefill on its new owner, and nothing fails. Modulo hashing would move about three quarters of the keys, a fleet-wide cache flush on every scale event.
- **Bounded load** caps hot spots, so one viral system prompt spreads across a few replicas instead of melting one.
- **A rolling version change** drains one replica at a time: it refuses new groups and finishes its in-flight streams. When it is empty it switches version with a cold cache and rejoins. Capacity drops by one replica, never to zero. Responses carry model_version, so callers can tell which version answered.
- **Stale routing information**:
  - *Too optimistic* (it thinks a draining or full replica can take work): the replica refuses in one round trip, the requests go back to the head of their queues with their original timestamps, and they're re-routed. Nothing was generated, so nothing is lost.
  - *Too pessimistic*: this one bit me in testing. A report taken before a burst finished made an idle replica look busy, so its prefixes spilled elsewhere and lost cache hits. The fix was to trust the dispatcher's own in-flight count, which is exact for work it sent, and to count the reported number only when it was taken after the last local completion.

**Why the alternatives fail.** Least-loaded routing balances perfectly but scatters each prefix across the fleet, so every replica keeps a cold copy and TTFT doubles. Pure consistent hashing without a load bound keeps affinity perfectly and turns one popular prompt into one overloaded replica with a long queue, while its neighbours idle. Moving a request after output began, by restarting on another replica, would show the client the first tokens twice. Continuing from the partial output on another replica would splice two samplers, possibly two model versions. Either breaks the stream's integrity, so I fail the request with a clear error and let the client retry.

**What I give up.** A mid-stream replica crash becomes a client-visible error instead of a transparent recovery. The client must retry, and pays again for the tokens it already received. At low load I also give up perfect balance on purpose: below half occupancy affinity always wins, so one replica can be busier than the others while the cache pays for it. And every membership change costs a burst of cold prefills on the moved keys. A rollout across the fleet is effectively a slow cache flush, which shows up as higher TTFT for the duration.

---

## 📜 Execution Traces (~4 min)

### Successful trace: a streamed request with a prefix-cache hit

1. **Gateway checks the request.** It authenticates the key (Acme, scale tier), validates the body, and estimates 1,520 input tokens, so with max_tokens 256 the reservation is 1,776.
2. **Pre-check** passes; no database write yet.
3. **Durable record.** The gateway inserts the record with a fresh id and status queued, then runs admission for real: it charges 1,776 tokens and one request and pushes the id onto Acme's interactive FIFO, atomically.
4. **Stream opens.** The gateway sends message_start (with the id) and a "queued" status event, and subscribes to the request's event log.
5. **Dispatcher decides.** No batch is full, and 25 ms later the oldest request hits max wait. Fair picking selects it, and the claim moves it to the in-flight set.
6. **Route.** The router hashes the prefix; owner b2 has 2 of 8 slots in use, so it is chosen as primary.
7. **Record the dispatch.** One UPDATE records the backend, the batch id and the attempt count, for rows still queued. A batches row records size 1, trigger max_wait.
8. **b2 admits it.** The prefix is cached, so prefill is only the 20 new tokens: first token in about 140 ms.
9. **First token.** The dispatcher moves the record queued → running, and wins. Only then does it publish the start event (backend b2, queue 38 ms, TTFT 140 ms) and the first delta.
10. **Tokens flow.** The gateway relays each delta as content_block_delta, one per decode step.
11. **Completion.** b2 reports done after 60 tokens. The dispatcher moves running → completed, and wins. It inserts the usage row, refunds 1,776 − 1,580 = 196 tokens, and publishes done with usage and latency.
12. **Stream ends.** The gateway sends message_delta (stop reason, usage, latency split) and message_stop.

### Failed trace: the replica crashes mid-stream

1. **Starting state.** Request A is running on b1 with 40 tokens sent. B and C were just admitted by b1 and are still in prefill. D is queued.
2. **b1 dies.** The dispatcher's stream from b1 errors. It marks b1 as cooling down, so routing stops using it before the next health poll.
3. **Settle each unfinished request** of that group:
   - **A** had output, so it cannot move. Running → failed, which wins. The partial output is kept, input plus 40 output tokens are billed and the rest refunded, and an error event says the replica failed after output started, so retry.
   - **B and C** had no token, so they're still queued in the state machine. They go back to the head of their tenant FIFO with their original enqueue time, and a "requeued: backend_crashed" event is written.
4. **Client of A** sees the tokens it got, then an api_error event. A retry with the same Idempotency-Key starts a new request, because a failed attempt releases the key.
5. **Re-route.** B and C are dispatched to b3, the next replica on their prefix's ring, and complete with attempts = 2 and one cold prefill. D goes to b2 or b3 and never notices.
6. **b1 restarts** with a cold cache, health turns green, and its prefixes come back to it.

> "If the dispatcher died instead of the replica, the replicas would see their connections close and cancel those sequences. The standby takes the lease within a few seconds. Its recovery sweep finds claimed requests that no live process owns: queued ones are re-queued, running ones are failed with 'the dispatcher stopped after output started'. Same rule, different failure."

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | The PostgreSQL request row. Admission succeeds when the row exists and the atomic script charged and enqueued; only then does the client get 202 or an open stream. Completion succeeds when the guarded running → completed UPDATE commits. Valkey state (buckets, queues, logs) is rebuildable; losing it never loses a completed result or a usage row |
| Client retries after losing the response? | Idempotency-Key: completed → replay the stored result; in progress → 409 with the id; cancelled or failed → the key is released and the retry starts fresh. Without a key, a lost sync response means the request was cancelled at disconnect, so it isn't billed twice for unread work |
| Worker fails between two steps? | Gateway dies after insert, before admit → orphan sweep fails the row (nothing charged). Dispatcher dies after claim → recovery sweep re-queues. Replica dies before the first token → re-route; after it → fail clearly. Crash between usage insert and refund → one lost refund, bounded |
| Which ordering or consistency is required? | One terminal state per request (row lock); per-request event order (one writer); FIFO within a tenant's lane (re-queue to the head with the original time). Nothing global: fair dispatch reorders across tenants on purpose |
| Access with caches and async jobs? | Every read by id is scoped to the caller's orgs (another org's id is a 404). Event logs are reachable only through those endpoints. The key → org cache lives 30 s, so revocation lags by up to 30 s |
| What breaks first at scale? | Replica slots: in load tests queue time climbs into seconds while TTFT stays flat and admission stays in single-digit milliseconds. Next, the single dispatcher per cell (about five Valkey round trips per dispatch), then PostgreSQL write rate (four writes per request). Answers: cells, partitioned tables, batched usage writes |

---

## ❓ Follow-ups the Answer Must Handle

**Two requests have similar payload sizes but very different execution costs. How should admission treat them?**
> "By their reservation, not their size: estimated input plus max_tokens. A 200-byte prompt asking for 4,000 tokens reserves twenty times more than one asking for 200. If the estimate turns out high, the refund corrects it at completion. Prefill cost differs too, and a cached prefix makes a long prompt cheap. I bill cached input the same for the bucket, but the router sends it where it is cheap."

**The API server times out while the model is still working. Who owns the request?**
> "The request id does, not the server. For async, the server that accepted it can die and any other server returns the result by id, because the record is in PostgreSQL and the event log is in Valkey. For sync, the connection is the owner. A sync deadline cancels the request and returns a 504 carrying the id, because nobody can read a sync answer later. If the gateway process itself crashes, its sync requests run to completion unread. That's a known gap, closed by a gateway heartbeat on open connections."

**How do you correlate queued work with the original caller?**
> "One id minted at the edge before anything else exists. It is the queue entry, the in-flight entry, the replica's sequence id, the event-log key, the usage row's primary key, the request-id header and the first SSE event. The tenant comes from the API key, and every lookup by id is scoped to that tenant."

**When cancellation races with completion, what result does the caller observe?**
> "Whichever transition committed first. Both are guarded UPDATEs on the same row, so exactly one wins. The cancel endpoint returns the final record with cancelled true or false. If completion won, the caller gets the full result instead of an error. Streams see exactly one terminal event, because only the winner writes it."

**How do you keep one customer from consuming all available capacity?**
> "Three layers. Buckets cap spend. A per-tenant share of each lane's queue stops one tenant from filling it (that's their 429, not everyone's 529). Weighted deficit round robin by cost in the dispatcher stops a backlog from delaying a newcomer. Plus a bulk lane whose share of slots is capped, so even a well-behaved tenant's batch job can't crowd out interactive traffic."

**When traffic is low and a batch never fills, how long does a request wait?**
> "At most the lane's max wait plus one scheduling tick: 25 ms for interactive here, 1.5 s for bulk. With the exercise's batch of 100, a trickle of requests leaves in batches of one or two at that bound. Waiting longer would buy accelerator efficiency nobody needs at low load."

**During overload, what stops the queue from growing forever?**
> "Each lane's queue has a hard bound. At the bound, admission answers 529 before charging anything. Per-tenant shares stop one tenant from reaching it alone. Requests carry deadlines, and one that expires while queued is dropped with a full refund, because its caller has already given up. The dispatcher never sends more work than a replica has free slots, so no hidden queue builds up on the GPUs."

**Can a request move to another backend after output has begun? What happens when routing information is stale?**
> "No. Before the first token it can move freely, and I re-route on refusals, full replicas and crashes. After the first token it is pinned: a replica failure fails the request with a clear error and the client retries. Stale routing info is safe because the replica decides its own admission. An over-optimistic view costs one refused round trip and a re-route. An over-pessimistic one costs cache hits, which is why I trust the dispatcher's exact in-flight count over an older health report."

**Does adding a server invalidate existing assignments? What happens during a rolling model-version change?**
> "With consistent hashing, adding a fourth replica moves about a quarter of the prefix keys, all onto the new one, and each moved key costs one cold prefill. Modulo hashing would move three quarters. A rollout drains one replica at a time: it stops taking new groups, finishes its streams, switches version with a cold cache, and rejoins. Its keys spill to ring neighbours meanwhile. Every response carries model_version, so mixed versions during the rollout are visible to callers."

---

## 🚨 Failure Handling (~1 min)

| Failure | Behaviour |
|---------|-----------|
| Replica refuses (draining, restarting, 529) | Group re-queued at the head; local view corrected now; overloaded replicas cool down 2 s |
| Replica crash before / after first token | Re-route / fail with api_error, partial output kept, generated tokens billed |
| No replica accepts after 5 attempts | 529 overloaded_error, full refund |
| All replicas drained | Queue to the bound, then 529; queued work runs when capacity returns |
| Deadline passes in the queue | timeout_error, full refund |
| Dispatcher crash | Standby takes the lease (~3 s); recovery sweep re-queues or fails what the dead one held |
| Valkey restart | Buckets reset; queued entries and event logs lost (append-only file limits it); orphan sweep fails records left queued |

---

## 📈 What Breaks First and How It Scales (~2 min)

1. **Replica slots.** In the local load test, a capacity drop (two of three replicas drained) pushed interactive queue time to ten seconds with TTFT unchanged at ~140 ms. That's the "add capacity" signature, and why the latency split matters. Scale replicas on queue time and slot occupancy, not CPU.
2. **One dispatcher per cell.** It runs about five Valkey round trips per dispatch decision plus one pipeline per replica read. Split into cells (a few hundred replicas, their own queues and buckets) and home tenants to cells at the edge with, again, bounded-load hashing.
3. **PostgreSQL writes**: insert, first token, terminal, usage. That's 80k writes a second at 20k requests a second. Partition by day, shard by org, batch the usage inserts, and move per-minute analytics to an OLAP store fed by a log.
4. **Event-log fan-out**: millions of deltas a second. Coalesce per decode step (several tokens per entry when the replica runs ahead) and shard the logs by request id.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Admission unit | ✅ Reservation (input + max_tokens), refund | ❌ Request count | Worst-case cost before it consumes a slot |
| Saying no | ✅ 429 exact Retry-After vs 529 jittered | ❌ One code | Clients need to know whose problem it is |
| Rejections | ✅ Read-only pre-check, no DB write | ❌ Insert, then reject | Abuse must not load the source of truth |
| Fairness | ✅ Queue share + DRR by cost | ❌ Rate limits only | Fair under contention, work-conserving otherwise |
| Lanes | ✅ Interactive / bulk with min and max share | ❌ One priority queue | No head-of-line blocking, no starvation |
| Replica batching | ✅ Continuous | ❌ Static | Short requests don't hold slots for long ones |
| Dispatcher batching | ✅ Admission groups: full / max wait / deadline | ❌ One by one | Fewer decode stalls, bounded extra latency |
| Routing | ✅ Bounded-load consistent hashing | ❌ Least-loaded, mod N | Cache reuse without hot spots; ~1/N keys move |
| Pinning | ✅ After first token | ❌ Resume elsewhere | No duplicated or spliced output |
| Request state | ✅ Guarded transitions in PostgreSQL | ❌ Flags / locks | Races decided by row locks; any gateway can serve |

---

## 📝 Wrap-up (~1 min)

> "To summarize: the contract comes first. The edge mints the id, sync and stream are owned by their connection, async by the id. Admission charges worst-case cost and refunds the rest, and says 429 or 529 depending on whose fault it is. The dispatcher batches with a bounded wait, picks fairly by cost across tenants and lanes, and routes with bounded-load hashing for cache reuse. Requests move freely until their first token and never after. Every state change is one guarded transition, so races have one winner and every observer agrees on it."

### How the local implementation compares

| Production design | Local build |
|-------------------|-------------|
| Thousands of GPU replicas | Three mock replicas (8 slots, continuous or static batching, prefix cache, versions, chaos switches armed as counts) |
| Cells with tenant homing | One cell: one dispatcher leader (a standby can run), one Valkey, one PostgreSQL |
| Model tokenizer at the edge | ~4 characters per token, the same function in the mocks |
| Batch of 100 per accelerator | Batch size 4, 8 slots per replica (configurable to 100) |
| Verified by | 66 unit tests plus a live end-to-end script of 84 checks: 429 vs 529, fairness, disconnect, the cancel race, batching triggers, cache hits, drain, a mid-stream crash |
