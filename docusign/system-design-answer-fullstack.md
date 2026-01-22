# DocuSign - System Design Answer (Fullstack Focus)

## 45-minute system design interview format - Fullstack Engineer Position

---

## Introduction (2 minutes)

"Thank you for the opportunity. Today I'll design DocuSign, an electronic signature platform, with emphasis on fullstack integration. This system is fascinating because it requires:

1. Seamless frontend-backend coordination for document workflows
2. Real-time state synchronization during signing ceremonies
3. End-to-end type safety from database to UI
4. Legal compliance requiring audit trails across the stack

The fullstack challenges include building consistent data models, handling optimistic updates, and ensuring the frontend accurately reflects backend state transitions.

Let me clarify the requirements."

---

## Requirements Clarification (4 minutes)

### Cross-Stack Requirements

"From a fullstack perspective, we need:

1. **Shared Types**: TypeScript definitions used by both frontend and backend
2. **API Contracts**: Well-defined endpoints with request/response schemas
3. **State Synchronization**: Envelope status updates reflected in real-time
4. **Error Handling**: Consistent error format across the stack
5. **Validation**: Zod schemas shared between frontend forms and backend APIs

The key integration points are:
- Document upload with progress tracking
- Field placement with immediate persistence
- Signature capture with optimistic updates
- Audit trail display with chain verification"

### Non-Functional Requirements

"For fullstack implementation:

- **Type Safety**: End-to-end TypeScript coverage
- **Consistency**: Single source of truth for data models
- **Latency**: Sub-100ms API response times for UI operations
- **Reliability**: Graceful degradation when backend is slow/unavailable"

---

## Shared Type Definitions (8 minutes)

### Core Types

"Shared types ensure consistency between frontend and backend. These definitions live in a shared location accessible to both."

```typescript
// shared/types/envelope.ts

/**
 * Envelope status follows a strict state machine.
 * Transitions are validated on the backend.
 */
export type EnvelopeStatus =
  | 'draft'
  | 'sent'
  | 'delivered'
  | 'signed'
  | 'completed'
  | 'declined'
  | 'voided';

/**
 * Allowed status transitions map.
 * Used for UI state management and backend validation.
 */
export const ENVELOPE_TRANSITIONS: Record<EnvelopeStatus, EnvelopeStatus[]> = {
  draft: ['sent', 'voided'],
  sent: ['delivered', 'voided'],
  delivered: ['signed', 'declined', 'voided'],
  signed: ['completed'],
  declined: [],
  voided: [],
  completed: [],
};

/**
 * Document field types supported by the system.
 */
export type FieldType = 'signature' | 'initial' | 'date' | 'text' | 'checkbox';

/**
 * Recipient roles determine their permissions.
 */
export type RecipientRole = 'signer' | 'cc' | 'in_person';

/**
 * Authentication levels for signing security.
 */
export type AuthenticationLevel = 'email' | 'sms' | 'knowledge' | 'id_verification';

/**
 * Core envelope entity.
 * Central aggregate for document signing workflow.
 */
export interface Envelope {
  id: string;
  senderId: string;
  name: string;
  status: EnvelopeStatus;
  authenticationLevel: AuthenticationLevel;
  expirationDate?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/**
 * Recipient assigned to an envelope.
 */
export interface Recipient {
  id: string;
  envelopeId: string;
  name: string;
  email: string;
  role: RecipientRole;
  routingOrder: number;
  status: 'pending' | 'sent' | 'delivered' | 'completed' | 'declined';
  accessToken?: string;
  ipAddress?: string;
  completedAt?: string;
  createdAt: string;
}

/**
 * Document within an envelope.
 */
export interface Document {
  id: string;
  envelopeId: string;
  name: string;
  pageCount: number;
  url: string;
  status: 'processing' | 'ready' | 'error';
  createdAt: string;
}

/**
 * Field placed on a document page.
 */
export interface DocumentField {
  id: string;
  documentId: string;
  recipientId: string;
  type: FieldType;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  required: boolean;
  completed: boolean;
  value?: string;
  signatureId?: string;
  createdAt: string;
}

/**
 * Captured signature record.
 */
export interface Signature {
  id: string;
  recipientId: string;
  fieldId: string;
  type: 'draw' | 'typed' | 'upload';
  url: string;
  createdAt: string;
}

/**
 * Audit event for compliance.
 */
export interface AuditEvent {
  id: string;
  envelopeId: string;
  eventType: string;
  data: Record<string, unknown>;
  timestamp: string;
  actor: string;
  previousHash: string;
  hash: string;
}
```

### Validation Schemas

```typescript
// shared/schemas/envelope.ts
import { z } from 'zod';

/**
 * Zod schema for creating an envelope.
 * Used by both frontend form validation and backend request parsing.
 */
export const createEnvelopeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  authenticationLevel: z.enum(['email', 'sms', 'knowledge', 'id_verification']).default('email'),
  expirationDate: z.string().datetime().optional(),
});

export type CreateEnvelopeInput = z.infer<typeof createEnvelopeSchema>;

/**
 * Schema for adding a recipient.
 */
export const addRecipientSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email address'),
  role: z.enum(['signer', 'cc', 'in_person']).default('signer'),
  routingOrder: z.number().int().positive().default(1),
});

export type AddRecipientInput = z.infer<typeof addRecipientSchema>;

/**
 * Schema for adding a field.
 */
export const addFieldSchema = z.object({
  recipientId: z.string().uuid(),
  type: z.enum(['signature', 'initial', 'date', 'text', 'checkbox']),
  pageNumber: z.number().int().positive(),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  width: z.number().min(1).max(50).default(20),
  height: z.number().min(1).max(20).default(5),
  required: z.boolean().default(true),
});

export type AddFieldInput = z.infer<typeof addFieldSchema>;

/**
 * Schema for capturing a signature.
 */
export const captureSignatureSchema = z.object({
  type: z.enum(['draw', 'typed', 'upload']),
  imageData: z.string().min(1, 'Signature data required'),
});

export type CaptureSignatureInput = z.infer<typeof captureSignatureSchema>;
```

### API Response Types

```typescript
// shared/types/api.ts

/**
 * Standard API response wrapper.
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

/**
 * Structured API error.
 */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}

/**
 * Paginated list response.
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/**
 * Envelope with related entities.
 */
export interface EnvelopeWithDetails extends Envelope {
  recipients: Recipient[];
  documents: DocumentWithFields[];
}

/**
 * Document with fields.
 */
export interface DocumentWithFields extends Document {
  fields: DocumentField[];
}

/**
 * Signing session response.
 */
export interface SigningSession {
  envelope: Envelope;
  recipient: Recipient;
  document: DocumentWithFields;
  fields: DocumentField[];
}

/**
 * Audit trail with verification.
 */
export interface AuditTrail {
  events: AuditEvent[];
  chainValid: boolean;
  verifiedAt: string;
}
```

---

## Backend Implementation (10 minutes)

### Express Route Handler

```typescript
// backend/src/routes/envelopes.ts
import { Router } from 'express';
import { z } from 'zod';
import { createEnvelopeSchema, addRecipientSchema, addFieldSchema } from '../../../shared/schemas/envelope.js';
import { pool } from '../shared/db.js';
import { auditLogger } from '../shared/auditLogger.js';
import { idempotency } from '../shared/idempotency.js';
import { ApiResponse, EnvelopeWithDetails } from '../../../shared/types/api.js';

const router = Router();

/**
 * Create a new envelope.
 * POST /api/v1/envelopes
 */
router.post('/', async (req, res) => {
  try {
    const parsed = createEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.flatten().fieldErrors,
        },
      });
    }

    const { name, authenticationLevel, expirationDate } = parsed.data;
    const userId = req.session.userId;

    const result = await pool.query(`
      INSERT INTO envelopes (id, sender_id, name, authentication_level, expiration_date)
      VALUES (gen_random_uuid(), $1, $2, $3, $4)
      RETURNING *
    `, [userId, name, authenticationLevel, expirationDate]);

    const envelope = result.rows[0];

    await auditLogger.log(envelope.id, 'envelope_created', {
      userId,
      name,
    });

    const response: ApiResponse<typeof envelope> = {
      success: true,
      data: envelope,
    };

    res.status(201).json(response);
  } catch (error) {
    console.error('Error creating envelope:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create envelope' },
    });
  }
});

/**
 * Get envelope with all related data.
 * GET /api/v1/envelopes/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId;

    // Fetch envelope
    const envelopeResult = await pool.query(`
      SELECT * FROM envelopes WHERE id = $1 AND sender_id = $2
    `, [id, userId]);

    if (envelopeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Envelope not found' },
      });
    }

    const envelope = envelopeResult.rows[0];

    // Fetch recipients
    const recipientsResult = await pool.query(`
      SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order
    `, [id]);

    // Fetch documents with fields
    const documentsResult = await pool.query(`
      SELECT * FROM documents WHERE envelope_id = $1
    `, [id]);

    const documents = await Promise.all(
      documentsResult.rows.map(async (doc) => {
        const fieldsResult = await pool.query(`
          SELECT * FROM document_fields WHERE document_id = $1
        `, [doc.id]);
        return { ...doc, fields: fieldsResult.rows };
      })
    );

    const response: ApiResponse<EnvelopeWithDetails> = {
      success: true,
      data: {
        ...envelope,
        recipients: recipientsResult.rows,
        documents,
      },
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching envelope:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch envelope' },
    });
  }
});

/**
 * Add recipient to envelope.
 * POST /api/v1/envelopes/:id/recipients
 */
router.post('/:id/recipients', async (req, res) => {
  try {
    const { id } = req.params;
    const parsed = addRecipientSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid recipient data',
          details: parsed.error.flatten().fieldErrors,
        },
      });
    }

    const { name, email, role, routingOrder } = parsed.data;

    // Generate unique access token for signing link
    const accessToken = crypto.randomUUID();

    const result = await pool.query(`
      INSERT INTO recipients (id, envelope_id, name, email, role, routing_order, access_code)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [id, name, email, role, routingOrder, accessToken]);

    await auditLogger.log(id, 'recipient_added', {
      recipientId: result.rows[0].id,
      email,
    });

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Error adding recipient:', error);
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to add recipient' },
    });
  }
});

export default router;
```

### Workflow Engine

```typescript
// backend/src/services/workflowEngine.ts
import { pool } from '../shared/db.js';
import { auditLogger } from '../shared/auditLogger.js';
import { queuePublisher } from '../shared/queue.js';
import { ENVELOPE_TRANSITIONS, EnvelopeStatus } from '../../../shared/types/envelope.js';

/**
 * Workflow engine manages envelope state transitions.
 * Enforces state machine rules and triggers side effects.
 */
export class WorkflowEngine {
  /**
   * Transition envelope to new status with validation.
   */
  async transitionState(
    envelopeId: string,
    newStatus: EnvelopeStatus,
    idempotencyKey: string
  ): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Check idempotency
      const idempotent = await this.checkIdempotency(client, idempotencyKey);
      if (idempotent) {
        await client.query('ROLLBACK');
        return;
      }

      // Lock and fetch current state
      const envelope = await client.query(`
        SELECT * FROM envelopes WHERE id = $1 FOR UPDATE
      `, [envelopeId]);

      if (envelope.rows.length === 0) {
        throw new Error('Envelope not found');
      }

      const currentStatus = envelope.rows[0].status as EnvelopeStatus;
      const allowedTransitions = ENVELOPE_TRANSITIONS[currentStatus];

      if (!allowedTransitions.includes(newStatus)) {
        throw new Error(`Invalid transition: ${currentStatus} -> ${newStatus}`);
      }

      // Perform transition
      await client.query(`
        UPDATE envelopes SET status = $2, updated_at = NOW()
        WHERE id = $1
      `, [envelopeId, newStatus]);

      // Store idempotency key
      await client.query(`
        INSERT INTO idempotency_keys (key, response, created_at)
        VALUES ($1, $2, NOW())
      `, [idempotencyKey, JSON.stringify({ status: newStatus })]);

      await client.query('COMMIT');

      // Log audit event
      await auditLogger.log(envelopeId, `status_changed_to_${newStatus}`, {
        previousStatus: currentStatus,
        newStatus,
      });

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Send envelope to recipients.
   * Validates envelope is ready and triggers notifications.
   */
  async sendEnvelope(envelopeId: string): Promise<void> {
    // Validate envelope is complete
    const validation = await this.validateEnvelopeForSending(envelopeId);
    if (!validation.valid) {
      throw new Error(validation.errors.join(', '));
    }

    // Transition to sent
    await this.transitionState(envelopeId, 'sent', `send:${envelopeId}`);

    // Get first recipients (lowest routing order)
    const firstRecipients = await this.getNextRecipients(envelopeId);

    // Queue notifications
    for (const recipient of firstRecipients) {
      await queuePublisher.publishNotification({
        type: 'signing_request',
        recipientId: recipient.id,
        envelopeId,
        channels: ['email'],
      });

      // Update recipient status
      await pool.query(`
        UPDATE recipients SET status = 'sent' WHERE id = $1
      `, [recipient.id]);
    }
  }

  /**
   * Get next recipients in routing order.
   */
  async getNextRecipients(envelopeId: string) {
    const result = await pool.query(`
      SELECT * FROM recipients
      WHERE envelope_id = $1 AND status = 'pending'
      ORDER BY routing_order ASC
    `, [envelopeId]);

    if (result.rows.length === 0) return [];

    const nextOrder = result.rows[0].routing_order;
    return result.rows.filter(r => r.routing_order === nextOrder);
  }

  /**
   * Complete recipient after all fields signed.
   */
  async completeRecipient(recipientId: string): Promise<void> {
    const result = await pool.query(`
      UPDATE recipients SET status = 'completed', completed_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [recipientId]);

    const recipient = result.rows[0];

    await auditLogger.log(recipient.envelope_id, 'recipient_completed', {
      recipientId,
      email: recipient.email,
    });

    // Check if all recipients at this order are done
    const siblings = await pool.query(`
      SELECT * FROM recipients
      WHERE envelope_id = $1 AND routing_order = $2
    `, [recipient.envelope_id, recipient.routing_order]);

    const allComplete = siblings.rows.every(r => r.status === 'completed');

    if (allComplete) {
      const nextRecipients = await this.getNextRecipients(recipient.envelope_id);

      if (nextRecipients.length === 0) {
        // All done - complete envelope
        await this.completeEnvelope(recipient.envelope_id);
      } else {
        // Notify next recipients
        for (const next of nextRecipients) {
          await queuePublisher.publishNotification({
            type: 'signing_request',
            recipientId: next.id,
            envelopeId: recipient.envelope_id,
            channels: ['email'],
          });
        }
      }
    }
  }

  /**
   * Complete envelope after all recipients signed.
   */
  async completeEnvelope(envelopeId: string): Promise<void> {
    await this.transitionState(envelopeId, 'completed', `complete:${envelopeId}`);

    // Queue PDF generation and certificate creation
    await queuePublisher.publishPDFJob({
      type: 'generate_completed_document',
      envelopeId,
    });

    await queuePublisher.publishPDFJob({
      type: 'generate_certificate',
      envelopeId,
    });
  }

  private async validateEnvelopeForSending(envelopeId: string) {
    const errors: string[] = [];

    // Check for recipients
    const recipients = await pool.query(`
      SELECT COUNT(*) as count FROM recipients WHERE envelope_id = $1
    `, [envelopeId]);

    if (parseInt(recipients.rows[0].count) === 0) {
      errors.push('At least one recipient is required');
    }

    // Check for documents
    const documents = await pool.query(`
      SELECT COUNT(*) as count FROM documents WHERE envelope_id = $1 AND status = 'ready'
    `, [envelopeId]);

    if (parseInt(documents.rows[0].count) === 0) {
      errors.push('At least one document is required');
    }

    // Check all signers have fields
    const signersWithoutFields = await pool.query(`
      SELECT r.email FROM recipients r
      WHERE r.envelope_id = $1 AND r.role = 'signer'
      AND NOT EXISTS (
        SELECT 1 FROM document_fields f
        JOIN documents d ON f.document_id = d.id
        WHERE d.envelope_id = $1 AND f.recipient_id = r.id
      )
    `, [envelopeId]);

    if (signersWithoutFields.rows.length > 0) {
      const emails = signersWithoutFields.rows.map(r => r.email).join(', ');
      errors.push(`Signers without fields: ${emails}`);
    }

    return { valid: errors.length === 0, errors };
  }

  private async checkIdempotency(client: any, key: string): Promise<boolean> {
    const result = await client.query(`
      SELECT * FROM idempotency_keys
      WHERE key = $1 AND created_at > NOW() - INTERVAL '24 hours'
    `, [key]);
    return result.rows.length > 0;
  }
}

export const workflowEngine = new WorkflowEngine();
```

### Signature Capture Service

```typescript
// backend/src/services/signatureService.ts
import { pool } from '../shared/db.js';
import { storage } from '../shared/storage.js';
import { auditLogger } from '../shared/auditLogger.js';
import { idempotency } from '../shared/idempotency.js';
import { workflowEngine } from './workflowEngine.js';
import { CaptureSignatureInput } from '../../../shared/schemas/envelope.js';

/**
 * Service for capturing and storing signatures.
 * Handles idempotency and triggers workflow progression.
 */
export class SignatureService {
  /**
   * Capture signature for a field.
   * Idempotent operation with comprehensive audit logging.
   */
  async captureSignature(
    accessToken: string,
    fieldId: string,
    input: CaptureSignatureInput,
    context: { ipAddress: string; userAgent: string }
  ): Promise<{ signatureId: string }> {
    // Validate access token and get recipient
    const recipient = await this.validateAccessToken(accessToken);
    if (!recipient) {
      throw new Error('Invalid or expired access token');
    }

    // Generate idempotency key
    const idempotencyKey = `sig:${fieldId}:${recipient.id}`;

    // Check idempotency
    const existing = await idempotency.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Lock and validate field
      const field = await client.query(`
        SELECT * FROM document_fields WHERE id = $1 FOR UPDATE
      `, [fieldId]);

      if (field.rows.length === 0) {
        throw new Error('Field not found');
      }

      if (field.rows[0].recipient_id !== recipient.id) {
        throw new Error('Unauthorized');
      }

      if (field.rows[0].completed) {
        throw new Error('Field already signed');
      }

      // Store signature image
      const signatureId = crypto.randomUUID();
      const imageBuffer = Buffer.from(
        input.imageData.replace(/^data:image\/\w+;base64,/, ''),
        'base64'
      );
      const s3Key = `signatures/${signatureId}.png`;

      await storage.uploadSignature(s3Key, imageBuffer);

      // Create signature record
      await client.query(`
        INSERT INTO signatures (id, recipient_id, field_id, s3_key, type, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [signatureId, recipient.id, fieldId, s3Key, input.type]);

      // Mark field as completed
      await client.query(`
        UPDATE document_fields SET completed = true, signature_id = $1
        WHERE id = $2
      `, [signatureId, fieldId]);

      await client.query('COMMIT');

      // Store idempotency result
      await idempotency.set(idempotencyKey, { signatureId });

      // Log audit event
      const document = await pool.query(`
        SELECT d.envelope_id FROM documents d
        JOIN document_fields f ON f.document_id = d.id
        WHERE f.id = $1
      `, [fieldId]);

      await auditLogger.logSignatureCapture({
        envelopeId: document.rows[0].envelope_id,
        recipientId: recipient.id,
        recipientEmail: recipient.email,
        fieldId,
        signatureId,
        signatureType: input.type,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      });

      // Check if recipient has completed all required fields
      await this.checkRecipientCompletion(recipient.id);

      return { signatureId };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async validateAccessToken(token: string) {
    const result = await pool.query(`
      SELECT r.*, e.status as envelope_status
      FROM recipients r
      JOIN envelopes e ON r.envelope_id = e.id
      WHERE r.access_code = $1
        AND e.status NOT IN ('completed', 'voided', 'declined')
    `, [token]);

    return result.rows[0] || null;
  }

  private async checkRecipientCompletion(recipientId: string): Promise<void> {
    const incompleteFields = await pool.query(`
      SELECT COUNT(*) as count FROM document_fields
      WHERE recipient_id = $1 AND required = true AND completed = false
    `, [recipientId]);

    if (parseInt(incompleteFields.rows[0].count) === 0) {
      await workflowEngine.completeRecipient(recipientId);
    }
  }
}

export const signatureService = new SignatureService();
```

---

## Frontend Integration (10 minutes)

### API Client

```typescript
// frontend/src/services/api.ts
import { ApiResponse, EnvelopeWithDetails, SigningSession, AuditTrail } from '../../../shared/types/api.js';
import { CreateEnvelopeInput, AddRecipientInput, AddFieldInput, CaptureSignatureInput } from '../../../shared/schemas/envelope.js';

const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

/**
 * Typed API client with error handling.
 */
class ApiClient {
  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include',
    });

    const data = await response.json();

    if (!response.ok) {
      throw new ApiError(data.error || { code: 'UNKNOWN', message: 'Request failed' });
    }

    return data;
  }

  // Envelope operations
  async createEnvelope(input: CreateEnvelopeInput) {
    return this.request<EnvelopeWithDetails>('/envelopes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async getEnvelope(id: string) {
    return this.request<EnvelopeWithDetails>(`/envelopes/${id}`);
  }

  async listEnvelopes(page = 1, status?: string) {
    const params = new URLSearchParams({ page: String(page) });
    if (status) params.set('status', status);
    return this.request<EnvelopeWithDetails[]>(`/envelopes?${params}`);
  }

  async sendEnvelope(id: string) {
    return this.request<EnvelopeWithDetails>(`/envelopes/${id}/send`, {
      method: 'POST',
    });
  }

  // Recipient operations
  async addRecipient(envelopeId: string, input: AddRecipientInput) {
    return this.request(`/envelopes/${envelopeId}/recipients`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async removeRecipient(envelopeId: string, recipientId: string) {
    return this.request(`/envelopes/${envelopeId}/recipients/${recipientId}`, {
      method: 'DELETE',
    });
  }

  // Document operations
  async uploadDocument(envelopeId: string, file: File) {
    const formData = new FormData();
    formData.append('document', file);

    const response = await fetch(`${BASE_URL}/envelopes/${envelopeId}/documents`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    return response.json();
  }

  // Field operations
  async addField(documentId: string, input: AddFieldInput) {
    return this.request(`/documents/${documentId}/fields`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async removeField(fieldId: string) {
    return this.request(`/fields/${fieldId}`, {
      method: 'DELETE',
    });
  }

  // Signing operations
  async getSigningSession(accessToken: string) {
    return this.request<SigningSession>(`/signing/${accessToken}`);
  }

  async captureSignature(
    accessToken: string,
    fieldId: string,
    input: CaptureSignatureInput
  ) {
    return this.request(`/signing/${accessToken}/fields/${fieldId}/sign`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async completeSigningSession(accessToken: string) {
    return this.request(`/signing/${accessToken}/complete`, {
      method: 'POST',
    });
  }

  // Audit operations
  async getAuditTrail(envelopeId: string) {
    return this.request<AuditTrail>(`/envelopes/${envelopeId}/audit`);
  }
}

export class ApiError extends Error {
  constructor(public error: { code: string; message: string; details?: Record<string, string[]> }) {
    super(error.message);
    this.name = 'ApiError';
  }
}

export const api = new ApiClient();
```

### Zustand Store with API Integration

```typescript
// frontend/src/stores/envelopeStore.ts
import { create } from 'zustand';
import { api, ApiError } from '../services/api.js';
import { EnvelopeWithDetails } from '../../../shared/types/api.js';
import { AddRecipientInput, AddFieldInput } from '../../../shared/schemas/envelope.js';

interface EnvelopeState {
  currentEnvelope: EnvelopeWithDetails | null;
  isLoading: boolean;
  error: string | null;
  validationErrors: Record<string, string[]>;

  // Actions
  fetchEnvelope: (id: string) => Promise<void>;
  addRecipient: (input: AddRecipientInput) => Promise<void>;
  removeRecipient: (recipientId: string) => Promise<void>;
  addField: (documentId: string, input: AddFieldInput) => Promise<void>;
  removeField: (fieldId: string) => Promise<void>;
  sendEnvelope: () => Promise<void>;
  clearError: () => void;
}

/**
 * Envelope management store.
 * Handles optimistic updates and error recovery.
 */
export const useEnvelopeStore = create<EnvelopeState>((set, get) => ({
  currentEnvelope: null,
  isLoading: false,
  error: null,
  validationErrors: {},

  fetchEnvelope: async (id) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.getEnvelope(id);
      set({ currentEnvelope: response.data, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof ApiError ? error.message : 'Failed to load envelope',
        isLoading: false,
      });
    }
  },

  addRecipient: async (input) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    set({ error: null, validationErrors: {} });

    try {
      const response = await api.addRecipient(currentEnvelope.id, input);

      // Update state with new recipient
      set({
        currentEnvelope: {
          ...currentEnvelope,
          recipients: [...currentEnvelope.recipients, response.data],
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.error.details) {
        set({ validationErrors: error.error.details });
      } else {
        set({ error: error instanceof ApiError ? error.message : 'Failed to add recipient' });
      }
    }
  },

  removeRecipient: async (recipientId) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    // Optimistic update
    const previousRecipients = currentEnvelope.recipients;
    set({
      currentEnvelope: {
        ...currentEnvelope,
        recipients: currentEnvelope.recipients.filter(r => r.id !== recipientId),
      },
    });

    try {
      await api.removeRecipient(currentEnvelope.id, recipientId);
    } catch (error) {
      // Rollback on error
      set({
        currentEnvelope: { ...currentEnvelope, recipients: previousRecipients },
        error: 'Failed to remove recipient',
      });
    }
  },

  addField: async (documentId, input) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    try {
      const response = await api.addField(documentId, input);

      // Update document with new field
      set({
        currentEnvelope: {
          ...currentEnvelope,
          documents: currentEnvelope.documents.map(doc =>
            doc.id === documentId
              ? { ...doc, fields: [...doc.fields, response.data] }
              : doc
          ),
        },
      });
    } catch (error) {
      set({ error: error instanceof ApiError ? error.message : 'Failed to add field' });
    }
  },

  removeField: async (fieldId) => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    // Optimistic update
    const previousDocuments = currentEnvelope.documents;
    set({
      currentEnvelope: {
        ...currentEnvelope,
        documents: currentEnvelope.documents.map(doc => ({
          ...doc,
          fields: doc.fields.filter(f => f.id !== fieldId),
        })),
      },
    });

    try {
      await api.removeField(fieldId);
    } catch (error) {
      // Rollback on error
      set({
        currentEnvelope: { ...currentEnvelope, documents: previousDocuments },
        error: 'Failed to remove field',
      });
    }
  },

  sendEnvelope: async () => {
    const { currentEnvelope } = get();
    if (!currentEnvelope) return;

    set({ isLoading: true, error: null });

    try {
      const response = await api.sendEnvelope(currentEnvelope.id);
      set({
        currentEnvelope: response.data,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof ApiError ? error.message : 'Failed to send envelope',
        isLoading: false,
      });
    }
  },

  clearError: () => set({ error: null, validationErrors: {} }),
}));
```

### Audit Trail Component

```typescript
// frontend/src/components/envelope/AuditTab.tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../../services/api.js';
import { LoadingSpinner, MessageBanner } from '../common/index.js';
import { CheckIcon, WarningIcon } from '../icons/index.js';

interface AuditTabProps {
  envelopeId: string;
}

/**
 * Displays audit trail with hash chain verification.
 * Shows event timeline and chain integrity status.
 */
export function AuditTab({ envelopeId }: AuditTabProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['audit', envelopeId],
    queryFn: () => api.getAuditTrail(envelopeId),
  });

  if (isLoading) {
    return <LoadingSpinner centered message="Loading audit trail..." />;
  }

  if (error || !data?.data) {
    return <MessageBanner type="error" message="Failed to load audit trail" />;
  }

  const { events, chainValid, verifiedAt } = data.data;

  return (
    <div className="p-6">
      {/* Chain verification status */}
      <div className={`
        p-4 rounded-lg mb-6 flex items-center gap-3
        ${chainValid ? 'bg-green-50' : 'bg-red-50'}
      `}>
        {chainValid ? (
          <>
            <CheckIcon className="h-6 w-6 text-green-600" />
            <div>
              <p className="font-medium text-green-800">Audit Trail Verified</p>
              <p className="text-sm text-green-600">
                Hash chain integrity confirmed at {new Date(verifiedAt).toLocaleString()}
              </p>
            </div>
          </>
        ) : (
          <>
            <WarningIcon className="h-6 w-6 text-red-600" />
            <div>
              <p className="font-medium text-red-800">Verification Failed</p>
              <p className="text-sm text-red-600">
                Audit trail integrity could not be verified
              </p>
            </div>
          </>
        )}
      </div>

      {/* Event timeline */}
      <h3 className="text-lg font-semibold mb-4">Event History</h3>
      <div className="relative">
        {/* Vertical timeline line */}
        <div className="absolute left-4 top-0 bottom-0 w-px bg-gray-200" />

        <ul className="space-y-4">
          {events.map((event, index) => (
            <li key={event.id} className="relative pl-10">
              {/* Timeline dot */}
              <div className={`
                absolute left-2 top-1.5 w-4 h-4 rounded-full
                ${index === 0 ? 'bg-blue-500' : 'bg-gray-300'}
              `} />

              <div className="bg-white border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium capitalize">
                    {event.eventType.replace(/_/g, ' ')}
                  </span>
                  <span className="text-sm text-gray-500">
                    {new Date(event.timestamp).toLocaleString()}
                  </span>
                </div>

                <div className="text-sm text-gray-600 mb-2">
                  Actor: {event.actor}
                </div>

                {/* Event details */}
                {event.data && (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-blue-600 hover:underline">
                      View details
                    </summary>
                    <pre className="mt-2 p-2 bg-gray-50 rounded overflow-x-auto">
                      {JSON.stringify(event.data, null, 2)}
                    </pre>
                  </details>
                )}

                {/* Hash preview */}
                <div className="mt-2 text-xs text-gray-400 font-mono truncate">
                  Hash: {event.hash.substring(0, 16)}...
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

---

## End-to-End Data Flow (5 minutes)

### Signature Capture Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                        SIGNATURE CAPTURE FLOW                         │
└──────────────────────────────────────────────────────────────────────┘

Frontend                           Backend                         Storage
────────                           ───────                         ───────

1. User clicks field
   │
   ├─> SignatureModal opens
   │
2. User draws/types signature
   │
   ├─> Canvas captures image
   │
3. User confirms
   │
   ├─> Convert to base64
   │
4. Submit to API ─────────────────> captureSignature()
                                    │
                                    ├─> Validate access token
                                    │
                                    ├─> Check idempotency key
                                    │
                                    ├─> Lock field (FOR UPDATE)
                                    │
                                    ├─> Validate field ownership
                                    │
                                    ├─> Upload image ──────────────> MinIO
                                    │
                                    ├─> Create signature record
                                    │
                                    ├─> Mark field completed
                                    │
                                    ├─> Log audit event
                                    │
                                    ├─> Check recipient completion
                                    │   │
                                    │   └─> If complete, trigger workflow
                                    │
5. Receive response <───────────────┘
   │
   ├─> Update UI state
   │
   ├─> Mark field as completed
   │
   └─> Navigate to next field
```

### Envelope Lifecycle Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                      ENVELOPE LIFECYCLE FLOW                          │
└──────────────────────────────────────────────────────────────────────┘

Sender Actions                     System Events                 Recipient Actions
──────────────                     ─────────────                 ─────────────────

Create envelope
      │
      ▼
Upload document ──────────────> Document processing
      │                         (validate PDF, generate pages)
      │
Add recipients ───────────────> Store recipient records
      │
      ▼
Place fields on PDF
      │
      ▼
Send envelope ────────────────> Validate envelope
      │                         │
      │                         ├─> Transition to 'sent'
      │                         │
      │                         ├─> Queue notifications
      │                         │         │
      │                         │         ▼
      │                         │   Send emails ──────────────> Receive email
      │                         │                                     │
      │                         │                                     ▼
      │                         │                              Click signing link
      │                         │                                     │
      │                         │                              Load signing session
      │                         │                                     │
      │                         │                              View document
      │                         │                                     │
      │                         │                              Sign fields <──┐
      │                         │                                     │      │
      │                         │                               ┌─────┴──────┤
      │                         │                               │ More       │
      │                         │                               │ fields?    │
      │                         │                               └─────┬──────┘
      │                         │                                     │ No
      │                         │                                     ▼
      │                         │                              Complete signing
      │                         │                                     │
      │                         ├── Recipient completed <─────────────┘
      │                         │
      │                         ├─> Check all recipients
      │                         │         │
      │                         │    ┌────┴────┐
      │                         │    │ All     │ No
      │                         │    │ done?   ├───> Notify next recipient
      │                         │    └────┬────┘
      │                         │         │ Yes
      │                         │         ▼
      │                         │   Complete envelope
      │                         │         │
      │                         │         ├─> Generate signed PDF
      │                         │         │
      │                         │         ├─> Generate certificate
      │                         │         │
      ▼                         │         ▼
Receive completion <──────────────── Send completion emails
notification
```

---

## Testing Strategy (3 minutes)

### Integration Testing

```typescript
// backend/src/signing/signing.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from './app.js';
import { pool } from '../shared/db.js';
import { storage } from '../shared/storage.js';

// Mock external dependencies
vi.mock('../shared/storage.js', () => ({
  storage: {
    uploadSignature: vi.fn().mockResolvedValue('signatures/test.png'),
  },
}));

describe('Signing API', () => {
  let accessToken: string;
  let fieldId: string;

  beforeAll(async () => {
    // Set up test data
    const envelope = await createTestEnvelope();
    const recipient = await createTestRecipient(envelope.id);
    accessToken = recipient.access_code;
    const document = await createTestDocument(envelope.id);
    const field = await createTestField(document.id, recipient.id);
    fieldId = field.id;
  });

  afterAll(async () => {
    await cleanupTestData();
  });

  describe('GET /api/v1/signing/:accessToken', () => {
    it('returns signing session for valid token', async () => {
      const response = await request(app)
        .get(`/api/v1/signing/${accessToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.recipient).toBeDefined();
      expect(response.body.data.document).toBeDefined();
      expect(response.body.data.fields).toHaveLength(1);
    });

    it('returns 404 for invalid token', async () => {
      const response = await request(app)
        .get('/api/v1/signing/invalid-token')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/signing/:accessToken/fields/:fieldId/sign', () => {
    it('captures signature successfully', async () => {
      const signatureData = {
        type: 'draw',
        imageData: 'data:image/png;base64,iVBORw0KGgo...',
      };

      const response = await request(app)
        .post(`/api/v1/signing/${accessToken}/fields/${fieldId}/sign`)
        .send(signatureData)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.signatureId).toBeDefined();
      expect(storage.uploadSignature).toHaveBeenCalled();
    });

    it('is idempotent for duplicate requests', async () => {
      const signatureData = {
        type: 'draw',
        imageData: 'data:image/png;base64,iVBORw0KGgo...',
      };

      // First request
      const response1 = await request(app)
        .post(`/api/v1/signing/${accessToken}/fields/${fieldId}/sign`)
        .send(signatureData);

      // Second request (should return same result)
      const response2 = await request(app)
        .post(`/api/v1/signing/${accessToken}/fields/${fieldId}/sign`)
        .send(signatureData);

      expect(response1.body.data.signatureId).toBe(response2.body.data.signatureId);
    });

    it('rejects invalid signature type', async () => {
      const signatureData = {
        type: 'invalid',
        imageData: 'data:image/png;base64,...',
      };

      const response = await request(app)
        .post(`/api/v1/signing/${accessToken}/fields/${fieldId}/sign`)
        .send(signatureData)
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });
});
```

### Frontend Component Testing

```typescript
// frontend/src/components/signing/SignatureModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SignatureModal } from './SignatureModal.js';

describe('SignatureModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onConfirm: vi.fn(),
    fieldType: 'signature' as const,
  };

  it('renders draw and type tabs', () => {
    render(<SignatureModal {...defaultProps} />);

    expect(screen.getByRole('tab', { name: /draw/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /type/i })).toBeInTheDocument();
  });

  it('switches between draw and type modes', () => {
    render(<SignatureModal {...defaultProps} />);

    // Click type tab
    fireEvent.click(screen.getByRole('tab', { name: /type/i }));

    // Type input should be visible
    expect(screen.getByPlaceholderText(/type your name/i)).toBeInTheDocument();
  });

  it('calls onConfirm with typed signature data', async () => {
    render(<SignatureModal {...defaultProps} />);

    // Switch to type mode
    fireEvent.click(screen.getByRole('tab', { name: /type/i }));

    // Type name
    fireEvent.change(screen.getByPlaceholderText(/type your name/i), {
      target: { value: 'John Doe' },
    });

    // Confirm
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(defaultProps.onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'typed',
        imageData: expect.stringContaining('data:image/png;base64'),
      })
    );
  });

  it('calls onClose when cancel is clicked', () => {
    render(<SignatureModal {...defaultProps} />);

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(defaultProps.onClose).toHaveBeenCalled();
  });
});
```

---

## Trade-offs and Alternatives (2 minutes)

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Shared Types | TypeScript + Zod | OpenAPI/GraphQL | Simpler setup, runtime validation |
| State Sync | Zustand + React Query | Redux + RTK Query | Less boilerplate, adequate for scope |
| API Style | REST | GraphQL | Simpler for document-centric operations |
| Optimistic Updates | Selective | Full | Safer for legal document operations |
| Error Handling | Typed ApiError | Generic errors | Better developer experience |

---

## Summary

"To summarize the fullstack architecture for DocuSign:

1. **Shared Types**: TypeScript definitions and Zod schemas used by both frontend and backend
2. **Backend Services**: Workflow engine with state machine, signature capture with idempotency
3. **Frontend Integration**: Typed API client with Zustand stores for state management
4. **End-to-End Flow**: Document from signature capture through workflow completion
5. **Testing Strategy**: Integration tests for APIs, component tests for UI

The design prioritizes type safety and consistency across the stack while maintaining clear separation of concerns between frontend and backend responsibilities.

What aspects would you like me to elaborate on?"
