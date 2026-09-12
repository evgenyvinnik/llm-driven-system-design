# Gmail: backend system design interview

A proposed 45-minute design for an internal email service. Capacity numbers are
assumptions for this discussion, not claims about Google's infrastructure or
measurements of the repository demo.

## 🎯 Clarify the service and its guarantees — 5 minutes

> “I would scope this as mail between registered accounts, with conversations, To/CC/BCC, per-user mailbox state, drafts, and search. The interesting backend problem is that content is shared while visibility and organization belong to individual users. I will make those boundaries explicit before choosing databases.”

I would leave external SMTP delivery, IMAP/POP3, attachments, mailing-list expansion,
scheduled sending, and spam classification outside the first version. Those features
introduce their own delivery, abuse, and storage protocols. A manual Spam folder is
still useful without claiming that an ML classifier exists.

A message records a fixed sender, body, and audience. A thread groups related
messages. The two identities are not interchangeable: receiving one message in a
thread does not entitle a user to every earlier or later message in that conversation.

For example, Alice sends to Bob and BCCs Charlie. Charlie can read that message
without being disclosed to Bob. If Bob replies only to Alice, Charlie must not see the
reply, its snippet, its sender-derived participant list, or a global count that
reveals hidden activity.

The sender expects one accepted message when retrying the same send operation. Each
recipient expects one mailbox delivery effect, even when a worker retries. Those are
distinct invariants. I would not promise one transaction covering every recipient
across all regions.

| Requirement | Contract |
|-------------|----------|
| Acceptance | Persist content, intended audience, retry receipt, and delivery work before acknowledgment |
| Delivery | Retry durably; deduplicate each recipient effect and report progress |
| Mailbox state | Read, star, archive, labels, and trash are independent for each user |
| Drafts | Reject stale versions and return enough information to preserve both edits |
| Search | Return only currently entitled content; distinguish unavailable from no results |
| Latency/availability | Propose p99 under 200 ms for bounded inbox reads, under 500 ms for search, and 99.99% core availability |

Search may lag accepted mail under normal operation; I would target ten seconds
initially and alert on backlog age. Recently sent mail should still be visible through
the authoritative send receipt and mailbox path. Eventual search consistency must not
be presented as eventual confidentiality.

## 📊 Estimate the dominant work — 3 minutes

Assume ten million daily active users, twenty sends per user per day, and three
recipients per send. That yields 200 million accepted messages and 600 million
recipient deliveries daily. The average send rate is about 2,315 per second; a tenfold
peak is about 23,150 per second.

At 10 KB of text per message, bodies add about 2 TB per day before replication and
indexing. Sender plus recipient mailbox copies create roughly 800 million projection
records per day. I would measure the distribution of recipient counts and body sizes,
because a few enormous messages or fan-outs can dominate latency and cost.

A hundred mailbox-page reads per active user gives one billion reads per day, about
11,575 per second on average. Five searches per user gives fifty million daily
searches, roughly 580 per second. Peaks and per-user skew determine cache usefulness;
I would not derive a 97% hit rate from choosing a thirty-second TTL.

These numbers justify partitioning and independent worker capacity. They do not
require the first local implementation to deploy a global cluster. I would begin with
one relational database that expresses the invariants, then preserve the transaction
boundaries as ownership moves to shards.

## 🏗️ Draw ownership and the asynchronous path — 4 minutes

```
┌─────────────────────────┐       ┌──────────────────────────────┐
│ Authenticated mail API  │──────▶│ Message authority + outbox   │
└─────────────────────────┘       └──────────────┬───────────────┘
                                                 │
┌─────────────────────────┐       ┌──────────────▼───────────────┐
│ Mailbox + search views  │◀──────│ Delivery / indexing workers  │
└─────────────────────────┘       └──────────────────────────────┘
```

The API establishes account identity and routes requests to the correct authority.
Message acceptance stores immutable content, audience, and a durable receipt together.
Mailbox services own each user's visible conversation projection, state, drafts, and
contacts. Workers deliver accepted messages and publish search changes.

Redis is useful for sessions, limits, and bounded mailbox caches, but durable delivery
work does not live only in an expiring cache. Elasticsearch is a projection with its
own availability budget. Its outage should not make an accepted message disappear or
force the sender to submit again.

At the initial scale, message and mailbox tables can share a PostgreSQL database. At
larger scale, assign the acceptance authority by sender and mailbox ownership by user.
The acceptance transaction remains local to its authority; recipient delivery becomes
asynchronous and independently recoverable.

I would keep drafts and the sender's acceptance records colocated so finalizing a
draft and accepting its frozen revision can use one local transaction. Recipient
mailbox updates are deliberately outside that transaction. A location directory allows
user partitions to move without changing every public identifier.

## 💾 Data and API contracts — 5 minutes

| Record | Important key or relationship | Why it exists |
|--------|-------------------------------|---------------|
| Message | Stable ID; sender, immutable body, thread ID, optional reply parent | Canonical accepted content |
| Audience | Message ID + recipient ID; To/CC/BCC role and entitlement | Message-specific visibility |
| Send receipt | Sender ID + operation key; digest and message ID | Safe replay and uncertain-outcome lookup |
| Mailbox message | User ID + message ID; unique delivery ID and mailbox sequence | One recipient effect per message |
| Mailbox conversation | User ID + thread ID; visible summary, state version, read watermark | User-oriented listing and state updates |
| Labels and assignments | Owner ID in label and assignment keys | Independent filing with enforceable ownership |
| Draft | Owner, ID, version, content, active/sent/deleted state | Conflict-aware editing and final send boundary |
| Outbox / consumer receipt | Durable event ID and entity version | Recover asynchronous work across crashes |

A conversation's visible snippet, count, and last activity are derived from that
user's entitled messages. Storing a global latest snippet beside per-user read flags
is insufficient when participants differ between messages. The projection may
duplicate small metadata, while immutable bodies remain shared.

Separate mailbox rows also distribute updates and fit queries ordered by user
activity. A JSONB aggregate can be indexed, so I would not dismiss it as unqueryable.
The concern is that a large object containing every participant's state creates a
shared row hotspot and does not naturally colocate all of one user's mailbox data.

I would show a small API surface rather than every CRUD endpoint:

| Method | Proposed endpoint | Main contract |
|--------|-------------------|---------------|
| POST | `/messages` | Accept a frozen send with operation key and digest |
| GET | `/send-operations/:key` | Resolve accepted, pending, or failed outcome for this sender |
| GET | `/mailbox/threads` | Bounded page of viewer-specific summaries |
| GET | `/threads/:id/messages` | Bounded authorized message page and visible sequence |
| PATCH | `/mailbox/threads/:id` | Desired state with expected mailbox-item version |
| PUT | `/drafts/:id` | Conditional save with save operation ID |
| GET | `/search` | Validated query, bounded cursor, explicit availability state |

A missing or unauthorized resource returns an appropriate opaque failure; the API must
not disclose another user's subject while explaining why access failed. Structured
conflicts return the caller's current authorized state. Pagination cursors bind to
account and query context and do not grant access on their own.

## 🔧 Deep dive 1: accept once and deliver reliably — 10 minutes

### Define the exact commit point

> “I would call a message accepted when the service can recover it and its delivery work after a crash. Acceptance is a durable fact, not evidence that every recipient's search index already contains it.”

The request first validates body bytes, recipient count, address types, and reply
context. Resolve every internal recipient to a stable account ID. Unknown addresses
reject the operation before acceptance rather than silently dropping part of the
audience. Deduplicate delivery identities while preserving the intended visible
recipient roles.

For a reply, check that the sender can read the referenced message, that the parent
belongs to the stated thread, and that the request does not grant implicit access to
unrelated history. A public thread identifier is not permission to append into it.
Recipients get only the newly addressed message and deliberately quoted content.

The acceptance transaction claims a unique receipt scoped to sender and operation key.
Its digest covers the frozen body, recipient roles, subject, reply context, and draft
revision if present. If that key already committed with the same digest, return the
original message ID. If the digest differs, reject the conflict.

The claim must serialize concurrent duplicates before their effects occur. A
preliminary lookup followed by an unconstrained insert is racy. Inserting a receipt
after repeating the send, then ignoring its uniqueness conflict, is also insufficient:
both messages could already exist.

The same transaction stores immutable message content, audience records, and outbox
work. It also finalizes the sender's draft if this is a draft send. No Redis
invalidation or Elasticsearch request is required to decide whether that SQL
transaction commits.

### Work through the crash cases

If the process crashes before commit, no accepted message exists and the same
operation may be retried. If it crashes after commit but before responding, the
durable receipt resolves the retry. If the queue is unavailable, the outbox remains
pending in the database until a publisher can deliver it.

The outbox publisher uses short leases or claimed rows to coordinate workers. It marks
completion only after the downstream acceptance condition is met. A crash can cause
publication again, which is why every consumer treats delivery as at least once.

A mailbox consumer writes the user's message entry, visible conversation update,
unread effect, and processed-event receipt together. The unique user/message delivery
identity prevents duplicate unread increments. A crash after that commit but before
queue acknowledgment causes a replay that returns the committed effect.

There is no dependency on a global maximum creation timestamp. A transaction can
commit later than another transaction that started after it. Pending outbox rows
remain discoverable regardless of that timing. A monotonically allocated ID alone is
not necessarily commit order either.

### Separate delivery failure from acceptance failure

Most recipients may be delivered while one mailbox partition is unavailable. Keep the
send accepted, show delayed delivery status for the remaining recipient, and retry
with backoff and a budget. Do not roll back recipients who already received the
message or tell the sender to submit a second independent send.

Permanent delivery failures need a visible status and an auditable reason. Reaching a
dead-letter queue is not successful delivery. Operators need replay tooling that
retains the original message and recipient identities, and support staff should not
need access to message bodies to inspect queue health.

| Approach | Why choose or reject it here | Cost |
|----------|-----------------------------|------|
| ✅ Durable acceptance followed by idempotent recipient delivery | A failed recipient shard does not block every sender transaction | Delivery status, outbox workers, deduplication, and repair |
| ❌ Global transaction across all recipient shards | Gives one broad atomic boundary | Couples latency and availability to every participant and region |
| ❌ Fire-and-forget publish after committing the message | Small happy path | A crash between commit and publication loses delivery work |

> “I give up simultaneous visibility in every mailbox. In exchange, acceptance remains durable and recoverable during partial failures. The product must expose delivery progress honestly for that trade to work.”

For a small single-database demo, one transaction across all recipients is reasonable.
The scale transition is what changes the contract. I would not continue calling
multi-shard delivery strongly atomic merely because the earlier local implementation
used BEGIN and COMMIT.

### Keep the work bounded

Cap recipients and body bytes before starting the transaction. Contacts can be
projected later because a missed frequency update should not abort message acceptance.
Large fan-out belongs in a separate, rate-limited product path rather than one giant
interactive transaction.

Track accepted operations, outstanding recipient count, oldest delivery age, and
replay frequency. Per-user quotas should reflect recipients or bytes where those drive
cost; fifty requests per hour does not constrain a request containing a million
recipients.

## 🔧 Deep dive 2: search and conversation privacy — 8 minutes

### Entitlement applies to every representation

The first access check is at message level. Mailbox summaries, detail pages, search
hits, counts, and snippets must all be based on entitled messages. A global
thread-state row cannot authorize unseen history, and a cached summary can disclose
content even before someone opens a message.

For BCC, hiding a field from the JSON response is only part of the problem. If the
hidden recipient's name remains searchable, Bob can query that name and infer that
Charlie received the message. Therefore searchable fields themselves must reflect the
viewer's visibility.

I would use per-mailbox search documents keyed by user and message. Public
sender/To/CC fields appear where appropriate; the sender's projection can additionally
include their BCC envelope. A BCC recipient can see their own delivery context,
without learning the other hidden recipients.

This duplicates searchable text for multiple mailboxes, which increases index cost. It
also makes user-based routing and per-user deletion straightforward. A shared document
with a `visible_to` array is a valid smaller design if its searchable fields are
common to all viewers, but it cannot simultaneously express every viewer's distinct
envelope without additional logic.

### Choose the search engine for its workload

PostgreSQL full-text search can enforce permission predicates, including joins or
denormalized mailbox fields. I would start there if query quality and measured load
fit. Elasticsearch becomes worthwhile for independent search scaling, relevance
tuning, and a large historical corpus, with the operational cost of a separate
projection.

Neither an inverted index nor an array term filter provides a universal constant-time
privacy guarantee. Query cost depends on postings, filters, distribution, and result
size. I would measure realistic mailboxes and operator combinations rather than claim
that SQL cannot perform private search.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Per-mailbox index at the stated scale | Audience-specific fields and natural mailbox routing | More documents, indexing work, and storage |
| ❌ One fully shared searchable recipient envelope | Fewer indexed copies | Hidden-recipient queries can reveal information |
| ❌ Synchronous indexing in the send transaction | Simple apparent freshness | Search outage becomes a send dependency without cross-store atomicity |

### Build a repairable projection

A committed mailbox change emits durable indexing work. The worker publishes an entity
version and acknowledges only after the search store accepts the upsert or tombstone.
Duplicate publication is harmless; an older retry must not overwrite a newer deletion
or state change.

A failing item should remain retryable without blocking unrelated mail forever. Use
bounded attempts, a durable failure record, alerts, and controlled replay. Deletion
tombstones or equivalent version history must survive longer than any stale replay
that could resurrect the document.

For rebuilding, create a new index generation from a consistent source snapshot and
apply changes that occur during the rebuild. Switch reads only after verification and
catch-up. Keep the previous generation long enough for a controlled rollback, while
preserving current access checks. Simply deleting an index while retaining the old
checkpoint cannot reconstruct history.

Timestamp polling is tempting because it is easy to explain. It can fail at equal
timestamps, precision conversions, and late commits behind the watermark. Adding an ID
to the cursor fixes deterministic ties but not a transaction committing after the
scanner has passed its timestamp. A durable pending-work record addresses the actual
recovery problem.

### Return only currently authorized results

Query the mailbox index for candidate IDs, then hydrate through the current
authoritative entitlement and deletion state before producing content. Bound overfetch
so a page with many removed candidates does not trigger an unbounded database scan.
Return a continuation or partial page honestly when the budget is exhausted.

A point-in-time search view can stabilize ordering across pages. It does not preserve
permissions: an entry deleted or revoked after the snapshot must still be removed
during hydration. Do not expose an exact candidate total if that total includes
content the user may no longer access.

Return snippets as text plus validated highlight ranges, or use a rigorously defined
encoding/sanitization contract. An email body is untrusted even when it reaches the UI
through Elasticsearch. A raw fallback substring can be as unsafe as a highlighted
fragment.

Search errors return an explicit unavailable or degraded state. The browser can still
navigate recent authoritative mailbox pages. Returning empty success for an outage
creates the false impression that mail has been lost, and makes search reliability
hard to measure.

## 🔧 Deep dive 3: drafts and mailbox concurrency — 6 minutes

### A version check is necessary but not the whole editor

The draft update is scoped to owner and expected version, and increments the version
in the same atomic operation. If two tabs save from version 4, only one conditional
update succeeds. The other receives a conflict and the current authorized draft.

There is still ordinary short-lived database locking during updates. Optimistic
concurrency does not mean zero contention. Its advantage is that the application does
not reserve an editing session for the duration of a human's work; it detects stale
state when saving.

The client retains its local text on conflict and offers comparison or a separate
copy. Returning the server draft is useful only if the browser preserves the failed
editor's work. Automatically replacing the editor and announcing a conflict would
detect the data loss while still causing it.

A save operation ID handles a response lost after the conditional update committed.
Otherwise the client retries the old version and mistakes its own successful save for
another tab's conflict. Draft creation also needs a stable identity if autosave can
retry creation.

| Approach | Benefit | Cost |
|----------|---------|------|
| ✅ Expected versions plus durable save receipts | Detect cross-tab conflict and resolve lost acknowledgments | Receipt retention and client conflict handling |
| ❌ Last-write-wins saves | Simple update path | Delayed requests can overwrite newer text |
| ❌ Exclusive editing lease | Reduces simultaneous writers | Takeover rules and fencing after expiry |

### Finalize sending with the draft

When sending, the client selects a frozen revision. The sender authority verifies that
draft version, writes the accepted message and send receipt, and transitions the draft
to sent in one transaction. A concurrent save or second send fails its expected-state
condition or replays the same accepted operation.

If a save wins first, the user must review or explicitly send that newer revision. If
send wins first, a late save cannot turn the draft active again. Discard uses a
versioned terminal transition too, so a stale editor cannot erase or revive another
tab's state silently.

The draft owner and sender authority are colocated for this transaction. If the system
later separates them, it needs another explicit durable coordination protocol. Moving
tables to separate services does not preserve the old transaction for free.

### Read and archive semantics

For mailbox read state, acknowledge the highest visible message sequence the reader
actually observed. A new delivery with a higher sequence remains unread even when an
older read acknowledgment arrives late. A late boolean “read=true” cannot express that
distinction.

Archive removes Inbox membership for that user's conversation. A subsequent delivery
follows a defined policy for returning archived conversations to Inbox; Trash and Spam
rules may differ. State transitions and summary/count updates share a mailbox version
so caches and clients can reconcile them.

Per-user label assignments must validate both label ownership and conversation
visibility. Composite constraints or equivalent transactional checks should prevent
attaching another user's label. Having a user_id column alongside two foreign keys is
not itself proof that all three belong together.

## 🛡️ Failure handling, operations, and validation — 4 minutes

Sessions remain revocable server-side, with secure cookies, session rotation on
authentication, explicit request-origin/CSRF protection, and bounded login attempts.
Redis failure must fail closed for authentication. Optional mailbox caches can bypass
Redis under a bounded database fallback, but only if the implementation actually
isolates cache errors from required session work.

A search circuit breaker and deadline can bound repeated dependency failures, provided
calls really pass through them and timeouts cancel or bound underlying work. A
declared helper does not protect anything on its own. Preserve typed dependency errors
until the API decides how to represent degraded behavior.

Liveness checks the process independently of Redis sessions and request quotas.
Readiness checks dependencies needed for the traffic being routed, while search/worker
freshness has separate probes. Graceful shutdown stops new work, releases or finishes
leases, drains requests to a deadline, and then closes pools.

I would test response loss after acceptance, worker crash after mailbox commit,
repeated recipient events, a BCC recipient excluded from a later reply, stale indexing
after deletion, two saves from one version, and send racing with save. Those tests
assess the invariants directly rather than only checking HTTP status on mocked routes.

The local repository uses one SQL send transaction, cookie sessions, Redis request
counters, a working draft version condition, and a timestamp-polling indexer. It lacks
send receipts and outbox delivery; archive/cache semantics, reply access,
message-level visibility, and checkpoint precision have gaps. Search errors become
empty success, and the circuit-breaker helper is unused.
[architecture.md](./architecture.md) records those source findings separately from
this proposal.

> “The design's central boundary is durable acceptance followed by recoverable projections. Message-specific entitlement protects privacy, mailbox ownership keeps state independent, and conditional draft revisions protect authored work. I would validate those boundaries before claiming scale from the number of service instances.”
