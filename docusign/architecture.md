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
