# DocuSign architecture

## System Overview

This learning project models an electronic signature envelope: a sender prepares documents and recipient fields, recipients review and complete their assigned actions, and the system records the resulting workflow. The design challenge is keeping document identity, recipient authority, recorded actions, and the final downloadable artifact consistent through retries and failures.

The production sections below are a proposal. The repository has one Express API, a React application, PostgreSQL, Valkey/Redis, MinIO, and an incompatible RabbitMQ worker. It does not implement the full production workflow or demonstrate legal compliance. The **Database Schema** reproduces the actual initialization SQL; the final **Implementation Notes** trace current behavior and defects to source. Setup and fixture instructions are in [README.md](./README.md).

## Requirements

### Functional requirements — production proposal

1. A sender uploads PDFs, places fields, assigns recipients to serial or parallel stages, and explicitly sends an immutable document revision.
2. Each signer reviews the exact revision, completes required fields, explicitly confirms their action, and can decline. Authority is checked again when recording an action.
3. Only the active signing stage may proceed. Completion, decline, expiration, and sender withdrawal have deterministic ordering under concurrency.
4. A sender can track workflow progress and delivery attempts. Participants can retrieve an authorized final artifact and its evidence manifest when generation succeeds.
5. Administrators can investigate failures through controlled access, with their actions recorded separately from participant actions.

Templates, collaborative editing, identity-provider integrations, payment collection, and offline submission are outside the initial production scope. Retention, consent language, and identity assurance must be specified for the intended product and jurisdiction; a hash chain alone does not establish those requirements.

### Non-functional requirements — proposed targets

| Requirement | Target and boundary |
|-------------|---------------------|
| Availability | 99.9% monthly for authenticated metadata reads and action submission within the home region; storage/provider outages tracked separately |
| API latency | p95 under 300 ms for small metadata operations; file transfer, parsing, and artifact generation have separate budgets |
| Recording correctness | One accepted effect per scoped operation ID, with immutable receipts; a timeout can leave the outcome unknown until reconciliation |
| Document identity | Every accepted field action identifies an immutable document revision, page geometry version, and input digest |
| Rendering | Usable first page within 2 seconds for an assumed 2 MiB ordinary PDF on the agreed reference device/network; measure larger/scanned documents separately |
| Artifact readiness | p95 under 60 seconds after all signers finish for bounded documents; workflow completion and artifact availability are distinct |
| Recovery | Acknowledgment requires the selected database replication policy; cross-region RPO/RTO are explicit deployment choices, not implied by an object store |

These are design objectives, not measurements of this repository.

## Capacity Estimation

Assume 100,000 envelopes/day, three recipients per envelope, two 2 MiB documents per envelope, and three recorded field actions per recipient. Use a tenfold daily-average peak for an initial estimate, then validate actual business-hour and batch-send bursts.

| Item | Calculation | Implication |
|------|-------------|-------------|
| Envelope creation | 100,000 / 86,400 ≈ 1.16/s average; 11.6/s assumed peak | No immediate reason to shard workflow metadata |
| Field writes | 900,000/day ≈ 10.4/s average; 104/s assumed peak | Short SQL transactions are practical; contention is per envelope |
| Original bytes | 100,000 × 2 × 2 MiB ≈ 391 GiB/day | Object transfer/storage dominates request counts |
| One year of originals | About 139 TiB before replication, artifacts, versions, and overhead | Retention policy and storage class affect cost substantially |
| Audit events | Assume 30/envelope: 3 million/day | Approximately 2.9 GiB/day at 1 KiB/event, excluding indexes/replicas |
| Signature images | 900,000 × 20 KiB ≈ 17.2 GiB/day if every action were an image | An upper planning scenario; dates/text are smaller |

### Local Development Scale

One API and one browser are enough for fixture inspection. Compose supplies four backing services but no API/frontend container. Each API process permits up to 20 PostgreSQL connections. A 25 MiB upload is buffered and parsed inside the API, so concurrency multiplies memory consumption. The repository has no measured memory budget or load benchmark; running three APIs does not prove ordered workflow behavior.

## High-Level Architecture

Production proposal: one home region owns mutations for each envelope. Boxes represent responsibilities that can begin as modules; drawing a box does not require an independently deployed service.

```
┌───────────────────┐     ┌────────────────────┐
│ Sender and signer │────▶│ Edge / API gateway │
│ browser clients   │     │ Auth, admission    │
└───────────────────┘     └────────────────────┘
                                   │
                                   ▼
                          ┌────────────────────┐
                          │ Envelope authority │
                          │ Fields and stages  │
                          └────────────────────┘
                              │           │
                              ▼           ▼
                    ┌──────────────┐  ┌──────────────┐
                    │ PostgreSQL   │  │ Private      │
                    │ State, audit │  │ object store │
                    │ Receipts,    │  │ Immutable    │
                    │ outbox       │  │ versions     │
                    └──────────────┘  └──────────────┘
                           │                  ▲
                           ▼                  │
                    ┌──────────────┐  ┌───────────────┐
                    │ Outbox relay │─▶│ Queue workers │
                    │ Confirmed    │  │ PDF/evidence  │
                    │ publication  │  │ Notifications │
                    └──────────────┘  └───────────────┘
```

Static application assets can use a CDN. Document bytes require authorized, version-bound delivery through a private storage gateway or narrowly scoped signed URLs. Email delivery and artifact generation are asynchronous; neither sits inside a workflow database lock. A protected evidence archive receives canonical records and signed checkpoints through retryable jobs.

## Core Components / Request Flows

### Prepare and send

The document component validates upload size/type, quarantines and parses the PDF under resource limits, and records its object version, digest, page boxes, and rotation. The sender edits a draft revision with optimistic version checks. A send transaction locks the envelope, verifies that documents are ready and recipients/fields belong to that revision, freezes the revision, activates the first stage, and records audit, receipt, and outbox rows together.

Every draft mutation must acquire the same envelope guard or compare its draft version inside that transaction. Locking only the send method leaves a concurrent field update free to commit after the supposedly frozen snapshot. File uploads happen before the transaction; unattached objects need delayed cleanup that cannot delete a newly attached object.

**Local mapping:** uploads use `pdf-lib` synchronously and a 25 MiB Multer memory buffer. There is no quarantine job, object digest, geometry metadata, or immutable revision. The send method locks an envelope, while validation reads use the general pool and other draft routes do not participate in that lock protocol.

### Open, review, and record an action

A proposed token exchange validates the invite and creates a narrowly scoped signer session. Possession of an email link is an authentication signal, not proof of a person's identity. The session response identifies the recipient, envelope revision, available actions, and all assigned fields. The backend checks live workflow authority again on every write; a cached status or disabled button cannot authorize a signature.

A signature image is staged under a new immutable object key and its bytes are validated. A short SQL transaction checks the current envelope/stage, claims the operation ID, locks the relevant field, references the staged object digest, records the action and audit event, and commits the receipt. The server returns success only for the recorded action. Required-field completion does not automatically imply that the recipient has confirmed Finish.

**Local mapping:** the UI waits for an HTTP success before adding a checkmark, but sends no stable operation key. Session GET writes a camelcase Redis shape while authentication expects database column names. The resulting ordinary field submission fails ownership validation. Under the database fallback path, signing still lacks a transaction, field lock, uniqueness constraint, revision binding, and stage/expiration checks.

### Finish and advance stages

In the proposal, Finish serializes on the envelope and rechecks required values and the active stage. All signers sharing a stage may record independent field actions, but the short stage-advancement transaction decides once whether the next stage becomes active. Observers do not block a signer quorum; in-person signing requires its own expressly modeled authority if later added. The transaction appends notification and artifact jobs to the outbox.

A competing Void and Finish is ordered by the same authority. If Void commits first, Finish is rejected; if all signatures are committed first, withdrawal follows the product's explicit terminal-state rule. The client presents the committed outcome, including after an ambiguous timeout.

**Local mapping:** completion, decline, and void use separate unconditional updates. Selecting the next notification group filters `role = 'signer'`, but checking completion of its siblings includes every role, which can stall progress. All recipients receive tokens at send time; later-stage tokens are not prevented from authorizing an action.

### Generate the final artifact and notify

A proposed artifact job consumes the frozen revision, accepted field values/signature digests, and a specified audit sequence. It creates an output under a new immutable object key, verifies its digest, then conditionally marks the artifact ready for that generation ID. Duplicate workers cannot replace a newer generation. A downloadable manifest identifies every original and final document, accepted actions, canonical event hashes, and the protected checkpoint used to verify completeness.

Notify participants only when the relevant artifact is available. Track queued, provider-accepted, delivered/bounced, and artifact-ready independently. An email provider accepting a request is not proof that the recipient received or read it.

**Local mapping:** there is no flattening or artifact worker. Completion emails point to a frontend download route that does not exist. The certificate API creates a JSON report and verification boolean, selects one document name from an unordered join, and reads events and verification in separate queries.

## Database Schema

The following is the complete checked-in [initialization schema](./backend/src/db/init.sql), not a proposed migration. Comments such as “append-only” are labels: the SQL does not enforce append-only access. The final seed-path comment is stale; the real seed is [seed-envelopes.ts](./backend/src/db/seed-envelopes.ts).

```sql
-- DocuSign Database Schema

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(200) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(30) DEFAULT 'user', -- 'user', 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions table
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token VARCHAR(255) UNIQUE NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Envelopes (signing packages)
CREATE TABLE envelopes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  status VARCHAR(30) DEFAULT 'draft', -- 'draft', 'sent', 'delivered', 'signed', 'declined', 'voided', 'completed'
  authentication_level VARCHAR(30) DEFAULT 'email', -- 'email', 'sms', 'knowledge', 'id_verification'
  message TEXT,
  expiration_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Recipients
CREATE TABLE recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL,
  role VARCHAR(50) DEFAULT 'signer', -- 'signer', 'cc', 'in_person'
  routing_order INTEGER DEFAULT 1,
  status VARCHAR(30) DEFAULT 'pending', -- 'pending', 'sent', 'delivered', 'completed', 'declined'
  access_token VARCHAR(255) UNIQUE,
  access_code VARCHAR(100),
  phone VARCHAR(50),
  ip_address VARCHAR(50),
  user_agent TEXT,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  page_count INTEGER,
  s3_key VARCHAR(500) NOT NULL,
  status VARCHAR(30) DEFAULT 'processing', -- 'processing', 'ready', 'error'
  file_size INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Document Fields
CREATE TABLE document_fields (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL, -- 'signature', 'initial', 'date', 'text', 'checkbox'
  page_number INTEGER NOT NULL,
  x DECIMAL NOT NULL,
  y DECIMAL NOT NULL,
  width DECIMAL NOT NULL,
  height DECIMAL NOT NULL,
  required BOOLEAN DEFAULT TRUE,
  completed BOOLEAN DEFAULT FALSE,
  value TEXT,
  signature_id UUID,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Signatures
CREATE TABLE signatures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
  field_id UUID REFERENCES document_fields(id) ON DELETE CASCADE,
  s3_key VARCHAR(500) NOT NULL,
  type VARCHAR(30) NOT NULL, -- 'draw', 'typed', 'upload'
  ip_address VARCHAR(50),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Add foreign key for signature_id in document_fields
ALTER TABLE document_fields
ADD CONSTRAINT fk_signature
FOREIGN KEY (signature_id) REFERENCES signatures(id);

-- Audit Events (append-only)
CREATE TABLE audit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  data JSONB,
  timestamp TIMESTAMP NOT NULL,
  actor VARCHAR(100),
  previous_hash VARCHAR(64) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Email notifications (simulated)
CREATE TABLE email_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL, -- 'signing_request', 'reminder', 'completed', 'declined', 'voided'
  subject VARCHAR(255),
  body TEXT,
  status VARCHAR(30) DEFAULT 'pending', -- 'pending', 'sent', 'failed'
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Templates
CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  document_s3_key VARCHAR(500),
  fields JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Idempotency keys for preventing duplicate operations
-- Critical for legal document signing to prevent double-signing
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for cleaning up old idempotency keys
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);

-- Indexes
CREATE INDEX idx_envelopes_sender ON envelopes(sender_id);
CREATE INDEX idx_envelopes_status ON envelopes(status);
CREATE INDEX idx_recipients_envelope ON recipients(envelope_id);
CREATE INDEX idx_recipients_email ON recipients(email);
CREATE INDEX idx_recipients_token ON recipients(access_token);
CREATE INDEX idx_documents_envelope ON documents(envelope_id);
CREATE INDEX idx_fields_document ON document_fields(document_id);
CREATE INDEX idx_fields_recipient ON document_fields(recipient_id);
CREATE INDEX idx_audit_envelope ON audit_events(envelope_id, timestamp);
CREATE INDEX idx_audit_type ON audit_events(event_type);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Seed data is in db-seed/seed.sql
```

The proposed production design needs additional schema work: document/revision digests and page geometry, envelope versions and explicit stages, unique accepted field actions, scoped operation IDs with request digests and immutable responses, per-envelope audit sequence/head, transactional outbox/consumer receipts, and separately versioned artifact records. It also needs stronger NOT NULL, enum/range, and same-envelope constraints. None of those additions should be inferred from the SQL above.

The local `sessions` and `templates` tables have no active corresponding persistence/API flow. Authentication uses Redis. `signatures.field_id` is not unique, `recipient_id` and `document_id` can reference different envelopes, and timestamp ordering does not provide a unique audit sequence. `DECIMAL` geometry can arrive from PostgreSQL as strings; the viewer's `toPx` helper converts it to a CSS number, not to a normalized coordinate.

## API Design

Actual paths use `/api/v1`. This table summarizes the wire surface; permissions still have the implementation gaps listed below. In contrast, the operation/status, token-exchange, artifact, and revision APIs described in the production flows are proposed additions.

| Method | Path after `/api/v1` | Purpose / authority |
|--------|----------------------|---------------------|
| POST | `/auth/register`, `/auth/login`, `/auth/logout` | Account/session operations |
| GET | `/auth/me` | Current authenticated user |
| PUT | `/auth/password` | Change password; existing sessions are not revoked |
| GET / POST | `/envelopes` | Sender's paginated list / new draft |
| GET / PUT / DELETE | `/envelopes/:id` | Sender detail / draft edits / draft deletion |
| POST | `/envelopes/:id/send`, `/envelopes/:id/void` | Sender lifecycle actions |
| GET | `/envelopes/stats/summary` | Sender counters |
| POST | `/documents/upload/:envelopeId` | Multipart field `document`, PDF up to 25 MiB |
| GET | `/documents/:id`, `/documents/:id/view`, `/documents/:id/download` | Metadata with presigned URL / original bytes |
| GET / DELETE | `/documents/envelope/:envelopeId` / `/documents/:id` | List / delete draft document metadata |
| POST | `/recipients/:envelopeId` | Add recipient to draft |
| GET | `/recipients/envelope/:envelopeId` | List recipients |
| PUT / DELETE | `/recipients/:id` | Change / remove recipient |
| POST | `/recipients/envelope/:envelopeId/reorder` | Sequential draft order updates |
| POST | `/fields/:documentId`, `/fields/bulk/:documentId` | Add one or several draft fields |
| GET / PUT / DELETE | `/fields/document/:documentId` / `/fields/:id` / `/fields/:id` | List / change / remove fields |
| GET | `/signing/session/:accessToken` | Token session bootstrap; currently caches incompatible identifier names |
| GET | `/signing/document/:accessToken/:documentId` | Token-scoped original PDF; no lifecycle/expiration check here |
| POST | `/signing/sign/:accessToken`, `/signing/complete-field/:accessToken` | Image capture / non-signature field completion |
| POST | `/signing/finish/:accessToken`, `/signing/decline/:accessToken` | Recipient decision |
| GET | `/signing/signature-image/:signatureId/:accessToken` | Presigned image URL after signer middleware |
| GET | `/audit/envelope/:id`, `/audit/verify/:id`, `/audit/certificate/:id` | Sender audit data / check / completed-envelope JSON certificate |
| GET | `/audit/public/verify` | Unauthenticated envelope/hash lookup exposing selected workflow/participant data |
| GET | `/admin/stats`, `/admin/users`, `/admin/envelopes`, `/admin/envelopes/:id`, `/admin/emails`, `/admin/emails/envelope/:id` | Administrator data |
| PUT / DELETE | `/admin/users/:id/role` / `/admin/users/:id` | Administrator user management |

For example, the actual single-field POST accepts `recipientId`, `type`, `pageNumber`, `x`, `y`, optional `width`/`height`, and `required`; it returns `{ field }`. These values are viewer pixels. The signing POST accepts `fieldId`, `signatureData`, and `type`. Responses are route-specific objects and `{ error }` failures, not a shared validated envelope. The JSON body limit is 50 MB as configured in Express, separate from the multipart PDF limit.

## Key Design Decisions

### Serialize workflow authority, then dispatch effects

Choose short PostgreSQL transactions on the envelope aggregate. At the assumed peak, a few hundred small writes per second are manageable without distributing an individual envelope's authority. A last-signer race and a concurrent sender withdrawal become ordered decisions rather than independently emitted events that need compensation after acceptance.

An event-driven implementation can still use a state machine, but independently updating state and publishing notifications creates a concrete crash gap: the state commits, the process dies, and the next signer is never invited. A transactional outbox closes that gap for job creation; a relay publishes confirmed messages and may deliver duplicates. The costs are outbox lag, cleanup, and consumer deduplication. Avoid making the signing request wait for email or PDF generation.

### Use one geometry contract for authoring, viewing, and output

Choose a versioned page coordinate convention and use the PDF viewport transform in both directions. For example, store rectangles in the immutable PDF page's native coordinates, with the page box, rotation, and user-unit interpretation supplied by its parser. Convert pointer coordinates relative to the rendered page, not its padded container. Convert a rectangle using its corners so rotation is handled correctly.

Plain CSS pixels match only the original layout. Normalized top-left fractions also work if the normalized page view, rotation, and crop-box semantics are specified; they are not inherently more correct than PDF coordinates. CSS display size and canvas device-pixel ratio are different inputs. [PDF.js's rendering example](https://mozilla.github.io/pdf.js/examples/) illustrates viewport transforms and separate output scaling. Choosing the native-page contract costs transform testing but allows the final artifact renderer to reproduce the placement.

### Bind evidence to immutable content and an independent reference

A per-envelope hash chain can expose accidental changes only if its payload encoding, sequence, and expected head are trustworthy. Serialize a canonical, versioned payload containing actor, action, document/field revision, image/value digests, consent version, and authoritative recording time. Append under the same transaction/sequence guard as the business event.

A chain stored beside mutable application data can be rewritten or truncated with that data. Export signed checkpoints containing the expected sequence count and head digest to separately controlled storage, and retain verification keys and serialization versions. This adds operational and key-management costs; a signature image or a green hash badge alone cannot substitute for those controls. It also does not by itself prove the person's identity or legal enforceability.

## Consistency and Idempotency

The production operation key is scoped to actor/session, envelope revision, action, and operation ID. Associate it with a request digest; reusing a key with different input is a conflict. A unique receipt and the business mutation commit together. A repeated operation returns its stored result, while a different operation racing for an already completed field returns a meaningful conflict that the client reconciles. Never treat every HTTP 409 as success.

A staged object upload cannot share the SQL transaction. Use immutable object keys, validate the stored content before accepting its reference, and collect unattached objects after a safe retention window. A provider or object-store timeout may mean the side effect occurred; use known object IDs or provider receipts to reconcile instead of blindly issuing a new logical action.

The current [idempotency helper](./backend/src/shared/idempotency.ts) performs Redis lookup, SQL lookup, the operation, and independent cache/SQL receipt writes. There is no atomic reservation or payload/actor binding. Redis failures skip SQL lookup because both are inside one try block; failures warming Redis also discard a SQL hit. Concurrent checks can both miss and execute. Generated keys include the current hour, while cache/lookup retention is 24 hours; those are different concepts. SQL `ON CONFLICT DO NOTHING` can retain an old response while Redis is overwritten, and old rows are not automatically cleaned up.

The signature route checks field completion before looking for a receipt, so a normal replay can return 400 before it reaches a previously stored result. The middleware-generated key is assigned to the request but the critical routes use a header or their own generated keys. The frontend sends neither a stable key nor a revision. None of these paths provides an end-to-end exactly-once guarantee.

## Security / Auth

Production controls include secure sender sessions, expiring and revocable signer invitations, live authorization on every action, upload resource limits, private versioned objects, and actor-scoped administrative permissions. Rate limits belong at the edge and expensive parsing/signing endpoints. Remove invite credentials from logs and referrers; a proposed token exchange should not consume the only usable invitation merely because an email scanner fetched a URL.

Local sender authentication uses bcrypt and a Redis session lasting 24 hours. Cookies are HttpOnly, SameSite=Lax, and secure only under `NODE_ENV=production`; login/register responses also include the token. User roles are loaded from SQL on authenticated requests. Recipient access tokens are separate from account sessions and remain in URLs and database rows. SMS helpers and authentication-level fields have no active verification flow. No rate limiter, request-schema validation layer, invite expiration enforcement, or document security review is implemented.

A draft field's single-create route checks type, page range, sender, and recipient-envelope membership. Updates omit some type/page checks; bulk inserts omit recipient-envelope/type/page validation and run sequentially without a transaction. Sender draft checks race with sending. Signing accepts an image on field types beyond signatures, and non-signature completion validates completion flags more strongly than actual required values. These are authority/validation gaps, not UI features.

Compose grants anonymous object download. The signer PDF route checks token membership but not current envelope state, so withdrawing an envelope is not equivalent to revoking byte access. Public audit lookup exposes the envelope name/status, participant names, partially masked emails, and times; it is not document-byte verification. Logs can contain full token paths. PDF.js and a browser worker are parsing mechanisms, not an assurance that arbitrary uploads are harmless.

## Observability

The API exposes `/metrics`, `/health`, `/health/live`, and `/health/ready`. [metrics.ts](./backend/src/shared/metrics.ts) registers HTTP, signature, envelope, audit, idempotency, storage-breaker, and database/queue gauges; [logger.ts](./backend/src/shared/logger.ts) supplies Pino request and audit children. Instrumentation is partial: the shared audit helper increments counters while the other writer does not, storage wrapper duration timers finish on success only, and route labels can fall back to raw paths. Dashboard totals and background gauges are not one consistent snapshot.

The comprehensive health endpoint probes SQL, Redis, MinIO, and queue state. Readiness checks only SQL and Redis. The MinIO probe treats a non-throwing `bucketExists` result as healthy even if false. Queue health is based partly on stored channel references, which can survive a failed/closed connection; queue-detail errors can be reported as null under a connected status. Startup logs “RabbitMQ connected” even when queue initialization returned false. Thus green health is not a test of signing or email delivery.

Production metrics should follow outcomes: accepted actions, unknown outcomes resolved, authorization rejections, oldest outbox age, notification provider receipt age, artifact-generation lag, and evidence verification failures. Use aggregate labels, with restricted access to detailed event records. Alert on work age and stuck states, not only process liveness.

## Failure Handling

| Failure | Proposed behavior | Current implementation |
|---------|-------------------|------------------------|
| Timeout after action commit | Query/replay scoped receipt | UI gets generic error; receipt may be absent despite state changes |
| Object storage unavailable | Bound the call, preserve user input, reconcile staged upload | Only signature upload/image URL use wired breakers; document routes call raw helpers |
| Redis unavailable | Reject session-dependent actions; read durable operation receipts where appropriate | Required user sessions fail; idempotency helper treats failure as a miss |
| Broker unavailable | SQL outbox retains jobs for retry | Startup continues; selected notifications synchronously simulate email |
| Worker crash or poison message | Durable retry, consumer receipt, verified quarantine routing | Payload/schema mismatch; direct worker nacks without requeue |
| Concurrent finish/void | One guarded transition wins | Separate updates can produce inconsistent terminal states or duplicate notifications |
| Audit append fails | Roll back the business transaction | One writer throws after effects; the shared writer logs and returns null |
| Process shutdown | Stop admission and drain bounded work | API signal handler exits immediately |

Registered Opossum storage breakers have 50% error thresholds, a 30-second reset, and minimum volume five; wrapper-specific timeouts range from 5 to 30 seconds. Only signature upload and signature URL retrieval are imported by signing routes. No fallback queues uploads or serves cached documents. A breaker timeout does not cancel an already initiated storage write.

## Scalability Considerations

At the stated envelope rate, start with one regional PostgreSQL authority and stateless API replicas. Keep uploads and parsing out of locks, bound file-processing concurrency, and deliver bytes from authorized object storage. Add indexes/pagination based on observed access patterns before sharding. A global sender with a very large recipient list needs product limits, not an unbounded transaction.

Partition audit history and outbox maintenance by time while preserving per-envelope sequence. Retention must consider original objects, generated artifacts, signatures, event manifests, receipts, and verification material together. Removing a metadata row is not an object-deletion policy. Cross-region failover must fence the old writer and specify which acknowledgments remain durable before accepting new mutations.

On the browser, render one page or a small visible window, keep the field checklist independent of mounted pages, and bound canvas pixel area. Backend list pagination and frontend pagination controls are separate work: the current UI discards list pagination metadata. Sender status updates can begin with bounded visible-page polling; use SSE only if measured freshness needs justify connection management and resynchronization.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Workflow authority | Short per-envelope SQL transactions | Independently updated lifecycle events | Orders finish, withdrawal, and stage activation |
| Side effects | Transactional outbox and duplicate-safe workers | Publish after a state commit | Retains work across a process crash |
| Geometry | Versioned PDF-page coordinates | Viewer-container pixels | Reproduces placement across devices and final output |
| Action retries | Scoped durable receipt plus request digest | Redis response cache alone | Binds a retry to one authorized operation |
| Evidence | Canonical chain plus protected signed checkpoints | Mutable database chain alone | Provides an external reference for rewrite/truncation checks |
| Completion display | Separate accepted actions and artifact readiness | One success flag for everything | Makes asynchronous failure understandable |

## Implementation Notes

### Patterns present, with their actual boundaries

The local path is React on Vite → Express routes → PostgreSQL/Redis/MinIO, with RabbitMQ publication attempted from workflow methods. There are no separately deployed document, signing, or audit services. [index.ts](./backend/src/index.ts) owns all API routes. [workflowEngine.ts](./backend/src/services/workflowEngine.ts) and [auditService.ts](./backend/src/services/auditService.ts) are modules in that process.

- **Transactional send:** `sendEnvelope` uses `BEGIN` and `SELECT ... FOR UPDATE` for the envelope. This demonstrates serialization of competing sends, but validation queries and other edits do not share its transaction. Audit and notification work occurs after commit, so an error can follow a successful state change.
- **Idempotency cache:** [shared/idempotency.ts](./backend/src/shared/idempotency.ts) caches receipts in Redis and SQL. It illustrates response replay, not an atomic decision protocol; the specific races are described above.
- **Circuit breakers:** [shared/storageWithBreaker.ts](./backend/src/shared/storageWithBreaker.ts) wraps MinIO calls through [circuitBreaker.ts](./backend/src/shared/circuitBreaker.ts). The active signature upload uses `await uploadSignature(s3Key, signatureBuffer, 'image/png')`; the original-PDF upload/view/download routes use [utils/minio.ts](./backend/src/utils/minio.ts) directly.
- **Metrics and logging:** [shared/metrics.ts](./backend/src/shared/metrics.ts) and [shared/logger.ts](./backend/src/shared/logger.ts) provide Prometheus/Pino patterns. They help diagnose requests and selected storage calls; they do not certify business outcomes or prevent secrets in paths from reaching logs.
- **Publisher confirmation:** [shared/queue.ts](./backend/src/shared/queue.ts) publishes persistent wrapped messages on a confirm channel. This demonstrates broker acknowledgment, without a database outbox, mandatory-route handling, or end-to-end delivery receipt.

### Confirmed signing and completion defects

[Session GET](./backend/src/routes/signing.ts) stores `{ recipientId, envelopeId, envelope_status, status }`. [authenticateSigner](./backend/src/middleware/auth.ts) uses the cached object as a `SignerData` whose downstream consumers read `id` and `envelope_id`. An isolated execution of the actual route/middleware sequence returns 403 for the correctly assigned field. Finish and decline can subsequently operate on undefined IDs and fail; the cache is not invalidated on transitions. Fixing the shape alone would still leave stale authorization and the missing stage/expiration guards.

`completeEnvelope` writes `completed`, then notifies recipients and the sender. It passes the sender's **user ID** into `email_notifications.recipient_id`, which references **recipients**. With ordinary distinct IDs, this fails after the status update. The isolated check confirmed that ordering and identifier use; no transaction rolls back the already committed state. The fixture's completed envelope does not exercise this path.

### Audit implementation is internally inconsistent

[shared/auditLogger.ts](./backend/src/shared/auditLogger.ts) hashes a separate `context` property but stores context inside `data`. Its verifier reconstructs the stored `data` including that context and also supplies a separate context, producing a different hash. The service writer uses another payload format without that separate property; many signing/workflow events call both writers. An isolated test rejected one unchanged shared event using both verifiers.

The service hash omits actor and depends on ordinary object-key insertion order. PostgreSQL [JSONB does not preserve object-key order](https://www.postgresql.org/docs/current/datatype-json.html); reserializing database JSON is therefore not a canonical hashing scheme. Timestamps are stored without a timezone contract, ordering has no tie-break sequence, and both writers fetch the previous head without a lock. These defects can create a failed verification without tampering. Conversely, mutable rows and no externally protected expected head permit rewrites/truncation to evade a local-only check. Hardcoded consent text in audit metadata is not an implemented consent collection flow.

### Queue and email limitations

The actual exchanges are direct `docusign.direct` and direct `docusign.dlx`. Four durable queues handle notifications, email, workflow, and reminders. The DLQ binds with an empty routing key, while dead letters retain nonempty original routing keys unless overridden. Under the supplied topology they will not reach that binding; this follows [RabbitMQ's dead-letter routing rules](https://www.rabbitmq.com/docs/dlx).

The [worker](./backend/src/workers/notification-worker.ts) consumes bare payloads, while the publisher sends `{ id, type, data, timestamp, idempotencyKey }`. It also queries absent `notifications`, `email_log`, and `workflow_events` tables, uses a nonexistent `recipients.user_id`, and expects different event names. It defaults to guest credentials and needs API-created queues. Exporting the correct broker URL only fixes the credential mismatch. Prefetch is ten; errors nack without requeue, and reminder handling does not wait for `scheduledFor`.

The exported `createConsumer` helper is not used by that worker. Its retries nack first, then use process timers and unconfirmed republishing; a crash can lose work. Queue reference checks do not reconnect closed channels. No fanout exchange, PDF queue, consumed-message deduplication, or reliable delayed-reminder scheduler is wired.

[EmailService](./backend/src/services/emailService.ts) only inserts simulated records and prints part of their bodies. A queued notification and a simulated `sent` row are different paths, neither an actual email delivery. Completion links refer to a missing frontend route. No signed PDF or PDF certificate generation is present.

### Frontend and local substitutions

[envelopeStore.ts](./frontend/src/stores/envelopeStore.ts) holds server responses in Zustand and updates after success. It has one loading/error state, no cancellation or request generation, and late fetches can overwrite a newer envelope. Several pages omit store errors, yielding stale content, an empty list, or an indefinite spinner. Lists request only their first page; there is no polling, SSE, React Query, shared runtime validation, or offline persistence.

[Envelope detail](./frontend/src/routes/envelopes/$envelopeId.tsx) saves each placement click immediately using the container's pointer offset. Both viewers render a 700-pixel page; [format.ts](./frontend/src/utils/format.ts) merely converts SQL numeric strings. Centered canvas offsets, different container widths, crop/rotation, and responsive scaling are not modeled. Changing/deleting documents can also leave a selected index/page stale. There is no drag, resize, zoom, or upload progress UI.

[SigningPage](./frontend/src/routes/sign/$accessToken.tsx) keeps completed IDs in a component Set, waits for successful writes, and displays a checkmark. It does not render captured images or field values, bind responses to a request generation, gate Finish on PDF render success, or disable concurrent submissions. Optional completed fields inflate the numerator relative to required-field count. Signature capture offers drawing and typing only; modal focus/keyboard behavior and canvas display scaling are incomplete. CSS hides PDF text and annotation layers, and clickable field divs lack keyboard controls.

MinIO substitutes for private production object storage, Redis holds simple sessions, and email is simulated. Compose starts infrastructure with persistent volumes but no production backup/restore plan. Metadata deletion does not remove stored objects. Seed PDFs and completion flags are illustrative data. Local commands and current credentials are maintained in the README.

### Omitted production capabilities and verification scope

No immutable revision/manifest, safe operation receipt transaction, outbox, compatible notification worker, final signed artifact, enforceable retention, independent evidence anchor, MFA flow, rate limiting, distributed workflow fencing, CDN document authorization, or multi-region recovery is implemented. This review changed documentation only. Isolated mocked source checks confirmed the signing cache, audit, idempotency, and sender-notification defects; no full application run or production performance/compliance claim follows from those checks.
