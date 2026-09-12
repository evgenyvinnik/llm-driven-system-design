# Facebook News Feed — Backend System Design Answer

A 45-minute interview proposal. This is a Facebook-inspired learning design; production
mechanisms below are not claims about Facebook's infrastructure or features already present
in the demo.

## 🎯 Scope and Capacity — 4 minutes

> “A news feed is a materialized view over posts, relationships, and engagement. I would
> separate accepting a post from distributing candidates, then make ranking and privacy
> explicit in the read contract.”

The first version supports text/image posts, following, a ranked feed, likes, comments,
deletion, and profile history. I would define Friends visibility as mutually active
relationships, then check whether the interviewer instead wants a followers-only model.
Those are different access policies.

Video, stories, messaging, custom audiences, and sophisticated ML ranking are outside the
initial scope. A public discovery fallback can help a new account, but it must be labeled
rather than silently presented as followed content.

| Requirement | Proposed target or meaning |
|-------------|----------------------------|
| Availability | 99.9% regional feed-serving availability |
| Feed latency | Healthy-path p95 API response below 300 ms |
| First useful browser content | Target under 1.5 seconds on a defined device/network |
| Propagation | Ordinary fan-out target within 10 seconds |
| Durability | Accepted post has a recoverable operation result |
| Reading order | Stable within a short-lived ranked session |
| Privacy | Current authorization on hydration and interaction |

For a consistent example, assume 100 million daily users and ten feed reads per day. That is
one billion daily reads, about 11,574 per second on average, and about 57,870 at a
five-times-average peak.

Twenty million posts per day is about 231 per second on average. At 2 KB per raw record,
storage grows by 40 GB per day before replicas, indexes, and media. If 95% of posts are
pushed to 50 recipients on average, that adds 950 million candidate insert attempts per day.

A single ten-million-follower account can still produce ten million writes with one post.
Averages hide the hotspot that determines the distribution strategy. I would ask about
active followers and posting frequency, not only total followers.

## 🏗️ Architecture and Records — 6 minutes

I would draw one write authority, an asynchronous distribution path, and a separate
feed-session read path. Media processing/CDN is an external dependency that returns owned
references and dimensions.

```
┌──────────────────────────┐       ┌──────────────────────────┐
│ Post / graph / likes API │       │ Feed API                 │
│ Authorized operations    │       │ Current access checks    │
└────────────┬─────────────┘       └────────────┬─────────────┘
             ▼                                  ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│ SQL records + receipts   │       │ Ranked session IDs       │
│ Transactional outbox     │       │ Viewer + order + expiry  │
└────────────┬─────────────┘       └────────────▲─────────────┘
             ▼                                  │
┌──────────────────────────┐       ┌──────────────────────────┐
│ Fan-out workers          │──────▶│ Candidate aggregation    │
│ Bounded retryable chunks │       │ Pushed + pulled IDs      │
└──────────────────────────┘       └──────────────────────────┘
```

The post authority commits a source record, an operation receipt, and an outbox event. A
durable relay schedules recipient work. Feed candidates contain IDs and selection metadata;
they are not permission grants or copies of complete private posts.

I would start with PostgreSQL for canonical mutations because post/receipt/outbox and
relationship/engagement transitions need transactional boundaries. A sharded wide-column
store can later hold large candidate projections. Redis supplies disposable candidate caches
and hot author timelines.

| Record | Key fields or invariant | Main access |
|--------|-------------------------|-------------|
| Post | ID, author, audience, content/media, visibility version | Hydration, profile timeline, deletion |
| Directed relationship | Follower/followed pair, state, version | Followees and reverse follower lookup |
| Candidate entry | Viewer/post unique, canonical time, source policy | Recent pushed candidates |
| Operation receipt | Actor/operation unique, digest, result | Retry an ambiguous mutation |
| Fan-out task | Event/policy, recipient chunk, completion | Retry and reconcile distribution |
| Feed session | Viewer, ordered IDs, ranking version, expiry | Stable ranked pagination |
| Like membership | Viewer/post unique, current state | Desired-state mutation and viewer overlay |

Posts can be sharded by author and feeds by viewer. Both directions of a social graph need
an access path: a follower-keyed shard does not also make all followers of a celebrity a
single-shard query. A reverse projection is part of the design.

The candidate cache should record coverage or be merged with durable candidates. A nonempty
cache is not necessarily a complete recent window. Its score must have consistent units
across fan-out, backfill, and rebuild.

A notification service sends small refresh hints to authorized online viewers. WebSocket or
SSE can carry those hints; mutations remain HTTP operations. A competing-consumer group can
divide fan-out work, but delivery to multiple interested gateways needs a real
broadcast/routing layer.

## 🔍 Deep Dive 1: Hybrid Fan-out and Durable Acceptance — 10 minutes

### Where push and pull fail

Push computes recipient candidates when a post is created. That makes repeated feed reads
cheaper, especially for active users following many ordinary authors. The cost is write
amplification and delayed distribution across a large audience.

Pull stores an author's timeline and gathers followed authors' posts at read time. It avoids
per-recipient candidate writes but adds candidate work to every feed read. It need not be
one sequential SQL query per followee: batched queries and caches help, though the total
candidate volume still grows.

| Approach | Works well when | Main failure/cost |
|----------|-----------------|-------------------|
| ✅ Push ordinary authors | Many repeated reads, moderate audiences | Recipient write amplification |
| ✅ Pull expensive authors | Large audience or high posting rate | Per-reader aggregation and hot timeline traffic |
| ❌ Push everyone | Simple uniform read path | A few accounts dominate the write fleet |
| ❌ Pull everyone | Simple publish path | Every read reconstructs too much candidate state |

The demo uses 10,000 followers as a threshold. I would treat that as an initial experiment,
then compare expected recipient work with follower read activity and posting rate. There is
no universal follower count where the correct answer changes.

A celebrity pull path also does not eliminate notification cost. A single channel
publication still needs distribution to the gateways and devices that subscribe. Coalesce
hints so one busy author does not trigger continuous refresh requests.

### Do not make the author wait for the whole audience

1. Authenticate the author, validate the audience/content, and resolve a supplied operation
ID.
2. Commit the post, actor-scoped result, and outbox event together.
3. Return the accepted post ID to the author.
4. Let workers distribute candidates in bounded recipient chunks.
5. Retry incomplete chunks, deduplicating each viewer/post effect.
6. Reconcile caches and send coalesced refresh hints.

This gives acceptance a small durable boundary. It does not promise every follower can
already see the post at the moment of acknowledgment. Expose propagation lag operationally
and keep the author's own accepted view available independently.

A database insert followed by a best-effort in-process loop can lose fan-out work if the
process crashes. Saving an outbox record in the same transaction means the relay can
rediscover that work. It still publishes at least once, so chunk and candidate effects must
be idempotent.

The post operation ID is different from the candidate uniqueness key. Viewer/post uniqueness
prevents duplicate feed entries, but does not prevent two retried creation requests from
making two different post IDs. Bind the actor's operation ID to a request digest and store
its canonical result.

If the request times out after commit, the client retries the same operation to recover the
existing result. An expired receipt must have an explicit policy; silently accepting an
ancient retry as a new operation can duplicate the post.

### Batches need failure accounting

A bounded SQL multi-row insert and Redis pipeline reduce round trips. They do not make SQL
and Redis one atomic resource. Inspect every pipeline reply and persist enough task progress
to retry the missing idempotent effects.

Do not build one enormous statement for all followers. Bound chunk size, memory, query
duration, and retry work. Backpressure should slow scheduling rather than allocate an
unlimited in-process array during a viral event.

The durable candidate store is the rebuild source. If Redis is evicted, a refill should
preserve canonical time units and known coverage. TTLs are not a substitute for a repair
process when a write succeeded in only one store.

### Changing distribution policy

An author can cross a threshold in either direction. Old posts may already exist in pushed
feeds while new ones live only in the pull timeline. Simply changing a flag can omit history
or add duplicate source work.

Version the policy, use a bounded overlap/transition period, and deduplicate candidate IDs
when merging. Maintain enough author history to cover the promised recent horizon. Measure
read amplification during migration rather than assuming the policy change is instantaneous.

> “The hybrid design buys control over the extreme workloads. I pay for two distribution
> paths, retryable tasks, and explicit transition behavior; I would not call that free
> scalability.”

## 🔍 Deep Dive 2: Ranking Without Breaking Pagination — 10 minutes

### A tie-breaker does not freeze a score

The read service collects recent pushed candidates plus a bounded contribution from followed
pull-mode authors. It batches hydration and affinity lookup, checks permission, computes
rank, and applies diversity.

A chronological feed can use a time-plus-ID boundary. A ranked feed has scores that change
with engagement, recency, and affinity. Adding a stable ID after the score only breaks ties;
it does not prevent a previously unseen post from moving above the cursor between page
requests.

Offsetting into a freshly ranked list repeats or skips items when membership changes. Client
deduplication hides repeats, but it cannot discover an unseen post that the server skipped.
That is a server continuity problem.

### My initial contract: short-lived ranked sessions

1. Gather and deduplicate a bounded candidate pool for the viewer.
2. Filter current audience/deletion policy and rank/diversify the remaining IDs.
3. Save the ordered IDs with viewer identity, ranking version, and an expiry, such as ten
minutes.
4. Return an opaque cursor pointing to the next position in that session.
5. On each later page, scan forward through the same order and recheck current permissions.
6. Return an explicit refresh/reset if the session expires.

An offset inside that immutable list is safe because its membership/order is fixed. The
cursor must be bound to its viewer and session, rather than accepted against arbitrary
cached lists. The client should never fabricate or reinterpret it.

Deletion and privacy revocation remain current. A feed session freezes rank, not access.
Skip newly inaccessible items, overfetch within a bounded budget, and advance the cursor
through examined positions so removed rows cannot trap pagination.

A newly created post goes into a future session. The client shows a refresh hint and asks
for a new session when the user chooses. Otherwise an enthusiastic live-update path would
keep shuffling the reading surface.

| Approach | Benefit | Trade-off |
|----------|---------|-----------|
| ✅ Ordered ranked session | Predictable pagination and restoration | Session storage, expiry, and temporary rank staleness |
| ❌ Recompute score cursor per page | Fresh rank each time | Score movement causes omission/repetition |
| ❌ Offset over live query | Simple API | Insertions/deletions shift the page boundary |
| ✅ Chronological mode as a separate contract | Simpler stable order | Different product ranking and candidate coverage |

A discovery fallback also needs a mode flag and compatible pagination. Returning global
popular posts with no explanation makes users think their follow graph is ignored. Mark its
scope and calculate viewer-specific engagement state correctly.

### Keep the ranking baseline honest

The local heuristic multiplies engagement, reciprocal age decay, and capped affinity. Likes
count once, comments three times, and shares five times. That is understandable, but those
weights are guesses rather than validated predictions.

There are important consequences. Zero engagement produces zero rank no matter how fresh the
post is. A large viral score can still beat a fresh small score after decay. The reciprocal
multiplier is half its initial value at 12.5 hours; it is not exponential with a repeating
twelve-hour half-life.

For an initial production baseline, I would give fresh content a nonzero prior, compress
very large engagement values, decay affinity, and reserve room for freshness/diversity. A
later model can learn negative feedback and content preferences without changing the
session/cursor contract.

A diversity cap can also hide remaining candidates. If a response returns only three posts
from one author, that does not establish that the user has exhausted all history.
Distinguish the end of a selected session from complete coverage of every post.

Rank evaluation needs product metrics and experiments, but avoid stuffing model internals
into this interview. The backend insight is the separation of candidate retrieval,
permission filtering, rank selection, and stable serving.

## 🔍 Deep Dive 3: Privacy and Engagement Are Authoritative State — 8 minutes

### Cached membership is a hint, not permission

A viewer may have received a candidate while following an author, then unfollow before
opening the page. A queued task can also use an old graph snapshot. Deleting one Redis key
cannot prove every cached copy disappeared.

I would centralize the audience predicate and apply it during feed hydration, post detail,
comments, likes, and media access. Friends means the agreed relationship rule, not whichever
directional edge happens to be easiest to query.

The graph mutation transaction changes the relationship and its counters, records a version,
and creates invalidation work. Current read checks enforce revocation while invalidations
catch up. A content removal should also notify connected viewers or be applied on resume so
already-mounted cards do not remain indefinitely.

| Choice | Why I choose it | Cost |
|--------|-----------------|------|
| ✅ Recheck access during hydration | Stale candidates cannot grant access | Batched graph/visibility work on reads |
| ❌ Trust materialized membership | Fast simple cache serving | Revocation leaks through old candidate copies |
| ✅ Versioned invalidation plus read checks | Repairs caches and active views | More state and propagation logic |
| ❌ Depend only on TTL expiry | Little invalidation machinery | Private content can remain available until expiry |

Audience-protected media matters too. A private post with a permanent unrestricted image URL
still exposes its image. Store owned media references and issue access-appropriate
derivatives/URLs; do not treat a metadata flag as complete protection.

### Membership and count must change together

A like is a unique viewer/post relationship. The proposed mutation says “set liked=true”
rather than “increment the counter.” Repeating the same desired state is harmless; the count
changes only when membership changes.

Initially I would transact membership, count transition, and result/event together. If one
extremely hot post outgrows that counter row, separate aggregate counting with an explicit
staleness contract and reconcile from membership/events. That is a later scale trade-off,
not a reason to claim both immediate strong counts and independent asynchronous writes.

The server returns canonical state and a version. The browser keeps the latest intent over
that base, serializes one in-flight operation per entity, and coalesces rapid toggles. Old
failures cannot blindly reverse the current UI.

Comments and posts need durable operation identity because their content is individually
meaningful. A timeout can occur after insertion. Deleting text from the composer or retrying
with a new ID does not resolve that ambiguity.

Affinity is a derived signal, so it can tolerate delay and be recomputed. It should not grow
forever from repeated view requests or stay inflated after a burst of like/unlike activity
without a deliberate policy. Keep that derived signal separate from canonical membership and
privacy.

## 🧪 Operations and Verification — 5 minutes

| Interface | Contract to discuss |
|-----------|----------------------|
| POST `/api/v1/posts` | Actor-scoped operation, accepted post/result |
| GET `/api/v1/feed` | Viewer-bound session cursor, selected posts, mode, expiry |
| PUT desired like state | Idempotent membership transition, canonical count/version |
| Follow/unfollow operation | Relationship version and invalidation work |
| Refresh hint | Authorized indication that a new feed session may help |
| Profile/history read | Current access and deterministic time-plus-ID pagination |

I would enforce runtime field/length/rate limits and authenticated ownership before these
operations. A shared TypeScript contract reduces drift but cannot validate arbitrary network
input by itself.

Observe acceptance latency separately from fan-out completion. Useful metrics include oldest
task age, retry/partial-chunk rate, cache coverage, candidate count before/after permission
filtering, session reset rate, and page latency. Cache hit rate alone can look excellent
while serving an incomplete candidate set.

A circuit breaker only helps if its fallback can survive the dependency that failed.
Querying the same exhausted SQL pool for popular posts may be a simpler query, but it is not
independent protection during a database outage. Define deadlines and fallback capacity
explicitly.

| Failure test | Invariant |
|--------------|-----------|
| Writer dies after commit | Accepted post/result and outbox work survive |
| Fan-out pipeline partially fails | Missing effects retry without duplicate candidates |
| Follow revokes while task is delayed | Old candidate cannot bypass current permission |
| Rank changes between pages | Existing session order remains stable |
| Same desired like arrives twice | One membership transition and correct count |
| Feed session expires during Back navigation | Explicit reset rather than silent reordering |

Media bytes and personalized privacy also limit caching. Public image derivatives are
suitable for shared CDN caching; a personalized response containing viewer-specific liked
state is not automatically safe to share by URL.

## 📝 Close and Local Boundary — 2 minutes

> “I chose hybrid fan-out to bound the extreme distribution workloads, frozen ranked
> sessions to make reading stable, and current authoritative checks to keep stale caches
> from granting access. Durable receipts and retryable tasks connect those pieces without
> promising exactly-once delivery.”

The local app has inline fan-out, SQL/Redis candidate copies, a hand-tuned ranker, bearer
sessions, and an Opossum feed breaker. It has no outbox, task queue, feed-session snapshot,
desired-state mutation protocol, or functioning live frontend channel.

Its cache combines second/millisecond scores; the home cursor is a native Date string parsed
numerically for Redis. Follow/unfollow leaves stale cache entries, and final hydration omits
privacy checks. Likes/comments/counts are separate writes, and optimistic rollback is not
operation-aware.

Exact schema, source links, and verification limits are in
[architecture.md](./architecture.md#implementation-notes). [README.md](./README.md) covers
actual setup. The capacities here are assumptions; this documentation review did not run a
load benchmark or the full stack.
