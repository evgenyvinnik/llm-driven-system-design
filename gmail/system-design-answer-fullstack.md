# Gmail: full-stack system design interview

A proposed 45-minute design for an internal email product. This answer connects
user-visible behavior to server guarantees; it does not describe every feature as
already implemented in the repository.

## 🎯 Agree on what the user can trust — 4 minutes

> “I would design an internal email client with conversations, labels, drafts, To/CC/BCC, and search. I want to explain three complete journeys: writing and sending safely, reading and organizing a personal mailbox, and finding mail without disclosing another recipient's information.”

External SMTP delivery, IMAP/POP3, attachments, scheduled sending, and spam
classification are outside the first version. That keeps the interview focused while
leaving clear extension points. I would use plain-text bodies initially; supporting
arbitrary HTML email is a separate rendering and security project.

The first invariant is that authored text is not silently lost. A draft save
acknowledges a particular revision, and a conflict preserves the losing editor's local
copy. The second is that one intended send produces one accepted message within the
declared retry contract. The third is that mailbox organization and content visibility
belong to the viewer.

For example, Alice sends a message to Bob and BCCs Charlie. Charlie can read that
message, but Bob should not discover Charlie through headers or search. If Bob then
replies only to Alice, Charlie does not gain access to that reply just because it
shares the original thread ID.

| Product action | Frontend promise | Server obligation |
|----------------|------------------|-------------------|
| Save draft | Identify which text is saved | Conditional version and durable save result |
| Send | Preserve and resolve uncertain outcome | Accepted-message receipt and recoverable delivery work |
| Read | Show this account's conversation view | Message entitlement and viewer-specific summary |
| Archive/star | Respond immediately and reconcile | Canonical state with a version |
| Search | Separate loading, no matches, and outage | Authorized hits and explicit availability status |

I would propose API p99 below 200 ms for a bounded mailbox page, below 500 ms for
search, and 99.99% availability for the core service. These are goals to validate. The
browser also needs a device-specific interaction budget because a fast API does not
prevent a large message body or list render from blocking input.

## 🏗️ Draw the full path — 4 minutes

```
┌─────────────────────────┐       ┌──────────────────────────────┐
│ Browser: inbox + editor │──────▶│ Mail / draft / search API    │
└─────────────────────────┘       └──────────────┬───────────────┘
                                                 │
┌─────────────────────────┐       ┌──────────────▼───────────────┐
│ Mailbox + search views  │◀──────│ Durable writes + outbox      │
│ Updated by workers      │       │ Accepted send receipts       │
└─────────────────────────┘       └──────────────────────────────┘
```

The browser shell contains mailbox navigation, conversation reading, and an editor
that survives ordinary route changes. The API establishes identity and routes work to
the correct message, mailbox, or draft authority. PostgreSQL is the initial source of
truth; Redis holds sessions, quotas, and bounded caches.

The message transaction records acceptance and durable outbox work. Workers
materialize recipient mailbox entries and search documents. Elasticsearch can be
unavailable while accepted mail remains durable. The API must represent that degraded
search state instead of returning an apparently successful empty search.

The local version can use one database and one API. At the proposed scale, mailbox
data is owned by user partition, while immutable message content and its audience live
at a message authority. Recipient delivery then crosses a durable asynchronous
boundary. I would not draw several databases and still imply one ordinary SQL
transaction spans them all.

I would colocate the sender's draft lifecycle and acceptance receipt so “send this
draft revision” is one local transaction. Browser state and network requests have an
account generation, ensuring that logging out prevents a delayed request from
repopulating the previous account's mail.

## 💾 Shared contracts and client state — 4 minutes

The browser should not reconstruct security or consistency rules from incidental
fields. I would establish the few entities that carry those rules before selecting a
state library.

| Entity | Server ownership | Browser representation |
|--------|------------------|------------------------|
| Message | Immutable body, sender, explicit audience | Authorized body loaded on demand |
| Mailbox conversation | User-specific summary and state version | Shared entity used by list and detail |
| Mailbox query | Filtered order, cursor, mailbox revision | Ordered IDs plus bounded page cache |
| Draft | Owner, server version, lifecycle state | Current local revision, acknowledged revision, pending save |
| Operation receipt | Owner, operation key, digest, committed result | Resolve save/send uncertainty without creating new intent |
| Search result | Authorized message ID, safe fragments, cursor | Query-specific results and explicit availability state |

Use URL state for the active label, thread, and submitted search query. Use a
server-state cache for entities and result pages, and a small Zustand store or
equivalent for editor coordination and selection. Local component state holds
temporary focus, expanded messages, and input drafts that do not need global
subscriptions.

List and detail should refer to the same mailbox entity for star/read state. Otherwise
a star button in a conversation can mutate an unrelated cached list while the
displayed icon remains unchanged. Authenticated identity is part of every cache key;
clear sensitive state and invalidate response generations on sign-out.

The API error type preserves HTTP status, current draft on conflict, retry timing, and
operation identity. Treating every failure as a message string forces the editor to
guess whether it should retry, compare content, or ask the user to sign in again.

## 📊 Scale assumptions — 2 minutes

Assume ten million daily active users, twenty sends per user per day, and three
recipients per send. That produces 200 million messages and 600 million recipient
deliveries daily, about 2,315 sends per second on average. A tenfold peak is roughly
23,150 sends per second.

At 10 KB per text body, raw content adds about 2 TB/day before copies and indexes. One
hundred mailbox-page reads per active user gives one billion reads per day. These are
illustrative assumptions, not Gmail statistics. Recipient fan-out and retention
determine the largest storage and write costs.

The frontend still fetches one bounded page at a time. Large global scale does not
justify downloading one user's entire mailbox. The backend scales acceptance,
recipient delivery, and search independently because they have different latency and
availability requirements.

## 🔧 Deep dive 1: from typing to one accepted message — 9 minutes

### Autosave acknowledges content, not elapsed time

The editor owns local content immediately. A debounce schedules a save, with a maximum
delay so continuous typing still reaches storage. The save carries a stable draft ID,
expected server version, save operation ID, and the local revision being submitted.

Suppose local revision 8 is sent with server version 3. The user types revision 9
before the response arrives. When the server acknowledges revision 8 as version 4, the
browser updates its metadata and queues revision 9. It must not overwrite the editor
with the older response or show revision 9 as saved.

Only one save is in flight for a draft in this editor. The latest dirty state waits
behind it, reducing self-conflicts and redundant requests. Independent tabs still need
a server-side conditional version check; browser coordination is an optimization, not
the authority.

The server atomically checks owner and expected version, writes the content, and
increments the version. If another editor has advanced it, return a conflict with
current authorized content. The browser retains its local copy and presents a
comparison or “save separately” option.

Blindly loading the returned draft into the editor would discard exactly the work the
conflict mechanism is meant to protect. Recipient changes deserve particular care: an
automatic merge that adds an unintended recipient is not a harmless text merge.

### Resolve uncertain saves and closing

A response can be lost after a successful save. Reusing the same save operation ID
lets the server replay that acknowledged version instead of interpreting a retry as a
new stale edit. The receipt has a declared retention window, and the browser retains
enough state to reconcile beyond that window explicitly.

Closing and discarding have different semantics. Closing preserves a durably saved
draft. Discarding transitions it to a deleted state after any needed confirmation. An
unsaved editor reports save failure instead of relying on a best-effort request during
tab unload.

If local crash recovery is required, keep a bounded account-scoped recovery copy with
a clear “only on this device” status. It is not automatically synchronized or secure
on a shared device. Storage failure and sign-out cleanup need explicit product
behavior.

| Approach | Why it fits or fails | Cost |
|----------|---------------------|------|
| ✅ Conditional saves with local revision tracking | Preserves newer typing and detects another tab's write | Save queue, receipts, and conflict UI |
| ❌ Unconditional last-write-wins | Smaller update contract | A delayed autosave can destroy newer authored content |
| ❌ Exclusive editing lease | Reduces concurrent editors | Abandoned-tab recovery, takeover, and fencing |

> “I choose conditional saves because a conflict can be explained and recovered. Silent overwrite cannot. I am accepting client-state complexity in exchange for protecting the message the user is actually writing.”

### Freeze intent when sending

Before Send, commit valid pending recipient text or show an error. Do not silently
exclude an address that has not become a chip. Validate roles and duplicates across
To/CC/BCC, resolve all internal addresses, and reject unknown recipients before
acceptance.

The browser freezes the chosen draft revision, body, and audience. It reuses one send
operation ID while resolving that intent. Further editing is disabled for the frozen
send or explicitly creates another draft; it cannot be mixed into the same retry key.

The sender authority checks the draft version and active state. In one transaction it
writes the immutable message, audience, receipt, and outbox work, then marks the draft
sent. A concurrent save or send must satisfy its version/state condition; late saves
cannot resurrect a sent draft.

The receipt is unique by sender and operation ID and stores a digest of the frozen
request. Equal requests replay the original accepted message. Different bodies or
recipients under the same key are a conflict. Checking for a key and inserting it only
after repeating the send would not protect concurrent requests.

### Acceptance and delivery are different states

Once that transaction commits, the message is accepted. Recipient workers create
mailbox entries using a unique message/recipient identity and a processed-event
receipt in the same recipient transaction. Replayed work cannot increment unread
counts twice.

If the response to Send is lost, the browser shows an uncertain state and queries or
retries using the same operation ID. If one recipient partition is unavailable,
acceptance remains true while delivery is delayed. A new independent send is not the
repair mechanism.

Outbox publication and consumer acknowledgment can each be repeated after crashes. The
database retains pending work, workers lease it for bounded intervals, and retries use
the same identities. A queue alone does not close the gap between committing a message
and publishing an event.

The trade is additional status and recovery machinery for a less coupled acceptance
path. A small single-database installation can transact across recipients; a sharded
service gives up simultaneous mailbox visibility and makes progress explicit.

## 🔧 Deep dive 2: one conversation, different mailbox views — 8 minutes

### Build the summary from authorized messages

Alice and Bob can independently read, star, archive, or label the same message. I
would store mailbox state by user and thread, with message-level entitlement
underneath it. The visible summary includes only messages the user can read: latest
snippet, visible count, participants, and last activity.

Consider Charlie, who received the original message through BCC but was excluded from
a later reply. Charlie's summary must not update to the reply's text or date.
Filtering the body endpoint while returning a global snippet in the inbox would still
disclose information.

For every detail request, the server checks the user's entitlement to each returned
message. Reply creation verifies access to the parent and its relationship to the
thread. Merely knowing a thread ID cannot let an outsider append a message, gain a
mailbox-state row, and read the existing history.

Label assignments validate label ownership and conversation visibility. Foreign keys
on label, thread, and user IDs do not prove that the label belongs to that same user.
Use constraints or transactional checks that encode the relationship.

A JSONB aggregate could represent a small amount of state and can be indexed. Separate
mailbox rows are preferable here because updates and reads are naturally user-owned,
and an ever-growing shared thread row would concentrate writes from many users. The
cost is fan-out and maintaining derived summaries.

### Read acknowledgments and new delivery

The conversation API returns a visible sequence through which the presented view is
complete. The browser acknowledges reading through that point. A new delivery has a
higher sequence and remains unread even if an older read request reaches the server
afterward.

A late boolean read update cannot distinguish mail the user saw from mail that arrived
during the request. That race matters in the UI: an unread count disappearing without
the new message being shown looks like mail was lost.

Archive removes Inbox membership for that user. A later incoming message can return an
archived conversation to Inbox under the chosen policy, while Trash or Spam may retain
their locations. Define these rules once in the server rather than keeping a flag and
label that can disagree.

### Optimistic actions must preserve newer intent

The browser immediately overlays a desired star/archive state on a normalized mailbox
entity. The request contains the expected entity version and operation ID. Success
returns canonical state and a mailbox revision; failure removes only that operation's
overlay and preserves any newer pending action.

If an older star request fails after a newer unstar succeeds, inverting the current
value is wrong. Either serialize actions for that entity or maintain an ordered set of
pending desired changes. A refetch also needs a version check so older server data
cannot overwrite a newer acknowledged action.

Archive removes a thread from the active Inbox list, but it also affects counts and
possibly other query memberships. The response identifies the canonical state;
affected queries are patched or invalidated consistently. A detail page reads the same
entity, including when it was opened directly without visiting the inbox first.

Undo submits a compensating action if the original mutation committed. It is not a
delayed cancellation of a database transaction. If another message arrives or another
tab changes the thread, version reconciliation prevents undo from erasing that newer
state.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Per-user projection and versioned optimistic actions | Independent state with quick feedback | Projection maintenance and pending-action reconciliation |
| ❌ Global thread flags and summaries | Fewer rows and joins | Cannot represent different read state or private reply history |
| ❌ Blind rollback by toggling the displayed value | Simple error branch | A late failure can reverse a newer successful action |

### Bound navigation and rendering together

The API returns 25 or 50 summaries with a cursor. The browser keeps the current page
and a small neighboring cache, not all mailbox bodies. Conversation messages are paged
separately, with search links opening the matching visible message.

Cursor ordering uses activity plus a unique tie-breaker, but conversations can move
when replies arrive. Deduplicate seen IDs and present a “New mail” refresh affordance
instead of moving the row under the user's pointer. A fixed multi-page snapshot would
require a separate bounded server contract; cursors alone do not create one.

Virtualize only when the retained window or measured row cost justifies it. Stable
thread IDs, a constrained viewport, and measured heights for wrapping content keep
positioning reliable. Store a thread ID and offset as the return anchor when
navigating to detail.

Keyboard and touch interactions remain available without hover. Focus moves to a
sensible surviving row after archive and returns to the previous conversation on Back.
A virtualizer must retain or deliberately relocate focus when it removes elements from
the DOM.

## 🔧 Deep dive 3: search as a private, repairable projection — 8 minutes

### Match the searchable fields to the viewer

A message can be visible to several people while some envelope details remain private.
A shared `visible_to` filter controls which messages match, but it does not make every
indexed field safe to search. BCC addresses must not affect another recipient's
results.

For the proposed scale, I would build one searchable projection per mailbox/message
pair. The sender can search their own BCC envelope; ordinary recipients see only
public recipient fields; a hidden recipient gets their own permitted view. This
duplicates text but aligns search routing and deletion with mailbox ownership.

A smaller shared-document design can exclude BCC fields from searchable content
entirely. That protects the common query path but gives up sender-specific BCC search.
I would state that trade clearly rather than assuming one shared recipient array meets
every view's requirements.

PostgreSQL full-text search can combine search and permission predicates.
Elasticsearch is a choice for independent scaling and relevance features, not a
prerequisite for privacy. Maintaining a second index adds lag, backfills, repair
procedures, and extra copies of sensitive data.

### Publish changes durably

Mailbox delivery and state changes create durable indexing events. Workers publish
versioned documents or tombstones and acknowledge after the search store accepts them.
Repeated work is expected; an older upsert cannot overwrite a newer deletion.

A global last-created timestamp is an unreliable checkpoint. Equal timestamps can
straddle a batch, precision can be lost when converting between SQL and JavaScript,
and a transaction can commit late with a timestamp older than the scanner's watermark.
Timestamp plus ID solves ties but not late commits.

An outbox worker claims pending records rather than discarding everything below a
global clock value. Failed items retain retry state; poison items get an explicit
failure queue and repair path. Search lag is measured from outstanding work age, not
inferred from the configured polling interval.

Rebuilding requires an index generation, a consistent source snapshot, and capture of
changes during the rebuild. Catch up and verify the new generation before switching
readers. A data-store reset with an old checkpoint still present can leave historical
mail permanently unindexed.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Durable versioned indexing events | Replay, deletion ordering, and repair are explicit | Outbox storage, worker coordination, and monitoring |
| ❌ Timestamp-only polling | Easy initial implementation | Ties, precision changes, and late commits can lose progress |
| ❌ Index synchronously during send | Makes the happy path appear immediately searchable | Search failures become send failures without true cross-store atomicity |

### Hydrate under current permissions

Search retrieves candidate IDs from the caller's mailbox projection. Before returning
snippets, the service verifies current entitlement and deletion state against the
authoritative store. It bounds candidate overfetch and returns a partial page or
continuation if enough authorized results cannot be assembled within the work budget.

A point-in-time index view stabilizes pagination, not permissions. Deleted or revoked
content remains hidden even if it exists in an older search snapshot. Totals must not
reveal unauthorized candidates; exact counts are optional when safe counting would be
expensive.

The response identifies matching messages and safe text fragments. Grouping several
message hits under one conversation is a UI choice, and the count should say whether
it refers to messages or conversations. Clicking a hit opens and expands that message,
rather than always jumping to the latest reply.

### Make the browser contract safe and useful

I would return plain text with validated highlight ranges. React renders the text and
applies emphasis to those ranges. If HTML snippets are used instead, define encoding
and an allowlist explicitly; raw email content is not safe just because it passed
through a search engine.

The initial reader also renders plain text. Rich HTML later needs sanitization,
isolation, safe navigation, and a remote-image policy. Snippet safety and body safety
are related but separate paths, and both require review.

Search state belongs to the submitted query and account. A response-generation check
prevents an old request from replacing a newer query or reopening cleared results.
Cancellation saves work but is not the sole correctness mechanism. Browser Back
restores the query and previous inbox anchor through route state.

On an outage, show “Search temporarily unavailable” while the inbox remains usable.
Empty success would imply that messages no longer exist and would make the user retry
different queries for the wrong reason. An availability flag or typed error makes this
distinction observable to both the interface and operations.

> “I accept some search lag to keep message acceptance independent. I do not accept stale authorization or invisible indexing failures. A projection is useful only if we can explain its freshness and repair it.”

## 🛡️ Operations and verification — 4 minutes

Use revocable server sessions, secure cookies, session rotation on authentication, and
explicit request-origin/CSRF protection. A localStorage profile cache is not
authentication. Sign-out clears the previous mailbox/editor state according to
retention policy and fences all outstanding requests before another user signs in.

Apply limits to recipient count, body bytes, save frequency, search work, and login
attempts. A shared Redis request counter can help, but Redis is a required dependency
for sessions unless another authenticated fallback is deliberately designed. Re-login
does not make a Redis outage disappear.

Optional cache reads should fail over only under a bounded database budget.
Invalidation occurs after authoritative commit, with a revision or generation to stop
an old in-flight read from repopulating stale data. A thirty-second TTL is a bound on
cache age under stated conditions, not proof that the mailbox action worked.

Separate process liveness, dependency readiness, and delivery/search freshness. A
probe passing through session lookup and rate limiting is not independent of Redis.
Monitor accepted sends, delayed recipient deliveries, oldest unindexed event, draft
conflicts, replayed operations, and user-visible error rates.

I would verify complete failure stories: a successful send with a dropped response; a
worker crash after mailbox commit; a save conflict while the user keeps typing; a BCC
recipient excluded from a subsequent reply; an old search event arriving after
deletion; and an account switch during an inbox request.

Frontend checks also cover direct thread navigation, list/detail reconciliation,
return anchors, keyboard recipient entry, and focus after archive. Backend tests use
real transaction constraints where they establish correctness, while mocked route
tests remain useful for request validation. Neither screenshots nor a successful empty
health response establish delivery guarantees.

## ⚖️ Decisions and local implementation boundary — 2 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Send lifecycle | ✅ Frozen revision plus durable receipt | ❌ Fresh send on every retry | Resolve uncertain outcomes without another accepted message |
| Conversation model | ✅ Viewer-specific summaries and message access | ❌ Thread membership grants all history | Protect private replies and BCC-related visibility |
| Draft coordination | ✅ Conditional saves and recovery copy | ❌ Unconditional overwrite | Preserve the losing editor's authored text |
| Search propagation | ✅ Durable versioned projections | ❌ Global timestamp watermark | Repair retries, late commits, and deletion ordering |
| Client updates | ✅ Versioned desired state | ❌ Blind inverse rollback | Preserve newer intent across delayed responses |

The repository demo provides internal SQL sends, session cookies, per-user flags,
draft version checks, a paged virtualized list, and search polling. Its compose window
never saves drafts, thread detail uses overly broad thread membership, cache
invalidation and archive filtering are incomplete, and send has no idempotency
receipt. Raw HTML and stale client responses also need correction. [The architecture
document](./architecture.md) records actual behavior; these interview decisions
describe the intended production design.

> “The browser and server need to agree about three kinds of identity: the account allowed to see a message, the revision being edited, and the operation being retried. Once those contracts are explicit, we can make the experience responsive and scale its projections without confusing a quick UI response with durable success.”
