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

## Frontend Architecture

### Component Hierarchy

The frontend is a React SPA built with Vite, TypeScript, and Tailwind CSS. It provides two distinct user experiences: the **sender flow** (creating envelopes, adding documents, placing fields, managing recipients) and the **signing ceremony** (recipients opening a link, viewing the document, and signing fields).

```
__root.tsx (RootComponent)
├── Header (DocuSign logo, nav: Dashboard, Envelopes, Admin [role-gated])
├── checkAuth() on mount to restore session
└── <Outlet /> renders child routes:
    ├── /login ──────────────── Login (email + password)
    ├── /register ──────────── Register (email, name, password)
    ├── / ──────────────────── Dashboard (envelope stats summary)
    ├── /envelopes ─────────── Envelope List (filterable by status)
    ├── /envelopes/new ─────── Create Envelope (name + message form)
    ├── /envelopes/$envelopeId ── Envelope Detail (tabbed interface)
    │   ├── DocumentsTab
    │   │   └── PdfViewer (react-pdf rendering with page navigation)
    │   ├── RecipientsTab (add/remove recipients, set routing order)
    │   ├── FieldsTab
    │   │   ├── PdfViewer (with click-to-add field overlay)
    │   │   └── FieldsSidebar (field type selector, recipient assignment)
    │   └── AuditTab (hash chain event timeline with verification)
    ├── /sign/$accessToken ─── Signing Ceremony (token-based, no login required)
    │   ├── SigningHeader (envelope info, Finish/Decline buttons)
    │   ├── SigningPdfViewer (document with clickable field overlays)
    │   ├── SigningSidebar (field completion checklist)
    │   └── SignatureModal (draw with signature_pad / type with preview)
    ├── /signing-complete ──── Signing Complete (confirmation page)
    ├── /signing-declined ──── Signing Declined (confirmation page)
    ├── /admin ────────────── Admin Dashboard (stats, user list, envelope inspector, email log)
    │
    └── Components organized by feature:
        ├── components/common/ → LoadingSpinner, MessageBanner, StatusBadge (barrel export)
        ├── components/envelope/ → DocumentsTab, PdfViewer, RecipientsTab, FieldsTab, FieldsSidebar, AuditTab
        ├── components/signing/ → SignatureModal, SigningPdfViewer, SigningSidebar, SigningHeader, error/loading states
        └── components/icons/ → CheckIcon, CloseIcon, PdfIcon, WarningIcon (SVG components with barrel export)
```

### Zustand Stores

**`authStore`**: Manages user session state. Stores `User` object, `isAuthenticated` flag, loading state, and error. Actions: `login()`, `register()`, `logout()`, `checkAuth()`, `clearError()`. The `checkAuth()` action is called on mount in `__root.tsx` via `useEffect` to restore sessions from the HTTP-only cookie. The `isAuthenticated` flag drives conditional rendering of navigation links and the admin tab (which also checks `user.role === 'admin'`).

**`envelopeStore`**: Central state for the entire envelope workflow. Stores the envelope list, current envelope detail, documents array, recipients array, and fields array. This single store coordinates all CRUD operations across four entity types:
- **Envelope actions**: `fetchEnvelopes()`, `fetchEnvelope()` (loads envelope + documents + recipients + fields in one call), `createEnvelope()`, `updateEnvelope()`, `sendEnvelope()`, `voidEnvelope()`, `deleteEnvelope()`
- **Document actions**: `uploadDocument()` (uses FormData for file upload, not JSON), `deleteDocument()` (also removes associated fields from local state)
- **Recipient actions**: `addRecipient()`, `updateRecipient()`, `deleteRecipient()` (also removes associated fields)
- **Field actions**: `addField()`, `updateField()`, `deleteField()`
- **Cleanup**: `clearCurrent()` resets current envelope, documents, recipients, and fields when navigating away

The store's optimistic local state updates (e.g., filtering out deleted items from arrays without refetching) provide a responsive UI. Error handling sets the store's `error` field, which components can display via `MessageBanner`.

### Routing

Uses TanStack Router with file-based routing. Notable routing patterns:
- **Nested dynamic route**: `/envelopes/$envelopeId` extracts the envelope UUID from the URL for detail views
- **Token-based signing route**: `/sign/$accessToken` is accessible without authentication -- the access token in the URL serves as the auth credential for the signing ceremony
- **Role-gated admin route**: `/admin` checks `user.role === 'admin'` in the component and shows an "Access Denied" message for non-admin users
- **Post-signing confirmation routes**: `/signing-complete` and `/signing-declined` are simple static pages shown after the signing ceremony

### Data Fetching

API calls use a centralized `fetchWithAuth()` function with `credentials: 'include'` for session cookies. The API service is organized into seven domain objects: `authApi`, `envelopeApi`, `documentApi`, `recipientApi`, `fieldApi`, `signingApi`, and `auditApi`, plus `adminApi` for admin operations.

The signing API (`signingApi`) is unique: it uses raw `fetch()` calls instead of `fetchWithAuth()` because signing sessions authenticate via the access token in the URL rather than session cookies. This allows external signers (who are not registered users) to sign documents.

Document uploads use `FormData` instead of JSON, which is the standard approach for file uploads. The `documentApi.upload()` method creates a `FormData` object and omits the `Content-Type` header (letting the browser set the multipart boundary automatically).

Document viewing uses URL construction rather than fetch: `documentApi.view(id)` returns a URL string that can be set as the `src` of react-pdf's Document component. This avoids loading entire PDFs into JavaScript memory.

### Key UI Patterns

- **Tabbed envelope detail**: The envelope detail page uses tab navigation (Documents, Recipients, Fields, Audit) rather than separate routes. Each tab is a component that reads from the shared `envelopeStore`. This keeps all envelope data in one store and avoids re-fetching when switching tabs.
- **Click-to-add field placement**: On the Fields tab, the `PdfViewer` renders the document, and clicking on the PDF calculates page-relative coordinates for field placement. The `FieldsSidebar` selects the field type and target recipient. Fields are rendered as CSS absolute-positioned overlays on top of the PDF canvas.
- **Signature capture modal**: `SignatureModal` offers two modes -- draw (using the `signature_pad` library for canvas-based freehand input) and type (rendering typed text with a cursive font). Both produce a base64 PNG that is sent to the API.
- **PDF rendering with react-pdf**: Uses `react-pdf` (a React wrapper for PDF.js) for in-browser PDF rendering. Pages are rendered individually with navigation controls. The same component is used in both the sender view (field placement) and the signing ceremony (field completion).
- **Hash chain audit display**: The `AuditTab` shows a timeline of all envelope events with their SHA-256 hashes and verification status. Users can click "Verify Chain" to confirm tamper evidence.
- **Status badges**: The `StatusBadge` component in `components/common/` renders color-coded pills for envelope statuses (draft=gray, sent=blue, delivered=yellow, signed=green, completed=green, declined=red, voided=red).
- **Component organization with barrel exports**: Components are grouped by feature area (`common/`, `envelope/`, `signing/`, `icons/`) with `index.ts` barrel files for clean imports.

## Deep Pattern Explanations

This section explains each production-grade pattern used in this project. Each explanation assumes no prior familiarity with the pattern.

### RBAC (Role-Based Access Control)

RBAC is an authorization model where permissions are assigned to roles, and roles are assigned to users. Instead of maintaining per-user permission lists, you define roles (e.g., "user", "admin") with specific allowed actions, and check the user's role at each protected endpoint.

In this project, users have a `role` column (default `'user'`). Admin users can access the admin dashboard, view all envelopes across all users, manage user roles, and inspect email notifications. Regular users can only manage their own envelopes. The frontend gates the admin nav link with `user.role === 'admin'`, and the backend verifies the role in admin route middleware. This two-layer check (frontend hides the UI, backend enforces the rule) ensures that even if someone crafts a direct API request, they cannot access admin operations without the admin role.

### Redis Cache-Aside

Cache-aside (also called "lazy loading") is a caching strategy where the application checks a fast cache before querying the database. On a cache miss, the database is queried, the result is stored in the cache with a TTL, and then returned. On a cache hit, the cached value is returned directly.

In this project, Valkey stores two types of cached data: sessions (24-hour TTL, used for sender authentication) and idempotency keys (for the fast-path of duplicate signature detection). The idempotency system uses a dual-layer approach: Redis provides sub-millisecond duplicate detection, and PostgreSQL provides durable backup. When checking for a duplicate signature, the system first checks Redis. If Redis is down, it falls back to querying the PostgreSQL `idempotency_keys` table.

The cache-aside pattern is particularly important for the signing ceremony, where multiple recipients may be signing concurrently. Each signature capture must check for duplicates quickly -- a 5ms database query multiplied by 20 fields across 5 recipients adds up. The Redis check completes in under 1ms.

### Circuit Breaker

A circuit breaker is a stability pattern that wraps calls to external services and monitors their reliability. It has three states: **Closed** (normal, requests flow through), **Open** (too many failures, requests immediately rejected with an error), and **Half-Open** (after a cooldown, one test request is allowed to check if the service recovered).

In this project, Opossum circuit breakers protect MinIO/S3 storage operations. Configuration: 30-second timeout, 50% error threshold, 30-second reset period. When the storage circuit breaker opens, the system degrades gracefully: non-critical storage reads return cached data (if available), while critical writes are queued for retry. This is important because document upload and signature storage are the most I/O-intensive operations -- if MinIO becomes slow or unreachable, without a circuit breaker, every document view and signature capture would hang for 30 seconds before timing out, making the entire platform unusable.

The circuit breaker state is also exposed as a Prometheus metric (`docusign_circuit_breaker_state`), enabling operators to see when storage is degraded and for how long.

Files: `backend/src/shared/circuitBreaker.ts`, `backend/src/shared/storageWithBreaker.ts`

### Structured Logging

Structured logging means emitting log entries as machine-parseable JSON objects with named fields, rather than free-form text. Instead of `"Signature captured for field abc on envelope xyz"`, the system emits `{"event": "signature.captured", "fieldId": "abc", "envelopeId": "xyz", "recipientId": "def", "type": "draw", "ip": "1.2.3.4"}`.

In this project, structured logging is especially critical because of legal compliance requirements. The ESIGN Act and eIDAS require that electronic signature platforms maintain detailed records of signing activities. Structured logs with fields like `event_type`, `envelope_id`, `recipient_id`, `ip_address`, and `user_agent` enable both operational debugging and compliance auditing.

Pino produces JSON logs with a separate audit logger. Compliance-sensitive events are tagged with `type: "audit"` for segregated log streams -- this means audit logs can be routed to a separate, immutable storage system (WORM storage) that satisfies regulatory retention requirements, while operational logs can have shorter retention.

File: `backend/src/shared/logger.ts`

### Prometheus Metrics

Prometheus is a pull-based monitoring system. The application exposes numeric measurements at `GET /metrics`. A Prometheus server scrapes this endpoint periodically, stores the time series, and Grafana visualizes them.

This project exposes 11+ metrics spanning business events and infrastructure health: `docusign_documents_total` (counter for document uploads), `docusign_envelopes_by_status` (gauge per status showing current distribution -- useful for spotting stuck envelopes), `docusign_signatures_captured_total` (counter for the primary business action), `docusign_signatures_pending` (gauge showing how many signatures are waiting -- a rising count may indicate signing ceremony problems), `docusign_http_request_duration_seconds` (histogram for API latency SLOs), `docusign_queue_messages_published_total` and `processed_total` (counters for RabbitMQ health), `docusign_circuit_breaker_state` (gauge showing 0=closed, 1=open for storage health), `docusign_storage_operation_duration_seconds` (histogram for MinIO performance), `docusign_idempotency_hits_total` (counter for duplicate detection rate), and `docusign_audit_events_total` (counter by event type for compliance monitoring).

File: `backend/src/shared/metrics.ts`

### Rate Limiting

Rate limiting restricts how many requests a client can make within a time window. Without it, a single client could overwhelm the server, degrading performance for all users, or an attacker could brute-force signing tokens.

In a document signing platform, rate limiting serves specific purposes: preventing brute-force attacks on access tokens (which are the signing ceremony's only authentication), protecting the document processing pipeline (PDF parsing and storage are CPU/IO intensive), and ensuring fair access during peak signing periods (e.g., end-of-quarter when thousands of contracts need signatures).

The implementation uses express middleware that checks request counts per IP or per user. When the limit is exceeded, the server returns HTTP 429 (Too Many Requests). The signing ceremony endpoints are particularly sensitive because they are publicly accessible (no login required, just an access token in the URL).

### Idempotency

Idempotency means that performing the same operation multiple times produces the same result as performing it once. For electronic signatures, this is legally critical: a duplicate signature due to a network retry could invalidate a document, break the audit chain, or create ambiguous legal standing about which signature is authoritative.

The implementation uses two layers. The fast path checks Redis: before processing a signature capture, the server looks up the key format `sig:{fieldId}:{recipientId}:{hourBucket}` in Redis. If found, the previously stored response is returned. The durable path checks PostgreSQL: the `idempotency_keys` table ensures that even if Redis loses data (restart, eviction), duplicates are caught.

The hour-bucket in the key format is a deliberate design choice. It allows legitimate re-signs (a recipient returns the next day to re-sign after a genuine failure) while catching rapid duplicates (two identical requests within the same hour). Without the time bucket, a recipient could never retry a failed signing session because the idempotency key would permanently block the operation.

File: `backend/src/shared/idempotency.ts`

### Health Checks

Health checks are HTTP endpoints that report whether the service is functioning correctly. They are consumed by load balancers (to route traffic away from sick instances), container orchestrators (to restart failed processes), and monitoring systems (to alert operators).

This project implements three levels of health checks, each serving a different consumer:
- **`/health/live`** (liveness probe): Returns 200 if the process is running. This is the most basic check -- if it fails, the process should be killed and restarted. It always returns 200 because if the HTTP server can respond at all, the process is alive.
- **`/health/ready`** (readiness probe): Tests PostgreSQL and Redis connectivity. A newly started server that has not yet established database connections returns unhealthy on this endpoint, preventing the load balancer from sending traffic before the server is ready.
- **`/health`** (comprehensive): Checks all dependencies with latency measurements and circuit breaker states. This endpoint is for operators and dashboards, not for load balancers (it is too expensive to call every second).

For a document signing platform with legal deadlines, health checks are critical. If a signing ceremony fails because the server is unhealthy, the recipient may miss a legal deadline. Proactive health detection prevents this by routing traffic to healthy instances before failures become user-visible.

File: `backend/src/index.ts`

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
