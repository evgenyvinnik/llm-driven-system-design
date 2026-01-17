import { v4 as uuid } from 'uuid';
import { query, getClient } from '../utils/db.js';
import { auditService } from './auditService.js';
import { emailService } from './emailService.js';
import {
  publishNotification,
  publishWorkflowEvent,
  isQueueHealthy,
} from '../shared/queue.js';
import {
  executeWithIdempotency,
  generateSendIdempotencyKey,
} from '../shared/idempotency.js';
import { logAuditEvent, AUDIT_EVENTS } from '../shared/auditLogger.js';
import { envelopesCreated } from '../shared/metrics.js';
import logger from '../shared/logger.js';

// Valid state transitions
const ENVELOPE_STATES = {
  draft: ['sent', 'voided'],
  sent: ['delivered', 'voided'],
  delivered: ['signed', 'declined', 'voided'],
  signed: ['completed'],
  declined: [],
  voided: [],
  completed: []
};

class WorkflowEngine {
  // Validate state transition
  canTransition(currentState, newState) {
    const allowedTransitions = ENVELOPE_STATES[currentState] || [];
    return allowedTransitions.includes(newState);
  }

  // Transition envelope state
  async transitionState(envelopeId, newState, actor = 'system') {
    const result = await query(
      'SELECT status FROM envelopes WHERE id = $1',
      [envelopeId]
    );

    if (result.rows.length === 0) {
      throw new Error('Envelope not found');
    }

    const currentState = result.rows[0].status;

    if (!this.canTransition(currentState, newState)) {
      throw new Error(`Cannot transition from ${currentState} to ${newState}`);
    }

    const updates = ['status = $2', 'updated_at = NOW()'];
    const params = [envelopeId, newState];

    if (newState === 'completed') {
      updates.push('completed_at = NOW()');
    }

    await query(
      `UPDATE envelopes SET ${updates.join(', ')} WHERE id = $1`,
      params
    );

    await auditService.log(envelopeId, `envelope_${newState}`, {
      previousState: currentState,
      newState
    }, actor);

    // Publish workflow event for async processing
    try {
      if (isQueueHealthy()) {
        await publishWorkflowEvent({
          eventType: `envelope_${newState}`,
          envelopeId,
          data: { previousState: currentState, newState },
        });
      }
    } catch (error) {
      logger.warn({ error: error.message }, 'Failed to publish workflow event');
    }

    return newState;
  }

  // Validate envelope before sending
  async validateEnvelope(envelopeId) {
    // Check for documents
    const docsResult = await query(
      'SELECT COUNT(*) as count FROM documents WHERE envelope_id = $1',
      [envelopeId]
    );
    if (parseInt(docsResult.rows[0].count) === 0) {
      throw new Error('Envelope must have at least one document');
    }

    // Check for recipients
    const recipientsResult = await query(
      'SELECT COUNT(*) as count FROM recipients WHERE envelope_id = $1',
      [envelopeId]
    );
    if (parseInt(recipientsResult.rows[0].count) === 0) {
      throw new Error('Envelope must have at least one recipient');
    }

    // Check that signer recipients have signature fields
    const signersResult = await query(
      `SELECT r.id, r.name, r.email
       FROM recipients r
       WHERE r.envelope_id = $1 AND r.role = 'signer'`,
      [envelopeId]
    );

    for (const signer of signersResult.rows) {
      const fieldsResult = await query(
        `SELECT COUNT(*) as count
         FROM document_fields df
         JOIN documents d ON df.document_id = d.id
         WHERE d.envelope_id = $1 AND df.recipient_id = $2 AND df.type = 'signature'`,
        [envelopeId, signer.id]
      );

      if (parseInt(fieldsResult.rows[0].count) === 0) {
        throw new Error(`Signer ${signer.email} must have at least one signature field`);
      }
    }

    return true;
  }

  // Send envelope to recipients - WITH IDEMPOTENCY
  async sendEnvelope(envelopeId, senderId) {
    // Generate idempotency key for send operation
    const idempotencyKey = generateSendIdempotencyKey(envelopeId, senderId);

    const { data: envelope, cached } = await executeWithIdempotency(
      idempotencyKey,
      async () => {
        const client = await getClient();

        try {
          await client.query('BEGIN');

          const envelopeResult = await client.query(
            'SELECT * FROM envelopes WHERE id = $1 FOR UPDATE',
            [envelopeId]
          );

          if (envelopeResult.rows.length === 0) {
            throw new Error('Envelope not found');
          }

          const envelope = envelopeResult.rows[0];

          if (envelope.status !== 'draft') {
            throw new Error('Can only send draft envelopes');
          }

          // Validate envelope
          await this.validateEnvelope(envelopeId);

          // Transition state
          await client.query(
            `UPDATE envelopes SET status = 'sent', updated_at = NOW() WHERE id = $1`,
            [envelopeId]
          );

          // Generate access tokens for recipients
          const recipientsResult = await client.query(
            'SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order ASC',
            [envelopeId]
          );

          for (const recipient of recipientsResult.rows) {
            const accessToken = uuid();
            await client.query(
              'UPDATE recipients SET access_token = $2, status = $3 WHERE id = $1',
              [recipient.id, accessToken, 'sent']
            );
          }

          await client.query('COMMIT');

          // Log audit event
          await auditService.log(envelopeId, 'envelope_sent', {
            senderId,
            recipientCount: recipientsResult.rows.length
          }, senderId);

          // Log enhanced audit event
          await logAuditEvent(envelopeId, AUDIT_EVENTS.ENVELOPE_SENT, {
            senderId,
            recipientCount: recipientsResult.rows.length,
            recipients: recipientsResult.rows.map(r => ({
              id: r.id,
              email: r.email,
              name: r.name,
              routingOrder: r.routing_order,
            })),
          });

          // Get updated envelope and recipients for notification
          const updatedEnvelopeResult = await query(
            'SELECT * FROM envelopes WHERE id = $1',
            [envelopeId]
          );
          const updatedEnvelope = updatedEnvelopeResult.rows[0];

          // Get updated recipients with access tokens
          const updatedRecipientsResult = await query(
            'SELECT * FROM recipients WHERE envelope_id = $1 ORDER BY routing_order ASC',
            [envelopeId]
          );

          // Get first recipients and send notifications
          const firstRecipients = await this.getNextRecipients(envelopeId);
          for (const recipient of firstRecipients) {
            // Find the updated recipient with access token
            const updatedRecipient = updatedRecipientsResult.rows.find(
              r => r.id === recipient.id
            );
            await this.notifyRecipient(updatedRecipient || recipient, updatedEnvelope);
          }

          return updatedEnvelope;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      'send'
    );

    if (cached) {
      logger.info({ envelopeId, senderId }, 'Duplicate send request blocked by idempotency');
    }

    return envelope;
  }

  // Get next recipients based on routing order
  async getNextRecipients(envelopeId) {
    const result = await query(
      `SELECT * FROM recipients
       WHERE envelope_id = $1 AND role = 'signer'
       ORDER BY routing_order ASC`,
      [envelopeId]
    );

    const pending = result.rows.filter(r => r.status !== 'completed' && r.status !== 'declined');
    if (pending.length === 0) return [];

    const nextOrder = pending[0].routing_order;

    // Return all recipients at this order (parallel signing)
    return pending.filter(r => r.routing_order === nextOrder);
  }

  // Notify recipient to sign - with async queue support
  async notifyRecipient(recipient, envelope) {
    // Update recipient status to delivered
    await query(
      'UPDATE recipients SET status = $2 WHERE id = $1',
      [recipient.id, 'delivered']
    );

    // Update envelope status if first delivery
    await query(
      `UPDATE envelopes SET status = 'delivered', updated_at = NOW()
       WHERE id = $1 AND status = 'sent'`,
      [recipient.envelope_id]
    );

    // Try async notification via queue first
    if (isQueueHealthy()) {
      try {
        await publishNotification({
          type: 'signing_request',
          recipientId: recipient.id,
          envelopeId: recipient.envelope_id,
          channels: ['email'],
        });
        logger.info({
          recipientId: recipient.id,
          envelopeId: recipient.envelope_id,
        }, 'Notification queued for async delivery');
      } catch (error) {
        logger.warn({ error: error.message }, 'Queue publish failed, falling back to sync');
        // Fall back to synchronous email
        await emailService.sendSigningRequest(recipient, envelope);
      }
    } else {
      // Queue not available, send synchronously
      await emailService.sendSigningRequest(recipient, envelope);
    }

    // Log audit events
    await auditService.log(recipient.envelope_id, 'recipient_notified', {
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      recipientName: recipient.name
    });

    await logAuditEvent(recipient.envelope_id, AUDIT_EVENTS.RECIPIENT_NOTIFIED, {
      recipientId: recipient.id,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      notificationChannel: 'email',
    });
  }

  // Complete a recipient (all fields signed)
  async completeRecipient(recipientId, ipAddress, userAgent) {
    const result = await query(
      `UPDATE recipients
       SET status = 'completed', completed_at = NOW(), ip_address = $2, user_agent = $3
       WHERE id = $1
       RETURNING *`,
      [recipientId, ipAddress, userAgent]
    );

    const recipient = result.rows[0];

    await auditService.log(recipient.envelope_id, 'recipient_completed', {
      recipientId,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      ipAddress
    });

    await logAuditEvent(recipient.envelope_id, AUDIT_EVENTS.RECIPIENT_COMPLETED, {
      recipientId,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      ipAddress,
      userAgent,
      completedAt: new Date().toISOString(),
    }, {
      ipAddress,
      userAgent,
    });

    // Check if all recipients at this routing order are done
    const siblingsResult = await query(
      `SELECT * FROM recipients
       WHERE envelope_id = $1 AND routing_order = $2`,
      [recipient.envelope_id, recipient.routing_order]
    );

    const allComplete = siblingsResult.rows.every(r => r.status === 'completed');

    if (allComplete) {
      // Get next recipients
      const nextRecipients = await this.getNextRecipients(recipient.envelope_id);

      if (nextRecipients.length === 0) {
        // All signers done, complete the envelope
        await this.completeEnvelope(recipient.envelope_id);
      } else {
        // Get envelope for notification
        const envelopeResult = await query(
          'SELECT * FROM envelopes WHERE id = $1',
          [recipient.envelope_id]
        );
        const envelope = envelopeResult.rows[0];

        // Notify next recipients
        for (const next of nextRecipients) {
          await this.notifyRecipient(next, envelope);
        }
      }
    }

    return recipient;
  }

  // Complete an envelope (all signatures collected)
  async completeEnvelope(envelopeId) {
    await query(
      `UPDATE envelopes
       SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [envelopeId]
    );

    await auditService.log(envelopeId, 'envelope_completed', {
      completedAt: new Date().toISOString()
    });

    await logAuditEvent(envelopeId, AUDIT_EVENTS.ENVELOPE_COMPLETED, {
      completedAt: new Date().toISOString(),
    });

    // Send completion notifications to all recipients
    const recipientsResult = await query(
      'SELECT * FROM recipients WHERE envelope_id = $1',
      [envelopeId]
    );

    const envelopeResult = await query(
      'SELECT * FROM envelopes WHERE id = $1',
      [envelopeId]
    );
    const envelope = envelopeResult.rows[0];

    for (const recipient of recipientsResult.rows) {
      // Try async notification via queue
      if (isQueueHealthy()) {
        try {
          await publishNotification({
            type: 'completed',
            recipientId: recipient.id,
            envelopeId,
            channels: ['email'],
          });
        } catch (error) {
          logger.warn({ error: error.message }, 'Queue publish failed for completion');
          await emailService.sendCompletionNotification(recipient, envelope);
        }
      } else {
        await emailService.sendCompletionNotification(recipient, envelope);
      }
    }

    // Also notify sender
    const senderResult = await query(
      'SELECT * FROM users WHERE id = $1',
      [envelope.sender_id]
    );
    if (senderResult.rows.length > 0) {
      await emailService.sendCompletionNotification(senderResult.rows[0], envelope);
    }

    // Publish workflow event for any downstream processing
    if (isQueueHealthy()) {
      try {
        await publishWorkflowEvent({
          eventType: 'envelope_completed',
          envelopeId,
          data: { completedAt: new Date().toISOString() },
        });
      } catch (error) {
        logger.warn({ error: error.message }, 'Failed to publish completion event');
      }
    }
  }

  // Decline an envelope
  async declineEnvelope(recipientId, reason, ipAddress, userAgent) {
    const recipientResult = await query(
      `UPDATE recipients
       SET status = 'declined', ip_address = $2, user_agent = $3
       WHERE id = $1
       RETURNING *`,
      [recipientId, ipAddress, userAgent]
    );

    const recipient = recipientResult.rows[0];

    await query(
      `UPDATE envelopes SET status = 'declined', updated_at = NOW() WHERE id = $1`,
      [recipient.envelope_id]
    );

    await auditService.log(recipient.envelope_id, 'envelope_declined', {
      recipientId,
      recipientEmail: recipient.email,
      reason,
      ipAddress
    });

    await logAuditEvent(recipient.envelope_id, AUDIT_EVENTS.ENVELOPE_DECLINED, {
      recipientId,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      reason,
      declinedAt: new Date().toISOString(),
    }, {
      ipAddress,
      userAgent,
    });

    // Notify sender
    const envelopeResult = await query(
      `SELECT e.*, u.email as sender_email, u.name as sender_name
       FROM envelopes e
       JOIN users u ON e.sender_id = u.id
       WHERE e.id = $1`,
      [recipient.envelope_id]
    );
    const envelope = envelopeResult.rows[0];

    await emailService.sendDeclineNotification(recipient, envelope, reason);

    return recipient;
  }

  // Void an envelope
  async voidEnvelope(envelopeId, reason, userId) {
    const result = await query(
      'SELECT status FROM envelopes WHERE id = $1',
      [envelopeId]
    );

    if (result.rows.length === 0) {
      throw new Error('Envelope not found');
    }

    const currentStatus = result.rows[0].status;
    if (['completed', 'declined', 'voided'].includes(currentStatus)) {
      throw new Error(`Cannot void envelope with status: ${currentStatus}`);
    }

    await query(
      `UPDATE envelopes SET status = 'voided', updated_at = NOW() WHERE id = $1`,
      [envelopeId]
    );

    await auditService.log(envelopeId, 'envelope_voided', {
      reason,
      voidedBy: userId
    }, userId);

    await logAuditEvent(envelopeId, AUDIT_EVENTS.ENVELOPE_VOIDED, {
      reason,
      voidedBy: userId,
      previousStatus: currentStatus,
      voidedAt: new Date().toISOString(),
    });

    // Notify all recipients
    const recipientsResult = await query(
      'SELECT * FROM recipients WHERE envelope_id = $1',
      [envelopeId]
    );

    const envelopeResult = await query(
      'SELECT * FROM envelopes WHERE id = $1',
      [envelopeId]
    );

    for (const recipient of recipientsResult.rows) {
      await emailService.sendVoidNotification(recipient, envelopeResult.rows[0], reason);
    }
  }

  // Check if recipient has completed all required fields
  async checkRecipientCompletion(recipientId) {
    const result = await query(
      `SELECT COUNT(*) as count
       FROM document_fields df
       JOIN documents d ON df.document_id = d.id
       JOIN recipients r ON df.recipient_id = r.id
       WHERE df.recipient_id = $1 AND df.required = true AND df.completed = false`,
      [recipientId]
    );

    return parseInt(result.rows[0].count) === 0;
  }
}

export const workflowEngine = new WorkflowEngine();
