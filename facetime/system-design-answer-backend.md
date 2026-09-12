# FaceTime: Backend System Design Interview

## 🎯 Requirements and Scale — 5 minutes

> “I’ll design the backend of a FaceTime-inspired calling service. I’ll separate call
> control from media transport, because an accepted invitation and a working audio path are
> different facts.”

The initial product supports one-to-one audio/video calls, ringing all of an invited user’s
devices, one answering device, call termination, and private call history. Group calling is
a bounded extension through an SFU. I would defer recording, shared playback, effects, and
device handoff until the control and recovery model is established.

I would clarify the busy policy. For this answer, a user can have at most one accepted call,
and Decline rejects the invitation for that user across devices. Dismissing only one
device’s notification would be a separate action. These choices affect both the data model
and concurrent acceptance behavior.

| Requirement | Initial target or invariant |
|-------------|-----------------------------|
| Online ringing | p95 below two seconds from request to an online device’s ring |
| Media setup | p95 below three seconds from acceptance to usable media |
| Media delay | Aim below 200 ms one-way in a supported regional profile |
| Control availability | Proposed 99.9% regional availability |
| Device acceptance | At most one winning device per invited user/seat |
| Retry behavior | One durable outcome for the same actor, operation ID, and body |
| History and access | Only authorized participants can read or control their calls |
| Group extension | Evaluate up to 32 participants with bounded subscriptions |

These targets exclude human response time and are not measurements of the repository. TURN
improves connectivity but cannot promise success through every firewall or provider outage.
I would also distinguish measured network RTT from total one-way media delay, which includes
capture, encoding, buffering, and playback.

For sizing, assume 100,000 concurrent one-to-one calls and a five-minute average duration.
At steady occupancy, that is about 333 new calls per second. If a completed call produces
thirty application signaling messages, the average call-related load is about 10,000
messages per second.

Now assume two million online sockets sending one heartbeat every thirty seconds. That adds
about 66,667 inbound messages per second even if most users are not calling. Connection
management and call creation therefore need separate capacity models.

For media, suppose 20% of those calls use TURN and each endpoint sends 1.5 Mb/s. Twenty
thousand relayed calls produce 60 Gb/s of relay ingress and another 60 Gb/s of egress across
the fleet. Relay ratio and actual bitrates are assumptions to replace with
selected-candidate measurements.

## 🏗️ Architecture, Records, and Interfaces — 6 minutes

> “I’ll use a transactional authority for call lifecycle decisions, gateways for live device
> connections, and a separate media path. Redis helps route and cache; it does not
> independently decide who won a call.”

```
┌──────────────────────┐     ┌──────────────────────┐
│ Device connections   │────▶│ Authenticated gateway│
└──────────────────────┘     └──────────┬───────────┘
                                        ▼
┌──────────────────────┐     ┌──────────────────────┐
│ Presence / routing   │◀────│ Call authority       │
└──────────────────────┘     └──────────┬───────────┘
                                        ▼
                             ┌──────────────────────┐
                             │ PostgreSQL + outbox  │
                             │ Claims and receipts  │
                             └──────────────────────┘
```

The media path is direct between browsers, through TURN as an opaque relay, or through an
SFU for a group. Signaling carries session descriptions, candidates, and control decisions.
It does not carry every video frame.

Gateways authenticate sessions and bind devices/connections to accounts. They route commands
to the call service and deliver versioned events. A device registry maps an active
connection to its gateway, with a lease that expires independently of the user’s other
devices.

PostgreSQL stores lifecycle state and the invariants that must survive process failure.
Redis can cache current revisions and routes. A notification bus helps distribute committed
events, while an outbox supplies recovery when publishing and database commit do not happen
together.

| Record | Key contents or constraint |
|--------|----------------------------|
| User/device | Authenticated account, verified device ownership |
| Connection lease | Connection ID, device, gateway route, generation, expiry |
| Call | Initiator, modality, revision, deadline, terminal reason |
| Invitation/seat | Invited user, state, winning device and endpoint generation |
| Active-user slot | Unique active claim enforcing the busy policy across calls |
| Command receipt | Actor, operation ID, body digest, call ID, outcome |
| Call event/outbox | Call revision, event, recipients, delivery progress |
| History projection | Authorized participant view of committed call records |

I would keep media phase separate from invitation state. The server can know that Bob
accepted at revision 4, while Bob’s browser is still negotiating. Client reports of first
usable media help observability, but are not a substitute for authoritative membership.

| Interface | Purpose |
|-----------|---------|
| Session/login API | Authenticate the account and establish a session |
| Device registration | Bind a verified device and current connection generation |
| Call initiate command | Create invitation with a stable retry identity |
| Call accept/decline/end commands | Request conditional lifecycle changes |
| Call snapshot/resume | Retrieve current revision and endpoint claims |
| SDP/ICE messages | Negotiate only between authorized endpoint generations |
| TURN credential API | Issue bounded relay access for an authorized purpose |
| History API | Cursor-paginated calls visible to the current account |

These are proposed contracts, not an inventory of the local routes. In particular, a user ID
in a history URL does not authorize access to that user’s calls.

## 🔧 Deep Dive: One Call and One Winning Device — 9 minutes

> “I’ll commit call creation, retry receipts, and ring events together. I’ll also make
> acceptance conditional in storage. This handles failures at the exact places where a user
> can otherwise see phantom rings or two devices claiming success.”

A caller supplies an operation ID and the intended recipients/modality. The server scopes
that ID to the authenticated actor and compares a digest of the body. Retrying the same
request returns its recorded outcome. Reusing the ID for a different call is rejected rather
than silently changing its meaning.

The creation transaction validates policy, reserves the caller’s active slot, creates the
call and invitations, and writes the receipt and outbox entries. If the transaction aborts,
there is no successful receipt pointing to a nonexistent call. If the response is lost after
commit, a retry retrieves the original call ID.

Storing a Redis key before the SQL insert does not solve this atomically. It replaces a
duplicate-call risk with a dead-ID risk, and a separate GET followed by SET still lets
simultaneous requests both proceed. Moving the same two independent writes into the opposite
order merely moves the crash window.

| Creation strategy | Benefit | Cost or failure |
|-------------------|---------|-----------------|
| ✅ Receipt, call, and outbox in one transaction | One recoverable committed outcome | Durable receipt retention and delivery worker |
| ❌ Best-effort Redis key before SQL | Can suppress some sequential retries | Can point to a call that never existed; concurrent requests still race |
| ❌ SQL followed by an unrelated notification send | Small initial path | Commit can succeed while the ring event is lost |

For acceptance, imagine Alice’s phone and laptop answering together. Both can send a
request, but only one transaction may claim Alice’s invited seat while it is still ringing
and before its deadline. The winning device, participant state, call revision, receipt, and
sibling-dismiss events commit together.

A losing request returns the canonical winner. If the winning response was lost, the same
operation can recover its success. We do not infer “already answered” solely from a locked
row being temporarily unavailable; we distinguish contention, a committed winner, and a
terminal call.

The busy rule crosses call IDs. Locking just this call cannot prevent Alice’s phone from
accepting call A while her laptop accepts call B. A unique active-user slot, acquired
transactionally in a stable locking order, enforces the account-wide rule. The initial
policy can reserve the caller’s slot while their outgoing invitation is pending.

Decline, cancel, answer, and timeout all participate in this same transition protocol. A
stale timer checks the current state and deadline inside the conditional transition. It
cannot read ringing, wait behind an answer, and then unconditionally overwrite the call as
missed.

For a group, each invited user claims a separate seat. The room can become active after one
person joins while other invitations remain open until their own deadline. A single
room-wide ringing flag would incorrectly prevent the remaining invitees from answering.

Terminal transitions are idempotent. Ending a call releases active slots, records the reason
and final timestamps, and produces termination events once as a committed effect. Duplicate
deliveries can still occur, so clients ignore repeated or older revisions. This is
exactly-once effect under the receipt model, not exactly-once network delivery.

I would retain a clear history model. Call duration based on acceptance differs from
measured media duration. Store the timestamps needed to explain that difference and avoid
calling an unanswered invitation a successful conversation just because it has a participant
row.

The cost is transactional coordination and deliberate policy. I accept that for a small
number of lifecycle events per call. Media packets and routine candidate forwarding do not
need to pay that transaction cost, so a generic claim that PostgreSQL is too slow for video
calling misses the separation between paths.

## 📡 Deep Dive: Routing, Presence, and Reconnection — 9 minutes

> “A socket lives on one gateway. I’ll make that placement explicit and make call decisions
> recoverable when a gateway disappears.”

Each authenticated connection has an ID, device identity, gateway route, and lease
generation. Heartbeats refresh that connection’s lease. Several tabs may belong to one
device, but closing one must not erase another live connection’s route or mark the entire
device offline.

A user-to-connection index supports ring fan-out. Its entries are validated against live
leases. A single expiring hash per user cannot independently expire an abandoned device if
another device keeps refreshing the whole key. Expiration is also cleanup, not a durable
decision that an accepted call ended.

The authority commits a ring event before delivery. A worker resolves current routes and
delivers it to the appropriate gateways. An acknowledgment from a gateway only proves that
gateway received it; it does not prove the user saw it or accepted it.

Events include call revision and expiry. If delayed delivery reaches a phone after the
laptop already answered, the phone checks current state or observes the newer revision and
declines to show an actionable stale invitation. Offline push, if later added, follows the
same rule when the app wakes.

| Delivery approach | Strength | Cost or limitation |
|-------------------|----------|--------------------|
| ✅ Durable events plus current connection routing | Recovers after publisher/gateway failures | Needs deduplication, expiry, and acknowledgment semantics |
| ❌ Process-local user maps only | Very simple local implementation | Users on different processes cannot reach one another |
| ❌ Redis pub/sub as the complete protocol | Convenient live fan-out | Missed messages, call claims, and deadline recovery remain unsolved |

A reconnecting device authenticates again, obtains a fresh connection generation, and
retrieves current call state. If it still owns its accepted seat, it can resume control. If
the call ended or another device took over through an authorized transfer, old commands and
negotiation messages must be rejected.

Healthy direct media can continue during a short signaling interruption. I would allow a
bounded grace period and reconcile before forcing renegotiation. Conversely, the signaling
socket can remain open while the media path fails. That requires a media recovery attempt,
not merely another heartbeat.

SDP and ICE messages are addressed to the authorized endpoint pair and a negotiation
generation. The server checks sender membership, destination, current claims, type, and
payload bounds. It does not trust a claimed actor embedded in an arbitrary message.

Candidate delivery needs ordering and scope. The client queues candidates until the matching
remote description is installed, then applies them to that attempt. Restarting ICE changes
the generation; old candidates and old duplicate-suppression entries cannot be treated as
current.

I would not mistake candidate hashing for reliable delivery. Marking a candidate seen before
forwarding it can lose the candidate if delivery then fails. If the transport session cannot
be resumed coherently, negotiate a fresh generation instead of replaying unknown fragments
indefinitely.

Ringing deadlines live in durable state. A scheduled worker or periodic indexed sweeper
finds eligible expired invitations and performs conditional transitions. An in-process timer
can optimize responsiveness, but is not the only mechanism; a server restart must not leave
a call ringing forever.

Backpressure is part of gateway design. Bound message size, per-connection rates,
outstanding negotiation work, and output queues. Reject unsupported types before using them
as metric labels. A socket is not inherently rate-limited merely because it is one
connection.

The trade-off is more coordination between durable state and transient routes. It allows
gateways to fail independently without turning every reconnect into a new call or silently
preserving obsolete participation.

## 🌐 Deep Dive: Media Paths and Group Scaling — 10 minutes

> “I’ll prefer direct media for ordinary one-to-one calls, provide tested TURN fallback, and
> use selective forwarding for groups. Each topology has a different bandwidth and trust
> model.”

ICE tests candidate pairs that may use local addresses, reflexive addresses discovered
through STUN, or relay allocations from TURN. It does not require application logic to wait
a fixed time for each category in sequence. The browser can test candidates while gathering
continues.

A direct path avoids unnecessary relay traffic, but is not automatically the fastest
Internet path. TURN can help with difficult networks or deliberately hide peer addresses.
The service still pays for signaling and presence even when media is direct, so “zero server
cost” is too broad.

TURN infrastructure requires reachable listening and relay ports, supported transports,
capacity limits, and appropriate credentials. A public credential endpoint with a permanent
shared password offers no per-user allocation policy. I would issue time-limited credentials
through a supported Coturn mechanism and define renewal behavior for long sessions.

Credential expiry does not mean every active call should abruptly stop at the five-minute
mark. The design must account for allocation/channel refresh and future reconnects.
Likewise, a published TLS port is meaningless unless a real TLS listener and certificate
configuration exist.

| One-to-one choice | Why use it | What it costs |
|-------------------|------------|---------------|
| ✅ Direct candidates plus TURN fallback | Avoids relaying media when a useful direct path exists | More candidate paths and relay testing |
| ❌ Always relay by default | Predictable infrastructure path and address-privacy option | Bandwidth for every call and dependence on relay placement |
| ❌ STUN without operational TURN | Minimal media infrastructure | Some NAT/firewall combinations cannot establish a useful path |

For a group mesh with N participants, each endpoint has N−1 peers and there are N(N−1)/2
peer pairs in total. At six people, that is five peers per endpoint and fifteen total pairs.
At 32 people and 1.5 Mb/s per outgoing peer, an endpoint would upload 46.5 Mb/s before
overhead.

An SFU lets each endpoint publish to a media server, which forwards selected streams or
layers. It usually avoids decoding and re-encoding every video frame for ordinary
forwarding, but it still handles packet processing, congestion feedback, bandwidth, and
potentially substantial memory/CPU work.

Server relationships become linear in participants. Egress does not become linear if every
receiver subscribes to every sender. We should bound useful subscriptions, such as a large
speaker stream plus several lower-resolution visible tiles, rather than forwarding
everything just because the room supports 32 people.

Simulcast may upload multiple encodings. Scalable video coding may supply layers within an
encoding. Neither means an endpoint sends exactly one fixed-bitrate stream. Receiver
capabilities, visible tiles, and measured network conditions determine which layers are
useful.

| Group topology | Benefit | Trade-off |
|----------------|---------|-----------|
| ✅ SFU with bounded subscriptions | Lower endpoint upload fan-out and individual stream control | Server egress, media operations, and subscription policy |
| ❌ Unrestricted mesh | No central media forwarding for direct pairs | Upload/encode pressure grows with peers |
| ❌ MCU for the initial design | One mixed output can reduce receiver decoding | Server mixing/transcoding and plaintext media access |

Encryption must match the topology. Browser-to-browser WebRTC uses encrypted media
transport, including when TURN forwards the packets. That does not authenticate the intended
account by itself; secure signaling and endpoint identity are still necessary.

With an SFU, transport encryption normally terminates on each server leg. Keeping media
content hidden from the SFU needs an additional endpoint-controlled frame encryption layer
and authenticated group-key management. I would use an established mechanism, define
membership/key-epoch changes, and avoid inventing a protocol in an interview.

An ordinary MCU that mixes plaintext cannot simultaneously be excluded from the media trust
boundary. Recording introduces another explicit participant/trust decision; it is not a
feature that can be slipped into an end-to-end encryption claim without changing the
contract.

The main trade-off is operational cost versus endpoint capability and privacy. I would
validate it with measured relay share, per-room egress, endpoint decode load, and quality
outcomes. A universal “mesh works until four people” threshold or an invented number of
users per SFU CPU core is not a useful capacity plan.

## 📊 Observability and Failure Tests — 4 minutes

The backend should distinguish request-to-ring, human ring duration, acceptance latency, and
accept-to-first-media. A server-side acceptance timer cannot establish when a remote video
frame became visible. Client reports and selected-candidate telemetry complete the picture,
with sensible privacy and sampling limits.

Useful operational signals include unanswered expired invitations, outbox lag, failed or
conflicting device claims, receipt retries, socket backlog, stale endpoint messages, relay
allocation failures, and active-call projection drift. Labels should use bounded categories
rather than arbitrary client-supplied types or IDs.

| Failure scenario | Required result |
|------------------|-----------------|
| Creation commits and response disappears | Same retry returns the original call |
| Phone and laptop accept together | One invited-seat winner and consistent sibling dismissal |
| One user accepts two different calls | Busy policy permits only one active claim |
| Timeout races an answer | Conditional transition cannot overwrite the winner |
| Gateway fails after ring event commit | Delivery/reconciliation still reaches the current device route |
| An unrelated registered user sends SDP | Membership check rejects it |
| Relay is forced or UDP is blocked | Supported fallback is verified with actual media counters |
| Breaker is reused for a later request | It executes current arguments rather than the first request’s closure |

I would combine deterministic concurrency tests, real database transactions and sockets, and
controlled browser/network tests. Healthy dependencies and a rendered contact screen do not
establish call correctness. Load tests should separately exercise many idle sockets, heavy
call churn, and bandwidth-intensive group rooms.

## 🏁 Repository Mapping — 2 minutes

The local backend has public user/history routes, claimed socket identities, Redis call
JSON, and process-local connection and ring maps. SQL and Redis transitions are independent;
there are no durable receipts, seat claims, deadline recovery, cross-gateway delivery, or
SFU.

Its Opossum registry retains the first action closure for each name, so later database work
can reuse earlier parameters. Isolated checks confirmed repeated first-user/device work and
a second call trying the first call ID. Other checks confirmed concurrent acceptance and
missing sender membership enforcement.

TURN credentials are static, while the browser’s default credential route misses the Vite
proxy. The [architecture document](architecture.md#implementation-notes) separates these
actual behaviors from the proposed production mechanisms.

> “My first backend milestone would be one authenticated, retry-safe call lifecycle with a
> single device winner and restart-safe deadlines. I would establish that contract before
> distributing sockets across gateways or introducing group media.”
