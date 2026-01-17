# Design DocuSign - Architecture

## System Overview

DocuSign is an electronic signature platform with document workflow automation. Core challenges involve document processing, workflow orchestration, and legal compliance.

**Learning Goals:**
- Build document processing pipelines
- Design workflow state machines
- Implement tamper-proof audit trails
- Handle multi-party signing flows

---

## Requirements

### Functional Requirements

1. **Upload**: Upload documents for signing
2. **Prepare**: Add signature fields and assign recipients
3. **Route**: Send to recipients in order
4. **Sign**: Capture legally binding signatures
5. **Complete**: Generate signed document with audit trail

### Non-Functional Requirements

- **Availability**: 99.99% for signing ceremonies
- **Durability**: Documents stored for 10+ years
- **Compliance**: ESIGN, UETA, eIDAS compliant
- **Security**: End-to-end encryption, SOC 2 compliant

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Layer                                │
│           Web App │ Mobile App │ API Integration                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    API Gateway                                  │
│               (Auth, Rate Limiting)                             │
└─────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│Document Service│    │Workflow Engine│    │ Signing Service│
│               │    │               │    │               │
│ - PDF process │    │ - State mgmt  │    │ - Capture sig │
│ - Fields      │    │ - Routing     │    │ - Verify ID   │
│ - Templates   │    │ - Reminders   │    │ - Audit log   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Data Layer                                 │
├─────────────────┬───────────────────┬───────────────────────────┤
│   PostgreSQL    │        S3         │      Elasticsearch        │
│   - Envelopes   │  - Documents      │      - Audit logs         │
│   - Recipients  │  - Signatures     │      - Search             │
│   - Workflow    │  - Certificates   │      - Analytics          │
└─────────────────┴───────────────────┴───────────────────────────┘
```

---

## Core Components

### 1. Document Processing

**PDF Upload & Field Placement:**
```javascript
async function processDocument(envelopeId, file) {
  // Validate PDF
  const pdfDoc = await PDFDocument.load(file.buffer)
  const pageCount = pdfDoc.getPageCount()

  // Store original document
  const documentId = uuid()
  const s3Key = `envelopes/${envelopeId}/documents/${documentId}/original.pdf`
  await s3.upload({
    Bucket: 'docusign-documents',
    Key: s3Key,
    Body: file.buffer,
    ContentType: 'application/pdf',
    ServerSideEncryption: 'aws:kms'
  }).promise()

  // Generate page images for field placement UI
  const pageImages = []
  for (let i = 0; i < pageCount; i++) {
    const pngBytes = await renderPageToImage(pdfDoc, i)
    const imageKey = `envelopes/${envelopeId}/documents/${documentId}/pages/${i}.png`
    await s3.upload({
      Bucket: 'docusign-documents',
      Key: imageKey,
      Body: pngBytes,
      ContentType: 'image/png'
    }).promise()
    pageImages.push(imageKey)
  }

  // Create document record
  const document = await db.query(`
    INSERT INTO documents (id, envelope_id, name, page_count, s3_key, status)
    VALUES ($1, $2, $3, $4, $5, 'ready')
    RETURNING *
  `, [documentId, envelopeId, file.originalname, pageCount, s3Key])

  return document.rows[0]
}

async function addField(documentId, field) {
  const { type, pageNumber, x, y, width, height, recipientId, required } = field

  const fieldRecord = await db.query(`
    INSERT INTO document_fields
      (id, document_id, type, page_number, x, y, width, height, recipient_id, required)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `, [uuid(), documentId, type, pageNumber, x, y, width, height, recipientId, required])

  // Log for audit
  await auditLog(documentId, 'field_added', { field: fieldRecord.rows[0] })

  return fieldRecord.rows[0]
}
```

### 2. Workflow Engine

**State Machine for Signing:**
```javascript
const ENVELOPE_STATES = {
  draft: ['sent', 'voided'],
  sent: ['delivered', 'voided'],
  delivered: ['signed', 'declined', 'voided'],
  signed: ['completed'], // When all recipients sign
  declined: [],
  voided: [],
  completed: []
}

class WorkflowEngine {
  async sendEnvelope(envelopeId) {
    const envelope = await getEnvelope(envelopeId)

    if (envelope.status !== 'draft') {
      throw new Error('Can only send draft envelopes')
    }

    // Validate all required fields have recipients
    await this.validateEnvelope(envelope)

    // Transition state
    await this.transitionState(envelopeId, 'sent')

    // Determine first recipient(s)
    const firstRecipients = await this.getNextRecipients(envelopeId)

    // Send notifications
    for (const recipient of firstRecipients) {
      await this.notifyRecipient(recipient)
    }

    return envelope
  }

  async getNextRecipients(envelopeId) {
    // Get routing order
    const recipients = await db.query(`
      SELECT * FROM recipients
      WHERE envelope_id = $1
      ORDER BY routing_order ASC
    `, [envelopeId])

    // Find lowest incomplete routing order
    const pending = recipients.rows.filter(r => r.status === 'pending')
    if (pending.length === 0) return []

    const nextOrder = pending[0].routing_order

    // Return all recipients at that order (parallel signing)
    return pending.filter(r => r.routing_order === nextOrder)
  }

  async completeRecipient(recipientId) {
    const recipient = await db.query(`
      UPDATE recipients SET status = 'completed', completed_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [recipientId])

    // Check if all recipients at this order are done
    const siblings = await db.query(`
      SELECT * FROM recipients
      WHERE envelope_id = $1 AND routing_order = $2
    `, [recipient.rows[0].envelope_id, recipient.rows[0].routing_order])

    const allComplete = siblings.rows.every(r => r.status === 'completed')

    if (allComplete) {
      // Move to next recipients
      const nextRecipients = await this.getNextRecipients(recipient.rows[0].envelope_id)

      if (nextRecipients.length === 0) {
        // All done, complete envelope
        await this.completeEnvelope(recipient.rows[0].envelope_id)
      } else {
        for (const next of nextRecipients) {
          await this.notifyRecipient(next)
        }
      }
    }
  }

  async completeEnvelope(envelopeId) {
    await this.transitionState(envelopeId, 'completed')

    // Generate signed document with flattened fields
    await this.generateCompletedDocument(envelopeId)

    // Generate certificate of completion
    await this.generateCertificate(envelopeId)

    // Notify all parties
    await this.notifyCompletion(envelopeId)
  }
}
```

### 3. Signature Capture

**Electronic Signature:**
```javascript
async function captureSignature(recipientId, fieldId, signatureData) {
  const recipient = await getRecipient(recipientId)
  const field = await getField(fieldId)

  // Verify recipient owns this field
  if (field.recipient_id !== recipientId) {
    throw new Error('Unauthorized')
  }

  // Validate signature data
  let signatureImage
  if (signatureData.type === 'draw') {
    signatureImage = signatureData.imageData // Base64 PNG from canvas
  } else if (signatureData.type === 'typed') {
    signatureImage = await renderTypedSignature(signatureData.text, signatureData.font)
  } else if (signatureData.type === 'upload') {
    signatureImage = signatureData.uploadedImage
  }

  // Store signature
  const signatureId = uuid()
  const s3Key = `signatures/${signatureId}.png`
  await s3.upload({
    Bucket: 'docusign-signatures',
    Key: s3Key,
    Body: Buffer.from(signatureImage.split(',')[1], 'base64'),
    ContentType: 'image/png',
    ServerSideEncryption: 'aws:kms'
  }).promise()

  // Create signature record
  await db.query(`
    INSERT INTO signatures (id, recipient_id, field_id, s3_key, type, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
  `, [signatureId, recipientId, fieldId, s3Key, signatureData.type])

  // Mark field as completed
  await db.query(`
    UPDATE document_fields SET completed = true, signature_id = $2
    WHERE id = $1
  `, [fieldId, signatureId])

  // Comprehensive audit log
  await auditLog(field.document_id, 'signature_captured', {
    recipientId,
    fieldId,
    signatureId,
    ipAddress: signatureData.ipAddress,
    userAgent: signatureData.userAgent,
    timestamp: new Date().toISOString(),
    geolocation: signatureData.geolocation
  })

  // Check if recipient has completed all fields
  await checkRecipientCompletion(recipientId)

  return { signatureId }
}

async function checkRecipientCompletion(recipientId) {
  const incompleteFields = await db.query(`
    SELECT COUNT(*) as count FROM document_fields
    WHERE recipient_id = $1 AND required = true AND completed = false
  `, [recipientId])

  if (parseInt(incompleteFields.rows[0].count) === 0) {
    await workflowEngine.completeRecipient(recipientId)
  }
}
```

### 4. Tamper-Proof Audit Trail

**Immutable Event Log:**
```javascript
class AuditService {
  async log(envelopeId, eventType, data) {
    const event = {
      id: uuid(),
      envelopeId,
      eventType,
      data,
      timestamp: new Date().toISOString(),
      actor: data.recipientId || data.userId || 'system'
    }

    // Calculate hash including previous event
    const previousEvent = await this.getLastEvent(envelopeId)
    const previousHash = previousEvent?.hash || '0'.repeat(64)

    event.previousHash = previousHash
    event.hash = this.calculateHash(event)

    // Store in append-only log
    await db.query(`
      INSERT INTO audit_events
        (id, envelope_id, event_type, data, timestamp, actor, previous_hash, hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [event.id, envelopeId, eventType, JSON.stringify(data),
        event.timestamp, event.actor, previousHash, event.hash])

    // Also store in Elasticsearch for search
    await elasticsearch.index({
      index: 'audit-events',
      body: event
    })

    return event
  }

  calculateHash(event) {
    const payload = JSON.stringify({
      id: event.id,
      envelopeId: event.envelopeId,
      eventType: event.eventType,
      data: event.data,
      timestamp: event.timestamp,
      previousHash: event.previousHash
    })

    return crypto.createHash('sha256').update(payload).digest('hex')
  }

  async verifyChain(envelopeId) {
    const events = await db.query(`
      SELECT * FROM audit_events
      WHERE envelope_id = $1
      ORDER BY timestamp ASC
    `, [envelopeId])

    let previousHash = '0'.repeat(64)

    for (const event of events.rows) {
      // Verify previous hash link
      if (event.previous_hash !== previousHash) {
        return { valid: false, error: 'Chain broken', eventId: event.id }
      }

      // Verify event hash
      const calculatedHash = this.calculateHash({
        id: event.id,
        envelopeId: event.envelope_id,
        eventType: event.event_type,
        data: event.data,
        timestamp: event.timestamp,
        previousHash: event.previous_hash
      })

      if (calculatedHash !== event.hash) {
        return { valid: false, error: 'Hash mismatch', eventId: event.id }
      }

      previousHash = event.hash
    }

    return { valid: true }
  }

  async generateCertificate(envelopeId) {
    const events = await db.query(`
      SELECT * FROM audit_events
      WHERE envelope_id = $1
      ORDER BY timestamp ASC
    `, [envelopeId])

    const certificate = {
      envelopeId,
      documentName: await this.getDocumentName(envelopeId),
      completedAt: new Date().toISOString(),
      signers: [],
      events: events.rows.map(e => ({
        time: e.timestamp,
        action: e.event_type,
        actor: e.actor,
        details: this.formatEventDetails(e)
      })),
      chainVerified: (await this.verifyChain(envelopeId)).valid
    }

    // Add signer details
    const recipients = await db.query(`
      SELECT * FROM recipients WHERE envelope_id = $1 AND status = 'completed'
    `, [envelopeId])

    for (const r of recipients.rows) {
      certificate.signers.push({
        name: r.name,
        email: r.email,
        signedAt: r.completed_at,
        ipAddress: r.ip_address
      })
    }

    // Generate PDF certificate
    const pdfBytes = await this.renderCertificatePDF(certificate)

    // Store certificate
    const s3Key = `envelopes/${envelopeId}/certificate.pdf`
    await s3.upload({
      Bucket: 'docusign-documents',
      Key: s3Key,
      Body: pdfBytes,
      ContentType: 'application/pdf'
    }).promise()

    return certificate
  }
}
```

### 5. Recipient Authentication

**Multi-Factor Verification:**
```javascript
async function authenticateRecipient(recipientId, method) {
  const recipient = await getRecipient(recipientId)
  const envelope = await getEnvelope(recipient.envelope_id)

  // Check required authentication level
  const requiredAuth = envelope.authentication_level || 'email'

  switch (requiredAuth) {
    case 'email':
      // Email link is sufficient
      return { authenticated: true }

    case 'sms':
      return await smsVerification(recipient)

    case 'knowledge':
      return await knowledgeBasedAuth(recipient)

    case 'id_verification':
      return await idVerification(recipient)
  }
}

async function smsVerification(recipient) {
  // Generate and send code
  const code = crypto.randomInt(100000, 999999).toString()

  await redis.setex(`sms_code:${recipient.id}`, 300, code) // 5 min expiry

  await smsService.send(recipient.phone, `Your DocuSign code is: ${code}`)

  return { requiresCode: true, method: 'sms' }
}

async function verifySMSCode(recipientId, code) {
  const stored = await redis.get(`sms_code:${recipientId}`)

  if (stored === code) {
    await redis.del(`sms_code:${recipientId}`)
    await auditLog(recipientId, 'sms_verified', { success: true })
    return { authenticated: true }
  }

  await auditLog(recipientId, 'sms_verified', { success: false })
  return { authenticated: false, error: 'Invalid code' }
}

async function knowledgeBasedAuth(recipient) {
  // Fetch KBA questions from identity service
  const questions = await identityService.getKBAQuestions(recipient.email)

  return {
    requiresKBA: true,
    questions: questions.map(q => ({
      id: q.id,
      question: q.question,
      options: q.options
    }))
  }
}
```

---

## Database Schema

```sql
-- Envelopes (signing packages)
CREATE TABLE envelopes (
  id UUID PRIMARY KEY,
  sender_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  status VARCHAR(30) DEFAULT 'draft',
  authentication_level VARCHAR(30) DEFAULT 'email',
  expiration_date TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Recipients
CREATE TABLE recipients (
  id UUID PRIMARY KEY,
  envelope_id UUID REFERENCES envelopes(id),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL,
  role VARCHAR(50) DEFAULT 'signer', -- 'signer', 'cc', 'in_person'
  routing_order INTEGER DEFAULT 1,
  status VARCHAR(30) DEFAULT 'pending',
  access_code VARCHAR(100), -- Encrypted
  ip_address VARCHAR(50),
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Documents
CREATE TABLE documents (
  id UUID PRIMARY KEY,
  envelope_id UUID REFERENCES envelopes(id),
  name VARCHAR(200) NOT NULL,
  page_count INTEGER,
  s3_key VARCHAR(500) NOT NULL,
  status VARCHAR(30) DEFAULT 'processing',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Document Fields
CREATE TABLE document_fields (
  id UUID PRIMARY KEY,
  document_id UUID REFERENCES documents(id),
  recipient_id UUID REFERENCES recipients(id),
  type VARCHAR(30) NOT NULL, -- 'signature', 'initial', 'date', 'text', 'checkbox'
  page_number INTEGER NOT NULL,
  x DECIMAL NOT NULL,
  y DECIMAL NOT NULL,
  width DECIMAL NOT NULL,
  height DECIMAL NOT NULL,
  required BOOLEAN DEFAULT TRUE,
  completed BOOLEAN DEFAULT FALSE,
  value TEXT,
  signature_id UUID REFERENCES signatures(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Signatures
CREATE TABLE signatures (
  id UUID PRIMARY KEY,
  recipient_id UUID REFERENCES recipients(id),
  field_id UUID REFERENCES document_fields(id),
  s3_key VARCHAR(500) NOT NULL,
  type VARCHAR(30) NOT NULL, -- 'draw', 'typed', 'upload'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit Events (append-only)
CREATE TABLE audit_events (
  id UUID PRIMARY KEY,
  envelope_id UUID REFERENCES envelopes(id),
  event_type VARCHAR(50) NOT NULL,
  data JSONB,
  timestamp TIMESTAMP NOT NULL,
  actor VARCHAR(100),
  previous_hash VARCHAR(64) NOT NULL,
  hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_envelope ON audit_events(envelope_id, timestamp);

-- Templates
CREATE TABLE templates (
  id UUID PRIMARY KEY,
  owner_id UUID REFERENCES users(id),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  document_s3_key VARCHAR(500),
  fields JSONB, -- Template fields without recipients
  created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Key Design Decisions

### 1. Hash Chain for Audit Trail

**Decision**: Link audit events with cryptographic hashes

**Rationale**:
- Tamper-evident (any modification breaks chain)
- Legally defensible
- Verifiable integrity

### 2. Workflow State Machine

**Decision**: Explicit state machine with allowed transitions

**Rationale**:
- Clear business rules
- Prevents invalid states
- Easy to audit and debug

### 3. Separate Signature Storage

**Decision**: Store signatures in separate bucket with encryption

**Rationale**:
- Independent retention policies
- Enhanced security
- Separation of concerns

---

## Trade-offs Summary

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| Audit integrity | Hash chain | Simple logging | Legal compliance |
| Document storage | S3 with KMS | Database BLOBs | Scale, durability |
| Workflow | State machine | Event-driven | Clarity, validation |
| Authentication | Multi-factor | Email only | Security, compliance |

---

## Consistency and Idempotency Semantics

### Consistency Model

**Strong Consistency (PostgreSQL):**
- All envelope state transitions, recipient status updates, and signature captures use PostgreSQL transactions
- Read-after-write consistency for signing ceremonies ensures signers see their own updates immediately
- The workflow state machine relies on strong consistency to prevent double-signing or invalid transitions

**Eventual Consistency (Elasticsearch, Redis):**
- Audit log indexing in Elasticsearch is eventually consistent (typically <1 second lag)
- Search results for envelope history may lag behind writes
- Redis session cache invalidation propagates within 100ms

```javascript
// Envelope state transition with strong consistency
async function transitionState(envelopeId, newStatus, idempotencyKey) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    // Check for duplicate request using idempotency key
    const existing = await client.query(`
      SELECT * FROM idempotency_keys
      WHERE key = $1 AND created_at > NOW() - INTERVAL '24 hours'
    `, [idempotencyKey])

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK')
      return existing.rows[0].response  // Return cached response
    }

    // Lock envelope row for update
    const envelope = await client.query(`
      SELECT * FROM envelopes WHERE id = $1 FOR UPDATE
    `, [envelopeId])

    if (!envelope.rows[0]) {
      throw new Error('Envelope not found')
    }

    const currentStatus = envelope.rows[0].status
    const allowedTransitions = ENVELOPE_STATES[currentStatus]

    if (!allowedTransitions.includes(newStatus)) {
      throw new Error(`Invalid transition: ${currentStatus} -> ${newStatus}`)
    }

    // Perform update
    const result = await client.query(`
      UPDATE envelopes SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [envelopeId, newStatus])

    // Store idempotency key with response
    await client.query(`
      INSERT INTO idempotency_keys (key, response, created_at)
      VALUES ($1, $2, NOW())
    `, [idempotencyKey, JSON.stringify(result.rows[0])])

    await client.query('COMMIT')
    return result.rows[0]
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
```

### Idempotency for Core Operations

**Idempotency Key Table:**
```sql
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Auto-cleanup old keys (run daily)
CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
```

**Operations with Idempotency:**

| Operation | Idempotency Key Format | Replay Behavior |
|-----------|----------------------|-----------------|
| Send envelope | `send:{envelopeId}:{userId}` | Return original response |
| Capture signature | `sig:{fieldId}:{recipientId}` | Return existing signature |
| Complete recipient | `complete:{recipientId}` | Return existing completion |
| State transition | `transition:{envelopeId}:{newStatus}` | Return cached result |

**Conflict Resolution:**

```javascript
// Signature capture with conflict detection
async function captureSignatureWithConflict(recipientId, fieldId, signatureData, idempotencyKey) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')

    // Check idempotency first
    const idempotent = await checkIdempotency(client, idempotencyKey)
    if (idempotent) return idempotent

    // Lock the field to prevent concurrent signing
    const field = await client.query(`
      SELECT * FROM document_fields WHERE id = $1 FOR UPDATE
    `, [fieldId])

    if (field.rows[0].completed) {
      // Already signed - conflict
      await client.query('ROLLBACK')
      throw new ConflictError('Field already signed', {
        existingSignatureId: field.rows[0].signature_id
      })
    }

    // Proceed with signature capture
    const signatureId = await createSignature(client, recipientId, fieldId, signatureData)

    await storeIdempotency(client, idempotencyKey, { signatureId })
    await client.query('COMMIT')

    return { signatureId }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
```

---

## Async Queue Architecture (RabbitMQ)

### Queue Topology

For local development, we use RabbitMQ with a simple topology that supports fanout, background jobs, and backpressure.

```
┌─────────────────────────────────────────────────────────────────┐
│                     RabbitMQ Exchange                           │
├─────────────────┬─────────────────────┬─────────────────────────┤
│  docusign.direct│  docusign.fanout    │  docusign.delayed       │
│  (direct)       │  (fanout)           │  (x-delayed-message)    │
└────────┬────────┴──────────┬──────────┴────────────┬────────────┘
         │                   │                       │
    ┌────▼────┐         ┌────▼────┐            ┌────▼────┐
    │ workflow │         │broadcast│            │ delayed │
    │  queue   │         │ queue   │            │  queue  │
    └────┬────┘         └────┬────┘            └────┬────┘
         │                   │                       │
    ┌────▼────┐         ┌────▼────┐            ┌────▼────┐
    │Workflow │         │Notifier │            │Reminder │
    │ Worker  │         │ Worker  │            │ Worker  │
    └─────────┘         └─────────┘            └─────────┘
```

### Queue Configuration

```javascript
// queue/setup.js
const amqp = require('amqplib')

const QUEUES = {
  WORKFLOW: 'docusign.workflow',
  NOTIFICATIONS: 'docusign.notifications',
  EMAIL: 'docusign.email',
  PDF_PROCESSING: 'docusign.pdf',
  REMINDERS: 'docusign.reminders',
  DEAD_LETTER: 'docusign.dlq'
}

async function setupQueues(channel) {
  // Dead letter exchange for failed messages
  await channel.assertExchange('docusign.dlx', 'direct', { durable: true })
  await channel.assertQueue(QUEUES.DEAD_LETTER, {
    durable: true,
    arguments: { 'x-message-ttl': 7 * 24 * 60 * 60 * 1000 } // 7 days
  })
  await channel.bindQueue(QUEUES.DEAD_LETTER, 'docusign.dlx', '')

  // Main exchanges
  await channel.assertExchange('docusign.direct', 'direct', { durable: true })
  await channel.assertExchange('docusign.fanout', 'fanout', { durable: true })

  // Workflow queue - processes state transitions
  await channel.assertQueue(QUEUES.WORKFLOW, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'docusign.dlx',
      'x-max-length': 10000  // Backpressure: max queue size
    }
  })
  await channel.bindQueue(QUEUES.WORKFLOW, 'docusign.direct', 'workflow')

  // Notifications queue - triggers email/SMS
  await channel.assertQueue(QUEUES.NOTIFICATIONS, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'docusign.dlx',
      'x-max-length': 50000
    }
  })
  await channel.bindQueue(QUEUES.NOTIFICATIONS, 'docusign.direct', 'notification')

  // Email queue - actual email sending
  await channel.assertQueue(QUEUES.EMAIL, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'docusign.dlx',
      'x-max-length': 100000
    }
  })
  await channel.bindQueue(QUEUES.EMAIL, 'docusign.direct', 'email')

  // PDF processing queue - document rendering, flattening
  await channel.assertQueue(QUEUES.PDF_PROCESSING, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'docusign.dlx',
      'x-max-length': 5000
    }
  })
  await channel.bindQueue(QUEUES.PDF_PROCESSING, 'docusign.direct', 'pdf')

  // Reminders queue - scheduled reminder checks
  await channel.assertQueue(QUEUES.REMINDERS, {
    durable: true,
    arguments: {
      'x-dead-letter-exchange': 'docusign.dlx'
    }
  })

  console.log('RabbitMQ queues configured')
}
```

### Message Publishing with Delivery Guarantees

```javascript
// queue/publisher.js
class QueuePublisher {
  constructor(channel) {
    this.channel = channel
    this.confirmChannel = null
  }

  async initConfirmMode() {
    // Publisher confirms for guaranteed delivery
    this.confirmChannel = await this.channel.connection.createConfirmChannel()
  }

  async publishWorkflowEvent(event, options = {}) {
    const message = {
      id: uuid(),
      type: event.type,
      envelopeId: event.envelopeId,
      data: event.data,
      timestamp: new Date().toISOString(),
      idempotencyKey: event.idempotencyKey || `${event.type}:${event.envelopeId}:${Date.now()}`
    }

    return new Promise((resolve, reject) => {
      this.confirmChannel.publish(
        'docusign.direct',
        'workflow',
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,  // Survive broker restart
          messageId: message.id,
          headers: {
            'x-idempotency-key': message.idempotencyKey,
            'x-retry-count': 0
          }
        },
        (err) => {
          if (err) {
            reject(new Error('Message not confirmed by broker'))
          } else {
            resolve(message.id)
          }
        }
      )
    })
  }

  async publishNotification(notification) {
    const message = {
      id: uuid(),
      recipientId: notification.recipientId,
      type: notification.type,  // 'signing_request', 'reminder', 'completed'
      envelopeId: notification.envelopeId,
      channels: notification.channels || ['email'],  // 'email', 'sms'
      timestamp: new Date().toISOString()
    }

    await this.confirmChannel.publish(
      'docusign.direct',
      'notification',
      Buffer.from(JSON.stringify(message)),
      { persistent: true, messageId: message.id }
    )
  }

  async scheduledReminder(envelopeId, delayMs) {
    // Use RabbitMQ delayed message plugin for local dev
    // In production, use a scheduler like node-cron or pg-boss
    const message = {
      id: uuid(),
      type: 'check_reminder',
      envelopeId,
      scheduledFor: new Date(Date.now() + delayMs).toISOString()
    }

    await this.channel.publish(
      'docusign.direct',
      'reminder',
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        headers: { 'x-delay': delayMs }
      }
    )
  }
}
```

### Consumer with Backpressure and Acknowledgment

```javascript
// queue/consumer.js
class WorkflowConsumer {
  constructor(channel, concurrency = 5) {
    this.channel = channel
    this.concurrency = concurrency
  }

  async start() {
    // Prefetch limits concurrent message processing (backpressure)
    await this.channel.prefetch(this.concurrency)

    await this.channel.consume('docusign.workflow', async (msg) => {
      if (!msg) return

      const startTime = Date.now()
      const message = JSON.parse(msg.content.toString())
      const retryCount = msg.properties.headers['x-retry-count'] || 0

      try {
        // Check idempotency before processing
        const processed = await this.checkProcessed(message.idempotencyKey)
        if (processed) {
          console.log(`Duplicate message ignored: ${message.id}`)
          this.channel.ack(msg)
          return
        }

        // Process the workflow event
        await this.processEvent(message)

        // Mark as processed
        await this.markProcessed(message.idempotencyKey, message.id)

        // Acknowledge success
        this.channel.ack(msg)

        console.log(`Processed ${message.type} in ${Date.now() - startTime}ms`)
      } catch (error) {
        console.error(`Error processing message ${message.id}:`, error)

        if (retryCount < 3) {
          // Requeue with incremented retry count
          this.channel.nack(msg, false, false)  // Don't requeue directly

          // Republish with delay and retry count
          await this.republishWithRetry(message, retryCount + 1)
        } else {
          // Max retries exceeded, send to DLQ
          console.error(`Message ${message.id} sent to DLQ after ${retryCount} retries`)
          this.channel.nack(msg, false, false)  // Goes to DLQ via dead letter exchange
        }
      }
    })
  }

  async republishWithRetry(message, retryCount) {
    const delay = Math.min(1000 * Math.pow(2, retryCount), 60000)  // Exponential backoff, max 60s

    await this.channel.publish(
      'docusign.direct',
      'workflow',
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        headers: {
          'x-idempotency-key': message.idempotencyKey,
          'x-retry-count': retryCount,
          'x-delay': delay
        }
      }
    )
  }

  async processEvent(message) {
    switch (message.type) {
      case 'envelope_sent':
        await this.handleEnvelopeSent(message)
        break
      case 'recipient_completed':
        await this.handleRecipientCompleted(message)
        break
      case 'envelope_completed':
        await this.handleEnvelopeCompleted(message)
        break
      default:
        console.warn(`Unknown event type: ${message.type}`)
    }
  }

  async checkProcessed(idempotencyKey) {
    const result = await redis.get(`processed:${idempotencyKey}`)
    return result !== null
  }

  async markProcessed(idempotencyKey, messageId) {
    // Keep for 24 hours
    await redis.setex(`processed:${idempotencyKey}`, 86400, messageId)
  }
}
```

### Delivery Semantics Summary

| Queue | Semantics | Reasoning |
|-------|-----------|-----------|
| workflow | At-least-once | State transitions are idempotent |
| notifications | At-least-once | Duplicate notification is acceptable |
| email | At-least-once | External email APIs handle dedup |
| pdf | At-least-once | PDF generation is idempotent |
| reminders | At-most-once | Missing reminder is acceptable |

---

## Failure Handling

### Retry Strategy with Idempotency Keys

```javascript
// shared/retry.js
class RetryableOperation {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3
    this.baseDelay = options.baseDelay || 1000
    this.maxDelay = options.maxDelay || 30000
  }

  async execute(operation, idempotencyKey) {
    let lastError
    let attempt = 0

    while (attempt < this.maxRetries) {
      try {
        // Check if already succeeded
        const cached = await redis.get(`idempotent:${idempotencyKey}`)
        if (cached) {
          return JSON.parse(cached)
        }

        const result = await operation()

        // Cache successful result
        await redis.setex(`idempotent:${idempotencyKey}`, 86400, JSON.stringify(result))

        return result
      } catch (error) {
        lastError = error
        attempt++

        if (!this.isRetryable(error)) {
          throw error
        }

        if (attempt < this.maxRetries) {
          const delay = Math.min(
            this.baseDelay * Math.pow(2, attempt) + Math.random() * 1000,
            this.maxDelay
          )
          await this.sleep(delay)
        }
      }
    }

    throw lastError
  }

  isRetryable(error) {
    // Network errors, timeouts, and 5xx are retryable
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true
    if (error.response?.status >= 500) return true
    if (error.message.includes('deadlock')) return true
    return false
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// Usage example
const retryable = new RetryableOperation({ maxRetries: 3 })

async function sendEnvelopeWithRetry(envelopeId, userId) {
  const idempotencyKey = `send:${envelopeId}:${userId}`

  return retryable.execute(async () => {
    return await workflowEngine.sendEnvelope(envelopeId)
  }, idempotencyKey)
}
```

### Circuit Breaker Pattern

```javascript
// shared/circuitBreaker.js
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'default'
    this.failureThreshold = options.failureThreshold || 5
    this.successThreshold = options.successThreshold || 2
    this.timeout = options.timeout || 30000  // 30 seconds open state

    this.state = 'CLOSED'  // CLOSED, OPEN, HALF_OPEN
    this.failures = 0
    this.successes = 0
    this.lastFailure = null
    this.nextRetry = null
  }

  async execute(operation, fallback = null) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextRetry) {
        console.log(`Circuit ${this.name} is OPEN, using fallback`)
        if (fallback) return fallback()
        throw new Error(`Circuit ${this.name} is open`)
      }
      // Try to recover
      this.state = 'HALF_OPEN'
      console.log(`Circuit ${this.name} transitioning to HALF_OPEN`)
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      if (fallback && this.state === 'OPEN') {
        return fallback()
      }
      throw error
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      this.successes++
      if (this.successes >= this.successThreshold) {
        this.reset()
        console.log(`Circuit ${this.name} CLOSED after recovery`)
      }
    } else {
      this.failures = 0
    }
  }

  onFailure() {
    this.failures++
    this.lastFailure = Date.now()

    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      this.nextRetry = Date.now() + this.timeout
      console.log(`Circuit ${this.name} OPENED after ${this.failures} failures`)
    }
  }

  reset() {
    this.state = 'CLOSED'
    this.failures = 0
    this.successes = 0
    this.lastFailure = null
    this.nextRetry = null
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      lastFailure: this.lastFailure,
      nextRetry: this.nextRetry
    }
  }
}

// Circuit breakers for external services
const circuits = {
  email: new CircuitBreaker({ name: 'email', failureThreshold: 3, timeout: 60000 }),
  sms: new CircuitBreaker({ name: 'sms', failureThreshold: 5, timeout: 120000 }),
  s3: new CircuitBreaker({ name: 's3', failureThreshold: 3, timeout: 30000 }),
  elasticsearch: new CircuitBreaker({ name: 'elasticsearch', failureThreshold: 5, timeout: 60000 })
}

// Example: S3 upload with circuit breaker
async function uploadToS3(bucket, key, body) {
  return circuits.s3.execute(
    async () => {
      return await s3.upload({ Bucket: bucket, Key: key, Body: body }).promise()
    },
    () => {
      // Fallback: queue for retry later
      return queuePublisher.publishPDFJob({
        type: 's3_upload_retry',
        bucket, key, body: body.toString('base64')
      })
    }
  )
}
```

### Local Development Disaster Recovery

For a local learning project, we simulate multi-region DR concepts on a single machine.

**Backup Strategy:**

```bash
# scripts/backup.sh - PostgreSQL backup
#!/bin/bash
BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p $BACKUP_DIR

# Database backup
pg_dump -h localhost -U docusign -d docusign_db -F c -f "$BACKUP_DIR/db.dump"

# MinIO backup (sync to local folder)
mc mirror minio/docusign-documents "$BACKUP_DIR/documents/"
mc mirror minio/docusign-signatures "$BACKUP_DIR/signatures/"

# Redis backup (RDB snapshot)
redis-cli BGSAVE
cp /var/lib/redis/dump.rdb "$BACKUP_DIR/redis.rdb"

echo "Backup completed: $BACKUP_DIR"
```

**Restore Testing:**

```bash
# scripts/restore-test.sh - Verify backup can be restored
#!/bin/bash
BACKUP_DIR=$1
TEST_DB="docusign_restore_test"

echo "Testing restore from $BACKUP_DIR..."

# Create test database
createdb -h localhost -U docusign $TEST_DB

# Restore database
pg_restore -h localhost -U docusign -d $TEST_DB "$BACKUP_DIR/db.dump"

# Verify critical tables
psql -h localhost -U docusign -d $TEST_DB -c "
SELECT
  (SELECT COUNT(*) FROM envelopes) as envelopes,
  (SELECT COUNT(*) FROM documents) as documents,
  (SELECT COUNT(*) FROM signatures) as signatures,
  (SELECT COUNT(*) FROM audit_events) as audit_events;
"

# Verify audit chain integrity
psql -h localhost -U docusign -d $TEST_DB -c "
SELECT envelope_id, COUNT(*) as events,
       CASE WHEN COUNT(*) = COUNT(DISTINCT hash) THEN 'OK' ELSE 'CORRUPTED' END as chain_status
FROM audit_events
GROUP BY envelope_id;
"

# Cleanup
dropdb -h localhost -U docusign $TEST_DB

echo "Restore test completed"
```

**docker-compose.yml additions for local DR simulation:**

```yaml
services:
  postgres-primary:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      POSTGRES_DB: docusign_db
      POSTGRES_USER: docusign
      POSTGRES_PASSWORD: docusign123
    volumes:
      - postgres-primary-data:/var/lib/postgresql/data

  postgres-replica:
    image: postgres:16
    ports:
      - "5433:5432"
    environment:
      POSTGRES_DB: docusign_db
      POSTGRES_USER: docusign
      POSTGRES_PASSWORD: docusign123
    volumes:
      - postgres-replica-data:/var/lib/postgresql/data
    # In production: configure streaming replication
    # For learning: manual sync with pg_dump/pg_restore

  rabbitmq:
    image: rabbitmq:3-management
    ports:
      - "5672:5672"
      - "15672:15672"
    environment:
      RABBITMQ_DEFAULT_USER: docusign
      RABBITMQ_DEFAULT_PASS: docusign123
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq

volumes:
  postgres-primary-data:
  postgres-replica-data:
  rabbitmq-data:
```

### Graceful Degradation

```javascript
// shared/degradation.js
class GracefulDegradation {
  constructor() {
    this.degradedFeatures = new Set()
  }

  async withFallback(feature, primary, fallback) {
    if (this.degradedFeatures.has(feature)) {
      console.log(`Feature ${feature} degraded, using fallback`)
      return fallback()
    }

    try {
      return await primary()
    } catch (error) {
      console.error(`Feature ${feature} failed, degrading:`, error.message)
      this.degradedFeatures.add(feature)

      // Auto-recover after 5 minutes
      setTimeout(() => {
        this.degradedFeatures.delete(feature)
        console.log(`Feature ${feature} recovery attempted`)
      }, 5 * 60 * 1000)

      return fallback()
    }
  }
}

const degradation = new GracefulDegradation()

// Example: Elasticsearch search with DB fallback
async function searchEnvelopes(userId, query) {
  return degradation.withFallback(
    'elasticsearch_search',
    // Primary: Elasticsearch
    async () => {
      return await elasticsearch.search({
        index: 'envelopes',
        body: { query: { bool: { must: [
          { term: { sender_id: userId } },
          { multi_match: { query, fields: ['name', 'recipients.email'] } }
        ]}}}
      })
    },
    // Fallback: PostgreSQL LIKE query (slower but functional)
    async () => {
      const result = await db.query(`
        SELECT e.* FROM envelopes e
        LEFT JOIN recipients r ON e.id = r.envelope_id
        WHERE e.sender_id = $1
          AND (e.name ILIKE $2 OR r.email ILIKE $2)
        LIMIT 50
      `, [userId, `%${query}%`])
      return result.rows
    }
  )
}
```

### Health Checks and Recovery

```javascript
// shared/health.js
async function healthCheck() {
  const checks = {
    postgres: await checkPostgres(),
    redis: await checkRedis(),
    rabbitmq: await checkRabbitMQ(),
    minio: await checkMinIO(),
    elasticsearch: await checkElasticsearch()
  }

  const healthy = Object.values(checks).every(c => c.status === 'healthy')

  return {
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks
  }
}

async function checkPostgres() {
  try {
    const start = Date.now()
    await db.query('SELECT 1')
    return { status: 'healthy', latencyMs: Date.now() - start }
  } catch (error) {
    return { status: 'unhealthy', error: error.message }
  }
}

async function checkRabbitMQ() {
  try {
    const start = Date.now()
    const conn = await amqp.connect(process.env.RABBITMQ_URL)
    await conn.close()
    return { status: 'healthy', latencyMs: Date.now() - start }
  } catch (error) {
    return { status: 'unhealthy', error: error.message }
  }
}

// Expose health endpoint
app.get('/health', async (req, res) => {
  const health = await healthCheck()
  res.status(health.status === 'healthy' ? 200 : 503).json(health)
})
```

---

## Implementation Notes

This section documents the production-readiness features implemented in the backend to address consistency, reliability, and compliance requirements.

### Why Idempotency is CRITICAL for Legal Document Signing

Idempotency ensures that executing the same operation multiple times produces the same result as executing it once. For electronic signature platforms, this is not just a nice-to-have - it is legally critical:

1. **Legal Validity**: Each signature must be unique and traceable. Under ESIGN Act (15 U.S.C. 7001) and UETA, an electronic signature must be "attributable to a person" and demonstrate the signer's "intent to sign." Duplicate signatures due to network retries could invalidate a document or create conflicting records.

2. **Network Reliability**: Mobile and web clients frequently retry requests due to network timeouts, connection resets, or user impatience. Without idempotency protection, a single signature action could be recorded multiple times.

3. **Audit Trail Integrity**: The hash-chain audit log requires exactly one entry per signing action. Duplicate entries would break chain verification and compromise legal defensibility.

4. **Financial/Legal Consequences**: Double-signing contracts could have severe consequences - agreeing to terms multiple times, double-counting approvals, or creating ambiguous legal standing.

**Implementation**: The `shared/idempotency.js` module provides:
- Redis-first lookups for fast duplicate detection
- PostgreSQL backup for durability across service restarts
- 24-hour key TTL to balance safety with storage efficiency
- Automatic key generation based on field ID, recipient ID, and time bucket

```javascript
// Example: Signature capture with idempotency
const { data: result, cached } = await executeWithIdempotency(
  generateSignatureIdempotencyKey(fieldId, recipientId),
  async () => { /* signature capture logic */ },
  'signature'
);

if (cached) {
  // Duplicate request - return cached response, log security event
}
```

### Why Audit Logging is Required for Legal Compliance

Electronic signatures are legally binding only when they can be proven to meet specific requirements. Audit logging provides the evidence trail:

1. **ESIGN Act (USA)**: Requires "accurate records" of electronic signatures including when and how they were captured.

2. **UETA (Uniform Electronic Transactions Act)**: Mandates that electronic records demonstrate integrity and attribution to the signatory.

3. **eIDAS (EU)**: Advanced electronic signatures must be "uniquely linked to the signatory," capable of identifying the signatory, and created using signature creation data under the signatory's sole control.

4. **SOC 2 Compliance**: Security controls and change management require comprehensive audit trails.

5. **Legal Disputes**: In contract disputes, the audit trail serves as evidence of who signed, when, from what IP address, and with what browser.

**Implementation**: The `shared/auditLogger.js` module provides:
- Hash-chain integrity (each event includes hash of previous event)
- Comprehensive event types covering all signature lifecycle actions
- Context capture (IP address, user agent, geolocation)
- Tamper-evident verification function
- Structured logging with pino for real-time monitoring

```javascript
// Example: Signature capture audit event
await logSignatureCapture({
  envelopeId,
  recipientId,
  recipientEmail,
  fieldId,
  signatureId,
  signatureType: 'draw',
  ipAddress: req.ip,
  userAgent: req.get('User-Agent'),
});
```

### Why Async Queues Enable Reliable Notification Delivery

Synchronous notification delivery (sending emails inline with signature capture) creates several reliability issues that message queues solve:

1. **Decoupling**: Separates the critical signing workflow from notification delivery. If the email service is slow or down, signatures are still captured successfully.

2. **Reliability**: Messages are persisted in RabbitMQ until acknowledged. Service restarts, deployments, or temporary failures don't lose notifications.

3. **Backpressure**: Queue limits (10,000 messages) prevent overwhelming downstream services. When the email service is slow, messages queue instead of causing cascading timeouts.

4. **Retry with Backoff**: Failed notifications are automatically retried with exponential backoff (1s, 2s, 4s, up to 60s). Dead letter queue catches persistent failures for manual review.

5. **Delivery Semantics**: At-least-once delivery ensures every notification eventually reaches recipients. Idempotent handlers on the consumer side prevent duplicates.

6. **Observability**: Queue metrics (depth, consumer count, processing rate) provide visibility into notification pipeline health.

**Implementation**: The `shared/queue.js` module provides:
- RabbitMQ integration with publisher confirms
- Dead letter exchange for failed messages
- Graceful fallback to synchronous delivery when queue is unavailable
- Queue health checks in the `/health` endpoint

```javascript
// Example: Async notification publish with fallback
if (isQueueHealthy()) {
  await publishNotification({
    type: 'signing_request',
    recipientId: recipient.id,
    envelopeId: envelope.id,
    channels: ['email'],
  });
} else {
  // Fallback to synchronous delivery
  await emailService.sendSigningRequest(recipient, envelope);
}
```

### Why Circuit Breakers Protect Document Storage

Document storage (MinIO/S3) is a critical dependency. Without protection, storage failures can cascade to bring down the entire application:

1. **Prevent Cascade Failures**: If MinIO is slow or unresponsive, without a circuit breaker all API threads would block waiting for timeouts. Eventually, the connection pool exhausts, memory fills with queued requests, and the entire application becomes unresponsive.

2. **Fail Fast**: When storage is known to be unavailable (circuit open), requests fail immediately instead of waiting for timeout. This preserves resources and provides better user experience (immediate error vs. hung request).

3. **Automatic Recovery**: The half-open state periodically tests if storage has recovered. When it succeeds, the circuit closes and normal operation resumes automatically.

4. **Graceful Degradation**: With fallback behaviors, the system can continue serving read operations from cache while writes are queued for retry.

5. **Resource Protection**: Prevents thread/connection exhaustion during storage outages, keeping other system components operational.

6. **Observability**: Circuit breaker state transitions are logged and exposed as Prometheus metrics, providing early warning of storage issues.

**Implementation**: The `shared/circuitBreaker.js` and `shared/storageWithBreaker.js` modules provide:
- Opossum-based circuit breakers for all storage operations
- 50% error threshold to open circuit
- 30-second timeout before trying half-open
- Prometheus metrics for circuit state
- Fallback support for non-critical operations

```javascript
// Example: Storage upload with circuit breaker
const uploadDocumentBreaker = createCircuitBreaker(
  'minio_upload_document',
  async (key, buffer, contentType) => {
    return await MinioOriginal.uploadDocument(key, buffer, contentType);
  },
  { timeout: 30000, errorThresholdPercentage: 50 }
);

// Usage - automatically opens circuit on repeated failures
await uploadDocumentBreaker.fire(key, buffer, 'application/pdf');
```

### Prometheus Metrics Endpoint

The `/metrics` endpoint exposes operational metrics in Prometheus format:

- **Document metrics**: `docusign_documents_total`, `docusign_envelopes_by_status`
- **Signature metrics**: `docusign_signatures_captured_total`, `docusign_signatures_pending`, `docusign_signatures_expired_total`
- **Queue metrics**: `docusign_queue_messages_published_total`, `docusign_queue_messages_processed_total`
- **Circuit breaker metrics**: `docusign_circuit_breaker_state`, `docusign_circuit_breaker_failures_total`
- **Storage metrics**: `docusign_storage_operation_duration_seconds`, `docusign_storage_operation_errors_total`
- **Idempotency metrics**: `docusign_idempotency_hits_total`, `docusign_idempotency_misses_total`
- **Audit metrics**: `docusign_audit_events_total`
- **HTTP metrics**: `docusign_http_request_duration_seconds`

### Health Check Endpoints

Three levels of health checks are available:

- **`/health/live`**: Liveness probe - always returns 200 if the process is running
- **`/health/ready`**: Readiness probe - checks PostgreSQL and Redis connectivity
- **`/health`**: Comprehensive health - checks all dependencies (PostgreSQL, Redis, MinIO, RabbitMQ) with latency measurements and circuit breaker states

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "version": "1.0.0",
  "uptime": 3600,
  "checks": {
    "postgres": { "status": "healthy", "latencyMs": 2 },
    "redis": { "status": "healthy", "latencyMs": 1 },
    "minio": { "status": "healthy", "latencyMs": 5, "circuitBreakers": {...} },
    "rabbitmq": { "status": "healthy", "queues": {...} }
  },
  "circuitBreakers": {
    "minio_upload_document": { "state": "closed", "stats": {...} }
  }
}
```

### Structured JSON Logging with Pino

All application logs use structured JSON format via pino, enabling:

- **Log aggregation**: Ship to ELK, Datadog, or CloudWatch
- **Correlation**: Request ID propagated through all log entries
- **Audit segregation**: Compliance-sensitive logs tagged with `type: "audit"`
- **Performance tracking**: Slow query detection with timing information
- **Development mode**: pino-pretty for human-readable output locally

```javascript
// Example log output
{
  "level": "info",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "service": "docusign-backend",
  "requestId": "abc123",
  "method": "POST",
  "path": "/api/v1/signing/sign/token123",
  "msg": "Signature captured successfully"
}
```

---

## Frontend Architecture

The frontend is built with React, TypeScript, Vite, and Tailwind CSS. It follows a modular component architecture designed for maintainability and reusability.

### Component Organization

```
frontend/src/
├── components/
│   ├── common/           # Reusable UI components
│   │   ├── StatusBadge.tsx      # Status indicator badges
│   │   ├── LoadingSpinner.tsx   # Loading states
│   │   ├── MessageBanner.tsx    # Error/success messages
│   │   └── index.ts             # Barrel export
│   │
│   ├── envelope/         # Envelope management components
│   │   ├── DocumentsTab.tsx     # Document upload/management
│   │   ├── RecipientsTab.tsx    # Recipient management
│   │   ├── FieldsTab.tsx        # Field placement orchestrator
│   │   ├── FieldsSidebar.tsx    # Field placement controls
│   │   ├── PdfViewer.tsx        # PDF rendering with overlays
│   │   ├── AuditTab.tsx         # Audit trail display
│   │   └── index.ts
│   │
│   ├── signing/          # Signing ceremony components
│   │   ├── SigningHeader.tsx    # Header with actions
│   │   ├── SigningSidebar.tsx   # Navigation and field list
│   │   ├── SigningPdfViewer.tsx # Interactive PDF viewer
│   │   ├── SignatureModal.tsx   # Signature capture modal
│   │   ├── SigningLoadingState.tsx
│   │   ├── SigningErrorState.tsx
│   │   └── index.ts
│   │
│   └── icons/            # SVG icon components
│       ├── PdfIcon.tsx
│       ├── CheckIcon.tsx
│       ├── CloseIcon.tsx
│       ├── WarningIcon.tsx
│       └── index.ts
│
├── routes/               # Page components (TanStack Router)
│   ├── envelopes/
│   │   ├── index.tsx            # Envelope list
│   │   ├── new.tsx              # Create envelope
│   │   └── $envelopeId.tsx      # Envelope detail (~440 lines)
│   ├── sign/
│   │   └── $accessToken.tsx     # Signing ceremony (~300 lines)
│   └── ...
│
├── stores/               # Zustand state management
│   ├── authStore.ts             # Authentication state
│   └── envelopeStore.ts         # Envelope data and actions
│
├── services/             # API client
│   └── api.ts                   # HTTP client with typed endpoints
│
└── types/                # TypeScript definitions
    └── index.ts
```

### Component Design Principles

1. **Single Responsibility**: Each component has one clear purpose
2. **Composition over Inheritance**: Small components composed into larger features
3. **Props-Down, Events-Up**: Parent components manage state, children receive data via props
4. **JSDoc Documentation**: All exported components and functions have JSDoc comments
5. **Barrel Exports**: Each component directory has an `index.ts` for clean imports

### Key Components

#### Common Components

| Component | Purpose | Props |
|-----------|---------|-------|
| `StatusBadge` | Display status with color coding | `status: string` |
| `LoadingSpinner` | Loading indicator | `size`, `centered`, `message` |
| `MessageBanner` | Error/success/info messages | `type`, `message`, `className` |

#### Envelope Components

| Component | Purpose | Lines |
|-----------|---------|-------|
| `DocumentsTab` | Document upload and list | ~100 |
| `RecipientsTab` | Add/remove recipients | ~130 |
| `FieldsTab` | Orchestrates field placement | ~120 |
| `FieldsSidebar` | Controls for field placement | ~210 |
| `PdfViewer` | PDF rendering with field overlays | ~95 |
| `AuditTab` | Hash-chain verified audit trail | ~100 |

#### Signing Components

| Component | Purpose | Lines |
|-----------|---------|-------|
| `SigningHeader` | Header with progress and actions | ~70 |
| `SigningSidebar` | Field navigation checklist | ~180 |
| `SigningPdfViewer` | Interactive PDF with clickable fields | ~95 |
| `SignatureModal` | Draw/type signature capture | ~230 |
| `SigningLoadingState` | Loading state display | ~15 |
| `SigningErrorState` | Error state display | ~25 |

### State Management

**Global State (Zustand)**:
- `authStore`: User authentication, session management
- `envelopeStore`: Current envelope data, CRUD operations

**Local State (React useState)**:
- UI state: active tab, modal visibility, form inputs
- Derived data: current page fields, completion status

### PDF Handling

The application uses `react-pdf` (PDF.js wrapper) for document rendering:

```typescript
// PDF.js worker configuration (required)
pdfjs.GlobalWorkerOptions.workerSrc =
  `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

// Document rendering with page navigation
<Document file={documentUrl} onLoadSuccess={({ numPages }) => setNumPages(numPages)}>
  <Page pageNumber={currentPage} width={700} />
</Document>
```

Field overlays are positioned absolutely over the PDF using CSS:

```css
.field-highlight {
  position: absolute;
  border: 2px dashed;
  background: rgba(255, 193, 7, 0.2);
  cursor: pointer;
}
```

### Signature Capture

The `SignatureModal` component supports two input modes:

1. **Draw Mode**: Uses `signature_pad` library for canvas-based drawing
2. **Type Mode**: Renders typed text to canvas with cursive font

Both modes output base64-encoded PNG images for storage.

### Route Structure

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | Landing | Home page |
| `/login` | Login | User authentication |
| `/register` | Register | User registration |
| `/envelopes` | EnvelopeList | List all envelopes |
| `/envelopes/new` | NewEnvelope | Create envelope |
| `/envelopes/:id` | EnvelopeDetail | Manage envelope |
| `/sign/:token` | SigningPage | Signing ceremony |
| `/admin` | Admin | Admin dashboard |

### Import Conventions

```typescript
// Barrel imports for cleaner code
import { StatusBadge, LoadingSpinner, MessageBanner } from '../../components/common';
import { DocumentsTab, RecipientsTab, FieldsTab, AuditTab } from '../../components/envelope';
import { SigningHeader, SigningSidebar, SignatureModal } from '../../components/signing';
import { PdfIcon, CheckIcon } from '../../components/icons';
```

### Performance Considerations

1. **Code Splitting**: Route-based splitting via TanStack Router
2. **PDF Worker**: Loaded asynchronously from CDN
3. **Memoization**: Consider `React.memo` for frequently re-rendered components
4. **Lazy Loading**: PDF pages loaded on demand
