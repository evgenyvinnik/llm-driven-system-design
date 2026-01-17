# Design DocuSign - System Design Interview Answer

## Introduction (2 minutes)

"Thank you for the opportunity. Today I'll design DocuSign, an electronic signature platform. DocuSign is fascinating because it combines:

1. Document processing and rendering across formats
2. Workflow orchestration for multi-party signing
3. Legal compliance requiring tamper-proof audit trails
4. Long-term document storage with cryptographic integrity

The unique challenge is building a system where every action is legally defensible and verifiable years later.

Let me clarify the requirements."

---

## Requirements Clarification (5 minutes)

### Functional Requirements

"For our core product:

1. **Upload**: Upload documents (primarily PDFs) for signing
2. **Prepare**: Add signature fields and assign to recipients
3. **Route**: Send to recipients in specified order (serial or parallel)
4. **Sign**: Capture legally binding electronic signatures
5. **Complete**: Generate final signed document with certificate of completion

The workflow engine and audit trail are the most technically interesting aspects."

### Non-Functional Requirements

"Electronic signatures have strict requirements:

- **Availability**: 99.99% for signing ceremonies - deals can't wait
- **Durability**: Documents stored for 10+ years with guaranteed integrity
- **Compliance**: ESIGN Act, UETA, eIDAS (EU) compliant
- **Security**: End-to-end encryption, SOC 2 Type II compliant

The durability requirement is unique - we need to prove a document hasn't been tampered with years after signing."

---

## High-Level Design (10 minutes)

### Architecture Overview

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

### Key Services

**Document Service**: Handles PDF upload, processing, field placement, and template management. Renders documents for the signing experience.

**Workflow Engine**: The state machine that orchestrates the signing process - who signs when, reminders, expirations.

**Signing Service**: Captures signatures, verifies recipient identity, and maintains the tamper-proof audit trail."

---

## Deep Dive: Document Processing (8 minutes)

### Upload and Processing

```javascript
async function processDocument(envelopeId, file) {
  // Validate PDF
  const pdfDoc = await PDFDocument.load(file.buffer)
  const pageCount = pdfDoc.getPageCount()

  // Store original document with encryption
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
```

Key points:
- Original PDF stored with KMS encryption
- Page images generated for the drag-and-drop field placement UI
- Each document belongs to an 'envelope' (the signing package)"

### Field Placement

```javascript
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

Field types include: signature, initials, date, text, checkbox. Each is assigned to a specific recipient."

---

## Deep Dive: Workflow Engine (12 minutes)

### State Machine

"The envelope (signing package) moves through defined states:

```javascript
const ENVELOPE_STATES = {
  draft: ['sent', 'voided'],
  sent: ['delivered', 'voided'],
  delivered: ['signed', 'declined', 'voided'],
  signed: ['completed'],  // When all recipients sign
  declined: [],
  voided: [],
  completed: []
}
```

Each state has allowed transitions. This prevents invalid states like going from 'completed' back to 'draft'."

### Workflow Orchestration

```javascript
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

    // Determine first recipient(s) based on routing order
    const firstRecipients = await this.getNextRecipients(envelopeId)

    // Send email notifications
    for (const recipient of firstRecipients) {
      await this.notifyRecipient(recipient)
    }

    return envelope
  }

  async getNextRecipients(envelopeId) {
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
}
```

The routing_order enables both serial (1, 2, 3) and parallel (all at order 1) signing patterns."

### Completing a Recipient

```javascript
async completeRecipient(recipientId) {
  const recipient = await db.query(`
    UPDATE recipients SET status = 'completed', completed_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [recipientId])

  // Check if all recipients at this routing order are done
  const siblings = await db.query(`
    SELECT * FROM recipients
    WHERE envelope_id = $1 AND routing_order = $2
  `, [recipient.rows[0].envelope_id, recipient.rows[0].routing_order])

  const allComplete = siblings.rows.every(r => r.status === 'completed')

  if (allComplete) {
    // Move to next recipients
    const nextRecipients = await this.getNextRecipients(recipient.rows[0].envelope_id)

    if (nextRecipients.length === 0) {
      // All done - complete the envelope
      await this.completeEnvelope(recipient.rows[0].envelope_id)
    } else {
      for (const next of nextRecipients) {
        await this.notifyRecipient(next)
      }
    }
  }
}
```"

### Envelope Completion

```javascript
async completeEnvelope(envelopeId) {
  await this.transitionState(envelopeId, 'completed')

  // Generate signed document with flattened fields
  await this.generateCompletedDocument(envelopeId)

  // Generate certificate of completion
  await this.generateCertificate(envelopeId)

  // Notify all parties
  await this.notifyCompletion(envelopeId)
}
```"

---

## Deep Dive: Signature Capture (8 minutes)

### Capturing a Signature

```javascript
async function captureSignature(recipientId, fieldId, signatureData) {
  const recipient = await getRecipient(recipientId)
  const field = await getField(fieldId)

  // Verify recipient owns this field
  if (field.recipient_id !== recipientId) {
    throw new Error('Unauthorized')
  }

  // Process signature based on type
  let signatureImage
  if (signatureData.type === 'draw') {
    signatureImage = signatureData.imageData  // Base64 PNG from canvas
  } else if (signatureData.type === 'typed') {
    signatureImage = await renderTypedSignature(signatureData.text, signatureData.font)
  } else if (signatureData.type === 'upload') {
    signatureImage = signatureData.uploadedImage
  }

  // Store signature with encryption
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

  // Check if recipient has completed all required fields
  await checkRecipientCompletion(recipientId)

  return { signatureId }
}
```

We capture extensive metadata (IP, user agent, geolocation) for legal defensibility."

---

## Deep Dive: Tamper-Proof Audit Trail (10 minutes)

### Hash Chain

"The audit trail must be tamper-evident. We use a hash chain (similar to blockchain):

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

    // Get previous event's hash
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
}
```"

### Chain Verification

```javascript
async verifyChain(envelopeId) {
  const events = await db.query(`
    SELECT * FROM audit_events
    WHERE envelope_id = $1
    ORDER BY timestamp ASC
  `, [envelopeId])

  let previousHash = '0'.repeat(64)

  for (const event of events.rows) {
    // Verify chain link
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
```

If anyone modifies an event, the hash chain breaks. This is verifiable decades later."

### Certificate of Completion

```javascript
async generateCertificate(envelopeId) {
  const events = await db.query(`
    SELECT * FROM audit_events WHERE envelope_id = $1 ORDER BY timestamp ASC
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

  await s3.upload({
    Bucket: 'docusign-documents',
    Key: `envelopes/${envelopeId}/certificate.pdf`,
    Body: pdfBytes
  }).promise()

  return certificate
}
```"

---

## Deep Dive: Recipient Authentication (5 minutes)

### Multi-Factor Verification

```javascript
async function authenticateRecipient(recipientId, method) {
  const recipient = await getRecipient(recipientId)
  const envelope = await getEnvelope(recipient.envelope_id)

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
  const code = crypto.randomInt(100000, 999999).toString()
  await redis.setex(`sms_code:${recipient.id}`, 300, code)  // 5 min expiry
  await smsService.send(recipient.phone, `Your DocuSign code is: ${code}`)
  return { requiresCode: true, method: 'sms' }
}
```

Higher-value documents can require stronger authentication (SMS, knowledge-based questions, or ID verification)."

---

## Trade-offs and Alternatives (2 minutes)

"Key decisions:

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Audit Integrity | Hash chain | Simple logging | Legal defensibility, tamper evidence |
| Document Storage | S3 with KMS | Database BLOBs | Scale, durability, compliance |
| Workflow | Explicit state machine | Event-driven | Clarity, validation, debugging |
| Authentication | Multi-factor options | Email only | Enterprise security requirements |

Things I'd explore with more time:
- In-person signing workflows
- Template system for repeat documents
- Bulk send capabilities
- Integration with CLM systems"

---

## Summary

"To summarize, I've designed DocuSign with:

1. **Document processing pipeline** that prepares PDFs for field placement and signing
2. **Workflow engine** with explicit state machine for signing orchestration
3. **Signature capture** with comprehensive metadata for legal compliance
4. **Hash chain audit trail** providing tamper-evident logging
5. **Multi-factor authentication** options for recipient verification
6. **Certificate of completion** with verified integrity

The design prioritizes legal defensibility - every action is logged, hashed, and verifiable years later.

What aspects would you like me to elaborate on?"
