# Baby Discord: backend system design interview

## 🎯 Establish message and membership guarantees — 4 minutes

> “I would design a text-chat service with a shared domain layer behind TCP and browser adapters. The key contracts are what an accepted message means, how a room is ordered, and how a client recovers when live delivery stops.”

The first version supports authenticated users, text rooms, message sends, recent and
paginated history, and room-scoped live delivery. Direct conversations can use the same
durable model with a restricted participant set. Voice/video, bots, rich attachments,
search, and complex guild permissions are separate extensions for this interview.

An accepted message has committed to durable storage. The acknowledgement does not mean
that every connected recipient received it or that a person read it. If the response is
lost, retrying the same operation must resolve to the same message rather than insert
another copy.

I would promise order within a room, not a global order across all conversations. A
client can replay retained committed messages after a room cursor. If that cursor is
older than the retention boundary, the service explicitly requests a reset instead of
implying that the client missed nothing.

Presence can be approximate, but room access cannot depend on an approximate online
flag. A user may have several devices, and closing one connection must not remove
another device's permission or confuse its subscription. This distinction affects both
the data model and the disconnect path.

| Requirement | Initial contract |
|-------------|------------------|
| Send acceptance | Message, operation receipt, and notification obligation commit together |
| Ordering | One authoritative committed sequence per room |
| Retry | Same scoped operation ID and payload return the original result |
| Recovery | Bounded retained replay with explicit cursor-expired response |
| Access | Validate user and room permission at reads, subscriptions, and sends |
| Presence | Derived from independent connection leases, not durable membership count |

## 📏 Estimate storage and fan-out — 3 minutes

Assume one million daily users sending twenty messages each. That is twenty million
messages per day, about 231 per second on average and roughly 2,300 per second at a
tenfold peak. I would state those as workload assumptions rather than borrow an
unsupported throughput claim from a database vendor.

At an illustrative 500 bytes per message and compact metadata, the logical payload is
about 10 GB daily or 3.65 TB yearly. Indexes, receipts, outbox state, replicas, backups,
and physical row overhead increase storage. Retention and expected history access
determine how much stays on the primary serving tier.

Assume 100,000 concurrent connections across the fleet. A hypothetical 30 KiB of state
per connection is about 2.9 GiB before room subscriptions and queued output. The actual
number depends on buffers, TLS, runtime, and traffic; I would measure it rather than
claim every Node process can hold a fixed number of sockets.

Fan-out can dominate writes. One room producing 100 messages per second for 10,000
readers generates one million deliveries per second, roughly 500 MB per second of
payload at the same size assumption. Adding message-storage shards does not solve that
output load.

Proposed targets are 99.9% command/history availability, regional delivery p95 below 200
milliseconds under a bounded healthy workload, and a recent-page p95 below 500
milliseconds. The target workload must include room audience distribution and slow
readers, not just average insert rate.

## 🏗️ Draw the authority and delivery boundaries — 5 minutes

I would use PostgreSQL for the initial durable message and metadata model, with explicit
room ownership. A cache and notification bus can accelerate delivery, but neither
replaces the source used to resolve acceptance and replay.

```
┌──────────────────────┐       ┌─────────────────────────┐
│ TCP / HTTP           │──────▶│ Room authority          │
│ adapters             │       │ Policy / order          │
└──────────────────────┘       └────────────┬────────────┘
                                            │
                                            ▼
                               ┌─────────────────────────┐
                               │ PostgreSQL              │
                               │ Messages / receipts     │
                               │ Outbox                  │
                               └────────────┬────────────┘
                                            │
                                            ▼
┌──────────────────────┐       ┌─────────────────────────┐
│ Gateway replay       │◀──────│ Outbox publisher        │
│ + live fan-out       │       │ Notification bus        │
└──────────────────────┘       └─────────────────────────┘
```

Adapters handle transport framing, credentials, connection lifetime, and backpressure.
They pass structured intent to the domain layer: authenticated user, explicit room,
operation identity, and content. The domain layer does not return a socket-formatted
string as the canonical message representation.

The room authority validates permission and serializes acceptance. One relational
transaction can establish the room sequence, message, receipt, and outbox obligation.
Different rooms proceed independently. A room head row can provide an initial
serialization point; a later dedicated owner still needs a fenced commit boundary.

The publisher turns durable outbox obligations into fan-out notifications. Gateways with
interested local subscribers read committed room events and deliver them in order.
Notifications are wakeups; retained room history supplies catch-up after missed events
or reconnects.

A shared session-validation service allows requests to reach different gateways.
Connection handles remain local and need recovery when a gateway dies. A gateway with
sockets is stateful even if the corresponding account/session can be validated
elsewhere.

I would separate ingestion/commands, history reads, and fan-out resource budgets before
splitting every responsibility into a service. At larger measured volume, partition room
ownership across storage nodes. A durable broker or wide-column history store can be
introduced with a clear replay and transaction story, not by replacing a database name
on the diagram.

## 💾 Describe the records and APIs — 4 minutes

The important schema choices are the relationships that prevent ambiguity. I would
sketch them as a table instead of writing database definitions on the whiteboard.

| Record | Key fields | Correctness purpose |
|--------|------------|---------------------|
| User/session | Account ID, credential/session version, expiry | Authenticate independently of display nickname |
| Room/membership | Room ID, policy revision, authorized members | Enforce durable access |
| Room head | Last committed sequence, owner generation where used | Serialize room acceptance and fence old owners |
| Message | Stable ID, room sequence, author, time, content | Ordered durable conversation |
| Send receipt | User/device scope, operation ID, payload digest, result | Resolve duplicate or unknown sends |
| Outbox | Event identity, room sequence, publication status | Repair commit-to-notification failures |
| Connection/subscription | Session, connection generation, room, lease | Manage multiple devices and stream replacement |
| Retention boundary | Earliest retained replay position | Tell clients when a reset is required |

A display nickname can change while the stable author ID stays fixed. The message
presentation policy determines whether historical display names are snapshots or current
profiles. That decision should not accidentally vary between startup history and live
delivery.

| Proposed operation | Purpose |
|--------------------|---------|
| Create authenticated session | Establish account identity and revocation policy |
| Send to explicit room with operation ID | Return durable message identity and room sequence |
| Get recent history with cursor | Return a bounded page and synchronization boundary |
| Stream room events after cursor | Replay retained events and continue live |
| Get older page before cursor | Read older history without changing the live position |
| Join/leave durable membership | Update access according to room policy |
| Close connection/subscription | Remove only the corresponding live device state |

A TCP slash-command parser can translate into these operations without becoming a second
implementation of permission and persistence rules. Browser APIs can use structured
requests and errors. Both adapters must enforce a common message-size/rate policy while
respecting their own framing limits.

## 🔧 Deep dive 1: commit, ordering, and retry identity — 8 minutes

> “I would choose a transaction containing the message, receipt, room head, and outbox record. That makes the acceptance boundary explicit and closes the common gap between saving a message and remembering to deliver it.”

A client supplies an operation ID scoped to its authenticated sender/device and an
immutable payload containing the intended room. The authority first resolves an existing
receipt when available. A changed payload under the same identity is a conflict;
returning success for different content would make the receipt meaningless.

The write transaction acquires the room's serialization boundary and checks the
permission state required for acceptance. It allocates the next transactional room
sequence, writes the message, records the operation result, and adds the outbox event.
The receipt's uniqueness arbitrates concurrent retries; a check outside the transaction
is only an optimization. Permission changes use that same authority or an equivalent
policy-revision check, so a cached permission cannot authorize a send after revocation.

On commit, the response can state that the message is accepted. A crash before commit
leaves no accepted message. A crash after commit but before response leaves a result
that can be resolved through the same operation identity. The client must not generate a
fresh identity simply because it did not receive the response.

The publisher processes the outbox independently. If it publishes but crashes before
recording progress, it may publish again. Stable event identity and replay-aware
gateway/client handling absorb that duplication. Marking the outbox complete before
publication would instead create a message that is never announced.

Room order comes from the committed room sequence, not from wall-clock timestamps or a
global SERIAL column. Sequence allocation can happen before another transaction commits,
and a global sequence also contains gaps from other rooms. The proposed transactional
room head is incremented while acceptance is serialized, so rollback does not create a
falsely completed room position.

If a dedicated room owner later replaces the row-lock approach, include its ownership
generation in the durable conditional update. A lease that expired in memory does not
prevent its old worker from committing late. New and old owners must not both create the
next accepted room event.

Directly inserting a message and publishing afterward is attractive for a small demo,
and it already gives durable storage when the insert is awaited. Its weakness is the
dual write: the database and bus can disagree after a crash. A best-effort in-memory
buffer before persistence weakens the acceptance guarantee further and is not required
for a responsive UI.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Transactional message, receipt, head, and outbox | Resolvable acceptance and repairable delivery obligations | Additional writes and room serialization |
| ❌ Insert then untracked publish | Simple synchronous storage path | Commit-to-fan-out gap remains |
| ❌ Redis check, insert, then cache receipt | Fast common retry path | Concurrent duplicate and crash windows |

The cost is contention within a hot room and receipt/outbox retention. I would preserve
the contract while batching or partitioning independent rooms. I would not bypass it
with an acknowledgement issued before the relevant durability boundary merely to improve
a latency graph.

## 🔧 Deep dive 2: reliable history over imperfect fan-out — 8 minutes

> “I would separate the fast notification path from the authoritative replay path. Redis Pub/Sub can tell a gateway that something changed, but it cannot supply the events a disconnected subscriber missed.”

For a room subscription, the gateway validates access, establishes notification
coverage, and reads a committed high-water mark. It fetches retained events after the
client's cursor through that mark, then continues reading new committed events.
Notifications wake catch-up work; they do not directly establish that every previous
event has arrived.

A history response contains a bounded page and the high-water mark for synchronization.
The mark does not imply that the client loaded the entire older conversation. Older-page
pagination and live catch-up have separate cursors and can proceed without overwriting
each other's state.

The handoff must tolerate a message committed between the history query and live
attachment. Replay covers that interval. It also tolerates duplicate notifications and
reconnect overlap because the gateway/client recognizes already-applied message
identities and sequences.

A lost notification with no later traffic is another case to handle. Use bounded
periodic head/catch-up checks shared per room on each interested gateway, or a durable
event-consumption path at larger scale. Without such a repair mechanism, a committed
message can remain invisible indefinitely even though future notifications are usually
reliable.

Redis Pub/Sub provides at-most-once delivery and no replay for missed subscriber
messages. That is appropriate for this notification role, but insufficient as the only
record of accepted conversation events. A subscriber reconnecting successfully does not
recover the time it was absent. [Redis delivery
semantics](https://redis.io/docs/latest/develop/pubsub/)

A durable broker is an alternative when long replay windows and many independent
consumers justify it. It adds partitioning, retention, checkpoints, and ownership
transitions. A single consumer group distributes events among workers; delivery still
needs routing to every gateway with interested clients, rather than assuming all group
members see every record.

SSE offers browser reconnection and event IDs, but the server must implement the cursor
contract and retained data. If a cursor is too old, return a reset-required condition
with a fresh snapshot path. If a client receives malformed or out-of-order data, it
should not advance past an unvalidated gap.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Notifications plus authoritative ordered catch-up | Simple low-latency path with repairable gaps | Requires retained history and bounded repair work |
| ❌ Pub/Sub as the only delivery record | Minimal broker operations | Subscriber failures silently lose messages |
| ❌ Unbounded client stream-first buffering | Avoids one history-first gap | Can exhaust memory and still lacks a proven boundary |

The trade-off is catch-up load and a retention promise. Share room reads across local
subscribers, cap replay batches, and disconnect slow consumers with a resumable cursor
rather than retaining unlimited output. An event's bytes entering a socket buffer is not
evidence that the client application applied it.

I would test the boundary by committing messages before, during, and after subscription
establishment, dropping the notification, and replaying an overlapping interval. The
expected result is a continuous retained room log at the client, with an explicit reset
when that continuity can no longer be provided.

## 🔧 Deep dive 3: transport independence with correct lifecycle — 7 minutes

> “I would keep domain events structured and transport lifecycle explicit. Sharing a command handler is useful, but it does not by itself make TCP and SSE carry the same information or recover in the same way.”

The domain result contains stable message identity, room, author, content, and committed
order. The TCP adapter can format a readable line, while the SSE adapter serializes the
event envelope and frames it correctly. Formatting plain text inside the core and then
trying to recover JSON fields in the browser loses identity and timestamp information.

JSON also does not preserve a JavaScript Date instance. A typed cast after parsing does
not recreate one. Normalize timestamps at the boundary or keep the transport contract as
an explicit UTC string; do not let a downstream Date-method call decide whether a remote
message can be delivered.

TCP requires bounded incremental framing. A packet is not a command: one packet may
contain several lines, and one UTF-8 character or line can cross packets. Maintain a
bounded decoder/buffer and a per-session command queue so asynchronous handling of
separate data events does not reorder joins and sends.

HTTP requests can overlap too. A send carries its intended room instead of consulting a
mutable session.currentRoom after several awaits. Joining room B while a send to A is
pending must not cause that send to be persisted under A and broadcast as B.

Subscriptions need distinct connection generations. Closing an old response removes only
its own registered connection, even when a replacement has the same user and room.
Permission and session validity are checked when attaching and according to a revocation
policy afterward. A URL room name is not itself proof of membership.

Presence is tracked per connection with expiry or explicit closure. Durable membership
remains separate. Multiple sessions can belong to one user, so removing one connection
does not delete the shared membership record or declare all devices offline. Distributed
direct-message routing likewise needs an account-to-gateway directory or durable
conversation subscriptions.

Both adapters need backpressure. Bound output bytes and in-flight commands; pause or
close a slow connection while retaining a recovery cursor. During shutdown, stop
admitting work, track and drain accepted operations within a deadline, then close
connections and dependencies. Waiting on a timer alone does not prove that asynchronous
work has finished.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Structured domain events and explicit connection ownership | Consistent semantics across transports and devices | Adapter-specific framing and lifecycle code |
| ❌ Shared string formatter for every transport | Small common interface | Loses structured identity and can corrupt framing |
| ❌ User-level online/membership flag | Simple disconnect logic | One device can erase another device's state |

The cost is more precise interfaces and cleanup logic. I would accept that cost because
the dual-adapter design is valuable only if it preserves the same domain contract.
Otherwise it shares code while presenting different conversations to terminal and
browser users.

## 📈 Scale, observe, and verify — 4 minutes

The first limits are likely hot-room fan-out, slow-client buffers, repeated history
work, and unbounded connection/session maps. I would bound these before adding gateways.
Maintain room-to-local-subscriber indexes instead of scanning every session for each
message, and share catch-up work for clients watching the same room.

Separate interactive history from acceptance and delivery budgets. A large history
export should not block current chat. When storage needs partitioning, keep a room's
authority, receipt, and ordered append relationship explicit. Cross-region gateways can
follow a room's home authority; independent writers require a different conflict/order
design.

Observe accepted commits, retry resolution, outbox age, missed-notification repair,
replay latency, sequence gaps, per-connection queued bytes, and actual disconnect
causes. A configured histogram with no observations is not instrumentation. Health
checks should distinguish process liveness from the ability to accept writes or deliver
room events.

Verification covers duplicate send races, unknown commit outcomes, publisher crashes,
lost notifications, expired cursors, stale owners, TCP packet splitting, concurrent room
changes, and stream replacement. Fault injection should show both durable database state
and what clients observe. A route test with the chat handler mocked cannot prove
delivery correctness.

## 🛠️ Relate this to the repository — 2 minutes

The current project uses PostgreSQL, Valkey Pub/Sub, TCP, and HTTP/SSE. It awaits
message insertion before buffering and broadcast, contrary to its former
asynchronous-persistence description. It has no send receipt, room sequence, or outbox.
Sessions and recent buffers are process-local, and subscriptions are established only at
startup.

Remote JSON messages fail because the router calls a Date method on a string timestamp.
Local live messages are formatted as plain text, and remote events never update the
receiving history buffer. Membership, session, and stream lifetimes are not independent,
while several metrics and configuration options are defined but unused.

The documentation audit read source and ran selected isolated checks; it did not run the
complete stack, real concurrency, or load tests. I would first repair the wire contract
and fan-out path, then implement explicit send identity and replay, followed by bounded
lifecycle and authority changes. [Current implementation
mapping](./architecture.md#implementation-notes)
