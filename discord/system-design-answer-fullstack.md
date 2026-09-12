# Baby Discord: full-stack system design interview

## 🎯 Define one conversation across two transports — 4 minutes

> “I would design a text-chat system where a browser and a terminal client can participate in the same room. The important requirement is that both observe the same accepted conversation, even though one uses HTTP/SSE and the other a raw TCP connection.”

Users can choose a room, read recent history, send text, and recover after a connection
interruption. A browser user gets immediate feedback while sending, can switch rooms
safely, and can read older messages without being pulled to the bottom by every new
arrival.

I would assume authenticated accounts and server-enforced room access for the production
design. The repository's nickname-only identity is a local simplification. A display
name, durable membership, login session, and live connection have different lifetimes;
treating them as one object makes multi-device behavior unreliable.

The first version focuses on text rooms and durable message recovery. Private
conversations can use the same model with a restricted participant set. Voice/video,
attachments, bots, search, reactions, and complex guild hierarchy are separate
extensions rather than features to fit into this whiteboard session.

The central promise is that an accepted message has committed. A successful send does
not claim that Bob received it or read it. If Alice loses the response, retrying the
same operation resolves the existing result. If Bob loses the stream, the system can
replay retained messages or explicitly say that a fresh snapshot is needed.

| User situation | Required behavior |
|----------------|-------------------|
| Alice submits text | Show pending feedback and preserve the content |
| Alice's response is lost | Resolve the same operation without another message |
| Bob connects mid-conversation | Join recent history to live events without a silent gap |
| Alice switches rooms | Old requests cannot place content under the new room |
| One device disconnects | Other sessions and durable access remain intact |
| History is no longer retained | Show a defined recovery/reset boundary |

## 📏 Estimate the workload and response budget — 3 minutes

Assume one million daily users sending twenty messages each. That is twenty million
messages per day, about 231 per second on average and roughly 2,300 per second at a
tenfold peak. At an illustrative 500 bytes per message plus compact metadata, logical
payload is about 10 GB per day or 3.65 TB per year.

Those figures exclude indexes, receipts, outbox records, replicas, backups, and physical
storage overhead. They guide a storage discussion but do not prove a database's
capacity. I would benchmark the intended message size, room distribution, retention, and
history workload before choosing additional storage systems.

Assume 100,000 concurrent connections across gateways. A hot room with 100 messages per
second and 10,000 readers generates one million outgoing deliveries per second. The
service can therefore hit network or slow-reader limits before insert throughput becomes
the main bottleneck.

For the browser, fetch a bounded recent page such as fifty messages and load older
history on demand. A small initial page does not bound memory in a long-running live
session. The client needs its own retained working window and rendering budget.

Proposed targets are regional delivery p95 below 200 milliseconds under a bounded
healthy workload, recent history p95 below 500 milliseconds, and 99.9% command/history
availability. These are design targets, not measured properties of the local teaching
implementation.

## 🏗️ Draw the acceptance and display paths — 5 minutes

I would put one authoritative message path on the whiteboard and show how both
transports reach it. The browser coordinator handles presentation state; it does not
decide the order of committed room messages.

```
┌────────────────────────┐       ┌─────────────────────────┐
│ Browser coordinator    │──────▶│ HTTP/TCP adapters       │
│ Pending / timeline     │       │ Auth + framing          │
└────────────────────────┘       └────────────┬────────────┘
                                              │
                                              ▼
                                 ┌─────────────────────────┐
                                 │ Room authority          │
                                 │ Order / permissions     │
                                 └────────────┬────────────┘
                                              │
                                              ▼
┌────────────────────────┐       ┌─────────────────────────┐
│ Gateway replay         │◀──────│ Durable messages        │
│ + live delivery        │       │ Receipts + outbox       │
└────────────────────────┘       └─────────────────────────┘
```

The terminal reaches the TCP adapter, while the browser posts commands and receives SSE
events. Adapters translate transport-specific input into structured domain operations
containing authenticated user, explicit room, content, and stable operation identity.

A room authority checks permission and serializes acceptance. PostgreSQL initially
stores the message, room head, receipt, and outbox obligation in one transaction. Other
rooms proceed independently. This is an implementable starting point; later partitioning
must preserve those relationships rather than merely replace the database label.

The outbox publisher wakes interested delivery gateways through a notification bus.
Gateways read committed room events and replay after a client cursor. The bus
accelerates delivery, while durable history supplies the missing events after a
disconnect or lost notification.

The browser uses a coordinator and shared store for the active account/room context,
normalized committed messages, pending operations, and stream state. Renderers consume
known message shapes. History, acknowledgements, and incoming events all enter through a
validated normalization boundary.

A shared session-validation mechanism can allow HTTP requests to reach different
gateways, but socket handles remain on their connected gateway. A gateway restart
therefore requires reconnection and replay even if the account session remains valid.
Presence can be derived from per-connection leases independently of durable membership.

## 🧭 Establish contracts that cross the stack — 4 minutes

I would agree on identity and outcome semantics before implementing the UI. Sharing
TypeScript interfaces helps development, but runtime validation and explicit lifecycle
contracts are what make the components agree over the network.

| Contract | Producer | Consumer |
|----------|----------|----------|
| Immutable send operation | Client creates ID, room, and payload | Authority resolves duplicate/changed-payload attempts |
| Accepted message | Transaction assigns stable ID and room sequence | HTTP response, TCP response, history, and live stream |
| History boundary | Server returns bounded page and committed high-water mark | Client starts catch-up after that mark |
| Stream event | Gateway supplies structured event and room cursor | Client validates, merges, and advances applied position |
| Room context generation | Browser creates it on navigation/session change | Every asynchronous completion checks it |
| Connection generation | Gateway assigns an independent stream identity | Cleanup removes only that connection |

A send response distinguishes rejection, durable acceptance, and an unknown outcome when
communication fails. A room query distinguishes an empty valid result from an
unavailable source. The browser can only offer honest recovery if those cases survive
the API boundary.

A stable message ID supports deduplication. A room sequence supports committed ordering
only if the server defines that contract. A global database ID can skip because other
rooms used IDs; a wall-clock timestamp can disagree with commit order. The UI should not
guess continuity from either one.

The history page also needs author, content, room, timestamp, and identity in the same
representation as live events. JSON timestamps are strings, not Date instances. Parsing
and casting a payload to a TypeScript type does not recreate runtime objects or verify
missing fields.

For room-changing commands, return structured effects that the client can apply to
navigation and session state. The server owns command grammar and policy. The browser
can offer hints or autocomplete without separately implementing which operation is
allowed.

## 🔧 Deep dive 1: turn a submitted draft into an accepted message — 8 minutes

> “I would follow Alice's message from her draft to a committed row and back to her pending item. This is where the database transaction and the optimistic interface need the same identity.”

When Alice submits, the browser captures the intended room and immutable content under a
client operation ID. It immediately displays a pending item, keeping the text
recoverable. A pending item is not yet placed into authoritative committed order or
labeled as received by another participant.

The server validates the account, room permission, size, and rate limits. The room
authority acquires its serialization boundary and checks for an existing operation
receipt. A duplicate with the same payload returns the original result; reuse with
different content is a conflict.

Within one transaction, it allocates the next room sequence, inserts the message, stores
the receipt and payload digest, and creates an outbox event. Commit establishes
acceptance. The response returns the stable message identity and room sequence so the
client can reconcile its pending operation.

If the process fails before commit, there is no accepted row. If it fails after commit
but before the response reaches Alice, the result is unknown to her but still resolvable
through that operation ID. Creating another ID on retry risks duplicating a message that
was already accepted.

The publisher processes the durable outbox after commit. A crash after publishing but
before marking progress may send the notification again, so downstream merging must
tolerate duplicates. Publishing without an outbox leaves a different failure: a row can
commit but its notification obligation can disappear with the process.

The SSE echo might reach Alice before the HTTP response. It might arrive later, or the
stream may be disconnected while the POST succeeds. Both paths update one item by
operation/message identity. The browser does not depend exclusively on the echo to know
that the server accepted the message.

A confirmed rejection preserves the failed content with a useful reason. A timeout keeps
an unknown state and offers resolution using the same operation. If Alice navigates to
another room, that pending item remains associated with its original room; it must not
silently be resubmitted to whichever room is now visible.

A terminal adapter can return the same acceptance identity in a readable response, even
if it lacks the browser's pending UI. The shared contract is durable acceptance and
retry behavior, not identical presentation. A plain-text command interface can still
provide structured IDs as part of its defined protocol.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Identified pending UI plus transactional receipt/outbox | Responsive feedback with resolvable durable effects | More state and transaction work |
| ❌ Wait only for live echo | Simpler browser state | A receive failure hides an accepted send |
| ❌ Clear draft and retry with a new ID | Easy request handling | Lost text or duplicated committed messages |

The cost is explicit uncertainty and reconciliation. That is preferable to presenting a
guessed success or deleting the user's words. I would test both completion orders and a
lost response after commit, inspecting the database identity as well as the browser
timeline.

## 🔧 Deep dive 2: recover history while the user changes rooms — 8 minutes

> “I would treat history synchronization and navigation as one correctness problem. The server supplies a recoverable boundary; the client makes sure that boundary belongs to the room the user is actually viewing.”

Suppose Bob opens a room. If the client fetches history and then opens an unresumable
stream, a message can commit in the gap and appear in neither. No request has to fail
for the transcript to become incomplete.

Instead, history returns a recent page and the committed room head. The stream starts
after that cursor and replays the retained gap. The gateway establishes notification
coverage, catches up through a known committed boundary, and continues delivery. It uses
message identity and room order to absorb overlap.

A missed notification also needs repair when no later message arrives to wake the
gateway. Bounded head checks shared among local subscribers, or a durable consumption
path at larger scale, allow eventual catch-up. Pub/Sub alone cannot supply a
disconnected subscriber's missing events.

On the browser, a coordinator owns the current account, room, and navigation generation.
Every history request, subscription callback, and recovery result carries that context.
Switching from room A to B increments the generation and closes A's known stream, while
late A completions are discarded from B's visible state.

Cancellation saves resources but is not the correctness boundary. A request may already
have committed, and a callback can already be queued. The result must still match the
active context before it changes the timeline or connection state.

Now consider two streams for the same room during replacement. The server gives each a
distinct connection generation and removes only the matching generation on close. Keying
both by user and room allows the old close handler to delete the new subscription, even
if the browser correctly closed its old EventSource.

SSE reconnection and replay are different responsibilities. The browser can carry a
received event ID on reconnect, but the server must retain and replay the corresponding
interval. For a newly created stream, an initial cursor can use the endpoint's URL
contract. Neither mechanism replaces authorization or a validated application cursor.

The client advances its applied cursor after validating and merging the event. It does
not advance merely because bytes arrived. A sequence gap or incompatible payload
triggers catch-up. If retention no longer covers the cursor, the UI shows reset-required
state and loads a new recent snapshot without claiming discarded events were delivered.

Older-history pagination remains independent. A recent page ending at head H does not
mean Bob loaded the beginning of the room. Loading earlier pages merges by identity and
preserves the scroll anchor while incoming messages continue at the other end.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Retained replay plus context generations | Recovers gaps and isolates room navigation | Stronger server contract and client lifecycle state |
| ❌ History then plain live stream | Minimal coordination | Silent join/reconnect gaps |
| ❌ Close old stream without checking completions | Saves a connection | Late responses and close handlers can still affect replacements |

The trade-off is coordination and retained replay state. Stream-first buffering can be
an alternative after subscription confirmation, but it still needs stable identity, an
authoritative boundary, and a buffer limit. The useful test is not “EventSource opened”;
it is that Bob sees the correct retained conversation after each handoff and room
switch.

## 🔧 Deep dive 3: share domain behavior without sharing lifecycle mistakes — 7 minutes

> “I would make transport independence mean that all clients follow the same acceptance and permission rules. Their framing, connection ownership, and presentation remain specific to the adapter.”

The core produces a structured message event. The TCP adapter formats a readable line or
protocol frame; the SSE adapter serializes a versioned envelope. History and
acknowledgements normalize into that same semantic event. A shared string formatter
loses information if the browser then tries to infer author, timestamp, and identity
from display text.

Each adapter validates its input boundaries. TCP packets are not commands: several lines
can arrive together, or one line and UTF-8 character can span packets. Use a bounded
incremental decoder and per-session command queue. HTTP requests also overlap, so the
domain operation carries its intended room instead of reading mutable current-room state
after awaits.

A session belongs to an authenticated account, and a connection belongs to a particular
device/tab and gateway. A room subscription is attached to that connection. Durable
membership expresses access. Closing one device removes its live state while leaving
other devices' subscriptions and permissions intact.

This matters in the UI as well. Restoring a stored session object after reload does not
establish that the server still recognizes it. Validate the session, preserve drafts
during reauthentication, and centralize expired-session handling. An account change
advances the context generation so old responses cannot update the new user's state.

Permission changes must reach the same authority that accepts sends and grants
history/stream access. If a gateway caches room policy, it needs a revision/revocation
mechanism with a defined boundary. Hiding a room icon is helpful navigation behavior,
not enforcement against a TCP client or a direct HTTP request.

Presence can remain approximate. Per-connection leases let the service derive whether
any device remains live, while an abrupt disconnect eventually expires. A database
membership count or a sidebar label saying Online does not prove that the user currently
has a functioning receive stream.

Direct messages are another example of the distinction. An ephemeral local send to every
session in one process can demonstrate routing, but it is not distributed private
conversation history. A production DM uses authorized participants and the same durable
acceptance/replay model, plus routing to the devices that are actually connected.

Both adapters bound output. A slow browser or terminal cannot accumulate unlimited
buffers while the server continues reporting healthy delivery. Disconnecting it with a
resumable cursor is better than exhausting the gateway for every participant. During
shutdown, stop admitting work and track accepted in-flight operations rather than
equating a fixed wait with a completed drain.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Structured domain contract with adapter-owned framing | Same conversation semantics across clients | Separate lifecycle/backpressure implementations |
| ❌ Shared plain-text output as the canonical event | Small common formatter | Browser loses stable fields and multiline framing |
| ❌ One user/room flag for membership and presence | Simple state model | Multiple devices and reconnects corrupt each other's state |

The cost is additional identity and ownership concepts. I would keep them visible in the
interfaces because they prevent cross-room and cross-device errors that are difficult to
repair after deployment. They also let the browser explain the difference between
reconnecting, unauthorized, and genuinely empty history.

## 📈 Scale and verify the complete path — 4 minutes

The first scalability work is bounding connections, message size/rate, TCP partial
buffers, matching room subscribers, history pages, and queued output. A hot room needs
shared delivery work and egress capacity, not just another database shard. Gateway
room-to-subscriber indexes avoid scanning every local session for each message.

For the browser, use stable IDs, a bounded working timeline, and virtualization when
history grows. Preserve the visible scroll anchor, auto-scroll only near the bottom, and
provide jump-to-latest. Keep pending operations and drafts outside transient rendering
state so an unmount does not discard them.

The interface should remain useful during partial failure. A stale room list can be
labeled and retried while the current conversation remains visible. A timeline-rendering
error should not erase the composer and navigation. Screen-reader announcements should
be concise and avoid continuously interrupting someone reading scrollback.

Observe accepted commits, outbox lag, replay delay, sequence gaps, pending/unknown send
age, stream replacement, and per-connection queued bytes. Measure what clients apply as
well as what servers publish. A healthy Redis client object or a registered but unused
metric is weak evidence of working delivery.

Verification should inject a lost send response, duplicate retry, missed notification,
malformed timestamp, reordered room joins, old-stream close after replacement, expired
cursor, and gateway shutdown during active sends. Check both durable rows and
browser/terminal output. Mocked HTTP route tests and page headings cover only a small
part of that path.

## 🛠️ Ground the proposal in the repository — 2 minutes

Baby Discord already shares a command core between TCP and HTTP/SSE, and it waits for
PostgreSQL insertion before local buffering and broadcast. It does not implement the
proposed receipts, outbox, ordered room cursors, shared sessions, or replay. Its
nickname users and flat rooms are deliberately smaller than a full community platform.

The source audit found that remote JSON messages fail on a string timestamp, local live
browser messages fall back to system text, and new rooms lack runtime subscriptions.
Browser sends discard response bodies; room switching lacks generations; session and
membership state can outlive closed streams. The seed and existing smoke tests also
contain stale assumptions.

Selected isolated checks confirmed persistence ordering and delivery/lifecycle defects
without running a full stack or load test. I would first repair the message contract and
remote delivery, then connect stable send outcomes, replay, and context ownership across
the stack. [Architecture and current implementation
notes](./architecture.md#implementation-notes)
