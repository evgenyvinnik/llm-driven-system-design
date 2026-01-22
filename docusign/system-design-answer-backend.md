# Design DocuSign - System Design Answer (Backend Focus)

## 45-minute system design interview format - Backend Engineer Position

---

## 1. Requirements Clarification (3-4 minutes)

### Functional Requirements

- **Upload**: Upload documents (primarily PDFs) for signing
- **Prepare**: Add signature fields and assign to recipients
- **Route**: Send to recipients in specified order (serial or parallel)
- **Sign**: Capture legally binding electronic signatures
- **Complete**: Generate final signed document with certificate of completion

### Non-Functional Requirements

- **Availability**: 99.99% for signing ceremonies
- **Durability**: Documents stored for 10+ years with guaranteed integrity
- **Compliance**: ESIGN Act, UETA, eIDAS compliant
- **Security**: End-to-end encryption, SOC 2 Type II compliant
- **Auditability**: Every action logged with tamper-proof trail

### Scale Estimation

- 100K envelopes per day, average 3 recipients each
- Document sizes: 100KB - 50MB (PDFs)
- Long-term storage: 10+ years with integrity verification

---

## 2. High-Level Architecture (5 minutes)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Client Layer                                 │
│               Web App │ Mobile App │ API Integration                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          API Gateway                                 │
│                     (Auth, Rate Limiting)                            │
└───────────┬───────────────────┼───────────────────┬─────────────────┘
            │                   │                   │
            ▼                   ▼                   ▼
┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
│ Document Service  │  │ Workflow Engine   │  │ Signing Service   │
├───────────────────┤  ├───────────────────┤  ├───────────────────┤
│ - PDF processing  │  │ - State mgmt      │  │ - Capture sig     │
│ - Field placement │  │ - Routing logic   │  │ - Verify ID       │
│ - Templates       │  │ - Reminders       │  │ - Audit logging   │
└─────────┬─────────┘  └─────────┬─────────┘  └─────────┬─────────┘
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          Data Layer                                  │
├─────────────────────┬─────────────────────┬─────────────────────────┤
│     PostgreSQL      │      S3/MinIO       │     Elasticsearch       │
│  - Envelopes        │  - Documents        │  - Audit logs           │
│  - Recipients       │  - Signatures       │  - Search               │
│  - Workflow state   │  - Certificates     │  - Analytics            │
└─────────────────────┴─────────────────────┴─────────────────────────┘
```

### Component Responsibilities

- **Document Service**: PDF processing, field placement, template management
- **Workflow Engine**: State machine for signing orchestration
- **Signing Service**: Signature capture, recipient verification, audit logging

---

## 3. Database Schema Design (6 minutes)

### Schema Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  envelopes                                                           │
├─────────────────────────────────────────────────────────────────────┤
│  id UUID PK, sender_id UUID FK, name VARCHAR(200)                   │
│  status VARCHAR(30) DEFAULT 'draft'                                 │
│  authentication_level VARCHAR(30) DEFAULT 'email'                   │
│  expiration_date TIMESTAMP, created_at, updated_at, completed_at    │
│  INDEX: idx_envelopes_sender_status ON (sender_id, status)          │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   recipients    │    │    documents    │    │  audit_events   │
├─────────────────┤    ├─────────────────┤    ├─────────────────┤
│ id UUID PK      │    │ id UUID PK      │    │ id UUID PK      │
│ envelope_id FK  │    │ envelope_id FK  │    │ envelope_id FK  │
│ name, email     │    │ name, page_count│    │ event_type      │
│ role            │    │ s3_key, status  │    │ data JSONB      │
│ routing_order   │    │ created_at      │    │ timestamp       │
│ status          │    └────────┬────────┘    │ actor           │
│ access_token    │             │             │ previous_hash   │
│ ip_address      │             ▼             │ hash (SHA-256)  │
│ completed_at    │    ┌─────────────────┐    └─────────────────┘
└────────┬────────┘    │ document_fields │
         │             ├─────────────────┤
         │             │ id UUID PK      │
         │             │ document_id FK  │
         │             │ recipient_id FK │
         │             │ type, page_num  │
         ▼             │ x, y, w, h      │
┌─────────────────┐    │ required, done  │
│   signatures    │    │ value, sig_id   │
├─────────────────┤    └─────────────────┘
│ id UUID PK      │
│ recipient_id FK │
│ field_id FK     │
│ s3_key, type    │
│ created_at      │
└─────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  idempotency_keys (prevent duplicate operations)                     │
├─────────────────────────────────────────────────────────────────────┤
│  key VARCHAR(255) PK, response JSONB, created_at TIMESTAMP          │
│  INDEX: idx_idempotency_created ON (created_at)                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Workflow Engine State Machine (8 minutes)

### State Transitions

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Envelope State Machine                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│      ┌───────┐                                                       │
│      │ draft │                                                       │
│      └───┬───┘                                                       │
│          │ send                                                      │
│          ▼                                                           │
│      ┌───────┐                                                       │
│      │ sent  │─────────────┐                                         │
│      └───┬───┘             │ void                                    │
│          │ deliver         │                                         │
│          ▼                 ▼                                         │
│   ┌───────────┐      ┌────────┐                                      │
│   │ delivered │      │ voided │ (terminal)                           │
│   └─────┬─────┘      └────────┘                                      │
│         │                                                            │
│    ┌────┴────┐                                                       │
│    │         │                                                       │
│    ▼         ▼                                                       │
│ ┌────────┐ ┌──────────┐                                              │
│ │ signed │ │ declined │ (terminal)                                   │
│ └────┬───┘ └──────────┘                                              │
│      │ all recipients done                                           │
│      ▼                                                               │
│ ┌───────────┐                                                        │
│ │ completed │ (terminal)                                             │
│ └───────────┘                                                        │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Routing Logic

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Get Next Recipients                                │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Query recipients ordered by routing_order ASC                    │
│  2. Filter to pending status only                                    │
│  3. Find lowest incomplete routing order                             │
│  4. Return ALL recipients at that order (parallel signing)           │
└─────────────────────────────────────────────────────────────────────┘
```

"Recipients with the same routing_order sign in parallel. Recipients with different orders sign serially."

### Complete Recipient Flow

```
┌──────────────────┐
│ Recipient signs  │
│ all their fields │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Mark recipient   │
│ as completed     │
└────────┬─────────┘
         │
         ▼
┌──────────────────────────────────┐
│ Check: All siblings at this      │
│ routing order complete?          │
└────────────────┬─────────────────┘
                 │
     ┌───────────┴───────────┐
     │ No                    │ Yes
     ▼                       ▼
┌─────────────┐     ┌─────────────────────────┐
│ Wait for    │     │ Get next recipients     │
│ siblings    │     └────────────┬────────────┘
└─────────────┘                  │
                     ┌───────────┴───────────┐
                     │ None                  │ Some
                     ▼                       ▼
            ┌─────────────────┐    ┌─────────────────┐
            │ Complete        │    │ Queue signing   │
            │ envelope        │    │ notifications   │
            └────────┬────────┘    └─────────────────┘
                     │
                     ▼
            ┌─────────────────┐
            │ Generate signed │
            │ PDF + cert      │
            └─────────────────┘
```

### Idempotent State Transitions

```
┌─────────────────────────────────────────────────────────────────────┐
│             Idempotent Transition (Database Transaction)             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. BEGIN transaction                                                │
│  2. Check idempotency_keys table for duplicate request               │
│     - If found: ROLLBACK, return cached response                     │
│  3. Lock envelope row with FOR UPDATE                                │
│  4. Validate state transition is allowed                             │
│  5. Execute operation                                                │
│  6. Store idempotency key with response                              │
│  7. COMMIT transaction                                               │
└─────────────────────────────────────────────────────────────────────┘
```

"This prevents race conditions and duplicate processing when clients retry failed requests."

---

## 5. Tamper-Proof Audit Trail (8 minutes)

### Hash Chain Implementation

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Audit Event Hash Chain                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Event 1          Event 2          Event 3          Event 4         │
│  ┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐     │
│  │ data    │      │ data    │      │ data    │      │ data    │     │
│  │ prev: 0 │──────│ prev: H1│──────│ prev: H2│──────│ prev: H3│     │
│  │ hash: H1│      │ hash: H2│      │ hash: H3│      │ hash: H4│     │
│  └─────────┘      └─────────┘      └─────────┘      └─────────┘     │
│       │                │                │                │          │
│       └────────────────┴────────────────┴────────────────┘          │
│                        Linked by hashes                              │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Hash Calculation

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Hash Calculation Process                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Input payload:                                                      │
│  ├── event.id                                                        │
│  ├── event.envelopeId                                                │
│  ├── event.eventType                                                 │
│  ├── event.data (JSON)                                               │
│  ├── event.timestamp                                                 │
│  └── event.previousHash                                              │
│                                                                      │
│  Output: SHA-256(JSON.stringify(payload)) ──▶ 64-char hex string    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Chain Verification

```
┌────────────────────┐
│ Verify Chain       │
│ for envelope       │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐
│ Fetch all events   │
│ ORDER BY timestamp │
└─────────┬──────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────┐
│  For each event:                                                │
│  1. Verify previous_hash matches prior event's hash            │
│  2. Recalculate hash from event data                           │
│  3. Compare calculated hash with stored hash                    │
│  4. If mismatch: chain is broken, return invalid               │
└────────────────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────────┐
│ Return: valid/     │
│ invalid + error    │
└────────────────────┘
```

### Audit Event Types

| Category | Event Types |
|----------|-------------|
| Envelope lifecycle | envelope_created, envelope_sent, envelope_voided, envelope_completed |
| Document events | document_uploaded, field_added, field_removed |
| Recipient events | recipient_added, recipient_viewed, recipient_declined, recipient_completed |
| Signature events | signature_captured, field_completed |
| Authentication | access_token_generated, sms_verification_sent, sms_verification_completed |

"Each signature capture includes: recipientId, fieldId, signatureId, signatureType, ipAddress, userAgent, timestamp, geolocation."

---

## 6. Signature Capture Service (6 minutes)

### Capture Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Signature Capture Flow                            │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Check idempotency key in Redis                                   │
│     - If found: return cached result                                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. BEGIN database transaction                                       │
│  3. Lock field row with FOR UPDATE                                   │
│  4. Verify field not already completed                               │
│  5. Verify recipient owns this field                                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  6. Process signature based on type:                                 │
│     ├── draw: decode base64 image data                               │
│     ├── typed: render text with selected font                        │
│     └── upload: validate uploaded image                              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  7. Store signature in S3 with KMS encryption                        │
│  8. Create signature record in database                              │
│  9. Mark field as completed                                          │
│  10. COMMIT transaction                                              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  11. Log to audit trail with full context                            │
│  12. Cache result for idempotency (24h TTL)                          │
│  13. Check if recipient completed all required fields                │
│      - If yes: trigger workflow.completeRecipient()                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Message Queue Architecture (5 minutes)

### RabbitMQ Queue Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                      RabbitMQ Exchanges                              │
├─────────────────┬─────────────────────┬─────────────────────────────┤
│ docusign.direct │   docusign.fanout   │      docusign.dlx           │
│ (direct type)   │   (fanout type)     │   (dead letter)             │
└────────┬────────┴──────────┬──────────┴────────────┬────────────────┘
         │                   │                       │
         ▼                   ▼                       ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ workflow queue  │  │  email queue    │  │    dlq queue    │
└────────┬────────┘  └────────┬────────┘  └─────────────────┘
         │                    │
         ▼                    ▼
┌─────────────────┐  ┌─────────────────┐
│ Workflow Worker │  │  Email Worker   │
└─────────────────┘  └─────────────────┘
```

### Message Publishing with Delivery Guarantees

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Message Structure                                 │
├─────────────────────────────────────────────────────────────────────┤
│  {                                                                   │
│    id: UUID,                                                        │
│    type: event_type,                                                │
│    envelopeId: UUID,                                                │
│    data: {...},                                                     │
│    timestamp: ISO8601,                                              │
│    idempotencyKey: "{type}:{envelopeId}:{timestamp}"                │
│  }                                                                   │
│                                                                      │
│  Options: persistent=true, messageId=id,                            │
│           headers: { x-idempotency-key, x-retry-count }             │
└─────────────────────────────────────────────────────────────────────┘
```

### Consumer with Backpressure

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Consumer Processing                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Prefetch: 5 (limits concurrent processing)                         │
│                                                                      │
│  For each message:                                                   │
│  1. Check Redis for processed:{idempotencyKey}                      │
│     - If found: ACK and skip (already processed)                    │
│  2. Process the event                                               │
│  3. Store processed key in Redis (24h TTL)                          │
│  4. ACK the message                                                 │
│                                                                      │
│  On error:                                                          │
│  - If retryCount < 3: republish with incremented count, NACK        │
│  - If retryCount >= 3: NACK (goes to DLQ)                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 8. Recipient Authentication (4 minutes)

### Authentication Levels

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Authentication Methods                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  email          ──▶  Email link with access token (default)         │
│  sms            ──▶  6-digit code sent via SMS                      │
│  knowledge      ──▶  Knowledge-based questions                      │
│  id_verification──▶  Government ID verification                     │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### SMS Verification Flow

```
┌────────────────────┐
│ Recipient requests │
│ signing access     │
└─────────┬──────────┘
          │
          ▼
┌────────────────────┐                    ┌────────────────────┐
│ Generate 6-digit   │───────────────────▶│ Store in Redis     │
│ random code        │                    │ 5-minute expiry    │
└─────────┬──────────┘                    └────────────────────┘
          │
          ▼
┌────────────────────┐                    ┌────────────────────┐
│ Send SMS via       │───────────────────▶│ Log audit event:   │
│ provider           │                    │ sms_verification_  │
└─────────┬──────────┘                    │ sent               │
          │                               └────────────────────┘
          ▼
┌────────────────────┐
│ Recipient enters   │
│ code               │
└─────────┬──────────┘
          │
          ▼
┌────────────────────────────────────────────────────────────────┐
│ Compare with stored code                                        │
│ ├── Match: delete key, log success, return authenticated       │
│ └── No match: log failure, return error                        │
└────────────────────────────────────────────────────────────────┘
```

---

## 9. Circuit Breaker for External Services (3 minutes)

### Circuit Breaker Configuration

| Service | Timeout | Error Threshold | Reset Timeout |
|---------|---------|-----------------|---------------|
| Email | 5s | 50% | 60s |
| S3 | 30s | 50% | 30s |
| SMS | 10s | 50% | 120s |

### Circuit Breaker States

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Circuit Breaker States                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│    CLOSED ────────▶ OPEN ────────▶ HALF-OPEN                        │
│       │               │               │                              │
│   (normal)      (50% failures)   (after reset                        │
│       ▲               │            timeout)                          │
│       │               │               │                              │
│       └───────────────┴───────────────┘                              │
│            (on success in half-open)                                 │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Fallback Strategy

"When S3 circuit breaker is open, queue uploads for retry when storage recovers. Return {queued: true} to client."

---

## 10. Certificate of Completion (3 minutes)

### Certificate Generation Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                Certificate of Completion                             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  1. Fetch all audit events for envelope                              │
│  2. Verify hash chain integrity                                      │
│  3. Build certificate object:                                        │
│     ├── envelopeId, documentName, completedAt                        │
│     ├── signers: [{ name, email, signedAt, ipAddress }]              │
│     ├── events: [{ time, action, actor, details }]                   │
│     ├── chainVerified: true/false                                    │
│     └── integrityHash: final event hash                              │
│  4. Render certificate as PDF                                        │
│  5. Store in S3: envelopes/{id}/certificate.pdf                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Certificate Contents

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Certificate Structure                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Document: [Document Name]                                           │
│  Completed: [Timestamp]                                              │
│  Integrity Hash: [SHA-256]                                           │
│  Chain Verified: Yes/No                                              │
│                                                                      │
│  Signers:                                                            │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Name        │ Email           │ Signed At    │ IP Address  │    │
│  ├─────────────┼─────────────────┼──────────────┼─────────────┤    │
│  │ John Doe    │ john@example.com│ 2024-01-15   │ 192.168.1.1 │    │
│  │ Jane Smith  │ jane@example.com│ 2024-01-16   │ 10.0.0.1    │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Audit Trail:                                                        │
│  [Timestamp] envelope_created by sender@example.com                  │
│  [Timestamp] envelope_sent                                           │
│  [Timestamp] recipient_viewed by john@example.com from IP           │
│  [Timestamp] signature_captured                                      │
│  [Timestamp] recipient_completed                                     │
│  [Timestamp] envelope_completed                                      │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 11. Key Backend Trade-offs

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Audit integrity | Hash chain | Simple logging | Legal defensibility, tamper evidence |
| Document storage | S3 with KMS | Database BLOBs | Scale, durability, compliance |
| Workflow | State machine | Event-driven | Clarity, validation, debugging |
| Authentication | Multi-factor | Email only | Enterprise security requirements |
| Idempotency | Redis + PostgreSQL | PostgreSQL only | Fast duplicate detection |

### Why Hash Chain over Simple Logging?

1. **Legal Defensibility**: Courts accept cryptographic proof of integrity
2. **Tamper Evidence**: Any modification breaks the chain
3. **Independent Verification**: Chain can be verified without access to source system
4. **Compliance**: Meets ESIGN, UETA, eIDAS requirements

---

## Summary

"This DocuSign backend design demonstrates:

1. **Workflow State Machine**: Explicit transitions prevent invalid states
2. **Tamper-Proof Audit**: Hash chain provides legal defensibility
3. **Idempotency**: All critical operations are safely retryable
4. **Message Queues**: Decouple signing from notifications
5. **Multi-Factor Auth**: Configurable security levels
6. **Circuit Breakers**: Protect against external service failures
7. **Certificate Generation**: Complete signing record with integrity proof

The design prioritizes legal compliance - every action is logged, hashed, and verifiable years after signing."
