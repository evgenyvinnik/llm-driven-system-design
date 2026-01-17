/**
 * Audit Logging for Financial Transactions
 *
 * WHY audit logging is required for financial systems:
 *
 * 1. REGULATORY COMPLIANCE: Financial services are subject to regulations
 *    (SOX, PCI-DSS, BSA/AML) that require immutable audit trails of all
 *    money movements. Without audit logs, regulators can impose fines
 *    or revoke operating licenses.
 *
 * 2. FRAUD INVESTIGATION: When suspicious activity is detected, investigators
 *    need to trace every action taken by an account. Audit logs provide the
 *    evidence needed to identify unauthorized access or money laundering.
 *
 * 3. DISPUTE RESOLUTION: When a user disputes a charge or claims they didn't
 *    authorize a transfer, audit logs provide definitive proof of what happened,
 *    including IP addresses, device info, and exact timestamps.
 *
 * 4. INCIDENT RESPONSE: During security incidents (account takeover, data breach),
 *    audit logs help determine the scope of impact and what data was accessed.
 *
 * 5. NON-REPUDIATION: Users cannot deny performing actions when audit logs
 *    capture their session ID, IP, and user agent at the time of action.
 *
 * Audit events are:
 * - Immutable (append-only, never updated or deleted)
 * - Timestamped with server time (not client time)
 * - Include actor identity and context
 * - Stored separately from application logs
 * - Retained per regulatory requirements (typically 7 years)
 */

const { pool } = require('../db/pool');
const { logger } = require('./logger');
const { auditEventsTotal } = require('./metrics');

// Audit action types
const AUDIT_ACTIONS = {
  // Money movement
  TRANSFER_INITIATED: 'transfer_initiated',
  TRANSFER_COMPLETED: 'transfer_completed',
  TRANSFER_FAILED: 'transfer_failed',
  CASHOUT_INITIATED: 'cashout_initiated',
  CASHOUT_COMPLETED: 'cashout_completed',
  CASHOUT_FAILED: 'cashout_failed',
  DEPOSIT_COMPLETED: 'deposit_completed',

  // Payment requests
  REQUEST_CREATED: 'request_created',
  REQUEST_PAID: 'request_paid',
  REQUEST_DECLINED: 'request_declined',

  // Payment methods
  PAYMENT_METHOD_ADDED: 'payment_method_added',
  PAYMENT_METHOD_REMOVED: 'payment_method_removed',
  PAYMENT_METHOD_VERIFIED: 'payment_method_verified',
  PAYMENT_METHOD_DEFAULT_CHANGED: 'payment_method_default_changed',

  // Authentication
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  PASSWORD_CHANGED: 'password_changed',
  PIN_CHANGED: 'pin_changed',

  // Account management
  ACCOUNT_CREATED: 'account_created',
  ACCOUNT_UPDATED: 'account_updated',
  ACCOUNT_FROZEN: 'account_frozen',
  ACCOUNT_UNFROZEN: 'account_unfrozen',
  LIMIT_CHANGED: 'limit_changed',

  // Privacy
  PRIVACY_SETTINGS_CHANGED: 'privacy_settings_changed',
};

// Actor types
const ACTOR_TYPES = {
  USER: 'user',
  ADMIN: 'admin',
  SYSTEM: 'system',
};

// Outcome types
const OUTCOMES = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  DENIED: 'denied',
};

/**
 * Create an audit log entry
 *
 * @param {Object} params - Audit log parameters
 * @param {string} params.action - Action performed (from AUDIT_ACTIONS)
 * @param {string} params.actorId - ID of user/admin/system performing action
 * @param {string} params.actorType - Type of actor (from ACTOR_TYPES)
 * @param {string} params.resourceType - Type of resource affected
 * @param {string} params.resourceId - ID of the affected resource
 * @param {string} params.outcome - Result (from OUTCOMES)
 * @param {Object} params.details - Additional context (amounts, reasons, etc.)
 * @param {Object} params.request - Express request object (for IP, user agent)
 */
async function createAuditLog({
  action,
  actorId,
  actorType = ACTOR_TYPES.USER,
  resourceType = null,
  resourceId = null,
  outcome = OUTCOMES.SUCCESS,
  details = {},
  request = null,
}) {
  try {
    // Extract request context
    const requestContext = request
      ? {
          ip: request.ip || request.headers['x-forwarded-for'] || request.connection?.remoteAddress,
          userAgent: request.headers['user-agent'],
          requestId: request.requestId || request.headers['x-request-id'],
        }
      : {};

    // Remove any potentially sensitive data from details
    const sanitizedDetails = sanitizeDetails(details);

    // Insert audit log entry
    await pool.query(
      `INSERT INTO audit_log (
        actor_id, actor_type, action, resource_type, resource_id,
        ip_address, user_agent, request_id, details, outcome
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        actorId,
        actorType,
        action,
        resourceType,
        resourceId,
        requestContext.ip,
        requestContext.userAgent,
        requestContext.requestId,
        JSON.stringify(sanitizedDetails),
        outcome,
      ]
    );

    // Update metrics
    auditEventsTotal.inc({ action, outcome });

    // Also log to structured logger for immediate visibility
    logger.info({
      event: 'audit_log',
      action,
      actorId,
      actorType,
      resourceType,
      resourceId,
      outcome,
      ip: requestContext.ip,
      requestId: requestContext.requestId,
      ...sanitizedDetails,
    });
  } catch (error) {
    // Audit logging failures should not break the main operation
    // but must be logged for investigation
    logger.error({
      event: 'audit_log_failure',
      error: error.message,
      action,
      actorId,
      resourceType,
      resourceId,
      outcome,
    });
  }
}

/**
 * Remove sensitive fields from details object
 */
function sanitizeDetails(details) {
  const sensitiveFields = [
    'password',
    'pin',
    'account_number',
    'routing_number',
    'card_number',
    'cvv',
    'ssn',
  ];

  const sanitized = { ...details };

  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '***REDACTED***';
    }
  }

  // Mask account numbers to last 4
  if (sanitized.last4) {
    // last4 is already masked, keep it
  }
  if (sanitized.bank_account && typeof sanitized.bank_account === 'string') {
    sanitized.bank_account = '****' + sanitized.bank_account.slice(-4);
  }

  return sanitized;
}

/**
 * Helper for logging transfer operations
 */
async function logTransfer(action, transfer, outcome, request, additionalDetails = {}) {
  await createAuditLog({
    action,
    actorId: transfer.sender_id,
    actorType: ACTOR_TYPES.USER,
    resourceType: 'transfer',
    resourceId: transfer.id,
    outcome,
    details: {
      amount_cents: transfer.amount,
      receiver_id: transfer.receiver_id,
      funding_source: transfer.funding_source,
      visibility: transfer.visibility,
      ...additionalDetails,
    },
    request,
  });
}

/**
 * Helper for logging cashout operations
 */
async function logCashout(action, cashout, outcome, request, additionalDetails = {}) {
  await createAuditLog({
    action,
    actorId: cashout.user_id,
    actorType: ACTOR_TYPES.USER,
    resourceType: 'cashout',
    resourceId: cashout.id,
    outcome,
    details: {
      amount_cents: cashout.amount,
      fee_cents: cashout.fee,
      speed: cashout.speed,
      payment_method_id: cashout.payment_method_id,
      ...additionalDetails,
    },
    request,
  });
}

/**
 * Helper for logging authentication events
 */
async function logAuth(action, userId, outcome, request, additionalDetails = {}) {
  await createAuditLog({
    action,
    actorId: userId,
    actorType: ACTOR_TYPES.USER,
    resourceType: 'session',
    resourceId: null,
    outcome,
    details: additionalDetails,
    request,
  });
}

/**
 * Query audit logs for investigation
 *
 * @param {Object} filters - Query filters
 * @param {string} filters.actorId - Filter by actor
 * @param {string} filters.action - Filter by action type
 * @param {string} filters.resourceType - Filter by resource type
 * @param {string} filters.resourceId - Filter by specific resource
 * @param {Date} filters.startDate - Filter by start date
 * @param {Date} filters.endDate - Filter by end date
 * @param {number} filters.limit - Result limit
 * @param {number} filters.offset - Pagination offset
 */
async function queryAuditLogs({
  actorId = null,
  action = null,
  resourceType = null,
  resourceId = null,
  startDate = null,
  endDate = null,
  limit = 100,
  offset = 0,
}) {
  const conditions = [];
  const params = [];
  let paramIndex = 1;

  if (actorId) {
    conditions.push(`actor_id = $${paramIndex++}`);
    params.push(actorId);
  }

  if (action) {
    conditions.push(`action = $${paramIndex++}`);
    params.push(action);
  }

  if (resourceType) {
    conditions.push(`resource_type = $${paramIndex++}`);
    params.push(resourceType);
  }

  if (resourceId) {
    conditions.push(`resource_id = $${paramIndex++}`);
    params.push(resourceId);
  }

  if (startDate) {
    conditions.push(`timestamp >= $${paramIndex++}`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`timestamp <= $${paramIndex++}`);
    params.push(endDate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT * FROM audit_log
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex}
  `;

  params.push(limit, offset);

  const result = await pool.query(query, params);
  return result.rows;
}

module.exports = {
  createAuditLog,
  logTransfer,
  logCashout,
  logAuth,
  queryAuditLogs,
  AUDIT_ACTIONS,
  ACTOR_TYPES,
  OUTCOMES,
};
