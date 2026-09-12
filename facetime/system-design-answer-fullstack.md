# FaceTime: Full-Stack System Design Interview

## 🎯 Scope and Success Criteria — 4 minutes

> “I’ll follow one video call from Alice pressing Call, through Bob accepting on one device,
> to both browsers exchanging media. The design needs a reliable call decision and a working
> media path; neither proves the other.”

This is a FaceTime-inspired browser service, not a claim about Apple's implementation. I
would support one-to-one audio/video, a contact list, multi-device ringing, mute/video
controls, hangup, and private call history. Group calling can extend the media topology
through an SFU after the basic lifecycle is sound.

I would defer screen sharing, effects, recording, shared playback, and device transfer. Each
adds meaningful resource, negotiation, and permission work. Drawing a button for one of
those features is much easier than making its lifecycle reliable.

The initial policy permits one accepted call per user. Decline rejects that user's
invitation across their devices; a local notification dismiss would be a different action. A
caller cancelling while the callee is accepting must produce one explainable final outcome.

| Concern | Initial target or invariant |
|---------|-----------------------------|
| Online ringing | p95 below two seconds from request to an online device’s ring |
| Media setup | p95 below three seconds after acceptance on supported networks |
| Media delay | Aim below 200 ms one-way in a defined regional profile |
| Availability | Proposed 99.9% regional call-control availability |
| Device selection | One accepted device per invited seat |
| Retry behavior | One durable outcome for the same actor, operation ID, and body |
| Cleanup | An ended attempt cannot later acquire or attach media |

These are design targets. Human time spent deciding whether to answer is separate from
signaling or media setup latency. I would also measure one-way media delay separately from
network round-trip time.

## 🏗️ Architecture and Shared Contract — 6 minutes

```
┌──────────────────────┐     ┌──────────────────────┐
│ React call interface │────▶│ Client call owner    │
└──────────────────────┘     └──────────┬───────────┘
                                        │ Control
                                        ▼
┌──────────────────────┐     ┌──────────────────────┐
│ Device routing       │◀────│ Call authority       │
└──────────────────────┘     └──────────┬───────────┘
                                        ▼
                             ┌──────────────────────┐
                             │ SQL state + outbox   │
                             │ Claims and receipts  │
                             └──────────────────────┘

┌──────────────────────┐     ┌──────────────────────┐
│ Browser A media      │◀───▶│ Browser B media      │
└──────────────────────┘     └──────────────────────┘
        Direct candidate pair or TURN relay
```

The client call owner manages the peer connection, streams, negotiation queues, and attempt
identity. React renders the call’s status and controls. The backend authenticates devices,
commits call transitions, and routes messages to the intended endpoints. PostgreSQL stores
decisions and receipts; Redis can cache connection routes and presence.

The media path is separate from HTTP and WebSocket signaling. STUN helps discover candidate
addresses, ICE tests connectivity, and TURN can relay packets when appropriate. A group SFU
would become a separate media endpoint rather than an extra database or signaling handler.

The state model distinguishes authoritative call decisions from local media conditions:

| State | Authority | Example |
|-------|-----------|---------|
| Invitation and deadline | Server | Bob may answer until a specified deadline |
| Winning device and call revision | Server | Bob's phone accepted revision 4 |
| Peer negotiation phase | Client controller | Offer sent; waiting for remote description |
| Media health | Browser observations | Incoming audio is flowing; video stalled |
| Pending command outcome | Client plus durable server receipt | Accept was sent but its response was lost |
| Capture and playback resources | Client controller | Owns microphone track and remote media element |

An accepted call is not yet a connected media session. The interface can say “Connecting”
after acceptance and transition to active media when the browser observes a usable path. A
socket's open event should not trigger either of those states.

| Proposed interface | Contract |
|--------------------|----------|
| Authenticated device registration | Establish account, device ownership, connection generation |
| Initiate command | Recipients, modality, stable actor-scoped operation ID |
| Accept/decline/end command | Call ID, expected state/revision, stable retry identity |
| Call snapshot/resume | Current revision, terminal status, accepted endpoint claims |
| Offer/answer/ICE | Authorized endpoint pair and negotiation generation |
| TURN credential request | Current relay configuration and bounded credential lifetime |
| History query | Only calls visible to the current account, with a stable cursor |

This is a proposed contract. The local project has a smaller and less reliable API, which I
would identify explicitly at the end of the interview.

## 📱 Deep Dive: From Call Button to One Answering Device — 10 minutes

> “I’ll make the call command durable and retry-safe, then make device acceptance an atomic
> server decision. The browser can provide immediate feedback without pretending it already
> knows the winner.”

Alice presses Video Call. The frontend records the selected contact and starts a new attempt
generation. It acquires media through the user action, while showing permission/preparation
status. A cancelled or superseded attempt cannot proceed when a delayed permission result
arrives.

Once the attempt is ready to initiate, it sends the recipients, modality, and a stable
operation ID. The server derives Alice's identity from authentication and validates the
request. It does not trust a user ID supplied by an arbitrary socket as proof of identity.

One transaction reserves the caller's active slot, creates the call and invitations, and
writes both the retry receipt and ring outbox entries. The response identifies a committed
call. If the response disappears, Alice retries the same operation and body and receives the
same recorded result.

This transaction prevents two different partial-success cases. A key written before the call
could point to a nonexistent record. A call written before an unrelated notification send
could exist without ever ringing Bob. The receipt and outbox give both the client and
delivery worker a recoverable boundary.

| Initiation approach | What it solves | Cost or failure |
|---------------------|----------------|-----------------|
| ✅ Transactional call, receipt, and outbox | Recovers creation and delivery after lost responses or crashes | Receipt retention and an event delivery worker |
| ❌ Separate Redis key and SQL insert | Suppresses some sequential retries | Still races and can return a dead call ID |
| ❌ Retry every tap as a new call | Simple client behavior | Duplicate invitations and phantom ringing |

The delivery worker rings Bob's currently registered connections with the same call ID,
revision, and deadline. A delayed or duplicated ring is harmless only if the recipient
checks that the invitation is still current. A transport delivery acknowledgment is not
evidence that Bob saw or accepted it.

Bob presses Accept on the phone while the laptop also sends acceptance. Both may have
acquired media locally, but the server atomically claims one invited seat. It commits the
winner, participant state, busy slot, retry receipt, and sibling-dismiss events together.

The winning device proceeds to negotiation. The other device receives the canonical winner,
stops its capture, and shows “Answered on another device.” A missing response can be
resolved by the receipt; the losing device must not claim success merely because its button
was pressed first locally.

The busy slot must cover different calls as well as different devices. If Alice is invited
to call X and call Y at the same time, locking only each call row can still allow two
independent acceptances. The account-wide active claim prevents that outcome under our
initial policy.

Cancel and timeout use the same conditional transitions. If cancellation wins, a later
acceptance returns the terminal result. If acceptance wins, a later hangup becomes a
termination request for the accepted call. An old timer cannot blindly overwrite current
state as missed.

For group calls, each invited user has a separate seat. A room can become active after one
participant joins while others are still invited. Reusing a single “ringing versus
connected” flag as the admission check for every invitee would block the rest of the group.

The frontend also scopes every event to the current attempt. A late call_end from an old
invitation cannot close the current call. An incoming call during an active conversation
follows the busy policy rather than replacing the global call object and leaving the old
media running.

The trade-off is more server coordination and client outcome handling. That complexity gives
a precise answer to two questions a user actually cares about: “Did my call start?” and
“Which device answered?”

## 🎥 Deep Dive: Negotiating and Owning the Media Path — 9 minutes

> “The client needs one owner for capture, descriptions, candidates, and playback. I’ll keep
> it outside incidental React renders and tag all async work with the current attempt.”

Before constructing the peer connection, obtain ICE configuration from the real backend
route. A successful request to the wrong origin can return an HTML page rather than
credentials, so both status and payload need validation. If only STUN is available, that is
a degraded capability, not operational TURN fallback.

The call owner creates the peer for the accepted endpoint pair, installs handlers, and adds
current local tracks. One side is the designated initial offerer. The offer and answer
travel through authorized signaling; media begins after compatible descriptions and a usable
ICE path are established.

Trickle ICE sends candidates as they are discovered instead of waiting for every possible
interface and relay allocation. The recipient may receive a candidate before installing the
remote description. It queues candidates only for that peer and negotiation generation, then
drains the matching queue after the description is ready.

| Negotiation choice | Benefit | Cost or limit |
|--------------------|---------|---------------|
| ✅ Trickle ICE with scoped ordered queues | Starts checking useful paths early | More ordering and generation handling |
| ❌ Always wait for gathering to finish | Simpler first message bundle | Slow discovery can delay the entire connection |
| ❌ Shared unscoped candidate array | Convenient prototype | Old calls and restarts can contaminate a new peer |

The server checks membership and accepted device generations before relaying SDP or
candidates. A valid call ID is not a bearer credential. A candidate's text hash is also not
proof that it belongs to the current media section or negotiation generation.

On the frontend, a callback installed on an existing peer cannot rely on a later React
render to update its captured variables. I would bind it to the immutable attempt identity
or a controlled current reference. Otherwise the caller can create the peer before receiving
a call ID and silently drop all later trickle candidates through a stale empty-ID closure.

Subsequent renegotiations need a collision policy. A designated initial caller does not
solve simultaneous offers caused by later media changes. I would serialize description
operations and use a documented glare-handling pattern, with a bounded restart path if
negotiation cannot recover.

The same ownership rule protects camera lifetime. If getUserMedia resolves after hangup,
stop the newly returned tracks. Ending a call invalidates its generation, closes the peer,
clears queues and timers, detaches elements, and stops owned tracks. Local release should
not wait for the server to acknowledge the end command.

Native video/audio elements handle decoding and playback. The local preview is muted to
avoid feedback and can be mirrored visually. A remote autoplay rejection needs an actionable
UI response. An audio-only call should intentionally show participant identity and audio
state rather than an empty video placeholder.

Mute and camera-off also need clear semantics. Disabling a track is not the same as stopping
and releasing its device. I would define what the product promises, show the local state
accurately, and tell peers when a stream is intentionally unavailable. Re-enabling a
released camera may require a new acquisition.

Media topology introduces another trade-off. Direct one-to-one paths can avoid relay
bandwidth, but some networks need TURN and some users may prefer relay-only address privacy.
Direct is not universally faster, and neither path has zero operational cost.

For groups, a mesh makes each endpoint send to every peer. An SFU reduces that upload
fan-out and supports selective subscriptions. It adds server egress, media operations, and a
different encryption boundary. Merely rendering a grid does not implement those backend
capabilities.

Normal browser-to-browser WebRTC encrypts media even when TURN relays it. An SFU normally
terminates each transport leg; hiding media content from it needs an additional
endpoint-controlled frame-encryption layer and authenticated group-key management. Account
authentication remains necessary in either topology.

The cost of the client owner is explicit lifecycle and negotiation state. It prevents
resource leaks and cross-call interference while letting React remain focused on a small,
understandable interface.

## 🔄 Deep Dive: Recovering Control and Media Separately — 9 minutes

> “I’ll recover the failed part of a call instead of assuming that every socket interruption
> means the entire conversation is gone.”

Consider an active direct audio call whose WebSocket disconnects. The media path may remain
healthy. I would show that control is reconnecting and preserve media for a bounded grace
period. Hangup still releases local resources immediately, even if the termination command
must be retried later.

Reconnection starts with authentication and registration acknowledgment, then retrieves the
current call revision and accepted endpoint claim. Re-registering a device is not itself
call recovery. The call may have ended, been revoked, or moved to a different device while
this connection was absent.

If the same endpoint still owns the seat and media works, the client can resume control
without replacing the peer. If the server reports a terminal state or a newer endpoint
generation, the client tears down the old attempt. Pending lifecycle commands are reconciled
through their recorded outcomes.

Now consider the opposite: signaling works, but media fails after a network change.
Heartbeats cannot repair that path. A bounded ICE restart can use refreshed configuration
and a later negotiation generation. Old descriptions and candidates must not leak into that
new generation.

| Failure policy | Benefit | Trade-off |
|----------------|---------|-----------|
| ✅ Separate control and media recovery | Preserves healthy audio during brief signaling loss | More state and explicit reconciliation |
| ❌ End every call on socket close | Simple implementation | Unnecessarily interrupts a working media path |
| ❌ Keep every call alive indefinitely | Avoids immediate interruption | Stale membership, stuck UI, and leaked resources |

Transient disconnected states need deadlines and observations. A short interruption can
recover, but an endless Connecting label is not a recovery strategy. The controller should
track attempts, show useful status, and eventually release resources with a clear reason.

Logout must disable reconnection before closing the socket. It also cancels pending retry
timers, invalidates callback generations, clears account-scoped call state, and disposes
media. Otherwise a normal close handler can reopen the connection using the identity the
person just signed out of.

Presence similarly belongs to connections. Several tabs can share one browser device ID, and
several devices can share an account. A close from one connection must not remove another’s
live lease. The UI consumes explicit presence state; it should not treat a stored device row
as evidence of a reachable socket.

Server recovery requires durable deadlines. A thirty-second in-process timer can make the
common case responsive, but a restart destroys it. A scheduled worker or indexed sweeper
must find eligible ringing invitations and apply conditional timeout transitions.

Outbox delivery is at least once. Events carry revisions and expiry so duplicates and stale
rings can be discarded. Redis pub/sub can help route live events, but it cannot recover a
missed publish or decide who won an acceptance by itself.

The durable history records the control outcome. Media-quality telemetry can separately
record how much of the accepted session carried useful audio/video. An acceptance timestamp
alone cannot prove that the users ever heard each other.

The trade-off is temporary uncertainty during recovery. We make that uncertainty bounded and
visible, then reconcile with the authority. Pretending a reconnect succeeded because the
socket opened would hide the decision that actually matters: whether this endpoint still
belongs in this call.

## 📈 Capacity, Quality, and Verification — 5 minutes

Assume 100,000 concurrent one-to-one calls lasting five minutes on average. At steady
occupancy, about 333 calls begin each second. With thirty application signaling messages per
completed call, that is roughly 10,000 call-related messages per second, separate from
idle-device heartbeats.

If 20% use TURN and each endpoint sends 1.5 Mb/s, the relay fleet sees 60 Gb/s ingress and
60 Gb/s egress. We should measure the actual relay share. A credential endpoint returning
JSON is not evidence that the browser selected a relay candidate.

For a group of 32, a mesh has 496 total peer pairs and 31 peers per endpoint. At 1.5 Mb/s
per outgoing peer, each endpoint uploads 46.5 Mb/s. An SFU reduces endpoint connection
fan-out, but forwarding every sender to every receiver still creates large aggregate egress.

The group UI should request useful visible streams and layers. Hiding a tile does not
automatically stop receiving or decoding it. Simulcast can involve multiple outgoing
encodings, so “one connection to the SFU” should not be mistaken for one fixed-bitrate
stream.

Quality metrics should separate signaling latency, acceptance, first usable media,
loss/jitter, selected candidate type, and actual media progress. Use bounded client sampling
and sustained trends. Preserve audio under pressure, then adjust video policy around browser
congestion control and receiver capabilities.

| Scenario | End-to-end evidence |
|----------|---------------------|
| Lost creation response | Retrying returns the same durable call ID |
| Two devices answer | One winner; the loser stops capture and ringing |
| Permission resolves after cancellation | No camera/microphone resource survives the ended attempt |
| Late SDP or call_end from an old call | Current call remains unchanged |
| Signaling interruption with healthy media | Audio continues during bounded control recovery |
| Forced TURN path | Relay candidate selected and bidirectional media counters advance |
| Server restarts during ringing | Durable deadline produces a final invitation outcome |
| Logout with a scheduled retry | Old account cannot silently reconnect |

I would test controller races in isolation, call claims with real database concurrency, and
two browser contexts with controlled media/network conditions. A single login-container
smoke test is useful for rendering, but cannot establish any of those call guarantees.

Accessibility belongs in the same validation: labeled controls, pressed states for
mute/video, meaningful call announcements, focus handling on incoming calls, and reduced
motion. Audio-only and blocked-playback states need understandable interfaces rather than a
generic error or silent spinner.

## 🏁 Local Implementation Boundary — 2 minutes

The repository has a React contact/call UI, one peer connection per browser, public HTTP
routes, process-local socket maps, and separate PostgreSQL/Redis writes. It has no
authenticated membership, atomic device winner, durable command receipt/outbox, or group
SFU.

Isolated checks confirmed that named circuit breakers retain the first request closure,
concurrent answers can both succeed, and unrelated registered clients can inject call
signaling. The browser misses TURN credentials under the default Vite proxy, can retain an
empty caller call ID in its candidate callback, and reconnects after explicit logout.

The [architecture document](architecture.md#implementation-notes) maps these actual limits
to source and separates them from this proposal. No claim of tested media quality or working
group calls follows from the local interface alone.

> “My first full-stack milestone would be one call whose creation survives a retry, whose
> invitation has one device winner, whose media path is measured, and whose resources are
> released after every exit. That gives us a reliable base for group calling and more
> advanced features.”
