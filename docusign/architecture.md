# Design DocuSign - Architecture

## System Overview

An electronic signature platform with document workflow automation. Core challenges involve document processing pipelines, workflow state machine orchestration, tamper-proof audit trails for legal compliance, and multi-party signing flows with configurable routing orders.

**Learning Goals:**
- Build document processing pipelines
- Design workflow state machines
- Implement tamper-proof audit trails
- Handle multi-party signing flows

## Requirements

### Functional Requirements

1. **Upload**: Upload PDF documents for signing
2. **Prepare**: Add signature fields (signature, initial, date, text, checkbox) and assign recipients
3. **Route**: Send to recipients in configurable order (serial or parallel)
4. **Sign**: Capture legally binding electronic signatures (draw, type, upload)
5. **Complete**: Generate signed document with audit trail and certificate of completion

### Non-Functional Requirements

- **Availability**: 99.99% for signing ceremonies (users may have legal deadlines)
- **Durability**: Documents stored for 10+ years with tamper-evidence
- **Compliance**: ESIGN Act, UETA, eIDAS compliant
- **Security**: End-to-end encryption, SOC 2 compliant
- **Consistency**: Strong consistency for state transitions; no double-signing
- **Latency**: Signature capture < 500ms p99; document rendering < 2s

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Client Layer                                  │
│           Web App │ Mobile App │ API Integration                     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       API Gateway                                    │
│               (Auth, Rate Limiting, TLS, WAF)                        │
└──────────────────────────────┬──────────────────────────────────────┘
              │                │                │
              ▼                ▼                ▼
   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
   │ Document Service │ │ Workflow Engine  │ │ Signing Service  │
   │                  │ │                  │ │                  │
   │ - PDF processing │ │ - State machine  │ │ - Capture sigs   │
   │ - Field placement│ │ - Routing logic  │ │ - Verify ID      │
   │ - Templates      │ │ - Reminders      │ │ - Audit logging  │
   │ - Page rendering │ │ - Notifications  │ │ - Idempotency    │
   └────────┬─────────┘ └────────┬─────────┘ └────────┬─────────┘
            │                    │                    │
            └────────────────────┼────────────────────┘
                                 │
    ┌───────────────┬────────────┼────────────┬───────────────┐
    ▼               ▼            ▼            ▼               ▼
┌────────┐   ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐
│Postgres│   │  Redis    │  │RabbitMQ │  │   S3     │  │Elastic   │
│        │   │           │  │         │  │          │  │search    │
│- Envlps│   │- Sessions │  │- Workflw│  │- Docs    │  │- Audit   │
│- Recips│   │- Idemptncy│  │- Notifs │  │- Sigs    │  │  logs    │
│- Fields│   │- Cache    │  │- Email  │  │- Certs   │  │- Search  │
│- Audit │   │           │  │- PDF    │  │          │  │          │
│- Idemp │   │           │  │- DLQ    │  │          │  │          │
└────────┘   └──────────┘  └─────────┘  └──────────┘  └──────────┘
```

## Core Components

### 1. Document Processing

The document pipeline handles PDF upload, validation, page image rendering for the field placement UI, and field coordinate storage. Documents are validated using pdf-lib to verify PDF integrity before storage. Page images are rendered server-side and stored in S3 for the web-based field placement interface.

Field types include signature, initial, date, text, and checkbox. Each field is positioned at specific coordinates on a page and assigned to a recipient. Required fields must be completed before a recipient can finish their signing session.

### 2. Workflow Engine (State Machine)

The envelope lifecycle follows an explicit state machine with defined transitions:

```
                 ┌──────────────────────────────┐
                 │           draft               │
                 └──────┬──────────────┬─────────┘
                        │              │
                        ▼              ▼
                 ┌──────────┐    ┌──────────┐
                 │   sent   │    │  voided  │
                 └─────┬────┘    └──────────┘
                       │
                       ▼
                 ┌──────────┐
                 │ delivered│
                 └──┬───┬───┘
                    │   │
                    ▼   ▼
            ┌────────┐ ┌─────────┐
            │ signed │ │declined │
            └───┬────┘ └─────────┘
                │
                ▼
            ┌──────────┐
            │completed │
            └──────────┘
```

**State transitions:**
- `draft` -> `sent`, `voided`
- `sent` -> `delivered`, `voided`
- `delivered` -> `signed`, `declined`, `voided`
- `signed` -> `completed`
- `declined`, `voided`, `completed` -> (terminal states)

**Routing logic**: Recipients are ordered by `routing_order`. All recipients at the same routing order sign in parallel. When all recipients at one order complete, the next group is notified. When all signers complete, the envelope transitions to `completed`.

### 3. Signature Capture

Electronic signatures support three capture modes:
- **Draw**: Canvas-based freehand drawing using `signature_pad` library
- **Type**: Text rendered to canvas with cursive font
- **Upload**: User uploads a signature image

All modes produce base64-encoded PNG images stored in a separate S3 bucket with encryption. Each signature is linked to a specific field and recipient, with full audit trail recording IP address, user agent, and timestamp.

### 4. Tamper-Proof Audit Trail (Hash Chain)

Every envelope action is recorded as an append-only audit event with a cryptographic hash chain. Each event includes a SHA-256 hash of its contents plus the hash of the previous event, forming a blockchain-like structure that makes any tampering immediately detectable.

Chain verification walks the entire event history, recalculating hashes and verifying each link. A valid chain proves no events were inserted, deleted, or modified after the fact.

This provides the evidence trail required by ESIGN Act, UETA, and eIDAS for electronic signatures to be legally binding. In contract disputes, the audit chain serves as admissible evidence of who signed what, when, and from where.

### 5. Recipient Authentication

Multi-factor verification based on envelope security level:
- **Email link**: Default; access token in signing URL
- **SMS verification**: One-time code sent to recipient's phone (5-minute expiry)
- **Knowledge-based auth (KBA)**: Identity verification questions
- **ID verification**: Government ID verification via third-party service

## Database Schema

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(200) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(30) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Sessions
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
  status VARCHAR(30) DEFAULT 'draft',
  authentication_level VARCHAR(30) DEFAULT 'email',
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
  role VARCHAR(50) DEFAULT 'signer',
  routing_order INTEGER DEFAULT 1,
  status VARCHAR(30) DEFAULT 'pending',
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
  status VARCHAR(30) DEFAULT 'processing',
  file_size INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Document Fields
CREATE TABLE document_fields (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
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
  type VARCHAR(30) NOT NULL,
  ip_address VARCHAR(50),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE document_fields
ADD CONSTRAINT fk_signature FOREIGN KEY (signature_id) REFERENCES signatures(id);

-- Audit Events (append-only, never delete)
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

-- Email notifications (simulated in local, real in production)
CREATE TABLE email_notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  recipient_id UUID REFERENCES recipients(id) ON DELETE CASCADE,
  envelope_id UUID REFERENCES envelopes(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  subject VARCHAR(255),
  body TEXT,
  status VARCHAR(30) DEFAULT 'pending',
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

-- Idempotency keys (prevents duplicate signatures)
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);

-- Performance indexes
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
```

## Key Design Decisions

### 1. Hash Chain for Audit Trail vs Simple Logging

**Decision**: Link audit events with cryptographic hash chain.

Each event's SHA-256 hash includes the previous event's hash, forming an immutable chain. Simple append-only logging provides no tamper evidence -- a database administrator could modify, insert, or delete records without detection. The hash chain makes any modification immediately detectable by walking the chain and recalculating hashes. Under ESIGN Act and eIDAS, the ability to prove document integrity in court is not optional -- it is a compliance requirement.

The trade-off: hash chain verification is O(N) in the number of events per envelope. For typical envelopes (5-50 events), this is negligible. For bulk verification across thousands of envelopes, a background job handles the cost.

### 2. Explicit State Machine vs Event Sourcing

**Decision**: Explicit state machine with allowed transitions stored in code.

Event sourcing would provide a complete history of state changes and enable temporal queries, but adds significant complexity: event stores, projections, eventual consistency between read and write models, and snapshot management. For document signing, the workflow is well-defined with a small number of states and transitions. An explicit state machine provides clear business rules, prevents invalid states at the code level, maps directly to UI states, and is dramatically easier to debug. The trade-off: we lose the ability to replay events to reconstruct state, but the audit trail provides equivalent historical visibility.

### 3. Separate Signature Storage

**Decision**: Store signatures in a separate S3 bucket from documents.

Documents and signatures have different security, retention, and access patterns. Signatures contain biometric-like data (handwriting patterns) requiring enhanced protection. Separate buckets enable independent encryption keys, retention policies, and access controls. The trade-off: downloading a complete signed document requires fetching from two sources, adding latency. For the signing ceremony (where speed matters), signatures are uploaded to the signature bucket and only composited into the final PDF during the completion step.

### 4. Idempotency for Signature Operations

**Decision**: Two-layer idempotency (Redis fast path + PostgreSQL durable backup).

For electronic signatures, idempotency is legally critical. A duplicate signature due to a network retry could invalidate a document, break the audit chain, or create ambiguous legal standing. Redis provides sub-millisecond duplicate detection for the fast path; PostgreSQL ensures idempotency survives Redis restarts. The idempotency key format (`sig:{fieldId}:{recipientId}:{hourBucket}`) uses 1-hour time buckets to allow legitimate re-signs after genuine failures while catching rapid duplicates.

## Consistency and Idempotency

### Consistency Model

**Strong Consistency (PostgreSQL):**
- All envelope state transitions use `SELECT ... FOR UPDATE` row locks
- Signature capture locks the field row to prevent concurrent double-signing
- Recipient completion and workflow advancement run in a single transaction

**Eventual Consistency:**
- Audit log indexing in Elasticsearch lags by <1 second
- Redis session/idempotency cache invalidation propagates within 100ms
- Notification delivery is async via RabbitMQ (at-least-once semantics)

### Idempotent Operations

| Operation | Key Format | Replay Behavior |
|-----------|-----------|-----------------|
| Send envelope | `send:{envelopeId}:{userId}:{hourBucket}` | Return original response |
| Capture signature | `sig:{fieldId}:{recipientId}:{hourBucket}` | Return existing signature |
| Complete recipient | `complete:{recipientId}:{hourBucket}` | Return existing completion |

## Async Queue Architecture (RabbitMQ)

### Queue Topology

```
┌────────────────────────────────────────────────────────────────┐
│                     RabbitMQ Exchanges                          │
├──────────────────┬────────────────────┬────────────────────────┤
│  docusign.direct │  docusign.fanout   │  docusign.dlx          │
│  (direct)        │  (fanout)          │  (dead letter)         │
└────────┬─────────┴────────┬───────────┴──────────┬─────────────┘
         │                  │                      │
    ┌────▼────┐        ┌────▼────┐           ┌────▼────┐
    │workflow │        │  notif  │           │   DLQ   │
    │  queue  │        │  queue  │           │         │
    └────┬────┘        └────┬────┘           └─────────┘
         │                  │
    ┌────▼────┐        ┌────▼────┐
    │Workflow │        │Notifier │
    │ Worker  │        │ Worker  │
    └─────────┘        └─────────┘
```

### Delivery Semantics

| Queue | Semantics | Reasoning |
|-------|-----------|-----------|
| workflow | At-least-once | State transitions are idempotent |
| notifications | At-least-once | Duplicate notification is acceptable |
| email | At-least-once | External email APIs handle dedup |
| pdf | At-least-once | PDF generation is idempotent |

Messages are persistent (survive broker restart). Failed messages retry with exponential backoff (1s, 2s, 4s, max 60s) up to 3 times before routing to DLQ via dead-letter exchange. Consumer prefetch limits concurrent processing for backpressure.

## Security

### Authentication

- **Senders**: Session-based auth with Redis-backed cookies (24-hour TTL)
- **Signers**: Access token in URL, generated per-recipient on envelope send
- **Admin**: Session-based with `role = 'admin'`

### Signing Session Security

Each recipient gets a unique, single-use access token. The signing session captures IP address and user agent, recorded in the audit trail. Field-level locking (`SELECT ... FOR UPDATE`) prevents concurrent signing of the same field.

### Document Security

Documents encrypted at rest in S3 (server-side encryption). Separate buckets for documents and signatures with independent access policies. Audit events are append-only with hash chain tamper evidence.

## Observability

### Metrics (Prometheus)

| Metric | Type | Labels |
|--------|------|--------|
| `docusign_documents_total` | Counter | - |
| `docusign_envelopes_by_status` | Gauge | status |
| `docusign_signatures_captured_total` | Counter | - |
| `docusign_signatures_pending` | Gauge | - |
| `docusign_http_request_duration_seconds` | Histogram | method, route, status_code |
| `docusign_queue_messages_published_total` | Counter | queue |
| `docusign_queue_messages_processed_total` | Counter | queue, status |
| `docusign_circuit_breaker_state` | Gauge | name |
| `docusign_storage_operation_duration_seconds` | Histogram | operation, bucket |
| `docusign_idempotency_hits_total` | Counter | operation |
| `docusign_audit_events_total` | Counter | event_type |

### Health Checks

Three levels of health endpoints:
- **`/health/live`**: Liveness probe -- process running (always 200)
- **`/health/ready`**: Readiness probe -- PostgreSQL and Redis connectivity
- **`/health`**: Comprehensive -- all dependencies with latency and circuit breaker states

### Logging

Structured JSON via Pino with separate audit logger. Compliance-sensitive events tagged with `type: "audit"` for segregated log streams. Development mode uses pino-pretty.

## Failure Handling

### Circuit Breaker Pattern

Opossum circuit breakers protect MinIO/S3 storage operations. Configuration: 30-second timeout, 50% error threshold, 30-second reset. When open, non-critical storage reads return cached data; critical writes are queued for retry.

### Retry Strategy

| Operation | Max Retries | Backoff | Dead Letter |
|-----------|------------|---------|-------------|
| Storage upload | 3 | Exponential: 1s, 2s, 4s | Queue for retry |
| Notification delivery | 3 | Exponential: 1s, 2s, 4s | DLQ |
| Workflow event | 3 | Exponential: 1s, 2s, 4s, max 60s | DLQ |
| Signature capture | 0 (fail fast) | N/A | Return error |

### Graceful Degradation

| Component Failure | Degradation Strategy |
|-------------------|---------------------|
| Redis down | Idempotency falls back to PostgreSQL-only checks |
| RabbitMQ down | Notifications sent synchronously (slower but functional) |
| MinIO down | Circuit breaker opens; existing documents served from cache |
| Elasticsearch down | Audit search falls back to PostgreSQL ILIKE queries |

## Scalability Considerations

### Horizontal Scaling Path

1. **API Servers**: Stateless, add instances behind load balancer
2. **Workers**: Add notification/workflow workers, each consumes from shared queue
3. **PostgreSQL**: Read replicas for envelope listings and audit queries
4. **S3/MinIO**: Inherently scalable object storage
5. **RabbitMQ**: Clustering for high availability

### Document Storage Scaling

At production scale (millions of envelopes), storage is organized by envelope ID prefix for S3 listing performance: `envelopes/{id-prefix}/{id}/documents/`. Separate lifecycle policies archive completed envelopes to cold storage after 1 year while maintaining the legally required 10-year retention.

### Audit Trail at Scale

For high-volume deployments, audit events are also indexed in Elasticsearch for fast search across millions of envelopes. The PostgreSQL table remains the source of truth for chain verification; Elasticsearch provides the search/analytics layer.

## Trade-offs Summary

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Audit integrity | Hash chain | Simple logging | Legal compliance, tamper evidence |
| Document storage | S3 with KMS encryption | Database BLOBs | Scale, durability, independent retention |
| Workflow | Explicit state machine | Event sourcing | Clarity, simpler debugging, maps to UI |
| Authentication | Multi-factor per level | Email only | Security, eIDAS compliance |
| Idempotency | Redis + PostgreSQL dual-layer | Redis only | Durability across restarts |
| Notifications | Async queue with fallback | Synchronous only | Decouples signing from delivery |

## Implementation Notes

This section maps the production architecture above to the local Docker + Node.js setup actually built.

### Local Setup Diagram

```
┌──────────────────┐
│  React Frontend  │
│ (localhost:5173)  │
│  react-pdf,      │
│  signature_pad   │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐          ┌──────────────────┐
│  API Server      │          │ Notification     │
│ (localhost:3001)  │          │ Worker           │
│  Express + Prom  │          │ (separate proc)  │
└────────┬─────────┘          └────────┬─────────┘
         │                             │
    ┌────┴─────────────────────────────┴────┐
    │                                       │
    ▼              ▼              ▼         ▼
┌────────┐  ┌──────────┐  ┌─────────┐  ┌────────┐
│Postgres│  │  Valkey   │  │  MinIO  │  │RabbitMQ│
│  :5432 │  │  :6379   │  │:9000/:9001│ │ :5672  │
│        │  │          │  │          │  │        │
│DB:     │  │Sessions, │  │Documents,│  │Notifs, │
│docusign│  │idempotency│ │Signatures│  │Workflow│
└────────┘  └──────────┘  └─────────┘  └────────┘
```

### Production Patterns Actually Implemented

| Pattern | Library | File Path | Purpose |
|---------|---------|-----------|---------|
| Circuit breaker | Opossum | `backend/src/shared/circuitBreaker.ts` | Storage operation protection |
| Storage + breaker | Opossum + MinIO | `backend/src/shared/storageWithBreaker.ts` | MinIO uploads/downloads with fallback |
| Idempotency | Redis + PostgreSQL | `backend/src/shared/idempotency.ts` | Dual-layer duplicate detection for signatures |
| Audit hash chain | crypto (SHA-256) | `backend/src/shared/auditLogger.ts` | Tamper-evident event log with chain verification |
| Prometheus metrics | prom-client | `backend/src/shared/metrics.ts` | 15+ metrics: documents, signatures, queue, circuit |
| Structured logging | Pino | `backend/src/shared/logger.ts` | JSON logs with audit segregation, pino-pretty dev |
| Async queue | amqplib | `backend/src/shared/queue.ts` | RabbitMQ notifications with sync fallback |
| Workflow state machine | Custom | `backend/src/services/workflowEngine.ts` | Envelope lifecycle with routing logic |
| Audit service | Custom | `backend/src/services/auditService.ts` | Event logging with hash chain |
| Health checks | Custom endpoints | `backend/src/index.ts` | `/health`, `/health/live`, `/health/ready` |
| Metrics middleware | prom-client | `backend/src/shared/metrics.ts` | HTTP duration histograms |
| Notification worker | amqplib consumer | `backend/src/workers/notification-worker.ts` | Async email processing |
| Idempotency middleware | Custom | `backend/src/shared/idempotency.ts` | X-Idempotency-Key header extraction |
| PDF validation | pdf-lib | `backend/src/routes/documents.ts` | PDF integrity check on upload |

### Frontend Implementation

The frontend uses React + TypeScript + Vite + Tailwind CSS with modular component architecture:

| Feature Area | Key Libraries | Components |
|--------------|---------------|------------|
| PDF rendering | react-pdf (PDF.js) | `PdfViewer`, `SigningPdfViewer` |
| Signature capture | signature_pad | `SignatureModal` (draw/type modes) |
| Field placement | CSS absolute positioning | `FieldsTab`, `FieldsSidebar` |
| State management | Zustand | `authStore`, `envelopeStore` |
| Routing | TanStack Router | File-based routes (`/envelopes/:id`, `/sign/:token`) |
| Styling | Tailwind CSS | Responsive layouts |

### Simplifications from Production Design

| Production | Local Substitute | Impact |
|------------|-----------------|--------|
| AWS S3 with KMS encryption | MinIO (S3-compatible) | No server-side encryption, no lifecycle policies |
| Real email delivery (SendGrid/SES) | Emails stored in DB `email_notifications` table | No actual notification delivery |
| Elasticsearch for audit search | PostgreSQL queries | Slower audit search at scale |
| SMS verification (Twilio) | Not implemented | Email-link only authentication |
| PDF flattening (embed signatures) | Signatures stored separately | Completed PDFs don't contain embedded sigs |
| Multi-region replication | Single PostgreSQL instance | No geographic redundancy |
| API Gateway + CDN | Direct frontend-to-backend | No TLS termination, no WAF |
| Load balancer | Run manually on :3001-:3003 | No automatic failover |
| Template system | Not implemented | Each envelope created from scratch |

### What Was Omitted

- PDF flattening with embedded signatures
- Real email/SMS delivery
- OAuth, MFA, access code authentication
- Knowledge-based authentication (KBA) and ID verification
- Template system for recurring documents
- Bulk send capabilities
- Real-time signing status via WebSocket
- Mobile-responsive signing experience
- CDN for document/page image delivery
- Multi-region deployment and Kubernetes
- Document expiration enforcement
- Distributed locking for concurrent signing sessions
