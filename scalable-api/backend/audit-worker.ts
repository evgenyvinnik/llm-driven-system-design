import queue, { QUEUES } from './shared/services/queue.js';
import db from './shared/services/database.js';
import config from './shared/config/index.js';

const workerId = process.env.WORKER_ID || 'audit-1';

console.log(`Audit Worker [${workerId}] starting...`);

/**
 * Store audit event in database
 */
async function storeAuditEvent(event) {
  const { id, action, userId, details, timestamp, instanceId } = event;

  await db.query(
    `INSERT INTO audit_log (event_id, action, user_id, details, instance_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, action, userId, JSON.stringify(details), instanceId, timestamp]
  );
}

/**
 * Handle incoming audit event
 */
async function handleAuditEvent(event) {
  const { id, action, userId, details } = event;

  console.log(`[${workerId}] Processing audit event: ${action} (user: ${userId || 'system'})`);

  try {
    // Store in database
    await storeAuditEvent(event);

    // Log for immediate visibility
    console.log(`[${workerId}] Audit logged: ${id}`, {
      action,
      userId,
      details: JSON.stringify(details).substring(0, 100),
    });

    // Additional processing based on action type
    await processSecurityAlerts(event);
  } catch (error) {
    console.error(`[${workerId}] Failed to process audit event ${id}:`, error.message);
    throw error; // Will trigger requeue
  }
}

/**
 * Process security-related audit events for alerting
 */
async function processSecurityAlerts(event) {
  const { action, userId, details } = event;

  // Security-critical events that might need alerting
  const securityEvents = [
    'user.login_failed',
    'user.password_changed',
    'user.role_changed',
    'api_key.created',
    'api_key.revoked',
    'admin.action',
    'rate_limit.exceeded',
    'circuit_breaker.opened',
  ];

  if (securityEvents.some((e) => action.startsWith(e.split('.')[0]))) {
    // In production, this could trigger PagerDuty, Slack, or email alerts
    console.log(`[${workerId}] SECURITY ALERT: ${action}`, {
      userId,
      ip: details.ip,
      timestamp: event.timestamp,
    });

    // Track failed login attempts for brute force detection
    if (action === 'user.login_failed' && details.ip) {
      await trackFailedLogin(details.ip, userId);
    }
  }
}

/**
 * Track failed logins for security monitoring
 */
async function trackFailedLogin(ip, _attemptedUser) {
  try {
    // Count recent failed attempts from this IP
    const result = await db.query(
      `SELECT COUNT(*) as count FROM audit_log
       WHERE action = 'user.login_failed'
         AND details->>'ip' = $1
         AND created_at > NOW() - INTERVAL '15 minutes'`,
      [ip]
    );

    const failedCount = parseInt(result.rows[0]?.count || 0, 10);

    if (failedCount >= 5) {
      console.warn(`[${workerId}] BRUTE FORCE ALERT: ${failedCount} failed logins from IP ${ip}`);
      // In production: block IP, send alert, etc.
    }
  } catch (error) {
    // Don't fail the main audit logging if this check fails
    console.warn(`[${workerId}] Failed to track login attempt:`, error.message);
  }
}

/**
 * Start the worker
 */
async function start() {
  try {
    // Connect to RabbitMQ
    await queue.connect();

    // Verify database connection
    const dbStatus = await db.checkConnection();
    if (!dbStatus.connected) {
      throw new Error('Database not available');
    }

    // Start consuming audit events
    await queue.consume(QUEUES.AUDIT_LOG, handleAuditEvent, {
      prefetch: 20, // Audit events are lightweight, process more concurrently
    });

    console.log(`Audit Worker [${workerId}] is now consuming from ${QUEUES.AUDIT_LOG}`);
    console.log(`Environment: ${config.env}`);
  } catch (error) {
    console.error(`[${workerId}] Failed to start:`, error.message);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown() {
  console.log(`[${workerId}] Shutting down...`);
  await queue.close();
  await db.closePool();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start the worker
start();
