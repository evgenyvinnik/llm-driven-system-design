import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import { query } from '../utils/db.js';
import logger, { auditLogger as pinoAuditLogger } from './logger.js';
import { auditEventsLogged } from './metrics.js';

/**
 * Enhanced Audit Logging for Legal Compliance
 *
 * WHY AUDIT LOGGING IS REQUIRED FOR LEGAL COMPLIANCE:
 *
 * 1. ESIGN ACT (USA): Requires accurate records of each electronic signature,
 *    including the date, time, and method of signing.
 *
 * 2. UETA (Uniform Electronic Transactions Act): Mandates that electronic
 *    records be attributable to a person and demonstrate integrity.
 *
 * 3. eIDAS (EU): Requires advanced electronic signatures to be linked to
 *    the signatory, capable of identifying the signatory, and created using
 *    data under the signatory's control.
 *
 * 4. SOC 2 COMPLIANCE: Audit trails are essential for demonstrating security
 *    controls and change management.
 *
 * 5. LEGAL DISPUTES: In case of contract disputes, the audit trail serves as
 *    evidence of who signed what, when, and from where.
 *
 * 6. TAMPER EVIDENCE: Hash chain ensures any modification to audit records
 *    is immediately detectable.
 */

// Event types for comprehensive audit trail
export const AUDIT_EVENTS = {
  // Envelope lifecycle
  ENVELOPE_CREATED: 'envelope_created',
  ENVELOPE_SENT: 'envelope_sent',
  ENVELOPE_DELIVERED: 'envelope_delivered',
  ENVELOPE_COMPLETED: 'envelope_completed',
  ENVELOPE_DECLINED: 'envelope_declined',
  ENVELOPE_VOIDED: 'envelope_voided',
  ENVELOPE_EXPIRED: 'envelope_expired',

  // Document events
  DOCUMENT_ADDED: 'document_added',
  DOCUMENT_VIEWED: 'document_viewed',
  DOCUMENT_DOWNLOADED: 'document_downloaded',

  // Field events
  FIELD_ADDED: 'field_added',
  FIELD_COMPLETED: 'field_completed',
  FIELD_MODIFIED: 'field_modified',

  // Signature events
  SIGNING_STARTED: 'signing_started',
  SIGNATURE_CAPTURED: 'signature_captured',
  SIGNATURE_FAILED: 'signature_failed',
  SIGNATURE_DUPLICATE_BLOCKED: 'signature_duplicate_blocked',

  // Recipient events
  RECIPIENT_ADDED: 'recipient_added',
  RECIPIENT_NOTIFIED: 'recipient_notified',
  RECIPIENT_REMINDED: 'recipient_reminded',
  RECIPIENT_COMPLETED: 'recipient_completed',
  RECIPIENT_DECLINED: 'recipient_declined',

  // Authentication events
  AUTH_ATTEMPTED: 'auth_attempted',
  AUTH_SUCCEEDED: 'auth_succeeded',
  AUTH_FAILED: 'auth_failed',
  SMS_CODE_SENT: 'sms_code_sent',
  SMS_CODE_VERIFIED: 'sms_code_verified',
  SMS_CODE_FAILED: 'sms_code_failed',

  // Security events
  ACCESS_DENIED: 'access_denied',
  SUSPICIOUS_ACTIVITY: 'suspicious_activity',
  IDEMPOTENCY_BLOCKED: 'idempotency_blocked',
} as const;

export type AuditEventType = typeof AUDIT_EVENTS[keyof typeof AUDIT_EVENTS];

export interface AuditContext {
  ipAddress?: string;
  ip?: string;
  userAgent?: string;
  sessionId?: string;
  geoLocation?: string;
  deviceInfo?: string;
  userId?: string;
}

export interface AuditEventData {
  recipientId?: string;
  userId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface AuditEvent {
  id: string;
  envelopeId: string;
  eventType: string;
  data: AuditEventData & { timestamp: string };
  timestamp: string;
  actor: string;
  context: {
    ipAddress?: string;
    userAgent?: string;
    sessionId?: string;
    geoLocation?: string;
    deviceInfo?: string;
  };
  previousHash?: string;
  hash?: string;
}

export interface AuditEventRow {
  id: string;
  envelope_id: string;
  event_type: string;
  data: string | Record<string, unknown>;
  timestamp: string;
  actor: string;
  previous_hash: string;
  hash: string;
}

export interface ChainVerificationResult {
  valid: boolean;
  eventCount: number;
  issues: ChainIssue[];
  verifiedAt: string;
}

export interface ChainIssue {
  eventId: string;
  type: 'chain_broken' | 'hash_mismatch';
  expected: string;
  found: string;
}

export interface SignatureCaptureParams {
  envelopeId: string;
  recipientId: string;
  recipientEmail: string;
  recipientName: string;
  fieldId: string;
  signatureId: string;
  signatureType: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface DuplicateSignatureParams {
  envelopeId: string;
  recipientId: string;
  fieldId: string;
  idempotencyKey: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthEventParams {
  recipientId: string;
  authMethod?: string;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface SecurityEventParams {
  severity?: string;
  ipAddress?: string;
  userAgent?: string;
  [key: string]: unknown;
}

/**
 * Log an audit event with full context for legal compliance.
 *
 * @param envelopeId - ID of the envelope
 * @param eventType - Type of event (from AUDIT_EVENTS)
 * @param data - Event-specific data
 * @param context - Request context (IP, user agent, etc.)
 */
export async function logAuditEvent(
  envelopeId: string,
  eventType: string,
  data: AuditEventData,
  context: AuditContext = {}
): Promise<AuditEvent | null> {
  const event: AuditEvent = {
    id: uuid(),
    envelopeId,
    eventType,
    data: {
      ...data,
      timestamp: new Date().toISOString(),
    },
    timestamp: new Date().toISOString(),
    actor: data.recipientId || data.userId || context.userId || 'system',
    context: {
      ipAddress: context.ipAddress || context.ip,
      userAgent: context.userAgent,
      sessionId: context.sessionId,
      geoLocation: context.geoLocation,
      deviceInfo: context.deviceInfo,
    },
  };

  try {
    // Get previous event's hash for chain integrity
    const previousEvent = await getLastEvent(envelopeId);
    const previousHash = previousEvent?.hash || '0'.repeat(64);

    event.previousHash = previousHash;
    event.hash = calculateEventHash(event);

    // Store in database (append-only, never delete)
    await query(
      `INSERT INTO audit_events
        (id, envelope_id, event_type, data, timestamp, actor, previous_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.id,
        envelopeId,
        eventType,
        JSON.stringify({ ...event.data, context: event.context }),
        event.timestamp,
        event.actor,
        previousHash,
        event.hash,
      ]
    );

    // Also log to structured logging for real-time monitoring
    pinoAuditLogger.info({
      eventId: event.id,
      envelopeId,
      eventType,
      actor: event.actor,
      ipAddress: event.context.ipAddress,
      hash: event.hash,
    }, `Audit: ${eventType}`);

    // Update metrics
    auditEventsLogged.inc({ event_type: eventType });

    return event;
  } catch (error) {
    // Audit failures are critical - log at error level but don't throw
    // The main operation should still proceed
    const err = error as Error;
    logger.error({
      error: err.message,
      envelopeId,
      eventType,
    }, 'Failed to log audit event');

    return null;
  }
}

/**
 * Calculate SHA-256 hash for event (tamper-evidence).
 */
function calculateEventHash(event: AuditEvent): string {
  const payload = JSON.stringify({
    id: event.id,
    envelopeId: event.envelopeId,
    eventType: event.eventType,
    data: event.data,
    timestamp: event.timestamp,
    previousHash: event.previousHash,
    context: event.context,
  });

  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Get the last event for an envelope (for hash chain).
 */
async function getLastEvent(envelopeId: string): Promise<AuditEventRow | null> {
  const result = await query<AuditEventRow>(
    `SELECT * FROM audit_events
     WHERE envelope_id = $1
     ORDER BY timestamp DESC
     LIMIT 1`,
    [envelopeId]
  );
  return result.rows[0] || null;
}

/**
 * Log a signature capture event with full legal context.
 */
export async function logSignatureCapture(params: SignatureCaptureParams): Promise<AuditEvent | null> {
  const {
    envelopeId,
    recipientId,
    recipientEmail,
    recipientName,
    fieldId,
    signatureId,
    signatureType,
    ipAddress,
    userAgent,
  } = params;

  return logAuditEvent(envelopeId, AUDIT_EVENTS.SIGNATURE_CAPTURED, {
    recipientId,
    recipientEmail,
    recipientName,
    fieldId,
    signatureId,
    signatureType,
    capturedAt: new Date().toISOString(),
    legalStatement: 'I agree to use electronic records and signatures',
  }, {
    ipAddress,
    userAgent,
  });
}

/**
 * Log a duplicate signature attempt (blocked by idempotency).
 */
export async function logDuplicateSignatureBlocked(params: DuplicateSignatureParams): Promise<AuditEvent | null> {
  const {
    envelopeId,
    recipientId,
    fieldId,
    idempotencyKey,
    ipAddress,
    userAgent,
  } = params;

  return logAuditEvent(envelopeId, AUDIT_EVENTS.SIGNATURE_DUPLICATE_BLOCKED, {
    recipientId,
    fieldId,
    idempotencyKey,
    blockedAt: new Date().toISOString(),
    reason: 'Duplicate signature attempt detected and blocked',
  }, {
    ipAddress,
    userAgent,
  });
}

/**
 * Log authentication event for signing session.
 */
export async function logAuthEvent(
  envelopeId: string,
  success: boolean,
  params: AuthEventParams
): Promise<AuditEvent | null> {
  const eventType = success ? AUDIT_EVENTS.AUTH_SUCCEEDED : AUDIT_EVENTS.AUTH_FAILED;

  return logAuditEvent(envelopeId, eventType, {
    recipientId: params.recipientId,
    authMethod: params.authMethod || 'email_link',
    attemptedAt: new Date().toISOString(),
    reason: params.reason,
  }, {
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

/**
 * Log security-related events.
 */
export async function logSecurityEvent(
  envelopeId: string,
  eventType: string,
  params: SecurityEventParams
): Promise<AuditEvent | null> {
  return logAuditEvent(envelopeId, eventType, {
    ...params,
    detectedAt: new Date().toISOString(),
    severity: params.severity || 'medium',
  }, {
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });
}

/**
 * Verify the integrity of the audit chain for an envelope.
 * Used for compliance audits and legal proceedings.
 */
export async function verifyAuditChain(envelopeId: string): Promise<ChainVerificationResult> {
  const result = await query<AuditEventRow>(
    `SELECT * FROM audit_events
     WHERE envelope_id = $1
     ORDER BY timestamp ASC`,
    [envelopeId]
  );

  const events = result.rows;
  let previousHash = '0'.repeat(64);
  const issues: ChainIssue[] = [];

  for (const event of events) {
    // Verify chain link
    if (event.previous_hash !== previousHash) {
      issues.push({
        eventId: event.id,
        type: 'chain_broken',
        expected: previousHash,
        found: event.previous_hash,
      });
    }

    // Verify event hash
    const eventData = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    const calculatedHash = calculateEventHash({
      id: event.id,
      envelopeId: event.envelope_id,
      eventType: event.event_type,
      data: eventData,
      timestamp: event.timestamp,
      previousHash: event.previous_hash,
      context: eventData.context || {},
      actor: event.actor,
    });

    if (calculatedHash !== event.hash) {
      issues.push({
        eventId: event.id,
        type: 'hash_mismatch',
        expected: calculatedHash,
        found: event.hash,
      });
    }

    previousHash = event.hash;
  }

  return {
    valid: issues.length === 0,
    eventCount: events.length,
    issues,
    verifiedAt: new Date().toISOString(),
  };
}

export default {
  AUDIT_EVENTS,
  logAuditEvent,
  logSignatureCapture,
  logDuplicateSignatureBlocked,
  logAuthEvent,
  logSecurityEvent,
  verifyAuditChain,
};
