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
import logger, { createModuleLogger } from './logger.js';

const log = createModuleLogger('audit');

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
 * @param {object} event - Audit event details
 * @param {string} event.type - Event type from AUDIT_EVENTS
 * @param {number} event.userId - ID of the user performing the action
 * @param {string} event.resourceType - Type of resource (booking, listing, etc.)
 * @param {number} event.resourceId - ID of the resource
 * @param {string} event.action - Action performed
 * @param {string} event.outcome - Outcome (success, failure, denied)
 * @param {object} event.metadata - Additional context
 * @param {object} event.before - State before change (for updates)
 * @param {object} event.after - State after change (for updates)
 * @param {object} req - Express request object for IP and user agent
 */
export async function logAuditEvent(event, req = null) {
  const auditEntry = {
    event_type: event.type,
    user_id: event.userId || null,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    action: event.action,
    outcome: event.outcome || OUTCOMES.SUCCESS,
    ip_address: req?.ip || req?.connection?.remoteAddress || null,
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
export async function auditBooking(eventType, booking, req, options = {}) {
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
export async function auditListing(eventType, listing, req, options = {}) {
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
export async function auditFailure(eventType, resourceType, resourceId, error, req) {
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
export async function auditDenied(eventType, resourceType, resourceId, reason, req) {
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
 * @param {string} resourceType - Resource type
 * @param {number} resourceId - Resource ID
 * @param {object} options - Query options
 */
export async function getAuditHistory(resourceType, resourceId, options = {}) {
  const { limit = 50, offset = 0, eventType } = options;

  let sql = `
    SELECT a.*, u.name as user_name, u.email as user_email
    FROM audit_logs a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.resource_type = $1 AND a.resource_id = $2
  `;
  const params = [resourceType, resourceId];

  if (eventType) {
    params.push(eventType);
    sql += ` AND a.event_type = $${params.length}`;
  }

  params.push(limit, offset);
  sql += ` ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await query(sql, params);
  return result.rows;
}

/**
 * Query audit logs for a specific user
 */
export async function getUserAuditHistory(userId, options = {}) {
  const { limit = 50, offset = 0, resourceType } = options;

  let sql = `
    SELECT * FROM audit_logs
    WHERE user_id = $1
  `;
  const params = [userId];

  if (resourceType) {
    params.push(resourceType);
    sql += ` AND resource_type = $${params.length}`;
  }

  params.push(limit, offset);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const result = await query(sql, params);
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
