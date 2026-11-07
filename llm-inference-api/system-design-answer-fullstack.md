# LLM Inference API — System Design Answer (Full-Stack Focus)

*Full-stack interview · 45 minutes · Contract → Architecture → Admission and scheduling → Consoles → Deep dives → Traces → Scale*

> "This is a multi-tenant developer API in front of a model, plus the two consoles people use to drive it and run it. A developer console sends requests, watches tokens stream and sees what each one cost. An operator console shows queues, batches and replicas. I'll start with the contract the client depends on, because it shapes everything from the database to the Stop button. The edge assigns the request id, and the id owns the work. Sync and streamed requests belong to their connection, so closing it cancels them. Async requests belong to their id and survive anything. Then I'll show how a request is charged by cost, queued fairly, batched and routed, and how the UI shows each of those decisions honestly: queue time separately from model time, and 'over your limit' separately from 'we're overloaded'."

| Phase | Time | Focus |
|-------|------|-------|
| Contract and requirements | ~5 min | Modes, ownership, error contract |
| Architecture and data | ~6 min | Gateway, queues, dispatcher, replicas, consoles |
| Backend core | ~8 min | Admission by cost, fairness, batching, routing |
| Frontend | ~6 min | Streaming client, cancel per mode, admin live data |
| Deep dives | ~12 min | Ownership and cancellation end to end; batching; streams across servers |
| Traces, checklist, follow-ups | ~6 min | One success, one crash |
| Scale and wrap-up | ~2 min | What breaks first |

---

## 🎯 Contract and Requirements (~5 min)

### Clarifying questions (and the answers I'll assume)

| Question | Why it matters | Assumption |
|----------|----------------|------------|
| Who are the users? | Two UIs, two auth models | Developers (API keys, console) and platform operators (admin console) |
| Which response modes? | Ownership, UI states | Sync, stream and async; the console offers all three |
| What is scarce? | What to protect and show | Replica batch slots; the admin console is built around them |
| What does a request cost? | Admission unit, what the console displays | Mostly output tokens, unknown up front |
| Does the console need its own path? | Fidelity | No: it acts through the user's API keys, through the same pipeline |
| The batching variant? | Batch semantics | One accelerator processes up to 100 inputs at a time (an exercise assumption) |

### The contract

| Mode | Request owned by | Client disconnects | What the client gets |
|------|------------------|--------------------|----------------------|
| Sync | The connection | Cancelled | One JSON message |
| Stream | The connection | Cancelled | Server-sent events in the Messages API shape |
| Async | The request id | Keeps running | 202 + id; poll it, or attach to its event stream |

Errors share one shape, and the type is what clients branch on:

| Status | Type | Means |
|--------|------|-------|
| 429 + exact Retry-After | rate_limit_error | You are over your own limit |
| 529 + jittered hint | overloaded_error | We are over capacity |
| 400 | invalid_request_error | E.g. the reservation exceeds your tier's burst |
| 500 | api_error | E.g. the replica failed after output started |
| 504 | timeout_error | Sync deadline, or expired while queued |

### Functional requirements

1. API keys per org, with a tier (tokens/min, requests/min, queue share).
2. Sync, stream and async submission; cancel; fetch by id from any server.
3. Usage per request: tokens in (and from the prefix cache), out, reserved, refunded, and the latency split (queue, time to first token, generation).
4. Interactive and bulk lanes; batching onto replicas with fixed slots; routing with prefix affinity.
5. Developer console: pick a key, send in any mode, watch tokens, cancel, see history with usage.
6. Admin console: queue depth per lane, batch fill, replica slots, cache hit rate, version, drain and chaos controls, and usage per tenant.

### Non-functional requirements

| Property | Target |
|----------|--------|
| Admission decision | p99 < 5 ms, no database write on rejection |
| Interactive queue time | p50 < 50 ms at normal load |
| Time to first token | p50 < 300 ms on a prefix-cache hit |
| Cancellation | One terminal state; the caller sees which |
| Overload | Bounded queues, shed with 529, never collapse |
| Console | Tokens render as they arrive; operator data at most ~1 s old |

### Capacity estimate

| Quantity | Estimate | Reasoning |
|----------|----------|-----------|
| Requests | 20k/s average, 60k/s peak | Large public API |
| Tokens | ~2,000 in, ~300 out per request | Long system prompts, short answers |
| Replicas | ~2,000 + 25% headroom | ~3,000 output tokens/s per replica at full batch |
| Concurrent streams | ~200k | 20k/s × ~10 s each; spread over gateways |
| Console users | Thousands of developers, dozens of operators | The admin console's polling load is negligible |

> "The control plane is cheap and the GPU fleet is the cost. So the design keeps replicas full and refuses work at the edge, and the operator UI is built around one question: are we short of slots, or is something slow?"

---

## 🏗️ Architecture (~4 min)

```
 ┌───────────────────┐  ┌───────────────────┐        ┌──────────────┐
 │ Developer console │  │ Admin console     │        │ API clients  │
 │ fetch + stream    │  │ 1 s snapshot poll │        │ (SDKs, curl) │
 └─────────┬─────────┘  └─────────┬─────────┘        └──────┬───────┘
           │ session cookie       │                         │ x-api-key
           ▼                      ▼                         ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │ API gateways (stateless): auth · estimate · admit · record · modes  │
 └───────┬───────────────────────────┬───────────────────────┬─────────┘
         │ charge + enqueue           │ insert / transition   │ read event log
         ▼                            ▼                       │
 ┌───────────────────────────┐ ┌──────────────────────┐       │
 │ Valkey                    │ │ PostgreSQL           │       │
 │ buckets · lanes · in-flight│ │ orgs · keys · tiers  │       │
 │ per-request event logs ◀──┼─┼──────────────────────┼───────┘
 └────────────▲──────────────┘ │ requests · usage     │
              │                │ batches              │
 ┌────────────┴────────────────┴──────▲───────────────┘
 │ Dispatcher: batch policy · fair pick · router · relay│
 └────────┬───────────────────┬───────────────────┬─────┘
          ▼                   ▼                   ▼
    ┌───────────┐       ┌───────────┐       ┌───────────┐
    │ replica 1 │       │ replica 2 │       │ replica 3 │
    └───────────┘       └───────────┘       └───────────┘
```

> "The console is just another client of the same pipeline. A console request names one of the user's API keys, and from then on it goes through the same admission, queues and limits as an SDK call, charged to that key's org. If the console had its own fast path, it would be a demo of a different system."

---

## 💾 Data Model and API (~2 min)

| Table | Key columns | Notes |
|-------|-------------|-------|
| orgs, tiers | tier limits: tokens/min, requests/min, queue shares, fairness weight | Free / build / scale |
| api_keys | org, hash of the secret, display prefix, revoked_at | The secret is never stored |
| requests | edge-assigned id, org, key, mode, lane, status, max_tokens, estimated input, reservation, prefix key, idempotency key, backend, model version, attempts, timestamps | The state machine |
| usage | request id (PK), input, cached input, output, reserved, refunded, queue / TTFT / exec / total ms, tokens/s | Written once |
| batches | lane, size, max size, trigger, oldest wait, backends | Batch fill |

```
POST /v1/messages              sync or stream        GET  /v1/requests/:id          result + usage
POST /v1/messages/async        202 + id              GET  /v1/requests/:id/events   attach, resumable
POST /v1/requests/:id/cancel   says who won          GET  /api/v1/console/orgs      keys + budget now
POST /api/v1/console/messages  { keyId, mode, … }    GET  /api/v1/console/requests  history + usage
GET  /api/v1/admin/overview    queues, batches, replicas, usage per tenant, latency
POST /api/v1/admin/backends/:id/drain | /upgrade     PUT …/settings (chaos switches)
```

---

## ⚙️ Backend Core (~8 min)

### Admission by cost

The reservation is estimated input tokens plus max_tokens, charged against the org's token bucket in one atomic Valkey script. The same script checks the request bucket, the tenant's share of the lane's queue, and the lane's bound, then charges and enqueues. On completion, the unused part is refunded. Over the tenant's budget or share is a 429 with an exact Retry-After; a full lane is a 529.

> "I run the script once as a read-only pre-check before inserting the durable record. A tenant hammering past its limit costs Valkey reads, never PostgreSQL writes."

### Fairness

Per-tenant FIFOs inside each lane. The dispatcher picks with deficit round robin by cost, weighted by tier, so a tenant with a 500-request backlog and a tenant with 2 alternate. A per-tenant share of each queue keeps one tenant from filling it and turning everyone else's traffic into 529s. Bulk has a guaranteed minimum share of slots and a maximum, so interactive bursts always find room.

### Batching

A lane dispatches a batch when it is **full**, when its oldest request has waited **max wait** (25 ms interactive, 1.5 s bulk), or when a **deadline** is near, and never beyond the free slots. Replicas batch **continuously**: every decode step emits one token per sequence, finished sequences leave immediately and new ones join at the next step. The dispatcher's batch is an admission group, which amortizes the decode stall each admission causes.

### Routing

Consistent hashing with bounded load on a prefix key (the system prompt), because a replica that recently saw a prefix has it in its KV cache and starts much faster. That's a preference, not a rule: the router walks past draining, full or overloaded replicas, and past any replica already above 1.25 × the average load. A request can be re-routed until its first token, and never after.

### Lifecycle

queued → running → completed | cancelled | failed. Each change is one guarded UPDATE that lists the legal source states. Running starts at the first token. Whoever wins a terminal transition writes the single terminal event to the request's event log.

---

## 🖥️ Frontend (~6 min)

### Developer console

| Element | Behaviour |
|---------|-----------|
| Key picker | Grouped by org; shows tier limits and tokens available now (read from the bucket) |
| Mode switch | Stream / Sync / Async, each with a one-line note on who owns the request |
| Composer | System prompt preset (long cacheable prompts vs short), message, max_tokens (labelled "reserved"), lane |
| Output panel | Streaming text with a cursor; chips for status, backend, model version, primary vs spill; a timeline of status events (queued, running on b2 with cache hit, re-routed, cancel won or lost) |
| Latency bar | Three segments: queue (amber), first token (blue), generation (green), each labelled |
| History | The org's latest requests with status, backend, tries, tokens in / cached / out and the latency split, refreshed every 5 s and when a run ends |

**Streaming without EventSource.** The console POSTs with fetch and reads the body as a stream, parsing SSE frames by hand. EventSource can't send a POST body, and it reconnects on its own, which for a connection-owned stream would mean a second request.

**Cancel is different per mode, and the UI says so:**

- **Stream**: the console knows the id from the first event and calls the cancel endpoint. The timeline then says whether the cancel won or the request had already completed.
- **Sync**: there is no id until the response arrives, so Cancel aborts the fetch. Closing the connection *is* the cancel, and the gateway stops the generation.
- **Async**: the console attaches to the event stream after the 202. Detach closes only the viewer, and the request keeps running. "Cancel by id" calls the endpoint.

**Errors render as what they mean**: a 429 shows "Retry after N s" from the header; a 529 shows that the service is overloaded; a 500 from the dev proxy with an empty body shows "gateway unreachable", not an application error.

### Request page

The request page is reachable from the output panel and the history. It is a durable view of one id: the lifecycle (created at the edge, dispatched to which replica, first token, finished, attempts, primary or spilled), usage with reserved versus refunded tokens, the latency bar, the output (partial if cancelled or failed), and the input. It polls while the request is open, so an async result can be checked days later from any device.

### Admin console

Panels: queue depth per lane against its bound, plus the top tenants in each queue; batch fill (the last 60 batches as bars, height = fill, colour = trigger) with a summary per lane and trigger; one card per replica (slots in use split into prefilling and decoding, cache hit rate, version, drain, roll version, static/continuous switch, chaos switches with armed counts); usage per tenant with 429s and 529s in separate columns; the latency split per lane; live dispatcher settings.

> "The admin console short-polls one snapshot endpoint every second instead of holding a stream. The data is an aggregate of three stores (queue sizes from Valkey, replica health from the dispatcher's snapshot, usage from PostgreSQL), not a sequence of events. A once-a-second snapshot is honest about that, survives proxies, needs no reconnect logic, and pauses when the tab is hidden. Token streams use SSE, where latency matters and the data really is a sequence."

---

## 🔧 Deep Dives (~12 min)

### Deep dive 1: Request ownership and cancellation, end to end

**Decision.** The edge mints the id before anything is queued. Sync and stream requests are owned by their connection, and a disconnect cancels them. Async requests are owned by their id. Every status change is one guarded transition, so cancel versus completion has exactly one winner, and the UI shows which.

**Why it works here.**

- *Correlation.* The id is the only thing that exists from the first byte to the last: the queue entry, the replica's sequence, the event log, the usage row and the request-id header all carry it.
- *Ownership by mode.* For sync and stream, the connection is the only place the answer can go, so a closed socket means every further token is waste. Cancelling frees the slot within one decode step and bills only what was generated.
- *The race.* Cancel and completion are both guarded UPDATEs on one row. The first to commit wins; the other matches zero rows. Only the winner writes the terminal event, so the stream, the sync waiter and a viewer attached by id all agree. The cancel endpoint returns the final record, so the console can say "cancel lost: already completed" and show the full output.

**Why the alternatives fail.** If the gateway owned the work in memory, an async request would die with its gateway, and "fetch it later from any server" would be impossible. Keeping sync requests alive after a disconnect, hoping for a retry, burns GPU time on answers nobody reads. Retries would also double-bill unless every client sends an idempotency key. A cancelled flag checked between tokens loses at the end of the stream: the final token and the completion land after the flag is set but before it's read, and the user sees both "cancelled" and a full answer.

**What I give up.** Every request pays a database transition at its first token and another at its end. The first token can't be shown until the first transition commits, a few milliseconds of TTFT. A gateway crash is a hole: the process that would notice its clients disconnecting is gone, so their sync requests run to completion unread and are billed. Closing that needs a connection heartbeat from gateways to the dispatcher, which I'd add before production.

### Deep dive 2: Batching, and what the admin console should show

**Decision.** Replicas batch continuously at the iteration level. The dispatcher forms admission groups that leave when full, at max wait, or for a deadline. The admin console shows batch fill *and* slot occupancy, and labels why each batch left.

**Why it works here.** Requests differ wildly in output length. Continuous batching lets a 20-token answer leave its slot the moment it's done, so slots stay busy and a short request's latency depends only on itself. Admission still has a cost: each admitted group stalls decode for every running sequence while it's scheduled and prefilled. Grouping arrivals briefly trades a bounded delay for fewer stalls. The max wait (25 ms interactive) bounds that delay, which answers "what if a batch never fills": a lone request waits at most max wait plus one tick. With the exercise's accelerator of 100 inputs, a 50 ms wait fills batches at 2,000 requests a second and leaves them ~10% full at 200 a second. That's fine, because at low traffic efficiency doesn't matter.

**Why the alternatives fail.** Static batching (run until the longest member finishes) holds every slot hostage to the slowest request. In my mock, switching a replica to static makes its slots read "8 of 8 in use" while most of its sequences are already done. Dispatching every request the instant it arrives maximizes the number of admission stalls exactly when traffic is high. And waiting for a full batch, with no max wait, makes the first request after a quiet period wait indefinitely.

**What I give up.** Under saturation, slots free up one at a time, so most admission groups leave on max wait with one or two requests. The batch-fill panel shows ~27% fill for those, which looks bad to anyone reading it as an efficiency metric. I label it as a diagnostic and put slot occupancy next to it, because holding three free slots idle to form a group of four would be worse. The continuous scheduler itself is more complex (KV-cache allocation per sequence, preemption under memory pressure), but that complexity lives in the model server, not in this API.

### Deep dive 3: Streams that survive the server they started on

**Decision.** The dispatcher appends each request's events (start, deltas, re-routes, one terminal event) to a per-request Valkey stream. Each gateway process reads all the streams it's waiting on with one blocking read across many keys. Async clients attach by id and resume with Last-Event-ID.

**Why it works here.** The gateway that accepted a request might not be the one the client reconnects to, and an async client may attach minutes later. A durable, ordered, per-request log answers both: any gateway can replay it from any event id, and a completed request replays the stored result from PostgreSQL once the log expires. One blocking read per gateway process, interrupted when a new subscription arrives, keeps connection counts flat regardless of how many streams a gateway serves.

**Why the alternatives fail.** Pub/sub drops anything published before the subscriber arrives. A client that attaches a second late misses the first tokens, and a reconnect has nothing to resume from. Streaming replica → dispatcher → the specific gateway over a direct connection couples the request to one gateway: if it restarts, the stream is gone even for async work. One blocking connection per waiting request would exhaust Valkey connections at a few thousand concurrent streams per gateway.

**What I give up.** Every token is written to Valkey and read back, an extra hop and write amplification. At millions of deltas a second, I'd coalesce per decode step and shard logs by request id. Logs live an hour, so a very late attach falls back to the final result without the token-by-token replay.

---

## 📜 Execution Traces (~4 min)

### Successful trace: streamed from the console with a cache hit

1. **Alice submits.** She picks "Acme / production", Stream mode and the long support prompt, and clicks Send.
2. **The console** POSTs to the console endpoint with the key id and starts reading the response stream.
3. **The gateway admits it.** It checks Alice may use that key, estimates the cost (1,520 input + 256 max), and passes the pre-check. It inserts the record (id minted, queued), then runs admission for real: charge and enqueue on Acme's interactive FIFO.
4. **The stream opens.** The gateway sends message_start (with the id) and "queued" status; the output panel shows the id and a queued chip.
5. **Dispatch.** 25 ms later the dispatcher dispatches on max wait. The router picks b2, which owns the prefix and has room (primary). One UPDATE records the backend and batch.
6. **First token.** b2 finds the prefix cached and produces it in ~140 ms. The dispatcher moves queued → running, wins, then publishes start (b2, queue 38 ms, TTFT 140 ms) and the first delta.
7. **The console renders** "Running on b2 (primary, 1,500 cached prefix tokens)" and appends tokens as they arrive.
8. **Completion.** Done after 60 tokens: running → completed wins, the usage row is written, 196 unused tokens are refunded, and the done event carries usage and latency.
9. **The console finishes.** The latency bar renders queue / first token / generation, and the history refreshes with the new row.

### Failed trace: the replica crashes mid-stream

1. **Alice's stream is running on b1.** The operator has armed "crash mid-stream" on b1, and two async requests with the same prompt were just admitted there and are prefilling.
2. **b1 dies after 40 tokens.** The dispatcher's stream from b1 breaks, and it marks b1 as cooling down.
3. **Alice's request had output, so it can't move.** Running → failed with api_error ("failed after 40 output tokens; output had started, so it cannot move; retry"). The 40 tokens are billed and the rest refunded.
4. **Her console** shows the partial text and a red error. The history row shows failed, with the partial output kept on the request page.
5. **The two async requests had no tokens**, so they go back to the head of their queue with a "requeued: backend_crashed" event. They complete on b3 with attempts = 2.
6. **The admin console** shows b1 as restarting, then ok with a cold cache (hit rate reset). The router sends its prefixes back as health returns.

---

## ✅ Design Review Checklist (~2 min)

| Question | Answer |
|----------|--------|
| Source of truth; when is a write successful? | The PostgreSQL request row. Admission succeeds when the row exists and the atomic script charged and enqueued; completion when running → completed commits. Valkey is rebuildable |
| Client retries after losing the response? | Idempotency-Key replays a completed result, returns 409 + id while in progress, and starts fresh after cancel or failure. The console shows the id early, so a user can open the request page after a reload |
| Failure between two steps? | Sweeps: orphan records failed; claimed-but-unstarted work re-queued; started work failed clearly; usage written once with the refund keyed to it |
| Ordering or consistency needed? | One terminal state; per-request event order; FIFO per tenant lane. Nothing global |
| Access with caches and async work? | Reads by id are scoped to the user's orgs (404 otherwise); event logs only via those endpoints; the console uses only the user's own keys; the admin API requires admin |
| What breaks first? | Replica slots: queue time climbs while TTFT stays flat. Then the per-cell dispatcher and PostgreSQL write rate |

---

## ❓ Follow-ups the Answer Must Handle

**Similar payload sizes, very different execution costs. How does admission treat them?**
> "By reservation: estimated input plus max_tokens, refunded down to actual use at the end. The console labels max_tokens as 'reserved' so developers see why a 4,096-token reservation drains their budget, and the request page shows reserved versus refunded."

**The API server times out while the model is still working. Who owns the request?**
> "The id. Async work and its result live in PostgreSQL and the event log, so any server can return them. A sync request is owned by its connection: its deadline cancels it and returns a 504 carrying the id, and the console steers long work to async."

**How do you correlate queued work with the original caller?**
> "One edge-minted id carried by the queue entry, the replica sequence, the event log, the usage row, the request-id header and the first stream event. The console shows it in the output panel the moment message_start arrives."

**When cancellation races with completion, what does the caller observe?**
> "Whichever guarded transition committed first. The cancel response carries the final status and a flag, and the console timeline says 'cancel won' or 'cancel lost: already completed' and shows the full result in the second case."

**How do you keep one customer from consuming all capacity?**
> "Buckets for spend, a per-tenant share of each lane's queue, weighted deficit round robin by cost in the dispatcher, and a capped bulk lane. The admin console's usage table shows 429s (their own limit) and 529s (ours) in separate columns per tenant."

**When traffic is low and a batch never fills, how long does a request wait?**
> "At most the lane's max wait plus one tick: 25 ms for interactive. The batch-fill panel shows those batches leaving on max wait at size one, which is the intended behaviour at low traffic."

**During overload, what stops the queue from growing forever?**
> "Each lane's bound. Beyond it, admission returns 529 before charging. Requests whose deadlines pass in the queue are dropped with a full refund, and the dispatcher never sends a replica more than its free slots."

**Can a request move to another backend after output has begun? What about stale routing information?**
> "No. Before the first token it is re-routed freely on refusals, full replicas or crashes. After it, a replica failure fails the request with a clear error. Stale routing info is safe because each replica decides its own admission: a wrong guess costs one refused round trip."

**Does adding a server invalidate existing assignments? What about a rolling model-version change?**
> "Adding a fourth replica moves about a quarter of the prefix keys, all to the new one. The routing page shows this next to the three quarters that mod-N would move. A rollout drains one replica at a time: in-flight streams finish, the version switches with a cold cache, then it rejoins. The admin console shows mixed versions during the rollout, and every response says which version answered."

---

## 🚨 Failure Handling (~1 min)

| Failure | System | UI |
|---------|--------|----|
| Tenant over its limit | 429 + exact Retry-After | "Retry after N s" |
| System over capacity | 529 + jittered hint | "Service overloaded" with backoff |
| Replica crash before first token | Re-routed | Timeline: "re-routed: backend_crashed" |
| Replica crash after first token | Failed, partial output kept | Partial text + error; history shows failed |
| Gateway unreachable (dev proxy 500, empty body) | — | "Gateway unreachable", not an app error |
| Admin poll fails | Last snapshot kept | "Stale" label with the error |

---

## 📈 What Breaks First and How It Scales (~2 min)

1. **Replica slots.** In the local load test, draining two of three replicas pushed interactive queue time to ~10 s with TTFT flat at ~140 ms. The latency split makes that diagnosis instant in the admin console.
2. **The dispatcher**, one per cell. Split into cells of a few hundred replicas with their own queues, and home tenants to cells.
3. **PostgreSQL writes**: four per request. Partition by day, shard by org, batch usage writes.
4. **Event logs**: coalesce deltas per decode step and shard by request id.
5. **The admin console**: polling one snapshot per operator per second is fine for dozens of operators. With hundreds, cache the snapshot for a second at the gateway so polls share one computation.

---

## ⚖️ Trade-offs Summary

| Decision | Chosen | Alternative | Why |
|----------|--------|-------------|-----|
| Admission | ✅ Reservation + refund | ❌ Request count | Charges real cost before it consumes a slot |
| Saying no | ✅ 429 vs 529 | ❌ One code | Different client behaviour; separate columns in the admin console |
| Fairness | ✅ Queue share + DRR by cost | ❌ Rate limits only | Newcomers don't wait behind a backlog |
| Replica batching | ✅ Continuous | ❌ Static | Short answers free their slot at once |
| Routing | ✅ Bounded-load hashing on the prefix | ❌ Least-loaded | Cache reuse without hot spots |
| Pinning | ✅ At the first token | ❌ Move mid-stream | No duplicated or spliced output |
| Client streaming | ✅ fetch + ReadableStream | ❌ EventSource | POST bodies, cookies, no surprise reconnects |
| Admin live data | ✅ 1 s snapshot polling | ❌ SSE | Aggregated data; no long-lived connection |
| Event delivery | ✅ Per-request log in Valkey | ❌ Pub/sub | Late attach and resume work |

---

## 📝 Wrap-up (~1 min)

> "The contract drives both halves. The id owns the work, sync and stream are owned by their connection, and races are settled by one guarded transition, so the console's Cancel button can always say what really happened. Admission charges worst-case cost and says 429 or 529 depending on whose fault it is. The dispatcher batches with a bounded wait, picks fairly, and routes for cache reuse without hot spots. The consoles show queue time apart from model time, so nobody blames the model for a queue."

| Production design | Local build |
|-------------------|-------------|
| GPU replicas | Three mock replicas: 8 slots, continuous or static batching, prefix cache, versions, chaos switches armed as counts |
| Many gateways, cells | Two gateways (3000/3001), one dispatcher leader, one Valkey, one PostgreSQL |
| Console SSO | Session login (alice, bob, admin) |
| Proof | 66 unit tests; 84 live end-to-end checks; a load generator showing fairness, 429 vs 529 and batch fill at low and high traffic |
