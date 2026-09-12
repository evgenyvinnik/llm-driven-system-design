# Design an electronic signature platform — fullstack interview

A 45-minute proposed design balancing the browser journey with server correctness. The local
project is a learning implementation; its missing and broken integrations are summarized at
the end rather than treated as completed production features.

## 🎯 Define the user journey — 4 minutes

> “I would design the system around the handoff between what the signer sees and what the server records. The interface must identify the document revision, the server must authorize the action, and the response must say exactly which part succeeded.”

A sender uploads PDFs, adds recipients, places fields, previews routing stages, and sends an
envelope. A recipient follows an invitation, reviews the frozen documents, completes
assigned fields, and confirms or declines. After all required signers finish, a background
process creates a final downloadable artifact.

The sender tracks progress, and administrators investigate failed notifications, stalled
workflows, and evidence problems. These are distinct permissions. An administrator's
operational access should not silently become authority to act as a signer.

I would ask whether documents can change after sending, which recipients are required, and
what the final download must contain. For this design, sending freezes a revision,
same-stage signers can act in parallel, and copied recipients do not block progress. Changes
after send require an explicit replacement workflow outside today's scope.

| Requirement | Proposed boundary |
|-------------|-------------------|
| Document correctness | Browser and recorded action refer to the same immutable revision |
| Field placement | Stable across viewport changes and final output generation |
| Retry behavior | Recover a matching accepted action after an ambiguous timeout |
| Workflow | Ordered stage changes, finish, decline, and withdrawal |
| Feedback | Separate recorded fields, recipient completion, and artifact readiness |
| Accessibility | Complete the ceremony with keyboard or pointer on a narrow screen |

I would exclude collaborative authoring, offline submission, and templates from the initial
scope. Identity assurance, consent, and retention requirements need explicit product
decisions. We cannot infer legal certification from the presence of hashes or a signature
canvas.

For planning, assume 100,000 envelopes per day and three recipients per envelope. I would
target regional metadata responses under 300 ms at p95 and first-page usability within two
seconds for a defined ordinary PDF scenario. These are objectives to test, not universal
promises for arbitrary files and networks.

## 🏗️ Architecture and ownership — 5 minutes

I would draw one frontend-to-backend path, with a separate asynchronous path for work that
should not hold up recording the recipient's decision.

```
┌───────────────────┐    ┌──────────────────┐
│ Sender workspace  │    │ Signer ceremony  │
│ Draft preparation │    │ Review and input │
└───────────────────┘    └──────────────────┘
          │                       │
          ▼                       ▼
┌──────────────────────────────────────────┐
│ Shared geometry and API contracts        │
│ Revision IDs, fields, operation receipts │
└──────────────────────────────────────────┘
                       │
                       ▼
              ┌───────────────────┐
              │ Envelope API      │
              │ Auth and workflow │
              └───────────────────┘
                   │         │
                   ▼         ▼
         ┌──────────────┐ ┌───────────────┐
         │ PostgreSQL   │ │ Private       │
         │ State, audit │ │ object store  │
         │ outbox       │ │ Versioned PDF │
         └──────────────┘ └───────────────┘
                │                 ▲
                ▼                 │
         ┌───────────────┐ ┌───────────────┐
         │ Relay / queue │▶│ Workers       │
         │               │ │ PDF and email │
         └───────────────┘ └───────────────┘
```

I would start with a modular API backed by one regional SQL authority. Separate modules
clarify ownership without immediately requiring distributed transactions. Object storage
holds immutable file bytes; the database records which versions and actions belong to the
envelope.

On the frontend, server resources live in a query cache and transient interactions in local
component state or a small store. The sender needs draft editing tools; the signer needs a
viewer and input controls. Shared geometry belongs in a common module, while heavy authoring
code should not be required for the signer route.

The browser owns a preview, not the authoritative state machine. It can disable Finish until
visible validation passes and show who is waiting, but the server rechecks permissions,
required values, revision, and active stage before accepting an action.

The proposed model separates an envelope, document revision, recipient, field definition,
field action, operation receipt, audit sequence, outbox job, and generated artifact. That
sounds like several entities, but each answers a concrete question: what was seen, who could
act, what committed, and what still needs work?

At the assumed load, three field actions per recipient produce about 104 field writes per
second at a tenfold average peak. Two 2 MiB documents per envelope produce about 391 GiB of
original bytes per day. File handling and storage deserve their own capacity budgets instead
of being hidden inside a metadata latency target.

## 🔌 Contracts and state synchronization — 4 minutes

I would define runtime request and response schemas at the API boundary, then derive or
share types. TypeScript alone cannot validate JSON, convert numeric strings, or make a
cached object match the shape expected by middleware.

| Contract | Essential data | Why it matters |
|----------|----------------|----------------|
| Draft | Envelope ID, revision, documents, fields, recipient stages | Prevent stale saves and unclear routing |
| Signing session | Recipient, frozen revision, fields, current authority | Bind the viewer to the action scope |
| Page metadata | Page box, rotation, coordinate convention | Match browser geometry to the PDF |
| Action request | Operation ID, field/revision, input digest | Distinguish retry from conflicting intent |
| Action receipt | Accepted operation, revision, result | Reconcile response loss accurately |
| Artifact status | Generation ID, ready/pending/failed, digest | Avoid promising a nonexistent download |

The API should return domain errors with enough structure to guide recovery. “Inactive
stage,” “invitation expired,” “revision changed,” and “operation outcome unknown” should not
all become “request failed.” Keep sensitive details out of errors shown to unauthorized
users.

For state synchronization, tag requests with their envelope and revision and ignore
responses from an obsolete generation. Abort requests when practical, but also guard
application of responses because cancellation can race with completion. A late result for
envelope A must not replace envelope B's fields.

Draft saves use the expected revision. The client can move a field locally during a drag and
commit on drop, but a rejected save remains unsaved and visible for correction. A disabled
Send button cannot prevent a second tab from changing the draft; the backend must enforce
the same revision rule.

I would give the main operations clear REST endpoints: create/update draft, send, exchange
invitation, load signing session, record field action, finish/decline, inspect an operation,
and fetch artifact status. We do not need GraphQL or real-time synchronization to establish
these contracts.

The local API paths can be adapted to that model, but existing route names are not proof of
those guarantees. Contract tests should exercise the real session, middleware, route, and
persistence representations together.

## 🔧 Deep dive: one placement from editor to final PDF — 9 minutes

The sender places a signature field on a desktop viewer. A signer opens the same document on
a phone. Later, a worker embeds the accepted image into the final PDF. Those three
participants must agree about one rectangle.

I would store field geometry in a versioned document-page coordinate system. The immutable
PDF revision supplies page dimensions, crop box, rotation, and coordinate units. The browser
and output renderer share a documented convention and test fixtures, even if they do not use
the same runtime library.

During authoring, measure pointer coordinates relative to the actual rendered page, then
apply the inverse viewport transform. During viewing, transform the stored rectangle into
the current CSS viewport. During output generation, use that same stored rectangle against
the frozen page revision.

| Approach | Why choose it | Failure or cost |
|----------|---------------|-----------------|
| ✅ Document-space rectangle and transform | Works across editor, signer, and output | More careful geometry and compatibility tests |
| ❌ Fixed container pixels | Easy to implement in a demo | Padding, zoom, or a different width changes placement |
| Alternative: normalized page fractions | Convenient proportional representation | Must still define page box, rotation, and origin |

I would not say normalized fractions are automatically correct. A page's visible crop and
rotation define what “top-left” means. Fractions of one page box applied to another can be
just as wrong as pixels. The important decision is the shared, versioned interpretation.

Device-pixel ratio is a separate concern. A canvas may have twice as many backing pixels as
CSS pixels in each direction, while a field remains positioned in CSS space. Multiplying
stored geometry by that ratio would move or enlarge the field incorrectly.

A useful test is a rotated page with nonzero crop offsets and a field near the corner. If
the implementation only scales width and height, it may map to the wrong corner.
Transforming all rectangle corners handles the orientation; round-trip tests verify the
inverse mapping.

The page canvas and overlay should have the same positioning context. Avoid using a padded
card's rectangle as if it were the document. A centered canvas may look fine at one width
while every stored field silently includes a layout offset.

For interaction, I would render accessible field controls over the PDF and offer a checklist
that navigates by document, page, and reading order. A field must remain discoverable when
its page is not mounted. The checklist should open an input panel rather than requiring a
tiny tap target on a phone.

Use a small mounted page window or explicit page navigation to bound memory. At an
illustrative 816 by 1,056 CSS pixels and device-pixel ratio two, one RGBA canvas is roughly
13 MiB. That makes eager rendering of hundreds of pages a material memory problem.

The backend validates page number, finite bounded coordinates, dimensions, field type, and
recipient membership in the same envelope revision. It should reject unsupported page
geometry during preparation rather than accept fields it cannot later reproduce.

Sending freezes the geometry with the document revision. The send transaction and all draft
mutations share an envelope guard, so a concurrent edit is either included in the frozen
version or rejected. We cannot fix an after-send edit race by making the browser controls
disappear quickly.

The artifact worker consumes the exact frozen input manifest. A browser checkmark is only UI
state; it does not place the captured signature into the original PDF bytes. The output is a
new artifact with its own object version and digest.

This design costs more than a fixed-width viewer, but it gives us a clear compatibility
boundary. When upgrading the parser or renderer, compare placement on the same corpus across
the browser and generated output before changing the geometry version.

> “The geometry contract is the bridge between the frontend and backend. If either side invents its own origin or scaling rule, type-safe requests can still produce the wrong document.”

## 🔧 Deep dive: recording an action through an unreliable network — 8 minutes

A signer draws a signature, confirms it, and loses connectivity while the request is in
flight. The difficult question is whether the server recorded it. Neither a spinner timeout
nor a green optimistic checkmark answers that question.

Create one operation ID when the user confirms this field input. Bind it to the signer,
envelope revision, field, and input digest. Retries reuse that ID and payload; a different
action gets a new ID. Do not reuse one session-wide key for every field.

On the backend, validate and stage the signature image under an immutable key, then enter a
short SQL transaction. Recheck live authority, claim the scoped operation, guard the field,
reference the staged digest, append audit data, and commit the receipt with the accepted
action.

An existing operation with the same digest returns its stored receipt. A reused key with
different input is rejected. A different operation targeting a field already completed by
another tab is a separate conflict, so the UI must not treat every 409 as success.

| Client state | Server knowledge | User feedback |
|--------------|------------------|---------------|
| Editing | No submitted action | Input is editable |
| Submitting | Request being handled | Disable repeat action and show progress |
| Outcome unknown | Client lacks the result | Preserve input and reconcile the operation |
| Recorded | Matching committed receipt | Display server-confirmed completion |
| Conflict/rejected | Known incompatible or invalid action | Explain and refresh the relevant authority |

If the response is lost after commit, the client checks the operation or retries with the
same ID. It only marks the field recorded after matching the receipt to that revision and
input. A late receipt must not apply to a newly edited drawing.

The browser should keep the drawn image and text in memory during a recoverable request
failure. Reload recovery can retain a small operation identifier and ask the authenticated
server for its result. I would not automatically store signature images or whole documents
indefinitely on a shared device.

SQL and object storage do not share a transaction. If staging succeeds and SQL rejects the
action, the unattached object is collected later. If SQL commits, the accepted action
references immutable bytes that cleanup must preserve. A timed-out upload may still have
happened, so known object identity matters during recovery.

| Choice | Benefit | What we give up |
|--------|---------|----------------|
| ✅ Receipt committed with action | A retry can discover one accepted decision | Durable receipt storage and reconciliation logic |
| ❌ Check Redis, mutate, then cache | Fast happy path | Concurrent misses or crashes cause duplicate/uncertain effects |
| ✅ Confirmed recorded state | UI matches accepted server actions | Extra waiting on a slow connection |
| ❌ Optimistic recorded signature | Immediate green check | Misleading state after authorization or persistence failure |

Field uniqueness also matters. Two distinct operation IDs must not both become the accepted
final action on one field unless replacement is explicitly versioned. Idempotency identifies
retries; it does not resolve every domain conflict.

Finish is another operation. The client highlights missing required fields, and the server
independently checks their actual values and current stage. After Finish commits, the UI
says this recipient is done; it does not necessarily say all signers finished or that the
final document is ready.

I would gate interaction on a successfully loaded, matching document revision and preserve
an explicit PDF-error state. Rendering success does not prove the person read the document,
but a failed viewer must not be presented as a successful review experience.

This approach trades a simple success/failure model for a small explicit state machine. That
complexity earns its place because it gives the user a truthful recovery path instead of
inviting them to repeat an action whose outcome is unknown.

## 🔧 Deep dive: progress, side effects, and evidence — 7 minutes

The final signer clicks Finish just as the sender clicks Void. Both requests may be valid
against an earlier snapshot. I would serialize those lifecycle decisions at the envelope
authority and apply the product's explicit ordering rule.

If withdrawal commits first, the signer cannot finish afterward. If completion commits
first, the withdrawal request receives the defined terminal-state result. Recipients within
one active stage can fill fields concurrently, but only a guarded transition activates the
next stage once.

The transaction records state, audit event, operation receipt, and outbox jobs together. It
does not call an email provider or render a PDF while holding the lock. A relay publishes
jobs with stable event IDs; workers expect duplicate delivery and retain durable receipts.

Without the outbox, a crash between SQL commit and publication leaves a completed stage with
no invitation to the next signer. Publishing first has the opposite problem: someone gets an
invitation for a transition that never commits. The outbox couples the decision to durable
dispatch intent.

| Approach | Strength | Cost or failure |
|----------|----------|-----------------|
| ✅ Transaction plus outbox | State and required work survive the same commit | Queue lag and duplicate-safe consumers |
| ❌ Independent update and publish | Less machinery | A crash splits state from its side effects |
| ❌ Generate output inside Finish | Synchronous result | Slow files extend locks and request timeouts |

On the frontend, these distinctions become useful statuses: next invitation queued, provider
accepted, recipient finished, artifact generating, artifact ready. An email being queued
must not be labeled delivered. If a provider lacks idempotency or queryable receipts, a
worker crash can still produce a duplicate external email despite local deduplication.

The artifact worker reads the frozen document and action manifest, generates output, stores
its digest, and conditionally publishes readiness for its generation ID. An older or
duplicate job cannot replace a newer result. Generation failure leaves signer actions intact
and produces a retryable artifact job.

For audit integrity, each accepted event gets a canonical payload and per-envelope sequence.
Include actor, action, document revision, field/input digests, recording time, and the
previous hash. Serialize head advancement with the workflow decision so concurrent writers
cannot create a fork.

A hash chain stored beside mutable application rows is only internally checkable. An actor
controlling both can rewrite the whole chain or remove its tail. I would retain signed
checkpoints with expected sequence count and head digest in separately controlled storage.

That introduces key management, archive permissions, and checkpoint lag. It is justified
when the product needs independently checkable evidence. It still does not prove a person's
identity or establish legal enforceability by itself.

The audit UI should show what was verified, through which sequence, and when. A failed check
needs an investigation state: it might reflect changed data, serialization errors, or an
incomplete export. A green badge without a defined reference is not enough information to
call the record trustworthy.

The final download should reference every output document and its evidence manifest. The
original PDF remains a separately labeled file. A report assembled from two unbound event
queries or one arbitrary document name cannot reliably describe a multi-document completion.

## 🧯 Access and failure experience — 3 minutes

Sender sessions and signer invitations serve different users. I would exchange a scoped
invitation for a secure session, remove the credential from the visible URL, and enforce
live state on every write. A mere email-scanner GET should not consume the person's only
invitation.

The backend also applies the intended document-read policy. A signer no longer authorized to
act may or may not retain read access according to product rules, but that should be
explicit. A long-lived signed URL or public bucket can outlive the API's revocation
decision.

The UI needs distinct waiting, expired, withdrawn, already-finished, and PDF-failed states.
Offer recovery that fits each case. Redirecting an accountless signer to sender login does
not solve an expired invitation.

The signature modal needs focus management and a typed alternative to drawing.
Required-field errors should be announced and identify the field/page. A completion count
must compare required completed fields with required fields, while optional fields are shown
separately.

| Failure | Cross-stack behavior |
|---------|----------------------|
| Stale draft save | Server rejects revision; UI retains unsaved edit for review |
| Action timeout | Reconcile original operation without replacing the input |
| PDF load failure | Block review-ready state and offer retry |
| Broker unavailable | Keep outbox work, show dispatch delay |
| Artifact generation fails | Keep signing result, expose pending/failed output |
| Authorization changes | Reject writes server-side and refresh explanatory UI state |

## 🧪 Verification and scaling — 3 minutes

I would build contract checks around the complete path from session bootstrap to
authentication to field submission. A unit test of a valid type declaration would miss a
Redis object whose keys differ from the SQL shape expected by middleware.

| Test | What it proves |
|------|----------------|
| Editor placement through final output | One geometry convention across both runtimes |
| Session GET followed by field POST | Actual cached identity can authorize the assigned field |
| Concurrent identical operation | One recorded action with a matching receipt |
| Commit followed by lost response | Client recovers without inventing a second action |
| Edit racing send / finish racing void | Backend guard applies across all relevant routes |
| Worker receives actual published payload | Schema and envelope format match |
| Crash after publish | Redelivery does not repeat the business transition |
| Audit storage round trip and tail deletion | Canonical hashing and protected expected-head checks work |

The first performance bottleneck I expect is file handling. Bound parser concurrency, stream
authorized downloads where supported, and keep large files out of SQL locks. On the client,
bound canvas area and mounted pages, then measure input responsiveness during PDF rendering.

Sender lists need server pagination and reachable page controls. Status can start with
bounded polling while visible. If SSE becomes useful, use versioned invalidation and
snapshot recovery after reconnect rather than assuming every event arrives once and in
order.

Observe action acknowledgment latency, unresolved operations, stage-notification age,
artifact lag, and evidence-check failures. A dependency health endpoint cannot establish
that the worker consumed the right payload or that the signing ceremony succeeded.

## ⚖️ Trade-offs and local reality — 2 minutes

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Geometry | ✅ Shared document-space contract | ❌ Viewer pixels | Matches browser and final PDF |
| Operation recovery | ✅ Durable receipt and stable ID | ❌ Fresh retry requests | Resolves ambiguous outcomes |
| Workflow effects | ✅ Transactional outbox | ❌ Independent publication | Retains work across crashes |
| UI feedback | ✅ Separate recorded/ready states | ❌ One completion flag | Reflects asynchronous work accurately |
| Evidence | ✅ Canonical sequence and protected head | ❌ Local-only hash badge | Defines what verification actually covers |

The repository implements a React/Zustand interface and one Express API with SQL, Redis,
MinIO, and queue helpers. It has no shared runtime schemas, and its fixed-width viewers
store container pixels. The normal session cache uses the wrong identifier shape for signing
writes, while critical mutations lack atomic receipts and consistent workflow guards.

Its queue worker expects incompatible messages and tables, the audit writers disagree about
hash payloads, and no final signed artifact is generated. The sender notification path can
also fail after completion commits because it uses a user ID as a recipient foreign key.
These are documented in [architecture.md](./architecture.md), alongside the exact schema and
source paths.

> “The fullstack design succeeds when the interface and backend share precise meanings: this revision was reviewed, this action was recorded, and this artifact is ready. Those meanings guide the contracts, transaction boundaries, and recovery screens.”
