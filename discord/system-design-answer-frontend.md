# Baby Discord: frontend system design interview

## 🎯 Define the conversation experience — 4 minutes

> “I would focus on text chat with reliable room switching and recovery. The browser sends commands through HTTP and receives room events through SSE. Those two paths can finish in either order, so the interface needs an explicit model of what has been accepted and what it has actually received.”

Users can choose a room, read recent messages, send text, and navigate to another room.
They can scroll back without incoming messages pulling them away. After a network
interruption, the interface either catches up or explains that its retained history is
incomplete.

I would separate a claimed nickname from authentication. The repository uses
nickname-only sessions, which is appropriate to describe as a local simplification. For
the proposed production client, I assume an authenticated account and server-enforced
room access. The browser cannot protect a room merely by hiding its navigation link.

I would scope out voice/video, executable bots, attachments, reactions, and
collaborative message editing for this discussion. They add separate state and media
requirements. The interesting frontend problem already exists with plain text: a user
must not lose a draft or see a message from one room appear under another room's
heading.

My target is a usable recent timeline within about 500 milliseconds and healthy regional
message delivery within about 200 milliseconds at p95. These are targets to measure
under a specified workload, not guarantees from choosing SSE or a particular store
library.

| Requirement | User-visible behavior |
|-------------|-----------------------|
| Send text | Immediate pending feedback; retained content on failure |
| Read a room | History and incoming events form one identified timeline |
| Switch rooms | Old responses and streams cannot affect the new room |
| Recover | Catch up after the last applied cursor or show an explicit reset |
| Read older messages | Stable scroll anchor and a jump-to-latest affordance |
| Lose access | Stop protected reads/sends and explain the state change |

## 📏 Estimate client work — 3 minutes

Assume 100,000 concurrent clients across the service and a normal room with tens of
messages per minute. Most visible timelines are modest. The exceptional case is a busy
room or a tab left open all day, where an append-only array grows even if the server
initially returns only ten messages.

I would request a bounded recent page, perhaps fifty messages, and load older pages
through a cursor. The browser keeps a bounded working window and enough identity
information to merge overlapping results. Server retention and browser memory bounds are
different policies: trimming DOM nodes must not imply deleting the conversation.

At high arrival rates, batch store updates over a short rendering interval and keep the
composer responsive. Do not render every event in its own expensive page-wide update. I
would measure message-to-render delay, input latency, memory after prolonged use, and
room-switch cleanup on representative devices.

A room with ten thousand readers also creates server fan-out pressure. The client should
respect bounded catch-up batches and server retry guidance rather than reconnect
repeatedly in a tight loop. It does not need to know database partitions or which
gateway owns another user's connection.

## 🏗️ Draw a small browser architecture — 5 minutes

The main ownership boundary is the room-session coordinator. Components display state
and express intent; they do not each open streams or independently reconcile HTTP
results.

```
┌──────────────────────┐       ┌────────────────────────┐
│ Route + composer     │──────▶│ Room coordinator       │
└──────────────────────┘       │ Session / generation   │
                               └────────────┬───────────┘
                                            │
                                            ▼
┌──────────────────────┐       ┌────────────────────────┐
│ HTTP + SSE API       │◀─────▶│ Normalized timeline    │
└──────────────────────┘       │ Pending + committed    │
                               └────────────┬───────────┘
                                            │
                                            ▼
                               ┌────────────────────────┐
                               │ Message list + status  │
                               └────────────────────────┘
```

The route identifies the selected room. The coordinator validates the session, acquires
the room context, fetches history, owns the stream, and applies events. It also owns a
generation token so a response from an earlier selection can be recognized as obsolete.

A shared store holds normalized messages, pending operations, the active room context,
and connection quality. Zustand is sufficient for this scope. Choosing one store does
not make several asynchronous actions run sequentially; the transitions and identity
checks still need to be designed.

The API boundary validates and normalizes history, send acknowledgements, and SSE
envelopes into the same message representation. TypeScript types are useful during
development, but a type annotation on parsed JSON does not check that an author or
timestamp actually exists.

I would keep the live EventSource handle in one lifecycle owner rather than treat it as
persisted application data. Whether that owner is a store service or a hook is secondary
to cleanup, generation checks, and a single source of subscription ownership.

The composer has a draft scoped to its intended room and account. A timeline contains
committed messages plus visibly pending items. A side panel shows room information;
connection status is nearby but does not replace the conversation with a full-page
spinner during every reconnect.

## 🧭 Define state and server contracts — 4 minutes

I would identify each kind of state before implementing the components. In particular, a
session credential, a socket, a room subscription, and durable membership are not
interchangeable.

| State | Identity | Why it matters |
|-------|----------|----------------|
| Account session | Validated session/account generation | Reject late work after logout or account change |
| Room context | Stable room ID plus navigation generation | Keep old room work out of the current view |
| Draft | Account and intended room | Preserve unsent text without redirecting it |
| Pending send | Client operation ID and immutable payload | Resolve retries and match acknowledgements |
| Committed message | Server ID, room sequence, author, time, content | Merge history and live delivery consistently |
| Applied cursor | Room and last validated applied sequence | Resume without claiming unseen events were applied |
| Stream status | Connecting, live, reconnecting, reset-required, failed | Explain availability independently of message content |

A send request includes the intended room and stable operation ID. Its successful
response means durable acceptance and identifies the committed message. It does not mean
another participant has read it. The live event carries that identity and the operation
correlation needed to reconcile the sender's pending item.

History returns a bounded page and an authoritative synchronization boundary. A page of
fifty messages can be complete for that requested page while older history remains
unloaded. The browser must not label the first displayed row as the beginning of the
room unless the server establishes that fact.

For SSE, I would ask for a structured event version, room ID, message identity,
sequence, and explicit replay/reset semantics. Connection establishment is not proof of
gap-free history. Permission changes and expired sessions need actionable error
contracts rather than an indefinitely reconnecting stream.

## 🔧 Deep dive 1: pending messages versus waiting for an echo — 8 minutes

> “I would show a pending item immediately, while reserving ‘sent’ for durable acceptance. This gives responsive feedback without presenting an optimistic guess as a committed message.”

When the user submits, the client captures the room ID, content, and a new operation ID.
That payload stays immutable for the operation. The composer can clear into a visible
pending item because the text remains recoverable there; a failure does not make the
user's work disappear.

The pending item is separate from committed order. It might appear in a pending area at
the end of the timeline with a clear status. Once the server assigns the room sequence,
the store reconciles it into the committed timeline. It should not pretend that the
client's clock determines the position everyone else will see.

The POST response can arrive before the SSE echo. It can also arrive afterward or be
lost while the event succeeds. Both paths converge by operation/message identity, so
receiving the second copy updates one item rather than appending another. Identical text
from two users remains two messages; content and timestamps are not deduplication keys.

If the server rejects permission or content, retain the failed item with an explanation
and an edit/retry action. Editing creates a new operation payload and identity after the
previous outcome is resolved or explicitly abandoned according to the contract. Reusing
an ID with changed content is a conflict, not a convenient retry.

A timeout is different from a confirmed rejection. The database may have committed while
the response was lost. Mark that operation unknown, then retry or query the same
identity. Generating another ID can create a duplicate, while declaring failure and
deleting the item can conceal an accepted message.

A dead receive stream does not necessarily mean that HTTP sends are unavailable. I would
keep composition available and let the send path report its own state. If the session
itself is invalid, preserve drafts and request reauthentication before allowing new
sends. An offline queue, if added, must remain bounded and expose which account/room
each item targets.

Waiting for the server echo is a simpler alternative for a small demo. It avoids some
reconciliation UI, but a successful POST with a broken SSE path can leave the sender
wondering whether anything happened. It still needs a durable response contract and a
way to explain uncertainty; silence is not a useful delivery state.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Identified pending items | Responsive feedback; drafts survive ambiguity | Requires reconciliation and explicit outcome states |
| ❌ Wait only for stream echo | Small client implementation | Receive failure hides successful sends |
| ❌ Clear text and treat POST completion as delivery | Easy form handling | Loses user work and conflates acceptance with receipt |

The cost is additional state and occasional movement when a pending message receives its
final order. I would make that movement predictable and test both completion orders. For
this product, retaining the user's words during an unreliable connection is more
valuable than avoiding a small pending-state model.

## 🔧 Deep dive 2: join history and live events without a hole — 8 minutes

> “I would require a server cursor and replay contract. The browser can merge and validate events, but it cannot recover a message that neither history nor the stream ever supplies.”

The naive sequence is to fetch history and then open SSE. A message committed after the
history snapshot but before subscription can appear in neither response. A busy room
makes that gap likely, and no ordinary transport error tells the client that a row is
missing.

I would request recent history with a room high-water mark, then start the stream after
that mark. The server replays retained committed messages after the cursor and joins
that replay to live delivery without a gap. The client still handles overlap and
reconnect duplicates by message identity.

A room sequence supports continuity checks only if the server defines it that way. A
global database ID can skip because other rooms consumed IDs, and a time-based ID does
not prove commit order. I would not show “missing message” whenever two arbitrary IDs
are nonconsecutive.

The server must establish a committed boundary and keep replay available for the
supported recovery window. If the browser's cursor is too old, the response explicitly
requires a fresh snapshot. The interface can say that the recent view was refreshed and
older messages may need loading; it cannot claim to have replayed discarded history.

Native EventSource can reconnect with a previously received event ID, but that does not
create replay storage. A newly constructed EventSource also cannot accept arbitrary
custom headers; an initial cursor can be part of the server's URL contract.
Authentication and cursor authorization remain server responsibilities. [SSE
reconnection contract](https://html.spec.whatwg.org/multipage/server-sent-events.html)

Stream-first buffering is a reasonable alternative when the server confirms that the
subscription is active before the history request. Buffer incoming identified events,
fetch history at a known boundary, merge overlap, then continue live. Merely
constructing the browser object is not confirmation that the server has attached the
subscription.

That buffer needs a limit. If history is slow and the room is busy, the client cannot
queue events forever. It should restart from a new snapshot or request bounded catch-up
through the server contract. Re-fetching history after opening a stream without
identities and a boundary merely moves the race elsewhere.

I would advance the application cursor only after an event validates and enters the
correct room state. A malformed event or missing sequence pauses normal advancement and
triggers recovery. The transport's last received ID is not necessarily the last event
the application successfully applied.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Authoritative cursor plus retained replay | Explicit recovery and bounded history pages | Requires server order, retention, and handoff logic |
| ❌ History then unresumable live stream | Minimal endpoints | Silent gap during join and reconnect |
| ❌ Guess duplicates from text/time | No protocol change | Drops legitimate repeated text or retains duplicates |

The trade-off is a stronger backend contract and client recovery state. It is worthwhile
because users cannot reliably notice or report a missing line. I would test a message at
every history/stream boundary, then repeat with a reconnect and overlapping delivery to
verify that each committed message appears once in the visible timeline.

## 🔧 Deep dive 3: isolate rooms, sessions, and stream lifetimes — 7 minutes

> “I would use explicit context generations on both sides of the stream. Closing an old EventSource helps, but a late HTTP response or close callback must also be prevented from affecting its replacement.”

When navigation selects another room, the coordinator increments its room generation and
closes the previous stream. Every history request, join operation, event callback, and
pending completion carries the context in which it began. Before applying a result, it
verifies the active account and room generation.

Consider a slow join to room A followed by a fast join to room B. B's history arrives
first and the page shows B. If A's completion writes to a single global messages array
afterward, the heading and content disagree. A single shared store does not prevent that
race; the generation check does.

Cancellation reduces wasted work but is not enough. Some requests may already be
committed, and callbacks can already be queued. Old work can complete safely as long as
it cannot replace a newer context. The server likewise must bind a send to its explicit
room rather than reading a mutable current-room field after several awaits.

Subscription replacement needs a unique connection identity. If the server keys both old
and new streams only by session and room, closing the old stream can delete the new
stream's map entry. Cleanup must remove only the connection generation that owns the
entry. This is the server counterpart of rejecting an obsolete browser callback.

Several tabs may share an account but should have independent connection state. Closing
one tab should not delete another tab's membership or invalidate its stream. Durable
membership grants access; connection presence describes a currently observed device. The
UI can show approximate online state without treating it as authoritative room access.

Session validation also matters after reload. A credential restored from localStorage
may refer to a server process that restarted. I would validate it before treating the
client as ready, preserve drafts during recovery, and centralize expired-session
handling. A route guard that checks only whether an object exists can trap the user in
an invalid session.

Slash commands complicate state if their effects are invisible. A command that joins a
room, renames the user, or disconnects must return structured effects that the
coordinator applies to navigation/session state. The server remains the grammar
authority; client autocomplete can use a published command catalog rather than duplicate
business rules.

| Approach | Pros | Cons |
|----------|------|------|
| ✅ Explicit context and connection generations | Safe late completions and independent tabs | More lifecycle state and cleanup discipline |
| ❌ One mutable current-room field for all work | Simple method signatures | Requests can act on the wrong room after awaits |
| ❌ Persisted session object treated as validation | Fast route guard | Restart/revocation leaves a misleading ready state |

The cost is deliberate ownership at every async boundary. I would keep it in a small
coordinator rather than scatter checks throughout presentation components. That makes
the race behavior testable without needing to inspect every button handler whenever a
new command is added.

## 📈 Render and verify a usable timeline — 4 minutes

For long histories, I would use variable-height list virtualization, with stable message
identities and a bounded working set. Prepending older pages preserves the visible
anchor. Incoming messages scroll automatically only when the reader is already near the
bottom; otherwise show a new-message count and jump-to-latest action.

Older-page loading also needs context checks. Capture the room and page cursor, merge by
identity, and preserve the visible anchor even while new messages arrive at the other
end. Prevent duplicate requests for the same page, and distinguish an empty page at the
beginning of history from a failed request that can be retried.

Connection control events are separate from chat messages. A planned server shutdown can
trigger a resumable reconnect, while a revoked session requires authentication recovery.
I would not append either event to the conversation as though another participant had
spoken. Keep one owner for reconnection so browser-managed retries and application-
created replacement streams do not compete.

The receive path should expose whether it is catching up, current, or unable to recover.
A successful connection-open callback only confirms transport establishment. I would
mark the timeline current after the server confirms the replay boundary and the client
has applied the corresponding events, while leaving older unloaded history independently
pageable.

A draft should not disappear because a virtualized row or route component unmounts. Keep
drafts and pending operations outside transient renderer state. Avoid moving focus when
messages arrive. Keyboard navigation and concise announcements should help participation
without reading an entire busy channel over a screen reader's current task.

Validate payloads once at the network boundary, then render known internal shapes. A
scoped error boundary can preserve navigation and composition if a timeline renderer
fails. Missing author/time data should be handled as a contract problem with an
appropriate fallback, not silently rewritten as an authentic system event.

I would test acknowledgement-before-echo and echo-before-acknowledgement, an unknown
send outcome, reordered joins, logout during a fetch, overlapping stream replacement,
malformed events, and a replay cursor beyond retention. Performance tests include an
all-day session and rapid room switching to find retained arrays and streams.

## 🛠️ Map this to the current implementation — 2 minutes

The repository uses React, TanStack Router, Zustand, HTTP POST, and native EventSource.
Its valid route layout and shared store provide a starting point, but sends clear the
input and ignore response bodies. There is no pending-operation model, replay cursor,
session validation on reload, or generation-safe room switch.

History author/time fields are partially normalized. Actual live SSE sends plain-text
lines, which the browser renders as system messages without stable IDs; the unused JSON
formatter does not establish the live contract. Remote JSON delivery also fails on a
string timestamp in the backend. The timeline grows and auto-scrolls without a client
bound.

Those are source findings with selected isolated checks, not a completed browser test. I
would first align the live/history/send contracts and preserve send outcomes, then
implement replay and context-safe lifecycle handling. The detailed current behavior and
proposed server responsibilities are in
[architecture.md](./architecture.md#implementation-notes).
