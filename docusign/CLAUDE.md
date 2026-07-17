# Design DocuSign — Development with Claude

## Project Context

An electronic-signature platform: a sender assembles an **envelope** (documents + recipients + fields), sends it, and recipients sign in a defined routing order, producing a tamper-evident record. The defining constraint is **legal correctness** — a signature must never be recorded twice on a retry, the audit trail must be provably un-tampered, and the envelope must move through its lifecycle in exactly one valid order. That pushes the interesting work into idempotency, a hash-chained audit log, and an explicit workflow state machine.

**Learning goals:** workflow state machines, tamper-evident hash-chain audit trails, idempotency for money-/legally-sensitive writes, multi-party routing, and S3-style object storage for documents.

## Architecture at a Glance (what actually runs)

Four backing services. Matches `docker-compose.yml` (postgres, valkey, minio, rabbitmq) and `backend/package.json`:

| Store | Client lib | Role | Why this one |
|-------|-----------|------|--------------|
| **PostgreSQL 16** | `pg` | Source of truth: users, envelopes, recipients, documents, `document_fields`, signatures, `audit_events`, `idempotency_keys`, templates, `email_notifications` | ACID — envelope transitions and signature capture run under `SELECT ... FOR UPDATE` so concurrent signing can't double-write |
| **Valkey (Redis)** | `redis` (node-redis) | Session tokens (cookie or Bearer) + signer signing-sessions + idempotency fast-path | Sub-ms auth checks; sessions shared across API instances |
| **MinIO** | `minio` | Object storage for uploaded PDFs and captured signature images (S3-compatible) | Runs locally, same API as S3 for production migration; MinIO calls are wrapped in a circuit breaker (`storageWithBreaker`) |
| **RabbitMQ** | `amqplib` | Async notification queue consumed by `workers/notification-worker.ts` | Sending the signing-request/reminder/completed emails off the request path; degrades to synchronous send if down |

Backend is a **single Express app** (default port **3001**), routes: `auth`, `envelopes`, `documents`, `fields`, `recipients`, `signing`, `audit`, `admin`. Services: `workflowEngine` (state machine), `auditService` (hash chain), `emailService` (simulated → rows in `email_notifications`). Frontend: React 19 + TanStack Router + Zustand + **react-pdf** (client-side PDF rendering) + **signature_pad** (draw signatures).

## Key Design Decisions

### 1. Explicit state machine over event sourcing/saga
`workflowEngine` enforces the envelope lifecycle `draft → sent → delivered → signed → completed` (plus `declined`, `voided`) with defined legal transitions, and advances recipients by `routing_order` (serial or parallel). Trade-off given up: event sourcing would give a perfect replayable history "for free," but an explicit machine maps directly to UI states and is far easier to reason about and test — and the audit hash-chain already provides the immutable history event sourcing would have given.

### 2. Hash-chain audit trail, not full blockchain
Every `audit_events` row stores the SHA-256 `hash` of its data plus the `previous_hash`, forming a chain; a verification pass recomputes the chain to detect any tampering. Trade-off: this gives tamper-*evidence*, not distributed consensus — a single actor who controls the DB could in principle recompute the whole chain. Accepted because for this scale the goal is provable integrity for disputes (ESIGN/eIDAS-style), and a real blockchain's consensus overhead buys nothing a trusted-operator + external timestamp wouldn't.

### 3. Idempotency keys + row locks so a signature is never double-recorded
Signing writes carry an idempotency key checked against `idempotency_keys` (Redis fast-path, Postgres as the durable backstop) and the field/envelope rows are locked with `SELECT ... FOR UPDATE`. Trade-off: an extra table, a cache lookup, and lock contention on hot envelopes — trivial next to the cost of being wrong. A network retry or double-click on "Sign" returns the original result instead of recording a second, legally-ambiguous signature.

### 4. Magic-link signer authentication (no signer accounts)
Recipients don't register; each gets a unique `access_token` embedded in their signing link, validated by `authenticateSigner` (Redis signing-session, then the `recipients.access_token` row). Trade-off: a leaked link grants access — the schema has an `access_code` column to add a shared-secret second factor, but it is captured, not yet *enforced* at signing time. Accepted because account-less signing matches how real e-signature flows reach external counterparties.

### 5. MinIO for documents and signatures, PDFs not flattened
Uploaded PDFs and signature images live in MinIO; on upload, pdf-lib validates the file and counts pages. Signatures are stored as separate image objects and rendered as **overlays** at stored page coordinates — the completed PDF does **not** embed the signatures (no flattening). Trade-off: a downloaded PDF isn't self-contained proof; the audit trail + stored signature objects are. Flattening with pdf-lib is the top future item.

## Current State

Working end to end: session auth (bcrypt, Redis-backed cookie/Bearer tokens, admin role); envelope CRUD and lifecycle transitions via the state machine; recipient management with routing order and per-recipient access tokens; PDF upload (pdf-lib validation + page count) to MinIO; field placement (signature/initial/date/text/checkbox at page coordinates); the signing ceremony with draw (signature_pad) and typed signatures, field-completion tracking, and idempotent signature capture under row locks; hash-chained audit events with a verification pass; simulated email notifications persisted to Postgres and dispatched via a RabbitMQ worker; admin and audit query routes. Production patterns implemented: Opossum circuit breaker (MinIO), prom-client metrics at `/metrics`, Pino logging, idempotency middleware.

Intentionally not built: PDF flattening/embedding, real email (SendGrid/SES), SMS/knowledge-based auth, access-code enforcement, a template-driven send flow (the `templates` table exists but has no API), bulk send, and real-time signing status over WebSocket.

## Iteration & Repair Log

- **Doc rewrite (2026-07):** the previous CLAUDE.md used banned "Phase 1–4" checklists and referenced `workflowEngine.js` / `auditService.js` — the code is TypeScript (`.ts`). Rewritten to the standard structure; the genuinely good decision notes (state machine, hash chain, MinIO) were kept and grounded in the code.
- **architecture.md drift corrected (2026-07):** it referenced **Elasticsearch** for audit search (eventual-consistency note + a failure-mode row) — there is no Elasticsearch in `docker-compose.yml`; those were removed (the "audit at scale" production-ideal note was left, clearly labeled aspirational). It also claimed page images are "rendered server-side and stored in S3" — rendering is **client-side** via react-pdf, and the `pdf2pic` dependency is unused; corrected.
- **README credential/path fixes (2026-07):** demo accounts said "(any password)", but login enforces bcrypt and the seed hash is the repo-normalized `password123` hash — updated to `password123`. The native-setup step pointed at `backend/db/init.sql`; the schema is at `backend/src/db/init.sql` — corrected.

## Open Questions

1. **Seed comment drift (can't fix here — non-.md):** `backend/db-seed/seed.sql` comments still say "password: admin123 / test123", but the stored hashes are the `password123` hash. The comments should be updated in a code pass.
2. **Access-code enforcement:** the column and capture exist but signer auth doesn't check it. Where should the second factor gate — before the signing session is minted, or per field-submit?
3. **PDF flattening:** completed envelopes don't produce a self-contained signed PDF. Is overlay-plus-audit-trail sufficient evidence, or does legal defensibility require embedding + a digital signature over the final bytes?
4. **Distributed locking:** row locks handle single-DB concurrency; if signing spans multiple API instances during a workflow advance, is `FOR UPDATE` on the envelope row enough, or is an advisory lock / queue needed?

## Resources

- [ESIGN Act](https://www.fdic.gov/resources/supervision-and-examinations/consumer-compliance-examination-manual/documents/10/x-3-1.pdf) and [eIDAS](https://digital-strategy.ec.europa.eu/en/policies/eidas-regulation) — the legal frameworks the audit trail targets
- [pdf-lib](https://pdf-lib.js.org/) — upload validation now; flattening later
- [react-pdf](https://react-pdf.org/) — client-side rendering + field overlays
