# Design an electronic signature platform — backend interview

A 45-minute proposed design, with three deep dives. The production guarantees described here
are design choices; the local implementation differs in important ways summarized at the
end.

## 🎯 Requirements and boundaries — 4 minutes

> “I would start by defining what the system records: a specific recipient performed a specific action on a specific immutable document revision. Sending an email and generating a downloadable artifact are related jobs, but neither should determine whether that action committed.”

The core flow is prepare an envelope, assign fields and routing stages, send it, collect
recipient decisions, and produce a final artifact with an evidence manifest. The sender may
withdraw an active envelope; recipients may decline. Those competing decisions must have a
defined order.

I would ask about signature assurance, supported document formats, expected retention, and
whether recipients sign in serial or parallel. Those answers affect the evidence and
authorization model. For this discussion, I assume ordinary PDFs, accountless invited
signers, and explicit routing stages.

I would exclude collaborative preparation, template management, offline submission, and
external identity-provider integration from the first version. We still leave room for an
assurance policy, but a flag in a database is not an implemented identity check.

| Requirement | Proposed objective |
|-------------|--------------------|
| Correctness | One accepted effect per scoped operation; immutable document revision binding |
| Availability | 99.9% regional metadata/action API availability |
| Latency | p95 under 300 ms for small metadata operations, excluding file transfer |
| Artifacts | Asynchronous generation, p95 under 60 seconds for bounded ordinary PDFs |
| Audit | Ordered, canonical events bound to content and a protected expected head |
| Recovery | Explicit database replication acknowledgment and regional failover policy |

I would not promise legal enforceability, a particular retention period, or a certification
merely from this architecture. The engineering model must implement the product's specified
consent, identity, access, and retention requirements and preserve evidence of what actually
happened.

One distinction matters throughout: a recipient finishing their fields, all recipients
finishing, and the final artifact becoming available are three separate facts. Combining
them into one status hides failure and makes recovery harder.

## 📏 Capacity and architecture — 4 minutes

Assume 100,000 envelopes per day, three recipients per envelope, two 2 MiB PDFs per
envelope, and three field actions per recipient. A tenfold daily-average peak is an initial
assumption to validate against batch sends and business-hour concentration.

That gives about 1.16 envelope creations per second on average and 11.6 at the assumed peak.
Field actions are approximately 900,000 per day, or 104 per second at peak. This is a
reasonable starting workload for a relational database with short transactions.

Bytes are more demanding: originals alone are about 391 GiB per day, or 139 TiB per year
before replicas, signatures, output artifacts, and retained versions. I would separate file
transfer and parsing capacity from the small-request API budget.

```
┌─────────────────┐     ┌──────────────────┐
│ Sender / signer │────▶│ Gateway and auth │
└─────────────────┘     └──────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ Envelope service │
                        │ State authority  │
                        └──────────────────┘
                            │         │
                            ▼         ▼
                  ┌──────────────┐ ┌───────────────┐
                  │ PostgreSQL   │ │ Private       │
                  │ State, audit │ │ object store  │
                  │ receipts,    │ │ Originals and │
                  │ outbox       │ │ artifacts     │
                  └──────────────┘ └───────────────┘
                         │                 ▲
                         ▼                 │
                  ┌───────────────┐ ┌───────────────┐
                  │ Relay / queue │▶│ Workers       │
                  │ Durable jobs  │ │ PDF and email │
                  └───────────────┘ └───────────────┘
```

I would begin with one regional envelope authority and modular services, not a transaction
scattered across several databases. Stateless API replicas share that authority. Object
storage holds immutable bytes; PostgreSQL holds the references and business decisions.

A CDN can serve application assets. Document delivery must remain authorized and
version-bound, through a private gateway or a narrowly scoped signed URL. A public bucket is
not made private by adding authentication to the metadata API.

## 💾 Data model and API — 5 minutes

The envelope is the concurrency boundary. Documents, field definitions, recipients, and
their accepted actions all identify the frozen revision. A mutable draft and an active
signing revision must not share an ambiguous “latest document” reference.

| Entity | Key information | Constraint or access pattern |
|--------|-----------------|------------------------------|
| Envelope | Sender, home region, version, state, active stage | Guard lifecycle changes by envelope ID/version |
| Document revision | Immutable object key/version, digest, page metadata | Never replace bytes referenced by accepted actions |
| Recipient | Envelope revision, role, stage, invitation/session policy | Signer authority checked against current stage and state |
| Field definition | Document/page, geometry, recipient, type, required rule | Same-envelope assignment and bounded geometry |
| Field action | Field revision, input/image digest, actor, operation, time | Unique accepted action under the chosen field policy |
| Operation receipt | Scope, operation ID, request digest, response | Unique scoped key; commit alongside the effect |
| Audit event | Envelope sequence, canonical payload, previous hash, hash | Unique sequence and serialized head advancement |
| Outbox / consumer receipt | Stable event ID, destination, payload version, result | Retain dispatch work and detect duplicate consumption |
| Artifact | Frozen inputs, generation ID, object digest, readiness | Publish one output for the intended generation |

I would store opaque object references and digests in SQL rather than the PDF bytes. This
keeps database transactions small. It also creates a cleanup problem: an uploaded object may
never become attached, so staging and garbage collection are part of the design.

The API describes business operations explicitly. The paths below are proposed, and I would
settle exact naming with the client team rather than letting storage table names define the
interface.

| Method | Example path | Purpose |
|--------|--------------|---------|
| POST | `/envelopes` | Create a draft |
| PUT | `/envelopes/:id/draft` | Update a matching draft revision |
| POST | `/envelopes/:id/send` | Freeze and activate the signing revision |
| POST | `/invitations/exchange` | Establish scoped signer authority |
| GET | `/signing/session` | Current revision, fields, and permitted actions |
| POST | `/fields/:id/actions` | Record one field action with an operation ID |
| POST | `/envelopes/:id/finish` | Confirm this recipient's completion |
| POST | `/envelopes/:id/decline` | Record a recipient's decision |
| POST | `/envelopes/:id/void` | Sender withdrawal under the state rule |
| GET | `/operations/:id` | Reconcile an ambiguous action outcome |
| GET | `/envelopes/:id/artifacts` | Authorized ready outputs and their identities |

Errors need stable meanings: invalid input, unauthorized field, stale revision, inactive
stage, terminal envelope, and unresolved operation. A transport failure is not itself proof
that the operation failed.

## 🔧 Deep dive: order workflow decisions at one authority — 9 minutes

> “My first correctness choice is to serialize the decisions that change who is allowed to sign. Otherwise two perfectly valid requests can combine into an invalid workflow.”

An envelope starts as a draft. Send validates and freezes its documents, field definitions,
recipients, and stage plan. The first stage becomes active. After every required signer in
that stage confirms Finish, the next stage activates. When all required signers finish, the
envelope's signing work is complete and artifact generation begins.

I would use a short PostgreSQL transaction guarded by the envelope row or version for Send,
Finish, Decline, and Void. It checks current authority and state, performs the transition,
appends the corresponding audit event, stores the operation receipt, and creates outbox jobs
before commit.

All draft mutations must participate in that same guard. Consider a sender changing a field
just as Send validates the envelope. If only Send takes a lock, the other route can read
“draft,” wait elsewhere, then update the field after Send commits. The supposedly frozen
document no longer matches its field plan.

That is why the invariant is a shared protocol across routes, not the presence of one `FOR
UPDATE` statement. Either the mutation sees the expected draft version and commits under the
guard, or it reports a conflict. Uploaded bytes can be staged beforehand so we never hold
the lock during file transfer.

For parallel signing, recipients at one stage can fill different fields independently. Stage
advancement remains one ordered decision. If the last two signers finish concurrently, the
second transaction sees the first one's committed completion, activates the next stage once,
and inserts one stable transition event.

Recipients copied for information do not participate in the required-signer count. In-person
signing is not just another string with the same authority; I would keep it out of scope
until its delegation and identity rules are explicit.

Now consider a sender withdrawing the envelope while a recipient finishes. If Void wins the
guard, Finish sees a terminal state and cannot create an accepted action. If Finish wins,
the withdrawal follows the defined completed-state rule. We do not resolve this by comparing
browser timestamps after accepting both.

| Approach | Why it fits | Cost or failure |
|----------|-------------|-----------------|
| ✅ Short transaction per envelope decision | Orders authorization, stage changes, and competing terminal actions | Contention for unusually large or active envelopes |
| ❌ Independent updates plus notifications | Simple happy path | Lost invitations and contradictory terminal states after races |
| Alternative: single-writer event stream | Can preserve ordered authority | More replay, projection, and operational machinery |

The event-stream alternative can be correct if one ordered stream owns the aggregate. My
objection is to independent services each believing they own part of the transition, not to
event-driven architecture itself. At this scale, SQL transactions make the invariants easier
to inspect and operate.

I would keep notification and PDF work outside the transaction. Instead, write an outbox row
alongside the state change. A relay publishes the job, waits for broker confirmation, then
marks it dispatched. If it crashes after publishing but before marking, it publishes again;
consumers must expect duplicates.

A worker keeps a durable receipt for a stable event ID. For external email, a local receipt
alone cannot prevent the provider accepting a message just before the worker crashes. Use
provider idempotency or queryable provider receipts when available, otherwise describe the
remaining duplicate-delivery risk honestly.

This design trades immediate side-effect completion for durable intent and measurable lag.
The sender sees “invitation queued” before “provider accepted.” An unavailable email
provider can delay the next person's invitation without undoing the already committed
workflow.

I would add admission limits for extreme envelopes and measure lock wait time. At the
initial aggregate rate, sharding individual workflow decisions would buy complexity before
it solves a demonstrated bottleneck.

## 🔧 Deep dive: idempotency across SQL and object storage — 8 minutes

A signer may double-tap, retry after a timeout, or use two tabs. We need to distinguish
repeated transport attempts from distinct conflicting intentions. A response cache alone
does not make that distinction safely.

The client supplies an operation ID for one action, stable across retries. The server scopes
it to the actor or signer session, envelope revision, and operation type. It records a
digest of the request, including the field revision and signature image or value digest.

Inside the transaction, a unique operation claim determines whether this is new. If the same
operation already completed with the same digest, return its immutable receipt. If the key
has a different digest, reject it. If another operation already completed this field, return
that distinct conflict rather than pretending the new action succeeded.

The business mutation and receipt must commit together. A crash after the field update but
before an independent receipt insert otherwise leaves the retry unable to tell whether the
action happened. Redis may accelerate reading committed receipts, but SQL remains the
authority for deciding whether to execute.

A Redis failure should not silently turn a known operation into a new one. For session
authentication, an unavailable session store may require failing the request. For operation
receipts, the backend can use its durable SQL path. Those are separate dependency policies.

| Choice | Benefit | Trade-off |
|--------|---------|-----------|
| ✅ Scoped SQL receipt in the mutation transaction | One committed decision with a replayable result | Receipt storage, retention, and transaction contention |
| ❌ Redis check then perform then cache | Fast and easy | Concurrent misses execute twice; crashes leave uncertain effects |
| ❌ Hour-based generated key | Catches some nearby duplicates | Time boundaries separate the same intent; no payload binding |

The hard boundary is object storage. We cannot roll an object upload back with a PostgreSQL
transaction. I would first validate the image and place it under a new immutable staging
key, then record its version and digest in the transaction that accepts the field action.

If staging fails, there is no recorded action. If staging succeeds but SQL rejects the
action, the object remains unattached and is collected later. If SQL commits but the
response is lost, the same operation returns its receipt and references the same accepted
bytes.

Garbage collection must avoid racing with an in-flight attachment. Use explicit staging
lifecycle/ownership or a conservative age plus an attachment check under the appropriate
coordination. A storage timeout can also leave an object present, so reconcile using its
known identity before creating unbounded replacements.

The receipt can say “field action recorded” without saying the recipient finished. Finish
has its own operation ID and rechecks required field values. Merely setting a completed
boolean is not sufficient if an empty required text field or an unchecked required consent
field violates the product's rule.

A field-action uniqueness constraint complements operation idempotency. Two different
operation IDs for the same field must not both become accepted final actions unless
replacement is explicitly modeled as a new revision. This is how we handle two tabs whose
intentions were genuinely distinct.

Receipt retention is also a policy. If receipts expire but the original effect remains,
replay cannot simply treat the old key as new. Keep enough durable identity or field-state
constraints to resolve late retries, and expose an expired-recovery result if the original
response is no longer retained.

> “I would promise one accepted effect for the defined operation scope. I would not call the network exactly-once, because responses and worker messages can still be duplicated or lost.”

The cost is a more careful protocol and some abandoned-object cleanup. The benefit is that
an unknown outcome becomes a recoverable state rather than a reason to guess whether a
signature was recorded.

## 🔧 Deep dive: evidence that binds to actual bytes — 7 minutes

An audit list can tell a compelling story while failing to identify the document that story
is about. I would start with content identity: immutable original revision, page geometry,
accepted field values or signature digests, and the exact consent/confirmation version used
for the action.

Each committed event gets a per-envelope sequence number and a canonical payload version.
Include the actor, action, revision identifiers, content digests, recording time, and
previous event hash. Update the audit head under the same guard as the associated business
decision.

I would not hash arbitrary serialized database JSON and assume it will reproduce the same
bytes later. Object-key ordering and timestamp representation need an explicit canonical
format. Verification must be defined across storage round trips and future implementation
versions.

The sequence matters too. Two writers reading the same previous hash can create competing
successors. Ordering events only by wall-clock timestamp does not repair that fork, and
timestamps can tie. The database should enforce unique sequence positions while the envelope
authority advances the head once.

A chain alone does not prevent a privileged actor from replacing the events and recomputing
all hashes. Nor does checking the available prefix prove that the expected tail was not
deleted. The verifier needs an independently protected expected head and event count.

I would export signed checkpoints and canonical event batches to separately controlled
storage. A checkpoint identifies envelope revision, sequence count, head digest, signing key
version, and checkpoint time. Verification checks against that retained reference rather
than simply trusting whatever head the mutable database currently returns.

| Approach | What it establishes | Cost or limitation |
|----------|----------------------|--------------------|
| ✅ Canonical chain plus protected checkpoint | Detectable divergence from the anchored record | Key management, archive permissions, export lag |
| ❌ Mutable chain beside workflow rows | Internal consistency of available rows | An actor controlling both can rewrite or truncate them |
| ❌ Signature image alone | A visual mark | No complete binding to document revision or authority |

This does not establish a person's identity by itself. An IP address is context, and an
email-link session is evidence of link possession. Stronger assurance requires the
corresponding authentication process and records, not stronger language in a certificate
template.

Artifact generation consumes a frozen input manifest. The worker places accepted fields into
each PDF and writes the output to an immutable key with its digest. Any digital sealing step
has a defined key and verification policy; merely flattening an image into a PDF is a
rendering operation.

The worker publishes readiness conditionally for its generation ID. If two deliveries run
the same job, they cannot replace a newer artifact. If generation fails, preserve the
recorded signer actions and expose an artifact-pending or failed state with a retryable job.

The evidence manifest should enumerate all documents, not pick an arbitrary document name
from a join. It references the canonical sequence actually verified. Fetching events for
display and running verification in separate unbound queries can produce a report about two
different sets of events.

The trade-off is that artifact readiness and archive/checkpoint readiness may lag behind
signing. I would expose those stages and monitor their age. A single “completed and
verified” flag would hide the very failure conditions the evidence design is meant to
explain.

## 🧯 Security and failure handling — 3 minutes

Sender accounts use secure sessions and server-side authorization. Signer invitations are
scoped, expiring, and revocable, with action permission checked from current envelope state.
The document route must apply the intended access policy too; withdrawing signing authority
does not automatically revoke a previously issued storage URL.

Keep uploaded content private, validate resource bounds, and parse under controlled
concurrency. A PDF parser or worker thread is not a complete security boundary. Logs should
identify request/operation IDs without retaining invitation secrets in URL paths or
unnecessary signature content.

| Failure | Response |
|---------|----------|
| SQL authority unavailable | Reject new workflow decisions rather than accept unrecorded signatures |
| Storage timeout | Reconcile staged object identity; keep action outcome explicit |
| Broker outage | Retain outbox work; show dispatch delay |
| Poison message | Durable retry/quarantine with verified routing and operator visibility |
| Audit append failure | Abort the business transaction |
| Artifact generation failure | Retry generation without repeating signer actions |
| Old region still reachable after failover | Fence the old writer before accepting new mutations |

A circuit breaker bounds repeated failures and protects capacity; it does not cancel a
remote effect already underway. I would use bounded timeouts, admission controls, and
retries that understand operation identity. A queue's durable flag also does not repair an
incompatible message contract or a missing dead-letter binding.

## 🚀 Scaling and verification — 3 minutes

I would scale byte delivery and PDF processing before sharding the envelope database. At our
assumptions, object bandwidth and bounded parser concurrency are more pressing than a few
hundred transactional writes per second.

Add appropriate sender/status indexes and stable pagination, partition growing audit/outbox
maintenance by time, and measure per-envelope lock contention. Keep one envelope's state and
sequence colocated. Regional distribution assigns each envelope one writer and requires a
deliberate failover/replication policy.

Observe business progress: age of the oldest outbox job, time to notify an active stage,
unknown action outcomes awaiting reconciliation, artifact-generation lag, and failed
evidence checks. Health probes show dependencies are reachable; they cannot prove that a
worker understands the payload or that a recipient received an email.

| Verification scenario | Invariant |
|-----------------------|-----------|
| Concurrent last signers | One stage activation and stable event identity |
| Draft edit racing Send | Either included in the frozen revision or rejected |
| Same operation concurrently | One accepted effect and the same receipt |
| Void racing Finish | One defined ordering, no terminal-state resurrection |
| Crash after publish | Duplicate consumer delivery is safe |
| SQL rejects after upload | Unattached bytes are eventually collected safely |
| JSON/timestamp round trip | Canonical digest remains reproducible |
| Tail deletion or full local rewrite | Protected checkpoint detects divergence |

I would test these with controlled failures, not infer correctness from a login smoke test.
Load tests then establish the latency and memory envelope for the supported document sizes.

## ⚖️ Trade-offs and implementation boundary — 2 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Workflow authority | ✅ Guarded SQL aggregate | ❌ Independent lifecycle writes | Orders stage and terminal decisions |
| Side effects | ✅ Outbox plus duplicate-safe workers | ❌ Publish after commit | Retains dispatch intent through crashes |
| Idempotency | ✅ Scoped durable receipts | ❌ Response cache alone | Couples the effect to replay evidence |
| Audit | ✅ Canonical events and protected checkpoints | ❌ Unanchored mutable chain | Binds verification to an expected complete record |
| Artifacts | ✅ Separate asynchronous readiness | ❌ Generate during signing lock | Keeps slow rendering outside core decisions |

The local code has one Express API with PostgreSQL, Redis, MinIO, and RabbitMQ helpers. Only
Send takes an envelope lock; other transitions and field actions are not atomic. The receipt
cache can execute concurrent duplicates, and the normal session cache shape blocks signer
writes.

The two audit writers use incompatible formats, the worker expects different payloads and
nonexistent tables, and sender completion notification misuses a user ID as a recipient
foreign key. Final signed artifact generation and protected checkpoints are absent.
[architecture.md](./architecture.md) documents those source findings; this interview answer
describes the design needed to resolve them.

> “I would leave the whiteboard with three invariants: one authority orders the envelope, one durable receipt identifies an accepted action, and one protected content reference identifies what the evidence covers. Those are more useful than a diagram full of services without clear ownership.”
