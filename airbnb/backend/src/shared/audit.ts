/**
 * Audit Logging Module
 *
 * Audit logging enables:
 * - Dispute resolution (who did what, when)
 * - Compliance (track all booking changes)
 * - Fraud detection (identify suspicious patterns)
 * - Debugging (trace user actions)
 *
 * All booking-related actions are logged with:
 * - Actor (who performed the action)
 * - Resource (what was affected)
 * - Action (what was done)
 * - Context (IP, user agent, session)
 * - Before/after state for changes
 */

import { query } from '../db.js';
import { logger as _logger, createModuleLogger } from './logger.js';
import type { Request } from 'express';

const log = createModuleLogger('audit');

// Type definitions
interface AuditEventInput {
  type: string;
  userId?: number | null;
  resourceType: string;
  resourceId: number | string;
  action: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

interface AuditEntry {
  event_type: string;
  user_id: number | null;
  resource_type: string;
  resource_id: number | string;
  action: string;
  outcome: string;
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
}

interface AuditBookingOptions {
  userId?: number;
  outcome?: string;
  metadata?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

interface AuditListingOptions {
  outcome?: string;
  metadata?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

interface AuditHistoryOptions {
  limit?: number;
  offset?: number;
  eventType?: string;
}

interface UserAuditHistoryOptions {
  limit?: number;
  offset?: number;
  resourceType?: string;
}

interface AuditBooking {
  id: number;
  listing_id: number;
  check_in: string;
  check_out: string;
  total_price: number;
  nights: number;
  guests: number;
  status?: string;
}

interface AuditListing {
  id: number;
  title: string;
  price_per_night: number;
}

interface AuditError {
  message: string;
  code?: string;
}

interface AuditLogRow {
  id: number;
  event_type: string;
  user_id: number | null;
  resource_type: string;
  resource_id: number;
  action: string;
  outcome: string;
  ip_address: string | null;
  user_agent: string | null;
  session_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: Date;
  user_name?: string;
  user_email?: string;
}

// Audit event types
export const AUDIT_EVENTS = {
  // Booking events
  BOOKING_CREATED: 'booking.created',
  BOOKING_CONFIRMED: 'booking.confirmed',
  BOOKING_DECLINED: 'booking.declined',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_COMPLETED: 'booking.completed',
  BOOKING_MODIFIED: 'booking.modified',

  // Listing events
  LISTING_CREATED: 'listing.created',
  LISTING_UPDATED: 'listing.updated',
  LISTING_DELETED: 'listing.deleted',
  LISTING_ACTIVATED: 'listing.activated',
  LISTING_DEACTIVATED: 'listing.deactivated',

  // Availability events
  AVAILABILITY_BLOCKED: 'availability.blocked',
  AVAILABILITY_UNBLOCKED: 'availability.unblocked',
  PRICE_CHANGED: 'price.changed',

  // User events
  USER_REGISTERED: 'user.registered',
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_BECAME_HOST: 'user.became_host',

  // Review events
  REVIEW_SUBMITTED: 'review.submitted',
  REVIEW_DELETED: 'review.deleted',

  // Payment events (future)
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  REFUND_ISSUED: 'refund.issued',
};

// Outcome types
export const OUTCOMES = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  DENIED: 'denied',
};

/**
 * Log an audit event
 * @param event - Audit event details
 * @param req - Express request object for IP and user agent
 */
export async function logAuditEvent(event: AuditEventInput, req: Request | null = null): Promise<AuditEntry> {
  const auditEntry: AuditEntry = {
    event_type: event.type,
    user_id: event.userId ?? null,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    action: event.action,
    outcome: event.outcome || OUTCOMES.SUCCESS,
    ip_address: req?.ip || (req as unknown as { connection?: { remoteAddress?: string } })?.connection?.remoteAddress || null,
    user_agent: req?.headers?.['user-agent'] || null,
    session_id: req?.cookies?.session || null,
    request_id: req?.requestId || null,
    metadata: event.metadata || {},
    before_state: event.before || null,
    after_state: event.after || null,
  };

  // Log to structured logger
  log.info({
    audit: true,
    ...auditEntry,
    timestamp: new Date().toISOString(),
  }, `Audit: ${event.type}`);

  // Persist to database for querying
  try {
    await query(
      `INSERT INTO audit_logs (
        event_type, user_id, resource_type, resource_id, action, outcome,
        ip_address, user_agent, session_id, request_id, metadata,
        before_state, after_state, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())`,
      [
        auditEntry.event_type,
        auditEntry.user_id,
        auditEntry.resource_type,
        auditEntry.resource_id,
        auditEntry.action,
        auditEntry.outcome,
        auditEntry.ip_address,
        auditEntry.user_agent,
        auditEntry.session_id,
        auditEntry.request_id,
        JSON.stringify(auditEntry.metadata),
        auditEntry.before_state ? JSON.stringify(auditEntry.before_state) : null,
        auditEntry.after_state ? JSON.stringify(auditEntry.after_state) : null,
      ]
    );
  } catch (error) {
    // Don't fail the main operation if audit logging fails
    log.error({ error }, 'Failed to persist audit log to database');
  }

  return auditEntry;
}

/**
 * Log a booking audit event with full context
 */
export async function auditBooking(eventType: string, booking: AuditBooking, req: Request | null, options: AuditBookingOptions = {}): Promise<AuditEntry> {
  return logAuditEvent({
    type: eventType,
    userId: options.userId || req?.user?.id,
    resourceType: 'booking',
    resourceId: booking.id,
    action: eventType.split('.')[1], // 'created', 'cancelled', etc.
    outcome: options.outcome || OUTCOMES.SUCCESS,
    metadata: {
      listingId: booking.listing_id,
      checkIn: booking.check_in,
      checkOut: booking.check_out,
      totalPrice: booking.total_price,
      nights: booking.nights,
      guests: booking.guests,
      ...options.metadata,
    },
    before: options.before,
    after: options.after,
  }, req);
}

/**
 * Log a listing audit event
 */
export async function auditListing(eventType: string, listing: AuditListing, req: Request | null, options: AuditListingOptions = {}): Promise<AuditEntry> {
  return logAuditEvent({
    type: eventType,
    userId: req?.user?.id,
    resourceType: 'listing',
    resourceId: listing.id,
    action: eventType.split('.')[1],
    outcome: options.outcome || OUTCOMES.SUCCESS,
    metadata: {
      title: listing.title,
      pricePerNight: listing.price_per_night,
      ...options.metadata,
    },
    before: options.before,
    after: options.after,
  }, req);
}

/**
 * Log a failed operation for audit trail
 */
export async function auditFailure(eventType: string, resourceType: string, resourceId: number | string, error: AuditError, req: Request | null): Promise<AuditEntry> {
  return logAuditEvent({
    type: eventType,
    userId: req?.user?.id,
    resourceType,
    resourceId,
    action: 'attempt',
    outcome: OUTCOMES.FAILURE,
    metadata: {
      errorMessage: error.message,
      errorCode: error.code,
    },
  }, req);
}

/**
 * Log a denied operation (authorization failure)
 */
export async function auditDenied(eventType: string, resourceType: string, resourceId: number | string, reason: string, req: Request | null): Promise<AuditEntry> {
  return logAuditEvent({
    type: eventType,
    userId: req?.user?.id,
    resourceType,
    resourceId,
    action: 'access_denied',
    outcome: OUTCOMES.DENIED,
    metadata: {
      reason,
    },
  }, req);
}

/**
 * Query audit logs for a specific resource
 * @param resourceType - Resource type
 * @param resourceId - Resource ID
 * @param options - Query options
 */
export async function getAuditHistory(resourceType: string, resourceId: number | string, options: AuditHistoryOptions = {}): Promise<AuditLogRow[]> {
  const { limit = 50, offset = 0, eventType } = options;

  let sql = `
    SELECT a.*, u.name as user_name, u.email as user_email
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.resource_type = $1 AND a.resource_id = $2
  `;
  const params: (string | number)[] = [resourceType, resourceId];

  if (eventType) {
    params.push(eventType);
    sql += ` AND a.event_type = $${params.length}`;
  }

  params.push(limit, offset);
  sql += ` ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await query<AuditLogRow>(sql, params);
  return result.rows;
}

/**
 * Query audit logs for a specific user
 */
export async function getUserAuditHistory(userId: number, options: UserAuditHistoryOptions = {}): Promise<AuditLogRow[]> {
  const { limit = 50, offset = 0, resourceType } = options;

  let sql = `
    SELECT * FROM audit_logs
    WHERE user_id = $1
  `;
  const params: (string | number)[] = [userId];

  if (resourceType) {
    params.push(resourceType);
    sql += ` AND resource_type = $${params.length}`;
  }

  params.push(limit, offset);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await query<AuditLogRow>(sql, params);
  return result.rows;
}

export default {
  logAuditEvent,
  auditBooking,
  auditListing,
  auditFailure,
  auditDenied,
  getAuditHistory,
  getUserAuditHistory,
  AUDIT_EVENTS,
  OUTCOMES,
};
