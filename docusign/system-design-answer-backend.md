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
│   PostgreSQL    │     S3/MinIO      │      Elasticsearch        │
│   - Envelopes   │  - Documents      │      - Audit logs         │
│   - Recipients  │  - Signatures     │      - Search             │
│   - Workflow    │  - Certificates   │      - Analytics          │
└─────────────────┴───────────────────┴───────────────────────────┘
```

### Component Responsibilities
- **Document Service**: PDF processing, field placement, template management
- **Workflow Engine**: State machine for signing orchestration
- **Signing Service**: Signature capture, recipient verification, audit logging

---

## 3. Database Schema Design (6 minutes)

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

CREATE INDEX idx_envelopes_sender_status ON envelopes(sender_id, status);

-- Recipients
CREATE TABLE recipients (
  id UUID PRIMARY KEY,
  envelope_id UUID REFERENCES envelopes(id),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200) NOT NULL,
  role VARCHAR(50) DEFAULT 'signer', -- 'signer', 'cc', 'in_person'
  routing_order INTEGER DEFAULT 1,
  status VARCHAR(30) DEFAULT 'pending',
  access_token VARCHAR(64) UNIQUE,
  ip_address VARCHAR(50),
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_recipients_envelope ON recipients(envelope_id, routing_order);
CREATE INDEX idx_recipients_token ON recipients(access_token);

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
  type VARCHAR(30) NOT NULL, -- 'signature', 'initial', 'date', 'text'
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

CREATE INDEX idx_fields_recipient ON document_fields(recipient_id, completed);

-- Signatures
CREATE TABLE signatures (
  id UUID PRIMARY KEY,
  recipient_id UUID REFERENCES recipients(id),
  field_id UUID REFERENCES document_fields(id),
  s3_key VARCHAR(500) NOT NULL,
  type VARCHAR(30) NOT NULL, -- 'draw', 'typed', 'upload'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Audit Events (append-only hash chain)
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

-- Idempotency Keys (prevent duplicate operations)
CREATE TABLE idempotency_keys (
  key VARCHAR(255) PRIMARY KEY,
  response JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_idempotency_created ON idempotency_keys(created_at);
```

---

## 4. Workflow Engine State Machine (8 minutes)

### State Transitions

```typescript
const ENVELOPE_STATES = {
  draft: ['sent', 'voided'],
  sent: ['delivered', 'voided'],
  delivered: ['signed', 'declined', 'voided'],
  signed: ['completed'],  // When all recipients sign
  declined: [],
  voided: [],
  completed: []
};

class WorkflowEngine {
  async sendEnvelope(envelopeId: string, idempotencyKey: string) {
    return this.transitionWithIdempotency(envelopeId, 'sent', idempotencyKey, async () => {
      const envelope = await this.getEnvelope(envelopeId);

      if (envelope.status !== 'draft') {
        throw new Error('Can only send draft envelopes');
      }

      // Validate all required fields have recipients
      await this.validateEnvelope(envelope);

      // Perform state transition
      await this.updateStatus(envelopeId, 'sent');

      // Determine first recipients based on routing order
      const firstRecipients = await this.getNextRecipients(envelopeId);

      // Queue notification jobs
      for (const recipient of firstRecipients) {
        await this.queueNotification(recipient, 'signing_request');
      }

      return envelope;
    });
  }

  async getNextRecipients(envelopeId: string): Promise<Recipient[]> {
    const recipients = await db.query(`
      SELECT * FROM recipients
      WHERE envelope_id = $1
      ORDER BY routing_order ASC
    `, [envelopeId]);

    // Find lowest incomplete routing order
    const pending = recipients.rows.filter(r => r.status === 'pending');
    if (pending.length === 0) return [];

    const nextOrder = pending[0].routing_order;

    // Return all recipients at that order (parallel signing)
    return pending.filter(r => r.routing_order === nextOrder);
  }

  async completeRecipient(recipientId: string) {
    const recipient = await db.query(`
      UPDATE recipients SET status = 'completed', completed_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [recipientId]);

    // Check if all recipients at this routing order are done
    const siblings = await db.query(`
      SELECT * FROM recipients
      WHERE envelope_id = $1 AND routing_order = $2
    `, [recipient.rows[0].envelope_id, recipient.rows[0].routing_order]);

    const allComplete = siblings.rows.every(r => r.status === 'completed');

    if (allComplete) {
      const nextRecipients = await this.getNextRecipients(recipient.rows[0].envelope_id);

      if (nextRecipients.length === 0) {
        // All done - complete the envelope
        await this.completeEnvelope(recipient.rows[0].envelope_id);
      } else {
        for (const next of nextRecipients) {
          await this.queueNotification(next, 'signing_request');
        }
      }
    }
  }

  async completeEnvelope(envelopeId: string) {
    await this.updateStatus(envelopeId, 'completed');

    // Generate signed document with flattened fields
    await this.queueJob('pdf_processing', {
      type: 'generate_completed',
      envelopeId,
    });

    // Generate certificate of completion
    await this.queueJob('pdf_processing', {
      type: 'generate_certificate',
      envelopeId,
    });

    // Notify all parties
    await this.queueNotification(envelopeId, 'completed');
  }
}
```

### Idempotent State Transitions

```typescript
async transitionWithIdempotency(
  envelopeId: string,
  newStatus: string,
  idempotencyKey: string,
  operation: () => Promise<any>
): Promise<any> {
  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Check for duplicate request
    const existing = await client.query(`
      SELECT * FROM idempotency_keys
      WHERE key = $1 AND created_at > NOW() - INTERVAL '24 hours'
    `, [idempotencyKey]);

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return existing.rows[0].response;
    }

    // Lock envelope row
    const envelope = await client.query(`
      SELECT * FROM envelopes WHERE id = $1 FOR UPDATE
    `, [envelopeId]);

    if (!envelope.rows[0]) {
      throw new Error('Envelope not found');
    }

    const currentStatus = envelope.rows[0].status;
    const allowedTransitions = ENVELOPE_STATES[currentStatus];

    if (!allowedTransitions.includes(newStatus)) {
      throw new Error(`Invalid transition: ${currentStatus} -> ${newStatus}`);
    }

    // Execute operation
    const result = await operation();

    // Store idempotency key
    await client.query(`
      INSERT INTO idempotency_keys (key, response, created_at)
      VALUES ($1, $2, NOW())
    `, [idempotencyKey, JSON.stringify(result)]);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

---

## 5. Tamper-Proof Audit Trail (8 minutes)

### Hash Chain Implementation

```typescript
import crypto from 'crypto';

class AuditService {
  async log(envelopeId: string, eventType: string, data: any) {
    const event = {
      id: uuid(),
      envelopeId,
      eventType,
      data,
      timestamp: new Date().toISOString(),
      actor: data.recipientId || data.userId || 'system'
    };

    // Get previous event's hash for chain
    const previousEvent = await this.getLastEvent(envelopeId);
    const previousHash = previousEvent?.hash || '0'.repeat(64);

    event.previousHash = previousHash;
    event.hash = this.calculateHash(event);

    // Store in append-only table
    await db.query(`
      INSERT INTO audit_events
        (id, envelope_id, event_type, data, timestamp, actor, previous_hash, hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [event.id, envelopeId, eventType, JSON.stringify(data),
        event.timestamp, event.actor, previousHash, event.hash]);

    // Also index in Elasticsearch for search
    await elasticsearch.index({
      index: 'audit-events',
      body: event
    });

    return event;
  }

  calculateHash(event: any): string {
    const payload = JSON.stringify({
      id: event.id,
      envelopeId: event.envelopeId,
      eventType: event.eventType,
      data: event.data,
      timestamp: event.timestamp,
      previousHash: event.previousHash
    });

    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  async verifyChain(envelopeId: string): Promise<{ valid: boolean; error?: string }> {
    const events = await db.query(`
      SELECT * FROM audit_events
      WHERE envelope_id = $1
      ORDER BY timestamp ASC
    `, [envelopeId]);

    let previousHash = '0'.repeat(64);

    for (const event of events.rows) {
      // Verify chain link
      if (event.previous_hash !== previousHash) {
        return { valid: false, error: 'Chain broken', eventId: event.id };
      }

      // Verify event hash
      const calculatedHash = this.calculateHash({
        id: event.id,
        envelopeId: event.envelope_id,
        eventType: event.event_type,
        data: event.data,
        timestamp: event.timestamp,
        previousHash: event.previous_hash
      });

      if (calculatedHash !== event.hash) {
        return { valid: false, error: 'Hash mismatch', eventId: event.id };
      }

      previousHash = event.hash;
    }

    return { valid: true };
  }
}
```

### Audit Event Types

```typescript
const AUDIT_EVENTS = {
  // Envelope lifecycle
  ENVELOPE_CREATED: 'envelope_created',
  ENVELOPE_SENT: 'envelope_sent',
  ENVELOPE_VOIDED: 'envelope_voided',
  ENVELOPE_COMPLETED: 'envelope_completed',

  // Document events
  DOCUMENT_UPLOADED: 'document_uploaded',
  FIELD_ADDED: 'field_added',
  FIELD_REMOVED: 'field_removed',

  // Recipient events
  RECIPIENT_ADDED: 'recipient_added',
  RECIPIENT_VIEWED: 'recipient_viewed',
  RECIPIENT_DECLINED: 'recipient_declined',
  RECIPIENT_COMPLETED: 'recipient_completed',

  // Signature events
  SIGNATURE_CAPTURED: 'signature_captured',
  FIELD_COMPLETED: 'field_completed',

  // Authentication events
  ACCESS_TOKEN_GENERATED: 'access_token_generated',
  SMS_VERIFICATION_SENT: 'sms_verification_sent',
  SMS_VERIFICATION_COMPLETED: 'sms_verification_completed',
};

// Example: Signature capture audit
await auditService.log(documentId, 'signature_captured', {
  recipientId,
  fieldId,
  signatureId,
  signatureType: 'draw',
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
  timestamp: new Date().toISOString(),
  geolocation: req.body.geolocation
});
```

---

## 6. Signature Capture Service (6 minutes)

```typescript
async function captureSignature(
  recipientId: string,
  fieldId: string,
  signatureData: SignatureInput,
  idempotencyKey: string
) {
  // Check idempotency first
  const cached = await redis.get(`idempotent:${idempotencyKey}`);
  if (cached) return JSON.parse(cached);

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Lock the field to prevent concurrent signing
    const field = await client.query(`
      SELECT * FROM document_fields WHERE id = $1 FOR UPDATE
    `, [fieldId]);

    if (field.rows[0].completed) {
      throw new ConflictError('Field already signed');
    }

    const recipient = await getRecipient(recipientId);

    // Verify recipient owns this field
    if (field.rows[0].recipient_id !== recipientId) {
      throw new UnauthorizedError('Field not assigned to this recipient');
    }

    // Process signature based on type
    let signatureImage: Buffer;
    if (signatureData.type === 'draw') {
      signatureImage = Buffer.from(signatureData.imageData.split(',')[1], 'base64');
    } else if (signatureData.type === 'typed') {
      signatureImage = await renderTypedSignature(signatureData.text, signatureData.font);
    }

    // Store signature with encryption
    const signatureId = uuid();
    const s3Key = `signatures/${signatureId}.png`;
    await s3.upload({
      Bucket: 'docusign-signatures',
      Key: s3Key,
      Body: signatureImage,
      ContentType: 'image/png',
      ServerSideEncryption: 'aws:kms'
    }).promise();

    // Create signature record
    await client.query(`
      INSERT INTO signatures (id, recipient_id, field_id, s3_key, type, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `, [signatureId, recipientId, fieldId, s3Key, signatureData.type]);

    // Mark field as completed
    await client.query(`
      UPDATE document_fields SET completed = true, signature_id = $1
      WHERE id = $2
    `, [signatureId, fieldId]);

    await client.query('COMMIT');

    // Comprehensive audit log
    await auditService.log(field.rows[0].document_id, 'signature_captured', {
      recipientId,
      fieldId,
      signatureId,
      ipAddress: signatureData.ipAddress,
      userAgent: signatureData.userAgent,
      timestamp: new Date().toISOString()
    });

    // Cache result for idempotency
    const result = { signatureId };
    await redis.setex(`idempotent:${idempotencyKey}`, 86400, JSON.stringify(result));

    // Check if recipient has completed all required fields
    await checkRecipientCompletion(recipientId);

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function checkRecipientCompletion(recipientId: string) {
  const incompleteFields = await db.query(`
    SELECT COUNT(*) as count FROM document_fields
    WHERE recipient_id = $1 AND required = true AND completed = false
  `, [recipientId]);

  if (parseInt(incompleteFields.rows[0].count) === 0) {
    await workflowEngine.completeRecipient(recipientId);
  }
}
```

---

## 7. Message Queue Architecture (5 minutes)

### RabbitMQ Queue Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                     RabbitMQ Exchange                           │
├─────────────────┬─────────────────────┬─────────────────────────┤
│  docusign.direct│  docusign.fanout    │  docusign.dlx           │
│  (direct)       │  (fanout)           │  (dead letter)          │
└────────┬────────┴──────────┬──────────┴────────────┬────────────┘
         │                   │                       │
    ┌────▼────┐         ┌────▼────┐            ┌────▼────┐
    │ workflow │         │  email  │            │   dlq   │
    │  queue   │         │  queue  │            │  queue  │
    └────┬────┘         └────┬────┘            └─────────┘
         │                   │
    ┌────▼────┐         ┌────▼────┐
    │Workflow │         │ Email   │
    │ Worker  │         │ Worker  │
    └─────────┘         └─────────┘
```

### Message Publishing with Delivery Guarantees

```typescript
class QueuePublisher {
  async publishWorkflowEvent(event: WorkflowEvent) {
    const message = {
      id: uuid(),
      type: event.type,
      envelopeId: event.envelopeId,
      data: event.data,
      timestamp: new Date().toISOString(),
      idempotencyKey: event.idempotencyKey || `${event.type}:${event.envelopeId}:${Date.now()}`
    };

    return new Promise((resolve, reject) => {
      this.channel.publish(
        'docusign.direct',
        'workflow',
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          messageId: message.id,
          headers: {
            'x-idempotency-key': message.idempotencyKey,
            'x-retry-count': 0
          }
        },
        (err) => {
          if (err) reject(new Error('Message not confirmed'));
          else resolve(message.id);
        }
      );
    });
  }
}
```

### Consumer with Backpressure

```typescript
class WorkflowConsumer {
  async start() {
    // Prefetch limits concurrent processing (backpressure)
    await this.channel.prefetch(5);

    await this.channel.consume('docusign.workflow', async (msg) => {
      if (!msg) return;

      const message = JSON.parse(msg.content.toString());
      const retryCount = msg.properties.headers['x-retry-count'] || 0;

      try {
        // Idempotency check
        const processed = await redis.get(`processed:${message.idempotencyKey}`);
        if (processed) {
          this.channel.ack(msg);
          return;
        }

        await this.processEvent(message);

        await redis.setex(`processed:${message.idempotencyKey}`, 86400, message.id);
        this.channel.ack(msg);
      } catch (error) {
        if (retryCount < 3) {
          await this.republishWithRetry(message, retryCount + 1);
          this.channel.nack(msg, false, false);
        } else {
          // Send to DLQ
          this.channel.nack(msg, false, false);
        }
      }
    });
  }
}
```

---

## 8. Recipient Authentication (4 minutes)

```typescript
async function authenticateRecipient(recipientId: string, method: string) {
  const recipient = await getRecipient(recipientId);
  const envelope = await getEnvelope(recipient.envelope_id);

  const requiredAuth = envelope.authentication_level || 'email';

  switch (requiredAuth) {
    case 'email':
      // Email link with access token is sufficient
      return { authenticated: true };

    case 'sms':
      return await smsVerification(recipient);

    case 'knowledge':
      return await knowledgeBasedAuth(recipient);

    case 'id_verification':
      return await idVerification(recipient);

    default:
      return { authenticated: true };
  }
}

async function smsVerification(recipient: Recipient) {
  const code = crypto.randomInt(100000, 999999).toString();

  await redis.setex(`sms_code:${recipient.id}`, 300, code); // 5 min expiry

  await smsService.send(recipient.phone, `Your DocuSign code is: ${code}`);

  await auditService.log(recipient.envelope_id, 'sms_verification_sent', {
    recipientId: recipient.id,
    phone: maskPhone(recipient.phone)
  });

  return { requiresCode: true, method: 'sms' };
}

async function verifySMSCode(recipientId: string, code: string) {
  const stored = await redis.get(`sms_code:${recipientId}`);

  if (stored === code) {
    await redis.del(`sms_code:${recipientId}`);

    await auditService.log(recipientId, 'sms_verification_completed', {
      success: true
    });

    return { authenticated: true };
  }

  await auditService.log(recipientId, 'sms_verification_completed', {
    success: false
  });

  return { authenticated: false, error: 'Invalid code' };
}
```

---

## 9. Circuit Breaker for External Services (3 minutes)

```typescript
import Opossum from 'opossum';

const circuitBreakers = {
  email: new Opossum(emailService.send, {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 60000
  }),

  s3: new Opossum(s3.upload, {
    timeout: 30000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000
  }),

  sms: new Opossum(smsService.send, {
    timeout: 10000,
    errorThresholdPercentage: 50,
    resetTimeout: 120000
  })
};

// Log circuit breaker state changes
circuitBreakers.s3.on('open', () => {
  console.log('S3 circuit breaker opened');
  metrics.increment('circuit_breaker_open', { service: 's3' });
});

circuitBreakers.s3.on('halfOpen', () => {
  console.log('S3 circuit breaker half-open');
});

circuitBreakers.s3.on('close', () => {
  console.log('S3 circuit breaker closed');
});

// Usage with fallback
async function uploadWithFallback(key: string, body: Buffer) {
  return circuitBreakers.s3.fire({ Bucket: 'documents', Key: key, Body: body })
    .catch(async (error) => {
      if (circuitBreakers.s3.opened) {
        // Queue for retry when storage recovers
        await queuePublisher.publishPDFJob({
          type: 's3_upload_retry',
          key,
          body: body.toString('base64')
        });
        return { queued: true };
      }
      throw error;
    });
}
```

---

## 10. Certificate of Completion (3 minutes)

```typescript
async function generateCertificate(envelopeId: string) {
  const events = await db.query(`
    SELECT * FROM audit_events
    WHERE envelope_id = $1
    ORDER BY timestamp ASC
  `, [envelopeId]);

  // Verify chain integrity
  const chainVerification = await auditService.verifyChain(envelopeId);

  const certificate = {
    envelopeId,
    documentName: await getDocumentName(envelopeId),
    completedAt: new Date().toISOString(),
    signers: [],
    events: events.rows.map(e => ({
      time: e.timestamp,
      action: e.event_type,
      actor: e.actor,
      details: formatEventDetails(e)
    })),
    chainVerified: chainVerification.valid,
    integrityHash: events.rows[events.rows.length - 1]?.hash
  };

  // Add signer details
  const recipients = await db.query(`
    SELECT * FROM recipients WHERE envelope_id = $1 AND status = 'completed'
  `, [envelopeId]);

  for (const r of recipients.rows) {
    certificate.signers.push({
      name: r.name,
      email: r.email,
      signedAt: r.completed_at,
      ipAddress: r.ip_address
    });
  }

  // Generate PDF certificate
  const pdfBytes = await renderCertificatePDF(certificate);

  await s3.upload({
    Bucket: 'docusign-documents',
    Key: `envelopes/${envelopeId}/certificate.pdf`,
    Body: pdfBytes,
    ContentType: 'application/pdf'
  }).promise();

  return certificate;
}
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

This DocuSign backend design demonstrates:

1. **Workflow State Machine**: Explicit transitions prevent invalid states
2. **Tamper-Proof Audit**: Hash chain provides legal defensibility
3. **Idempotency**: All critical operations are safely retryable
4. **Message Queues**: Decouple signing from notifications
5. **Multi-Factor Auth**: Configurable security levels
6. **Circuit Breakers**: Protect against external service failures
7. **Certificate Generation**: Complete signing record with integrity proof

The design prioritizes legal compliance - every action is logged, hashed, and verifiable years after signing.
